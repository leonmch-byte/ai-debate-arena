// M5：决策引擎。弹窗数据契约（§4.4）由后端预计算；执行路径（§4.5）落账全部过 M2 守卫。
import { SLA, PRICE_TABLE_VERSION, PRICE_TABLES, VOUCHER_TTL_DAYS } from './config.js';
import { genDecisionId, genItemId, genVoucherId, genOperationId } from './ids.js';
import { StoreError } from './store.js';
import { appendGuarded } from './checkout.js';
import { projectItems } from './orders.js';
import { computeCarryover } from './carryover.js';
import { applyFullRefund, applyDeltaRefund } from './refunds.js';

const yuan = c => '¥' + (c / 100).toFixed(2);

export function buildDecisionPayload(history, orderId, itemId, now = new Date()) {
  const it = projectItems(history).get(itemId);
  if (!it || it.state !== 'FAILED_FINAL') throw new StoreError('NOT_FAILED_FINAL', itemId);
  const rec = (history.find(e => e.type === 'ORDER_CONFIRMED')?.data.items ?? []).find(x => x.item_id === itemId);
  const locked = rec?.locked_price_cents ?? 0;
  const fs = rec?.funding_split ?? { cash_cents: 0, credit_cents: 0 };
  const models = PRICE_TABLES[PRICE_TABLE_VERSION].models;
  const candidates = Object.entries(models)
    .filter(([mid]) => mid !== rec?.model_id)
    .map(([model_id, price]) => {
      const c = computeCarryover({ prior_cash_cents: fs.cash_cents, prior_credit_cents: fs.credit_cents, new_price_cents: price });
      return {
        model_id, price_cents: price,
        delta_cents: c.cash_delta_cents, credit_surplus_cents: c.credit_surplus_cents,
        label: c.cash_delta_cents > 0 ? `补 ${yuan(c.cash_delta_cents)} 更换`
             : c.cash_delta_cents < 0 ? `更换并退 ${yuan(-c.cash_delta_cents)}`
             : '等额更换',
      };
    });
  return {
    decision_id: genDecisionId(), order_id: orderId,
    failed_item: { item_id: itemId, model_id: rec?.model_id, locked_price_cents: locked, reason_code: it.fail_reason },
    funding: { cash_cents: fs.cash_cents, credit_cents: fs.credit_cents },
    expires_at: new Date(now.getTime() + SLA.DECISION_TIMEOUT_HOURS * 3600_000).toISOString(),
    options: [
      { type: 'REFUND',   refund_cash_cents: fs.cash_cents, refund_credit_cents: fs.credit_cents, label: `退款 ${yuan(fs.cash_cents)}，会诊继续` },
      { type: 'VOUCHER',  credit_cents: locked, label: `领取 ${yuan(locked)} 服务额度，会诊继续` },
      { type: 'REPLACE',  candidates },
    ],
    default_on_timeout: 'REFUND',
    notice: `${SLA.DECISION_TIMEOUT_HOURS} 小时未选择将自动退款，会诊不受影响`,
  };
}

export function openDecision(store, orderId, itemId, now = new Date()) {
  const history = store.getOrder(orderId);
  const payload = buildDecisionPayload(history, orderId, itemId, now);
  appendGuarded(store, orderId, history,
    [{ type: 'DECISION_REQUESTED', item_id: itemId, data: { decision_id: payload.decision_id, payload } }]);
  return payload;
}

function receive(store, orderId, itemId, data) {
  appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'DECISION_RECEIVED', item_id: itemId, decision_source: 'USER_DECISION', data }]);
}

export async function executeRefundChoice(store, orderId, itemId, channel) {
  receive(store, orderId, itemId, { choice: 'REFUND' });
  return applyFullRefund(store, orderId, itemId, { channel, decision_source: 'USER_DECISION' });
}

