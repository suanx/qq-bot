/**
 * /api/admin/logs  操作日志（只读 + 可清理）
 * GET  ?id=&search=&action=&actor=&page=&pageSize=
 * DELETE ?id= 删除（仅 owner）
 */
import { handleCollection } from '../../src/admin/crud.js';
import { COLLECTIONS } from '../../src/repo.js';

export async function onRequest(context) {
  return handleCollection(context, COLLECTIONS.LOGS, {
    searchFields: ['actor', 'action', 'target', 'detail'],
    filterFields: ['action', 'actor', 'actorRole'],
    deny: ['POST', 'PUT'], // 日志由系统写入，不接受外部伪造
  });
}

export const onRequestGet = onRequest;
export const onRequestDelete = onRequest;
