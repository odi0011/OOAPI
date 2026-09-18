// 轻量内存限流（单进程滑动窗口）
// ---------------------------------------------------------------------------
// 用途：登录/注册等敏感入口防暴力破解与刷号。
// 说明：
//   · 按 req.ip 维度计数，依赖 index.js 的 trust proxy 配置取真实 IP；
//   · 仅单进程有效（多实例部署需换成 Redis 等共享存储）；
//   · 超限时返回 429 与 Retry-After。
const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 20, keyPrefix = "", keyFn } = {}) {
  return (req, res, next) => {
    // 默认按 IP 计数；需要按用户维度（如改密）可通过 keyFn 指定
    const who = keyFn ? keyFn(req) : req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${keyPrefix}:${who}`;
    const t = Date.now();

    let hits = buckets.get(key);
    if (!hits) {
      hits = [];
      buckets.set(key, hits);
    }
    while (hits.length && t - hits[0] > windowMs) hits.shift();

    if (hits.length >= max) {
      const retry = Math.max(1, Math.ceil((windowMs - (t - hits[0])) / 1000));
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ success: false, message: `请求过于频繁，请 ${retry} 秒后再试` });
    }

    hits.push(t);

    // 防止 Map 无限膨胀：清理已过期条目
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (!v.length || t - v[v.length - 1] > windowMs) buckets.delete(k);
      }
    }
    next();
  };
}
