// ============================================================
// 多 AI 头脑风暴 · 单文件发布版 v3
// 自动生成：由 src/ 模块合并（勿手改，改 src/ 后 npm run build）
// 依赖：Node >= 22.13（node:sqlite 内置），零 npm 依赖
// ============================================================

// ========== src/store.js ==========




let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('需要 Node >= 22.13（内置 node:sqlite）。');
  process.exit(1);
}

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
  'LEDGER_CORRECTION', 'SURCHARGE_EXPIRED', 'ADMIN_ACTION',
]);
const DECISION_SOURCES = new Set(['SYSTEM_RULE', 'USER_DECISION', 'TIMEOUT_RULE', 'HUMAN_EXCEPTION']);

class StoreError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

class EventStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');   // server/worker 双进程共享库（WAL）
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
        data            TEXT NOT NULL,
        occurred_at     TEXT NOT NULL,
        UNIQUE(order_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
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
       decision_source, caused_by, payload, data, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

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
            JSON.stringify(env.caused_by), JSON.stringify(env), JSON.stringify(env.data), env.occurred_at);
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

  getAllEvents() {
    return this.db.prepare('SELECT payload FROM events ORDER BY occurred_at, rowid')
      .all().map(r => JSON.parse(r.payload));
  }

  getEvent(eventId) {
    const r = this.db.prepare('SELECT payload FROM events WHERE event_id = ?').get(eventId);
    return r ? JSON.parse(r.payload) : null;
  }

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

  getOperationsByOrder(orderId) {
    return this.db.prepare('SELECT * FROM operations WHERE order_id = ? ORDER BY created_at').all(orderId);
  }

  getEventsByType(type) {
    return this.db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY occurred_at, rowid')
      .all(type).map(r => JSON.parse(r.payload));
  }

  getAllOrderIds() {
    const a = this.db.prepare('SELECT DISTINCT order_id AS id FROM events').all();
    const b = this.db.prepare('SELECT DISTINCT order_id AS id FROM operations').all();
    return [...new Set([...a, ...b].map(r => r.id))];
  }

  getAllOperations() {
    return this.db.prepare('SELECT * FROM operations ORDER BY created_at').all();
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
  if (raw.data !== undefined && (typeof raw.data !== 'object' || raw.data === null || Array.isArray(raw.data)))
    throw new StoreError('INVALID_EVENT', 'data 必须是普通对象');
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
    data: raw.data ?? {},
    occurred_at: raw.occurred_at ?? now,
  };
}


// ========== src/ids.js ==========


// UUIDv7：时间有序，用于 event_id（协议 §1.4）
function uuidv7() {
  const ts = BigInt(Date.now());
  const b = randomBytes(16);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const rid = () => randomBytes(8).toString('hex');
const genOrderId = () => 'ord_' + rid();
const genItemId = () => 'itm_' + rid();
const genVoucherId = () => 'vch_' + rid();
const genDecisionId = () => 'dec_' + rid();
const genObligationId = () => 'obl_' + rid();

// 幂等操作键 op_{type}:{order_id}:{item_id?}:{uuid}（协议 §1.4）
function genOperationId(type, orderId, itemId = null) {
  return `op_${type}:${orderId}${itemId ? ':' + itemId : ''}:${randomUUID()}`;
}


// ========== src/config.js ==========
// v3 协议常量（§4.7 SLA + §8 权限参数 + 价格表）。改数值不改结构。
const SLA = {
  QUOTE_TTL_MINUTES: 15,
  RECOVERY_MAX_ATTEMPTS: 3,
  RECOVERY_WINDOW_MINUTES: 5,
  DECISION_TIMEOUT_HOURS: 24,
  SURCHARGE_WINDOW_MINUTES: 15,
  OBJECTION_PERIOD_HOURS: 72,
  PAYMENT_UNKNOWN_POOL_MINUTES: 30,
};
const VOUCHER_TTL_DAYS = 90;                       // §6.6
const RUNTIME_FLAGS = { dual_review_enabled: false }; // §8.4 休眠，开时零迁移
const GOODWILL = {
  MAX_SINGLE_CENTS: 2000,            // 单笔 ≤ ¥20
  USER_30D_CAP_CENTS: 10000,         // 单用户 30 天累计 ≤ ¥100
  MAX_RATIO_OF_PAID: 0.5,            // 单笔 ≤ 订单实付 50%
};
const WORKER_INTERVAL_SECONDS = 60;
const PRICE_TABLE_VERSION = 'pt-2025-09';
const PRICE_TABLES = {
  'pt-2025-09': {
    models: {
      'doubao-pro': 800,
      'kimi-k3': 800,
      'deepseek-v41': 600,
      'minimax-m3': 800,
    },
  },
};


// ========== src/auth.js ==========
// M10：最小身份（§9.2 access.js 重写第一步）。用户/会话是平台数据，非订单事件，独立于事件账本。



class Auth {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
        pw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);`);
  }
  #hash(pw, salt) { return scryptSync(pw, salt, 32).toString('hex'); }
  register(email, password) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) throw new StoreError('INVALID_EMAIL', '邮箱格式不正确');
    if (typeof password !== 'string' || password.length < 8) throw new StoreError('WEAK_PASSWORD', '密码至少 8 位');
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
      throw new StoreError('EMAIL_TAKEN', '该邮箱已注册，请直接登录');
    const user_id = 'usr_' + randomBytes(8).toString('hex');
    const salt = randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO users (user_id, email, pw_hash, created_at) VALUES (?,?,?,?)')
      .run(user_id, email, salt + ':' + this.#hash(password, salt), new Date().toISOString());
    return { user_id, email };
  }
  #verify(pw, stored) {
    const [salt, hex] = stored.split(':');
    const a = Buffer.from(hex, 'hex'), b = Buffer.from(this.#hash(pw, salt), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  login(email, password) {
    const u = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email ?? '');
    if (!u || !this.#verify(password ?? '', u.pw_hash))
      throw new StoreError('BAD_CREDENTIALS', '邮箱或密码不正确');
    const token = randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 30 * 86400_000).toISOString();
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, u.user_id, expires_at);
    return { token, expires_at };
  }
  verify(token) {
    if (!token) return null;
    const s = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s) return null;
    if (new Date(s.expires_at) < new Date()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return this.db.prepare('SELECT user_id, email FROM users WHERE user_id = ?').get(s.user_id) ?? null;
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
}


// ========== src/growth.js ==========
// M11：增长机制——邀请码（内测期）、免费体验次数、运行时开关、反馈标签。


class Growth {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, day TEXT NOT NULL, used_by TEXT, used_at TEXT);
      CREATE TABLE IF NOT EXISTS free_trials (
        user_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 3);
      CREATE TABLE IF NOT EXISTS feedbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, order_id TEXT,
        tag TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO settings (key, value) VALUES ('BETA_MODE','true');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('FREE_TRIALS','3');
    `);
  }
  get(key, dflt = null) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? r.value : dflt;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
  }
  todayCode(day) {
    const existing = this.db.prepare('SELECT code FROM invites WHERE day = ? LIMIT 1').get(day);
    if (existing) return existing.code;
    for (let i = 0; i < 5; i++) {
      const code = 'ARENA-' + day.replaceAll('-', '').slice(4) + '-' + randomBytes(2).toString('hex').toUpperCase();
      try {
        this.db.prepare('INSERT INTO invites (code, day) VALUES (?,?)').run(code, day);
        return code;
      } catch {}
    }
    throw new Error('invite gen failed');
  }
  consumeInvite(code, userId, day) {
    if (this.get('BETA_MODE') !== 'true') return { ok: true, mode: 'open' };
    if (!code) return { ok: false, reason: '邀请码必填（内测期）' };
    const used = this.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE day = ? AND used_by IS NOT NULL").get(day).n;
    if (used >= 10) return { ok: false, reason: '今日内测名额已满（10/10），明日 0 点刷新' };
    const row = this.db.prepare('SELECT code, used_by FROM invites WHERE code = ? AND day = ?').get(code, day);
    if (!row) return { ok: false, reason: '邀请码无效' };
    if (row.used_by) return { ok: false, reason: '邀请码已被使用' };
    this.db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(userId, new Date().toISOString(), code);
    return { ok: true, mode: 'beta' };
  }
  grantTrials(userId) {
    const total = parseInt(this.get('FREE_TRIALS', '3'));
    this.db.prepare('INSERT INTO free_trials (user_id, total) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING')
      .run(userId, total);
  }
  trialsLeft(userId) {
    const r = this.db.prepare('SELECT used, total FROM free_trials WHERE user_id = ?').get(userId);
    if (!r) return { left: parseInt(this.get('FREE_TRIALS', '3')), total: parseInt(this.get('FREE_TRIALS', '3')) };
    return { left: Math.max(0, r.total - r.used), total: r.total };
  }
  consumeTrial(userId) {
    const t = this.trialsLeft(userId);
    if (t.left <= 0) return { ok: false, left: 0 };
    this.db.prepare('UPDATE free_trials SET used = used + 1 WHERE user_id = ?').run(userId);
    return { ok: true, left: t.left - 1 };
  }
  addFeedback(userId, orderId, tag, note) {
    const TAGS = new Set(['TOO_GENERIC','IRRELEVANT','TOO_SLOW','TOO_EXPENSIVE','UI_BAD','OTHER']);
    if (!TAGS.has(tag)) return false;
    this.db.prepare('INSERT INTO feedbacks (user_id, order_id, tag, note, created_at) VALUES (?,?,?,?,?)')
      .run(userId ?? null, orderId ?? null, tag, note ?? null, new Date().toISOString());
    return true;
  }
  feedbackStats() {
    return this.db.prepare('SELECT tag, COUNT(*) AS n FROM feedbacks GROUP BY tag ORDER BY n DESC').all();
  }
}


// ========== src/registry.js ==========
// M-B：模型注册表 + 场景库 + 角色池（全部数据库化，后台可管理，加模型不再改代码）。
// 设计：模型与角色解耦——用户选角色，引擎从启用模型池随机分配。

