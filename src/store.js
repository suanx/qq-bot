/**
 * 轻量状态存储：模块级内存 Map（边缘单实例内有效，重启清零）。
 * 若运行环境提供 KV（env.KV_NAMESPACE，get/put 接口），自动降级为无操作。
 * 接口：get / set(ttl 秒) / incr / del
 */

const data = new Map(); // key -> { v, expireAt }

function _expired(rec) {
  return !rec || (rec.expireAt && Date.now() > rec.expireAt);
}

export const store = {
  get(key, def = null) {
    const rec = data.get(key);
    if (_expired(rec)) { data.delete(key); return def; }
    return rec.v;
  },
  set(key, value, ttlSec = 0) {
    data.set(key, { v: value, expireAt: ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 });
  },
  incr(key, ttlSec = 86400) {
    const rec = data.get(key);
    if (_expired(rec)) {
      data.set(key, { v: 1, expireAt: Date.now() + ttlSec * 1000 });
      return 1;
    }
    rec.v += 1;
    return rec.v;
  },
  del(key) { data.delete(key); },
  /** 测试用 */
  _clear() { data.clear(); },
};

/** 群级开关：读取配置默认值，允许管理指令覆盖 */
export function groupFlag(groupOpenid, name, defaultOn) {
  const key = `flag:${groupOpenid}:${name}`;
  const v = store.get(key);
  return v === undefined || v === null ? defaultOn : !!v;
}
export function setGroupFlag(groupOpenid, name, on) {
  store.set(`flag:${groupOpenid}:${name}`, !!on);
}
