/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Gateway Credentials Service
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Stores/retrieves payment gateway credentials from system_config table.
 * Credentials are encrypted at rest using AES-256-GCM derived from JWT_SECRET.
 * 
 * This allows Super Admins to configure gateways from the UI
 * without editing .env files or restarting the server.
 * 
 * DB-stored credentials take precedence over .env values.
 */

const crypto = require('crypto');
const db = require('../db');
const logger = require('./logger').child({ module: 'gatewayCredentials' });

// Derive encryption key from JWT_SECRET (or a dedicated GATEWAY_ENCRYPT_KEY)
function getEncryptionKey() {
  const secret = process.env.GATEWAY_ENCRYPT_KEY || process.env.JWT_SECRET || 'fallback-dev-key-not-for-production';
  return crypto.createHash('sha256').update(secret).digest(); // 32 bytes for AES-256
}

function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // Format: iv:authTag:ciphertext
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedStr) {
  if (!encryptedStr || !encryptedStr.includes(':')) return '';
  try {
    const parts = encryptedStr.split(':');
    if (parts.length !== 3) return '';
    const [ivHex, authTagHex, ciphertext] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to decrypt gateway credential');
    return '';
  }
}

// In-memory cache for decrypted credentials
let _credCache = {};
let _credCacheLoadedAt = 0;
const CACHE_TTL = 30_000; // 30 seconds

/**
 * Load all gateway credentials from system_config
 */
async function loadAllCredentials() {
  try {
    const row = await db.prepare(
      `SELECT value FROM system_config WHERE key = 'gateway_credentials'`
    ).get();

    if (!row?.value) {
      _credCache = {};
      _credCacheLoadedAt = Date.now();
      return {};
    }

    const stored = JSON.parse(row.value);
    // Decrypt all values
    const decrypted = {};
    for (const [provider, creds] of Object.entries(stored)) {
      decrypted[provider] = {};
      for (const [key, val] of Object.entries(creds || {})) {
        decrypted[provider][key] = decrypt(val);
      }
    }

    _credCache = decrypted;
    _credCacheLoadedAt = Date.now();
    return decrypted;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load gateway credentials');
    return {};
  }
}

/**
 * Get credentials for a specific provider.
 * Returns an object with the provider's credential fields, or empty object.
 */
async function getCredentials(provider) {
  if (Date.now() - _credCacheLoadedAt > CACHE_TTL) {
    await loadAllCredentials();
  }
  return _credCache[provider] || {};
}

/**
 * Save credentials for a specific provider.
 * Only non-empty values are encrypted and stored.
 * Empty strings mean "use .env fallback".
 */
