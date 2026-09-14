import test from 'node:test';
import assert from 'node:assert/strict';
import { RealAdapter } from '../src/adapters-real.js';

test('M9-1 未配置任何 Key：火山模型返回 AUTH_FAILURE 而非崩溃/误报成功', async () => {
  delete process.env.ARK_API_KEY; delete process.env.ARK_ENDPOINT; delete process.env.DASHSCOPE_API_KEY;
  const a = new RealAdapter({ env: {} });
  const r = await a.run('doubao-pro', { prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, 'MODEL_AUTH_FAILURE');
});
test('M9-2 未映射模型：RESPONSE_INVALID 拒绝', async () => {
  const a = new RealAdapter({ env: {} });
  const r = await a.run('not-exist', {});
  assert.equal(r.reason_code, 'MODEL_RESPONSE_INVALID');
});
test('M9-3 阿里未配置：qwen 返回 AUTH_FAILURE（火山独立，不受影响）', async () => {
  delete process.env.DASHSCOPE_API_KEY;
  const a = new RealAdapter({ env: {} });
  const r = await a.run('qwen-max', {});
  assert.equal(r.reason_code, 'MODEL_AUTH_FAILURE');
});
