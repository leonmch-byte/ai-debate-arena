import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { genOperationId, genObligationId } from '../src/ids.js';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-'));
  return { dir, path: join(dir, 'test.db') };
};
const EV = (type, extra = {}) => ({ type, ...extra });

test('M1-1 追加：seq 连续、读取有序、载荷往返一致', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  const out = s.append('ord_a', [EV('QUOTE_CREATED'), EV('QUOTE_EXPIRED'), EV('ORDER_CONFIRMED')]);
  assert.deepEqual(out.map(e => e.seq), [1, 2, 3]);
  const read = s.getOrder('ord_a');
  assert.deepEqual(read.map(e => e.type), ['QUOTE_CREATED', 'QUOTE_EXPIRED', 'ORDER_CONFIRMED']);
  assert.equal(read[0].amount_cents, null);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-2 不同订单流水号相互独立', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  s.append('ord_1', [EV('QUOTE_CREATED')]);
  s.append('ord_2', [EV('QUOTE_CREATED')]);
  assert.equal(s.getOrder('ord_1')[0].seq, 1);
  assert.equal(s.getOrder('ord_2')[0].seq, 1);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-3 乱序/回退被拒，允许向前跳跃（I6）', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  s.append('ord_b', [EV('QUOTE_CREATED')]);
  assert.throws(
    () => s.append('ord_b', [EV('QUOTE_EXPIRED', { seq: 1 })]),
    e => e.code === 'SEQ_REGRESSION'
  );
  const out = s.append('ord_b', [EV('ORDER_CONFIRMED', { seq: 100 })]);
  assert.equal(out[0].seq, 100);
  assert.equal(s.append('ord_b', [EV('PAYMENT_INITIATED')])[0].seq, 101);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-4 重复 event_id 被拒', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  const [e] = s.append('ord_g', [EV('QUOTE_CREATED')]);
  assert.throws(
    () => s.append('ord_g', [{ ...EV('QUOTE_CREATED'), event_id: e.event_id }]),
    err => err.code === 'DUPLICATE_EVENT'
  );
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-5 因果引用必须真实存在（I5）', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  assert.throws(
    () => s.append('ord_e', [EV('ITEM_FAILED_FINAL', { caused_by: ['nope'] })]),
    e => e.code === 'CAUSALITY_BREAK'
  );
  const [e1] = s.append('ord_e', [EV('RECOVERY_ATTEMPTED', { item_id: 'itm_9' })]);
  const [e2] = s.append('ord_e', [EV('RECOVERY_EXHAUSTED', { item_id: 'itm_9', caused_by: [e1.event_id] })]);
  assert.deepEqual(e2.caused_by, [e1.event_id]);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-6 账本物理不可改不可删（I1，数据库触发器强制）', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  s.append('ord_f', [EV('QUOTE_CREATED')]);
  assert.throws(() => s.db.exec("UPDATE events SET type = 'HACKED'"), /append-only/);
  assert.throws(() => s.db.exec('DELETE FROM events'), /append-only/);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-7 操作幂等：重试去重、义务至多一次生效（I2）', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  const obl = genObligationId();
  const op1 = genOperationId('refund', 'ord_c', 'itm_1');
  const r1 = s.recordOperation({ operation_id: op1, order_id: 'ord_c', obligation_id: obl, type: 'refund' });
  assert.equal(r1.state, 'CREATED');
  const r2 = s.recordOperation({ operation_id: op1, order_id: 'ord_c', obligation_id: obl, type: 'refund' });
  assert.equal(r2.operation_id, op1);
  s.markOperation(op1, 'EXECUTED', 'ch_ref_1');
  const op2 = genOperationId('refund', 'ord_c', 'itm_1');
  s.recordOperation({ operation_id: op2, order_id: 'ord_c', obligation_id: obl, type: 'refund' });
  assert.throws(() => s.markOperation(op2, 'EXECUTED'), /I2/);
  s.markOperation(op2, 'FAILED');
  assert.throws(() => s.markOperation(op2, 'EXECUTED'), /FAILED/);
  s.close(); rmSync(dir, { recursive: true, force: true });
});

test('M1-8 重放一致性：落盘后重开，事件流完全一致', () => {
  const { dir, path } = fresh();
  const s = new EventStore(path);
  s.append('ord_d', [
    EV('ITEM_FAILED_FINAL', { item_id: 'itm_9', reason_code: 'MODEL_RATE_LIMITED' }),
    EV('DECISION_REQUESTED', { item_id: 'itm_9', decision_source: 'SYSTEM_RULE' }),
  ]);
  const before = s.getOrder('ord_d');
  s.close();
  const s2 = new EventStore(path);
  const after = s2.getOrder('ord_d');
  assert.deepEqual(after, before);
  assert.equal(after[0].seq, 1);
  assert.equal(after[0].reason_code, 'MODEL_RATE_LIMITED');
  s2.close(); rmSync(dir, { recursive: true, force: true });
});
