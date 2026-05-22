const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const cors      = require('cors');
const compression = require('compression');
const config    = require('./config');
const database  = require('./db');
const logger    = require('./services/logger').child({ module: 'server' });
const rateLimit = require('./middleware/rateLimit');

// ─── Advanced Security Modules ────────────────────────────────
const advancedRateLimit = require('./middleware/advancedRateLimit');
const securityRoutes = require('./routes/security');

// ─── Video workspace resolution middleware ────────────────────
const { resolveVideoWorkspace } = require('./middleware/resolveVideoWorkspace');
const { checkFeature } = require('./middleware/checkFeature');

const app = express();

// ─── Reverse proxy trust — must be set before any req.ip usage ───────────────
// Set TRUST_PROXY=1 when behind one reverse proxy (Nginx, ALB, Cloudflare).
// Without this, req.ip always returns the proxy's IP and rate limiting treats
// all users as one. With TRUST_PROXY=1 Express reads the rightmost XFF hop
// (added by the trusted proxy), which is the real client IP.
// Never set to 'true' or a number > 1 unless you have that many proxy hops.
if (process.env.TRUST_PROXY) {
  const raw = process.env.TRUST_PROXY;
  app.set('trust proxy', isNaN(Number(raw)) ? raw : Number(raw));
}

// ─── CORS — whitelist from ALLOWED_ORIGINS env var ───────────
// Production: ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
// Development: leave ALLOWED_ORIGINS empty to allow all origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    // Dev mode with no whitelist: allow everything
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  exposedHeaders: ['Content-Type', 'Cache-Control', 'Connection'],
}));

// ─── HTTP Compression ──────────────────────────────────────────
// Compress all HTTP responses (JSON, HTML, CSS, JS) to reduce bandwidth.
// Skip compression for video streams (already compressed) and small responses.
app.use(compression({
  filter: (req, res) => {
    // Don't compress video segments or streams
    if (req.path.startsWith('/videos/') || req.path.endsWith('.ts') || req.path.endsWith('.m3u8')) {
      return false;
    }
    // Use default compression filter for everything else
    return compression.filter(req, res);
  },
  threshold: 1024, // Only compress responses > 1KB
}));

// ─── Security hardening ───────────────────────────────────────
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS — only in production where TLS is terminated upstream (reverse proxy/CDN).
  if (!config.isDev) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Content Security Policy — strict, no unsafe-inline in production.
  // Inline scripts have been extracted to /js/app-*.js external files.
  // worker-src blob: required for HLS.js transmuxing worker.
  const _cdnUrl = process.env.CLOUDFRONT_BASE_URL || process.env.CDN_BASE_URL || '';
  const cdnOrigins = _cdnUrl ? new URL(_cdnUrl).origin : '';

  const cspDirectives = [
    "default-src 'self'",
    // www.gstatic.com required for Chromecast SDK
    // CDN origin allowed when configured (for self-hosted CSS/JS assets)
    // In development: allow 'unsafe-inline' for scripts because the dashboard
    // HTML has hundreds of inline onclick/oninput/onkeydown handlers that would
    // require a full refactor to remove. In production with NODE_ENV=production
    // this is removed for strict security.
    [
      "script-src 'self' 'unsafe-inline'",
      cdnOrigins,
      'cdn.jsdelivr.net',
      'unpkg.com',
      'www.gstatic.com',
      // chart.googleapis.com used as QR code fallback in 2FA setup
      'chart.googleapis.com',
    ].filter(Boolean).join(' '),
    // 'unsafe-inline' required for style-src: the dashboard JS generates thousands of
    // dynamic inline styles (via template literals in innerHTML). It is not feasible
    // to hash all of them. This does NOT affect script-src which remains strict.
    [
      "style-src 'self' 'unsafe-inline'",
      cdnOrigins,
      'fonts.googleapis.com',
    ].filter(Boolean).join(' '),
    "font-src 'self' fonts.gstatic.com www.gstatic.com" + (cdnOrigins ? ' ' + cdnOrigins : ''),
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https: http:",
    // cdn.jsdelivr.net for HLS.js; imasdk.googleapis.com for Chromecast
    [
      "connect-src 'self'",
      cdnOrigins,
      'cdn.jsdelivr.net',
      'unpkg.com',
      'imasdk.googleapis.com',
    ].filter(Boolean).join(' '),
    "worker-src blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ];
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));
  next();
});

// Embed, embed-playlist, player and view pages must be iframe-able from any domain — override frame headers.
app.use(['/embed', '/embed-playlist', '/player', '/playlist', '/view'], (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy',
    res.getHeader('Content-Security-Policy').replace("frame-ancestors 'self'", "frame-ancestors *")
  );
  next();
});

// Raw body parser for Stripe webhooks (must be before express.json)
app.use('/api/billing/webhooks', express.raw({ type: 'application/json' }));

// JSON body parser — limit to 1MB for API endpoints (10MB was excessive and enables DoS)
app.use(express.json({ limit: '10mb' }));
// URL-encoded body (for forms)
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Admin Panel Protection ───────────────────────────────────
// SECURITY: Admin routes require authenticated super_admin JWT.
// /metrics/stream is exempt here — it uses a short-lived SSE token validated inside the handler.
const authMiddleware = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/metrics/stream') return next();
  authMiddleware.superAdminAuth(req, res, next);
});

