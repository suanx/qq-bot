/**
 * 违规处罚：警告 → 撤回 → 禁言 → （可选踢人/拉黑）
 * 计数按 群+用户 维度，24h 窗口；计数与读写统一走 kv 适配层
 */

export const VIOLATION_TTL = 86400;

const violKey = (groupOpenid, userOpenid) => `viol:${groupOpenid}:${userOpenid}`;

/** 记一次违规，返回累计次数 */
export async function recordViolation(kv, groupOpenid, userOpenid) {
  return kv.incr(violKey(groupOpenid, userOpenid), VIOLATION_TTL);
}

/** 查询累计违规次数 */
export async function getViolations(kv, groupOpenid, userOpenid) {
  return kv.get(violKey(groupOpenid, userOpenid), 0);
}

/** 清零违规计数 */
export async function clearViolations(kv, groupOpenid, userOpenid) {
  await kv.del(violKey(groupOpenid, userOpenid));
}

/**
 * 根据次数决定动作（纯函数，便于测试）
 * 1~(threshold-1) 次：warn（仅警告）
 * threshold 次起：mute（禁言，时长阶梯递增）
 * kickThreshold 次起：kick（踢出群聊 + 拉黑，优先级最高；0 表示关闭）
 */
export function decideAction(count, cfg) {
  const th = Math.max(1, Number(cfg.AD_MUTE_THRESHOLD) || 3);
  const kickAt = Math.max(0, Number(cfg.AD_KICK_THRESHOLD) || 0);
  if (kickAt > 0 && count >= kickAt) return { action: 'kick', muteSeconds: 0 };
  if (count < th) return { action: 'warn', muteSeconds: 0 };
  // 阶梯：第 th 次 = AD_MUTE_SECONDS，之后翻倍，封顶 AD_MUTE_MAX_SECONDS
  const exp = count - th;
  const sec = Math.min(
    (Number(cfg.AD_MUTE_SECONDS) || 600) * 2 ** exp,
    Number(cfg.AD_MUTE_MAX_SECONDS) || 86400,
  );
  return { action: 'mute', muteSeconds: sec };
}
