// §5.4 退款执行：现金走渠道（义务→operation→执行，I2 幂等）；券部分原路补偿发新券（§2.4）。
// 重试语义（§5.4）：复用未决义务（无 REFUND_EXECUTED 引用的 REFUND_DUE），义务至多生效一次。
import { genOperationId, genVoucherId } from './ids.js';
import { StoreError } from './store.js';
import { appendGuarded } from './checkout.js';

export function orderItem(history, itemId) {
  const oc = history.find(e => e.type === 'ORDER_CONFIRMED');
  return (oc?.data.items ?? []).find(x => x.item_id === itemId) ?? null;
}

async function executeObligation(store, orderId, { item_id, dueEvent, executeType, decision_source,
  amount_cents, kind, channelRefFn, extra = {} }) {
  const opId = genOperationId(executeType.toLowerCase(), orderId, item_id);
  store.recordOperation({ operation_id: opId, order_id: orderId, obligation_id: dueEvent.event_id, type: executeType.toLowerCase() });
  const res = await channelRefFn({ operation_id: opId, amount_cents });
  if (res.state === 'UNKNOWN') {
    store.markOperation(opId, 'UNKNOWN');
    throw new StoreError('REFUND_UNKNOWN', '渠道状态未决，入重试队列（§5.1）');
  }
  if (res.state === 'FAILED') {
    store.markOperation(opId, 'FAILED');
    throw new StoreError('REFUND_STUCK', '渠道拒绝，可重试（复用义务，新 operation，§5.4）');
  }
  store.markOperation(opId, 'EXECUTED', res.channel_ref);
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: executeType, item_id, amount_cents, decision_source, caused_by: [dueEvent.event_id],
    data: { operation_id: opId, channel_ref: res.channel_ref, kind, ...extra },
  }]);
  return { operation_id: opId, channel_ref: res.channel_ref };
}

export async function applyFullRefund(store, orderId, itemId, { channel, decision_source = 'USER_DECISION' }) {
  const history = store.getOrder(orderId);
  const rec = orderItem(history, itemId);
  const fs = rec?.funding_split ?? { cash_cents: 0, credit_cents: 0 };
  const cash = fs.cash_cents ?? 0;

  // 未决义务复用：存在未被任何执行引用的 FULL_REFUND DUE → 重试，不新建
  const executedRefs = new Set(history.filter(e => e.type === 'REFUND_EXECUTED').flatMap(e => e.caused_by ?? []));
  let due = history.find(e => e.type === 'REFUND_DUE' && e.item_id === itemId
    && (e.data?.kind ?? 'FULL_REFUND') === 'FULL_REFUND' && !executedRefs.has(e.event_id));
  if (!due) {
    [due] = appendGuarded(store, orderId, history,
      [{ type: 'REFUND_DUE', item_id: itemId, amount_cents: cash, data: { kind: 'FULL_REFUND' } }]);
  }

  if (cash > 0) {
    await executeObligation(store, orderId, {
      item_id: itemId, dueEvent: due, executeType: 'REFUND_EXECUTED',
      decision_source, amount_cents: cash, kind: 'FULL_REFUND',
      channelRefFn: a => channel.refund(a),
    });
  } else {
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'REFUND_EXECUTED', item_id: itemId, amount_cents: 0, decision_source,
      caused_by: [due.event_id], data: { kind: 'FULL_REFUND', zero_cash: true },
    }]);
  }

  const creditIssued = history.some(e =>
    e.type === 'VOUCHER_ISSUED' && e.item_id === itemId && e.data?.source === 'REFUND_RESTORE');
  if ((fs.credit_cents ?? 0) > 0 && !creditIssued) {
    const voucher_id = genVoucherId();
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'VOUCHER_ISSUED', item_id: itemId, amount_cents: fs.credit_cents,
      data: { source: 'REFUND_RESTORE', voucher_id, face_value_cents: fs.credit_cents },
    }]);
    return { refunded_cash_cents: cash, voucher_id, credit_cents: fs.credit_cents };
  }
  return { refunded_cash_cents: cash, voucher_id: null, credit_cents: 0 };
}

export async function applyDeltaRefund(store, orderId, itemId, amount_cents, { channel }) {
  const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'REFUND_DUE', item_id: itemId, amount_cents, data: { kind: 'REPLACE_DELTA_REFUND' } }]);
  return executeObligation(store, orderId, {
    item_id: itemId, dueEvent: due, executeType: 'REFUND_EXECUTED',
    decision_source: 'USER_DECISION', amount_cents, kind: 'REPLACE_DELTA_REFUND',
    channelRefFn: a => channel.refund(a),
  });
}