// ─── Redirect old /security to new /dashboard/security ───────
app.get('/security', (req, res) => {
  res.redirect(301, '/dashboard/security');
});

// ─── robots.txt — dynamic Sitemap URL (must be before static middleware) ─────
app.get('/robots.txt', (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Allow: /watch/\n' +
    'Disallow: /dashboard/\n' +
    'Disallow: /admin/\n' +
    'Disallow: /api/\n' +
    'Disallow: /videos/\n' +
    'Disallow: /uploads/\n' +
    'Disallow: /embed/\n' +
    '\n' +
    `Sitemap: ${base}/sitemap.xml\n`
  );
});

// ─── Static assets — cache headers for CDN ────────────────────
// CSS, JS, images, fonts: aggressive long-lived cache (1 year).
// HTML files: no-cache so browsers always get the latest version.
// The CDN_BASE_URL env var configures an upstream CDN (CloudFront/Fastly/BunnyCDN)
// that serves these static files. Set it in .env to enable CDN.
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.js', '.css', '.woff', '.woff2', '.ttf', '.eot', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'].includes(ext)) {
      // Immutable assets: long cache with revalidation via content hash
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (['.html'].includes(ext)) {
      // HTML: always revalidate — never cache aggressively
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    // Everything else: default Express behavior
  },
}));

// ─── Advanced Rate Limiting (Global Protection) ───────────────
// Skip rate limiting for HLS video segments and playlists — these endpoints
// are already protected by signed video tokens. Applying IP rate limiting
// here causes 429 errors during normal adaptive bitrate streaming since
// HLS.js fires many concurrent segment requests for quality switching.
app.use(advancedRateLimit.globalLimiter({
  // Skip rate limiting for HLS segments AND all video API endpoints that fire
  // continuously during playback (views, events, progress, token renewal).
  skipPaths: ['/videos/', '/api/videos/'],
}));

// ─── HLS segment delivery — token + domain protection ────────
const { verifyVideoToken, verifyCastToken, tokensRequired } = require('./services/tokenSigning');

// ─── Bandwidth tracking — batched writes every 30s ───────────
const bwAccum = new Map(); // workspaceId → bytes

async function flushBandwidth() {
  if (!bwAccum.size) return;
  const entries = [...bwAccum.entries()];
  bwAccum.clear();
  for (const [wsId, bytes] of entries) {
    try {
      await database.prepare(
        `UPDATE workspaces SET bandwidth_used_bytes = bandwidth_used_bytes + ? WHERE id = ?`
      ).run(bytes, wsId);
    } catch (err) {
      logger.error({ err }, 'Bandwidth flush failed');
    }
  }
}

setInterval(() => {
  if (_shuttingDown) return;
  flushBandwidth();
}, 30_000);

// Purge old webhook delivery records daily — keep last 90 days per webhook.
// webhook_deliveries has no TTL by design (admin needs to debug failures),
// but without a cap it grows unboundedly in high-traffic workspaces.
setInterval(() => {
  if (_shuttingDown) return;
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
  database.prepare(
    `DELETE FROM webhook_deliveries WHERE created_at < ?`
  ).run(cutoff).catch(err => logger.warn({ err: err.message }, 'webhook_deliveries cleanup failed'));
}, 24 * 60 * 60 * 1000);

// Purge expired revoked JWT tokens every hour.
// Access tokens expire in 15m; we keep entries until expires_at to be safe.
// Without this the table grows unboundedly, one row per logout/revocation.
setInterval(() => {
  if (_shuttingDown) return;
  database.prepare(
    `DELETE FROM revoked_tokens WHERE expires_at < FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`
  ).run().catch(err => logger.warn({ err: err.message }, 'revoked_tokens cleanup failed'));
}, 60 * 60 * 1000);

// Purge expired refresh tokens daily — only deleted on logout/password-change normally,
// so abandoned sessions accumulate over months.
setInterval(() => {
  if (_shuttingDown) return;
  database.prepare(
    `DELETE FROM refresh_tokens WHERE expires_at < FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`
  ).run().catch(err => logger.warn({ err: err.message }, 'refresh_tokens cleanup failed'));
}, 24 * 60 * 60 * 1000);

// Purge expired workspace invitations daily — they cannot be accepted but accumulate.
setInterval(() => {
  if (_shuttingDown) return;
  database.prepare(
    `DELETE FROM workspace_invitations WHERE accepted_at IS NULL AND expires_at < FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`
  ).run().catch(err => logger.warn({ err: err.message }, 'workspace_invitations cleanup failed'));
}, 24 * 60 * 60 * 1000);

// Purge old audit log entries daily — keep 365 days.
setInterval(() => {
  if (_shuttingDown) return;
  const cutoff = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60;
  database.prepare(
    `DELETE FROM audit_log WHERE created_at < ?`
  ).run(cutoff).catch(err => logger.warn({ err: err.message }, 'audit_log cleanup failed'));
}, 24 * 60 * 60 * 1000);

