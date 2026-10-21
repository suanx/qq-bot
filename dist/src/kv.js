/**
 * 存储适配层：可插拔驱动，零硬依赖
 *
 * auto 模式优先级：
 *   1) KV 绑定        env.BOT_KV / globalThis.BOT_KV
 *                     —— 需控制台开通 KV 并「绑定命名空间」，变量名填 BOT_KV
 *   2) Blob 官方 SDK   @edgeone/pages-blob（可选依赖）
 *                     —— Pages Functions 内自动鉴权；未安装则自动跳过
 *   3) 内存 Map       —— 兜底，单实例有效，重启清零
 *
 * 统一异步 JSON 接口：get / put / del / incr
 * 无论落到哪个驱动，上层代码写法一致，便于 KV 审批通过后无缝切换。
 */
import { memoryDriver } from './store.js';

/** KV 绑定驱动（底层为字符串读写） */
function makeKVDriver(kv) {
  return {
    kind: 'kv',
    async get(key) { return kv.get(key); },
    async put(key, value) { await kv.put(key, value); },
    async del(key) {
      if (typeof kv.delete === 'function') await kv.delete(key);
      else if (typeof kv.del === 'function') await kv.del(key);
    },
  };
}

/** Blob 官方 SDK 驱动（每个 key 一个对象，值为 JSON 文本） */
function makeBlobDriver(store) {
  return {
    kind: 'blob',
    async get(key) {
      try {
        const v = await store.get(key, { type: 'text', consistency: 'strong' });
        return v === undefined ? null : v;
      } catch {
        return null; // 不存在或读取失败，按空处理
      }
    },
    async put(key, value) {
      await store.set(key, value, { cacheControl: 'no-store' });
    },
    async del(key) {
      try { await store.delete(key); } catch { /* 不存在时忽略 */ }
    },
  };
}

/** 对象键清洗，避免非法字符导致写入失败 */
function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._:/-]/g, '_');
}

/**
 * 解析驱动：KV 绑定 > Blob SDK > 内存
 * @param {object} env 环境变量
 */
export async function resolveDriver(env = {}) {
  const want = String(env.BOT_STORE || 'auto').toLowerCase();
  if (want === 'memory') return memoryDriver;

  // 1) KV 绑定（控制台绑定 namespace 后自动出现）
  const kv = env.BOT_KV || globalThis.BOT_KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function' && want !== 'blob') {
    return makeKVDriver(kv);
  }

  // 2) Blob 官方 SDK：可选依赖，未安装自动降级内存
  if (want !== 'kv') {
    try {
      const mod = await import('@edgeone/pages-blob');
      if (mod && typeof mod.getStore === 'function') {
        const store = mod.getStore({
          name: env.BLOB_STORE || 'qq-bot',
          consistency: 'strong',
        });
        return makeBlobDriver(store);
      }
    } catch { /* 未安装可选依赖，落到内存 */ }
  }

  return memoryDriver;
}

/** 创建存储实例（异步：可能动态加载官方 Blob SDK） */
export async function createKV(env = {}) {
  const driver = await resolveDriver(env);
  return {
    driver,
    /** 是否落在持久化存储上 */
    persistent: driver !== memoryDriver,
    /** 驱动名，便于后台概览与日志诊断 */
    kind: driver.kind || (driver === memoryDriver ? 'memory' : 'unknown'),

    async get(key, def = null) {
      const raw = await driver.get(sanitizeKey(key));
      if (raw === null || raw === undefined || raw === '') return def;
      try { return JSON.parse(raw); } catch { return def; }
    },

    async put(key, value, ttlSec = 0) {
      await driver.put(sanitizeKey(key), JSON.stringify(value), ttlSec);
    },

    async del(key) { await driver.del(sanitizeKey(key)); },

    async incr(key, ttlSec = 86400) {
      const next = Number(await this.get(key, 0)) + 1;
      await this.put(key, next, ttlSec);
      return next;
    },
  };
}

export default createKV;
