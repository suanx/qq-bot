/**
 * /api/admin/joinrequests  入群申请（GROUP_JOIN_REQUEST 事件落库 + 人工审批）
 * GET    ?page=&pageSize=&search=&status=&groupOpenid=
 * POST   { id, op:'approve'|'decline', addToBlacklist?:bool, rejectReason?:string }
 * DELETE ?id=
 *
 * 审批走 QQ 开放平台 /v2/groups/{group_openid}/approval_join_request/{member_openid}，
 * 需机器人是群管理员；拒绝时可同时写入平台群黑名单（真正阻止再次申请）。
 */
import { handleCollection } from '../../../src/admin/crud.js';
import {
  guard, ok, fail, audit,
} from '../../../src/admin/api.js';
import { COLLECTIONS } from '../../../src/repo.js';
import { approveJoinRequest } from '../../../src/qqapi.js';
import { loadConfig } from '../../../src/config.js';
import { touchMember, logAction } from '../../../src/records.js';

async function handleApprove(context) {
  const { request, env } = context;
  const g = await guard(request, env, { collection: COLLECTIONS.JOIN_REQUESTS, write: true });
  if (g.error) return g.error;
  const { repo, user, kv, cfg } = g;

  let body;
  try { body = await request.json(); } catch { return fail('bad json', 400); }
  const id = String((body && body.id) || '').trim();
  const op = body && body.op === 'decline' ? 'decline' : 'approve';
  if (!id) return fail('缺少记录 id', 400);

  const rec = await repo.get(COLLECTIONS.JOIN_REQUESTS, id);
  if (!rec) return fail('申请记录不存在', 404);
  if (rec.status !== 'pending') return fail(`该申请已处理（${rec.status}）`, 409);

  const addToBlacklist = op === 'decline' && !!body.addToBlacklist;
  const rejectReason = String((body && body.rejectReason) || '').slice(0, 200);

  try {
    await approveJoinRequest(rec.groupOpenid, rec.memberOpenid, op, cfg || loadConfig(env), {
      joinRequestId: rec.joinRequestId,
      rejectReason,
      addToBlacklist,
    });
  } catch (e) {
    await logAction(kv, {
      action: op === 'decline' ? 'join_decline_failed' : 'join_approve_failed',
      target: `${rec.groupOpenid}:${rec.memberOpenid}`,
      detail: `后台${op === 'decline' ? '拒绝' : '通过'}失败：${e.message}`,
    }).catch(() => {});
    return fail(`平台调用失败：${e.message}`, 502);
  }

  const item = await repo.update(COLLECTIONS.JOIN_REQUESTS, id, {
    status: op === 'decline' ? 'declined' : 'approved',
    handledBy: user?.username || user?.name || 'admin',
    reason: rejectReason,
  });

  await touchMember(kv, rec.groupOpenid, rec.memberOpenid, {
    status: addToBlacklist || op === 'decline' ? 'blacklisted' : 'normal',
    nickname: rec.username || rec.memberOpenid,
  }).catch(() => {});

  await logAction(kv, {
    action: op === 'decline' ? 'join_declined' : 'join_approved',
    target: `${rec.groupOpenid}:${rec.memberOpenid}`,
    detail: `后台${op === 'decline' ? '拒绝' : '通过'}入群申请：${rec.username || rec.memberOpenid}`
      + (addToBlacklist ? '（并写入群黑名单）' : ''),
  }).catch(() => {});

  await audit(repo, user, op === 'decline' ? 'decline' : 'approve',
    `joinrequests:${id}`, JSON.stringify(body).slice(0, 400));

  return ok({ item });
}

export async function onRequest(context) {
  const { request } = context;
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'POST') return handleApprove(context);
  return handleCollection(context, COLLECTIONS.JOIN_REQUESTS, {
    searchFields: ['username', 'memberOpenid', 'groupOpenid', 'reason'],
    filterFields: ['status', 'groupOpenid'],
    deny: ['PUT'], // 状态只允许通过审批接口变更
  });
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestDelete = onRequest;