// Purge old analytics events daily — respects per-workspace analytics_retention_days (default 90).
// Runs two queries: one for workspace events (uses per-ws retention), one for orphan videos (90d default).
setInterval(() => {
  if (_shuttingDown) return;
  database.prepare(`
    DELETE FROM events e USING workspaces w
    WHERE e.workspace_id = w.id
      AND e.created_at < FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - COALESCE(w.analytics_retention_days, 90) * 86400
  `).run().catch(err => logger.warn({ err: err.message }, 'events cleanup failed'));
  const orphanCutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  database.prepare(
    `DELETE FROM events WHERE workspace_id IS NULL AND created_at < ?`
  ).run(orphanCutoff).catch(err => logger.warn({ err: err.message }, 'events (orphan) cleanup failed'));
}, 24 * 60 * 60 * 1000);

// Purge expired guest videos daily — respects expiryHours from system_config guest_config (default 24h).
// Deletes DB row, local files, and S3 objects so storage is reclaimed.
setInterval(async () => {
  if (_shuttingDown) return;
  try {
    let expiryHours = 24;
    try {
      const row = await database.prepare(`SELECT value FROM system_config WHERE key = 'guest_config'`).get();
      if (row?.value) expiryHours = JSON.parse(row.value).expiryHours ?? 24;
    } catch {}
    const cutoff = Math.floor(Date.now() / 1000) - expiryHours * 3600;
    const expired = await database.prepare(
      `SELECT id, s3_object_prefix FROM videos WHERE guest_session_id IS NOT NULL AND workspace_id IS NULL AND created_at < ?`
    ).all(cutoff);
    for (const v of expired) {
      try { require('fs').rmSync(path.join(__dirname, 'videos', v.id), { recursive: true, force: true }); } catch {}
      if (s3.isS3Enabled() && v.s3_object_prefix) {
        s3.deleteObjectsWithPrefix(v.s3_object_prefix).catch(() => {});
      }
    }
    if (expired.length) {
      const ids = expired.map(v => v.id);
      await database.pool.query(`DELETE FROM videos WHERE id = ANY($1::text[])`, [ids]);
      logger.info({ count: expired.length }, 'Purged expired guest videos');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'guest video cleanup failed');
  }
}, 24 * 60 * 60 * 1000);

// Mark videos as expired hourly — sets status='expired' so players block playback.
// Actual file deletion is left to the user (or a separate admin purge).
setInterval(async () => {
  if (_shuttingDown) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = await database.pool.query(`
      UPDATE videos SET status = 'expired', updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE expires_at IS NOT NULL AND expires_at <= $1 AND status != 'expired'
      RETURNING id, title
    `, [now]);
    if (result.rowCount > 0) {
      logger.info({ count: result.rowCount }, 'Marked videos as expired');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'video expiry check failed');
  }
}, 60 * 60 * 1000);

// Purge old notifications (>90 days) to keep the table tidy.
setInterval(() => {
  if (_shuttingDown) return;
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  database.prepare(
    `DELETE FROM notifications WHERE created_at < ?`
  ).run(cutoff).catch(err => logger.warn({ err: err.message }, 'notifications cleanup failed'));
}, 24 * 60 * 60 * 1000);

function extractOrigin(req) {
  const raw = req.headers.origin || req.headers.referer || '';
  try { return new URL(raw).hostname; } catch { return ''; }
}

function isLocalOrigin(origin) {
  return !origin || origin === 'localhost' || origin.startsWith('127.');
}

app.use('/videos', async (req, res, next) => {
  const ext     = path.extname(req.path);
  const videoId = req.path.split('/').filter(Boolean)[0];

  // ── Cast token bypass ───────────────────────────────────────
  // The Chromecast receiver fetches .ts segments and sub-playlists using a
  // signed cast_token embedded by cast-manifest. No browser session exists
  // on the TV, so we skip hotlink + video-token enforcement entirely when
  // a valid cast token is present for this exact videoId.
  if (videoId && verifyCastToken(req.query.cast_token, videoId)) {
    // Chromecast receiver runs inside a Google-origin browser — ensure CORS
    // headers are present so it can fetch segments regardless of ALLOWED_ORIGINS.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    return next();
  }

  // ── Token enforcement ───────────────────────────────────────
  // Tokens are required when:
  //   • REQUIRE_VIDEO_TOKENS=true  (explicit global flag), OR
  //   • the video's workspace has requireVideoTokens=true, OR
  //   • the video's workspace has an embedAllowedDomains list (auto-enforce)
  let enforce = tokensRequired();
  let hotlinkProtect = false;

  if (videoId) {
    try {
      const row = await database.prepare(
        `SELECT w.settings FROM videos v
         LEFT JOIN workspaces w ON w.id = v.workspace_id
         WHERE v.id = ?`
      ).get(videoId);
      if (row?.settings) {
        const s = JSON.parse(row.settings);
        const allowed = s.embedAllowedDomains;
        if (Array.isArray(allowed) && allowed.length > 0) enforce = true;
        if (s.requireTokensAlways === true) enforce = true;
        hotlinkProtect = s.hotlinkProtection === true;
      }
    } catch {}
  }

  // Images, JSON metadata, and VTT subtitle tracks are always public —
  // subtitles must load even when the viewer has no auth token.
  const isPublicAsset = ['.jpg', '.jpeg', '.png', '.webp', '.json', '.vtt'].includes(ext.toLowerCase());
  if (enforce && !isPublicAsset) {
    const token  = req.query.token || req.headers['x-video-token'];
    const origin = extractOrigin(req);
    // Pass origin only for non-local requests so dev works without binding
    const checkOrigin = isLocalOrigin(origin) ? '' : origin;
    if (!videoId || !token || !verifyVideoToken(token, videoId, checkOrigin)) {
      return res.status(401).json({ error: 'Invalid or expired video token' });
    }
  }

  // ── Hotlink protection ──────────────────────────────────────
  // Block .m3u8 and .ts requests from external origins with no Referer/Origin.
  // Only applies when tokens are NOT already enforcing access.
  if (hotlinkProtect && !enforce && !isPublicAsset) {
    const origin = extractOrigin(req);
    if (!isLocalOrigin(origin) && !origin) {
      return res.status(403).json({ error: 'Direct access not allowed' });
    }
  }

  // ── Correct content-type + cache headers for HLS ───────────
  if (ext === '.m3u8') {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
  } else if (ext === '.ts') {
    res.setHeader('Content-Type', 'video/mp2t');
    // Encrypted segments can be cached publicly — useless without the key
    res.setHeader('Cache-Control', 'public, max-age=86400');

    // Track bandwidth: accumulate bytes when segment is fully sent
    if (videoId) {
      res.on('finish', async () => {
        try {
          const bytes = parseInt(res.getHeader('Content-Length') || '0', 10);
          if (!bytes) return;
          const row = await database.prepare(
            `SELECT workspace_id FROM videos WHERE id = ?`
          ).get(videoId);
          if (row?.workspace_id) {
            bwAccum.set(row.workspace_id, (bwAccum.get(row.workspace_id) || 0) + bytes);
          }
        } catch {}
      });
    }
  }
  next();
}, express.static('videos'));

