// M11：增长机制——邀请码（内测期）、免费体验次数、运行时开关、反馈标签。
import { randomBytes } from 'node:crypto';

export class Growth {
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
