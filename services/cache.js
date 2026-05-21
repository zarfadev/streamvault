/**
 * Redis cache service — thin wrapper around ioredis.
 *
 * Provides get/set/del with automatic JSON serialization.
 * Falls back gracefully (no-op) when Redis is not configured,
 * so the app works in development without Redis.
 *
 * Usage:
 *   const cache = require('./services/cache');
 *   const data  = await cache.get('my-key');
 *   await cache.set('my-key', data, 300); // TTL in seconds
 *   await cache.del('my-key');
 *   await cache.delPattern('analytics:videoId:*');
 */
const cfg = require('../config');
const logger = require('./logger').child({ module: 'cache' });

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!cfg.redisUrl) return null;

  try {
    const Redis = require('ioredis');
    _client = new Redis(cfg.redisUrl, {
      // Don't crash the app if Redis goes down — just disable cache
      enableOfflineQueue:    false,
      maxRetriesPerRequest:  1,
      lazyConnect:           true,
      connectTimeout:        3_000,
    });

    _client.on('error', err => {
      // Log once, don't spam
      if (!_client._svLoggedError) {
        logger.warn({ err: err.message }, 'Redis error (cache disabled)');
        _client._svLoggedError = true;
      }
    });

    _client.on('connect', () => {
      _client._svLoggedError = false;
      logger.info('Redis connected');
    });

    return _client;
  } catch (e) {
    logger.warn({ err: e.message }, 'ioredis init failed');
    return null;
  }
}

/**
 * Get a cached value. Returns parsed object or null on miss/error.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {
  const client = getClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Set a value in cache with optional TTL.
 * @param {string} key
 * @param {any}    value   — will be JSON-serialized
 * @param {number} [ttl]   — seconds (default: 300 = 5 min)
 */
async function set(key, value, ttl = 300) {
  const client = getClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Delete a single key.
 * @param {string} key
 */
async function del(key) {
  const client = getClient();
  if (!client) return;
  try {
    await client.del(key);
  } catch {}
}

/**
 * Delete all keys matching a glob pattern.
 * Uses SCAN to avoid blocking Redis with KEYS on large datasets.
 * @param {string} pattern  e.g. 'analytics:abc123:*'
 */
async function delPattern(pattern) {
  const client = getClient();
  if (!client) return;
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length) await client.del(...keys);
    } while (cursor !== '0');
  } catch {}
}

/**
 * Cache wrapper for database queries.
 * Eliminates redundant DB hits for frequently-read, rarely-changed data.
 *
 * Usage:
 *   const ws = await cache.cachedQuery(`ws:${id}`, 300, () =>
 *     db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
 *   );
 *
 * @param {string} key     - Cache key
 * @param {number} ttl     - TTL in seconds
 * @param {Function} queryFn - Async function that returns the data
 * @returns {Promise<any>}
 */
async function cachedQuery(key, ttl, queryFn) {
  // Try cache first
  const cached = await get(key);
  if (cached !== null) return cached;

  // Cache miss — execute query
  const result = await queryFn();

  // Store in cache (fire-and-forget — never block on cache write)
  if (result !== null && result !== undefined) {
    set(key, result, ttl).catch(() => {});
  }

  return result;
}

/**
 * Invalidate a specific cached query by key.
 * Call this after writes to ensure fresh data on next read.
 * @param {string} key
 */
async function invalidate(key) {
  return del(key);
}

module.exports = { get, set, del, delPattern, cachedQuery, invalidate };
