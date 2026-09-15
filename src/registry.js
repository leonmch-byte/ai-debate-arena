// M-B：模型注册表 + 场景库 + 角色池（全部数据库化，后台可管理，加模型不再改代码）。
// 设计：模型与角色解耦——用户选角色，引擎从启用模型池随机分配。

export class Registry {
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
      INSERT OR IGNORE INTO models (id,display_name,provider,endpoint,model_tag,price_cents,enabled,created_at) VALUES
        ('doubao-pro','豆包 · Doubao（火山）','ark',NULL,NULL,800,1,datetime('now')),
        ('kimi-k3','Kimi K3（TokenHub）','openai_compatible','https://tokenhub.tencentmaas.com/v1/chat/completions','kimi-k3',800,1,datetime('now')),
        ('deepseek-v41','DeepSeek（TokenHub）','openai_compatible','https://tokenhub.tencentmaas.com/v1/chat/completions','deepseek-v4.1-flash',600,0,datetime('now')),
        ('minimax-m3','MiniMax-M3（TokenHub）','openai_compatible','https://tokenhub.tencentmaas.com/v1/chat/completions','minimax-m3',1000,1,datetime('now'));
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
