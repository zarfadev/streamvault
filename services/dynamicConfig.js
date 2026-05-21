/**
 * Dynamic Configuration Service
 * 
 * Allows runtime config changes from the Admin panel without .env restarts.
 * Values are stored in the system_config table and take precedence over .env.
 * 
 * Usage:
 *   const { getDynConfig, setDynConfig, reloadDynConfig } = require('./dynamicConfig');
 *   const siteName = await getDynConfig('platform.siteName', 'Platform');
 */
const logger = require('./logger').child({ module: 'dynconfig' });

let _cache = {};
let _loaded = false;
let _loadedAt = 0;
const CACHE_TTL_MS = 60_000; // Reload from DB every 60s so cluster workers see admin changes
let _db = null;

function setDb(db) { _db = db; }

async function reloadDynConfig() {
  if (!_db) return;
  try {
    const rows = await _db.prepare(`SELECT key, value FROM system_config`).all().catch(() => []);
    _cache = {};
    for (const row of rows) {
      try { _cache[row.key] = JSON.parse(row.value); } catch { _cache[row.key] = row.value; }
    }
    _loaded = true;
    _loadedAt = Date.now();
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to reload dynamic config');
  }
}

/**
 * Get a config value. Supports dot-notation for nested keys within a section.
 * e.g. getDynConfig('platform.siteName', '')
 *      getDynConfig('transcoding.qualities', ['360p','720p'])
 *      getDynConfig('plans.enterprise', null) — handles literal dotted keys too
 */
async function getDynConfig(dotKey, defaultVal) {
  if ((!_loaded || Date.now() - _loadedAt > CACHE_TTL_MS) && _db) await reloadDynConfig();

  // 1. Check if the literal key exists in cache (e.g. 'plans.enterprise' stored as-is)
  if (_cache[dotKey] !== undefined) {
    return _cache[dotKey];
  }

  // 2. Try dot-notation traversal (e.g. 'platform.siteName' → _cache['platform'].siteName)
  const [section, ...rest] = dotKey.split('.');
  const sectionData = _cache[section];
  if (rest.length === 0) return sectionData ?? defaultVal;
  if (sectionData && typeof sectionData === 'object') {
    const val = rest.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), sectionData);
    return val !== undefined ? val : defaultVal;
  }
  return defaultVal;
}

/**
 * Set a config value by section key (replaces the entire section object).
 */
async function setDynConfig(section, data) {
  if (!_db) throw new Error('DB not initialized');
  const nowUnix = Math.floor(Date.now() / 1000);
  await _db.prepare(
    `INSERT INTO system_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(section, JSON.stringify(data), nowUnix);
  _cache[section] = data;
}

/**
 * Get entire section as object.
 */
async function getDynSection(section, defaults = {}) {
  if ((!_loaded || Date.now() - _loadedAt > CACHE_TTL_MS) && _db) await reloadDynConfig();
  const val = _cache[section];
  if (val && typeof val === 'object') return { ...defaults, ...val };
  return defaults;
}

/**
 * Get all config sections as a flat object.
 */
async function getAllDynConfig() {
  if ((!_loaded || Date.now() - _loadedAt > CACHE_TTL_MS) && _db) await reloadDynConfig();
  return { ..._cache };
}

module.exports = { setDb, reloadDynConfig, getDynConfig, setDynConfig, getDynSection, getAllDynConfig };
