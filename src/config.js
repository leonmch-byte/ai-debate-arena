// v3 协议常量（§4.7 SLA + 价格表）。改数值不改结构。
export const SLA = {
  QUOTE_TTL_MINUTES: 15,          // 报价锁价窗口
  RECOVERY_MAX_ATTEMPTS: 3,       // 恢复环次数
  RECOVERY_WINDOW_MINUTES: 5,
  DECISION_TIMEOUT_HOURS: 24,     // 决策超时 → 自动退款
  SURCHARGE_WINDOW_MINUTES: 15,   // 补差支付窗口
  OBJECTION_PERIOD_HOURS: 72,     // 结算异议期
  PAYMENT_UNKNOWN_POOL_MINUTES: 30,
};
export const PRICE_TABLE_VERSION = 'pt-2025-09';
export const PRICE_TABLES = {
  'pt-2025-09': {
    models: {
      'deepseek-v3': 600,
      'qwen-max': 800,
      'glm-4-plus': 800,
      'kimi': 800,
      'doubao-pro': 800,
      'gpt-4o': 1000,
      'claude-sonnet': 1000,
    },
  },
};
