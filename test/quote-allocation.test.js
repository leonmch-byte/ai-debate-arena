import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { createQuote, allocateOrderTotal } from '../src/pricing.js';

test('M6-9 生产路径回归：createQuote 打包价分摊正确（item_id 先于分摊生成）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m6b-'));
  const store = new EventStore(join(dir, 't.db'));
  const q = createQuote(store, { user_id: 'u_m6',
    model_ids: ['kimi-k3', 'kimi-k3', 'kimi-k3', 'kimi-k3', 'kimi-k3'], bundle_total_cents: 3990 });
  assert.equal(q.total_cents, 3990);
  assert.deepEqual(q.items.map(i => i.locked_price_cents), [798, 798, 798, 798, 798]);
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('M6-10 分摊自校验：缺 item_id 被拒 / Σ≠总额不可能产出', () => {
  assert.throws(
    () => allocateOrderTotal([{ model_id: 'kimi-k3', price_cents: 800 }], 3990),
    e => e.code === 'INVALID_QUOTE');
});
