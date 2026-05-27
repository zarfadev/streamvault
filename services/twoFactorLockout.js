/**
 * 2FA Lockout Service
 *
 * Rastreo de intentos fallidos de 2FA con bloqueo temporal progresivo.
 *
 * Estrategia:
 * - Primeros 3 fallos: sin bloqueo (ventana de 15 min)
 * - 4-5 fallos: bloqueo de 5 minutos
 * - 6-7 fallos: bloqueo de 15 minutos
 * - 10+ fallos: bloqueo de 1 hora
 *
 * Backend: Redis cuando está disponible (compartido entre instancias del cluster),
 * fallback automático a in-memory si Redis no está configurado o no responde.
 */

const cfg    = require('../config');
const logger = require('./logger').child({ module: '2fa-lockout' });

// ── In-memory fallback stores ─────────────────────────────────────────────────
const userLockouts = new Map();
const ipLockouts   = new Map();

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
      commandTimeout: 500, // 500ms — never block auth path
    });
    _redis.on('error', () => {}); // suppress unhandled errors
    return _redis;
  } catch {
    return null;
  }
}

const WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const KEY_TTL_S  = 60 * 60;        // Redis key TTL: 1 hour (covers the longest lockout)
const KEY_PREFIX = 'sv:2fa:';

const LOCKOUT_CONFIG = {
  windowMs: WINDOW_MS,
  thresholds: [
    { attempts: 3,  lockMs: 0 },
    { attempts: 5,  lockMs: 5  * 60 * 1000 },
    { attempts: 7,  lockMs: 15 * 60 * 1000 },
    { attempts: 10, lockMs: 60 * 60 * 1000 },
  ],
  maxAttempts: 10,
};

function getLockoutDuration(attempts) {
  let lockMs = 0;
  for (const t of LOCKOUT_CONFIG.thresholds) {
    if (attempts >= t.attempts) lockMs = t.lockMs;
  }
  return lockMs;
}

// ── Redis helpers ─────────────────────────────────────────────────────────────

async function redisGet(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(KEY_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function redisSet(key, data) {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.set(KEY_PREFIX + key, JSON.stringify(data), 'EX', KEY_TTL_S);
    return true;
  } catch { return false; }
}

async function redisDel(key) {
  const r = getRedis();
  if (!r) return;
  try { await r.del(KEY_PREFIX + key); } catch {}
}

// ── In-memory helpers (fallback) ──────────────────────────────────────────────

function memGet(store, key) {
  const data = store.get(key);
  if (!data) return null;
  const now = Date.now();
  const lockExpired   = !data.lockedUntil || now > data.lockedUntil;
  const windowExpired = now - data.lastAttempt > WINDOW_MS;
  if (lockExpired && windowExpired) { store.delete(key); return null; }
  return data;
}

// Prune stale in-memory entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, d] of userLockouts) {
    if ((!d.lockedUntil || now > d.lockedUntil) && now - d.lastAttempt > WINDOW_MS) userLockouts.delete(k);
  }
  for (const [k, d] of ipLockouts) {
    if ((!d.lockedUntil || now > d.lockedUntil) && now - d.lastAttempt > WINDOW_MS) ipLockouts.delete(k);
  }
}, 10 * 60 * 1000);

// ── Public API ────────────────────────────────────────────────────────────────

async function _getData(store, redisKey) {
  const fromRedis = await redisGet(redisKey);
  if (fromRedis !== null) return { data: fromRedis, backend: 'redis' };
  const fromMem = memGet(store, redisKey);
  return { data: fromMem, backend: 'memory' };
}

async function _setData(store, redisKey, data) {
  const saved = await redisSet(redisKey, data);
  if (!saved) store.set(redisKey, data); // fallback to memory
}

async function _delData(store, redisKey) {
  await redisDel(redisKey);
  store.delete(redisKey);
}

/**
 * Check if a userId or IP is currently locked out.
 */
async function checkLockout(userId, ip) {
  const now = Date.now();

  if (userId) {
    const { data } = await _getData(userLockouts, `user:${userId}`);
    if (data?.lockedUntil && now < data.lockedUntil) {
      const remainingMs = data.lockedUntil - now;
      return { locked: true, remainingMs, remainingSec: Math.ceil(remainingMs / 1000), remainingMin: Math.ceil(remainingMs / 60000), attempts: data.attempts, lockedBy: 'user' };
    }
  }

  if (ip) {
    const { data } = await _getData(ipLockouts, `ip:${ip}`);
    if (data?.lockedUntil && now < data.lockedUntil) {
      const remainingMs = data.lockedUntil - now;
      return { locked: true, remainingMs, remainingSec: Math.ceil(remainingMs / 1000), remainingMin: Math.ceil(remainingMs / 60000), attempts: data.attempts, lockedBy: 'ip' };
    }
  }

  return { locked: false };
}

/**
 * Record a failed 2FA attempt and update lockout state.
 */
