import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { uuidv7 } from './ids.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('需要 Node >= 22.13（内置 node:sqlite）。请先完成块 A 的版本升级。');
  process.exit(1);
}

// 事件类型注册表：§2.2 + §6.2 + §5.4 全集。扩展类型只改这里（协议允许扩展不破坏）。
const EVENT_TYPES = new Set([
  'QUOTE_CREATED', 'QUOTE_EXPIRED', 'ORDER_CONFIRMED',
  'PAYMENT_INITIATED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'PAYMENT_UNKNOWN_RESOLVED',
  'ITEM_LOCKED', 'ITEM_STARTED', 'ITEM_COMPLETED',
  'RECOVERY_ATTEMPTED', 'RECOVERY_EXHAUSTED', 'ITEM_FAILED_FINAL',
  'DECISION_REQUESTED', 'DECISION_RECEIVED', 'DECISION_TIMEOUT',
  'REFUND_DUE', 'SURCHARGE_DUE', 'CREDIT_DUE',
  'REFUND_EXECUTED', 'SURCHARGE_EXECUTED', 'REFUND_STUCK',
  'VOUCHER_ISSUED', 'VOUCHER_RESERVED', 'VOUCHER_REDEEMED', 'VOUCHER_RELEASED', 'VOUCHER_EXPIRED',
  'SETTLEMENT_PREVIEWED', 'SETTLEMENT_FINALIZED',
  'OBJECTION_RAISED', 'OBJECTION_RESOLVED',
  'LEDGER_CORRECTION',
]);
const DECISION_SOURCES = new Set(['SYSTEM_RULE', 'USER_DECISION', 'TIMEOUT_RULE', 'HUMAN_EXCEPTION']);

export class StoreError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

