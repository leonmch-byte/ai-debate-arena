// §5.4 退款执行：现金部分走渠道（义务→operation→执行，I2 幂等）；券部分原路补偿发新券（§2.4）。
import { genOperationId, genVoucherId } from './ids.js';
import { StoreError } from './store.js';
import { appendGuarded } from './checkout.js';

export function orderItem(history, itemId) {
  const oc = history.find(e => e.type === 'ORDER_CONFIRMED');
  return (oc?.data.items ?? []).find(x => x.item_id === itemId) ?? null;
}

// 义务→渠道→执行。同义务重试安全：obligation_id 唯一索引兜底（I2）。
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
    throw new StoreError('REFUND_STUCK', '渠道拒绝，可重试（新 operation，§5.4）');
  }
  store.markOperation(opId, 'EXECUTED', res.channel_ref);
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: executeType, item_id, amount_cents, decision_source, caused_by: [dueEvent.event_id],
    data: { operation_id: opId, channel_ref: res.channel_ref, kind, ...extra },
  }]);
  return { operation_id: opId, channel_ref: res.channel_ref };
}

// 全额退款（用户选退款 / 超时自动退款共用）。cash=0（纯券单）也发零额 REFUND_EXECUTED 推进状态。
export async function applyFullRefund(store, orderId, itemId, { channel, decision_source = 'USER_DECISION' }) {
  const rec = orderItem(store.getOrder(orderId), itemId);
  const fs = rec?.funding_split ?? { cash_cents: 0, credit_cents: 0 };
  const cash = fs.cash_cents ?? 0;

  const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'REFUND_DUE', item_id: itemId, amount_cents: cash, data: { kind: 'FULL_REFUND' } }]);

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

  if ((fs.credit_cents ?? 0) > 0) {
    const voucher_id = genVoucherId();
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'VOUCHER_ISSUED', item_id: itemId, amount_cents: fs.credit_cents,
      data: { source: 'REFUND_RESTORE', voucher_id, face_value_cents: fs.credit_cents },
    }]);
    return { refunded_cash_cents: cash, voucher_id, credit_cents: fs.credit_cents };
  }
  return { refunded_cash_cents: cash, voucher_id: null, credit_cents: 0 };
}

// 换模型退差（delta<0）。kind=REPLACE_DELTA_REFUND，前驱状态不动（T9 派生）。
export async function applyDeltaRefund(store, orderId, itemId, amount_cents, { channel }) {
  const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'REFUND_DUE', item_id: itemId, amount_cents, data: { kind: 'REPLACE_DELTA_REFUND' } }]);
  return executeObligation(store, orderId, {
    item_id: itemId, dueEvent: due, executeType: 'REFUND_EXECUTED',
    decision_source: 'USER_DECISION', amount_cents, kind: 'REPLACE_DELTA_REFUND',
    channelRefFn: a => channel.refund(a),
  });
}
