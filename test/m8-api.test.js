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
  const call = async (path, { method = 'POST', body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { code: r.status, data: await r.json().catch(() => ({})) };
  };
  return { dir, srv, base, call };
};

test('M8-1 E2E 正常单：报价→支付→执行→自动预演，balance=0', async t => {
  const x = await fresh();
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const models = await (await fetch(x.base + '/api/models')).json();
  assert.equal(models.models['kimi-k3'], 800);
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi-k3', 'doubao-pro'] } });
  assert.equal(q.code, 200);
  assert.equal(q.data.total_cents, 1600);
  const pay = await x.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay.code, 200);
  assert.equal(pay.data.cash_paid_cents, 1600);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'SETTLEMENT_PENDING');
  assert.ok(v.data.items.every(i => i.state === 'COMPLETED'));
  assert.equal(v.data.settlement.balance_cents, 0);
  assert.equal(v.data.settlement.delivered_value_cents, 1600);
});

test('M8-2 E2E 故障单：自动弹窗契约 → 用户退款 → balance=0', async t => {
  const x = await fresh(['kimi-k3']);
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi-k3', 'deepseek-v41'] } });
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'FULFILLING');
  const d = v.data.decision;
  assert.ok(d, 'FAILED_FINAL 应自动产生决策契约');
  assert.equal(d.failed_item.model_id, 'kimi-k3');
  assert.equal(d.options[0].refund_cash_cents, 800);
  assert.equal(d.default_on_timeout, 'REFUND');
  const v2 = await x.call(`/api/orders/${q.data.order_id}/items/${d.failed_item.item_id}/decision`, { body: { choice: 'REFUND' } });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  const states = v2.data.items.map(i => i.state);
  assert.ok(states.includes('REFUNDED') && states.includes('COMPLETED'));
  assert.equal(v2.data.settlement.refunded_cash_cents, 800);
  assert.equal(v2.data.settlement.balance_cents, 0);
});

test('M8-3 E2E 换贵模型：补差→后继完成→REPLACED，balance=0', async t => {
  const x = await fresh(['kimi-k3']);
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi-k3'] } });
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  const d = v.data.decision;
  assert.ok(d);
  const v2 = await x.call(`/api/orders/${q.data.order_id}/items/${d.failed_item.item_id}/decision`,
    { body: { choice: 'REPLACE', model_id: 'minimax-m3' } });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  assert.ok(v2.data.items.some(i => i.state === 'REPLACED'));
  assert.equal(v2.data.settlement.paid_cash_cents, 1000);
  assert.equal(v2.data.settlement.balance_cents, 0);
});

test('M8-4 防御：GET打POST→404 / 未付run→400 / 重复pay→400 / 404', async t => {
  const x = await fresh();
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi-k3'] } });
  assert.equal((await x.call(`/api/orders/${q.data.order_id}/pay`, { method: 'GET' })).code, 404);
  const runEarly = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(runEarly.code, 400);
  assert.equal(runEarly.data.error, 'PAYMENT_REQUIRED');
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const pay2 = await x.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay2.data.error, 'ALREADY_CONFIRMED');
  assert.equal((await x.call('/api/orders/ord_nope', { method: 'GET' })).code, 404);
});
