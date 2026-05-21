/**
 * Analytics routes
 *
 * GET /api/videos/:videoId/analytics          — full analytics report
 * GET /api/videos/:videoId/analytics/live     — live viewer count (last 5 min)
 * GET /api/videos/:videoId/analytics/export.csv
 *
 * Cache strategy (Redis, TTL 5 min):
 *   Key: sv:analytics:{videoId}:{days|'all'}
 *   Invalidated: when a new 'play' event is recorded for this video
 *                (fire-and-forget delPattern in POST /events in videos.js)
 *
 * The /live and /export endpoints are intentionally NOT cached:
 *   • /live must always reflect the last 5 minutes
 *   • /export is a one-off download, not a hot path
 */
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db');
const cache   = require('../services/cache');
const { authenticate } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const logger  = require('../services/logger').child({ module: 'analytics' });

// Shared ownership check — user must belong to the video's workspace.
// SECURITY FIX: Videos without a workspace now require super_admin access.
// Previously ANY authenticated user could read analytics for workspace-less videos.
async function assertAnalyticsAccess(videoId, userId) {
  const video = await db.prepare(
    `SELECT id, duration, workspace_id FROM videos WHERE id = ?`
  ).get(videoId);
  if (!video) return { video: null, forbidden: false };
  if (video.workspace_id) {
    const member = await db.prepare(
      `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
    ).get(video.workspace_id, userId);
    if (!member) return { video, forbidden: true };
  } else {
    // No workspace: only super admins can access analytics for orphan videos
    const user = await db.prepare(
      `SELECT platform_role FROM users WHERE id = ?`
    ).get(userId);
    if (user?.platform_role !== 'super_admin') return { video, forbidden: true };
  }
  return { video, forbidden: false };
}

const ANALYTICS_TTL = 300; // 5 minutes

function cacheKey(videoId, days) {
  return `sv:analytics:${videoId}:${days || 'all'}`;
}

// ─── GET /live ────────────────────────────────────────────────────────────────
router.get('/live', async (req, res) => {
  try {
    const { video, forbidden } = await assertAnalyticsAccess(req.params.videoId, req.user.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (forbidden) return res.status(403).json({ error: 'Forbidden' });

    const cutoff = Math.floor(Date.now() / 1000) - 300; // last 5 min
    const row = await db.prepare(
      `SELECT COUNT(DISTINCT viewer_id) AS cnt
       FROM events
       WHERE video_id = ? AND created_at >= ?`
    ).get(req.params.videoId, cutoff);

    res.json({ live: Number(row?.cnt) || 0 });
  } catch (err) {
    logger.error({ err: err.message, videoId: req.params.videoId }, 'Failed to fetch live viewers');
    res.status(500).json({ error: 'Failed to fetch live viewers', details: err.message });
  }
});

// ─── GET / — full analytics report ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
  const { video, forbidden } = await assertAnalyticsAccess(req.params.videoId, req.user.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (forbidden) return res.status(403).json({ error: 'Forbidden' });

  // Check analytics tier (basic vs full)
  // req.featureValue se setea por checkFeature middleware cuando está montado.
  // Si no hay middleware (ruta directa), devolver siempre analytics completo.
  const analyticsLevel = req.featureValue !== undefined ? req.featureValue : 'full';
  const isFullAnalytics = (analyticsLevel === true || analyticsLevel === 'full' || analyticsLevel === undefined);

  const vid      = video.id;
  const duration = video.duration || 0;
  
  // Validate days param against whitelist (prevents SQL injection)
  const allowedDays = [7, 30, 90];
  const daysParam   = parseInt(req.query.days);
  const days        = allowedDays.includes(daysParam) ? daysParam : null;

  // ── Cache check ────────────────────────────────────────────────────────────
  const key    = cacheKey(vid, days);
  const cached = await cache.get(key);
  // Only use the cached value if the tier matches what we need.
  // If the cache has a 'basic' entry but the current request deserves 'full'
  // (or vice versa), we must bypass the cache so the correct data is returned.
  if (cached && cached.tier === (isFullAnalytics ? 'full' : 'basic')) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  // ── Build date filter (safe: days is whitelist-validated integer) ──────────
  // PostgreSQL: use EXTRACT(EPOCH FROM NOW()) for current timestamp
  const dateFilter = days
    ? `AND created_at >= EXTRACT(EPOCH FROM NOW()) - ${days} * 86400`
    : '';

  // ── Run all queries in parallel — reduces latency from N round-trips to 1 ─
  const [
    uniqueViewersRow,
    totalPlaysRow,
    completionsRow,
    avgWatchRow,
    eventRows,
    retentionRows,
    topSegments,
    dailyPlays,
    deviceRows,
    browserRows,
    countryRows,
  ] = await Promise.all([

    db.prepare(
      `SELECT COUNT(DISTINCT viewer_id) AS cnt
       FROM events WHERE video_id = ? AND event_type = 'play' ${dateFilter}`
    ).get(vid),

    db.prepare(
      `SELECT COUNT(*) AS cnt
       FROM events WHERE video_id = ? AND event_type = 'play' ${dateFilter}`
    ).get(vid),

    db.prepare(
      `SELECT COUNT(DISTINCT viewer_id) AS cnt
       FROM events WHERE video_id = ? AND event_type = 'end' ${dateFilter}`
    ).get(vid),

    db.prepare(`
      SELECT AVG(max_pos) AS avg FROM (
        SELECT viewer_id, MAX(position) AS max_pos
        FROM events
        WHERE video_id = ? AND event_type = 'progress' ${dateFilter}
        GROUP BY viewer_id
      ) sub
    `).get(vid),

    db.prepare(
      `SELECT event_type, COUNT(*) AS cnt
       FROM events WHERE video_id = ? ${dateFilter}
       GROUP BY event_type`
    ).all(vid),

    db.prepare(`
      SELECT
        CAST(position / 10 AS INTEGER) * 10 AS bucket,
        COUNT(DISTINCT viewer_id) AS viewers
      FROM events
      WHERE video_id = ? AND event_type = 'progress' ${dateFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(vid),

    db.prepare(`
      SELECT
        CAST(position / 10 AS INTEGER) * 10 AS second,
        COUNT(*) AS plays
      FROM events
      WHERE video_id = ? AND event_type = 'progress' ${dateFilter}
      GROUP BY second
      ORDER BY plays DESC
      LIMIT 5
    `).all(vid),

    // BUG FIX: Use the same dateFilter as all other queries so the days param is consistent.
    // Previously this query always used 30 days even when days=7 was requested.
    // PostgreSQL: use TO_CHAR with TO_TIMESTAMP for unix epoch conversion
    db.prepare(`
      SELECT
        TO_CHAR(TO_TIMESTAMP(created_at), 'YYYY-MM-DD') AS day,
        COUNT(*) AS plays
      FROM events
      WHERE video_id = ? AND event_type = 'play' ${dateFilter}
      GROUP BY day
      ORDER BY day ASC
    `).all(vid),

    db.prepare(`
      SELECT device_type, COUNT(DISTINCT viewer_id) AS viewers
      FROM events
      WHERE video_id = ? AND event_type = 'play' ${dateFilter}
        AND device_type IS NOT NULL
      GROUP BY device_type
      ORDER BY viewers DESC
    `).all(vid),

    db.prepare(`
      SELECT browser, COUNT(DISTINCT viewer_id) AS viewers
      FROM events
      WHERE video_id = ? AND event_type = 'play' ${dateFilter}
        AND browser IS NOT NULL
      GROUP BY browser
      ORDER BY viewers DESC
    `).all(vid),

    db.prepare(`
      SELECT country, COUNT(DISTINCT viewer_id) AS viewers
      FROM events
      WHERE video_id = ? AND event_type = 'play' ${dateFilter}
        AND country IS NOT NULL AND country != ''
      GROUP BY country
      ORDER BY viewers DESC
      LIMIT 10
    `).all(vid),
  ]);

  // ── Assemble response ──────────────────────────────────────────────────────
  const uniqueViewers  = Number(uniqueViewersRow?.cnt)  || 0;
  const totalPlays     = Number(totalPlaysRow?.cnt)     || 0;
  const completions    = Number(completionsRow?.cnt)    || 0;
  const completionRate = uniqueViewers > 0 ? completions / uniqueViewers : 0;
  const avgWatchTime   = Math.round(Number(avgWatchRow?.avg) || 0);

  const eventCounts = {};
  for (const row of eventRows) eventCounts[row.event_type] = Number(row.cnt);

  // Retention curve
  const bucketCount  = duration > 0 ? Math.ceil(duration / 10) : 0;
  const retentionMap = new Map(retentionRows.map(r => [Number(r.bucket), Number(r.viewers)]));
  // CRITICAL FIX: peakViewers should be the MAXIMUM across all buckets, not just first bucket
  const peakViewers  = retentionRows.length > 0
    ? Math.max(...retentionRows.map(r => Number(r.viewers)))
    : (uniqueViewers || 1);

  const retention = [];
  for (let i = 0; i <= bucketCount; i++) {
    const second  = i * 10;
    const viewers = retentionMap.get(second) || 0;
    retention.push({
      second,
      viewers,
      pct: peakViewers > 0 ? Math.round((viewers / peakViewers) * 1000) / 10 : 0,
    });
  }

  // Drop-off points
  const dropOffs = [];
  for (let i = 1; i < retention.length; i++) {
    const drop = retention[i - 1].pct - retention[i].pct;
    if (drop > 0) dropOffs.push({ second: retention[i].second, drop: Math.round(drop * 10) / 10 });
  }
  dropOffs.sort((a, b) => b.drop - a.drop);

  // ── Filter data based on analytics level ──────────────────────────────────
  const result = {
    videoId: vid,
    duration,
    days,
    tier: isFullAnalytics ? 'full' : 'basic',
    // BASIC: Views, watch time, completion rate
    uniqueViewers,
    totalPlays,
    completionRate:    Math.round(completionRate * 1000) / 10,
    avgWatchTime,
    avgWatchTimePct:   duration > 0 ? Math.round((avgWatchTime / duration) * 1000) / 10 : 0,
  };

  // FULL ANALYTICS: Advanced metrics (retention curves, heatmaps, geo, device breakdown, export)
  if (isFullAnalytics) {
    Object.assign(result, {
      eventCounts,
      retention,
      topSegments:       topSegments.map(r => ({ second: Number(r.second), plays: Number(r.plays) })),
      dropOffs:          dropOffs.slice(0, 5),
      dailyPlays:        dailyPlays.map(r => ({ day: r.day, plays: Number(r.plays) })),
      deviceBreakdown:   Object.fromEntries(deviceRows.map(r => [r.device_type, Number(r.viewers)])),
      browserBreakdown:  Object.fromEntries(browserRows.map(r => [r.browser, Number(r.viewers)])),
      countryBreakdown:  countryRows.map(r => ({ country: r.country, viewers: Number(r.viewers) })),
    });
  }

  // ── Store in cache ─────────────────────────────────────────────────────────
  await cache.set(key, result, ANALYTICS_TTL);

  res.setHeader('X-Cache', 'MISS');
  res.json(result);
  } catch (err) {
    logger.error({ videoId: req.params.videoId, err: err.message }, 'Failed to fetch analytics');
    res.status(500).json({ error: 'Failed to fetch analytics', details: err.message });
  }
});