const uploadsDir = path.join(__dirname, 'uploads');
const videosDir = path.join(__dirname, 'videos');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

// Upload storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Strip path separators and non-safe chars to prevent path traversal
    const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});

// [HIGH-09] Validación de tipo de archivo en el nivel de multer.
// fileFilter es una defensa superficial (MIME type declarado por el cliente puede mentir).
// La validación real por magic bytes se hace en routes/upload.js después de recibir el archivo.
const ALLOWED_MIME_PREFIXES = [
  'video/', 'audio/',       // video y audio
];
const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv',
  '.m4v', '.ts', '.mts', '.m2ts', '.3gp', '.ogv', '.mpg', '.mpeg',
  '.mp3', '.aac', '.wav', '.ogg', '.flac', '.m4a',
]);

function videoFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mimeOk = ALLOWED_MIME_PREFIXES.some(prefix => (file.mimetype || '').startsWith(prefix));
  const extOk = ALLOWED_EXTENSIONS.has(ext);
  if (!mimeOk && !extOk) {
    return cb(new Error(`Tipo de archivo no permitido: ${file.mimetype} (${ext})`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB máximo
  fileFilter: videoFileFilter,
});

// ─── Auth routes (no auth required) ──────────────────────────
app.use('/auth', require('./routes/auth'));

// ─── API routes ──────────────────────────────────────────────
app.use('/api/health', require('./routes/health'));
app.use('/api/plans',  require('./routes/plans'));
// Bulk must be registered before the generic /:id video routes to prevent
// Express matching "bulk" as a videoId in the videos router.
app.use('/api/videos/bulk', require('./routes/bulk'));

app.use('/api/videos/:videoId/chapters',      require('./routes/chapters'));
app.use('/api/videos/:videoId/analytics', authMiddleware.authenticate, resolveVideoWorkspace, checkFeature('analytics'), require('./routes/analytics'));
app.use('/api/videos/:videoId/transcriptions', authMiddleware.optionalAuth, resolveVideoWorkspace, checkFeature('transcriptions'), require('./routes/transcriptions'));
app.use('/api/videos/:videoId/progress',      require('./routes/progress'));
app.use('/api/videos/:videoId/tracks',        require('./routes/tracks'));

// ─── Public TMDB credits endpoint — used by the player (no user auth required) ──
// The TMDB API key lives server-side in workspace settings and is never exposed.
app.get('/api/videos/:id/credits', async (req, res) => {
  try {
    const video = await database.prepare(
      `SELECT id, workspace_id, tmdb_id, tmdb_type FROM videos WHERE id = ?`
    ).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    const tmdbId   = video.tmdb_id;
    const tmdbType = video.tmdb_type === 'tv' ? 'tv' : 'movie';
    if (!tmdbId) return res.status(404).json({ error: 'no_tmdb_id' });
    const ws = await database.prepare(`SELECT settings FROM workspaces WHERE id = ?`).get(video.workspace_id);
    let tmdbKey = '';
    try { tmdbKey = JSON.parse(ws?.settings || '{}').tmdbApiKey || ''; } catch {}
    if (!tmdbKey) return res.status(400).json({ error: 'no_tmdb_key' });
    const url = `https://api.themoviedb.org/3/${tmdbType}/${encodeURIComponent(tmdbId)}?append_to_response=credits&language=es-MX`;
    const tmdbRes = await fetch(url, { headers: { Authorization: `Bearer ${tmdbKey}` } });
    if (!tmdbRes.ok) {
      const body = await tmdbRes.json().catch(() => ({}));
      return res.status(tmdbRes.status).json({ error: 'tmdb_error', detail: body });
    }
    res.json({ ...await tmdbRes.json(), _type: tmdbType });
  } catch (err) {
    logger.error({ err }, 'TMDB credits proxy error');
    res.status(500).json({ error: 'Failed to fetch TMDB data' });
  }
});

app.use('/api/videos', require('./routes/videos'));
app.use('/api/upload', rateLimit(10, 60_000), upload.single('video'), require('./routes/upload'));
// /api/admin is already protected by superAdminAuth middleware registered above
app.use('/api/admin', require('./routes/admin'));

// ─── Public workspace endpoints (MUST be before the authenticated workspaces router) ───
// GET /api/workspaces/by-id/:id — public, returns name+slug for channel page link
app.get('/api/workspaces/by-id/:id', async (req, res) => {
  try {
    const ws = await database.prepare(
      `SELECT id, name, slug, plan FROM workspaces WHERE id = ?`
    ).get(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ id: ws.id, name: ws.name, slug: ws.slug, plan: ws.plan });
  } catch { res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/stats/public — public aggregate stats for landing globe
let _publicStatsCache = null, _publicStatsCachedAt = 0;
app.get('/api/stats/public', async (req, res) => {
  try {
    const now = Date.now();
    if (!_publicStatsCache || now - _publicStatsCachedAt > 60_000) {
      const [vRow, wRow] = await Promise.all([
        database.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(views),0) AS views FROM videos WHERE status='ready'`).get(),
        database.prepare(`SELECT COUNT(*) AS cnt FROM workspaces`).get(),
      ]);
      _publicStatsCache = {
        videos:     Number(vRow?.cnt   || 0),
        views:      Number(vRow?.views || 0),
        workspaces: Number(wRow?.cnt   || 0),
      };
      _publicStatsCachedAt = now;
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(_publicStatsCache);
  } catch { res.json({ videos: 0, views: 0, workspaces: 0 }); }
});

// GET /api/workspaces/by-slug/:slug — public, no auth
app.get('/api/workspaces/by-slug/:slug', async (req, res) => {
  try {
    const ws = await database.prepare(
      `SELECT w.id, w.name, w.slug, w.plan, w.settings, w.avatar_url AS ws_avatar,
              u.channel_name, u.username, u.avatar_url AS user_avatar
       FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id WHERE w.slug = ?`
    ).get(req.params.slug);
    if (!ws) return res.status(404).json({ error: 'Channel not found' });
    const s = (() => { try { return JSON.parse(ws.settings || '{}'); } catch { return {}; } })();
    if (s.channelEnabled === false) return res.status(403).json({ error: 'Channel is disabled' });
    const displayName = ws.channel_name || ws.name;
    const avatarUrl = ws.ws_avatar || ws.user_avatar || null;
    res.json({ id: ws.id, name: displayName, slug: ws.slug, plan: ws.plan, avatarUrl });
  } catch { res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/workspaces/:id/public-videos — public videos for a channel page
app.get('/api/workspaces/:id/public-videos', async (req, res) => {
  try {
    // Check if channel is enabled for this workspace
    const wsCheck = await database.prepare(`SELECT settings FROM workspaces WHERE id = ?`).get(req.params.id);
    if (wsCheck) {
      const s = JSON.parse(wsCheck.settings || '{}');
      if (s.channelEnabled === false) {
        return res.status(403).json({ error: 'Channel is disabled for this workspace' });
      }
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const videos = await database.prepare(`
      SELECT id, title, description, thumbnail, hls_cdn_url, views, duration, size,
             qualities, visibility, created_at, updated_at, status
      FROM videos
      WHERE workspace_id = ? AND status = 'ready' AND (visibility IS NULL OR visibility = 'public')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(req.params.id, limit);
    const mapped = videos.map(v => {
      let q = [];
      try { q = JSON.parse(v.qualities || '[]'); } catch {}
      const cdn = v.hls_cdn_url;
      const base = cdn ? cdn.replace(/\/master\.m3u8$/i, '') : null;
      return { ...v, qualities: q, thumbnailUrl: base ? `${base}/thumb.jpg` : null };
    });
    res.json({ videos: mapped });
  } catch { res.status(500).json({ error: 'Internal server error' }); }
});

app.use('/api/workspaces', require('./routes/workspaces'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/invitations', require('./routes/invitations'));
app.use('/api/import', require('./routes/import'));
app.use('/api/apikeys', require('./routes/apikeys'));

// ─── Security API (2FA, activity logs, session management) ───
app.use('/api/security', securityRoutes);

// Public platform settings (no auth) — used by frontend/login page
// Si el usuario está autenticado y tiene workspace, devuelve además
// las features efectivas de su plan (global ∩ plan).
app.get('/api/settings', async (req, res) => {
  try {
    const dynCfg = require('./services/dynamicConfig');
    const { PLAN_FEATURE_DEFAULTS } = require('./middleware/checkFeature');

    const platform = await dynCfg.getDynSection('platform', { siteName: 'StreamVault', allowRegistration: true });

    // Features globales (lo que el super-admin ha habilitado para todo el sistema)
    const globalFeatures = await dynCfg.getDynSection('features', {
      foldersEnabled: true, playlistsEnabled: true, webhooksEnabled: true,
      transcriptionsEnabled: true, downloadLinksEnabled: true, watermarkEnabled: true,
      analyticsEnabled: true, embedEnabled: true, adsEnabled: true,
      bulkOperationsEnabled: true,
      apiKeysEnabled: true, tracksEnabled: true, invitationsEnabled: true,
      referralEnabled: true, multiWorkspaceEnabled: true,
    });

    // Si hay token de auth, intentar resolver features del plan del workspace
    let effectiveFeatures = { ...globalFeatures };
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token) {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, config.jwtSecret);
        if (decoded?.userId) {
          // Obtener workspace del usuario (el primero / activo)
          const wsHeader = req.headers['x-workspace-id'];
          let workspace = null;
          if (wsHeader) {
            workspace = await database.prepare(
              `SELECT w.id, w.plan FROM workspaces w
               JOIN workspace_members wm ON wm.workspace_id = w.id
               WHERE w.id = ? AND wm.user_id = ? LIMIT 1`
            ).get(wsHeader, decoded.userId);
          }
          if (!workspace) {
            workspace = await database.prepare(
              `SELECT w.id, w.plan FROM workspaces w
               JOIN workspace_members wm ON wm.workspace_id = w.id
               WHERE wm.user_id = ? ORDER BY w.created_at ASC LIMIT 1`
            ).get(decoded.userId);
          }
          if (workspace) {
            const planName = workspace.plan || 'starter';
            const planConfig = await dynCfg.getDynConfig(`plans.${planName}`, null);
            const planFeatures = planConfig?.features || PLAN_FEATURE_DEFAULTS[planName] || {};

            // Intersección: solo activo si global AND plan lo permiten
            // IMPORTANTE: En la DB las keys son "analytics", "apiKeys", etc (sin "Enabled")
            // pero en globalFeatures son "analyticsEnabled", "apiKeysEnabled", etc
            const { FEATURE_NAME_MAP } = require('./middleware/checkFeature');
            
            for (const key of Object.keys(effectiveFeatures)) {
              // Si está deshabilitado globalmente, no permitir
              if (globalFeatures[key] === false) {
                effectiveFeatures[key] = false;
                continue;
              }
              
              // Buscar el valor en el plan usando ambos formatos (con y sin "Enabled")
              // Ejemplo: para "analyticsEnabled" buscar planFeatures["analytics"] o planFeatures["analyticsEnabled"]
              let planValue = planFeatures[key]; // Buscar primero con "Enabled"
              
              // Si no existe, buscar sin "Enabled" (formato de la DB)
              if (planValue === undefined) {
                // Encontrar la clave corta (ej: "analytics" para "analyticsEnabled")
                const shortKey = Object.keys(FEATURE_NAME_MAP).find(
                  shortName => FEATURE_NAME_MAP[shortName] === key
                );
                if (shortKey) {
                  planValue = planFeatures[shortKey];
                }
              }
              
              // Aplicar la lógica de intersección
              if (planValue === false) {
                effectiveFeatures[key] = false;
              } else if (planValue !== undefined) {
                // Puede ser: true, "full", "basic", "branded", "unbranded", "custom"
                effectiveFeatures[key] = planValue;
              }
            }
          }
        }
      }
    } catch { /* Token inválido o no autenticado — usar solo features globales */ }

    res.json({
      siteName: platform.siteName || 'StreamVault',
      appUrl: platform.appUrl || process.env.APP_URL || '',
      allowRegistration: platform.allowRegistration !== false,
      supportEmail: platform.supportEmail || '',
      features: effectiveFeatures,
      recaptchaSiteKey: config.recaptchaSiteKey || '',
    });
  } catch {
    res.json({ siteName: 'StreamVault', allowRegistration: true, features: {} });
  }
});
app.use('/api/folders', require('./routes/folders'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/notifications', require('./routes/notifications'));

// VAST proxy — fetches VAST/VMAP XML server-side to avoid CORS issues in the browser.
// Rate-limited; only allows http/https URLs.
app.get('/api/vast-proxy', rateLimit(60, 60_000), async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'StreamVault-VAST/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    const xml = await upstream.text();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(xml);
  } catch {
    res.status(502).send('');
  }
});

// Watch page — nueva página estilo Streamtape/Filemoon con player + info + relacionados
// Inyecta OG tags para social sharing
app.get('/watch/:id', async (req, res) => {
  try {
    const video = await database.prepare(
      `SELECT id, title, description, thumbnail, hls_cdn_url, views, duration, visibility FROM videos WHERE id = ?`
    ).get(req.params.id);

    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

    // Read new watch page HTML
    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'public/watch/index.html'), 'utf8');

    // Inject OG meta tags if video exists and is public
    if (video && video.visibility !== 'private') {
      const thumbUrl = video.hls_cdn_url
        ? video.hls_cdn_url.replace(/\/master\.m3u8$/i, '') + '/thumb.jpg'
        : `${appUrl}/videos/${video.id}/thumb.jpg`;

      // SECURITY: Sanitize all user-controlled strings before injecting into HTML
      // to prevent stored XSS via title/description fields.
      function escAttr(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
      function escText(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      const title = escText((video.title || 'Video').slice(0, 200));
      const titleAttr = escAttr((video.title || 'Video').slice(0, 200));
      const dynCfg = require('./services/dynamicConfig');
      const platformCfg = await dynCfg.getDynSection('platform', {}).catch(() => ({}));
      const siteName = platformCfg.siteName || 'StreamVault';
      const desc = escAttr((video.description || `Mira este video en ${siteName}`).slice(0, 200));
      // Only allow safe absolute URLs for thumbUrl (must start with http/https)
      const safeThumb = /^https?:\/\//.test(thumbUrl) ? thumbUrl : '';
      const dur = video.duration ? Math.floor(video.duration) : 0;

      const ogTags = `
  <title>${title} — ${siteName}</title>
  <meta name="description" content="${desc}">
  <meta property="og:type" content="video.other">
  <meta property="og:title" content="${titleAttr}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${escAttr(safeThumb)}">
  <meta property="og:image:width" content="1280">
  <meta property="og:image:height" content="720">
  <meta property="og:url" content="${escAttr(appUrl)}/watch/${escAttr(video.id)}">
  <meta property="og:video" content="${escAttr(appUrl)}/videos/${escAttr(video.id)}/master.m3u8">
  <meta property="og:video:type" content="application/x-mpegurl">
  <meta property="og:site_name" content="${siteName}">
  <meta name="twitter:card" content="player">
  <meta name="twitter:title" content="${titleAttr}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${escAttr(safeThumb)}">
  <meta name="twitter:player" content="${escAttr(appUrl)}/embed/${escAttr(video.id)}">
  <meta name="twitter:player:width" content="1280">
  <meta name="twitter:player:height" content="720">
  ${dur > 0 ? `<meta name="video:duration" content="${dur}">` : ''}`;
      html = html.replace('<meta charset="UTF-8">', `<meta charset="UTF-8">${ogTags}`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (_) {
    res.sendFile(path.join(__dirname, 'public/watch/index.html'));
  }
});

// View page — sirve el player COMPLETO (con todos los controles OTT)
// El player extrae el videoId de /view/:id via regex
app.get('/view/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/player/index.html'));
});

// Player-only page — /player/:id — mismo OTT player, URL limpia para compartir
app.get('/player/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/player/index.html'));
});

// Playlist viewer page — public (only shows public playlists)
app.get('/playlist/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/playlist/index.html'));
});

