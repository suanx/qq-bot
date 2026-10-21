/**
 * 存储适配层：优先 KV 绑定，未绑定时降级内存。
 * 统一异步 JSON 接口，屏蔽底层差异。
 *
 * 绑定方式（EdgeOne Pages 控制台）：
 *   Database -> KV Storage -> Bind Namespace，变量名填 BOT_KV
 * 未绑定时自动使用内存驱动（状态不跨实例持久）。
 */
import { memoryDriver } from './store.js';

export function pickDriver(env = {}) {
  const kv = env.BOT_KV || globalThis.BOT_KV;
  const ok = kv && typeof kv.get === 'function' && typeof kv.put === 'function';
  return ok ? kv : memoryDriver;
}

export function createKV(env = {}) {
  const driver = pickDriver(env);
  return {
    driver,
    /** 是否落在持久化存储上 */
    persistent: driver !== memoryDriver,

    async get(key, def = null) {
      const raw = await driver.get(key);
      if (raw === null || raw === undefined || raw === '') return def;
      try { return JSON.parse(raw); } catch { return def; }
    },

    async put(key, value, ttlSec = 0) {
      await driver.put(key, JSON.stringify(value), ttlSec);
    },

    async del(key) { await driver.del(key); },

    async incr(key, ttlSec = 86400) {
      if (typeof driver.incr === 'function') return driver.incr(key, ttlSec);
      const v = (await this.get(key, 0)) + 1;
      await this.put(key, v, ttlSec);
      return v;
    },
  };
}

export default createKV;
