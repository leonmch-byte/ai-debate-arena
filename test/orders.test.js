import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, StoreError } from '../src/store.js';
import { projectItems, projectOrder, assertEventAllowed } from '../src/orders.js';

const E = (type, fields = {}) => ({ type, ...fields });
const expectCode = (fn, code) =>
  assert.throws(fn, e => e instanceof StoreError && e.code === code, `期望错误码 ${code}`);
const step = (h, ev) => { assertEventAllowed(h, ev); h.push(ev); };

const quoteAndPay = (...ids) => {
  const items = ids.map(id => ({ item_id: id }));
  return [
    E('QUOTE_CREATED', { data: { items } }),
    E('ORDER_CONFIRMED', { data: { items } }),
    E('PAYMENT_SUCCEEDED'),
  ];
};
const running = () => {
  const h = quoteAndPay('itm_1');
  h.push(E('ITEM_LOCKED', { item_id: 'itm_1' }));
  h.push(E('ITEM_STARTED', { item_id: 'itm_1' }));
  return h;
};
const failed = () => {
  const h = running();
  h.push(E('ITEM_FAILED_FINAL', { item_id: 'itm_1', reason_code: 'MODEL_RATE_LIMITED' }));
  return h;
};

test('M2-1 正常履约全链：状态逐步推进，订单 →DELIVERED', () => {
  const h = [];
  step(h, E('QUOTE_CREATED', { data: { items: [{ item_id: 'itm_1' }] } }));
  assert.equal(projectOrder(h), 'QUOTED');
  step(h, E('ORDER_CONFIRMED', { data: { items: [{ item_id: 'itm_1' }] } }));
  assert.equal(projectOrder(h), 'AWAITING_PAYMENT');
  step(h, E('PAYMENT_SUCCEEDED'));
  step(h, E('ITEM_LOCKED', { item_id: 'itm_1' }));
  step(h, E('ITEM_STARTED', { item_id: 'itm_1' }));
  assert.equal(projectOrder(h), 'FULFILLING');
  step(h, E('ITEM_COMPLETED', { item_id: 'itm_1' }));
  assert.equal(projectItems(h).get('itm_1').state, 'COMPLETED');
  assert.equal(projectOrder(h), 'DELIVERED');
});

test('M2-2 终态后一切流转被拒（§3.3-1）', () => {
  const h = running();
  h.push(E('ITEM_COMPLETED', { item_id: 'itm_1' }));
  expectCode(() => assertEventAllowed(h, E('ITEM_STARTED', { item_id: 'itm_1' })), 'ILLEGAL_FROM_TERMINAL');
  expectCode(() => assertEventAllowed(h, E('ITEM_FAILED_FINAL', { item_id: 'itm_1', reason_code: 'MODEL_TIMEOUT' })), 'ILLEGAL_FROM_TERMINAL');
  expectCode(() => assertEventAllowed(h, E('RECOVERY_ATTEMPTED', { item_id: 'itm_1' })), 'ILLEGAL_FROM_TERMINAL');
});

test('M2-3 FAILED_FINAL 不可变 COMPLETED（§3.3-2）', () => {
  const h = failed();
  expectCode(() => assertEventAllowed(h, E('ITEM_COMPLETED', { item_id: 'itm_1' })), 'FAILED_FINAL_NOT_COMPLETABLE');
  assert.equal(projectItems(h).get('itm_1').state, 'FAILED_FINAL');
});

test('M2-4 换模型：决策→补差→后继锁定→前驱 REPLACED（T9/T11）', () => {
  const h = failed();
  step(h, E('DECISION_REQUESTED', { item_id: 'itm_1', data: { decision_id: 'dec_1' } }));
  assert.equal(projectItems(h).get('itm_1').state, 'FAILED_FINAL'); // 仅有决策不产生 REPLACED（§3.3-3）
  step(h, E('DECISION_RECEIVED', { item_id: 'itm_1', data: { decision_id: 'dec_1', choice: 'REPLACE', successor_item_id: 'itm_2', delta_cents: 200 } }));
  assert.equal(projectItems(h).get('itm_1').state, 'FAILED_FINAL'); // 后继未锁定，前驱不得 REPLACED
  expectCode(() => assertEventAllowed(h, E('ITEM_LOCKED', { item_id: 'itm_2' })), 'SURCHARGE_REQUIRED');
  step(h, E('SURCHARGE_EXECUTED', { data: { successor_item_id: 'itm_2' } }));
  const m = projectItems(h);
  assert.equal(m.get('itm_2').state, 'LOCKED');   // T11
  assert.equal(m.get('itm_1').state, 'REPLACED'); // T9 派生
  assert.equal(projectOrder(h), 'FULFILLING');
  expectCode(() => assertEventAllowed(h, E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'USER_DECISION' })), 'REFUND_ON_NON_FAILED');
});