export function executeVoucherChoice(store, orderId, itemId) {
  const rec = (store.getOrder(orderId).find(e => e.type === 'ORDER_CONFIRMED')?.data.items ?? []).find(x => x.item_id === itemId);
  const locked = rec?.locked_price_cents ?? 0;
  receive(store, orderId, itemId, { choice: 'VOUCHER' });
  const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'CREDIT_DUE', item_id: itemId, amount_cents: locked, data: { form: 'CREDIT' } }]);
  const voucher_id = genVoucherId();
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: 'VOUCHER_ISSUED', item_id: itemId, amount_cents: locked, caused_by: [due.event_id],
    data: { source: 'FAULT_COMPENSATION', voucher_id, face_value_cents: locked, expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(), },
  }]);
  return { voucher_id, credit_cents: locked };
}

export async function executeReplaceChoice(store, orderId, itemId, successorModelId, channel) {
  const payload = buildDecisionPayload(store.getOrder(orderId), orderId, itemId);
  const cand = payload.options.find(o => o.type === 'REPLACE').candidates.find(c => c.model_id === successorModelId);
  if (!cand) throw new StoreError('INVALID_SUCCESSOR', successorModelId);
  const succItemId = genItemId();
  receive(store, orderId, itemId, {
    choice: 'REPLACE', successor_item_id: succItemId,
    successor_model_id: successorModelId, delta_cents: cand.delta_cents,
  });
  const c = computeCarryover({
    prior_cash_cents: payload.funding.cash_cents,
    prior_credit_cents: payload.funding.credit_cents,
    new_price_cents: cand.price_cents,
  });
  const succFunding = { cash_cents: c.cash_due_cents, credit_cents: c.credit_carried_cents };

  if (c.cash_delta_cents > 0) {                                   // 补差（§5.3）
    const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
      [{ type: 'SURCHARGE_DUE', item_id: itemId, amount_cents: c.cash_delta_cents,
         data: { successor_item_id: succItemId, successor_model_id: successorModelId } }]);
    const opId = genOperationId('surcharge', orderId, succItemId);
    store.recordOperation({ operation_id: opId, order_id: orderId, obligation_id: due.event_id, type: 'surcharge' });
    const res = await channel.charge({ operation_id: opId, amount_cents: c.cash_delta_cents });
    if (res.state !== 'SUCCEEDED') { store.markOperation(opId, 'FAILED'); throw new StoreError('SURCHARGE_FAILED', '补差支付未成功'); }
    store.markOperation(opId, 'EXECUTED', res.channel_ref);
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'SURCHARGE_EXECUTED', amount_cents: c.cash_delta_cents, caused_by: [due.event_id],
      data: { successor_item_id: succItemId, operation_id: opId, channel_ref: res.channel_ref, funding_split: succFunding },
    }]);                                                          // T11：后继直接 LOCKED
  } else if (c.cash_delta_cents < 0) {                            // 退差（§2.5）
    await applyDeltaRefund(store, orderId, itemId, -c.cash_delta_cents, { channel });
    appendGuarded(store, orderId, store.getOrder(orderId),
      [{ type: 'ITEM_LOCKED', item_id: succItemId, data: { funding_split: succFunding } }]);
  } else {
    appendGuarded(store, orderId, store.getOrder(orderId),
      [{ type: 'ITEM_LOCKED', item_id: succItemId, data: { funding_split: succFunding } }]);
  }
  if (c.credit_surplus_cents > 0) {                               // 券溢余：订单级发新券（§2.5）
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'VOUCHER_ISSUED', amount_cents: c.credit_surplus_cents,
      data: { source: 'CARRYOVER_SURPLUS', voucher_id: genVoucherId(), face_value_cents: c.credit_surplus_cents, expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(), },
    }]);
  }
  return { successor_item_id: succItemId, carryover: c };
}

export async function executeTimeout(store, orderId, itemId, channel) {
  appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'DECISION_TIMEOUT', item_id: itemId }]);
  return applyFullRefund(store, orderId, itemId, { channel, decision_source: 'TIMEOUT_RULE' });
}
