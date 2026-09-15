// v3 HTTP 网关。装配各引擎模块；网关零业务判断。
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventStore, StoreError } from './src/store.js';
import { SandboxChannel } from './src/payments.js';
import { createQuote } from './src/pricing.js';
import { confirmPayment } from './src/checkout.js';
import { fulfillItem } from './src/fulfillment.js';
import { projectItems, projectOrder, ITEM_TERMINAL } from './src/orders.js';
import { openDecision, executeRefundChoice, executeVoucherChoice, executeReplaceChoice } from './src/decisions.js';
import { previewSettlement } from './src/settlement.js';
import { PRICE_TABLES, PRICE_TABLE_VERSION } from './src/config.js';
import { buildCollisionReport } from './src/collision.js';
import { RealAdapter } from './src/adapters-real.js';
import { Auth } from './src/auth.js';
import { Registry } from './src/registry.js';
import { Growth } from './src/growth.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

export async function startServer({ port = 3100, dbPath = 'db/arena.db', simulateFail = [], betaMode = null, log = (...a) => console.log(...a) } = {}) {
  const store = new EventStore(dbPath);
  const channel = new SandboxChannel();
  const auth = new Auth(store);
  const growth = new Growth(store);
  if (opts.betaMode) growth.set('BETA_MODE', opts.betaMode);
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
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const cat = { ...PRICE_TABLES[PRICE_TABLE_VERSION].models };
        for (const m of registry.listModels(true)) if (!(m.id in cat)) cat[m.id] = m.price_cents;
        return send(200, { price_table_version: PRICE_TABLE_VERSION, models: cat });
      }

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