test('M2-5 跳过决策的换模型被结构性阻断（§3.3-5）', () => {
  const h = failed();
  expectCode(() => assertEventAllowed(h, E('SURCHARGE_EXECUTED', { data: { successor_item_id: 'itm_9' } })), 'UNKNOWN_ITEM');
  expectCode(() => assertEventAllowed(h, E('ITEM_LOCKED', { item_id: 'itm_9' })), 'UNKNOWN_ITEM');
  assert.equal(projectItems(h).get('itm_1').state, 'FAILED_FINAL');
});

test('M2-6 退款三路：用户退款 / 无决策被拒 / 超时自动退款（T7/T10）', () => {
  const h1 = failed();
  step(h1, E('DECISION_REQUESTED', { item_id: 'itm_1', data: { decision_id: 'dec_1' } }));
  step(h1, E('DECISION_RECEIVED', { item_id: 'itm_1', data: { decision_id: 'dec_1', choice: 'REFUND' } }));
  step(h1, E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'USER_DECISION' }));
  assert.equal(projectItems(h1).get('itm_1').state, 'REFUNDED');
  assert.equal(projectOrder(h1), 'FULFILLING');
  expectCode(() => assertEventAllowed(failed(), E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'USER_DECISION' })), 'REFUND_WITHOUT_DECISION');
  const h3 = failed();
  step(h3, E('DECISION_REQUESTED', { item_id: 'itm_1', data: { decision_id: 'dec_1' } }));
  step(h3, E('DECISION_TIMEOUT', { item_id: 'itm_1' }));
  expectCode(() => assertEventAllowed(h3, E('DECISION_RECEIVED', { item_id: 'itm_1', data: { choice: 'REPLACE', successor_item_id: 'itm_2' } })), 'DECISION_AFTER_TIMEOUT');
  step(h3, E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'TIMEOUT_RULE' }));
  assert.equal(projectItems(h3).get('itm_1').state, 'TIMEOUT_REFUNDED');
  expectCode(() => assertEventAllowed(failed(), E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'TIMEOUT_RULE' })), 'TIMEOUT_PATH_INVALID');
});

test('M2-7 补差窗口过期：后继 VOIDED、前驱转自动退款、无交付物结算（T12→T10）', () => {
  const h = failed();
  step(h, E('DECISION_REQUESTED', { item_id: 'itm_1', data: { decision_id: 'dec_1' } }));
  step(h, E('DECISION_RECEIVED', { item_id: 'itm_1', data: { decision_id: 'dec_1', choice: 'REPLACE', successor_item_id: 'itm_2', delta_cents: 200 } }));
  step(h, E('SURCHARGE_EXPIRED', { item_id: 'itm_2' }));
  const m = projectItems(h);
  assert.equal(m.get('itm_2').state, 'VOIDED');
  assert.equal(m.get('itm_1').state, 'FAILED_FINAL');
  step(h, E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'TIMEOUT_RULE' }));
  assert.equal(projectItems(h).get('itm_1').state, 'TIMEOUT_REFUNDED');
  step(h, E('SETTLEMENT_PREVIEWED'));
  assert.equal(projectOrder(h), 'SETTLEMENT_PENDING'); // 全退无交付物（§3.2 边则）
});

test('M2-8 领券路径与券的原路补偿（T8/§2.4）', () => {
  const h = failed();
  expectCode(() => assertEventAllowed(h, E('VOUCHER_ISSUED', { item_id: 'itm_1', data: { source: 'FAULT_COMPENSATION' } })), 'VOUCHER_WITHOUT_DECISION');
  step(h, E('DECISION_REQUESTED', { item_id: 'itm_1', data: { decision_id: 'dec_1' } }));
  step(h, E('DECISION_RECEIVED', { item_id: 'itm_1', data: { decision_id: 'dec_1', choice: 'VOUCHER' } }));
  step(h, E('VOUCHER_ISSUED', { item_id: 'itm_1', data: { source: 'FAULT_COMPENSATION' } }));
  assert.equal(projectItems(h).get('itm_1').state, 'VOUCHERED');
  const h2 = failed();
  step(h2, E('DECISION_REQUESTED', { item_id: 'itm_1', data: { decision_id: 'dec_2' } }));
  step(h2, E('DECISION_RECEIVED', { item_id: 'itm_1', data: { decision_id: 'dec_2', choice: 'REFUND' } }));
  step(h2, E('REFUND_EXECUTED', { item_id: 'itm_1', decision_source: 'USER_DECISION' }));
  step(h2, E('VOUCHER_ISSUED', { item_id: 'itm_1', data: { source: 'REFUND_RESTORE' } }));
  assert.equal(projectItems(h2).get('itm_1').state, 'REFUNDED'); // 补偿券不改状态
});

