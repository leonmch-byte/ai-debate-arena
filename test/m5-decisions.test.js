import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { projectItems, projectOrder } from '../src/orders.js';
import { createQuote } from '../src/pricing.js';
import { confirmPayment } from '../src/checkout.js';
import { SandboxChannel } from '../src/payments.js';
import { fulfillItem } from '../src/fulfillment.js';
import { computeCarryover } from '../src/carryover.js';
import { openDecision, executeRefundChoice, executeVoucherChoice,
         executeReplaceChoice, executeTimeout } from '../src/decisions.js';
import { E1 } from '../src/settlement.js';
import { assertI7 } from '../src/vouchers.js';

const paidOrder = async (modelIds, vouchers = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m5-'));
  const store = new EventStore(join(dir, 't.db'));
  const q = createQuote(store, { user_id: 'u_m5', model_ids: modelIds, vouchers });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel(), vouchers });
  return { dir, store, orderId: q.order_id, items: q.items };
};
const cleanup = (s, d) => { s.close(); rmSync(d, { recursive: true, force: true }); };
const failItem = async (store, orderId, itemId, modelId, reason = 'MODEL_AUTH_FAILURE') => {
  const Noop = { async run() { return { ok: false, reason_code: reason }; } };
  await fulfillItem(store, orderId, itemId, modelId, Noop, { backoffMs: 0 });
};
class OkAdapter {
  constructor(ref = 'res_ok') { this.ref = ref; }
  async run() { return { ok: true, result_ref: this.ref }; }
}

test('M5-1 结转代数四方向（§2.5 金样本）', () => {
  assert.deepEqual(computeCarryover({ prior_cash_cents: 800, prior_credit_cents: 0, new_price_cents: 1000 }),
    { credit_carried_cents: 0, cash_due_cents: 1000, cash_delta_cents: 200, credit_surplus_cents: 0 });
  assert.deepEqual(computeCarryover({ prior_cash_cents: 800, prior_credit_cents: 0, new_price_cents: 600 }),
    { credit_carried_cents: 0, cash_due_cents: 600, cash_delta_cents: -200, credit_surplus_cents: 0 });
  assert.deepEqual(computeCarryover({ prior_cash_cents: 0, prior_credit_cents: 800, new_price_cents: 1000 }),
    { credit_carried_cents: 800, cash_due_cents: 200, cash_delta_cents: 200, credit_surplus_cents: 0 });
  assert.deepEqual(computeCarryover({ prior_cash_cents: 0, prior_credit_cents: 800, new_price_cents: 600 }),
    { credit_carried_cents: 600, cash_due_cents: 0, cash_delta_cents: 0, credit_surplus_cents: 200 });
});

test('M5-2 弹窗契约：金额预计算、候选全集、超时默认（§4.4）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['qwen-max']);
  await failItem(store, orderId, items[0].item_id, 'qwen-max');
  const p = openDecision(store, orderId, items[0].item_id);
  assert.equal(p.failed_item.locked_price_cents, 800);
  assert.deepEqual(p.funding, { cash_cents: 800, credit_cents: 0 });
  assert.equal(p.options[0].type, 'REFUND');
  assert.equal(p.options[0].refund_cash_cents, 800);
  assert.equal(p.options[1].type, 'VOUCHER');
  assert.equal(p.options[1].credit_cents, 800);
  const reps = p.options[2].candidates;
  assert.equal(reps.find(c => c.model_id === 'gpt-4o').delta_cents, 200);
  assert.equal(reps.find(c => c.model_id === 'deepseek-v3').delta_cents, -200);
  assert.equal(reps.find(c => c.model_id === 'kimi').delta_cents, 0);
  assert.equal(p.default_on_timeout, 'REFUND');
  assert.ok(new Date(p.expires_at) > new Date());
  cleanup(store, dir);
});

