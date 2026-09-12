import { randomBytes, randomUUID } from 'node:crypto';

// UUIDv7：时间有序，用于 event_id（协议 §1.4）
export function uuidv7() {
  const ts = BigInt(Date.now());
  const b = randomBytes(16);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const rid = () => randomBytes(8).toString('hex');
export const genOrderId = () => 'ord_' + rid();
export const genItemId = () => 'itm_' + rid();
export const genVoucherId = () => 'vch_' + rid();
export const genDecisionId = () => 'dec_' + rid();
export const genObligationId = () => 'obl_' + rid();

// 幂等操作键 op_{type}:{order_id}:{item_id?}:{uuid}（协议 §1.4）
export function genOperationId(type, orderId, itemId = null) {
  return `op_${type}:${orderId}${itemId ? ':' + itemId : ''}:${randomUUID()}`;
}
