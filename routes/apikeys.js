/**
 * API Keys — Pro+ plan feature.
 * Keys use the format sv_live_<32-hex-random>.
 * Only the prefix (first 12 chars) is stored in plain text; the rest is bcrypt-hashed.
 *
 * SCOPES available:
 *   videos:read    — GET videos, metadata, token, HLS key
 *   videos:write   — Upload, PATCH video metadata, set thumbnail
 *   videos:delete  — DELETE videos
 *   analytics:read — GET analytics, events
 *   uploads:write  — POST /api/upload
 *
 * GET    /api/apikeys          — list workspace keys (no secrets)
 * POST   /api/apikeys          — create key (returns full key ONCE)
 * DELETE /api/apikeys/:id      — revoke key
 */
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const { checkFeature } = require('../middleware/checkFeature');
const config   = require('../config');
const logger   = require('../services/logger').child({ module: 'apikeys' });

// ─── Valid scopes ──────────────────────────────────────────────────────────────
const VALID_SCOPES = new Set([
  'videos:read',    // GET video metadata, HLS token, thumbnail
  'videos:write',   // PATCH metadata, set thumbnail, retry transcoding
  'videos:delete',  // DELETE videos
  'analytics:read', // GET analytics, events
  'uploads:write',  // POST /api/upload
]);

const DEFAULT_SCOPES = ['videos:read'];

// Static list of scopes — no workspace context required
router.get('/scopes', authenticate, (req, res) => {
  res.json({
    scopes: [
      { id: 'videos:read',    description: 'Leer metadatos de videos, obtener tokens HLS y miniaturas' },
      { id: 'videos:write',   description: 'Modificar metadatos, subir miniaturas, reintentar transcoding' },
      { id: 'videos:delete',  description: 'Eliminar videos' },
      { id: 'analytics:read', description: 'Ver analíticas y eventos de reproducción' },
      { id: 'uploads:write',  description: 'Subir nuevos videos via API' },
    ],
  });
});

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.headers['x-workspace-id']) {
    return res.status(400).json({ error: 'x-workspace-id header required' });
  }
  resolveWorkspace(req, res, next);
});
router.use(checkFeature('apiKeys'));

router.get('/', async (req, res) => {
  try {
    const keys = await db.prepare(
      `SELECT id, name, prefix, scopes, last_used_at, created_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC`
    ).all(req.workspace.id);
    res.json(keys.map(k => ({
      ...k,
      scopes: (() => { try { return JSON.parse(k.scopes || '[]'); } catch { return DEFAULT_SCOPES; } })(),
    })));
  } catch (err) {
    logger.error({ err }, 'list api keys failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, scopes } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.trim().length > 80) {
      return res.status(400).json({ error: 'name must be 80 characters or fewer' });
    }

    // ── Validate scopes ──────────────────────────────────────────────────────
    let finalScopes = DEFAULT_SCOPES;
    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return res.status(400).json({ error: 'scopes must be a non-empty array' });
      }
      const invalid = scopes.filter(s => !VALID_SCOPES.has(s));
      if (invalid.length) {
        return res.status(400).json({
          error: `Invalid scopes: ${invalid.join(', ')}. Valid scopes: ${[...VALID_SCOPES].join(', ')}`,
        });
      }
      finalScopes = [...new Set(scopes)]; // deduplicate
    }

    const count = await db.prepare(`SELECT COUNT(*) AS cnt FROM api_keys WHERE workspace_id = ?`).get(req.workspace.id);
    if (Number(count.cnt) >= 20) {
      return res.status(400).json({ error: 'Maximum 20 API keys per workspace' });
    }

    const rawSecret = crypto.randomBytes(32).toString('hex');
    const fullKey   = `sv_live_${rawSecret}`;
    const prefix    = fullKey.slice(0, 12);
    const keyHash   = await bcrypt.hash(fullKey, config.bcryptRounds);

    const id = uuidv4();
    await db.prepare(`
      INSERT INTO api_keys (id, workspace_id, name, key_hash, prefix, scopes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.workspace.id, name.trim(), keyHash, prefix, JSON.stringify(finalScopes));

    const { logAudit } = require('../services/auditLog');
    logAudit(req, 'apikey.created', 'api_key', id, { workspaceId: req.workspace.id, name: name.trim(), scopes: finalScopes }).catch(() => {});
    logger.info({ workspaceId: req.workspace.id, keyId: id, scopes: finalScopes }, 'API key created');

    res.status(201).json({
      id,
      name: name.trim(),
      prefix,
      scopes: finalScopes,
      key: fullKey,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    logger.error({ err }, 'create api key failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const key = await db.prepare(
      `SELECT id FROM api_keys WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!key) return res.status(404).json({ error: 'Not found' });

    await db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(key.id);
    const { logAudit } = require('../services/auditLog');
    logAudit(req, 'apikey.revoked', 'api_key', key.id, { workspaceId: req.workspace.id }).catch(() => {});
    logger.info({ workspaceId: req.workspace.id, keyId: key.id }, 'API key revoked');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'delete api key failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});


module.exports = router;
