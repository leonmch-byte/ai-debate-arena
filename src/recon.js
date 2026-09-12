// M7：对账。operations 表是渠道真象的镜像。§5.5：
// 渠道有账本无 → missing_event（查证补事件）；账本有渠道无 → phantom（LEDGER_CORRECTION 对冲）；
// 金额不符 → amount_mismatch；未决超龄 → stale_pending（MANUAL_POOL 准入 §8.2）。
import { SLA } from './config.js';
import { projectItems, projectOrder, ITEM_TERMINAL } from './orders.js';
import { E1 } from './settlement.js';
import { assertI7 } from './vouchers.js';

export function reconcileOperations(store, { now = new Date() } = {}) {
  const issues = { missing_event: [], phantom: [], amount_mismatch: [], stale_pending: [] };
  const eventOps = new Map();   // operation_id → { order_id, amount_cents, types[] }
  for (const orderId of store.getAllOrderIds()) {
    for (const e of store.getOrder(orderId)) {
      const opId = e.data?.operation_id;
      if (!opId) continue;
      if (!['PAYMENT_SUCCEEDED', 'REFUND_EXECUTED', 'SURCHARGE_EXECUTED'].includes(e.type)) continue;
      const cur = eventOps.get(opId) ?? { order_id: orderId, amount_cents: 0, caused: [] };
      cur.amount_cents += e.amount_cents ?? 0;
      cur.caused.push(...(e.caused_by ?? []));
      eventOps.set(opId, cur);
    }
  }
  for (const op of store.getAllOperations()) {
    const ev = eventOps.get(op.operation_id);
    const ageMin = (now.getTime() - new Date(op.updated_at).getTime()) / 60_000;
    if (op.state === 'EXECUTED' && !ev)
      issues.missing_event.push({ operation_id: op.operation_id, order_id: op.order_id, type: op.type });
    if (op.state !== 'EXECUTED' && ['CREATED', 'EXECUTING', 'UNKNOWN'].includes(op.state) &&
        ageMin > SLA.PAYMENT_UNKNOWN_POOL_MINUTES)
      issues.stale_pending.push({ operation_id: op.operation_id, order_id: op.order_id, state: op.state, age_minutes: Math.round(ageMin) });
  }
  for (const [opId, ev] of eventOps) {
    const op = store.getOperation(opId);
    if (!op || op.state !== 'EXECUTED')
      issues.phantom.push({ operation_id: opId, order_id: ev.order_id });
  }
  // 金额核对：执行事件 vs 其引用的义务
  for (const orderId of store.getAllOrderIds()) {
    const h = store.getOrder(orderId);
    const dues = new Map(h.filter(e => ['REFUND_DUE', 'SURCHARGE_DUE', 'CREDIT_DUE'].includes(e.type)).map(e => [e.event_id, e]));
    for (const e of h) {
      if (!['REFUND_EXECUTED', 'SURCHARGE_EXECUTED'].includes(e.type)) continue;
      const expected = (e.caused_by ?? []).reduce((a, r) => a + (dues.get(r)?.amount_cents ?? 0), 0);
      if ((e.caused_by ?? []).length && e.amount_cents !== expected)
        issues.amount_mismatch.push({ order_id: orderId, seq: e.seq, expected, actual: e.amount_cents });
    }
  }
  return issues;
}

// §9.5 事件溯源重放校验：全库逐单重放投影 + 终态单 E1 + 全库 I7
export function sweepInvariants(store) {
  const violations = [];
  for (const orderId of store.getAllOrderIds()) {
    const h = store.getOrder(orderId);
    try {
      const status = projectOrder(h);
      if (['DELIVERED', 'SETTLEMENT_PENDING', 'SETTLEMENT_FINALIZED'].includes(status)) {
        const d = E1(h).diff;
        if (d !== 0) violations.push({ order_id: orderId, kind: 'E1_IMBALANCE', diff: d });
      }
    } catch (e) { violations.push({ order_id: orderId, kind: 'REPLAY_ERROR', code: e.code ?? 'ERROR' }); }
  }
  try { assertI7(store.getAllEvents()); }
  catch (e) { violations.push({ order_id: null, kind: 'I7_VIOLATED', message: e.message }); }
  return { checked: store.getAllOrderIds().length, violations };
}
