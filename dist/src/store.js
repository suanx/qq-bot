/**
 * 内存存储驱动（异步接口，与 KV 驱动保持一致）
 * 单实例内有效，重启清零；用于未绑定 KV 时的降级。
 * 接口：get / put / del / incr
 */

const data = new Map(); // key -> { v, expireAt }

function expired(rec) {
  return !rec || (rec.expireAt && Date.now() > rec.expireAt);
}

export const memoryDriver = {
  async get(key) {
    const rec = data.get(key);
    if (expired(rec)) { data.delete(key); return null; }
    return rec.v;
  },
  async put(key, value, ttlSec = 0) {
    data.set(key, { v: value, expireAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
  },
  async del(key) { data.delete(key); },
  async incr(key, ttlSec = 86400) {
    const rec = data.get(key);
    if (expired(rec)) {
      data.set(key, { v: 1, expireAt: Date.now() + ttlSec * 1000 });
      return 1;
    }
    rec.v += 1;
    return rec.v;
  },
  /** 测试用 */
  _clear() { data.clear(); },
};

export default memoryDriver;
