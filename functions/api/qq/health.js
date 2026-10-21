/** GET /api/qq/health 健康检查 */
import { handleRequest } from '../../../src/core.js';

export async function onRequest(context) {
  return handleRequest(context.request, context.env, context.ctx);
}

export const onRequestGet = onRequest;
