import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';

const fresh = async (simulateFail = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m8-'));
  const srv = await startServer({ port: 0, dbPath: join(dir, 't.db'), simulateFail });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const call = async (path, body) => {
    const r = await fetch(base + path, body === undefined ? {} :
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { code: r.status, data: await r.json().catch(() => ({})) };
  };
  return { dir, srv, base, call };
};
const teardown = async ({ srv, dir }) => { await srv.close(); rmSync(dir, { recursive: true, force: true }); };

test('M8-1 E2E 正常单：报价→支付→执行→DELIVERED，预演 balance=0', async () => {
  const t = await fresh();
  const models = await (await fetch(t.base + '/api/models')).json();
  assert.equal(models.models['kimi'], 800);
  const q = await t.call('/api/quote', { model_ids: ['kimi', 'doubao-pro'] });
  assert.equal(q.code, 200);
  assert.equal(q.data.total_cents, 1600);
  const pay = await t.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay.data.cash_paid_cents, 1600);
  const v = await t.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'DELIVERED');
  assert.ok(v.data.items.every(i => i.state === 'COMPLETED'));
  assert.equal(v.data.settlement.balance_cents, 0);
  assert.equal(v.data.settlement.delivered_value_cents, 1600);
  assert.equal(v.data.decision, null);
  await teardown(t);
});

test('M8-2 E2E 故障单：自动弹窗契约 → 用户退款 → SETTLEMENT_PENDING，balance=0', async () => {
  const t = await fresh(['kimi']);
  const q = await t.call('/api/quote', { model_ids: ['kimi', 'deepseek-v3'] });
  await t.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await t.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'FULFILLING');
  const d = v.data.decision;
  assert.ok(d, 'FAILED_FINAL 应自动产生决策契约');
  assert.equal(d.failed_item.model_id, 'kimi');
  assert.equal(d.failed_item.locked_price_cents, 800);
  assert.equal(d.options[0].type, 'REFUND');
  assert.equal(d.options[0].refund_cash_cents, 800);
  assert.equal(d.default_on_timeout, 'REFUND');
  assert.equal(d.options[2].candidates.find(c => c.model_id === 'gpt-4o').delta_cents, 200);
  const itemId = d.failed_item.item_id;
  const v2 = await t.call(`/api/orders/${q.data.order_id}/items/${itemId}/decision`, { choice: 'REFUND' });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  const items = Object.fromEntries(v2.data.items.map(i => [i.state, true]));
  assert.ok(items.REFUNDED && items.COMPLETED);
  assert.equal(v2.data.settlement.refunded_cash_cents, 800);
  assert.equal(v2.data.settlement.balance_cents, 0);
  await teardown(t);
});

test('M8-3 E2E 换贵模型：补差→后继完成→REPLACED+COMPLETED，balance=0', async () => {
  const t = await fresh(['kimi']);
  const q = await t.call('/api/quote', { model_ids: ['kimi'] });
  await t.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await t.call(`/api/orders/${q.data.order_id}/run`);
  const d = v.data.decision;
  const v2 = await t.call(`/api/orders/${q.data.order_id}/items/${d.failed_item.item_id}/decision`,
    { choice: 'REPLACE', model_id: 'gpt-4o' });
  assert.equal(v2.data.status, 'DELIVERED');
  assert.ok(v2.data.items.some(i => i.state === 'REPLACED'));
  assert.ok(v2.data.items.some(i => i.state === 'COMPLETED' && i.model_id === 'gpt-4o'));
  assert.equal(v2.data.settlement.paid_cash_cents, 1000);   // 800 + 补差 200
  assert.equal(v2.data.settlement.delivered_value_cents, 1000);
  assert.equal(v2.data.settlement.balance_cents, 0);
  await teardown(t);
});

test('M8-4 防御：未付先 run→PAYMENT_REQUIRED / 重复 pay→ALREADY_CONFIRMED / 404', async () => {
  const t = await fresh();
  const q = await t.call('/api/quote', { model_ids: ['kimi'] });
  const runEarly = await t.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(runEarly.code, 400);
  assert.equal(runEarly.data.error, 'PAYMENT_REQUIRED');
  await t.call(`/api/orders/${q.data.order_id}/pay`);
  const pay2 = await t.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay2.code, 400);
  assert.equal(pay2.data.error, 'ALREADY_CONFIRMED');
  const nf = await t.call('/api/orders/ord_nope');
  assert.equal(nf.code, 404);
  await teardown(t);
});
