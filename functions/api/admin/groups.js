/**
 * /api/admin/groups  群数据增删改查
 * GET  ?id=&search=&status=&page=&pageSize=&sortKey=&sortDir=
 * POST 新建  PUT ?id= 更新  DELETE ?id= 删除
 */
import { handleCollection } from '../../../src/admin/crud.js';
import { COLLECTIONS } from '../../../src/repo.js';

export async function onRequest(context) {
  return handleCollection(context, COLLECTIONS.GROUPS, {
    searchFields: ['id', 'name'],
    filterFields: ['status', 'aiEnabled', 'adFilterEnabled'],
    defaults: { status: 'active', aiEnabled: true, adFilterEnabled: true, memberCount: 0 },
    allowClientId: true,                     // 主键为业务键 group_openid
    validateCreate: (p) => (!p.id ? '缺少群 group_openid（id）' : null),
  });
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
