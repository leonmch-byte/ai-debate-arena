import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';

const fresh = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m10-'));
  const srv = await startServer({ port: 0, dbPath: join(dir, 't.db') });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  let cookie = null;
  const call = async (path, { method = 'POST', body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { code: r.status, data: await r.json().catch(() => ({})) };
  };
  return { dir, srv, call };
};
const teardown = async ({ srv, dir }) => { await srv.close(); rmSync(dir, { recursive: true, force: true }); };
const EMAIL = () => `u${Date.now()}${Math.floor(Math.random() * 1e5)}@test.local`;

test('M10-1 未登录报价 → 401 LOGIN_REQUIRED（§9.2 身份门槛首站）', async t => {
  const x = await fresh();
  t.after(() => teardown(x));
  const r = await x.call('/api/quote', { body: { model_ids: ['kimi'] } });
  assert.equal(r.code, 401);
  assert.equal(r.data.error, 'LOGIN_REQUIRED');
  await teardown(x);
});

test('M10-2 注册→报价→我的订单可见；错密码/重复邮箱被拒', async t => {
  const x = await fresh();
  t.after(() => teardown(x));
  const email = EMAIL();
  assert.equal((await x.call('/api/auth/register', { body: { email, password: 'password123' } })).code, 200);
  assert.equal((await x.call('/api/auth/register', { body: { email, password: 'password123' } })).data.error, 'EMAIL_TAKEN');
  const bad = await x.call('/api/auth/login', { body: { email, password: 'wrong-password' } });
  assert.equal(bad.data.error, 'BAD_CREDENTIALS');
  const me = await x.call('/api/auth/me', { method: 'GET' });
  assert.equal(me.data.user.email, email);
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi'] } });
  assert.equal(q.code, 200);
  const mine = await x.call('/api/my/orders', { method: 'GET' });
  assert.equal(mine.data.orders.length, 1);
  assert.equal(mine.data.orders[0].order_id, q.data.order_id);
  assert.equal(mine.data.orders[0].total_cents, 800);
  await teardown(x);
});

test('M10-3 退出后：me 为空、我的订单 401', async t => {
  const x = await fresh();
  t.after(() => teardown(x));
  await x.call('/api/auth/register', { body: { email: EMAIL(), password: 'password123' } });
  assert.equal((await x.call('/api/auth/logout', { method: 'POST' })).code, 200);
  assert.equal((await x.call('/api/auth/me', { method: 'GET' })).data.user, null);
  assert.equal((await x.call('/api/my/orders', { method: 'GET' })).code, 401);
  await teardown(x);
});