class Registry {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,              -- 内部标识（如 doubao-pro）
        display_name TEXT NOT NULL,
        provider TEXT NOT NULL,           -- ark | openai_compatible
        endpoint TEXT,                    -- ark: ep-ID；openai_compatible: base_url
        model_tag TEXT,                   -- openai_compatible: model 字段值
        price_cents INTEGER NOT NULL DEFAULT 800,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,              -- slug（brainstorm / resume / 自建随机ID）
        name TEXT NOT NULL, description TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_by TEXT, is_public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, scene_id TEXT NOT NULL,
        name TEXT NOT NULL, stance TEXT NOT NULL,   -- 身份+利益+立场（prompt 核心）
        created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO scenes (id, name, description, builtin, created_at)
        VALUES ('brainstorm','自由头脑风暴','多 AI 各抒己见、互相碰撞，适合任何需要被挑战的决策','1', datetime('now'));
      INSERT OR IGNORE INTO roles (id, scene_id, name, stance, created_at)
        VALUES ('br-general','brainstorm','独立顾问','你是一名独立顾问，没有预设立场，但观点必须鲜明——骑墙是本产品的敌人', datetime('now'));
    `);
  }
  /* ---- 模型注册表 ---- */
  listModels(onlyEnabled = true) {
    const rows = this.db.prepare(`SELECT * FROM models ${onlyEnabled ? 'WHERE enabled=1' : ''} ORDER BY created_at`).all();
    return rows;
  }
  upsertModel(m) {
    if (!m.id || !m.display_name || !m.provider) throw new Error('id/display_name/provider 必填');
    if (!['ark','openai_compatible'].includes(m.provider)) throw new Error('provider 必须是 ark 或 openai_compatible');
    if (m.provider === 'ark' && !(m.endpoint ?? '').startsWith('ep-')) throw new Error('ark 提供商需要 ep- 接入点 ID');
    if (m.provider === 'openai_compatible' && !m.model_tag) throw new Error('openai_compatible 需要 model_tag');
    this.db.prepare(`INSERT INTO models (id,display_name,provider,endpoint,model_tag,price_cents,enabled,created_at)
      VALUES (@id,@display_name,@provider,@endpoint,@model_tag,@price_cents,@enabled,@created_at)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, provider=excluded.provider,
        endpoint=excluded.endpoint, model_tag=excluded.model_tag, price_cents=excluded.price_cents, enabled=excluded.enabled`)
      .run({ endpoint: null, model_tag: null, price_cents: 800,
             created_at: new Date().toISOString(), ...m,
             enabled: (m.enabled ?? true) ? 1 : 0 });   // SQLite INTEGER：布尔必须转 0/1
    return this.getModel(m.id);
  }
  getModel(id) { return this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) ?? null; }
  setModelEnabled(id, enabled) {
    this.db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }
  /* ---- 场景 / 角色 ---- */
  listScenes(includePrivate = false) {
    return this.db.prepare(`SELECT * FROM scenes ${includePrivate ? '' : 'WHERE is_public=1'} ORDER BY builtin DESC, created_at`).all();
  }
  getScene(id) { return this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) ?? null; }
  createScene({ id, name, description, created_by }) {
    const sid = id ?? 'sc_' + Math.random().toString(36).slice(2, 10);
    this.db.prepare('INSERT INTO scenes (id,name,description,builtin,created_by,is_public,created_at) VALUES (?,?,?,0,?,0,?)')
      .run(sid, name, description ?? '', created_by ?? null, new Date().toISOString());
    return this.getScene(sid);
  }
  listRoles(sceneId) {
    return this.db.prepare('SELECT * FROM roles WHERE scene_id = ? ORDER BY created_at').all(sceneId);
  }
  addRole(sceneId, name, stance) {
    if (!this.getScene(sceneId)) throw new Error('scene 不存在');
    const rid = 'ro_' + Math.random().toString(36).slice(2, 10);
    this.db.prepare('INSERT INTO roles (id,scene_id,name,stance,created_at) VALUES (?,?,?,?,?)')
      .run(rid, sceneId, name, stance, new Date().toISOString());
    return this.db.prepare('SELECT * FROM roles WHERE id = ?').get(rid);
  }
}


// ========== src/orders.js ==========
// M2：服务项状态机（§3.1）、订单状态投影（§3.2）、事件准入守卫（§3.3）
// 原则：状态永远是事件流的推导值。本模块只读事件、推导状态、拒绝违规，不存在"写状态"。
// 演进：M2-fix 逐事件推导 REPLACED；M4 落 T1 支付前置；M5-fix 退款决策/类型双重校验。


const ITEM_TERMINAL = new Set([
  'COMPLETED', 'REFUNDED', 'REPLACED', 'VOUCHERED', 'TIMEOUT_REFUNDED', 'VOIDED',
]);

const newItem = (id, origin = 'ORIGINAL', replacementOf = null) => ({
  item_id: id,
  state: 'QUOTED',
  origin,                        // ORIGINAL | REPLACEMENT
  replacement_of: replacementOf,
  attempts: 0,
  pending_decision: null,
  resolved_choice: null,
  decision_timed_out: false,
  surcharge_executed: false,
  fail_reason: null,
});

function projectItems(events) {
  let orderPaid = false; // T1 前置：支付成功才可 ITEM_LOCKED（§3.1）
  const items = new Map();
  const known = new Set();       // 已被报价/订单/决策引入的 item
  const decisions = new Map();   // item_id → { requested, received }
  const ensure = (id, origin, replOf) => {
    if (!items.has(id)) items.set(id, newItem(id, origin, replOf));
    return items.get(id);
  };
  const mustKnown = (id, e) => {
    if (!known.has(id))
      throw new StoreError('UNKNOWN_ITEM', `${e.type}: item ${id} 未被 QUOTE/ORDER/决策引入`);
    return ensure(id);
  };
  const requireState = (it, allowed, e) => {
    if (ITEM_TERMINAL.has(it.state))
      throw new StoreError('ILLEGAL_FROM_TERMINAL', `${e.type}: ${it.item_id} 已终态 ${it.state}（§3.3-1）`);
    if (!allowed.includes(it.state))
      throw new StoreError('ILLEGAL_TRANSITION', `${e.type}: ${it.item_id} 处于 ${it.state}（§3.1）`);
  };
  const decOf = (id) => decisions.get(id) ?? {};

  // 派生规则（T9）：前驱 REPLACED ⟺ 存在已锁定以上的后继（§3.3-3 结构上不可能发生）。
  // 每个事件处理前刷新推导态，保证守卫看到的是最新状态。
  const promoteReplaced = () => {
    for (const it of items.values()) {
      if (it.state !== 'FAILED_FINAL') continue;
      const succ = [...items.values()].find(s => s.origin === 'REPLACEMENT' && s.replacement_of === it.item_id);
      if (succ && succ.state !== 'QUOTED' && succ.state !== 'VOIDED') it.state = 'REPLACED';
    }
  };

  for (const e of events) {
    promoteReplaced();
    const p = e.data ?? {};
    switch (e.type) {
      case 'PAYMENT_SUCCEEDED':
        orderPaid = true;
        break;
      case 'QUOTE_CREATED':
      case 'ORDER_CONFIRMED':
        for (const it of (p.items ?? [])) { known.add(it.item_id); ensure(it.item_id); }
        break;

      case 'DECISION_REQUESTED': {
        const it = mustKnown(e.item_id, e);
        const d = decOf(e.item_id);
        if (d.requested) throw new StoreError('DECISION_ALREADY_OPEN', `${it.item_id} 已有决策流程`);
        d.requested = p.decision_id ?? true;
        decisions.set(e.item_id, d);
        it.pending_decision = p.decision_id ?? true;
        break;
      }
      case 'DECISION_RECEIVED': {
        const it = mustKnown(e.item_id, e);
        if (ITEM_TERMINAL.has(it.state))
          throw new StoreError('ILLEGAL_FROM_TERMINAL', `决策关闭后不可再接收（${it.item_id}=${it.state}）`);
        const d = decOf(e.item_id);
        if (!d.requested) throw new StoreError('DECISION_WITHOUT_REQUEST', `${it.item_id} 无未决决策`);
        if (it.decision_timed_out) throw new StoreError('DECISION_AFTER_TIMEOUT', '24h 窗口已关闭（§4.3）');
        if (!['REFUND', 'VOUCHER', 'REPLACE'].includes(p.choice))
          throw new StoreError('INVALID_CHOICE', `非法决策选项 ${p.choice}`);
        d.received = { choice: p.choice, successor_item_id: p.successor_item_id ?? null, delta_cents: p.delta_cents ?? 0 };
        decisions.set(e.item_id, d);
        it.pending_decision = null;
        it.resolved_choice = p.choice;
        if (p.choice === 'REPLACE') {
          if (!p.successor_item_id) throw new StoreError('REPLACE_WITHOUT_SUCCESSOR', '换模型决策必须指定后继 item（T9）');
          known.add(p.successor_item_id);
          ensure(p.successor_item_id, 'REPLACEMENT', e.item_id);
        }
        break;
      }
      case 'ITEM_LOCKED': {
        const it = mustKnown(e.item_id, e);
        if (it.origin === 'REPLACEMENT') {
          // 后继锁定：必须存在 REPLACE 决策；delta>0 时必须先收到补差（T11/§5.3）
          const d = decOf(it.replacement_of);
          if (d.received?.choice !== 'REPLACE')
            throw new StoreError('REPLACE_WITHOUT_DECISION', `后继 ${it.item_id} 锁定前必须有 REPLACE 决策（§3.3-5）`);
          if ((d.received.delta_cents ?? 0) > 0 && !it.surcharge_executed)
            throw new StoreError('SURCHARGE_REQUIRED', 'delta>0 的后继必须先收到补差（T11）');
          it.state = 'LOCKED';
        } else {
          requireState(it, ['QUOTED'], e);   // T1
          if (!orderPaid)
            throw new StoreError('PAYMENT_REQUIRED', 'ITEM_LOCKED 前必须有 PAYMENT_SUCCEEDED（T1/§3.1）');
          it.state = 'LOCKED';
        }
        break;
      }
      case 'ITEM_STARTED': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['LOCKED'], e);     // T3
        it.state = 'RUNNING';
        break;
      }
      case 'RECOVERY_ATTEMPTED': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['RUNNING'], e);    // T4：恢复环
        it.attempts += 1;
        break;
      }
      case 'RECOVERY_EXHAUSTED': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['RUNNING'], e);
        break;
      }
      case 'ITEM_COMPLETED': {
        const it = mustKnown(e.item_id, e);
        if (it.state === 'FAILED_FINAL')
          throw new StoreError('FAILED_FINAL_NOT_COMPLETABLE', `${it.item_id} 失败项永不可交付（§3.3-2）`);
        requireState(it, ['RUNNING'], e);    // T5
        it.state = 'COMPLETED';
        break;
      }
      case 'ITEM_FAILED_FINAL': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['RUNNING'], e);    // T6
        it.state = 'FAILED_FINAL';
        it.fail_reason = e.reason_code ?? null;
        break;
      }
      case 'SURCHARGE_EXECUTED': {
        const succ = mustKnown(p.successor_item_id, e);
        const d = decOf(succ.replacement_of);
        if (succ.origin !== 'REPLACEMENT' || d.received?.choice !== 'REPLACE')
          throw new StoreError('REPLACE_WITHOUT_DECISION', '补差执行必须有对应 REPLACE 决策（§3.3-5）');
        if ((d.received.delta_cents ?? 0) <= 0)
          throw new StoreError('SURCHARGE_NOT_DUE', 'delta≤0 不产生补差（§5.3）');
        requireState(succ, ['QUOTED'], e);
        succ.surcharge_executed = true;
        succ.state = 'LOCKED';               // T11
        break;
      }
      case 'SURCHARGE_EXPIRED': {
        const succ = mustKnown(e.item_id, e);
        if (succ.origin !== 'REPLACEMENT') throw new StoreError('ILLEGAL_TRANSITION', '补差超时只适用于后继项（T12）');
        requireState(succ, ['QUOTED'], e);
        succ.state = 'VOIDED';               // T12
        break;
      }
      case 'REFUND_EXECUTED': {
        const it = mustKnown(e.item_id, e);
        if (it.state !== 'FAILED_FINAL')
          throw new StoreError('REFUND_ON_NON_FAILED', `退款只作用于 FAILED_FINAL（§3.3-4），当前 ${it.state}`);
        const d = decOf(e.item_id);
        if (e.decision_source === 'TIMEOUT_RULE') {
          const succ = [...items.values()].find(s => s.origin === 'REPLACEMENT' && s.replacement_of === it.item_id);
          const viaSurchargeTimeout = d.received?.choice === 'REPLACE' && succ?.state === 'VOIDED';
          if (!it.decision_timed_out && !viaSurchargeTimeout)
            throw new StoreError('TIMEOUT_PATH_INVALID', '超时退款必须有 DECISION_TIMEOUT 或补差窗口过期（T10/T12）');
          it.state = 'TIMEOUT_REFUNDED';     // T10 / T12→T10
        } else {
          if (!d.received)
            throw new StoreError('REFUND_WITHOUT_DECISION', '用户退款必须有 REFUND 决策（§4.5）');
          const kind = p.kind ?? 'FULL_REFUND';
          if (d.received.choice === 'REFUND' && kind === 'FULL_REFUND') {
            it.state = 'REFUNDED';           // T7
          } else if (d.received.choice === 'REPLACE' && kind === 'REPLACE_DELTA_REFUND') {
            break;                           // 退差不改前驱状态；T9 由后继锁定派生（§2.5）
          } else {
            throw new StoreError('REFUND_KIND_MISMATCH', '退款类型与决策不匹配（§4.5）');
          }
        }
        break;
      }
      case 'VOUCHER_ISSUED': {
        const src = p.source ?? 'FAULT_COMPENSATION';
        if (e.item_id == null || src === 'GOODWILL') break;   // 订单级/善意券不动 item 状态
        const it = mustKnown(e.item_id, e);
        if (src === 'REFUND_RESTORE') {
          if (!['REFUNDED', 'TIMEOUT_REFUNDED'].includes(it.state))
            throw new StoreError('RESTORE_ON_NON_REFUNDED', '券部分原路补偿只作用于已退款项（§2.4）');
          break;                             // 状态不变
        }
        if (it.state !== 'FAILED_FINAL')
          throw new StoreError('ILLEGAL_FROM_TERMINAL', `FAULT_COMPENSATION 发券要求 FAILED_FINAL，当前 ${it.state}`);
        const d = decOf(e.item_id);
        if (d.received?.choice !== 'VOUCHER')
          throw new StoreError('VOUCHER_WITHOUT_DECISION', '领券必须有 VOUCHER 决策');
        it.state = 'VOUCHERED';              // T8
        break;
      }
      case 'DECISION_TIMEOUT': {
        const it = mustKnown(e.item_id, e);
        if (!it.pending_decision) throw new StoreError('TIMEOUT_WITHOUT_PENDING', '无未决决策可超时（§4.3）');
        it.pending_decision = null;
        it.decision_timed_out = true;
        break;
      }
      default:
        break; // 其余为订单级事件，由 projectOrder 处理
    }
  }
  promoteReplaced();
  return items;
}

function projectOrder(events) {
  const items = projectItems(events);       // 违规事件在这里就会抛出
  let quoteExpired = false, confirmed = false, paid = false;
  let previewed = false, finalized = false, objectionOpen = false;
  for (const e of events) {
    switch (e.type) {
      case 'QUOTE_EXPIRED': quoteExpired = true; break;
      case 'ORDER_CONFIRMED': confirmed = true; break;
      case 'PAYMENT_SUCCEEDED': paid = true; break;
      case 'SETTLEMENT_PREVIEWED': previewed = true; break;
      case 'SETTLEMENT_FINALIZED': finalized = true; break;
      case 'OBJECTION_RAISED': objectionOpen = true; break;
      case 'OBJECTION_RESOLVED': objectionOpen = false; break;
      default: break;
    }
  }
  if (!confirmed) return quoteExpired ? 'VOIDED' : 'QUOTED';
  if (!paid) return quoteExpired ? 'VOIDED' : 'AWAITING_PAYMENT';

  const states = [...items.values()].map(i => i.state);
  const allTerminal = states.length > 0 && states.every(s => ITEM_TERMINAL.has(s));
  const anyCompleted = states.includes('COMPLETED');
  const openDecision = [...items.values()].some(i => i.pending_decision);

  if (finalized) {
    if (!allTerminal || openDecision)
      throw new StoreError('FINALIZED_WITH_OPEN_ITEMS',
        '存在未终态 item 或未决决策时禁止 FINALIZED（§3.3-6 结构部分；金额校验 I3 归 M6）');
    return 'SETTLEMENT_FINALIZED';
  }
  if (objectionOpen) return 'DISPUTED';
  if (allTerminal && !openDecision) {
    if (anyCompleted) return previewed ? 'SETTLEMENT_PENDING' : 'DELIVERED';
    if (previewed) return 'SETTLEMENT_PENDING';   // 无交付物结算（§3.2 边则）
  }
  return 'FULFILLING';
}

// 准入守卫：任何引擎在 append 前调用。投影逻辑即守卫逻辑，一套代码两个用途。
function assertEventAllowed(history, candidate) {
  const next = [...history, candidate];
  projectItems(next);
  projectOrder(next);
  return true;
}


// ========== src/funding.js ==========
// M3：券额度→服务项资金的确定性分配（§2.4/§6.4）
// 规则：item 按单价升序（同价 item_id 字典序）逐项抵扣；券按先到期先用（同到期 voucher_id 升序）；额度可部分核销。


const byItemAsc = (a, b) =>
  a.locked_price_cents - b.locked_price_cents ||
  (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0);
const byVoucherExpiry = (a, b) => {
  const ea = a.expires_at ?? '9999-12-31', eb = b.expires_at ?? '9999-12-31';
  return ea < eb ? -1 : ea > eb ? 1 : (a.voucher_id < b.voucher_id ? -1 : 1);
};

function allocateFunding(items, vouchers = []) {
  for (const it of items)
    if (!Number.isInteger(it.locked_price_cents) || it.locked_price_cents < 0)
      throw new StoreError('INVALID_FUNDING', `item ${it.item_id} 价格非法`);
  for (const v of vouchers) {
    if (!Number.isInteger(v.remaining_cents) || v.remaining_cents < 0)
      throw new StoreError('INVALID_FUNDING', `voucher ${v.voucher_id} 余额非法`);
  }
  const pool = vouchers.map(v => ({ ...v, left: v.remaining_cents })).sort(byVoucherExpiry);
  const split = new Map();
  for (const it of [...items].sort(byItemAsc)) {
    let need = it.locked_price_cents, credit = 0;
    const allocations = [];
    for (const v of pool) {
      if (need === 0) break;
      if (v.left === 0) continue;
      const use = Math.min(need, v.left);
      v.left -= use; need -= use; credit += use;
      allocations.push({ voucher_id: v.voucher_id, applied_cents: use });
    }
    split.set(it.item_id, { cash_cents: it.locked_price_cents - credit, credit_cents: credit, allocations });
  }
  const funding = items.map(it => ({ item_id: it.item_id, ...split.get(it.item_id) }));
  const voucher_remaining = {};
  for (const v of pool) voucher_remaining[v.voucher_id] = v.left;
  return { funding, voucher_remaining };
}


// ========== src/pricing.js ==========
// M3→M6-fix：价格表查询 + 尾差分摊（§7.1）+ 报价创建（§5.2）
// M6-fix 根因修复：createQuote 此前在分摊之后才生成 item_id，allocateOrderTotal 的调整
// Map 以 undefined 为键坍缩为单键，全部 item 平摊整笔差额（5×800−10 → 5×790）。
// 修复：item_id 先于分摊生成；分摊函数加输入守卫 + Σ 自校验，此类错误从此不可能静默发生。





function lookupPrice(version, model_id) {
  const table = PRICE_TABLES[version];
  if (!table) throw new StoreError('UNKNOWN_PRICE_TABLE', version);
  if (!(model_id in table.models)) throw new StoreError('UNKNOWN_MODEL', model_id);
  return table.models[model_id];
}

// 尾差分摊：Σ locked ≡ total；价格降序、同价 item_id 升序，逐分承担（§7.1）
function allocateOrderTotal(items, totalCents) {
  if (!Number.isInteger(totalCents) || totalCents < 0)
    throw new StoreError('INVALID_QUOTE', 'bundle_total_cents 必须是非负整数（分）');
  for (const it of items)
    if (typeof it.item_id !== 'string' || it.item_id.length === 0)
      throw new StoreError('INVALID_QUOTE', '分摊输入项缺少 item_id（调整映射会坍缩，禁止）');
  const sum = items.reduce((a, i) => a + i.price_cents, 0);
  const order = [...items].sort((a, b) =>
    b.price_cents - a.price_cents ||
    (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
  const adj = new Map(items.map(i => [i.item_id, 0]));
  let diff = totalCents - sum;
  const step = diff > 0 ? 1 : -1;
  let k = 0;
  while (diff !== 0) {
    const id = order[k % order.length].item_id;
    adj.set(id, adj.get(id) + step);
    diff -= step; k += 1;
    if (k > 1_000_000) throw new StoreError('ALLOCATION_OVERFLOW', '尾差分摊异常');
  }
  const out = items.map(i => ({ ...i, locked_price_cents: i.price_cents + adj.get(i.item_id) }));
  const sumOut = out.reduce((a, o) => a + o.locked_price_cents, 0);
  if (sumOut !== totalCents)
    throw new StoreError('ALLOCATION_SUM_MISMATCH', `分摊后 Σ locked=${sumOut} ≠ 总额 ${totalCents}（§7.1）`);
  for (const o of out)
    if (o.locked_price_cents < 0) throw new StoreError('ALLOCATION_NEGATIVE', '尾差分摊导致负价格');
  return out;
}

function createQuote(store, { user_id, model_ids, bundle_total_cents = null, vouchers = [], now = new Date() }) {
  if (!Array.isArray(model_ids) || model_ids.length === 0)
    throw new StoreError('INVALID_QUOTE', 'model_ids 不能为空');
  // item_id 必须在分摊前生成（M6-fix 根因）
  const base = model_ids.map(id => ({
    item_id: genItemId(), model_id: id,
    price_cents: lookupPrice(PRICE_TABLE_VERSION, id),
  }));
  const priced = bundle_total_cents == null
    ? base.map(b => ({ ...b, locked_price_cents: b.price_cents }))
    : allocateOrderTotal(base, bundle_total_cents);
  const items = priced.map(p => ({
    item_id: p.item_id, model_id: p.model_id,
    price_cents: p.price_cents, locked_price_cents: p.locked_price_cents,
  }));
  const total = items.reduce((a, i) => a + i.locked_price_cents, 0);
  const expires_at = new Date(now.getTime() + SLA.QUOTE_TTL_MINUTES * 60_000).toISOString();
  const { funding } = allocateFunding(items, vouchers);
  const orderId = genOrderId();
  const events = [{
    type: 'QUOTE_CREATED',
    data: { user_id, price_table_version: PRICE_TABLE_VERSION, items, total_cents: total, expires_at },
  }];
  const reserved = new Map();
  for (const f of funding) for (const a of f.allocations)
    reserved.set(a.voucher_id, (reserved.get(a.voucher_id) ?? 0) + a.applied_cents);
  for (const [voucher_id, cents] of reserved)
    events.push({ type: 'VOUCHER_RESERVED', data: { voucher_id, reserved_cents: cents } });
  store.append(orderId, events);
  return { order_id: orderId, items, total_cents: total, expires_at, funding_preview: funding };
}


// ========== src/carryover.js ==========
// §2.5 换模型结转代数（规范性）。四方向由测试金样本锁定：
// 现金8→10 补2 / 现金8→6 退2 / 券8→10 补2 / 券8→6 退券2
function computeCarryover({ prior_cash_cents, prior_credit_cents, new_price_cents }) {
  const credit_carried_cents = Math.min(prior_credit_cents, new_price_cents);
  const cash_due_cents = new_price_cents - credit_carried_cents;
  const cash_delta_cents = cash_due_cents - prior_cash_cents;      // >0 补收 / <0 退还 / 0 不动
  const credit_surplus_cents = Math.max(0, prior_credit_cents - new_price_cents); // 发等额新券
  return { credit_carried_cents, cash_due_cents, cash_delta_cents, credit_surplus_cents };
}


// ========== src/checkout.js ==========
// M3：结账引擎——报价确认 / 沙箱收款 / funding_split 落账（§5.2、§2.4）
// 所有 append 前过 M2 守卫：引擎也只能走合法轨道。





function appendGuarded(store, orderId, history, events) {
  let h = history;
  for (const ev of events) { assertEventAllowed(h, ev); h = [...h, ev]; }
  return store.append(orderId, events);
}

export async function confirmPayment(store, orderId, { channel, vouchers = [], now = new Date() }) {
  const history = store.getOrder(orderId);
  if (history.length === 0) throw new StoreError('ORDER_NOT_FOUND', orderId);
  if (history.some(e => e.type === 'ORDER_CONFIRMED'))
    throw new StoreError('ALREADY_CONFIRMED', orderId + ' 已确认，勿重复支付');
  const q = history.find(e => e.type === 'QUOTE_CREATED');
  if (!q) throw new StoreError('ORDER_NOT_FOUND', '缺少 QUOTE_CREATED');

  // 锁价窗口（§5.2）：过期 → 订单作废 + 额度释放（§6.2 VOUCHER_RELEASED）
  if (now.toISOString() > q.data.expires_at) {
    const evs = [{ type: 'QUOTE_EXPIRED', data: { expired_at: now.toISOString() } }];
    for (const r of history.filter(e => e.type === 'VOUCHER_RESERVED'))
      evs.push({ type: 'VOUCHER_RELEASED', data: { voucher_id: r.data.voucher_id, released_cents: r.data.reserved_cents } });
    appendGuarded(store, orderId, history, evs);
    throw new StoreError('QUOTE_EXPIRED', '报价已过锁价窗口（§5.2），订单作废、额度已释放');
  }

  const items = q.data.items.map(it => ({ item_id: it.item_id, locked_price_cents: it.locked_price_cents }));
  const { funding } = allocateFunding(items, vouchers);
  const totalCash = funding.reduce((a, f) => a + f.cash_cents, 0);
  const operation_id = genOperationId('payment', orderId);
  // 合成义务号：复用"每义务至多一次 EXECUTED"的唯一索引 → 每订单至多一次成功收款（§5.1）
  store.recordOperation({ operation_id, order_id: orderId, obligation_id: 'obl_pay:' + orderId, type: 'payment' });

  appendGuarded(store, orderId, history,
    [{ type: 'PAYMENT_INITIATED', amount_cents: totalCash, data: { operation_id } }]);

  let res = await channel.charge({ operation_id, amount_cents: totalCash });
  if (res.state === 'UNKNOWN') {
    store.markOperation(operation_id, 'UNKNOWN');
    res = await channel.resolve(operation_id);
  }
  if (res.state !== 'SUCCEEDED' && res.state !== 'FAILED')
    throw new StoreError('PAYMENT_UNKNOWN', '渠道状态未决（§5.2，超 30 分钟入 MANUAL_POOL）');

  const h2 = store.getOrder(orderId);
  if (res.state === 'FAILED') {
    store.markOperation(operation_id, 'FAILED');
    appendGuarded(store, orderId, h2,
      [{ type: 'PAYMENT_FAILED', data: { operation_id, reason: 'CHANNEL_DECLINED' } }]);
    throw new StoreError('PAYMENT_DECLINED', '渠道拒绝，可重试（将生成新 operation）');
  }
  store.markOperation(operation_id, 'EXECUTED', res.channel_ref);

  const confirmedItems = q.data.items.map(it => ({
    ...it,
    funding_split: (({ item_id: _fid, ...rest }) => rest)(funding.find(f => f.item_id === it.item_id)),
  }));
  const perVoucher = new Map();
  for (const f of funding)
    for (const a of f.allocations) {
      const cur = perVoucher.get(a.voucher_id) ?? { applied_cents: 0, allocations: [] };
      cur.applied_cents += a.applied_cents;
      cur.allocations.push({ item_id: f.item_id, applied_cents: a.applied_cents });
      perVoucher.set(a.voucher_id, cur);
    }
  appendGuarded(store, orderId, h2, [
    { type: 'PAYMENT_SUCCEEDED', amount_cents: totalCash, data: { operation_id, channel_ref: res.channel_ref } },
    { type: 'ORDER_CONFIRMED', data: { items: confirmedItems, total_cents: q.data.total_cents, cash_paid_cents: totalCash } },
    ...[...perVoucher].map(([voucher_id, info]) => ({ type: 'VOUCHER_REDEEMED', data: { voucher_id, ...info } })),
  ]);
  return { order_id: orderId, operation_id, cash_paid_cents: totalCash, status: projectOrder(store.getOrder(orderId)) };
}


// ========== src/payments.js ==========
// M3：沙箱收款通道（§5.2）。M7 切真实渠道时替换本类，引擎不动。
// 剧本可选 'SUCCEEDED'（默认）/'FAILED'/'UNKNOWN'；同 operation_id 重放返回同结果（I2 通道层）。
class SandboxChannel {
  constructor(script = [], opts = {}) {
    this.script = [...script];
    this.sticky = !!opts.stickyUnknown;      // 模拟真实渠道 UNKNOWN 长期不收敛（§8.2）
    this.confirmed = new Set();
    this.pending = new Map();
    this.resolved = new Map();
    this.calls = [];
  }
  #ref(operation_id) { return 'sbx_' + operation_id.slice(-8); }
  async charge({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }
  async refund({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }

  async refund({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }

  async refund({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }

  confirmUnknown(operation_id) { this.confirmed.add(operation_id); }
  // 主动查询通道（§5.2 双通道）：沙箱里 UNKNOWN 一查即定案
  async resolve(operation_id) {
    if (!this.pending.has(operation_id))
      return this.resolved.get(operation_id) ?? { state: 'UNKNOWN' };
    if (this.sticky && !this.confirmed.has(operation_id)) return { state: 'UNKNOWN' };
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r);
    this.pending.delete(operation_id);
    return r;
  }
}


// ========== src/refunds.js ==========
// §5.4 退款执行：现金走渠道（义务→operation→执行，I2 幂等）；券部分原路补偿发新券（§2.4）。
// 重试语义（§5.4）：复用未决义务（无 REFUND_EXECUTED 引用的 REFUND_DUE），义务至多生效一次。





function orderItem(history, itemId) {
  const oc = history.find(e => e.type === 'ORDER_CONFIRMED');
  return (oc?.data.items ?? []).find(x => x.item_id === itemId) ?? null;
}

async function executeObligation(store, orderId, { item_id, dueEvent, executeType, decision_source,
  amount_cents, kind, channelRefFn, extra = {} }) {
  const opId = genOperationId(executeType.toLowerCase(), orderId, item_id);
  store.recordOperation({ operation_id: opId, order_id: orderId, obligation_id: dueEvent.event_id, type: executeType.toLowerCase() });
  const res = await channelRefFn({ operation_id: opId, amount_cents });
  if (res.state === 'UNKNOWN') {
    store.markOperation(opId, 'UNKNOWN');
    throw new StoreError('REFUND_UNKNOWN', '渠道状态未决，入重试队列（§5.1）');
  }
  if (res.state === 'FAILED') {
    store.markOperation(opId, 'FAILED');
    throw new StoreError('REFUND_STUCK', '渠道拒绝，可重试（复用义务，新 operation，§5.4）');
  }
  store.markOperation(opId, 'EXECUTED', res.channel_ref);
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: executeType, item_id, amount_cents, decision_source, caused_by: [dueEvent.event_id],
    data: { operation_id: opId, channel_ref: res.channel_ref, kind, ...extra },
  }]);
  return { operation_id: opId, channel_ref: res.channel_ref };
}

export async function applyFullRefund(store, orderId, itemId, { channel, decision_source = 'USER_DECISION' }) {
  const history = store.getOrder(orderId);
  const rec = orderItem(history, itemId);
  const fs = rec?.funding_split ?? { cash_cents: 0, credit_cents: 0 };
  const cash = fs.cash_cents ?? 0;

  // 未决义务复用：存在未被任何执行引用的 FULL_REFUND DUE → 重试，不新建
  const executedRefs = new Set(history.filter(e => e.type === 'REFUND_EXECUTED').flatMap(e => e.caused_by ?? []));
  let due = history.find(e => e.type === 'REFUND_DUE' && e.item_id === itemId
    && (e.data?.kind ?? 'FULL_REFUND') === 'FULL_REFUND' && !executedRefs.has(e.event_id));
  if (!due) {
    [due] = appendGuarded(store, orderId, history,
      [{ type: 'REFUND_DUE', item_id: itemId, amount_cents: cash, data: { kind: 'FULL_REFUND' } }]);
  }

  if (cash > 0) {
    await executeObligation(store, orderId, {
      item_id: itemId, dueEvent: due, executeType: 'REFUND_EXECUTED',
      decision_source, amount_cents: cash, kind: 'FULL_REFUND',
      channelRefFn: a => channel.refund(a),
    });
  } else {
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'REFUND_EXECUTED', item_id: itemId, amount_cents: 0, decision_source,
      caused_by: [due.event_id], data: { kind: 'FULL_REFUND', zero_cash: true },
    }]);
  }

  const creditIssued = history.some(e =>
    e.type === 'VOUCHER_ISSUED' && e.item_id === itemId && e.data?.source === 'REFUND_RESTORE');
  if ((fs.credit_cents ?? 0) > 0 && !creditIssued) {
    const voucher_id = genVoucherId();
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'VOUCHER_ISSUED', item_id: itemId, amount_cents: fs.credit_cents,
      data: { source: 'REFUND_RESTORE', voucher_id, face_value_cents: fs.credit_cents, expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(), },
    }]);
    return { refunded_cash_cents: cash, voucher_id, credit_cents: fs.credit_cents };
  }
  return { refunded_cash_cents: cash, voucher_id: null, credit_cents: 0 };
}

export async function applyDeltaRefund(store, orderId, itemId, amount_cents, { channel }) {
  const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'REFUND_DUE', item_id: itemId, amount_cents, data: { kind: 'REPLACE_DELTA_REFUND' } }]);
  return executeObligation(store, orderId, {
    item_id: itemId, dueEvent: due, executeType: 'REFUND_EXECUTED',
    decision_source: 'USER_DECISION', amount_cents, kind: 'REPLACE_DELTA_REFUND',
    channelRefFn: a => channel.refund(a),
  });
}


// ========== src/decisions.js ==========
// M5：决策引擎。弹窗数据契约（§4.4）由后端预计算；执行路径（§4.5）落账全部过 M2 守卫。








const yuan = c => '¥' + (c / 100).toFixed(2);

function buildDecisionPayload(history, orderId, itemId, now = new Date()) {
  const it = projectItems(history).get(itemId);
  if (!it || it.state !== 'FAILED_FINAL') throw new StoreError('NOT_FAILED_FINAL', itemId);
  const rec = (history.find(e => e.type === 'ORDER_CONFIRMED')?.data.items ?? []).find(x => x.item_id === itemId);
  const locked = rec?.locked_price_cents ?? 0;
  const fs = rec?.funding_split ?? { cash_cents: 0, credit_cents: 0 };
  const models = PRICE_TABLES[PRICE_TABLE_VERSION].models;
  const candidates = Object.entries(models)
    .filter(([mid]) => mid !== rec?.model_id)
    .map(([model_id, price]) => {
      const c = computeCarryover({ prior_cash_cents: fs.cash_cents, prior_credit_cents: fs.credit_cents, new_price_cents: price });
      return {
        model_id, price_cents: price,
        delta_cents: c.cash_delta_cents, credit_surplus_cents: c.credit_surplus_cents,
        label: c.cash_delta_cents > 0 ? `补 ${yuan(c.cash_delta_cents)} 更换`
             : c.cash_delta_cents < 0 ? `更换并退 ${yuan(-c.cash_delta_cents)}`
             : '等额更换',
      };
    });
  return {
    decision_id: genDecisionId(), order_id: orderId,
    failed_item: { item_id: itemId, model_id: rec?.model_id, locked_price_cents: locked, reason_code: it.fail_reason },
    funding: { cash_cents: fs.cash_cents, credit_cents: fs.credit_cents },
    expires_at: new Date(now.getTime() + SLA.DECISION_TIMEOUT_HOURS * 3600_000).toISOString(),
    options: [
      { type: 'REFUND',   refund_cash_cents: fs.cash_cents, refund_credit_cents: fs.credit_cents, label: `退款 ${yuan(fs.cash_cents)}，会诊继续` },
      { type: 'VOUCHER',  credit_cents: locked, label: `领取 ${yuan(locked)} 服务额度，会诊继续` },
      { type: 'REPLACE',  candidates },
    ],
    default_on_timeout: 'REFUND',
    notice: `${SLA.DECISION_TIMEOUT_HOURS} 小时未选择将自动退款，会诊不受影响`,
  };
}

function openDecision(store, orderId, itemId, now = new Date()) {
  const history = store.getOrder(orderId);
  const payload = buildDecisionPayload(history, orderId, itemId, now);
  appendGuarded(store, orderId, history,
    [{ type: 'DECISION_REQUESTED', item_id: itemId, data: { decision_id: payload.decision_id, payload } }]);
  return payload;
}

function receive(store, orderId, itemId, data) {
  appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'DECISION_RECEIVED', item_id: itemId, decision_source: 'USER_DECISION', data }]);
}

export async function executeRefundChoice(store, orderId, itemId, channel) {
  receive(store, orderId, itemId, { choice: 'REFUND' });
  return applyFullRefund(store, orderId, itemId, { channel, decision_source: 'USER_DECISION' });
}

function executeVoucherChoice(store, orderId, itemId) {
  const rec = (store.getOrder(orderId).find(e => e.type === 'ORDER_CONFIRMED')?.data.items ?? []).find(x => x.item_id === itemId);
  const locked = rec?.locked_price_cents ?? 0;
  receive(store, orderId, itemId, { choice: 'VOUCHER' });
  const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'CREDIT_DUE', item_id: itemId, amount_cents: locked, data: { form: 'CREDIT' } }]);
  const voucher_id = genVoucherId();
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: 'VOUCHER_ISSUED', item_id: itemId, amount_cents: locked, caused_by: [due.event_id],
    data: { source: 'FAULT_COMPENSATION', voucher_id, face_value_cents: locked, expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(), },
  }]);
  return { voucher_id, credit_cents: locked };
}

export async function executeReplaceChoice(store, orderId, itemId, successorModelId, channel) {
  const payload = buildDecisionPayload(store.getOrder(orderId), orderId, itemId);
  const cand = payload.options.find(o => o.type === 'REPLACE').candidates.find(c => c.model_id === successorModelId);
  if (!cand) throw new StoreError('INVALID_SUCCESSOR', successorModelId);
  const succItemId = genItemId();
  receive(store, orderId, itemId, {
    choice: 'REPLACE', successor_item_id: succItemId,
    successor_model_id: successorModelId, delta_cents: cand.delta_cents,
  });
  const c = computeCarryover({
    prior_cash_cents: payload.funding.cash_cents,
    prior_credit_cents: payload.funding.credit_cents,
    new_price_cents: cand.price_cents,
  });
  const succFunding = { cash_cents: c.cash_due_cents, credit_cents: c.credit_carried_cents };

  if (c.cash_delta_cents > 0) {                                   // 补差（§5.3）
    const [due] = appendGuarded(store, orderId, store.getOrder(orderId),
      [{ type: 'SURCHARGE_DUE', item_id: itemId, amount_cents: c.cash_delta_cents,
         data: { successor_item_id: succItemId, successor_model_id: successorModelId } }]);
    const opId = genOperationId('surcharge', orderId, succItemId);
    store.recordOperation({ operation_id: opId, order_id: orderId, obligation_id: due.event_id, type: 'surcharge' });
    const res = await channel.charge({ operation_id: opId, amount_cents: c.cash_delta_cents });
    if (res.state !== 'SUCCEEDED') { store.markOperation(opId, 'FAILED'); throw new StoreError('SURCHARGE_FAILED', '补差支付未成功'); }
    store.markOperation(opId, 'EXECUTED', res.channel_ref);
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'SURCHARGE_EXECUTED', amount_cents: c.cash_delta_cents, caused_by: [due.event_id],
      data: { successor_item_id: succItemId, operation_id: opId, channel_ref: res.channel_ref, funding_split: succFunding },
    }]);                                                          // T11：后继直接 LOCKED
  } else if (c.cash_delta_cents < 0) {                            // 退差（§2.5）
    await applyDeltaRefund(store, orderId, itemId, -c.cash_delta_cents, { channel });
    appendGuarded(store, orderId, store.getOrder(orderId),
      [{ type: 'ITEM_LOCKED', item_id: succItemId, data: { funding_split: succFunding } }]);
  } else {
    appendGuarded(store, orderId, store.getOrder(orderId),
      [{ type: 'ITEM_LOCKED', item_id: succItemId, data: { funding_split: succFunding } }]);
  }
  if (c.credit_surplus_cents > 0) {                               // 券溢余：订单级发新券（§2.5）
    appendGuarded(store, orderId, store.getOrder(orderId), [{
      type: 'VOUCHER_ISSUED', amount_cents: c.credit_surplus_cents,
      data: { source: 'CARRYOVER_SURPLUS', voucher_id: genVoucherId(), face_value_cents: c.credit_surplus_cents, expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(), },
    }]);
  }
  return { successor_item_id: succItemId, carryover: c };
}

export async function executeTimeout(store, orderId, itemId, channel) {
  appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'DECISION_TIMEOUT', item_id: itemId }]);
  return applyFullRefund(store, orderId, itemId, { channel, decision_source: 'TIMEOUT_RULE' });
}


// ========== src/fulfillment.js ==========
// M4：履约引擎——驱动 ServiceItem 走 LOCKED→RUNNING→COMPLETED/FAILED_FINAL（§4）
// 恢复策略（§4.2）：A 类指数退避 ≤3 次；B 类直接终判；C 类 1 次修正重试。
// 铁律：引擎只产生事件。状态推导与违例拒绝全部由 orders.js 守卫完成。





const CLASS_A = new Set(['MODEL_RATE_LIMITED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT']);
const CLASS_B = new Set(['MODEL_AUTH_FAILURE', 'UPSTREAM_SUSPENDED']);
const CLASS_C = new Set(['MODEL_RESPONSE_INVALID']);

function classifyFailure(reason_code) {
  if (CLASS_A.has(reason_code)) return 'A';
  if (CLASS_B.has(reason_code)) return 'B';
  if (CLASS_C.has(reason_code)) return 'C';
  throw new StoreError('UNKNOWN_REASON_CODE', reason_code);
}

// 适配器契约（M7 接真实 providers.js 时实现同一接口）：
//   run(model_id, input) → { ok: true, result_ref } | { ok: false, reason_code, raw? }
export async function fulfillItem(store, orderId, itemId, modelId, adapter, opts = {}) {
  const baseInput = opts.input ?? {};   // 议题/角色 prompt 经此透传给适配器
  const backoffMs = opts.backoffMs ?? 1000;   // 测试传 0 跳过真实退避
  const maxAttempts = SLA.RECOVERY_MAX_ATTEMPTS;

  // T1+T3：原始项 QUOTED→LOCKED→STARTED；后继项若已 LOCKED（T11 补差后）直接 STARTED
  const st = projectItems(store.getOrder(orderId)).get(itemId)?.state;
  const drive = [];
  if (st === 'QUOTED') drive.push({ type: 'ITEM_LOCKED', item_id: itemId });
  if (st === 'QUOTED' || st === 'LOCKED') drive.push({ type: 'ITEM_STARTED', item_id: itemId });
  if (drive.length) appendGuarded(store, orderId, store.getOrder(orderId), drive);

  let attempt = 0;        // A 类恢复已用次数
  let corrected = false;  // C 类修正重试已用
  let lastRaw = null;

  while (true) {
    const res = await adapter.run(modelId, { ...baseInput, ...(corrected ? { corrected: true } : {}) });
    if (res.ok) {
      appendGuarded(store, orderId, store.getOrder(orderId),
        [{ type: 'ITEM_COMPLETED', item_id: itemId, data: { result_ref: res.result_ref } }]);  // T5
      return { completed: true, result_ref: res.result_ref, recovery_attempts: attempt };
    }
    lastRaw = res.raw ?? null;
    const cls = classifyFailure(res.reason_code);

    if (cls === 'C' && !corrected) {          // §4.2：C 类恰 1 次修正重试
      corrected = true;
      appendGuarded(store, orderId, store.getOrder(orderId),
        [{ type: 'RECOVERY_ATTEMPTED', item_id: itemId, reason_code: res.reason_code,
           data: { kind: 'C_RETRY_CORRECTED' } }]);
      continue;
    }
    if (cls === 'A' && attempt < maxAttempts) {  // §4.2：A 类恢复环
      attempt += 1;
      const scheduled = 1000 * 2 ** (attempt - 1);            // 协议退避表（§4.2），恒定，入事件
      const wait = Math.round(backoffMs * 2 ** (attempt - 1)); // 实际睡眠，测试可缩放
      appendGuarded(store, orderId, store.getOrder(orderId),
        [{ type: 'RECOVERY_ATTEMPTED', item_id: itemId, reason_code: res.reason_code,
           data: { attempt, backoff_ms: scheduled } }]);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      continue;
    }

    // 终判（T6）：A 类耗尽 / B 类 / C 类修正后仍失败
    appendGuarded(store, orderId, store.getOrder(orderId), [
      ...(cls === 'A' ? [{ type: 'RECOVERY_EXHAUSTED', item_id: itemId,
                           reason_code: res.reason_code, data: { attempts: attempt } }] : []),
      { type: 'ITEM_FAILED_FINAL', item_id: itemId, reason_code: res.reason_code,
        data: { evidence: { attempts: attempt, corrected, last_raw: lastRaw } } },
    ]);
    return { completed: false, reason_code: res.reason_code, recovery_attempts: attempt };
  }
}


// ========== src/settlement.js ==========
// §7 结算协议：E1 现金守恒、结算预演（§7.2）、I3 完整前置、72h 异议期（§7.3）。






// E1：Σ收款(支付+补差) − Σ退款(含退差) = Σ{COMPLETED,VOUCHERED} 的 cash（§7.1）
function E1(events) {
  const items = projectItems(events);
  let paid = 0, refunded = 0;
  const fundingByItem = new Map();
  for (const e of events) {
    switch (e.type) {
      case 'PAYMENT_SUCCEEDED':  paid += e.amount_cents ?? 0; break;
      case 'SURCHARGE_EXECUTED':
        paid += e.amount_cents ?? 0;
        if (e.data?.funding_split)
          fundingByItem.set(e.data.successor_item_id, e.data.funding_split);
        break;
      case 'REFUND_EXECUTED':    refunded += e.amount_cents ?? 0; break;
      case 'ORDER_CONFIRMED':
        for (const it of (e.data.items ?? []))
          if (it.funding_split) fundingByItem.set(it.item_id, it.funding_split);
        break;
      case 'ITEM_LOCKED':
        if (e.data?.funding_split) fundingByItem.set(e.item_id, e.data.funding_split);
        break;
      default: break;
    }
  }
  let expected = 0;
  for (const it of items.values())
    if (it.state === 'COMPLETED' || it.state === 'VOUCHERED')
      expected += fundingByItem.get(it.item_id)?.cash_cents ?? 0;
  return {
    paid_cash_cents: paid, refunded_cash_cents: refunded,
    expected_cash_cents: expected, diff: paid - refunded - expected,
  };
}

// I3（§7.1 E3 / §2.6）：无未决决策 ∧ 每笔义务有执行 ∧ 无未决渠道操作
function assertI3(store, orderId) {
  const h = store.getOrder(orderId);
  const items = projectItems(h);
  for (const it of items.values())
    if (it.pending_decision)
      throw new StoreError('I3_PENDING_DECISIONS', `${it.item_id} 存在未决决策`);
  const dues = h.filter(e => ['REFUND_DUE', 'SURCHARGE_DUE', 'CREDIT_DUE'].includes(e.type));
  const executed = h.filter(e =>
    ['REFUND_EXECUTED', 'SURCHARGE_EXECUTED', 'VOUCHER_ISSUED'].includes(e.type));
  const covered = new Set(executed.flatMap(e => e.caused_by ?? []));
  const uncovered = dues.filter(d => !covered.has(d.event_id));
  if (uncovered.length)
    throw new StoreError('I3_UNSETTLED_DUES', `${uncovered.length} 笔义务未执行：${uncovered.map(d => d.type + '@' + d.seq).join(', ')}`);
  const unsettled = store.getOperationsByOrder(orderId)
    .filter(o => ['CREATED', 'EXECUTING', 'UNKNOWN'].includes(o.state));
  if (unsettled.length)
    throw new StoreError('I3_UNSETTLED_OPERATIONS', `${unsettled.length} 笔渠道操作未决（§5.1）`);
  return true;
}

function priceOf(itemId, ocItems, h) {
  const rec = (ocItems ?? []).find(x => x.item_id === itemId);
  if (rec) return rec.locked_price_cents;
  const sur = h.find(e => e.type === 'SURCHARGE_EXECUTED' && e.data?.successor_item_id === itemId);
  if (sur?.data?.funding_split)
    return (sur.data.funding_split.cash_cents ?? 0) + (sur.data.funding_split.credit_cents ?? 0);
  const lk = h.find(e => e.type === 'ITEM_LOCKED' && e.item_id === itemId && e.data?.funding_split);
  if (lk?.data?.funding_split)
    return (lk.data.funding_split.cash_cents ?? 0) + (lk.data.funding_split.credit_cents ?? 0);
  return 0;
}

// 结算预演（§7.2）：全部终态才可预演；balance=E1.diff 必须 0 才可 finalize
function previewSettlement(store, orderId, { now = new Date() } = {}) {
  const h = store.getOrder(orderId);
  const items = projectItems(h);
  const allTerminal = items.size > 0 && [...items.values()].every(i => ITEM_TERMINAL.has(i.state));
  const openDecision = [...items.values()].some(i => i.pending_decision);
  if (!allTerminal || openDecision)
    throw new StoreError('NOT_SETTLEMENT_READY', `当前投影 ${projectOrder(h)}（§7.3 触发条件不满足）`);
  const oc = h.find(e => e.type === 'ORDER_CONFIRMED');
  const ocItems = oc?.data.items ?? [];
  const total = ocItems.reduce((a, i) => a + i.locked_price_cents, 0);
  const paid = h.filter(e => ['PAYMENT_SUCCEEDED', 'SURCHARGE_EXECUTED'].includes(e.type))
    .reduce((a, e) => a + (e.amount_cents ?? 0), 0);
  const refunded = h.filter(e => e.type === 'REFUND_EXECUTED')
    .reduce((a, e) => a + (e.amount_cents ?? 0), 0);
  const voucherIssued = h.filter(e => e.type === 'VOUCHER_ISSUED')
    .reduce((a, e) => a + (e.data.face_value_cents ?? e.amount_cents ?? 0), 0);
  const voucherRedeemed = h.filter(e => e.type === 'VOUCHER_REDEEMED')
    .reduce((a, e) => a + (e.data.applied_cents ?? 0), 0);
  const delivered = [...items.values()].filter(i => i.state === 'COMPLETED')
    .reduce((a, i) => a + priceOf(i.item_id, ocItems, h), 0);

  const adjustments = [...items.values()].map(it => {
    const base = { item_id: it.item_id, state: it.state };
    const cash = (ocItems.find(x => x.item_id === it.item_id)?.funding_split?.cash_cents) ?? 0;
    switch (it.state) {
      case 'COMPLETED':      return { ...base, kind: 'DELIVERED', delta_cents: 0, note: '已交付' };
      case 'REPLACED':       return { ...base, kind: 'REPLACED', delta_cents: 0, note: '由后继项承接（§2.5）' };
      case 'REFUNDED':       return { ...base, kind: 'REFUND', delta_cents: -cash, note: '未履约退款' };
      case 'TIMEOUT_REFUNDED': return { ...base, kind: 'REFUND', delta_cents: -cash, note: '24h 未决策自动退款' };
      case 'VOUCHERED':      return { ...base, kind: 'VOUCHERED', delta_cents: 0, note: `未履约，转服务额度（券部分原路另发）` };
      case 'VOIDED':         return { ...base, kind: 'VOIDED', delta_cents: 0, note: '未进入履约' };
      default:               return { ...base, kind: 'UNKNOWN', delta_cents: 0, note: it.state };
    }
  });

  const e1 = E1(h);
  const preview = {
    order_total_locked_cents: total,
    paid_cash_cents: paid,
    refunded_cash_cents: refunded,
    voucher_issued_cents: voucherIssued,
    voucher_redeemed_cents: voucherRedeemed,
    delivered_value_cents: delivered,
    final_due_cents: paid - refunded,
    balance_cents: e1.diff,
    adjustments,
    previewed_at: now.toISOString(),
  };
  appendGuarded(store, orderId, h,
    [{ type: 'SETTLEMENT_PREVIEWED', occurred_at: now.toISOString(), data: { preview } }]);
  return preview;
}

function raiseObjection(store, orderId, { scope, reason, now = new Date() } = {}) {
  const h = store.getOrder(orderId);
  const count = h.filter(e => e.type === 'OBJECTION_RAISED').length;
  if (count >= 2)
    throw new StoreError('MANUAL_POOL_REQUIRED', '第 3 次异议转人工通道（§7.3/§8.2）');
  appendGuarded(store, orderId, h,
    [{ type: 'OBJECTION_RAISED', data: { scope, reason, raised_at: now.toISOString() } }]);
  return { objections_raised: count + 1 };
}

function resolveObjection(store, orderId, { resolution, note = '' }, now = new Date()) {
  const h = store.getOrder(orderId);
  if (!h.some(e => e.type === 'OBJECTION_RAISED') ||
      h[h.length - 1]?.type === 'OBJECTION_RESOLVED')
    throw new StoreError('NO_OPEN_OBJECTION', '无未决异议');
  appendGuarded(store, orderId, h,
    [{ type: 'OBJECTION_RESOLVED', data: { resolution, note, resolved_at: now.toISOString() } }]);
  return { resolution };
}

// FINALIZED（§7.3/§7.4）：预演存在 ∧ 非争议 ∧ 72h 满 ∧ I3 ∧ E1=0 → 快照+hash 落账
function finalizeSettlement(store, orderId, { now = new Date() } = {}) {
  const h = store.getOrder(orderId);
  const pv = [...h].reverse().find(e => e.type === 'SETTLEMENT_PREVIEWED');
  if (!pv) throw new StoreError('NO_PREVIEW', '结算前必须先出预演（§7.3）');
  const order = projectOrder(h);
  if (order === 'DISPUTED') throw new StoreError('OBJECTION_OPEN', '异议未解决，结算冻结（§7.3）');
  const elapsedH = (now.getTime() - new Date(pv.occurred_at).getTime()) / 3600_000;
  if (elapsedH < SLA.OBJECTION_PERIOD_HOURS)
    throw new StoreError('PREVIEW_PERIOD_ACTIVE', `异议期未满：${elapsedH.toFixed(1)}h < ${SLA.OBJECTION_PERIOD_HOURS}h`);
  assertI3(store, orderId);
  const e1 = E1(h);
  if (e1.diff !== 0) throw new StoreError('E1_IMBALANCE', `现金守恒破坏：diff=${e1.diff}`);
  const snapshot = { ...pv.data.preview, finalized_at: now.toISOString() };
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  appendGuarded(store, orderId, h,
    [{ type: 'SETTLEMENT_FINALIZED', data: { snapshot, hash } }]);
  return { hash, snapshot };
}


// ========== src/vouchers.js ==========
// §6：券余额从事件流推导。
// I7：face = remaining + redeemed + reserved + expired；核销是预占→已核销的转移（§6.2）。
function projectVouchers(events) {
  const v = new Map();
  const ensure = id => {
    if (!v.has(id)) v.set(id, {
      voucher_id: id, face_value_cents: 0, redeemed_cents: 0,
      reserved_cents: 0, expired_cents: 0, remaining_cents: 0,
      expires_at: null, sources: [],
    });
    return v.get(id);
  };
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'VOUCHER_ISSUED': {
        const x = ensure(d.voucher_id);
        x.face_value_cents += d.face_value_cents ?? e.amount_cents ?? 0;
        x.remaining_cents += d.face_value_cents ?? e.amount_cents ?? 0;
        if (d.expires_at) x.expires_at = d.expires_at;
        x.sources.push(d.source ?? 'UNKNOWN');
        break;
      }
      case 'VOUCHER_RESERVED':   { const x = ensure(d.voucher_id); x.reserved_cents += d.reserved_cents; x.remaining_cents -= d.reserved_cents; break; }
      case 'VOUCHER_RELEASED':   { const x = ensure(d.voucher_id); x.reserved_cents -= d.released_cents; x.remaining_cents += d.released_cents; break; }
      case 'VOUCHER_REDEEMED':   { const x = ensure(d.voucher_id); x.reserved_cents -= d.applied_cents; x.redeemed_cents += d.applied_cents; break; }
      case 'VOUCHER_EXPIRED':    { const x = ensure(d.voucher_id); x.expired_cents += x.remaining_cents; x.remaining_cents = 0; break; }
      default: break;
    }
  }
  return v;
}

function assertI7(events) {
  for (const x of projectVouchers(events).values()) {
    const lhs = x.face_value_cents;
    const rhs = x.remaining_cents + x.redeemed_cents + x.reserved_cents + x.expired_cents;
    if (lhs !== rhs)
      throw Object.assign(new Error(`I7 violated: ${x.voucher_id} ${lhs}≠${rhs}`), { code: 'I7_VIOLATED' });
  }
  return true;
}


// ========== src/collision.js ==========
// M-B 预埋：碰撞报告引擎 v0。
// 输入：各 COMPLETED 项的意见文本。输出：{ disagreements, holes, consensuses } 三栏。
// v0 为轻量启发式（关键词共现）；真模型接入后升级为"模型互评"二次调用（顾问 A 挑 B 的漏洞），协议无需变更。
function buildCollisionReport(opinions) {
  const valid = opinions.filter(o => o.text && o.text.length > 20);
  if (valid.length < 2) return null;
  const TOPICS = ['成本','风险','时机','合规','技术','市场','团队','资金','定价','增长','竞争','用户'];
  const hits = t => TOPICS.filter(k => t.includes(k));
  const disagreements = [], consensuses = [];
  for (const topic of TOPICS) {
    const who = valid.filter(o => hits(o.text).includes(topic));
    if (who.length < 2) continue;
    const stances = who.map(o => ({ model: o.model_id, snippet: snippetAround(o.text, topic) }));
    // v0 启发式：立场词共现判断（反对/但是/风险 vs 优势/可以/建议）
    const neg = stances.filter(s => /风险|不足|问题|但|难以|不建议/.test(s.snippet)).length;
    const pos = stances.filter(s => /优势|可以|建议|可行|机会/.test(s.snippet)).length;
    if (neg && pos) disagreements.push({ topic, stances });
    else if (pos === stances.length) consensuses.push({ topic, stances });
  }
  const holes = valid.flatMap(o =>
    (o.text.match(/(风险|漏洞|问题|隐患|不足)[：:，,]?\s*([^\n。]{6,40})/g) ?? [])
      .slice(0, 3).map(m => ({ raised_by: o.model_id, point: m.trim() })));
  return { disagreements: disagreements.slice(0, 5), holes: holes.slice(0, 6), consensuses: consensuses.slice(0, 4) };
}
function snippetAround(text, keyword) {
  const i = text.indexOf(keyword);
  const s = Math.max(0, i - 30);
  return text.slice(s, i + 50).replace(/\s+/g, ' ');
}


// ========== src/scenes.js ==========
// M-B 场景层：把"通用头脑风暴"实例化为具体产品场景。
// 每个场景 = 一组角色视角（role prompt）+ 议题装配规则。走 M4 契约与既有账本，零协议改动。
// v1 场景：resume（简历会诊）。文件上传（pdf/docx 解析）在 M-B.2 接入；当前支持粘贴文本。
const SCENES = {
  resume: {
    id: 'resume',
    name: '简历会诊',
    tagline: '让 5 个视角挑出你简历的真问题',
    audience: '求职者',
    topic_template: (topic, resumeText, jd) =>
      `【目标岗位】${jd || '（未提供，按通用职场建议处理）'}\n\n【简历原文】\n${resumeText || topic}`,
    roles: [
      { key: 'hr',            name: '资深 HR',        focus: '10 秒筛选视角：这份简历在招聘系统/HR 快速浏览中会先看到什么、会不会被刷掉、格式与信息密度问题。' },
      { key: 'hiring',        name: '招聘经理',        focus: '业务负责人视角：这个岗位真正要解决什么问题，简历里的经历能否证明候选人能干这件事，缺哪些关键证据。' },
      { key: 'match',         name: '岗位匹配分析师',  focus: '逐条对照 JD 与简历：硬性条件匹配度、关键词缺失、可迁移能力被埋没的地方。' },
      { key: 'expression',    name: '表达优化专家',    focus: '表达视角：哪些描述是空话套话、哪些成果没有量化、怎么改写才让一句话同时传达动作-结果-影响。' },
      { key: 'devil',         name: '反方面试官',      focus: '挑刺视角：简历里每一条都可能被面试深挖，指出最容易被问倒的表述、逻辑矛盾与夸大嫌疑。' },
    ],
  },
};

function sceneRoles(sceneId) {
  const s = SCENES[sceneId];
  if (!s) throw Object.assign(new Error(`unknown scene ${sceneId}`), { code: 'UNKNOWN_SCENE' });
  return s;
}

// 把角色视角实例化为各模型的 prompt（角色 × 模型 分配在引擎装配时决定）
function rolePrompt(sceneId, roleKey, topic, extra = {}) {
  const scene = sceneRoles(sceneId);
  const role = scene.roles.find(r => r.key === roleKey);
  if (!role) throw Object.assign(new Error(`unknown role ${roleKey}`), { code: 'UNKNOWN_ROLE' });
  return `你是「${scene.name}」场景中的${role.name}。${role.focus}
议题与材料如下，请输出：
一、事实——你从材料中确认了什么（不推测）
二、判断——基于事实的专业意见（明确说这是判断）
三、建议——具体可执行的修改/行动，逐条列出
禁止武断定性；推测必须标注"推测"。`;
}


// ========== src/recon.js ==========
// M7：对账。operations 表是渠道真象的镜像。§5.5：
// 渠道有账本无 → missing_event（查证补事件）；账本有渠道无 → phantom（LEDGER_CORRECTION 对冲）；
// 金额不符 → amount_mismatch；未决超龄 → stale_pending（MANUAL_POOL 准入 §8.2）。





function reconcileOperations(store, { now = new Date() } = {}) {
  const issues = { missing_event: [], phantom: [], amount_mismatch: [], stale_pending: [] };
  const eventOps = new Map();   // operation_id → { order_id, amount_cents, types[] }
  for (const orderId of store.getAllOrderIds()) {
    for (const e of store.getOrder(orderId)) {
      const opId = e.data?.operation_id;
      if (!opId) continue;
      if (!['PAYMENT_SUCCEEDED', 'REFUND_EXECUTED', 'SURCHARGE_EXECUTED'].includes(e.type)) continue;
      const cur = eventOps.get(opId) ?? { order_id: orderId, amount_cents: 0, caused: [] };
      cur.amount_cents += e.amount_cents ?? 0;
      cur.caused.push(...(e.caused_by ?? []));
      eventOps.set(opId, cur);
    }
  }
  for (const op of store.getAllOperations()) {
    const ev = eventOps.get(op.operation_id);
    const ageMin = (now.getTime() - new Date(op.updated_at).getTime()) / 60_000;
    if (op.state === 'EXECUTED' && !ev)
      issues.missing_event.push({ operation_id: op.operation_id, order_id: op.order_id, type: op.type });
    if (op.state !== 'EXECUTED' && ['CREATED', 'EXECUTING', 'UNKNOWN'].includes(op.state) &&
        ageMin > SLA.PAYMENT_UNKNOWN_POOL_MINUTES)
      issues.stale_pending.push({ operation_id: op.operation_id, order_id: op.order_id, state: op.state, age_minutes: Math.round(ageMin) });
  }
  for (const [opId, ev] of eventOps) {
    const op = store.getOperation(opId);
    if (!op || op.state !== 'EXECUTED')
      issues.phantom.push({ operation_id: opId, order_id: ev.order_id });
  }
  // 金额核对：执行事件 vs 其引用的义务
  for (const orderId of store.getAllOrderIds()) {
    const h = store.getOrder(orderId);
    const dues = new Map(h.filter(e => ['REFUND_DUE', 'SURCHARGE_DUE', 'CREDIT_DUE'].includes(e.type)).map(e => [e.event_id, e]));
    for (const e of h) {
      if (!['REFUND_EXECUTED', 'SURCHARGE_EXECUTED'].includes(e.type)) continue;
      const expected = (e.caused_by ?? []).reduce((a, r) => a + (dues.get(r)?.amount_cents ?? 0), 0);
      if ((e.caused_by ?? []).length && e.amount_cents !== expected)
        issues.amount_mismatch.push({ order_id: orderId, seq: e.seq, expected, actual: e.amount_cents });
    }
  }
  return issues;
}

// §9.5 事件溯源重放校验：全库逐单重放投影 + 终态单 E1 + 全库 I7
function sweepInvariants(store) {
  const violations = [];
  for (const orderId of store.getAllOrderIds()) {
    const h = store.getOrder(orderId);
    try {
      const status = projectOrder(h);
      if (['DELIVERED', 'SETTLEMENT_PENDING', 'SETTLEMENT_FINALIZED'].includes(status)) {
        const d = E1(h).diff;
        if (d !== 0) violations.push({ order_id: orderId, kind: 'E1_IMBALANCE', diff: d });
      }
    } catch (e) { violations.push({ order_id: orderId, kind: 'REPLAY_ERROR', code: e.code ?? 'ERROR' }); }
  }
  try { assertI7(store.getAllEvents()); }
  catch (e) { violations.push({ order_id: null, kind: 'I7_VIOLATED', message: e.message }); }
  return { checked: store.getAllOrderIds().length, violations };
}


// ========== src/admin.js ==========
// M7：人工操作台。§8.1 铁律落点：人工只能做白名单动作，每个动作留 ADMIN_ACTION 审计；
// 人工在结构上不存在修改状态/金额/用户选择的接口——本文件就是全部人工能力的边界。








const audit = (store, orderId, data) =>
  appendGuarded(store, orderId, store.getOrder(orderId),
    [{ type: 'ADMIN_ACTION', decision_source: 'HUMAN_EXCEPTION', data }]);

// §8.2 出池动作②：卡死退款重试（复用义务，§5.4 本义；引擎语义与用户侧重试完全一致）
export async function retryStuckRefund(store, orderId, itemId, { channel, actor, ticket_ref }) {
  const r = await applyFullRefund(store, orderId, itemId, { channel, decision_source: 'USER_DECISION' });
  audit(store, orderId, { action: 'RETRY_STUCK_REFUND', actor, ticket_ref, item_id: itemId, result: r });
  return r;
}

// §8.2/§8.3：GOODWILL 发券。三限额同时校验；双审开关生效于此；超限仅 owner。
function issueGoodwill(store, orderId, { amount_cents, actor, ticket_ref, approver = null, owner = false }) {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0)
    throw new StoreError('INVALID_GOODWILL', '金额非法');
  if (RUNTIME_FLAGS.dual_review_enabled) {
    if (!approver) throw new StoreError('APPROVER_REQUIRED', '双人复核已开启，需要第二账号批准（§8.4）');
    if (approver === actor) throw new StoreError('APPROVER_EQUALS_ACTOR', '复核人不得与操作人相同（§8.4）');
  }
  const h = store.getOrder(orderId);
  const paid = h.filter(e => e.type === 'PAYMENT_SUCCEEDED').reduce((a, e) => a + (e.amount_cents ?? 0), 0);
  const overLimit = amount_cents > GOODWILL.MAX_SINGLE_CENTS ||
    (paid > 0 && amount_cents > paid * GOODWILL.MAX_RATIO_OF_PAID);
  if (overLimit && !owner) throw new StoreError('GOODWILL_LIMIT', '超单笔限额，仅 owner 可批（§8.3）');
  if (!overLimit) {
    const userId = h.find(e => e.type === 'QUOTE_CREATED')?.data?.user_id;
    const since = Date.now() - 30 * 86400_000;
    let sum = 0;
    for (const q of store.getEventsByType('QUOTE_CREATED')) {
      if (q.data?.user_id !== userId) continue;
      for (const p of store.getOrder(q.order_id))
        if (p.type === 'PAYMENT_SUCCEEDED' || p.type === 'VOUCHER_ISSUED' && p.data?.source === 'GOODWILL')
          if (p.type === 'VOUCHER_ISSUED' && p.data?.source === 'GOODWILL' && new Date(p.occurred_at).getTime() >= since)
            sum += p.data.face_value_cents ?? 0;
    }
    if (sum + amount_cents > GOODWILL.USER_30D_CAP_CENTS && !owner)
      throw new StoreError('GOODWILL_USER_CAP', '超用户 30 天累计限额（§8.3）');
  }
  const voucher_id = genVoucherId();
  appendGuarded(store, orderId, store.getOrder(orderId), [{
    type: 'VOUCHER_ISSUED', decision_source: 'HUMAN_EXCEPTION', amount_cents,
    data: { source: 'GOODWILL', voucher_id, face_value_cents: amount_cents,
            expires_at: new Date(Date.now() + VOUCHER_TTL_DAYS * 86400_000).toISOString(),
            actor, ticket_ref, approver, owner_override: overLimit },
  }]);
  audit(store, orderId, { action: 'ISSUE_GOODWILL', actor, ticket_ref, approver, amount_cents, voucher_id });
  return { voucher_id, amount_cents };
}

// §8.2 出池动作①：支付未决的人工确认（渠道侧查询已收敛后调用）
export async function resolveUnknownPayment(store, orderId, { channel, actor, ticket_ref }) {
  const pend = store.getOperationsByOrder(orderId)
    .filter(o => o.type === 'payment' && ['UNKNOWN', 'EXECUTING', 'CREATED'].includes(o.state));
  if (!pend.length) throw new StoreError('NO_PENDING_PAYMENT', orderId);
  const op = pend[pend.length - 1];
  const res = await channel.resolve(op.operation_id);
  if (res.state !== 'SUCCEEDED') {
    audit(store, orderId, { action: 'RESOLVE_UNKNOWN_NOOP', actor, ticket_ref, operation_id: op.operation_id });
    return { resolved: false };
  }
  store.markOperation(op.operation_id, 'EXECUTED', res.channel_ref);
  const h = store.getOrder(orderId);
  const q = h.find(e => e.type === 'QUOTE_CREATED');
  const items = q.data.items.map(it => ({ item_id: it.item_id, locked_price_cents: it.locked_price_cents }));
  const reserved = new Map();
  for (const r of h.filter(e => e.type === 'VOUCHER_RESERVED'))
    reserved.set(r.data.voucher_id, (reserved.get(r.data.voucher_id) ?? 0) + r.data.reserved_cents);
  const vouchers = [...reserved].map(([voucher_id, cents]) => ({ voucher_id, remaining_cents: cents }));
  const { funding } = allocateFunding(items, vouchers);
  const cashTotal = funding.reduce((a, f) => a + f.cash_cents, 0);
  const perVoucher = new Map();
  for (const f of funding) for (const a of f.allocations) {
    const cur = perVoucher.get(a.voucher_id) ?? { applied_cents: 0, allocations: [] };
    cur.applied_cents += a.applied_cents;
    cur.allocations.push({ item_id: f.item_id, applied_cents: a.applied_cents });
    perVoucher.set(a.voucher_id, cur);
  }
  appendGuarded(store, orderId, store.getOrder(orderId), [
    { type: 'PAYMENT_UNKNOWN_RESOLVED', amount_cents: cashTotal, data: { operation_id: op.operation_id, resolved_by: actor } },
    { type: 'PAYMENT_SUCCEEDED', amount_cents: cashTotal, data: { operation_id: op.operation_id, channel_ref: res.channel_ref } },
    { type: 'ORDER_CONFIRMED', data: { items: q.data.items.map(it => ({ ...it, funding_split: funding.find(f => f.item_id === it.item_id) })),
                                       total_cents: q.data.total_cents, cash_paid_cents: cashTotal } },
    ...[...perVoucher].map(([voucher_id, info]) => ({ type: 'VOUCHER_REDEEMED', data: { voucher_id, ...info } })),
  ]);
  audit(store, orderId, { action: 'RESOLVE_UNKNOWN_PAYMENT', actor, ticket_ref, operation_id: op.operation_id, cash_paid_cents: cashTotal });
  return { resolved: true, cash_paid_cents: cashTotal };
}

// §8.5 人工介入率与池清单
function poolReport(store, now = new Date()) {
  const issues = reconcileOperations(store, { now });
  const adminActions = store.getEventsByType('ADMIN_ACTION').length;
  const totalOrders = store.getAllOrderIds().filter(id => id !== 'ord_system').length;
  return { pool: issues.stale_pending, other_issues: issues, admin_actions: adminActions,
           intervention_rate: totalOrders ? adminActions / totalOrders : 0 };
}


// ========== src/jobs.js ==========
// M7→fix：自动化钟表。修复：扫描器必须 await 每个 async 执行器，
// 禁止"发射后不管"——未决的退款落账对账即成 phantom，对资金系统不可接受。







// §6.6 券过期
function expireVouchers(store, now = new Date()) {
  const vmap = projectVouchers(store.getAllEvents());
  const out = [];
  for (const v of vmap.values()) {
    if (v.remaining_cents <= 0) continue;
    if (!v.expires_at || new Date(v.expires_at) > now) continue;
    store.append('ord_system', [{
      type: 'VOUCHER_EXPIRED',
      data: { voucher_id: v.voucher_id, expired_cents: v.remaining_cents, expired_at: now.toISOString() },
    }]);
    out.push({ voucher_id: v.voucher_id, expired_cents: v.remaining_cents });
  }
  return out;
}

// T10：24h 未决策 → 自动退款
export async function scanDecisionTimeouts(store, channel, now = new Date()) {
  const fired = [];
  for (const req of store.getEventsByType('DECISION_REQUESTED')) {
    const orderId = req.order_id, itemId = req.item_id;
    const exp = req.data?.payload?.expires_at;
    if (!exp || new Date(exp) > now) continue;
    const h = store.getOrder(orderId);
    const later = h.filter(e => e.item_id === itemId && e.seq > req.seq &&
      ['DECISION_RECEIVED', 'DECISION_TIMEOUT'].includes(e.type));
    if (later.length) continue;
    await executeTimeout(store, orderId, itemId, channel);
    fired.push({ order_id: orderId, item_id: itemId });
  }
  return fired;
}

// T12→T10：补差窗口过期 → 后继作废 + 前驱自动退款
export async function scanSurchargeWindows(store, channel, now = new Date()) {
  const fired = [];
  for (const due of store.getEventsByType('SURCHARGE_DUE')) {
    const orderId = due.order_id;
    const succ = due.data?.successor_item_id;
    const deadline = new Date(due.occurred_at).getTime() + SLA.SURCHARGE_WINDOW_MINUTES * 60_000;
    if (now.getTime() < deadline) continue;
    const h = store.getOrder(orderId);
    if (h.some(e => (e.type === 'SURCHARGE_EXECUTED' && (e.caused_by ?? []).includes(due.event_id)) ||
                    (e.type === 'SURCHARGE_EXPIRED' && e.item_id === succ))) continue;
    appendGuarded(store, orderId, h, [{ type: 'SURCHARGE_EXPIRED', item_id: succ }]);
    await applyFullRefund(store, orderId, due.item_id, { channel, decision_source: 'TIMEOUT_RULE' });
    fired.push({ order_id: orderId, successor_item_id: succ, refunded_item_id: due.item_id });
  }
  return fired;
}

// §7.3：预演 72h 无异议 → 自动 FINALIZED（I3 不满足则本周期跳过）
export async function scanSettlements(store, now = new Date()) {
  const finalized = [], skipped = [];
  const previews = store.getEventsByType('SETTLEMENT_PREVIEWED');
  const latestByOrder = new Map();
  for (const e of previews) latestByOrder.set(e.order_id, e);
  for (const [orderId, pv] of latestByOrder) {
    const h = store.getOrder(orderId);
    if (h.some(e => e.type === 'SETTLEMENT_FINALIZED')) continue;
    if (new Date(pv.occurred_at).getTime() + SLA.OBJECTION_PERIOD_HOURS * 3600_000 > now.getTime()) continue;
    try {
      finalizeSettlement(store, orderId, { now });
      finalized.push({ order_id: orderId });
    } catch (err) { skipped.push({ order_id: orderId, code: err.code ?? 'ERROR' }); }
  }
  return { finalized, skipped };
}

export async function runCycle(store, channel, now = new Date()) {
  const out = { decision_timeouts: [], surcharge_expiries: [], auto_finalized: [], vouchers_expired: [], errors: [] };
  const step = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (e) { out.errors.push({ task: name, code: e.code ?? 'ERROR', message: e.message }); }
  };
  await step('decision_timeouts',  () => scanDecisionTimeouts(store, channel, now));
  await step('surcharge_expiries', () => scanSurchargeWindows(store, channel, now));
  await step('auto_finalized_scan',() => scanSettlements(store, now));
  out.auto_finalized = out.auto_finalized_scan?.finalized ?? [];
  if (out.auto_finalized_scan?.skipped?.length)
    out.errors.push(...out.auto_finalized_scan.skipped.map(s => ({ task: 'finalize', ...s })));
  await step('vouchers_expired',   () => expireVouchers(store, now));
  return out;
}
export { WORKER_INTERVAL_SECONDS };


// ========== src/adapters-real.js ==========
// M-B v4：真实模型适配器。
// 模型路由：注册表（registry）优先 → 旧静态 MODEL_MAP fallback（兼容存量）。
// 凭证：ARENA_ENV_FILE（默认 ~/.arena_env）→ process.env；测试用 opts.env 注入隔离。
// 提供商：ark（火山接入点）/ zhipu / dashscope / tokenhub + 任意 OpenAI 兼容（注册表 base_url）。



function loadEnv() {
  const p = process.env.ARENA_ENV_FILE || join(process.env.HOME ?? '/home/ubuntu', '.arena_env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

const LEGACY_MAP = {
  'qwen-max':   { provider: 'dashscope', model: 'qwen-max',
                  base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
  'glm-4-plus': { provider: 'zhipu',     model: 'glm-4-plus',
                  base_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  'doubao-pro': { provider: 'ark',       model: () => process.env.ARK_ENDPOINT,
                  base_url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
  'kimi-k3':    { provider: 'tokenhub',  model: 'kimi-k3',
                  base_url: 'https://tokenhub.tencentmaas.com/v1/chat/completions' },
  'minimax-m3': { provider: 'tokenhub',  model: 'minimax-m3',
                  base_url: 'https://tokenhub.tencentmaas.com/v1/chat/completions' },
};

class RealAdapter {
  constructor(opts = {}) {
    if (opts.env) { Object.assign(process.env, opts.env); } else { loadEnv(); }
    this.registry = opts.registry ?? null;   // M-B：注册表优先
    this.resultsDir = opts.resultsDir ?? 'results';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.log = opts.log ?? (() => {});
  }
  #get(name) {
    if (this.envOverride) {
      const v = this.envOverride[name];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    }
    return process.env[name];
  }
  #ready(provider) {
    if (provider === 'ark') return !!(this.#get('ARK_API_KEY') && this.#get('ARK_ENDPOINT'));
    if (provider === 'tokenhub') return !!this.#get('TOKENHUB_API_KEY');
    if (provider === 'zhipu') return !!this.#get('ZHIPU_API_KEY');
    if (provider === 'dashscope') return !!this.#get('DASHSCOPE_API_KEY');
    if (provider === 'registry_openai') return !!this.#get('TOKENHUB_API_KEY'); // 注册表 OpenAI 兼容：沿用 tokenhub Key 池（可扩展按域名映射）
    return false;
  }
  #fail(reason_code, raw) { return { ok: false, reason_code, raw }; }

  #resolve(model_id) {
    const reg = this.registry?.getModel?.(model_id);
    if (reg) {
      if (reg.provider === 'ark')
        return { provider: 'ark', base_url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: reg.endpoint };
      return { provider: 'registry_openai', base_url: reg.endpoint, model: reg.model_tag };
    }
    const legacy = LEGACY_MAP[model_id];
    return legacy ? { ...legacy, model: typeof legacy.model === 'function' ? legacy.model() : legacy.model } : null;
  }

  async run(model_id, input = {}) {
    const conf = this.#resolve(model_id);
    if (!conf) return this.#fail('MODEL_RESPONSE_INVALID', { error: `未映射的模型 ${model_id}` });
    if (!this.#ready(conf.provider))
      return this.#fail('MODEL_AUTH_FAILURE', { error: `${conf.provider} 凭证未配置（~/.arena_env）` });
    if (!conf.model) return this.#fail('MODEL_AUTH_FAILURE', { error: '接入点/模型标识缺失' });

    const bodyObj = {
      model: conf.model,
      messages: [
        { role: 'system', content: input.system ?? '你是多模型头脑风暴团队的成员之一，请就用户议题给出你的独立专业意见。' },
        { role: 'user', content: input.prompt ?? '请就当前议题给出你的专业意见。' },
      ],
    };
    if (conf.provider !== 'tokenhub' && conf.provider !== 'registry_openai') bodyObj.temperature = 0.7;
    const body = JSON.stringify(bodyObj);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res; const t0 = Date.now();
    try {
      res = await fetch(conf.base_url, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#get(conf.provider === 'ark' ? 'ARK_API_KEY' : conf.provider === 'tokenhub' ? 'TOKENHUB_API_KEY' : conf.provider === 'zhipu' ? 'ZHIPU_API_KEY' : 'DASHSCOPE_API_KEY')}` },
        body, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') return this.#fail('MODEL_TIMEOUT', { elapsed_ms: Date.now() - t0 });
      return this.#fail('MODEL_UNAVAILABLE', { error: String(e?.message ?? e) });
    }
    clearTimeout(timer);

    if (res.status === 429) return this.#fail('MODEL_RATE_LIMITED', { status: 429 });
    if (res.status === 401 || res.status === 403) return this.#fail('MODEL_AUTH_FAILURE', { status: res.status });
    if (!res.ok) return this.#fail('MODEL_UNAVAILABLE', { status: res.status, body: (await res.text().catch(() => '')).slice(0, 300) });

    let data;
    try { data = await res.json(); } catch { return this.#fail('MODEL_RESPONSE_INVALID', { error: '响应非 JSON' }); }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length < 10)
      return this.#fail('MODEL_RESPONSE_INVALID', { error: '响应缺少内容', body: JSON.stringify(data).slice(0, 300) });

    mkdirSync(this.resultsDir, { recursive: true });
    const ref = `real-${model_id}-${Date.now()}.md`;
    writeFileSync(join(this.resultsDir, ref), `# ${model_id} 的意见\n\n${text}\n`);
    this.log(JSON.stringify({ at: new Date().toISOString(), msg: 'real model ok', model_id, ms: Date.now() - t0 }));
    return { ok: true, result_ref: ref };
  }
}


