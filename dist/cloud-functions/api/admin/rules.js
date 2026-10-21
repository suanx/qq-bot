/**
 * /api/admin/rules  广告规则（关键词/正则）增删改查
 * GET  ?id=&search=&type=&enabled=&page=&pageSize=
 * POST 新建  PUT ?id= 更新  DELETE ?id= 删除
 */
import { handleCollection } from '../../src/admin/crud.js';
import { COLLECTIONS } from '../../src/repo.js';

const TYPES = ['keyword', 'regex'];

const validate = (p) => {
  if (!TYPES.includes(String(p.type || '').toLowerCase())) {
    return `type 必须是 ${TYPES.join(' 或 ')}`;
  }
  if (!p.value || !String(p.value).trim()) return '缺少规则内容（value）';
  if (String(p.type).toLowerCase() === 'regex') {
    try { new RegExp(p.value); } catch (e) { return `正则非法：${e.message}`; }
  }
  return null;
};

export async function onRequest(context) {
  return handleCollection(context, COLLECTIONS.RULES, {
    searchFields: ['value', 'rule', 'note'],
    filterFields: ['type', 'enabled'],
    defaults: { type: 'keyword', enabled: true },
    validateCreate: validate,
    validateUpdate: (p) => (p.type || p.value ? validate({ type: p.type || 'keyword', value: p.value || 'x' }) : null),
  });
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
