/**
 * F2.4 — Bulk video operations
 * POST /api/videos/bulk
 */
const express = require('express');
const router  = express.Router();
const db = require('../db');
const path = require('path');
const fs   = require('fs');
const bcrypt = require('bcryptjs');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const s3 = require('../services/s3Storage');
const logger = require('../services/logger').child({ module: 'bulk' });
const { deliverWebhook } = require('../services/webhooks');

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.headers['x-workspace-id']) return res.status(400).json({ error: 'x-workspace-id header required' });
  resolveWorkspace(req, res, next);
});

// POST /api/videos/bulk
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { ids, action, folderId, visibility } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  if (ids.length > 200) return res.status(400).json({ error: 'Max 200 videos per bulk operation' });
  if (!['delete', 'move', 'visibility'].includes(action)) return res.status(400).json({ error: 'action must be delete|move|visibility' });

  // Verify all videos belong to this workspace
  const placeholders = ids.map(() => '?').join(',');
  let videos;
  try {
    videos = await db.prepare(
      `SELECT id, s3_object_prefix, size FROM videos WHERE id IN (${placeholders}) AND workspace_id = ?`
    ).all(...ids, req.workspace.id);
  } catch (err) {
    logger.error({ err }, 'Bulk: failed to verify video ownership');
    return res.status(500).json({ error: 'Failed to process bulk operation' });
  }

  if (videos.length !== ids.length) {
    return res.status(403).json({ error: 'Some videos were not found or do not belong to this workspace' });
  }

  if (action === 'delete') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM videos WHERE id = ANY($1) AND workspace_id = $2`,
        [ids, req.workspace.id]
      );
      // Recalculate storage
      const totalSize = videos.reduce((s, v) => s + (Number(v.size) || 0), 0);
      if (totalSize > 0) {
        await client.query(
          `UPDATE workspaces SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2`,
          [totalSize, req.workspace.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err }, 'Bulk delete failed');
      return res.status(500).json({ error: 'Bulk delete failed' });
    } finally {
      client.release();
    }
    // Cleanup files async + CDN invalidation + fire webhooks
    const cdnPaths = [];
    for (const v of videos) {
      if (s3.isS3Enabled() && v.s3_object_prefix) {
        s3.deleteObjectsWithPrefix(v.s3_object_prefix).catch(() => {});
        cdnPaths.push(`/${v.s3_object_prefix}/*`);
      }
      try { fs.rmSync(path.join(__dirname, '..', 'videos', v.id), { recursive: true, force: true }); } catch {}
    }
    if (cdnPaths.length) s3.invalidateCDN(cdnPaths).catch(() => {});
    deliverWebhook(req.workspace.id, 'video.deleted', {
      videoIds: videos.map(v => v.id),
      count: videos.length,
    }).catch(() => {});
    return res.json({ success: true, affected: videos.length });
  }

  if (action === 'move') {
    try {
      if (folderId) {
        const folder = await db.prepare(
          `SELECT id FROM folders WHERE id = ? AND workspace_id = ?`
        ).get(folderId, req.workspace.id);
        if (!folder) return res.status(404).json({ error: 'Folder not found' });
      }
      await db.prepare(
        `UPDATE videos SET folder_id = ? WHERE id IN (${placeholders}) AND workspace_id = ?`
      ).run(folderId || null, ...ids, req.workspace.id);
      return res.json({ success: true, affected: ids.length });
    } catch (err) {
      logger.error({ err }, 'Bulk move failed');
      return res.status(500).json({ error: 'Bulk move failed' });
    }
  }

  if (action === 'visibility') {
    if (!['public', 'private', 'unlisted', 'password'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be public|private|unlisted|password' });
    }
    const { access_password } = req.body;
    if (visibility === 'password') {
      if (!access_password || typeof access_password !== 'string' || access_password.length < 4) {
        return res.status(400).json({ error: 'access_password is required when visibility is password (min 4 chars)' });
      }
    }
    try {
      if (visibility === 'password') {
        const hash = await bcrypt.hash(access_password, 10);
        await db.prepare(
          `UPDATE videos SET visibility = ?, access_password_hash = ?, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id IN (${placeholders}) AND workspace_id = ?`
        ).run(visibility, hash, ...ids, req.workspace.id);
      } else {
        await db.prepare(
          `UPDATE videos SET visibility = ?, access_password_hash = NULL, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id IN (${placeholders}) AND workspace_id = ?`
        ).run(visibility, ...ids, req.workspace.id);
      }
      return res.json({ success: true, affected: ids.length });
    } catch (err) {
      logger.error({ err }, 'Bulk visibility update failed');
      return res.status(500).json({ error: 'Bulk visibility update failed' });
    }
  }
});

module.exports = router;