test('M5-3 选退款：现金单退现金 / 纯券单发补偿券（T7/§2.4/§5.4）', async () => {
  {
    const { store, dir, orderId, items } = await paidOrder(['qwen-max']);
    const it = items[0].item_id;
    await failItem(store, orderId, it, 'qwen-max');
    openDecision(store, orderId, it);
    const r = await executeRefundChoice(store, orderId, it, new SandboxChannel());
    assert.equal(r.refunded_cash_cents, 800);
    const h = store.getOrder(orderId);
    assert.ok(h.some(e => e.type === 'REFUND_DUE' && e.amount_cents === 800));
    assert.ok(h.some(e => e.type === 'REFUND_EXECUTED' && e.amount_cents === 800));
    assert.equal(projectItems(h).get(it).state, 'REFUNDED');
    assert.equal(E1(h).diff, 0);
    cleanup(store, dir);
  }
  {
    const vch = { voucher_id: 'vch_m5a', remaining_cents: 800, expires_at: '2026-06-30' };
    const { store, dir, orderId, items } = await paidOrder(['kimi'], [vch]);
    const it = items[0].item_id;
    await failItem(store, orderId, it, 'kimi');
    openDecision(store, orderId, it);
    const r = await executeRefundChoice(store, orderId, it, new SandboxChannel());
    assert.equal(r.refunded_cash_cents, 0);
    assert.equal(r.credit_cents, 800);
    const h = store.getOrder(orderId);
    const iss = h.find(e => e.type === 'VOUCHER_ISSUED');
    assert.equal(iss.data.source, 'REFUND_RESTORE');
    assert.equal(iss.data.face_value_cents, 800);
    assert.equal(projectItems(h).get(it).state, 'REFUNDED');
    cleanup(store, dir);
  }
});

test('M5-4 换贵模型：补差200→后继锁定→履约→REPLACED，E1=0（T9/T11）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['qwen-max']);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'qwen-max');
  openDecision(store, orderId, it);
  const r = await executeReplaceChoice(store, orderId, it, 'gpt-4o', new SandboxChannel());
  assert.equal(r.carryover.cash_delta_cents, 200);
  const h1 = store.getOrder(orderId);
  assert.equal(projectItems(h1).get(it).state, 'REPLACED');
  assert.equal(projectItems(h1).get(r.successor_item_id).state, 'LOCKED');
  const fr = await fulfillItem(store, orderId, r.successor_item_id, 'gpt-4o', new OkAdapter('res_F'), { backoffMs: 0 });
  assert.equal(fr.completed, true);
  const h2 = store.getOrder(orderId);
  assert.equal(projectOrder(h2), 'DELIVERED');
  const e1 = E1(h2);
  assert.equal(e1.paid_cash_cents, 1000);     // 800 + 补差 200
  assert.equal(e1.expected_cash_cents, 1000); // 后继 cash
  assert.equal(e1.diff, 0);
  cleanup(store, dir);
});

test('M5-5 换便宜模型：自动退差400→后继履约→REPLACED，E1=0（§2.5）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['gpt-4o']);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'gpt-4o');
  openDecision(store, orderId, it);
  const r = await executeReplaceChoice(store, orderId, it, 'deepseek-v3', new SandboxChannel());
  assert.equal(r.carryover.cash_delta_cents, -400);   // 1000 → 600
  const h1 = store.getOrder(orderId);
  assert.ok(h1.some(e => e.type === 'REFUND_EXECUTED' && e.amount_cents === 400 && e.data.kind === 'REPLACE_DELTA_REFUND'));
  assert.equal(projectItems(h1).get(it).state, 'REPLACED');
  await fulfillItem(store, orderId, r.successor_item_id, 'deepseek-v3', new OkAdapter('res_ds'), { backoffMs: 0 });
  const h2 = store.getOrder(orderId);
  assert.equal(projectOrder(h2), 'DELIVERED');
  const e1 = E1(h2);
  assert.equal(e1.paid_cash_cents, 1000);
  assert.equal(e1.refunded_cash_cents, 400);
  assert.equal(e1.diff, 0);
  cleanup(store, dir);
});

test('M5-6 决策超时：自动全额退款 TIMEOUT_REFUNDED（T10）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi']);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'kimi');
  openDecision(store, orderId, it);
  const r = await executeTimeout(store, orderId, it, new SandboxChannel());
  assert.equal(r.refunded_cash_cents, 800);
  const h = store.getOrder(orderId);
  assert.ok(h.some(e => e.type === 'DECISION_TIMEOUT'));
  assert.equal(projectItems(h).get(it).state, 'TIMEOUT_REFUNDED');
  assert.equal(E1(h).diff, 0);
  cleanup(store, dir);
});

