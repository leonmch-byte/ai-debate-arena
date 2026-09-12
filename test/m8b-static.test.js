import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';

// M8-5：静态首页可达。66 个 API 测试漏掉的覆盖——PUBLIC_DIR 幽灵目录 bug 的直接产物。
test('M8-5 静态服务：/ 返回产品页，css/js 可达', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m8b-'));
  const srv = await startServer({ port: 0, dbPath: join(dir, 't.db') });
  t.after(() => srv.close().then(() => rmSync(dir, { recursive: true, force: true })));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('AI 多模型会诊'));
  assert.equal((await fetch(base + '/style.css')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
});