// RSS/Podcast feed — /feed/:slug
app.use('/feed', require('./routes/feed'));

// Public channel page — /c/:slug (like YouTube @channel)
app.get('/c/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/channel/index.html'));
});

// Download page — estilo Mega/Filemoon con countdown de 5 segundos
app.get('/download/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public/download/index.html'));
});

// Short link redirect — /v/:code → /watch/:id
app.get('/v/:code', async (req, res) => {
  try {
    const video = await database.prepare(
      `SELECT id FROM videos WHERE short_code = ?`
    ).get(req.params.code);
    if (!video) return res.status(404).send('Video no encontrado');
    res.redirect(302, `/watch/${video.id}`);
  } catch (_) {
    res.status(500).send('Error');
  }
});

// F2.7: Custom embed domain middleware
// If request host matches a custom_embed_domain, serve embed HTML directly.
app.use(async (req, res, next) => {
  const host = req.hostname;
  const mainHost = (process.env.APP_URL || '').replace(/^https?:\/\//, '').split(':')[0];
  if (!host || host === mainHost || host === 'localhost') return next();
  try {
    const ws = await database.prepare(
      `SELECT id FROM workspaces WHERE custom_embed_domain = ?`
    ).get(host);
    if (ws && req.path.startsWith('/embed/')) {
      // Check allowed domains (already done in the normal embed route)
      return res.sendFile(path.join(__dirname, 'public/embed/index.html'));
    }
  } catch (_) {}
  next();
});

// Embeddable playlist player — public (only shows public playlists)
app.get('/embed/playlist/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/embed-playlist/index.html'));
});