test('M5-7 领券继续：全额发券 VOUCHERED（T8）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['doubao-pro']);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'doubao-pro');
  openDecision(store, orderId, it);
  const r = executeVoucherChoice(store, orderId, it);
  assert.equal(r.credit_cents, 800);
  const h = store.getOrder(orderId);
  const iss = h.find(e => e.type === 'VOUCHER_ISSUED');
  assert.equal(iss.data.source, 'FAULT_COMPENSATION');
  assert.equal(projectItems(h).get(it).state, 'VOUCHERED');
  assert.equal(E1(h).diff, 0);
  cleanup(store, dir);
});

test('M5-8 券换便宜模型：券溢余200发回 + E1=0（券8→6 场景）', async () => {
  const vch = { voucher_id: 'vch_m5b', remaining_cents: 800, expires_at: '2026-06-30' };
  const { store, dir, orderId, items } = await paidOrder(['kimi'], [vch]);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'kimi');
  openDecision(store, orderId, it);
  const r = await executeReplaceChoice(store, orderId, it, 'deepseek-v3', new SandboxChannel());
  assert.equal(r.carryover.credit_surplus_cents, 200);
  assert.equal(r.carryover.cash_delta_cents, 0);
  const h = store.getOrder(orderId);
  const surplus = h.filter(e => e.type === 'VOUCHER_ISSUED' && e.data.source === 'CARRYOVER_SURPLUS');
  assert.equal(surplus.length, 1);
  assert.equal(surplus[0].data.face_value_cents, 200);
  await fulfillItem(store, orderId, r.successor_item_id, 'deepseek-v3', new OkAdapter(), { backoffMs: 0 });
  const h2 = store.getOrder(orderId);
  assert.equal(projectOrder(h2), 'DELIVERED');
  assert.equal(E1(h2).diff, 0);
  cleanup(store, dir);
});

test('M5-9 退款渠道失败→重试：复用义务新 operation 成功，义务只生效一次（I2/§5.4）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['qwen-max']);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'qwen-max');
  openDecision(store, orderId, it);
  const ch = new SandboxChannel(['FAILED']);
  await assert.rejects(() => executeRefundChoice(store, orderId, it, ch), e => e.code === 'REFUND_STUCK');
  const { applyFullRefund } = await import('../src/refunds.js');
  const r = await applyFullRefund(store, orderId, it, { channel: ch, decision_source: 'USER_DECISION' });
  assert.equal(r.refunded_cash_cents, 800);
  const h = store.getOrder(orderId);
  assert.equal(h.filter(e => e.type === 'REFUND_EXECUTED').length, 1);
  const due = h.find(e => e.type === 'REFUND_DUE');
  assert.equal(store.getOperation(h.find(e => e.type === 'REFUND_EXECUTED').data.operation_id).state, 'EXECUTED');
  assert.ok(h.filter(e => e.type === 'REFUND_EXECUTED').every(x => x.caused_by.includes(due.event_id)));
  assert.equal(projectItems(h).get(it).state, 'REFUNDED');
  cleanup(store, dir);
});

test('M5-10 券账本 I7：多来源券全生命周期守恒（§6.7）', async () => {
  const vch = { voucher_id: 'vch_m5c', remaining_cents: 800, expires_at: '2026-06-30' };
  const { store, dir, orderId, items } = await paidOrder(['kimi'], [vch]);
  const it = items[0].item_id;
  await failItem(store, orderId, it, 'kimi');
  openDecision(store, orderId, it);
  executeVoucherChoice(store, orderId, it);
  const events = [
    { type: 'VOUCHER_ISSUED', data: { voucher_id: 'vch_m5c', source: 'MANUAL', face_value_cents: 800 } },
    ...store.getOrder(orderId),
  ];
  assertI7(events); // 原券 face 800 = redeemed 800；新券 face 800 = remaining 800
  const v = (await import('../src/vouchers.js')).projectVouchers(events);
  assert.equal(v.get('vch_m5c').redeemed_cents, 800);
  cleanup(store, dir);
});
