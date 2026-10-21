/**
 * EdgeOne Pages Function 入口：POST /api/qq/webhook
 * 路由映射：functions 目录结构即 URL 路径
 */
import { handleRequest } from '../../src/core.js';

export async function onRequest(context) {
  const { request, env, ctx } = context;
  return handleRequest(request, env, ctx);
}

export const onRequestPost = onRequest;