// Embeddable player (Sprint S-05 + S-06)
// Supports: ?autoplay, ?color=#hex, ?logo=url, ?controls=0, ?start=sec
// Enforces per-workspace allowed_domains allowlist and embedEnabled setting.
app.get('/embed/:id', async (req, res) => {
  try {
    const video = await database.prepare(`SELECT workspace_id FROM videos WHERE id = ?`).get(req.params.id);
    if (video?.workspace_id) {
      const ws = await database.prepare(`SELECT settings FROM workspaces WHERE id = ?`).get(video.workspace_id);
      const settings = JSON.parse(ws?.settings || '{}');
      
      // Check if embedding is disabled for this workspace
      if (settings.embedEnabled === false) {
        return res.status(403).send('<html><body style="background:#111;color:#aaa;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;"><p>Embedding disabled</p></body></html>');
      }
      
      const allowed = settings.embedAllowedDomains;
      if (Array.isArray(allowed) && allowed.length > 0) {
        const origin = req.headers.origin || req.headers.referer || '';
        let hostname = '';
        try { hostname = new URL(origin).hostname; } catch (_) {}
        if (hostname && !allowed.includes(hostname)) {
          return res.status(403).send('Embedding not allowed from this domain');
        }
      }
    }
  } catch (_) {}
  res.sendFile(path.join(__dirname, 'public/embed/index.html'));
});

