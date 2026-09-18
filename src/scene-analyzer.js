// M-B.2：处境分析——用户自由描述 → AI 自动判定子场景 + 组建角色阵容。
// 用户只负责描述自己的遭遇，系统负责把遭遇变成可推演的场景。
// 角色资料（用户自己的身份）和画像由用户在下一步填写，这里只做场景判定。

import { readFileSync } from 'node:fs';

// 职场子场景注册表（可扩展）
const OFFICE_SCENES = {
  'credit': {
    name: '功劳被抢',
    keywords: ['抢功', '功劳', '成果被', '汇报', '把我的', '当成自己的', '他提了', '签名', '署名'],
    roles: ['boss', 'colleague'],
    situation_hint: '你主导的工作成果，在汇报中被同事模糊了归属，领导当众认可了他。',
  },
  'edge': {
    name: '被边缘化',
    keywords: ['边缘', '不叫我', '会议', '孤立', '冷落', '核心工作', '转移', '架空'],
    roles: ['boss', 'veteran'],
    situation_hint: '重要的会议和核心工作正在离你远去，你隐约被移出了权力圈。',
  },
  'blame': {
    name: '背锅边缘',
    keywords: ['背锅', '责任', '出错', '甩锅', '追责', '复盘', '数据', '事故', '客户投诉', '延期'],
    roles: ['boss', 'colleague', 'veteran'],
    situation_hint: '项目出了问题，追责在逼近，各方的动作都在指向"锅"的最终归属。',
  },
  'politics-other': {
    name: '办公室其他博弈',
    keywords: ['画饼', '站队', '晋升', '加薪', '裁', '传闻', '领导换', '同事'],
    roles: ['boss', 'veteran', 'colleague'],
    situation_hint: '办公室的权力格局正在变化，你的位置需要重新判断。',
  },
};

// AI 兜底判定：关键词不命中时，调用模型分类
async function aiClassify(text, adapter, log = () => {}) {
  const sceneList = Object.entries(OFFICE_SCENES)
    .map(([k, v]) => `${k}=${v.name}`).join(', ');
  const prompt = `用户描述了一个职场处境，请判断它属于哪一类场景。
可选场景：${sceneList}
用户描述：「${text}」
只输出 JSON：{"scene":"场景key","confidence":"高或低"}，不要任何其他内容。`;
  try {
    const res = await adapter.run('doubao-pro', { prompt });
    if (!res.ok) return null;
    const text = readFileSync('results/' + res.result_ref, 'utf8');
    const m = text.match(/"scene"\s*:\s*"(\w+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

export function analyzeOffice(text, adapter, log) {
  const t = (text ?? '').toLowerCase();
  // 关键词优先判定（确定性强）
  for (const [key, def] of Object.entries(OFFICE_SCENES)) {
    const hits = def.keywords.filter(k => t.includes(k));
    if (hits.length >= 1) {
      return { scene: key, name: def.name, roles: def.roles,
        situation_hint: def.situation_hint, matched: hits, method: 'keyword' };
    }
  }
  return null; // 未命中 → 调用方决定是否走 AI 兜底
}
export { OFFICE_SCENES, aiClassify };
