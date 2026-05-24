/**
 * F2.2 — Playlists API
 */
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const logger = require('../services/logger').child({ module: 'playlists' });

// ─── Public endpoints (no auth required) ─────────────────────────────────────
// NOTE: These MUST be registered BEFORE the auth middleware applied below.

// Public embed endpoint — used by /playlist/:id and /embed/playlist/:id pages.
// No auth needed: external viewers/iframes must be able to load playlist data.
router.get('/:id/embed', async (req, res) => {
  try {
    const pl = await db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(req.params.id);
    if (!pl || pl.visibility !== 'public') {
      return res.status(404).json({ error: 'Playlist not found or private' });
    }
    const ws = await db.prepare(`SELECT settings FROM workspaces WHERE id = ?`).get(pl.workspace_id);
    const wsSettings = (() => { try { return JSON.parse(ws?.settings || '{}'); } catch { return {}; } })();
    if (wsSettings.playlistsPublic === false) {
      return res.status(404).json({ error: 'Playlist not found or private' });
    }
    const rawVideos = await db.prepare(`
      SELECT v.id, v.title, v.duration, v.hls_cdn_url, v.thumbnail_url FROM playlist_videos pv
      JOIN videos v ON v.id = pv.video_id
      WHERE pv.playlist_id = ? AND v.status = 'ready' AND (v.dmca_suspended IS NULL OR v.dmca_suspended = FALSE) ORDER BY pv.position ASC
    `).all(req.params.id);
    const videos = rawVideos.map(v => {
      const base = v.hls_cdn_url ? v.hls_cdn_url.replace(/\/master\.m3u8$/i, '') : null;
      return {
        ...v,
        thumbnailUrl: v.thumbnail_url || (base ? `${base}/thumb.jpg` : `/videos/${v.id}/thumb.jpg`),
      };
    });
    res.json({ ...pl, videos });
  } catch (err) {
    logger.error({ err }, 'embed playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Authenticated + workspace endpoints ─────────────────────────────────────
// All routes below require a valid session token and x-workspace-id header.

const ws = [
  authenticate,
  (req, res, next) => {
    if (!req.headers['x-workspace-id']) {
      return res.status(400).json({ error: 'x-workspace-id header required' });
    }
    resolveWorkspace(req, res, next);
  },
];

// GET /api/playlists
router.get('/', ws, async (req, res) => {
  try {
    const playlists = await db.prepare(
      `SELECT p.*, COUNT(pv.id) as video_count FROM playlists p
       LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
       WHERE p.workspace_id = ?
       GROUP BY p.id ORDER BY p.created_at DESC`
    ).all(req.workspace.id);
    res.json(playlists);
  } catch (err) {
    logger.error({ err }, 'list playlists failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/playlists/:id
router.get('/:id', ws, async (req, res) => {
  try {
    const playlist = await db.prepare(
      `SELECT * FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    res.json(playlist);
  } catch (err) {
    logger.error({ err }, 'get playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/playlists
router.post('/', ws, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { title, description, visibility } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (title.trim().length > 200) return res.status(400).json({ error: 'title too long (max 200 chars)' });
    if (description && String(description).length > 2000) return res.status(400).json({ error: 'description too long (max 2000 chars)' });
    const id = uuidv4();
    const playlistsPublic = req.workspace.settings?.playlistsPublic !== false;
    const finalVisibility = !playlistsPublic ? 'private'
      : (['public', 'private'].includes(visibility) ? visibility : 'public');
    await db.prepare(
      `INSERT INTO playlists (id, workspace_id, title, description, visibility) VALUES (?, ?, ?, ?, ?)`
    ).run(
      id,
      req.workspace.id,
      title.trim(),
      description || '',
      finalVisibility
    );
    res.status(201).json({ id, title: title.trim() });
  } catch (err) {
    logger.error({ err }, 'create playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/playlists/:id
router.patch('/:id', ws, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const pl = await db.prepare(
      `SELECT id FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!pl) return res.status(404).json({ error: 'Not found' });

    const { title, description, visibility } = req.body;
    if (title !== undefined && String(title).trim().length > 200) return res.status(400).json({ error: 'title too long (max 200 chars)' });
    if (description !== undefined && String(description).length > 2000) return res.status(400).json({ error: 'description too long (max 2000 chars)' });
    const playlistsPublic = req.workspace.settings?.playlistsPublic !== false;
    let newVisibility = ['public', 'private'].includes(visibility) ? visibility : null;
    if (newVisibility === 'public' && !playlistsPublic) newVisibility = 'private';
    await db.prepare(`
      UPDATE playlists SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        visibility = COALESCE(?, visibility),
        updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ?
    `).run(
      title || null,
      description ?? null,
      newVisibility,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'update playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/playlists/:id
router.delete('/:id', ws, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const pl = await db.prepare(
      `SELECT id FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!pl) return res.status(404).json({ error: 'Not found' });

    // Also delete playlist_videos entries (cascade)
    await db.prepare(`DELETE FROM playlist_videos WHERE playlist_id = ?`).run(req.params.id);
    await db.prepare(`DELETE FROM playlists WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'delete playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/playlists/:id/videos
router.get('/:id/videos', ws, async (req, res) => {
  try {
    const pl = await db.prepare(
      `SELECT id FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!pl) return res.status(404).json({ error: 'Not found' });

    const videos = await db.prepare(`
      SELECT v.*, pv.position FROM playlist_videos pv
      JOIN videos v ON v.id = pv.video_id
      WHERE pv.playlist_id = ? ORDER BY pv.position ASC
    `).all(req.params.id);
    // Compute thumbnailUrl for each video (same logic as routes/videos.js playbackUrls)
    const mapped = videos.map(v => {
      const base = v.hls_cdn_url ? v.hls_cdn_url.replace(/\/master\.m3u8$/i, '') : null;
      return {
        ...v,
        thumbnailUrl: v.thumbnail_url || (base ? `${base}/thumb.jpg` : `/videos/${v.id}/thumb.jpg`),
      };
    });
    res.json(mapped);
  } catch (err) {
    logger.error({ err }, 'list playlist videos failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/playlists/:id/videos
router.post('/:id/videos', ws, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const pl = await db.prepare(
      `SELECT id FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });

    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ error: 'video_id required' });

    const video = await db.prepare(
      `SELECT id FROM videos WHERE id = ? AND workspace_id = ?`
    ).get(video_id, req.workspace.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const maxPos = await db.prepare(
      `SELECT COALESCE(MAX(position), -1) as m FROM playlist_videos WHERE playlist_id = ?`
    ).get(req.params.id);
    const position = (maxPos?.m ?? -1) + 1;
    const id = uuidv4();

    try {
      await db.prepare(
        `INSERT INTO playlist_videos (id, playlist_id, video_id, position) VALUES (?, ?, ?, ?)`
      ).run(id, req.params.id, video_id, position);
      res.status(201).json({ id, position });
    } catch (e) {
      if (e.message?.includes('unique') || e.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Video already in playlist' });
      }
      throw e;
    }
  } catch (err) {
    if (err.status) return; // already responded
    logger.error({ err }, 'add video to playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/playlists/:id/videos/:videoId
router.delete('/:id/videos/:videoId', ws, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const playlist = await db.prepare(
      `SELECT id FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    await db.prepare(
      `DELETE FROM playlist_videos WHERE playlist_id = ? AND video_id = ?`
    ).run(req.params.id, req.params.videoId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'remove video from playlist failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/playlists/:id/videos/:videoId/position
router.patch('/:id/videos/:videoId/position', ws, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const playlist = await db.prepare(
      `SELECT id FROM playlists WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const { position } = req.body;
    if (typeof position !== 'number') {
      return res.status(400).json({ error: 'position (number) required' });
    }
    await db.prepare(
      `UPDATE playlist_videos SET position = ? WHERE playlist_id = ? AND video_id = ?`
    ).run(position, req.params.id, req.params.videoId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'reorder playlist video failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
