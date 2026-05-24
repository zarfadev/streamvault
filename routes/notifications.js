/**
 * In-app notifications.
 *
 * GET    /api/notifications          — list for current user (latest 50)
 * GET    /api/notifications/unread-count — unread count
 * PATCH  /api/notifications/:id/read — mark one read
 * PATCH  /api/notifications/read-all — mark all read
 * DELETE /api/notifications/:id      — delete one notification
 * DELETE /api/notifications          — delete all notifications for user
 */
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT * FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(req.user.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS cnt FROM notifications
      WHERE user_id = ? AND read_at IS NULL
    `).get(req.user.id);
    res.json({ count: Number(row?.cnt || 0) });
  } catch {
    res.json({ count: 0 });
  }
});

router.patch('/read-all', authenticate, async (req, res) => {
  try {
    await db.prepare(`
      UPDATE notifications
      SET read_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE user_id = ? AND read_at IS NULL
    `).run(req.user.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    await db.prepare(`
      UPDATE notifications
      SET read_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ? AND user_id = ? AND read_at IS NULL
    `).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

router.delete('/', authenticate, async (req, res) => {
  try {
    await db.prepare(`
      DELETE FROM notifications WHERE user_id = ?
    `).run(req.user.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    await db.prepare(`
      DELETE FROM notifications WHERE id = ? AND user_id = ?
    `).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

/**
 * createNotification — called internally from transcoder/worker/routes.
 * Not exposed as an HTTP endpoint.
 */
async function createNotification({ userId, workspaceId = null, kind = 'info', title, body = '', link = null }) {
  try {
    if (!userId || !title) return;
    await db.prepare(`
      INSERT INTO notifications (id, user_id, workspace_id, kind, title, body, link)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), userId, workspaceId || null, kind, title, body || '', link || null);
  } catch (err) {
    // Non-fatal — don't let notification failures break the main flow
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