// ─── GET /export.csv — raw event export (FULL ANALYTICS ONLY) ────────────────
router.get('/export.csv', rateLimit(5, 60_000), async (req, res) => {
  try {
  const { video, forbidden } = await assertAnalyticsAccess(req.params.videoId, req.user.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (forbidden) return res.status(403).json({ error: 'Forbidden' });

  // CSV export requires FULL analytics tier
  const analyticsLevel = req.featureValue || 'basic';
  const isFullAnalytics = (analyticsLevel === true || analyticsLevel === 'full');
  
  if (!isFullAnalytics) {
    return res.status(403).json({ 
      error: 'CSV export requiere plan con Analytics Completo', 
      code: 'ANALYTICS_FULL_REQUIRED',
      tier: 'basic'
    });
  }

  const MAX_EXPORT_ROWS = 100_000;
  const events = await db.prepare(`
    SELECT viewer_id, event_type, position, quality, country, city,
           device_type, browser, os,
           TO_CHAR(TO_TIMESTAMP(created_at), 'YYYY-MM-DD HH24:MI:SS') AS timestamp
    FROM events
    WHERE video_id = ?
    ORDER BY created_at ASC
    LIMIT ${MAX_EXPORT_ROWS}
  `).all(req.params.videoId);

  // RFC 4180 CSV: wrap every field in double quotes, escape internal quotes as ""
  const csvField = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = ['viewer_id','event_type','position','quality','country','city','device_type','browser','os','timestamp'];
  const csvRows = [headers.map(csvField).join(',')];
  for (const e of events) {
    csvRows.push(headers.map(h => csvField(e[h])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="analytics-${video.id}.csv"`);
  res.send(csvRows.join('\n'));
  } catch (err) {
    logger.error({ videoId: req.params.videoId, err: err.message }, 'Failed to export analytics');
    res.status(500).json({ error: 'Failed to export analytics', details: err.message });
  }
});

// ─── Export cache key builder so videos.js can invalidate on new events ───────
module.exports = router;
module.exports.cacheKey = cacheKey;
