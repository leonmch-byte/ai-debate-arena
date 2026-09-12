// §7 结算协议：E1 现金守恒、结算预演（§7.2）、I3 完整前置、72h 异议期（§7.3）。
import { createHash } from 'node:crypto';
import { StoreError } from './store.js';
import { projectItems, projectOrder, ITEM_TERMINAL } from './orders.js';
import { appendGuarded } from './checkout.js';
import { SLA } from './config.js';

// E1：Σ收款(支付+补差) − Σ退款(含退差) = Σ{COMPLETED,VOUCHERED} 的 cash（§7.1）
export function E1(events) {
  const items = projectItems(events);
  let paid = 0, refunded = 0;
  const fundingByItem = new Map();
  for (const e of events) {
    switch (e.type) {
      case 'PAYMENT_SUCCEEDED':  paid += e.amount_cents ?? 0; break;
      case 'SURCHARGE_EXECUTED':
        paid += e.amount_cents ?? 0;
        if (e.data?.funding_split)
          fundingByItem.set(e.data.successor_item_id, e.data.funding_split);
        break;
      case 'REFUND_EXECUTED':    refunded += e.amount_cents ?? 0; break;
      case 'ORDER_CONFIRMED':
        for (const it of (e.data.items ?? []))
          if (it.funding_split) fundingByItem.set(it.item_id, it.funding_split);
        break;
      case 'ITEM_LOCKED':
        if (e.data?.funding_split) fundingByItem.set(e.item_id, e.data.funding_split);
        break;
      default: break;
    }
  }
  let expected = 0;
  for (const it of items.values())
    if (it.state === 'COMPLETED' || it.state === 'VOUCHERED')
      expected += fundingByItem.get(it.item_id)?.cash_cents ?? 0;
  return {
    paid_cash_cents: paid, refunded_cash_cents: refunded,
    expected_cash_cents: expected, diff: paid - refunded - expected,
  };
}

// I3（§7.1 E3 / §2.6）：无未决决策 ∧ 每笔义务有执行 ∧ 无未决渠道操作
export function assertI3(store, orderId) {
  const h = store.getOrder(orderId);
  const items = projectItems(h);
  for (const it of items.values())
    if (it.pending_decision)
      throw new StoreError('I3_PENDING_DECISIONS', `${it.item_id} 存在未决决策`);
  const dues = h.filter(e => ['REFUND_DUE', 'SURCHARGE_DUE', 'CREDIT_DUE'].includes(e.type));
  const executed = h.filter(e =>
    ['REFUND_EXECUTED', 'SURCHARGE_EXECUTED', 'VOUCHER_ISSUED'].includes(e.type));
  const covered = new Set(executed.flatMap(e => e.caused_by ?? []));
  const uncovered = dues.filter(d => !covered.has(d.event_id));
  if (uncovered.length)
    throw new StoreError('I3_UNSETTLED_DUES', `${uncovered.length} 笔义务未执行：${uncovered.map(d => d.type + '@' + d.seq).join(', ')}`);
  const unsettled = store.getOperationsByOrder(orderId)
    .filter(o => ['CREATED', 'EXECUTING', 'UNKNOWN'].includes(o.state));
  if (unsettled.length)
    throw new StoreError('I3_UNSETTLED_OPERATIONS', `${unsettled.length} 笔渠道操作未决（§5.1）`);
  return true;
}

function priceOf(itemId, ocItems, h) {
  const rec = (ocItems ?? []).find(x => x.item_id === itemId);
  if (rec) return rec.locked_price_cents;
  const sur = h.find(e => e.type === 'SURCHARGE_EXECUTED' && e.data?.successor_item_id === itemId);
  if (sur?.data?.funding_split)
    return (sur.data.funding_split.cash_cents ?? 0) + (sur.data.funding_split.credit_cents ?? 0);
  const lk = h.find(e => e.type === 'ITEM_LOCKED' && e.item_id === itemId && e.data?.funding_split);
  if (lk?.data?.funding_split)
    return (lk.data.funding_split.cash_cents ?? 0) + (lk.data.funding_split.credit_cents ?? 0);
  return 0;
}

