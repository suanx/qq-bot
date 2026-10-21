/**
 * /api/admin/members  成员数据增删改查
 * GET  ?id=&search=&groupOpenid=&status=&page=&pageSize=
 * POST 新建  PUT ?id= 更新  DELETE ?id= 删除
 */
import { handleCollection } from '../../src/admin/crud.js';
import { COLLECTIONS } from '../../src/repo.js';

export async function onRequest(context) {
  return handleCollection(context, COLLECTIONS.MEMBERS, {
    searchFields: ['memberOpenid', 'nickname', 'groupOpenid'],
    filterFields: ['groupOpenid', 'status'],
    defaults: { violations: 0, status: 'normal', mutedUntil: null },
    allowClientId: true,                     // 主键为业务键 群openid:成员openid
    validateCreate: (p) => {
      if (!p.groupOpenid) return '缺少 groupOpenid';
      if (!p.memberOpenid) return '缺少 memberOpenid';
      return null;
    },
  });
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
