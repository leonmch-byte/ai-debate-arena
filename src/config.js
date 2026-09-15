// v3 协议常量（§4.7 SLA + §8 权限参数 + 价格表）。改数值不改结构。
export const SLA = {
  QUOTE_TTL_MINUTES: 15,
  RECOVERY_MAX_ATTEMPTS: 3,
  RECOVERY_WINDOW_MINUTES: 5,
  DECISION_TIMEOUT_HOURS: 24,
  SURCHARGE_WINDOW_MINUTES: 15,
  OBJECTION_PERIOD_HOURS: 72,
  PAYMENT_UNKNOWN_POOL_MINUTES: 30,
};
export const VOUCHER_TTL_DAYS = 90;                       // §6.6
export const RUNTIME_FLAGS = { dual_review_enabled: false }; // §8.4 休眠，开时零迁移
export const GOODWILL = {
  MAX_SINGLE_CENTS: 2000,            // 单笔 ≤ ¥20
  USER_30D_CAP_CENTS: 10000,         // 单用户 30 天累计 ≤ ¥100
  MAX_RATIO_OF_PAID: 0.5,            // 单笔 ≤ 订单实付 50%
};
export const WORKER_INTERVAL_SECONDS = 60;
export const PRICE_TABLE_VERSION = 'pt-2025-09';
export const PRICE_TABLES = {
  'pt-2025-09': {
    models: {
      'doubao-pro': 800,
      'kimi-k3': 800,
      'deepseek-v41': 600,
      'minimax-m3': 1000,
    },
  },
};
