import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('M8-6 前端资源：app.js 必须可被 JS 引擎解析（¥ 标识符事故的回归防线）', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(src));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('AI 多模型会诊'));
});
