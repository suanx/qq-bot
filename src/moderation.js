/**
 * 违规处罚：警告 → 撤回 → 禁言 → （可选踢人/拉黑）
 * 计数存储在 store，按 群+用户 维度，24h 滑动窗口
 */
import { store } from './store.js';

export const VIOLATION_TTL = 86400;

/** 记一次违规，返回累计次数 */
export function recordViolation(groupOpenid, userOpenid) {
  return store.incr(`viol:${groupOpenid}:${userOpenid}`, VIOLATION_TTL);
}

export function getViolations(groupOpenid, userOpenid) {
  return store.get(`viol:${groupOpenid}:${userOpenid}`, 0);
}

export function clearViolations(groupOpenid, userOpenid) {
  store.del(`viol:${groupOpenid}:${userOpenid}`);
}

/**
 * 根据次数决定动作
 * 1~(threshold-1) 次：warn（仅警告）
 * threshold 次起：delete_mute（撤回+禁言，时长阶梯递增）
 */
export function decideAction(count, cfg) {
  const th = Math.max(1, cfg.AD_MUTE_THRESHOLD);
  if (count < th) return { action: 'warn', muteSeconds: 0 };
  // 阶梯：第 th 次 = AD_MUTE_SECONDS，之后翻倍，封顶 AD_MUTE_MAX_SECONDS
  const exp = count - th;
  const sec = Math.min(cfg.AD_MUTE_SECONDS * 2 ** exp, cfg.AD_MUTE_MAX_SECONDS);
  return { action: 'delete_mute', muteSeconds: sec };
}

/** 测试用：清空（由 store._clear 实现） */
export function _reset() { /* store._clear 由测试直接调用 */ }
