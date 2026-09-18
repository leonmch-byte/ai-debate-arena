// M-B.5：场景推演引擎（背锅场景 MVP）。
// 状态层：每个角色 {goal, attitude_to_user, knows, suspects, last_action} 随剧情演化。
// 事件：SCENE_SESSION(开局含初始状态) / SCENE_TURN(含 state_delta) / SCENE_ENDED。
import { readFileSync } from 'node:fs';
import { BLAME_SCENARIO, parseStateDelta, stripDelta } from './scene-state.js';

export class ScenarioEngine {
  constructor(store, adapter, log = () => {}) {
    this.store = store;
    this.adapter = adapter;
    this.log = log;
  }
  def(id) { return id === 'blame' ? BLAME_SCENARIO : null; }
  actorOf(def, key) { return def.actors.find(a => a.key === key) ?? null; }

  // 开局：创建会话 + 领导开场（含初始状态）
  start(userId, { problem, days } = {}) {
    const def = this.def('blame');
    const orderId = 'ord_scn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const problemText = problem || '项目上线后出现了质量问题';
    const daysText = days || '3';
    this.store.append(orderId, [{ type: 'SCENE_SESSION',
      data: { scenario_id: def.id, user_id: userId,
        actors: Object.fromEntries(def.actors.map(a => [a.key, { ...a.initial }])),
        problem: problemText, days: daysText, round: 0 } }]);
    return { order_id: orderId, def };
  }
  // 领导开场白（走真模型）
  async opening(orderId) {
    const h = this.store.getOrder(orderId);
    const d = h.find(e => e.type === 'SCENE_SESSION').data;
    const boss = this.actorOf(this.def(d.scenario_id), 'boss');
    const prompt = [boss.card.replace('红线：', `当前局势：${d.problem}。复盘会还剩${d.days}天。各方开始动作。你的已知：${d.actors.boss.knows.join('；')}。你的态度：${d.actors.boss.attitude_to_user}。红线：`),
      '你是第一个开口的。以你的角色身份，就这个问题向团队（用户是成员之一）说出你的第一反应。1-3句话，施加你的影响。'].join('\n');
    const res = await this.adapter.run(boss.model, { prompt, system: boss.card });
    if (!res.ok) { const e = new Error(res.reason_code); e.code = res.reason_code; e.raw = res.raw; throw e; }
    const text = readFileSync('results/' + res.result_ref, 'utf8').replace(/^# .*?\n+/, '').trim();
    this.store.append(orderId, [{ type: 'SCENE_TURN', data: { actor: 'boss', name: boss.name, text, result_ref: res.result_ref } }]);
    return text;
  }
  // 用户行动 → 全体角色反应（每个角色基于自己的状态）
  async userTurn(orderId, userId, text) {
    const h = this.store.getOrder(orderId);
    const sess = h.find(e => e.type === 'SCENE_SESSION').data;
    const def = this.def(sess.scenario_id);
    sess.round += 1;
    this.store.append(orderId, [{ type: 'SCENE_TURN', data: { actor: 'user', name: '你', text, round: sess.round } }]);

    const reactions = [];
    for (const a of def.actors) {
      if (a.key === 'user') continue;
      const st = sess.actors[a.key];
      const prompt = [
        a.card.replace('红线：', `当前局势（第${sess.round}天级）：${sess.problem}。复盘会还剩${sess.days}天。用户的最新动作：「${text}」。\n你的当前状态——目标：${st.goal}；对用户的态度：${st.attitude_to_user}；你知道：${st.knows.join('；')}；你怀疑：${st.suspects.join('；') || '无'}；你上一步：${st.last_action}。\n其他角色的态度（你听说的）：${def.actors.filter(x => x.key !== a.key && x.key !== 'user').map(x => x.name + '：' + sess.actors[x.key].attitude_to_user).join('；')}。红线：`),
        '以你的角色身份回应这个局面。1-3句话。你的回应必须基于你的利益和你已知的信息——不知道的事不要提。',
        '输出格式（严格遵守）：第一部分只写你的角色台词（中文，1-3句，禁止任何思考过程、英文、或状态JSON出现在台词里）；然后另起一行，以【状态】开头，输出一行纯JSON：{"attitude_to_user":"…","knows":["…"],"suspects":["…"],"last_action":"…"}（只写有变化的字段）。【状态】行之后不能再有任何内容。'].filter(Boolean).join('\n');
      const res = await this.adapter.run(a.model, { prompt, system: a.card });
      if (!res.ok) { reactions.push({ actor: a.key, name: a.name, error: res.reason_code }); continue; }
      const raw = readFileSync('results/' + res.result_ref, 'utf8').replace(/^# .*?\n+/, '').trim();
      const reply = stripDelta(raw);
      const delta = parseStateDelta(raw);
      if (delta) Object.assign(sess.actors[a.key], delta);
      this.store.append(orderId, [{ type: 'SCENE_TURN',
        data: { actor: a.key, name: a.name, text: reply, state_delta: delta ?? {}, round: sess.round, result_ref: res.result_ref } }]);
      reactions.push({ actor: a.key, name: a.name, text: reply });
    }
    // 状态更新入账
    this.store.append(orderId, [{ type: 'SCENE_STATE', data: { round: sess.round, actors: sess.actors } }]);
    return { round: sess.round, reactions };
  }
  // 局势观察（每轮后可调用）：旁观者视角的现状陈述
  async situationBriefing(orderId) {
    const h = this.store.getOrder(orderId);
    const sess = h.find(e => e.type === 'SCENE_SESSION').data;
    const summary = def_actors_summary(sess);
    const prompt = `你是一个冷静的观察者，正在看一场职场复盘推演。目前状态：${summary}。请用3-4句话客观陈述当前局势（谁在动作、风向如何、什么在逼近），不评判、不建议、不预测确定结局。`;
    const model = 'kimi-k3';
    const res = await this.adapter.run(model, { prompt, system: '你是客观的局势观察者。只陈述可见的事实和动向。' });
    if (!res.ok) return null;
    return readFileSync('results/' + res.result_ref, 'utf8').replace(/^# .*?\n+/, '').trim();
    function def_actors_summary(d) {
      return Object.entries(d.actors).map(([k, v]) => `${k}：态度=${v.attitude_to_user}，已知=${v.knows.join('/')}`).join('；');
    }
  }
}
