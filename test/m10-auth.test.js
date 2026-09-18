import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';

const fresh = async (betaMode = 'false') => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m10-'));
  const srv = await startServer({ port: 0, dbPath: join(dir, 't.db'), betaMode });
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
  return { dir, srv, call, closed: false };
};
const teardown = async x => {
  if (x.closed) return; x.closed = true;
  await x.srv.close(); rmSync(x.dir, { recursive: true, force: true });
};
const EMAIL = () => `u${Date.now()}${Math.floor(Math.random() * 1e5)}@test.local`;

test('M10-1a 强制登录开关：ARENA_REQUIRE_AUTH=1 时未登录报价 → 401', async t => {
  process.env.ARENA_REQUIRE_AUTH = '1';
  const x = await fresh('true');
  t.after(() => { delete process.env.ARENA_REQUIRE_AUTH; return teardown(x); });
  const r = await x.call('/api/quote', { body: { model_ids: ['kimi-k3'] } });
  assert.equal(r.code, 401);
  assert.equal(r.data.error, 'LOGIN_REQUIRED');
});

test('M10-1b 默认（开关关闭）：匿名报价放行 200——用户决策"暂不启用强制登录"', async t => {
  assert.equal(process.env.ARENA_REQUIRE_AUTH, undefined);
  const x = await fresh();
  t.after(() => teardown(x));
  const r = await x.call('/api/quote', { body: { model_ids: ['kimi-k3'] } });
  assert.equal(r.code, 200);
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
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi-k3'] } });
  assert.equal(q.code, 200);
  const mine = await x.call('/api/my/orders', { method: 'GET' });
  assert.equal(mine.data.orders.length, 1);
  assert.equal(mine.data.orders[0].order_id, q.data.order_id);
  assert.equal(mine.data.orders[0].total_cents, 800);
  t.after(() => teardown(x));
});

test('M10-3 退出后：me 为空、我的订单 401', async t => {
  const x = await fresh();
  t.after(() => teardown(x));
  await x.call('/api/auth/register', { body: { email: EMAIL(), password: 'password123' } });
  assert.equal((await x.call('/api/auth/logout', { method: 'POST' })).code, 200);
  assert.equal((await x.call('/api/auth/me', { method: 'GET' })).data.user, null);
  assert.equal((await x.call('/api/my/orders', { method: 'GET' })).code, 401);
  t.after(() => teardown(x));
});
