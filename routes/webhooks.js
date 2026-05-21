/**
 * F2.3 — Webhooks management API
 */
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const { checkFeature } = require('../middleware/checkFeature');
const logger = require('../services/logger').child({ module: 'webhooks-routes' });

const VALID_EVENTS = ['video.ready','video.failed','transcription.complete','video.deleted','*'];

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.headers['x-workspace-id']) return res.status(400).json({ error: 'x-workspace-id header required' });
  resolveWorkspace(req, res, next);
});
router.use(checkFeature('webhooks'));

// GET /api/webhooks
router.get('/', async (req, res) => {
  try {
    const hooks = await db.prepare(
      `SELECT id, url, events, enabled, created_at FROM webhooks WHERE workspace_id = ? ORDER BY created_at DESC`
    ).all(req.workspace.id);
    res.json(hooks.map(h => {
      let events = [];
      try { events = JSON.parse(h.events || '[]'); } catch {}
      return { ...h, events };
    }));
  } catch (err) {
    logger.error({ err }, 'List webhooks error');
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// POST /api/webhooks
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { url, events, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (typeof url !== 'string' || url.length > 2000) return res.status(400).json({ error: 'URL demasiado larga (máx 2000 caracteres)' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const evList = Array.isArray(events) ? events.filter(e => VALID_EVENTS.includes(e)) : ['*'];
    const hookSecret = secret || crypto.randomBytes(24).toString('hex');
    const id = uuidv4();

    await db.prepare(
      `INSERT INTO webhooks (id, workspace_id, url, events, secret, enabled) VALUES (?, ?, ?, ?, ?, 1)`
    ).run(id, req.workspace.id, url, JSON.stringify(evList), hookSecret);

    logger.info({ workspaceId: req.workspace.id, hookId: id }, 'Webhook created');
    res.status(201).json({ id, url, events: evList, secret: hookSecret });
  } catch (err) {
    logger.error({ err }, 'Create webhook error');
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// PATCH /api/webhooks/:id
router.patch('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const hook = await db.prepare(`SELECT id FROM webhooks WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });

    const { url, events, enabled } = req.body;
    if (url) {
      if (typeof url !== 'string' || url.length > 2000) return res.status(400).json({ error: 'URL demasiado larga (máx 2000 caracteres)' });
      try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    }
    const evList = Array.isArray(events) ? JSON.stringify(events.filter(e => VALID_EVENTS.includes(e))) : null;

    await db.prepare(`
      UPDATE webhooks SET
        url = COALESCE(?, url),
        events = COALESCE(?, events),
        enabled = COALESCE(?, enabled)
      WHERE id = ?
    `).run(url || null, evList, typeof enabled === 'boolean' ? (enabled ? 1 : 0) : null, req.params.id);

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Update webhook error');
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

// DELETE /api/webhooks/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const hook = await db.prepare(`SELECT id FROM webhooks WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    await db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(req.params.id);
    logger.info({ workspaceId: req.workspace.id, hookId: req.params.id }, 'Webhook deleted');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Delete webhook error');
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// GET /api/webhooks/:id/deliveries — last 50 deliveries
router.get('/:id/deliveries', async (req, res) => {
  try {
    const hook = await db.prepare(`SELECT id FROM webhooks WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspace.id);
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const deliveries = await db.prepare(
      `SELECT id, event, status_code, created_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(req.params.id, limit);
    res.json(deliveries);
  } catch (err) {
    logger.error({ err }, 'List webhook deliveries error');
    res.status(500).json({ error: 'Failed to list deliveries' });
  }
});

module.exports = router;
