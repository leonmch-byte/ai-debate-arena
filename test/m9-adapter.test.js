import test from 'node:test';
import assert from 'node:assert/strict';
import { RealAdapter } from '../src/adapters-real.js';

test('M9-1 未配置 Key：返回 AUTH_FAILURE 而非崩溃/误报成功', async () => {
  const a = new RealAdapter({ env: {} });
  assert.equal(a.configured, false);
  const r = await a.run('qwen-max', { prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, 'MODEL_AUTH_FAILURE');
});
test('M9-2 未映射模型：RESPONSE_INVALID 拒绝', async () => {
  const a = new RealAdapter({ env: {} });
  const r = await a.run('not-exist', {});
  assert.equal(r.reason_code, 'MODEL_RESPONSE_INVALID');
});
