// M7：人工操作台。§8.1 铁律落点：人工只能做白名单动作，每个动作留 ADMIN_ACTION 审计；
// 人工在结构上不存在修改状态/金额/用户选择的接口——本文件就是全部人工能力的边界。
import { GOODWILL, RUNTIME_FLAGS, VOUCHER_TTL_DAYS, SLA } from './config.js';
import { genVoucherId } from './ids.js';
import { StoreError } from './store.js';
import { appendGuarded } from './checkout.js';
import { allocateFunding } from './funding.js';
import { applyFullRefund } from './refunds.js';
import { reconcileOperations } from './recon.js';

const audit = (store, orderId, data) =>
  appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'ADMIN_ACTION', decision_source: 'HUMAN_EXCEPTION', data }]);

// §8.2 出池动作②：卡死退款重试（复用义务，§5.4 本义；引擎语义与用户侧重试完全一致）
export async function retryStuckRefund(store, orderId, itemId, { channel, actor, ticket_ref }) {
  const r = await applyFullRefund(store, orderId, itemId, { channel, decision_source: 'USER_DECISION' });
  audit(store, orderId, { action: 'RETRY_STUCK_REFUND', actor, ticket_ref, item_id: itemId, result: r });
  return r;
}

// §8.2/§8.3：GOODWILL 发券。三限额同时校验；双审开关生效于此；超限仅 owner。
export function issueGoodwill(store, orderId, { amount_cents, actor, ticket_ref, approver = null, owner = false }) {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0)
    throw new StoreError('INVALID_GOODWILL', '金额非法');
  if (RUNTIME_FLAGS.dual_review_enabled) {
    if (!approver) throw new StoreError('APPROVER_REQUIRED', '双人复核已开启，需要第二账号批准（§8.4）');
    if (approver === actor) throw new StoreError('APPROVER_EQUALS_ACTOR', '复核人不得与操作人相同（§8.4）');
  }
  const h = store.getOrder(orderId);
  const paid = h.filter(e => e.type === 'PAYMENT_SUCCEEDED').reduce((a, e) => a + (e.amount_cents ?? 0), 0);
  const overLimit = amount_cents > GOODWILL.MAX_SINGLE_CENTS ||
    (paid > 0 && amount_cents > paid * GOODWILL.MAX_RATIO_OF_PAID);
  if (overLimit && !owner) throw new StoreError('GOODWILL_LIMIT', '超单笔限额，仅 owner 可批（§8.3）');
  if (!overLimit) {
    const userId = h.find(e => e.type === 'QUOTE_CREATED')?.data?.user_id;
    const since = Date.now() - 30 * 86400_000;
    let sum = 0;
    for (const q of store.getEventsByType('QUOTE_CREATED')) {
      if (q.data?.user_id !== userId) continue;
      for (const p of store.getOrder(q.order_id))
        if (p.type === 'PAYMENT_SUCCEEDED' || p.type === 'VOUCHER_ISSUED' && p.data?.source === 'GOODWILL')
          if (p.type === 'VOUCHER_ISSUED' && p.data?.source === 'GOODWILL' && new Date(p.occurred_at).getTime() >= since)
            sum += p.data.face_value_cents ?? 0;
    }
    if (sum + amount_cents > GOODWILL.USER_30D_CAP_CENTS && !owner)
      throw new StoreError('GOODWILL_USER_CAP', '超用户 30 天累计限额（§8.3）');
  }
  const voucher_id = genVoucherId();
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: 'VOUCHER_ISSUED', decision_source: 'HUMAN_EXCEPTION', amount_cents,
    data: { source: 'GOODWILL', voucher_id, face_value_cents: amount_cents,
            expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(),
            actor, ticket_ref, approver, owner_override: overLimit },
  }]);
  audit(store, orderId, { action: 'ISSUE_GOODWILL', actor, ticket_ref, approver, amount_cents, voucher_id });
  return { voucher_id, amount_cents };
}

// §8.2 出池动作①：支付未决的人工确认（渠道侧查询已收敛后调用）
export async function resolveUnknownPayment(store, orderId, { channel, actor, ticket_ref }) {
  const pend = store.getOperationsByOrder(orderId)
    .filter(o => o.type === 'payment' && ['UNKNOWN', 'EXECUTING', 'CREATED'].includes(o.state));
  if (!pend.length) throw new StoreError('NO_PENDING_PAYMENT', orderId);
  const op = pend[pend.length - 1];
  const res = await channel.resolve(op.operation_id);
  if (res.state !== 'SUCCEEDED') {
    audit(store, orderId, { action: 'RESOLVE_UNKNOWN_NOOP', actor, ticket_ref, operation_id: op.operation_id });
    return { resolved: false };
  }
  store.markOperation(op.operation_id, 'EXECUTED', res.channel_ref);
  const h = store.getOrder(orderId);
  const q = h.find(e => e.type === 'QUOTE_CREATED');
  const items = q.data.items.map(it => ({ item_id: it.item_id, locked_price_cents: it.locked_price_cents }));
  const reserved = new Map();
  for (const r of h.filter(e => e.type === 'VOUCHER_RESERVED'))
    reserved.set(r.data.voucher_id, (reserved.get(r.data.voucher_id) ?? 0) + r.data.reserved_cents);
  const vouchers = [...reserved].map(([voucher_id, cents]) => ({ voucher_id, remaining_cents: cents }));
  const { funding } = allocateFunding(items, vouchers);
  const cashTotal = funding.reduce((a, f) => a + f.cash_cents, 0);
  const perVoucher = new Map();
  for (const f of funding) for (const a of f.allocations) {
    const cur = perVoucher.get(a.voucher_id) ?? { applied_cents: 0, allocations: [] };
    cur.applied_cents += a.applied_cents;
    cur.allocations.push({ item_id: f.item_id, applied_cents: a.applied_cents });
    perVoucher.set(a.voucher_id, cur);
  }
  appendGuarded(store, orderId, store.getOrder(orderId), [
    { type: 'PAYMENT_UNKNOWN_RESOLVED', amount_cents: cashTotal, data: { operation_id: op.operation_id, resolved_by: actor } },
    { type: 'PAYMENT_SUCCEEDED', amount_cents: cashTotal, data: { operation_id: op.operation_id, channel_ref: res.channel_ref } },
    { type: 'ORDER_CONFIRMED', data: { items: q.data.items.map(it => ({ ...it, funding_split: funding.find(f => f.item_id === it.item_id) })),
                                       total_cents: q.data.total_cents, cash_paid_cents: cashTotal } },
    ...[...perVoucher].map(([voucher_id, info]) => ({ type: 'VOUCHER_REDEEMED', data: { voucher_id, ...info } })),
  ]);
  audit(store, orderId, { action: 'RESOLVE_UNKNOWN_PAYMENT', actor, ticket_ref, operation_id: op.operation_id, cash_paid_cents: cashTotal });
  return { resolved: true, cash_paid_cents: cashTotal };
}

// §8.5 人工介入率与池清单
export function poolReport(store, now = new Date()) {
  const issues = reconcileOperations(store, { now });
  const adminActions = store.getEventsByType('ADMIN_ACTION').length;
  const totalOrders = store.getAllOrderIds().filter(id => id !== 'ord_system').length;
  return { pool: issues.stale_pending, other_issues: issues, admin_actions: adminActions,
           intervention_rate: totalOrders ? adminActions / totalOrders : 0 };
}
