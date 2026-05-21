/**
 * F2.3 — Webhooks delivery service
 * Signs payloads with HMAC-SHA256, retries 3 times with backoff.
 */
const crypto = require('crypto');
const dns    = require('dns');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger').child({ module: 'webhooks' });

const RETRY_DELAYS = [5_000, 30_000, 120_000]; // 5s, 30s, 2min

// SSRF protection — mirrors the same logic used in routes/import.js
function _isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'ip6-localhost' || h === '::1' || h === '[::1]') return true;
  const parts = h.replace(/^\[|\]$/g, '').split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p))) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // AWS metadata / link-local
    if (a === 0) return true;
  }
  return false;
}

async function _isWebhookUrlSafe(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (_isPrivateHost(parsed.hostname)) return false;
  // Resolve DNS to catch domains like 169.254.169.254.nip.io
  return new Promise(resolve => {
    dns.lookup(parsed.hostname, (err, address) => {
      if (err || !address || _isPrivateHost(address)) return resolve(false);
      resolve(true);
    });
  });
}

/**
 * Deliver a webhook event to all active webhooks in a workspace.
 * Fire-and-forget safe — all errors are caught.
 */
async function deliverWebhook(workspaceId, event, payload) {
  if (!workspaceId) return;
  const db = require('../db');

  let siteSlug = 'Platform';
  try {
    const { getDynConfig } = require('./dynamicConfig');
    const siteName = await getDynConfig('platform.siteName', 'Platform');
    siteSlug = (siteName || 'Platform').replace(/[^a-zA-Z0-9]/g, '') || 'Platform';
  } catch {}

  let hooks;
  try {
    hooks = await db.prepare(
      `SELECT * FROM webhooks WHERE workspace_id = ? AND enabled = 1`
    ).all(workspaceId);
  } catch (e) {
    logger.error({ err: e.message }, 'Failed to fetch webhooks');
    return;
  }

  for (const hook of hooks) {
    // Check if this hook is subscribed to this event
    let events = [];
    try { events = JSON.parse(hook.events || '[]'); } catch {}
    if (events.length > 0 && !events.includes(event) && !events.includes('*')) continue;

    // Fire delivery asynchronously
    _deliver(hook, event, payload, 0, siteSlug).catch(() => {});
  }
}

async function _deliver(hook, event, payload, attempt, siteSlug = 'Platform') {
  const db = require('../db');
  const deliveryId = uuidv4();
  const body = JSON.stringify({ event, payload, deliveredAt: new Date().toISOString() });
  const sig  = _sign(body, hook.secret || '');

  let statusCode = null;
  let responseBody = null;

  // SSRF check before every delivery (including retries, since DNS can change)
  const urlSafe = await _isWebhookUrlSafe(hook.url);
  if (!urlSafe) {
    logger.warn({ hookId: hook.id, url: hook.url }, 'Webhook URL blocked — resolves to private/reserved address (SSRF)');
    await _saveDelivery(db, hook.id, event, body, 0, 'SSRF: URL blocked').catch(() => {});
    return; // do not retry SSRF-blocked URLs
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const r = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [`X-${siteSlug}-Event`]: event,
        [`X-${siteSlug}-Signature`]: `sha256=${sig}`,
        [`X-${siteSlug}-Delivery`]: deliveryId,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    statusCode = r.status;
    responseBody = (await r.text()).slice(0, 1000);

    await _saveDelivery(db, hook.id, event, body, statusCode, responseBody);

    if (r.ok) {
      logger.info({ hookId: hook.id, event, statusCode }, 'Webhook delivered');
    } else if (attempt < RETRY_DELAYS.length) {
      logger.warn({ hookId: hook.id, event, statusCode, attempt }, 'Webhook failed, will retry');
      setTimeout(() => _deliver(hook, event, payload, attempt + 1, siteSlug), RETRY_DELAYS[attempt]);
    } else {
      logger.error({ hookId: hook.id, event, statusCode }, 'Webhook exhausted retries');
    }
  } catch (err) {
    const errMsg = err.message || 'connection error';
    await _saveDelivery(db, hook.id, event, body, 0, errMsg.slice(0, 500)).catch(() => {});
    if (attempt < RETRY_DELAYS.length) {
      logger.warn({ hookId: hook.id, event, err: errMsg, attempt }, 'Webhook error, will retry');
      setTimeout(() => _deliver(hook, event, payload, attempt + 1, siteSlug), RETRY_DELAYS[attempt]);
    } else {
      logger.error({ hookId: hook.id, event, err: errMsg }, 'Webhook exhausted retries');
    }
  }
}

async function _saveDelivery(db, webhookId, event, payload, statusCode, responseBody) {
  try {
    await db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, response_body)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), webhookId, event, payload, statusCode, responseBody);
  } catch (e) {
    logger.error({ err: e.message }, 'Failed to save webhook delivery');
  }
}

function _sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

module.exports = { deliverWebhook };