export class EventStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.#initSchema();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id        TEXT PRIMARY KEY,
        order_id        TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        item_id         TEXT,
        type            TEXT NOT NULL,
        amount_cents    INTEGER,
        reason_code     TEXT,
        decision_source TEXT NOT NULL,
        caused_by       TEXT NOT NULL,
        payload         TEXT NOT NULL,
        occurred_at     TEXT NOT NULL,
        UNIQUE(order_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id, seq);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id  TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL,
        obligation_id TEXT NOT NULL,
        type          TEXT NOT NULL,
        state         TEXT NOT NULL
                      CHECK (state IN ('CREATED','EXECUTING','EXECUTED','FAILED','UNKNOWN')),
        channel_ref   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_executed_per_obligation
        ON operations(obligation_id) WHERE state = 'EXECUTED';
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'I1: events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'I1: events are append-only'); END;
    `);
  }

  // 追加事件。单条或数组均可。可选项：event_id（重试）、seq（显式指定，用于测试乱序拒绝）。
  append(orderId, events) {
    if (typeof orderId !== 'string' || !orderId.startsWith('ord_'))
      throw new StoreError('INVALID_EVENT', 'order_id 必须以 ord_ 开头');
    const list = Array.isArray(events) ? events : [events];
    if (list.length === 0) throw new StoreError('INVALID_EVENT', 'events 不能为空');

    const now = new Date().toISOString();
    const getMax = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE order_id = ?');
    const hasEvent = this.db.prepare('SELECT 1 FROM events WHERE event_id = ?');
    const insert = this.db.prepare(`INSERT INTO events
      (event_id, order_id, seq, item_id, type, amount_cents, reason_code,
       decision_source, caused_by, payload, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = [];
      let next = getMax.get(orderId).m;
      for (const raw of list) {
        const env = normalize(orderId, raw, now);
        if (env.seq === null) env.seq = next + 1;
        else if (env.seq <= next)
          throw new StoreError('SEQ_REGRESSION', `seq=${env.seq} 不大于当前最大值 ${next}（I6）`);
        next = env.seq;
        for (const ref of env.caused_by) {
          if (!out.some(e => e.event_id === ref) && !hasEvent.get(ref))
            throw new StoreError('CAUSALITY_BREAK', `caused_by 引用了不存在的事件 ${ref}（I5）`);
        }
        try {
          insert.run(env.event_id, orderId, env.seq, env.item_id, env.type,
            env.amount_cents, env.reason_code, env.decision_source,
            JSON.stringify(env.caused_by), JSON.stringify(env), env.occurred_at);
        } catch (e) {
          if (String(e.message).includes('UNIQUE'))
            throw new StoreError('DUPLICATE_EVENT', `event_id 已存在 ${env.event_id}`);
          throw e;
        }
        out.push(env);
      }
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getOrder(orderId) {
    return this.db.prepare('SELECT payload FROM events WHERE order_id = ? ORDER BY seq')
      .all(orderId).map(r => JSON.parse(r.payload));
  }

  getEvent(eventId) {
    const r = this.db.prepare('SELECT payload FROM events WHERE event_id = ?').get(eventId);
    return r ? JSON.parse(r.payload) : null;
  }

  // 记录渠道操作。同 operation_id 重复到达 → 静默幂等返回已有行（I2）。
  recordOperation({ operation_id, order_id, obligation_id, type, state = 'CREATED', channel_ref = null }) {
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO operations
        (operation_id, order_id, obligation_id, type, state, channel_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(operation_id, order_id, obligation_id, type, state, channel_ref, now, now);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
      const existing = this.getOperation(operation_id);
      if (existing) return existing;
      throw new StoreError('DUPLICATE_EXECUTION', '该义务已存在生效执行（I2）');
    }
    return this.getOperation(operation_id);
  }

  markOperation(operation_id, state, channel_ref = null) {
    const cur = this.getOperation(operation_id);
    if (cur && cur.state === 'FAILED' && state === 'EXECUTED')
      throw new StoreError('ILLEGAL_TRANSITION', 'FAILED 状态不允许转为 EXECUTED，需新建 operation（§5.1）');
    const sets = ['state = ?', 'updated_at = ?'];
    const args = [state, new Date().toISOString()];
    if (channel_ref) { sets.push('channel_ref = ?'); args.push(channel_ref); }
    args.push(operation_id);
    try {
      this.db.prepare(`UPDATE operations SET ${sets.join(', ')} WHERE operation_id = ?`).run(...args);
    } catch (e) {
      if (String(e.message).includes('UNIQUE'))
        throw new StoreError('DUPLICATE_EXECUTION', '该义务已存在 EXECUTED 操作（I2）');
      throw e;
    }
    return this.getOperation(operation_id);
  }

  getOperation(id) {
    return this.db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(id) ?? null;
  }

  close() { this.db.close(); }
}

function normalize(orderId, raw, now) {
  if (!raw || typeof raw !== 'object') throw new StoreError('INVALID_EVENT', '事件必须是对象');
  if (!EVENT_TYPES.has(raw.type)) throw new StoreError('INVALID_EVENT', `未知事件类型 ${raw.type}`);
  const amount = raw.amount_cents ?? null;
  if (amount !== null && (!Number.isInteger(amount) || amount < 0))
    throw new StoreError('INVALID_EVENT', 'amount_cents 必须是非负整数（单位：分）');
  const source = raw.decision_source ?? 'SYSTEM_RULE';
  if (!DECISION_SOURCES.has(source)) throw new StoreError('INVALID_EVENT', `非法 decision_source ${source}`);
  const caused = raw.caused_by ?? [];
  if (!Array.isArray(caused) || caused.some(x => typeof x !== 'string'))
    throw new StoreError('INVALID_EVENT', 'caused_by 必须是字符串数组');
  return {
    event_id: raw.event_id ?? uuidv7(),
    order_id: orderId,
    item_id: raw.item_id ?? null,
    seq: raw.seq ?? null,
    type: raw.type,
    amount_cents: amount,
    reason_code: raw.reason_code ?? null,
    decision_source: source,
    caused_by: caused,
    occurred_at: raw.occurred_at ?? now,
  };
}
