// M7→fix：自动化钟表。修复：扫描器必须 await 每个 async 执行器，
// 禁止"发射后不管"——未决的退款落账对账即成 phantom，对资金系统不可接受。
import { SLA, WORKER_INTERVAL_SECONDS } from './config.js';
import { executeTimeout } from './decisions.js';
import { applyFullRefund } from './refunds.js';
import { finalizeSettlement } from './settlement.js';
import { appendGuarded } from './checkout.js';
import { projectVouchers } from './vouchers.js';

// §6.6 券过期
export function expireVouchers(store, now = new Date()) {
  const vmap = projectVouchers(store.getAllEvents());
  const out = [];
  for (const v of vmap.values()) {
    if (v.remaining_cents <= 0) continue;
    if (!v.expires_at || new Date(v.expires_at) > now) continue;
    store.append('ord_system', [{
      type: 'VOUCHER_EXPIRED',
      data: { voucher_id: v.voucher_id, expired_cents: v.remaining_cents, expired_at: now.toISOString() },
    }]);
    out.push({ voucher_id: v.voucher_id, expired_cents: v.remaining_cents });
  }
  return out;
}

// T10：24h 未决策 → 自动退款
export async function scanDecisionTimeouts(store, channel, now = new Date()) {
  const fired = [];
  for (const req of store.getEventsByType('DECISION_REQUESTED')) {
    const orderId = req.order_id, itemId = req.item_id;
    const exp = req.data?.payload?.expires_at;
    if (!exp || new Date(exp) > now) continue;
    const h = store.getOrder(orderId);
    const later = h.filter(e => e.item_id === itemId && e.seq > req.seq &&
      ['DECISION_RECEIVED', 'DECISION_TIMEOUT'].includes(e.type));
    if (later.length) continue;
    await executeTimeout(store, orderId, itemId, channel);
    fired.push({ order_id: orderId, item_id: itemId });
  }
  return fired;
}

// T12→T10：补差窗口过期 → 后继作废 + 前驱自动退款
export async function scanSurchargeWindows(store, channel, now = new Date()) {
  const fired = [];
  for (const due of store.getEventsByType('SURCHARGE_DUE')) {
    const orderId = due.order_id;
    const succ = due.data?.successor_item_id;
    const deadline = new Date(due.occurred_at).getTime() + SLA.SURCHARGE_WINDOW_MINUTES * 60_000;
    if (now.getTime() < deadline) continue;
    const h = store.getOrder(orderId);
    if (h.some(e => (e.type === 'SURCHARGE_EXECUTED' && (e.caused_by ?? []).includes(due.event_id)) ||
                    (e.type === 'SURCHARGE_EXPIRED' && e.item_id === succ))) continue;
    appendGuarded(store, orderId, h, [{ type: 'SURCHARGE_EXPIRED', item_id: succ }]);
    await applyFullRefund(store, orderId, due.item_id, { channel, decision_source: 'TIMEOUT_RULE' });
    fired.push({ order_id: orderId, successor_item_id: succ, refunded_item_id: due.item_id });
  }
  return fired;
}

// §7.3：预演 72h 无异议 → 自动 FINALIZED（I3 不满足则本周期跳过）
export async function scanSettlements(store, now = new Date()) {
  const finalized = [], skipped = [];
  const previews = store.getEventsByType('SETTLEMENT_PREVIEWED');
  const latestByOrder = new Map();
  for (const e of previews) latestByOrder.set(e.order_id, e);
  for (const [orderId, pv] of latestByOrder) {
    const h = store.getOrder(orderId);
    if (h.some(e => e.type === 'SETTLEMENT_FINALIZED')) continue;
    if (new Date(pv.occurred_at).getTime() + SLA.OBJECTION_PERIOD_HOURS * 3600_000 > now.getTime()) continue;
    try {
      finalizeSettlement(store, orderId, { now });
      finalized.push({ order_id: orderId });
    } catch (err) { skipped.push({ order_id: orderId, code: err.code ?? 'ERROR' }); }
  }
  return { finalized, skipped };
}

export async function runCycle(store, channel, now = new Date()) {
  const out = { decision_timeouts: [], surcharge_expiries: [], auto_finalized: [], vouchers_expired: [], errors: [] };
  const step = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (e) { out.errors.push({ task: name, code: e.code ?? 'ERROR', message: e.message }); }
  };
  await step('decision_timeouts',  () => scanDecisionTimeouts(store, channel, now));
  await step('surcharge_expiries', () => scanSurchargeWindows(store, channel, now));
  await step('auto_finalized_scan',() => scanSettlements(store, now));
  out.auto_finalized = out.auto_finalized_scan?.finalized ?? [];
  if (out.auto_finalized_scan?.skipped?.length)
    out.errors.push(...out.auto_finalized_scan.skipped.map(s => ({ task: 'finalize', ...s })));
  await step('vouchers_expired',   () => expireVouchers(store, now));
  return out;
}
export { WORKER_INTERVAL_SECONDS };
