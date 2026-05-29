const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const db     = require('../db');

// ─── API Key Scope definitions ────────────────────────────────────────────────
// Used by requireScope() to enforce minimum permissions on API key requests.
const SCOPE_READ_VIDEOS    = 'videos:read';
const SCOPE_WRITE_VIDEOS   = 'videos:write';
const SCOPE_DELETE_VIDEOS  = 'videos:delete';
const SCOPE_READ_ANALYTICS = 'analytics:read';
const SCOPE_WRITE_UPLOADS  = 'uploads:write';

/**
 * Enforce a required scope for API key requests.
 * JWT (user) requests always pass — scopes only apply to sv_live_ API keys.
 * Usage: router.delete('/:id', authenticate, requireScope('videos:delete'), handler)
 */
function requireScope(scope) {
  return (req, res, next) => {
    // JWT users have full access — scopes only restrict API keys
    if (!req.isApiKey) return next();
    const scopes = req.apiKeyScopes || [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({
        error: `Insufficient permissions. Required scope: ${scope}`,
        yourScopes: scopes,
      });
    }
    next();
  };
}

// Resolve an sv_live_xxx API key → workspace context
async function resolveApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('sv_live_')) return null;
  const prefix = rawKey.slice(0, 12);
  const rows = await db.prepare(
    `SELECT ak.id, ak.key_hash, ak.workspace_id, ak.scopes, ak.expires_at, ak.disabled, w.owner_id
     FROM api_keys ak JOIN workspaces w ON w.id = ak.workspace_id
     WHERE ak.prefix = ?`
  ).all(prefix);
  for (const row of rows) {
    if (await bcrypt.compare(rawKey, row.key_hash)) {
      if (row.disabled) return null;
      if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return null;
      // Async update last_used_at — fire and forget
      db.prepare(`UPDATE api_keys SET last_used_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`)
        .run(row.id).catch(() => {});
      return row;
    }
  }
  return null;
}

/**
 * Check if a JWT token ID (jti) has been revoked.
 * Revoked tokens are stored in the revoked_tokens table.
 * Only called when jti is present (new tokens); old tokens without jti still work.
 */
async function isTokenRevoked(jti, userId) {
  // [CRIT-05] Legacy tokens without jti are treated as revoked (fail-closed)
  // Forces re-login for tokens issued before jti was implemented
  if (!jti) return true;
  try {
    const row = await db.prepare(
      `SELECT 1 FROM revoked_tokens WHERE jti = ? AND user_id = ? AND expires_at > FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`
    ).get(jti, userId);
    return !!row;
  } catch (err) {
    // [CRIT-04] Fail-closed: if we cannot verify revocation, block the token
    const logger = require('../services/logger').child({ module: 'auth' });
    logger.error({ err: err?.message }, 'Token revocation check failed — blocking token (fail-closed)');
    return true;
  }
}

async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Provide Authorization: Bearer <token>' });
  }

  // API key path
  if (token.startsWith('sv_live_')) {
    try {
      const apiKey = await resolveApiKey(token);
      if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });
      const owner = await db.prepare(
        `SELECT id, email, name, COALESCE(platform_role,'user') AS platform_role FROM users WHERE id = ?`
      ).get(apiKey.owner_id);
      if (!owner) return res.status(401).json({ error: 'Invalid API key' });
      req.user = owner;
      req.isApiKey = true;
      req.apiKeyWorkspaceId = apiKey.workspace_id;
      try {
        req.apiKeyScopes = JSON.parse(apiKey.scopes || '["videos:read"]');
      } catch {
        req.apiKeyScopes = ['videos:read'];
      }
      req.headers['x-workspace-id'] = apiKey.workspace_id;
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'Authentication error' });
    }
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);

    // ── JWT Revocation check ──────────────────────────────────────────────────
    if (decoded.jti && await isTokenRevoked(decoded.jti, decoded.userId)) {
      return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
    }

    const user = await db.prepare(
      `SELECT id, email, name, channel_name, username, avatar_url, created_at, password_changed_at, COALESCE(platform_role, 'user') as platform_role FROM users WHERE id = ?`
    ).get(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // ── Password-change invalidation ─────────────────────────────────────────
    // If the user changed/reset their password after this token was issued,
    // reject it so stolen tokens become useless immediately after a reset.
    // decoded.iat is seconds since epoch (set by jsonwebtoken automatically).
    if (user.password_changed_at && decoded.iat && decoded.iat < user.password_changed_at) {
      return res.status(401).json({ error: 'Token invalidated by password change. Please log in again.', code: 'PASSWORD_CHANGED' });
    }

    req.user = user;
    req.tokenJti = decoded.jti || null; // Store jti for potential revocation on logout
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);

    // Check revocation for optional auth too
    if (decoded.jti && await isTokenRevoked(decoded.jti, decoded.userId)) {
      req.user = null;
      return next();
    }

    const user = await db.prepare(
      `SELECT id, email, name, channel_name, username, avatar_url, created_at, COALESCE(platform_role, 'user') as platform_role FROM users WHERE id = ?`
    ).get(decoded.userId);
    req.user = user || null;
    if (user) req.tokenJti = decoded.jti || null;
  } catch {
    req.user = null;
  }
  next();
}

async function superAdminAuth(req, res, next) {
  if (config.adminApiKey) {
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const secret   = config.adminApiKey;
    const match    = provided.length === secret.length &&
                     crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (match) {
      req.user = { id: 'admin', email: 'admin', name: 'Admin', platform_role: 'super_admin', isApiKey: true };
      return next();
    }
  }

  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // SSE FIX: EventSource can't send custom headers, so accept token from query param
  // This is specifically for /metrics/stream endpoint which uses Server-Sent Events
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);

    // Check revocation
    if (decoded.jti && await isTokenRevoked(decoded.jti, decoded.userId)) {
      return res.status(401).json({ error: 'Token has been revoked', code: 'TOKEN_REVOKED' });
    }

    const user = await db.prepare(
      `SELECT id, email, name, channel_name, username, avatar_url, created_at, COALESCE(platform_role, 'user') as platform_role FROM users WHERE id = ?`
    ).get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    req.user = user;
    req.tokenJti = decoded.jti || null;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/** @deprecated use superAdminAuth */
const adminAuth = superAdminAuth;

module.exports = {
  authenticate,
  optionalAuth,
  adminAuth,
  superAdminAuth,
  requireScope,
  isTokenRevoked,
  SCOPE_READ_VIDEOS,
  SCOPE_WRITE_VIDEOS,
  SCOPE_DELETE_VIDEOS,
  SCOPE_READ_ANALYTICS,
  SCOPE_WRITE_UPLOADS,
};
