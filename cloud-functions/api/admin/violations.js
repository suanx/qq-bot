/**
 * /api/admin/violations  违规记录增删改查
 * GET  ?id=&search=&groupOpenid=&rule=&action=&page=&pageSize=
 * POST 新建  PUT ?id= 更新  DELETE ?id= 删除
 */
import { handleCollection } from '../../../src/admin/crud.js';
import { COLLECTIONS } from '../../../src/repo.js';

export async function onRequest(context) {
  return handleCollection(context, COLLECTIONS.VIOLATIONS, {
    searchFields: ['memberOpenid', 'rule', 'matched', 'content'],
    filterFields: ['groupOpenid', 'rule', 'action'],
    defaults: { action: 'warn', muteSeconds: 0, count: 1 },
  });
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
