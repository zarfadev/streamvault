const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db');
const { authenticate, optionalAuth } = require('../middleware/auth');

// All three routes use optionalAuth:
//   • GET  — anonymous viewers get position:0 (no 401 noise in console)
//   • POST — sendBeacon passes JWT via ?token= query string (no headers)
//   • DELETE — silently ignored when unauthenticated

router.get('/', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ position: 0 });
  try {
    const row = await db.prepare(
      `SELECT position FROM video_progress WHERE user_id = ? AND video_id = ?`
    ).get(req.user.id, req.params.videoId);
    res.json({ position: row ? row.position : 0 });
  } catch {
    res.json({ position: 0 });
  }
});

router.post('/', optionalAuth, async (req, res) => {
  // When called via sendBeacon the JWT may arrive as a query-string parameter
  // because sendBeacon cannot set custom headers.  optionalAuth already reads
  // req.headers['authorization'], so we manually handle the ?token= fallback.
  if (!req.user && req.query.token) {
    try {
      const jwt = require('jsonwebtoken');
      const config = require('../config');
      const payload = jwt.verify(req.query.token, config.jwtSecret);
      // Minimal user object — only id is needed for progress writes
      req.user = { id: payload.sub || payload.id || payload.userId };
    } catch (_) { /* invalid token — treat as unauthenticated */ }
  }

  // Unauthenticated viewers cannot persist server-side progress — silently ok
  if (!req.user) return res.json({ ok: true, saved: false });

  const pos = parseFloat(req.body?.position);
  if (isNaN(pos) || pos < 0) return res.status(400).json({ error: 'Invalid position' });

  try {
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`
      INSERT INTO video_progress (user_id, video_id, position, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, video_id)
      DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at
    `).run(req.user.id, req.params.videoId, pos, now);
    res.json({ ok: true, saved: true });
  } catch {
    res.json({ ok: true, saved: false });
  }
});

router.delete('/', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ ok: true });
  try {
    await db.prepare(
      `DELETE FROM video_progress WHERE user_id = ? AND video_id = ?`
    ).run(req.user.id, req.params.videoId);
  } catch {}
  res.json({ ok: true });
});

module.exports = router;