async function saveCredentials(provider, credentials) {
  // Load current full set
  let allStored = {};
  try {
    const row = await db.prepare(
      `SELECT value FROM system_config WHERE key = 'gateway_credentials'`
    ).get();
    if (row?.value) allStored = JSON.parse(row.value);
  } catch {}

  // Encrypt non-empty values
  const encrypted = {};
  for (const [key, val] of Object.entries(credentials || {})) {
    if (val && val.trim()) {
      encrypted[key] = encrypt(val.trim());
    }
    // If empty, don't store (will fallback to .env)
  }

  allStored[provider] = encrypted;

  // Save to DB
  const nowUnix = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO system_config (key, value, updated_at)
     VALUES ('gateway_credentials', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(JSON.stringify(allStored), nowUnix);

  // Invalidate cache
  _credCacheLoadedAt = 0;
  _credCache = {};

  logger.info({ provider }, 'Gateway credentials saved');
}

/**
 * Get a single credential value for a provider.
 * Priority: DB stored value > process.env fallback
 */
async function getCredential(provider, key, envFallback = '') {
  const creds = await getCredentials(provider);
  const dbVal = creds[key];
  if (dbVal && dbVal.trim()) return dbVal;
  return envFallback;
}

/**
 * Check if a provider has minimum required credentials configured
 * (either in DB or env)
 */
async function isConfigured(provider) {
  const creds = await getCredentials(provider);

  switch (provider) {
    case 'stripe': {
      const key = creds.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';
      return !!(key && !key.startsWith('sk_test_...'));
    }
    case 'paypal': {
      const clientId = creds.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || '';
      const clientSecret = creds.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET || '';
      return !!(clientId && clientSecret);
    }
    case 'dlocalgo': {
      const apiKey = creds.DLOCALGO_API_KEY || process.env.DLOCALGO_API_KEY || '';
      const secretKey = creds.DLOCALGO_SECRET_KEY || process.env.DLOCALGO_SECRET_KEY || '';
      return !!(apiKey && secretKey);
    }
    case 'binance': {
      const apiKey = creds.BINANCE_API_KEY || process.env.BINANCE_API_KEY || '';
      const secretKey = creds.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET_KEY || '';
      const merchantId = creds.BINANCE_MERCHANT_ID || process.env.BINANCE_MERCHANT_ID || '';
      return !!(apiKey && secretKey && merchantId);
    }
    default:
      return false;
  }
}

/**
 * Get full status for a provider (for admin panel display)
 */
async function getProviderStatus(provider) {
  const creds = await getCredentials(provider);

  switch (provider) {
    case 'stripe': {
      const key = creds.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';
      const webhookSecret = creds.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
      const priceStarter = creds.STRIPE_PRICE_STARTER || process.env.STRIPE_PRICE_STARTER || '';
      const pricePro = creds.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_PRO || '';
      const priceEnterprise = creds.STRIPE_PRICE_ENTERPRISE || process.env.STRIPE_PRICE_ENTERPRISE || '';
      return {
        configured: !!(key && !key.startsWith('sk_test_...')),
        hasWebhookSecret: !!webhookSecret,
        hasPriceIds: !!(priceStarter && pricePro && priceEnterprise),
      };
    }
    case 'paypal': {
      const clientId = creds.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || '';
      const clientSecret = creds.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET || '';
      const webhookId = creds.PAYPAL_WEBHOOK_ID || process.env.PAYPAL_WEBHOOK_ID || '';
      const planStarter = creds.PAYPAL_PLAN_STARTER || process.env.PAYPAL_PLAN_STARTER || '';
      const planPro = creds.PAYPAL_PLAN_PRO || process.env.PAYPAL_PLAN_PRO || '';
      const planEnterprise = creds.PAYPAL_PLAN_ENTERPRISE || process.env.PAYPAL_PLAN_ENTERPRISE || '';
      const mode = creds.PAYPAL_MODE || process.env.PAYPAL_MODE || 'sandbox';
      return {
        configured: !!(clientId && clientSecret),
        hasWebhookId: !!webhookId,
        hasPlanIds: !!(planStarter && planPro && planEnterprise),
        mode,
      };
    }
    case 'dlocalgo': {
      const apiKey = creds.DLOCALGO_API_KEY || process.env.DLOCALGO_API_KEY || '';
      const secretKey = creds.DLOCALGO_SECRET_KEY || process.env.DLOCALGO_SECRET_KEY || '';
      const planStarter = creds.DLOCALGO_PLAN_STARTER || process.env.DLOCALGO_PLAN_STARTER || '';
      const planPro = creds.DLOCALGO_PLAN_PRO || process.env.DLOCALGO_PLAN_PRO || '';
      const planEnterprise = creds.DLOCALGO_PLAN_ENTERPRISE || process.env.DLOCALGO_PLAN_ENTERPRISE || '';
      const mode = creds.DLOCALGO_MODE || process.env.DLOCALGO_MODE || 'sandbox';
      return {
        configured: !!(apiKey && secretKey),
        hasPlanIds: !!(planStarter && planPro && planEnterprise),
        mode,
      };
    }
    case 'binance': {
      const apiKey = creds.BINANCE_API_KEY || process.env.BINANCE_API_KEY || '';
      const secretKey = creds.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET_KEY || '';
      const merchantId = creds.BINANCE_MERCHANT_ID || process.env.BINANCE_MERCHANT_ID || '';
      const priceStarter = creds.BINANCE_PRICE_STARTER || process.env.BINANCE_PRICE_STARTER || '';
      const pricePro = creds.BINANCE_PRICE_PRO || process.env.BINANCE_PRICE_PRO || '';
      const priceEnterprise = creds.BINANCE_PRICE_ENTERPRISE || process.env.BINANCE_PRICE_ENTERPRISE || '';
      const mode = creds.BINANCE_MODE || process.env.BINANCE_MODE || 'sandbox';
      return {
        configured: !!(apiKey && secretKey && merchantId),
        hasPrices: !!(priceStarter && pricePro && priceEnterprise),
        mode,
      };
    }
    default:
      return { configured: false };
  }
}

/**
 * Invalidate the credentials cache (call after saving new credentials)
 */
function invalidateCache() {
  _credCacheLoadedAt = 0;
  _credCache = {};
}

module.exports = {
  encrypt,
  decrypt,
  getCredentials,
  saveCredentials,
  getCredential,
  isConfigured,
  getProviderStatus,
  loadAllCredentials,
  invalidateCache,
};