test('M2-9 结算投影全链 + 未终态禁 FINALIZED（§3.3-6 结构部分）', () => {
  const h = quoteAndPay('itm_1', 'itm_2');
  h.push(E('ITEM_LOCKED', { item_id: 'itm_1' }));
  h.push(E('ITEM_STARTED', { item_id: 'itm_1' }));
  h.push(E('ITEM_COMPLETED', { item_id: 'itm_1' }));
  h.push(E('ITEM_LOCKED', { item_id: 'itm_2' }));
  h.push(E('ITEM_STARTED', { item_id: 'itm_2' }));
  h.push(E('ITEM_FAILED_FINAL', { item_id: 'itm_2', reason_code: 'MODEL_AUTH_FAILURE' }));
  h.push(E('DECISION_REQUESTED', { item_id: 'itm_2', data: { decision_id: 'dec_9' } }));
  h.push(E('DECISION_RECEIVED', { item_id: 'itm_2', data: { decision_id: 'dec_9', choice: 'REFUND' } }));
  h.push(E('REFUND_EXECUTED', { item_id: 'itm_2', decision_source: 'USER_DECISION' }));
  assert.equal(projectOrder(h), 'DELIVERED');
  step(h, E('SETTLEMENT_PREVIEWED'));
  assert.equal(projectOrder(h), 'SETTLEMENT_PENDING');
  step(h, E('OBJECTION_RAISED', { data: { scope: 'itm_2' } }));
  assert.equal(projectOrder(h), 'DISPUTED');
  step(h, E('OBJECTION_RESOLVED', { data: { resolution: 'MAINTAIN' } }));
  assert.equal(projectOrder(h), 'SETTLEMENT_PENDING');
  step(h, E('SETTLEMENT_FINALIZED'));
  assert.equal(projectOrder(h), 'SETTLEMENT_FINALIZED');
  expectCode(() => assertEventAllowed(running(), E('SETTLEMENT_FINALIZED')), 'FINALIZED_WITH_OPEN_ITEMS');
});

test('M2-10 恢复环：RUNNING 内可多次尝试，耗尽后 FAILED_FINAL（T4/T6）', () => {
  const h = running();
  step(h, E('RECOVERY_ATTEMPTED', { item_id: 'itm_1' }));
  step(h, E('RECOVERY_ATTEMPTED', { item_id: 'itm_1' }));
  step(h, E('RECOVERY_ATTEMPTED', { item_id: 'itm_1' }));
  assert.equal(projectItems(h).get('itm_1').state, 'RUNNING');
  assert.equal(projectItems(h).get('itm_1').attempts, 3);
  step(h, E('RECOVERY_EXHAUSTED', { item_id: 'itm_1' }));
  step(h, E('ITEM_FAILED_FINAL', { item_id: 'itm_1', reason_code: 'MODEL_RATE_LIMITED' }));
  const it = projectItems(h).get('itm_1');
  assert.equal(it.state, 'FAILED_FINAL');
  assert.equal(it.fail_reason, 'MODEL_RATE_LIMITED');
  const h2 = quoteAndPay('itm_1');
  h2.push(E('ITEM_LOCKED', { item_id: 'itm_1' }));
  expectCode(() => assertEventAllowed(h2, E('RECOVERY_ATTEMPTED', { item_id: 'itm_1' })), 'ILLEGAL_TRANSITION');
});

test('M2-11 真实账本集成：data 载荷往返 + 守卫挂在 store 上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m2-'));
  const s = new EventStore(join(dir, 't.db'));
  s.append('ord_i', [
    E('QUOTE_CREATED', { data: { items: [{ item_id: 'itm_1', locked_price_cents: 800 }] } }),
    E('ORDER_CONFIRMED', { data: { items: [{ item_id: 'itm_1' }] } }),
    E('PAYMENT_SUCCEEDED'),
  ]);
  const h = s.getOrder('ord_i');
  assert.deepEqual(h[0].data, { items: [{ item_id: 'itm_1', locked_price_cents: 800 }] });
  assert.equal(projectOrder(h), 'AWAITING_PAYMENT');
  expectCode(() => assertEventAllowed(h, E('ITEM_COMPLETED', { item_id: 'itm_1' })), 'ILLEGAL_TRANSITION');
  s.close(); rmSync(dir, { recursive: true, force: true });
});