async function recordFailedAttempt(userId, ip, codeType = 'totp') {
  const now = Date.now();

  // ── Per-user tracking ─────────────────────────────────────────────────────
  const { data: existingUser } = await _getData(userLockouts, `user:${userId}`);
  let userData = existingUser || { attempts: 0, lockedUntil: null, lastAttempt: now };
  if (now - userData.lastAttempt > WINDOW_MS) userData = { attempts: 0, lockedUntil: null, lastAttempt: now };

  userData.attempts++;
  userData.lastAttempt = now;
  const lockMs = getLockoutDuration(userData.attempts);
  if (lockMs > 0) userData.lockedUntil = now + lockMs;

  await _setData(userLockouts, `user:${userId}`, userData);

  // ── Per-IP tracking ───────────────────────────────────────────────────────
  const { data: existingIp } = await _getData(ipLockouts, `ip:${ip}`);
  let ipData = existingIp || { attempts: 0, lockedUntil: null, lastAttempt: now };
  if (now - ipData.lastAttempt > WINDOW_MS) ipData = { attempts: 0, lockedUntil: null, lastAttempt: now };

  ipData.attempts++;
  ipData.lastAttempt = now;
  const ipLockMs = getLockoutDuration(ipData.attempts);
  if (ipLockMs > 0) ipData.lockedUntil = now + ipLockMs;

  await _setData(ipLockouts, `ip:${ip}`, ipData);

  const isLocked    = userData.lockedUntil && now < userData.lockedUntil;
  const attemptsLeft = Math.max(0, LOCKOUT_CONFIG.maxAttempts - userData.attempts);

  logger.warn({ event: '2fa_failed_attempt', userId, ip, codeType, attempts: userData.attempts, locked: !!isLocked, attemptsLeft });

  return {
    blocked:      !!isLocked,
    remainingMs:  isLocked ? userData.lockedUntil - now : 0,
    remainingSec: isLocked ? Math.ceil((userData.lockedUntil - now) / 1000)  : 0,
    remainingMin: isLocked ? Math.ceil((userData.lockedUntil - now) / 60000) : 0,
    attempts:     userData.attempts,
    attemptsLeft,
  };
}

/**
 * Clear lockout after a successful login.
 */
async function clearLockout(userId, ip) {
  if (userId) await _delData(userLockouts, `user:${userId}`);
  if (ip)     await _delData(ipLockouts,   `ip:${ip}`);
  logger.info({ event: '2fa_lockout_cleared', userId, ip, reason: 'successful_login' });
}

/**
 * Get lockout status for a user (admin / debug use).
 */
async function getLockoutStatus(userId) {
  const { data } = await _getData(userLockouts, `user:${userId}`);
  if (!data) return null;
  const now = Date.now();
  return {
    attempts:    data.attempts,
    lastAttempt: new Date(data.lastAttempt).toISOString(),
    locked:      !!(data.lockedUntil && now < data.lockedUntil),
    lockedUntil: data.lockedUntil ? new Date(data.lockedUntil).toISOString() : null,
    remainingMs: data.lockedUntil ? Math.max(0, data.lockedUntil - now) : 0,
    remainingMin: data.lockedUntil ? Math.max(0, Math.ceil((data.lockedUntil - now) / 60000)) : 0,
  };
}

/**
 * Force-unlock a user (admin use).
 */
async function adminUnlock(userId) {
  const { data } = await _getData(userLockouts, `user:${userId}`);
  await _delData(userLockouts, `user:${userId}`);
  logger.info({ event: '2fa_admin_unlock', userId, wasLocked: !!data });
  return !!data;
}

/**
 * Force-unlock an IP (admin use).
 */
async function adminUnlockIp(ip) {
  const { data } = await _getData(ipLockouts, `ip:${ip}`);
  await _delData(ipLockouts, `ip:${ip}`);
  logger.info({ event: '2fa_admin_ip_unlock', ip, wasLocked: !!data });
  return !!data;
}

/**
 * Global stats (admin dashboard).
 */
async function getStats() {
  const now = Date.now();
  const lockedUsers = Array.from(userLockouts.entries())
    .filter(([, d]) => d.lockedUntil && now < d.lockedUntil)
    .map(([userId, d]) => ({ userId, attempts: d.attempts, remainingMin: Math.ceil((d.lockedUntil - now) / 60000) }));
  const lockedIps = Array.from(ipLockouts.entries())
    .filter(([, d]) => d.lockedUntil && now < d.lockedUntil)
    .map(([ip, d]) => ({ ip, attempts: d.attempts, remainingMin: Math.ceil((d.lockedUntil - now) / 60000) }));

  return {
    backend: getRedis() ? 'redis' : 'memory',
    totalTrackedUsers:    userLockouts.size,
    totalTrackedIps:      ipLockouts.size,
    currentlyLockedUsers: lockedUsers.length,
    currentlyLockedIps:   lockedIps.length,
    lockedUsers,
    lockedIps,
    config: {
      windowMinutes: WINDOW_MS / 60000,
      thresholds: LOCKOUT_CONFIG.thresholds.map(t => ({ attempts: t.attempts, lockMinutes: t.lockMs / 60000 })),
    },
  };
}

// Legacy sync alias — callers in routes/auth.js use this name
const recordFailure = (userId, ip) => recordFailedAttempt(userId, ip).catch(() => {});

module.exports = {
  checkLockout,
  recordFailedAttempt,
  recordFailure,
  clearLockout,
  getLockoutStatus,
  adminUnlock,
  adminUnlockIp,
  getStats,
};
