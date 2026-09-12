import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { projectOrder } from '../src/orders.js';
import { createQuote } from '../src/pricing.js';
import { confirmPayment, appendGuarded } from '../src/checkout.js';
import { SandboxChannel } from '../src/payments.js';
import { verifyE1 } from '../src/settlement.js';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m3-'));
  return { dir, store: new EventStore(join(dir, 't.db')) };
};
const cleanup = (store, dir) => { store.close(); rmSync(dir, { recursive: true, force: true }); };
const driveToCompletion = (store, orderId, history, items) => {
  const drive = [];
  for (const it of items)
    drive.push({ type: 'ITEM_LOCKED', item_id: it.item_id },
               { type: 'ITEM_STARTED', item_id: it.item_id },
               { type: 'ITEM_COMPLETED', item_id: it.item_id });
  appendGuarded(store, orderId, history, drive);
};

test('M3-4 沙箱收款正常链 + E1 守恒 = 0', async () => {
  const { dir, store } = fresh();
  const q = createQuote(store, { user_id: 'u_1', model_ids: ['gpt-4o', 'deepseek-v3'] });
  assert.equal(q.total_cents, 1600);
  const r = await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  assert.equal(r.cash_paid_cents, 1600);
  assert.equal(r.status, 'FULFILLING');
  const h = store.getOrder(q.order_id);
  const oc = h.find(e => e.type === 'ORDER_CONFIRMED');
  for (const it of oc.data.items)
    assert.deepEqual(it.funding_split, { cash_cents: it.locked_price_cents, credit_cents: 0, allocations: [] });
  driveToCompletion(store, q.order_id, h, oc.data.items);
  assert.equal(projectOrder(store.getOrder(q.order_id)), 'DELIVERED');
  const e1 = verifyE1(store.getOrder(q.order_id));
  assert.equal(e1.diff, 0);
  assert.equal(e1.paid_cash_cents, 1600);
  cleanup(store, dir);
});

test('M3-5 券混合支付：funding_split 落账 + VOUCHER_REDEEMED 明细 + E1 = 0', async () => {
  const { dir, store } = fresh();
  const vch = { voucher_id: 'vch_t1', remaining_cents: 1600, expires_at: '2026-06-30' };
  const q = createQuote(store, { user_id: 'u_1', model_ids: ['deepseek-v3', 'qwen-max', 'kimi'], vouchers: [vch] });
  assert.equal(q.total_cents, 2200);
  const r = await confirmPayment(store, q.order_id, { channel: new SandboxChannel(), vouchers: [vch] });
  assert.equal(r.cash_paid_cents, 600);
  const h = store.getOrder(q.order_id);
  const redeemed = h.filter(e => e.type === 'VOUCHER_REDEEMED');
  assert.equal(redeemed.length, 1);
  assert.equal(redeemed[0].data.applied_cents, 1600);
  assert.equal(redeemed[0].data.allocations.length, 3);
  const oc = h.find(e => e.type === 'ORDER_CONFIRMED');
  driveToCompletion(store, q.order_id, h, oc.data.items);
  const e1 = verifyE1(store.getOrder(q.order_id));
  assert.equal(e1.diff, 0);
  assert.equal(e1.paid_cash_cents, 600);
  cleanup(store, dir);
});

test('M3-6 报价过期：锁价窗口外确认 → 作废 + 额度释放（§5.2/§6.2）', async () => {
  const { dir, store } = fresh();
  const vch = { voucher_id: 'vch_t2', remaining_cents: 800, expires_at: '2026-06-30' };
  const q = createQuote(store,
    { user_id: 'u_1', model_ids: ['qwen-max'], vouchers: [vch], now: new Date('2025-09-12T10:00:00Z') });
  assert.equal(q.expires_at, '2025-09-12T10:15:00.000Z');
  await assert.rejects(
    () => confirmPayment(store, q.order_id,
      { channel: new SandboxChannel(), vouchers: [vch], now: new Date('2025-09-12T10:16:00Z') }),
    e => e.code === 'QUOTE_EXPIRED');
  const h = store.getOrder(q.order_id);
  assert.ok(h.some(e => e.type === 'QUOTE_EXPIRED'));
  const rel = h.find(e => e.type === 'VOUCHER_RELEASED');
  assert.equal(rel.data.voucher_id, 'vch_t2');
  assert.equal(rel.data.released_cents, 800);
  assert.equal(projectOrder(h), 'VOIDED');
  cleanup(store, dir);
});

test('M3-7 支付失败→重试：新 operation，旧 FAILED 不阻塞（§5.1）', async () => {
  const { dir, store } = fresh();
  const ch = new SandboxChannel(['FAILED', 'SUCCEEDED']);
  const q = createQuote(store, { user_id: 'u_1', model_ids: ['kimi', 'doubao-pro'] });
  await assert.rejects(() => confirmPayment(store, q.order_id, { channel: ch }),
    e => e.code === 'PAYMENT_DECLINED');
  let h = store.getOrder(q.order_id);
  assert.ok(h.some(e => e.type === 'PAYMENT_FAILED'));
  const op1 = h.find(e => e.type === 'PAYMENT_INITIATED').data.operation_id;
  assert.equal(store.getOperation(op1).state, 'FAILED');
  const r2 = await confirmPayment(store, q.order_id, { channel: ch });
  assert.equal(r2.status, 'FULFILLING');
  h = store.getOrder(q.order_id);
  const inits = h.filter(e => e.type === 'PAYMENT_INITIATED');
  assert.equal(inits.length, 2);
  assert.notEqual(inits[1].data.operation_id, op1);
  assert.equal(h.filter(e => e.type === 'PAYMENT_SUCCEEDED').length, 1);
  assert.equal(store.getOperation(inits[1].data.operation_id).state, 'EXECUTED');
  assert.equal(ch.calls.length, 2);
  cleanup(store, dir);
});

test('M3-8 UNKNOWN→查询定案：双通道自动收敛（§5.2）', async () => {
  const { dir, store } = fresh();
  const ch = new SandboxChannel(['UNKNOWN']);
  const q = createQuote(store, { user_id: 'u_1', model_ids: ['glm-4-plus'] });
  const r = await confirmPayment(store, q.order_id, { channel: ch });
  assert.equal(r.status, 'FULFILLING');
  const h = store.getOrder(q.order_id);
  assert.equal(h.filter(e => e.type === 'PAYMENT_SUCCEEDED').length, 1);
  const op = h.find(e => e.type === 'PAYMENT_SUCCEEDED').data.operation_id;
  assert.equal(store.getOperation(op).state, 'EXECUTED');
  cleanup(store, dir);
});

test('M3-9 业务幂等：重复确认被拒；通道同 operation_id 重放同结果（I2）', async () => {
  const { dir, store } = fresh();
  const ch = new SandboxChannel();
  const q = createQuote(store, { user_id: 'u_1', model_ids: ['deepseek-v3'] });
  await confirmPayment(store, q.order_id, { channel: ch });
  await assert.rejects(() => confirmPayment(store, q.order_id, { channel: ch }),
    e => e.code === 'ALREADY_CONFIRMED');
  const ok = store.getOrder(q.order_id).find(e => e.type === 'PAYMENT_SUCCEEDED');
  const replay = await ch.charge({ operation_id: ok.data.operation_id, amount_cents: 600 });
  assert.equal(replay.channel_ref, ok.data.channel_ref);
  assert.equal(ch.calls.length, 1);
  await assert.rejects(() => confirmPayment(store, q.order_id, { channel: ch }),
    e => e.code === 'ALREADY_CONFIRMED');
  cleanup(store, dir);
});
