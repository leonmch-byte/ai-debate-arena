// M8：HTTP 网关 + 模块装配（§9.2）。网关零业务判断；状态推导、守卫、金额全部在引擎层。
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventStore, StoreError } from './src/store.js';
import { SandboxChannel } from './src/payments.js';
import { createQuote } from './src/pricing.js';
import { confirmPayment } from './src/checkout.js';
import { fulfillItem } from './src/fulfillment.js';
import { projectItems, projectOrder, ITEM_TERMINAL } from './src/orders.js';
import { openDecision, executeRefundChoice, executeVoucherChoice, executeReplaceChoice } from './src/decisions.js';
import { previewSettlement } from './src/settlement.js';
import { PRICE_TABLES, PRICE_TABLE_VERSION } from './src/config.js';
import { RealAdapter } from './src/adapters-real.js';
import { Auth } from './src/auth.js';
import { buildCollisionReport } from './src/collision.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function startServer({ port = 3100, dbPath = 'db/arena.db', simulateFail = [], log = (...a) => console.log(...a) } = {}) {
  const store = new EventStore(dbPath);
  const auth = new Auth(store);
  const channel = new SandboxChannel();
  // 模拟适配器（M9 换真实 providers.js，M4 已定接口契约）：
  // simulateFail 中的模型按 B 类永久失败（不进恢复环，直达决策弹窗，演示路径最短）
  const realAdapter = new RealAdapter({ log });
  const adapter = process.env.ARENA_ADAPTER === 'real' ? realAdapter : {
    async run(model_id) {
      if (simulateFail.includes(model_id))
        return { ok: false, reason_code: 'MODEL_AUTH_FAILURE', raw: { simulated: true } };
      return { ok: true, result_ref: `sim:${model_id}:${Date.now()}` };
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

  // §4.3 流水线自动化：驱动全部可跑项 → 为 FAILED_FINAL 自动开决策 → 终态自动预演
  async function driveOrder(orderId, topic = '') {
    if (topic) lastTopic = topic;
    for (const it of projectItems(store.getOrder(orderId)).values())
      if (it.state === 'QUOTED' || it.state === 'LOCKED')
        await fulfillItem(store, orderId, it.item_id, modelFor(store.getOrder(orderId), it.item_id), adapter);
    const h = store.getOrder(orderId);
    for (const it of projectItems(h).values())
      if (it.state === 'FAILED_FINAL' && !it.pending_decision && !it.resolved_choice)
        openDecision(store, orderId, it.item_id);
    maybePreview(orderId);
  }

  let lastTopic = '';

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
      : null;                                        // §4.4 契约原文，前端只渲染
    const pv = [...h].reverse().find(e => e.type === 'SETTLEMENT_PREVIEWED');
    const collision = buildCollisionReport(itemViews.filter(i => i.result_ref).map(i => ({
      model_id: i.model_id,
      text: (() => { const rp = join(process.cwd(), 'results', i.result_ref.replace(/^sim:/, '')); try { return existsSync(rp) ? readFileSync(rp, 'utf8') : (i.result_ref.startsWith('sim:') ? SIM_TEXT[i.model_id] ?? '' : ''); } catch { return ''; } })(),
    })));
    return {
      order_id: orderId,
      status: projectOrder(h),
      items: itemViews,
      decision,
      settlement: pv?.data.preview ?? null,
      collision,                                     // 碰撞报告（分歧/漏洞/共识）
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
      try { resolve(JSON.parse(s)); } catch { reject(new StoreError('BAD_JSON', 'invalid JSON')); }
    });
    req.on('error', reject);
  });

  async function api(req, res, url) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const body = await readBody(req);

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const u = auth.register(body.email, body.password);
        const ses = auth.login(body.email, body.password);
        res.setHeader('Set-Cookie', `arena_session=${ses.token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
        return send(200, { user: u });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const ses = auth.login(body.email, body.password);
        const u = auth.verify(ses.token);
        res.setHeader('Set-Cookie', `arena_session=${ses.token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
        return send(200, { user: u });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const m = (req.headers.cookie ?? '').match(/arena_session=([a-f0-9]+)/);
        if (m) auth.logout(m[1]);
        res.setHeader('Set-Cookie', 'arena_session=; HttpOnly; Path=/; Max-Age=0');
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me')
        return send(200, { user: sessionUser(req) });
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
      let m;
      if (req.method === 'GET' && url.pathname === '/api/health')
        return send(200, { ok: true, orders: store.getAllOrderIds().filter(x => x !== 'ord_system').length });
      if (req.method === 'GET' && url.pathname === '/api/models')
        return send(200, { price_table_version: PRICE_TABLE_VERSION, models: PRICE_TABLES[PRICE_TABLE_VERSION].models });
      if (req.method === 'POST' && url.pathname === '/api/quote') {
        const qUser = sessionUser(req);
        const REQUIRE_AUTH = process.env.ARENA_REQUIRE_AUTH === '1';
        if (!qUser && REQUIRE_AUTH)
          return send(401, { error: 'LOGIN_REQUIRED', message: '登录后发起头脑风暴' });
        const q = createQuote(store, { user_id: qUser?.user_id ?? 'anon-' + (sessionUser.anonSeq = (sessionUser.anonSeq ?? 0) + 1),
          model_ids: body.model_ids, bundle_total_cents: body.bundle_total_cents ?? null });
        return send(200, q);
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)$/)) && req.method === 'GET') {
        const v = orderView(m[1]);
        return v ? send(200, v) : send(404, { error: 'NOT_FOUND' });
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)\/pay$/)) && req.method === 'POST') {
        const r = await confirmPayment(store, m[1], { channel });
        return send(200, r);
      }
      if ((m = url.pathname.match(/^\/api\/orders\/(ord_\w+)\/run$/)) && req.method === 'POST') {
        const topic = body.topic ?? '';
        await driveOrder(m[1], topic);
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
          await fulfillItem(store, orderId, r.successor_item_id, model_id, adapter);
          const succ = projectItems(store.getOrder(orderId)).get(r.successor_item_id);
          if (succ.state === 'FAILED_FINAL') openDecision(store, orderId, succ.item_id);  // 后继又失败 → 再开决策
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

  const SIM_TEXT = {
    default: '【沙箱演示意见】本 AI 认为该议题值得关注：从市场角度看存在机会窗口，建议尽快验证需求真实性；主要风险在于执行成本与时机选择，若团队能力匹配，可以小步快跑验证。'
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    if (url.pathname.startsWith('/results/')) {
      const rp = join(process.cwd(), 'results', url.pathname.slice('/results/'.length));
      if (existsSync(rp) && rp.startsWith(join(process.cwd(), 'results'))) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(readFileSync(rp));
      }
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = join(PUBLIC_DIR, p);
    if (!p.startsWith(PUBLIC_DIR) || !existsSync(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise(r => server.listen(port, r));
  return { server, store, close: async () => { server.closeAllConnections?.(); await new Promise(r => server.close(() => { store.close(); r(); })); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.ARENA_PORT ?? 3100);
  const simulateFail = (process.env.ARENA_SIMULATE_FAIL ?? '').split(',').map(s => s.trim()).filter(Boolean);
  startServer({ port, dbPath: process.env.ARENA_DB ?? 'db/arena.db', simulateFail });
  console.log(JSON.stringify({ msg: 'arena server started', port, simulate_fail: simulateFail }));
}