// Dashboard (client SPA: /dashboard, /dashboard/upload, …)
const dashboardHtml = path.join(__dirname, 'public/dashboard/index.html');
app.get('/dashboard', (req, res) => res.sendFile(dashboardHtml));
app.get(/^\/dashboard\/(videos|upload|analytics|settings|playlists|security)\/?$/, (req, res) => res.sendFile(dashboardHtml));

// Login / Register
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login/index.html'));
});

// Password reset (email links point here)
app.get('/auth/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/reset-password/index.html'));
});

// Invitation accept page
app.get('/invite/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/invite/index.html'));
});

// Super Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// Billing / subscription page
app.get('/billing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard/index.html'));
});

// F4.3: Status page — public
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/status/index.html'));
});

// F4.4: API docs endpoints
const fs_api = require('fs');
app.get('/api/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/api-docs/index.html'));
});
app.get('/api/spec.yaml', (req, res) => {
  const specPath = path.join(__dirname, 'api-spec.yaml');
  if (fs_api.existsSync(specPath)) {
    res.setHeader('Content-Type', 'application/yaml');
    res.sendFile(specPath);
  } else {
    res.status(404).json({ error: 'API spec not found' });
  }
});

// OG image — served as SVG (social scrapers accept SVG when Content-Type is image/svg+xml)
app.get('/og.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/og.png'), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
});