// ========== server.js ==========
// v3 HTTP 网关。装配各引擎模块；网关零业务判断。



















const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

export async function startServer({ port = 3100, dbPath = 'db/arena.db', simulateFail = [], log = (...a) => console.log(...a) } = {}) {
  const store = new EventStore(dbPath);
  const channel = new SandboxChannel();
  const auth = new Auth(store);
  const growth = new Growth(store);
  const registry = new Registry(store);

  const realAdapter = new RealAdapter({ log, registry });
  const adapter = process.env.ARENA_ADAPTER === 'real' ? realAdapter : {
    async run(model_id, input = {}) {
      if (simulateFail.includes(model_id))
        return { ok: false, reason_code: 'MODEL_AUTH_FAILURE', raw: { simulated: true } };
      const text = '【沙箱演示意见】针对该议题：从市场与执行双角度看，机会存在但窗口有限，建议先以最小成本验证核心假设；主要风险在于投入节奏与团队能力匹配，若确认可行，可小步快跑。';
      mkdirSync('results', { recursive: true });
      const ref = `sim-${model_id}-${Date.now()}.md`;
      writeFileSync(join('results', ref), `# ${model_id} 的意见\n\n${text}\n`);
      return { ok: true, result_ref: ref };
    },
  };

  const modelFor = (h, itemId) => {
    const oc = h.find(e => e.type === 'ORDER_CONFIRMED');
    const rec = (oc?.data.items ?? []).find(x => x.item_id === itemId);
    if (rec) return rec.model_id;
    const dr = [...h].reverse().find(e => e.type === 'DECISION_RECEIVED' && e.data?.successor_item_id === itemId);
    return dr?.data?.successor_model_id ?? null;
  };
  const resultFor = (h, itemId) =>
    [...h].reverse().find(e => e.type === 'ITEM_COMPLETED' && e.item_id === itemId)?.data?.result_ref ?? null;

  function maybePreview(orderId) {
    const h = store.getOrder(orderId);
    if (h.some(e => e.type === 'SETTLEMENT_PREVIEWED')) return;
    const items = projectItems(h);
    const allTerminal = items.size > 0 && [...items.values()].every(i => ITEM_TERMINAL.has(i.state));
    const openDec = [...items.values()].some(i => i.pending_decision);
    if (allTerminal && !openDec) previewSettlement(store, orderId);
  }

  const topicsByOrder = {};

  function buildPrompt(topic) {
    if (!topic) return undefined;
    return [
      '你是一名受邀参加「多 AI 头脑风暴」的独立顾问。用户会将一个具体难题交给多位互不知情的 AI 分别作答，平台随后汇总各 AI 的意见并标注分歧点、被挑出的漏洞与意外共识。',
      '',
      `本次议题：${topic}`,
      '',
      '作答要求：',
      '1. 直接作答，不要索要更多信息——缺什么就基于合理假设作答，并明确标注「假设：…」。',
      '2. 按以下结构输出：',
      '   【核心判断】2-3 句，旗帜鲜明（可行/不可行/有条件可行）',
      '   【关键依据】3-5 条，每条一行，给出理由或数据',
      '   【主要风险】2-3 条，每条附带你估计的严重程度（高/中/低）',
      '   【行动建议】3-5 条可立即执行的步骤',
      '   【我可能与他人不同的观点】1-2 条你认为其他顾问容易忽略或反对的角度',
      '3. 观点要鲜明。本产品的价值在于 AI 之间的真实分歧——请不要说"取决于具体情况"这类骑墙话；有倾向就亮出倾向。',
      '4. 事实与推测分开：数据没有把握时标注「推测」。',
    ].join('\n');
  }

  async function driveOrder(orderId, topic = '') {
    if (topic) topicsByOrder[orderId] = topic;
    const prompt = buildPrompt(topicsByOrder[orderId]);
    for (const it of projectItems(store.getOrder(orderId)).values())
      if (it.state === 'QUOTED' || it.state === 'LOCKED')
        await fulfillItem(store, orderId, it.item_id, modelFor(store.getOrder(orderId), it.item_id), adapter, { input: { prompt } });
    const h = store.getOrder(orderId);
    for (const it of projectItems(h).values())
      if (it.state === 'FAILED_FINAL' && !it.pending_decision && !it.resolved_choice)
        openDecision(store, orderId, it.item_id);
    maybePreview(orderId);
  }

  function orderView(orderId) {
    const h = store.getOrder(orderId);
    if (!h.length) return null;
    const items = projectItems(h);
    const oc = h.find(e => e.type === 'ORDER_CONFIRMED');
    const itemViews = [...items.values()].map(it => {
      const rec = (oc?.data.items ?? []).find(x => x.item_id === it.item_id);
      const dr = [...h].reverse().find(e => e.type === 'DECISION_RECEIVED' && e.data?.successor_item_id === it.item_id);
      return {
        item_id: it.item_id,
        model_id: rec?.model_id ?? dr?.data?.successor_model_id ?? null,
        state: it.state,
        locked_price_cents: rec?.locked_price_cents ?? null,
        result_ref: resultFor(h, it.item_id),
      };
    });
    const pend = [...items.values()].find(i => i.pending_decision);
    const decision = pend
      ? [...h].reverse().find(e => e.type === 'DECISION_REQUESTED' && e.item_id === pend.item_id)?.data?.payload ?? null
      : null;
    const pv = [...h].reverse().find(e => e.type === 'SETTLEMENT_PREVIEWED');
    const collision = buildCollisionReport(itemViews.filter(i => i.result_ref).map(i => {
      const isReal = i.result_ref && !i.result_ref.startsWith('sim:');
      const rp = join(process.cwd(), 'results', i.result_ref ?? '');
      let text = '';
      try { text = isReal && existsSync(rp) ? readFileSync(rp, 'utf8') : (i.result_ref?.startsWith('sim:') ? '【沙箱演示意见】该议题存在市场机会但执行风险较高，建议小步验证；定价不宜过高，团队与节奏是关键变量。' : ''); } catch {}
      return { model_id: i.model_id, text };
    }));
    return {
      order_id: orderId,
      status: projectOrder(h),
      items: itemViews,
      decision,
      settlement: pv?.data.preview ?? null,
      collision,
    };
  }

  function sessionUser(req) {
    const m = (req.headers.cookie ?? '').match(/(?:^|;\s*)arena_session=([a-f0-9]+)/);
    return m ? auth.verify(m[1]) : null;
  }

  const readBody = req => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { log('READBODY RAW:', JSON.stringify(s.slice(0, 300))); reject(new StoreError('BAD_JSON', 'invalid JSON: ' + s.slice(0, 80))); }
    });
    req.on('error', reject);
  });

  async function api(req, res, url) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const body = await readBody(req);
      let m;
      if (req.method === 'GET' && url.pathname === '/api/health')
        return send(200, { ok: true, orders: store.getAllOrderIds().filter(x => x !== 'ord_system').length });
      if (req.method === 'GET' && url.pathname === '/api/models')
        return send(200, { price_table_version: PRICE_TABLE_VERSION, models: PRICE_TABLES[PRICE_TABLE_VERSION].models });

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const day = new Date().toISOString().slice(0, 10);
        let inviteCode = null;
        if (growth.get('BETA_MODE') === 'true') {
          const pre = growth.consumeInvite(body.invite_code, 'pending', day);
          if (!pre.ok) return send(400, { error: 'INVITE_INVALID', message: pre.reason });
          inviteCode = body.invite_code;
        }
        const u = auth.register(body.email, body.password);
        if (inviteCode) {
          growth.db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND day = ?')
            .run(u.user_id, new Date().toISOString(), inviteCode, day);
        } else {
          growth.grantTrials(u.user_id);
        }
        const ses = auth.login(body.email, body.password);
        res.setHeader('Set-Cookie', `arena_session=${ses.token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
        return send(200, { user: u, trials: growth.trialsLeft(u.user_id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const ses = auth.login(body.email, body.password);
        const u = auth.verify(ses.token);
        res.setHeader('Set-Cookie', `arena_session=${ses.token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
        return send(200, { user: u, trials: growth.trialsLeft(u.user_id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const cm = (req.headers.cookie ?? '').match(/arena_session=([a-f0-9]+)/);
        if (cm) auth.logout(cm[1]);
        res.setHeader('Set-Cookie', 'arena_session=; HttpOnly; Path=/; Max-Age=0');
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const u = sessionUser(req);
        return send(200, { user: u, trials: u ? growth.trialsLeft(u.user_id) : null, beta_mode: growth.get('BETA_MODE') });
      }
      if (req.method === 'GET' && url.pathname === '/api/my/orders') {
        const u = sessionUser(req);
        if (!u) return send(401, { error: 'LOGIN_REQUIRED' });
        const orders = store.getEventsByType('QUOTE_CREATED')
          .filter(e => e.data?.user_id === u.user_id)
          .map(e => ({ order_id: e.order_id, created_at: e.occurred_at,
                       total_cents: e.data.total_cents, status: projectOrder(store.getOrder(e.order_id)) }))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return send(200, { orders });
      }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const u = sessionUser(req);
        const ok = growth.addFeedback(u?.user_id ?? null, body.order_id ?? null, body.tag, body.note);
        return ok ? send(200, { ok: true }) : send(400, { error: 'INVALID_TAG' });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/growth') {
        const u = sessionUser(req);
        const isLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
        if (!u && !isLocal) return send(401, { error: 'LOGIN_REQUIRED' });
        const day = new Date().toISOString().slice(0, 10);
        return send(200, {
          beta_mode: growth.get('BETA_MODE'),
          today_code: growth.todayCode(day),
          invites_used: store.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE day = ? AND used_by IS NOT NULL").get(day).n,
          feedback_stats: growth.feedbackStats(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/models') {
        const u = sessionUser(req);
        const isLocal = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (!u && !isLocal) return send(401, { error: 'LOGIN_REQUIRED' });
        return send(200, { models: registry.listModels(false) });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/models') {
        const u = sessionUser(req);
        const isLocal = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (!u && !isLocal) return send(401, { error: 'LOGIN_REQUIRED' });
        try {
          const saved = registry.upsertModel({ id: body.id, display_name: body.display_name,
            provider: body.provider, endpoint: body.endpoint ?? null, model_tag: body.model_tag ?? null,
            price_cents: body.price_cents ?? 800, enabled: body.enabled ?? true });
          return send(200, { ok: true, model: saved });
        } catch (e) { return send(400, { error: 'MODEL_INVALID', message: e.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/beta-mode') {
        const u = sessionUser(req);
        if (!u) return send(401, { error: 'LOGIN_REQUIRED' });
        growth.set('BETA_MODE', body.enabled ? 'true' : 'false');
        return send(200, { ok: true, beta_mode: growth.get('BETA_MODE') });
      }

      if (req.method === 'POST' && url.pathname === '/api/quote') {
        const qUser = sessionUser(req);
        const REQUIRE_AUTH = process.env.ARENA_REQUIRE_AUTH === '1';
        if (!qUser && REQUIRE_AUTH)
          return send(401, { error: 'LOGIN_REQUIRED', message: '登录后发起头脑风暴' });
        if (qUser) {
          const t = growth.trialsLeft(qUser.user_id);
          if (t.left <= 0 && process.env.ARENA_ADAPTER === 'real')
            return send(402, { error: 'TRIALS_EXHAUSTED', message: '免费体验已用完（3/3），继续召唤众智请付费', left: 0 });
        }
        const anonSeq = (sessionUser.anonSeq = (sessionUser.anonSeq ?? 0) + 1);
        const q = createQuote(store, { user_id: qUser?.user_id ?? ('anon-' + anonSeq),
          model_ids: body.model_ids, bundle_total_cents: body.bundle_total_cents ?? null });
        return send(200, q);
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)$/)) && req.method === 'GET') {
        const v = orderView(m[1]);
        return v ? send(200, v) : send(404, { error: 'NOT_FOUND' });
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)\/pay$/)) && req.method === 'POST') {
        const r = await confirmPayment(store, m[1], { channel });
        if (body.topic) topicsByOrder[m[1]] = body.topic;
        setImmediate(() => driveOrder(m[1], topicsByOrder[m[1]] ?? '').catch(e => log('drive error:', e.message)));
        return send(200, { ...r, async: true });
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)\/run$/)) && req.method === 'POST') {
        if (body.topic) topicsByOrder[m[1]] = body.topic;
        driveOrder(m[1], body.topic ?? '').catch(e => log('drive error:', e.message));
        return send(200, orderView(m[1]));
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)\/items\/(itm_\w+)\/decision$/)) && req.method === 'POST') {
        const [, orderId, itemId] = m;
        const { choice, model_id } = body;
        if (choice === 'REFUND') await executeRefundChoice(store, orderId, itemId, channel);
        else if (choice === 'VOUCHER') executeVoucherChoice(store, orderId, itemId);
        else if (choice === 'REPLACE') {
          if (!model_id) return send(400, { error: 'MODEL_REQUIRED' });
          const r = await executeReplaceChoice(store, orderId, itemId, model_id, channel);
          const sprompt = buildPrompt(topicsByOrder[orderId]);
          await fulfillItem(store, orderId, r.successor_item_id, model_id, adapter, { input: { prompt: sprompt } });
          const succ = projectItems(store.getOrder(orderId)).get(r.successor_item_id);
          if (succ.state === 'FAILED_FINAL') openDecision(store, orderId, succ.item_id);
        } else return send(400, { error: 'INVALID_CHOICE' });
        maybePreview(orderId);
        return send(200, orderView(orderId));
      }
      return send(404, { error: 'NOT_FOUND' });
    } catch (e) {
      if (e instanceof StoreError) return send(400, { error: e.code, message: e.message });
      log('API error:', e);
      return send(500, { error: 'INTERNAL', message: String(e?.message ?? e) });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    if (url.pathname.startsWith('/results/')) {
      const rp = join(process.cwd(), 'results', url.pathname.slice('/results/'.length));
      if (existsSync(rp) && rp.startsWith(join(process.cwd(), 'results'))) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(readFileSync(rp));
      }
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = join(PUBLIC_DIR, p);
    if (!p.startsWith(PUBLIC_DIR) || !existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise(r => server.listen(port, r));
  return { server, store, close: async () => {
    server.closeAllConnections?.();
    await new Promise(r => server.close(() => { store.close(); r(); }));
  } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.ARENA_PORT ?? 3100);
  const simulateFail = (process.env.ARENA_SIMULATE_FAIL ?? '').split(',').map(s => s.trim()).filter(Boolean);
  startServer({ port, dbPath: process.env.ARENA_DB ?? 'db/arena.db', simulateFail });
  console.log(JSON.stringify({ msg: 'arena server started', port, adapter: process.env.ARENA_ADAPTER ?? 'sandbox', simulate_fail: simulateFail }));
}
