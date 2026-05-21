/**
 * Rate limiter — Redis-backed with in-memory fallback.
 * Atomic fixed-window via Lua INCR+EXPIRE so counters are shared
 * across all PM2 cluster workers. Falls back to per-process Map when
 * Redis is unavailable.
 *
 * Usage: router.post('/login', rateLimit(5, 60_000), handler)
 *   → max 5 requests per IP per 60 seconds on this route
 */

const cfg = require('../config');

// ── Redis client (lazy — only created when REDIS_URL is set) ──────────────────
let _redis = null;

function getRedis() {
  if (_redis) return _redis;
  if (!cfg.redisUrl) return null;
  try {
    const Redis = require('ioredis');
    _redis = new Redis(cfg.redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      lazyConnect: true,
      commandTimeout: 200,
    });
    _redis.on('error', () => {});
    return _redis;
  } catch {
    return null;
  }
}

// Atomic fixed-window: increment counter, set TTL only on first hit.
// Returns the new request count, or null on Redis error.
const LUA_INCR = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

async function redisIncr(key, windowSec) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.eval(LUA_INCR, 1, key, windowSec);
  } catch {
    return null;
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────
const store = new Map(); // key → [timestamp, ...]

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, ts] of store) {
    const fresh = ts.filter(t => t > cutoff);
    if (fresh.length === 0) store.delete(k);
    else store.set(k, fresh);
  }
}, 5 * 60_000);

function memCheck(key, windowMs, max) {
  const now = Date.now();
  const hits = (store.get(key) || []).filter(t => t > now - windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  store.set(key, hits);
  return true;
}

/**
 * @param {number} max       - max requests allowed in the window
 * @param {number} windowMs  - window size in milliseconds
 * @param {string} [message] - custom error message
 */
function rateLimit(max, windowMs, message) {
  const windowSec = Math.ceil(windowMs / 1000);

  return async (req, res, next) => {
    // Use the last IP in X-Forwarded-For (added by the trusted proxy),
    // or fall back to the direct socket address.
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (forwarded ? forwarded.split(',').pop().trim() : null) || req.socket?.remoteAddress || 'unknown';
    const key = `sv:rl:${ip}:${req.path}`;

    const count = await redisIncr(key, windowSec);

    if (count !== null) {
      if (count > max) {
        res.setHeader('Retry-After', windowSec);
        return res.status(429).json({
          error: message || `Demasiados intentos. Intenta de nuevo en ${windowSec}s.`,
          retryAfter: windowSec,
        });
      }
      return next();
    }

    // In-memory fallback when Redis is unavailable
    if (!memCheck(key, windowMs, max)) {
      const retryAfterSec = Math.ceil(windowMs / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        error: message || `Demasiados intentos. Intenta de nuevo en ${retryAfterSec}s.`,
        retryAfter: retryAfterSec,
      });
    }
    next();
  };
}

module.exports = rateLimit;