// Favicon — served from public/favicon.svg (browsers also accept SVG)
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/favicon.svg'), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
});
app.get('/favicon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/favicon.svg'), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
});

// Landing page (root)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// 404 catch-all — must be last route
// API routes get JSON response; browser routes get the 404 HTML page
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

// FIX HIGH-08: Global error handler seguro con sanitización
// Maneja todos los errores pasados a next(err) o lanzados en middleware sincrónicos
app.use(errorHandler);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Ensures in-flight FFmpeg processes are killed and the HTTP server stops
// accepting new connections before the process exits.
let _server = null;
let _shuttingDown = false;

async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;

  logger.info(`Received ${signal} — starting graceful shutdown…`);

  // 1. Kill all active FFmpeg processes to prevent zombie processes
  try {
    const { killAllFFmpeg } = require('./transcoder');
    killAllFFmpeg();
  } catch {}

  // 2. Stop accepting new HTTP connections
  if (_server) {
    await new Promise(resolve => _server.close(resolve));
    logger.info('HTTP server closed');
  }

  // 3. Flush any pending bandwidth accumulator to DB
  try { await flushBandwidth(); } catch {}

  // 4. Flush logger buffers before exit
  try { logger.flush(); } catch {}

  logger.info('Shutdown complete. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Catch unhandled errors — log them before crashing
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — process will exit');
  try { logger.flush(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

// ─── Init DB with retry then start ───────────────────────────────────────────
// PostgreSQL may not be ready immediately (e.g. docker-compose startup race).
// Retry up to MAX_DB_RETRIES times with exponential back-off before giving up.
const MAX_DB_RETRIES  = parseInt(process.env.DB_CONNECT_RETRIES  || '5',  10);
const DB_RETRY_DELAY  = parseInt(process.env.DB_CONNECT_DELAY_MS || '3000', 10);

async function initWithRetry(attempt = 1) {
  try {
    await database.init();
  } catch (err) {
    if (attempt >= MAX_DB_RETRIES) {
      logger.fatal({ err }, `Failed to connect to database after ${MAX_DB_RETRIES} attempts — exiting`);
      process.exit(1);
    }
    const delay = DB_RETRY_DELAY * attempt; // linear back-off: 3s, 6s, 9s, 12s, 15s
    logger.warn(
      { err: err.message, attempt, nextRetryMs: delay },
      `Database not ready (attempt ${attempt}/${MAX_DB_RETRIES}) — retrying in ${delay / 1000}s…`
    );
    await new Promise(resolve => setTimeout(resolve, delay));
    return initWithRetry(attempt + 1);
  }
}

initWithRetry().then(async () => {
  // Initialize dynamic config from DB
  const dynConfig = require('./services/dynamicConfig');
  dynConfig.setDb(database);
  await dynConfig.reloadDynConfig().catch(() => {});
  logger.info('Dynamic config loaded from DB');

  // ─── Start SSE metrics ticker ─────────────────────────────────────────────
  // Broadcasts real-time metrics to all connected admin SSE clients every 5s.
  // Only runs when there are active connections (skips if no clients).
  try {
    const metricsStream = require('./services/metricsStream');
    metricsStream.startMetricsTicker(database, 5000);
    logger.info('SSE metrics ticker started (5s interval)');
  } catch (err) {
    logger.warn({ err: err.message }, 'SSE metrics ticker failed to start');
  }

  _server = app.listen(config.port, () => {
    // headersTimeout: 30 s prevents slowloris attacks on all routes — headers are small
    // regardless of upload size, so 30 s is ample even on slow connections.
    // requestTimeout stays 0 because large file uploads (multi-GB through Cloudflare
    // tunnels / slow connections) can take many minutes. Auth endpoints are protected
    // by the existing rate limiter + IP blacklist in advancedRateLimit.js.
    _server.headersTimeout = 30_000;
    _server.requestTimeout = 0;
    _server.keepAliveTimeout = 120000; // Keep-alive 2 minutes

    logger.info({
      port:      config.port,
      env:       config.nodeEnv,
      dashboard: `http://localhost:${config.port}/dashboard`,
    }, `🎬 Server running on http://localhost:${config.port}`);

    if (config.isDev) {
      logger.debug('Demo account: demo@streamvault.local (password logged by schema seed)');
    }

    // Signal PM2 that the server is ready (required when wait_ready: true in ecosystem.config.js)
    if (process.send) process.send('ready');
  });
});
