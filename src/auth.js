// M10：最小身份（§9.2 access.js 重写第一步）。用户/会话是平台数据，非订单事件，独立于事件账本。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { StoreError } from './store.js';

export class Auth {
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