// 结算预演（§7.2）：全部终态才可预演；balance=E1.diff 必须 0 才可 finalize
export function previewSettlement(store, orderId, { now = new Date() } = {}) {
  const h = store.getOrder(orderId);
  const items = projectItems(h);
  const allTerminal = items.size > 0 && [...items.values()].every(i => ITEM_TERMINAL.has(i.state));
  const openDecision = [...items.values()].some(i => i.pending_decision);
  if (!allTerminal || openDecision)
    throw new StoreError('NOT_SETTLEMENT_READY', `当前投影 ${projectOrder(h)}（§7.3 触发条件不满足）`);
  const oc = h.find(e => e.type === 'ORDER_CONFIRMED');
  const ocItems = oc?.data.items ?? [];
  const total = ocItems.reduce((a, i) => a + i.locked_price_cents, 0);
  const paid = h.filter(e => ['PAYMENT_SUCCEEDED', 'SURCHARGE_EXECUTED'].includes(e.type))
    .reduce((a, e) => a + (e.amount_cents ?? 0), 0);
  const refunded = h.filter(e => e.type === 'REFUND_EXECUTED')
    .reduce((a, e) => a + (e.amount_cents ?? 0), 0);
  const voucherIssued = h.filter(e => e.type === 'VOUCHER_ISSUED')
    .reduce((a, e) => a + (e.data.face_value_cents ?? e.amount_cents ?? 0), 0);
  const voucherRedeemed = h.filter(e => e.type === 'VOUCHER_REDEEMED')
    .reduce((a, e) => a + (e.data.applied_cents ?? 0), 0);
  const delivered = [...items.values()].filter(i => i.state === 'COMPLETED')
    .reduce((a, i) => a + priceOf(i.item_id, ocItems, h), 0);

  const adjustments = [...items.values()].map(it => {
    const base = { item_id: it.item_id, state: it.state };
    const cash = (ocItems.find(x => x.item_id === it.item_id)?.funding_split?.cash_cents) ?? 0;
    switch (it.state) {
      case 'COMPLETED':      return { ...base, kind: 'DELIVERED', delta_cents: 0, note: '已交付' };
      case 'REPLACED':       return { ...base, kind: 'REPLACED', delta_cents: 0, note: '由后继项承接（§2.5）' };
      case 'REFUNDED':       return { ...base, kind: 'REFUND', delta_cents: -cash, note: '未履约退款' };
      case 'TIMEOUT_REFUNDED': return { ...base, kind: 'REFUND', delta_cents: -cash, note: '24h 未决策自动退款' };
      case 'VOUCHERED':      return { ...base, kind: 'VOUCHERED', delta_cents: 0, note: `未履约，转服务额度（券部分原路另发）` };
      case 'VOIDED':         return { ...base, kind: 'VOIDED', delta_cents: 0, note: '未进入履约' };
      default:               return { ...base, kind: 'UNKNOWN', delta_cents: 0, note: it.state };
    }
  });

  const e1 = E1(h);
  const preview = {
    order_total_locked_cents: total,
    paid_cash_cents: paid,
    refunded_cash_cents: refunded,
    voucher_issued_cents: voucherIssued,
    voucher_redeemed_cents: voucherRedeemed,
    delivered_value_cents: delivered,
    final_due_cents: paid - refunded,
    balance_cents: e1.diff,
    adjustments,
    previewed_at: now.toISOString(),
  };
  appendGuarded(store, orderId, h,
    [{ type: 'SETTLEMENT_PREVIEWED', data: { preview } }]);
  return preview;
}

export function raiseObjection(store, orderId, { scope, reason, now = new Date() } = {}) {
  const h = store.getOrder(orderId);
  const count = h.filter(e => e.type === 'OBJECTION_RAISED').length;
  if (count >= 2)
    throw new StoreError('MANUAL_POOL_REQUIRED', '第 3 次异议转人工通道（§7.3/§8.2）');
  appendGuarded(store, orderId, h,
    [{ type: 'OBJECTION_RAISED', data: { scope, reason, raised_at: now.toISOString() } }]);
  return { objections_raised: count + 1 };
}

export function resolveObjection(store, orderId, { resolution, note = '' }, now = new Date()) {
  const h = store.getOrder(orderId);
  if (!h.some(e => e.type === 'OBJECTION_RAISED') ||
      h[h.length - 1]?.type === 'OBJECTION_RESOLVED')
    throw new StoreError('NO_OPEN_OBJECTION', '无未决异议');
  appendGuarded(store, orderId, h,
    [{ type: 'OBJECTION_RESOLVED', data: { resolution, note, resolved_at: now.toISOString() } }]);
  return { resolution };
}

// FINALIZED（§7.3/§7.4）：预演存在 ∧ 非争议 ∧ 72h 满 ∧ I3 ∧ E1=0 → 快照+hash 落账
export function finalizeSettlement(store, orderId, { now = new Date() } = {}) {
  const h = store.getOrder(orderId);
  const pv = [...h].reverse().find(e => e.type === 'SETTLEMENT_PREVIEWED');
  if (!pv) throw new StoreError('NO_PREVIEW', '结算前必须先出预演（§7.3）');
  const order = projectOrder(h);
  if (order === 'DISPUTED') throw new StoreError('OBJECTION_OPEN', '异议未解决，结算冻结（§7.3）');
  const elapsedH = (now.getTime() - new Date(pv.occurred_at).getTime()) / 3600_000;
  if (elapsedH < SLA.OBJECTION_PERIOD_HOURS)
    throw new StoreError('PREVIEW_PERIOD_ACTIVE', `异议期未满：${elapsedH.toFixed(1)}h < ${SLA.OBJECTION_PERIOD_HOURS}h`);
  assertI3(store, orderId);
  const e1 = E1(h);
  if (e1.diff !== 0) throw new StoreError('E1_IMBALANCE', `现金守恒破坏：diff=${e1.diff}`);
  const snapshot = { ...pv.data.preview, finalized_at: now.toISOString() };
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  appendGuarded(store, orderId, h,
    [{ type: 'SETTLEMENT_FINALIZED', data: { snapshot, hash } }]);
  return { hash, snapshot };
}
