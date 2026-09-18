// M-B 场景层：把"通用头脑风暴"实例化为具体产品场景。
// 每个场景 = 一组角色视角（role prompt）+ 议题装配规则。走 M4 契约与既有账本，零协议改动。
// v1 场景：resume（简历会诊）。文件上传（pdf/docx 解析）在 M-B.2 接入；当前支持粘贴文本。
export const SCENES = {
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

export function sceneRoles(sceneId) {
  const s = SCENES[sceneId];
  if (!s) throw Object.assign(new Error(`unknown scene ${sceneId}`), { code: 'UNKNOWN_SCENE' });
  return s;
}

// 把角色视角实例化为各模型的 prompt（角色 × 模型 分配在引擎装配时决定）
export function rolePrompt(sceneId, roleKey, topic, extra = {}) {
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
