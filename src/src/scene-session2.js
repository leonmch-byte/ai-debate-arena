// M-B.2：新版场景会话——完整流程：描述 → 分析 → 角色确认 → 画像 → AI选择 → 推演。
// 构造依赖：(store, sceneEngine, adapter) —— sceneEngine 提供角色卡和状态层。

import { readFileSync } from 'node:fs';
import { analyzeOffice, aiClassify } from './scene-analyzer.js';

export class SceneSessionV2 {
  constructor(store, sceneEngine, adapter, log = () => {}) {
    this.store = store;
    this.engine = sceneEngine;
    this.adapter = adapter;
    this.log = log;
  }

  // 第 1 步：分析处境 → 返回判定结果 + 建议阵容（用户确认后进入下一步）
  async analyze(text, userId) {
    const result = analyzeOffice(text, this.adapter, this.log);
    if (result) {
      return { ok: true, ...result, userText: text };
    }
    // 关键词未命中 → AI 兜底
    const aiResult = await aiClassify(text, this.adapter, this.log);
    if (aiResult && aiResult !== 'politics-other') {
      const def = (await import('./scene-analyzer.js')).OFFICE_SCENES[aiResult];
      if (def) return { ok: true, scene: aiResult, name: def.name, roles: def.roles,
        situation_hint: def.situation_hint, method: 'ai', userText: text };
    }
    return { ok: false, reason: '无法归类——请补充更多细节' };
  }

  // 第 2 步：确认场景，创建会话（角色资料+画像+AI选择 存入会话）
  beginConfirmed(userId, { scene, user_role, profile, ai_assignments }) {
    const orderId = 'ord_scn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // AI 分配：用户为每个角色选的模型（{角色名: 模型ID}）
    const assignments = ai_assignments ?? {};
    this.store.append(orderId, [{ type: 'SCENE_SESSION',
      data: { user_id: userId, scene, user_role, profile,
              ai_assignments: assignments } }]);
    return { order_id: orderId };
  }

  // 第 3 步：推演一轮（用户行动 → 场景内 AI 角色反应）
  async userTurn(orderId, text) {
    const h = this.store.getOrder(orderId);
    const sess = h.find(e => e.type === 'SCENE_SESSION').data;
    this.store.append(orderId, [{ type: 'SCENE_TURN', data: { actor: 'user', name: '你', text } }]);

    const reactions = [];
    // 遍历所有 AI 角色（排除用户），按各自模型调用
    for (const [roleName, modelId] of Object.entries(sess.ai_assignments)) {
      if (!modelId) continue;
      const card = this.#buildCard(roleName, sess);
      const history = h.filter(e => e.type === 'SCENE_TURN')
        .map(e => `${e.data.name ?? e.data.actor}：「${e.data.text}」`).join('\n');
      const prompt = [card, '', '场景处境：' + (sess.scene ?? ''), '',
        '对话至今：', history, '',
        `用户刚才说了：「${text}」——以你的角色身份回应。`,
        '只以角色身份说1-3句话。不旁白、不出戏、不教育。'].filter(Boolean).join('\n');
      const res = await this.adapter.run(modelId, { prompt, system: card });
      if (!res.ok) { reactions.push({ actor: roleName, error: res.reason_code }); continue; }
      const reply = readFileSync('results/' + res.result_ref, 'utf8').replace(/^# .*?\n+/, '').trim();
      this.store.append(orderId, [{ type: 'SCENE_TURN',
        data: { actor: roleName, name: roleName, text: reply, result_ref: res.result_ref } }]);
      reactions.push({ actor: roleName, text: reply });
    }
    return { reactions };
  }

  #buildCard(roleName, sess) {
    // 简版：根据角色名和场景生成角色卡（M-C 接入角色池后从注册表读）
    const CARDS = {
      '领导': '你是「部门领导」。利益：部门业绩、上层信任。性格：简洁、反问施压、反感情绪化。',
      '同事': '你是「同事」。利益：在领导面前确立形象。性格：表面客气实则精明。',
      '老员工': '你是「老员工」。话少，用旧事暗示，不直接建议。',
      '用户': '你扮演场景中与用户互动的一方。',
    };
    // 根据角色名模糊匹配
    for (const [k, v] of Object.entries(CARDS)) {
      if (roleName.includes(k)) return v;
    }
    return '你是场景中的参与者，按你的角色身份自然回应。1-3句话，不旁白不出戏。';
  }
}
SSEOF
