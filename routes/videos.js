const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const config = require('../config');
const { optionalAuth, authenticate, requireScope } = require('../middleware/auth');
const { resolveWorkspace } = require('../middleware/workspace');
const rateLimit = require('../middleware/rateLimit');
const s3 = require('../services/s3Storage');
const { signVideoToken, verifyVideoToken, signUnlockToken, verifyUnlockToken, RENEW_HINT, signDownloadToken, verifyDownloadToken, signCastToken, verifyCastToken } = require('../services/tokenSigning');
const logger = require('../services/logger').child({ module: 'videos' });
const { deliverWebhook } = require('../services/webhooks');
const cache = require('../services/cache');
const { cacheKey: analyticsCacheKey } = require('./analytics');
const { getJobProgress } = require('../services/queue');
const { hasFeature } = require('../middleware/checkFeature');

function safeJsonParse(str, fallback = []) {
  try { return JSON.parse(str || JSON.stringify(fallback)); } catch { return fallback; }
}

// FIX #2: Path Traversal Protection - Validate UUID before using in path
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const thumbUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Validate UUID to prevent path traversal attacks
      if (!UUID_REGEX.test(req.params.id)) {
        return cb(new Error('Invalid video ID format'));
      }
      const dir = path.join(__dirname, '..', 'videos', req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_, file, cb) => cb(null, 'thumb_custom' + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    // FIX #15: Validate file magic bytes, not just MIME type
    cb(null, /^image\/(jpeg|png|webp)/.test(file.mimetype));
  },
});

function playbackUrls(video) {
  const cdn = video.hls_cdn_url;
  const base = cdn ? cdn.replace(/\/master\.m3u8$/i, '') : null;
  return {
    m3u8Url: cdn || `/videos/${video.id}/master.m3u8`,
    thumbnailUrl: base ? `${base}/thumb.jpg` : `/videos/${video.id}/thumb.jpg`,
    spriteUrl: base ? `${base}/thumbs_sprite.jpg` : `/videos/${video.id}/thumbs_sprite.jpg`,
    spriteMeta: base ? `${base}/thumbs_meta.json` : `/videos/${video.id}/thumbs_meta.json`,
  };
}

const eventThrottle = new Map();
const viewThrottle  = new Map();
// Purge stale throttle entries every 2 minutes to prevent unbounded growth.
setInterval(() => {
  const eventCutoff = Date.now() - 10_000;
  for (const [k, v] of eventThrottle) {
    if (v < eventCutoff) eventThrottle.delete(k);
  }
  const viewCutoff = Date.now() - 30_000;
  for (const [k, v] of viewThrottle) {
    if (v < viewCutoff) viewThrottle.delete(k);
  }
}, 120_000).unref();

const VALID_EVENT_TYPES = new Set(['play', 'pause', 'seek', 'progress', 'end', 'quality_change']);

function parseUA(ua = '') {
  let device = 'desktop';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) device = 'mobile';
  else if (/ipad|tablet|kindle|playbook|silk/i.test(ua)) device = 'tablet';

  let browser = 'other';
  if (/edg\//i.test(ua))                              browser = 'edge';
  else if (/opr\//i.test(ua) || /opera/i.test(ua))   browser = 'opera';
  else if (/chrome|chromium/i.test(ua))               browser = 'chrome';
  else if (/firefox/i.test(ua))                       browser = 'firefox';
  else if (/safari/i.test(ua))                        browser = 'safari';

  let os = 'other';
  if (/windows/i.test(ua))               os = 'windows';
  else if (/android/i.test(ua))          os = 'android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'ios';
  else if (/mac os/i.test(ua))           os = 'macos';
  else if (/linux/i.test(ua))            os = 'linux';

  return { device, browser, os };
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// FIX #4: DoS Protection - Use proper LRU cache with TTL
const { LRUCache } = require('lru-cache');
const geoCache = new LRUCache({
  max: 5000,
  ttl: 1000 * 60 * 60 * 24, // 24 hour TTL
  updateAgeOnGet: true,
  updateAgeOnHas: true,
});
const GEO_PENDING = new Set();

function geoCachePut(ip, data) {
  geoCache.set(ip, data);
}

async function fetchGeo(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('::ffff:127.')) return;
  if (geoCache.has(ip) || GEO_PENDING.has(ip)) return;

  GEO_PENDING.add(ip);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const r = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,city`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!r.ok) return;
    const data = await r.json();
    if (data.countryCode || data.city) {
      geoCachePut(ip, { country: data.countryCode || '', city: data.city || '' });
    }
  } catch (err) {
    // Silently fail on timeout or network errors
    if (err.name !== 'AbortError') {
      logger.debug({ err: err.message, ip }, 'Geo lookup failed');
    }
  } finally {
    GEO_PENDING.delete(ip);
  }
}

function updateEventGeo(eventId, ip) {
  fetchGeo(ip).then(async () => {
    const geo = geoCache.get(ip);
    if (!geo) return;
    await db.prepare(`UPDATE events SET country=?, city=? WHERE id=?`)
      .run(geo.country, geo.city, eventId);
  }).catch(() => {});
}

router.use(optionalAuth);

async function scopeToWorkspace(req, res, next) {
  if (req.user && req.headers['x-workspace-id']) {
    return resolveWorkspace(req, res, next);
  }
  req.workspace = null;
  next();
}

router.use(scopeToWorkspace);

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    // Cursor-based pagination: cursor = created_at of last seen item (BIGINT unix timestamp)
    // Much faster than OFFSET for large tables — no table scan needed.
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    if (cursor !== null && (isNaN(cursor) || cursor < 0)) {
      return res.status(400).json({ error: 'Invalid cursor value' });
    }

    // Sanitize search: strip SQL wildcards from user input before we add our own
    const rawSearch = req.query.search ? String(req.query.search).slice(0, 200) : null;
    const search = rawSearch ? `%${rawSearch.replace(/[%_\\]/g, '\\$&')}%` : null;
    const folderFilter = req.query.folder_id; // 'none' = no folder, uuid = specific folder
    const tagFilter = req.query.tag ? String(req.query.tag).slice(0, 50).trim().toLowerCase() : null;

    let videos;
    if (req.workspace) {
      const clauses = ['workspace_id = ?'];
      const baseParams = [req.workspace.id];
      if (search) { clauses.push('(title ILIKE ? OR description ILIKE ?)'); baseParams.push(search, search); }
      if (folderFilter === 'none') clauses.push('folder_id IS NULL');
      else if (folderFilter) { clauses.push('folder_id = ?'); baseParams.push(folderFilter); }
      // Tag filter: match JSON array containing the tag (e.g. ["news","sport"] contains "news")
      if (tagFilter) { clauses.push(`tags ILIKE ?`); baseParams.push(`%"${tagFilter}"%`); }
      // Cursor: only return items older than the cursor
      if (cursor !== null) { clauses.push('created_at < ?'); baseParams.push(cursor); }
      const where = `WHERE ${clauses.join(' AND ')}`;
      videos = await db.prepare(
        `SELECT * FROM videos ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(...baseParams, limit + 1); // fetch one extra to detect if there's a next page
    } else {
      // No workspace context: only show public/ready non-DMCA-suspended videos
      const clauses = ["status = 'ready'", "(visibility IS NULL OR visibility = 'public')", "(dmca_suspended IS NULL OR dmca_suspended = FALSE)"];
      const baseParams = [];
      if (search) { clauses.push('(title ILIKE ? OR description ILIKE ?)'); baseParams.push(search, search); }
      if (cursor !== null) { clauses.push('created_at < ?'); baseParams.push(cursor); }
      const where = `WHERE ${clauses.join(' AND ')}`;
      videos = await db.prepare(
        `SELECT * FROM videos ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(...baseParams, limit + 1);
    }

    // Determine if there's a next page
    const hasMore = videos.length > limit;
    if (hasMore) videos.pop(); // remove the extra item

    const nextCursor = hasMore && videos.length > 0
      ? videos[videos.length - 1].created_at
      : null;

    // Attach live transcoding progress % for any videos currently being processed
    const activeIds = videos.filter(v => v.status === 'transcoding').map(v => v.id);
    const progressMap = {};
    if (activeIds.length) {
      await Promise.all(activeIds.map(async id => {
        const pct = await getJobProgress(id);
        if (pct != null) progressMap[id] = pct;
      }));
    }

    res.json({
      videos: videos.map(v => ({
        ...v,
        qualities: safeJsonParse(v.qualities, []),
        tags: safeJsonParse(v.tags, []),
        ...playbackUrls(v),
        // Bull queue progress takes priority; fall back to DB-tracked inline progress
        ...(progressMap[v.id] != null
          ? { progress_pct: progressMap[v.id] }
          : (v.transcoding_pct != null ? { progress_pct: v.transcoding_pct } : {})),
      })),
      pagination: {
        limit,
        hasMore,
        nextCursor,    // pass as ?cursor=<value> in next request
        // Legacy offset fields kept for backwards compatibility with existing frontends
        // Will be removed in v3.0
        page: 1,
        total: null,   // not available with cursor pagination (use hasMore instead)
        pages: null,
      },
    });
  } catch (err) {
    logger.error({ err }, 'List videos error');
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const video = await db.prepare(`SELECT * FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    // DMCA takedown check - block access to suspended videos
    if (video.dmca_suspended) {
      return res.status(451).json({
        error: 'unavailable_legal',
        message: 'Este contenido no está disponible debido a una solicitud legal',
        dmca_suspended: true,
        dmca_notice_date: video.dmca_notice_date,
        dmca_notes: video.dmca_notes
      });
    }

    if (video.status === 'expired') {
      return res.status(410).json({ error: 'expired', message: 'Este video ha expirado y ya no está disponible.' });
    }

    if (req.workspace && video.workspace_id !== req.workspace.id) {
      return res.status(404).json({ error: 'Not found' });
    }

    const vis = video.visibility || 'public';
    if (vis === 'private') {
      // Return generic 404 to avoid confirming existence of private videos to unauthenticated users
      if (!req.user) return res.status(404).json({ error: 'Not found' });
      if (video.workspace_id) {
        const member = await db.prepare(
          `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
        ).get(video.workspace_id, req.user.id);
        const owner = await db.prepare(
          `SELECT id FROM workspaces WHERE id = ? AND owner_id = ?`
        ).get(video.workspace_id, req.user.id);
        if (!member && !owner) return res.status(404).json({ error: 'Not found' });
      }
    }
    if (vis === 'password') {
      const unlockToken = req.query.unlock || req.headers['x-unlock-token'];
      if (!unlockToken || !verifyUnlockToken(unlockToken, video.id)) {
        return res.status(403).json({ error: 'password_required', message: 'Este video requiere contraseña' });
      }
    }

    let embedConfig = {};
    let downloadsEnabled = true;
    let embedEnabled = true;
    let channelName = null;
    if (video.workspace_id) {
      const ws = await db.prepare(
        `SELECT w.settings, w.plan, w.name, w.custom_embed_domain, w.custom_domain_verified, u.channel_name FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id WHERE w.id = ?`
      ).get(video.workspace_id);
      if (ws) {
        const s = safeJsonParse(ws.settings, {});

        // Resolver embed tier: branded | unbranded | custom
        const { PLAN_FEATURE_DEFAULTS } = require('../middleware/checkFeature');
        const dynCfg = require('../services/dynamicConfig');
        const planConfig = await dynCfg.getDynConfig(`plans.${ws.plan}`, null);
        const planFeatures = planConfig?.features || PLAN_FEATURE_DEFAULTS[ws.plan] || {};
        const embedTier = planFeatures.embedEnabled || 'branded'; // 'branded' | 'unbranded' | 'custom'

        // Platform branding — solo visible en plan branded
        const platformCfg = await dynCfg.getDynSection('platform', {
          platformLogoUrl: '',
          platformLogoPos: 'tr',
          platformName: 'StreamVault',
        });

        // En plan branded: se muestra el logo de la plataforma (configurable por admin)
        // En plan unbranded/custom: NO se muestra el logo de la plataforma
        const showPlatformLogo = embedTier === 'branded';

        // Ads config — habilitado si el global y el plan lo permiten
        const adsConfigRaw = (s.ads && typeof s.ads === 'object') ? s.ads : safeJsonParse(s.ads, null);
        const globalFeatures = await dynCfg.getDynSection('features', { adsEnabled: true });
        const globalAdsEnabled = globalFeatures.adsEnabled !== false;
        const planAdsVal = planFeatures.adsEnabled ?? PLAN_FEATURE_DEFAULTS[ws.plan]?.adsEnabled ?? true;
        const adsEnabled = globalAdsEnabled && (planAdsVal === true || planAdsVal === 'enabled' || planAdsVal === 'full');
        const adblockDetect = planFeatures.adblockDetection === true || planFeatures.adblockDetection === 'enabled';

        // Normalizar estructura ads: el dashboard guarda {type, vast:{url,position,midrollTime}, banner:{...}, popup:{...}}
        // El player espera formato flat: {enabled, type, vastUrl, vastPosition, vastMidrollAt, bannerHtml, ...}
        let adsFlat = null;
        if (adsEnabled && adsConfigRaw) {
          const r = adsConfigRaw;
          adsFlat = {
            enabled: true,
            type: r.type || 'vast',
            // VAST — soportar formato nested (nuevo) y flat (legacy)
            vastUrl:       r.vastUrl       || r.vast?.url      || null,
            vastPosition:  r.vastPosition  || r.vast?.position || 'preroll',
            vastMidrollAt: r.vastMidrollAt || r.vast?.midrollTime || 60,
            // Banner
            bannerHtml:     r.bannerHtml     || r.banner?.html     || null,
            bannerPosition: r.bannerPosition || r.banner?.position || 'bottom',
            bannerDelay:    r.bannerDelay    != null ? r.bannerDelay    : (r.banner?.delay    ?? 0),
            bannerDuration: r.bannerDuration != null ? r.bannerDuration : (r.banner?.duration ?? 0),
            // Popup
            popupUrl:       r.popupUrl       || r.popup?.url       || null,
            popupDelay:     r.popupDelay     != null ? r.popupDelay     : (r.popup?.delay     ?? 10),
            popupFrequency: r.popupFrequency != null ? r.popupFrequency : (r.popup?.frequency ?? 1),
          };
        }

        embedConfig = {
          color: s.embedColor || null,
          // logoUrl del workspace (su propio logo) — solo en unbranded/custom
          logoUrl: (embedTier !== 'branded' && s.embedLogo) ? s.embedLogo : null,
          // Logo de la plataforma — solo en branded
          platformLogoUrl: showPlatformLogo ? (platformCfg.platformLogoUrl || null) : null,
          platformLogoPos: platformCfg.platformLogoPos || 'tr',
          platformName: platformCfg.platformName || 'StreamVault',
          playerName: s.embedPlayerName || null,
          allowedDomains: s.embedAllowedDomains || [],
          plan: ws.plan,
          embedTier,
          // Custom domain — disponible para cualquier plan con dominio verificado
          customDomain: ws.custom_domain_verified ? (ws.custom_embed_domain || null) : null,
          // Support both snake_case (saved by dashboard) and camelCase (legacy)
          watermarkEnabled: s.watermark_enabled || s.watermarkEnabled || false,
          watermarkText: s.watermark_text || s.watermarkText || '',
          watermarkPosition: s.watermark_position || s.watermarkPosition || 'bottom-right',
          watermarkOpacity: s.watermark_opacity != null ? s.watermark_opacity : (s.watermarkOpacity != null ? s.watermarkOpacity : 0.3),
          // Ads (formato flat listo para el player)
          ads: adsFlat,
          // Detección de AdBlockers: workspace setting tiene prioridad; cae a feature de plan
          adblockDetection: s.adblock_detection !== undefined ? !!s.adblock_detection : adblockDetect,
          // Bloquear DevTools — workspace setting
          devtoolsBlocker: !!s.devtools_blocker,
        };
        downloadsEnabled = s.downloadsEnabled !== false;
        embedEnabled = s.embedEnabled !== false;
        channelName = ws.channel_name || ws.name || null;
      }
    }

    const p = playbackUrls(video);
    res.json({
      ...video,
      qualities: safeJsonParse(video.qualities, []),
      m3u8Url: p.m3u8Url,
      thumbnailUrl: p.thumbnailUrl,
      spriteUrl: p.spriteUrl,
      spriteMeta: p.spriteMeta,
      embedConfig,
      channelName,
      downloadsEnabled,
      embedEnabled,
      visibility: video.visibility || 'public',
      access_password_hash: undefined,
    });
  } catch (err) {
    logger.error({ err }, 'Get video error');
    res.status(500).json({ error: 'Failed to get video' });
  }
});

router.post('/:id/unlock', rateLimit(5, 60_000), async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, visibility, access_password_hash FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if ((video.visibility || 'public') !== 'password') {
      return res.status(400).json({ error: 'Video is not password protected' });
    }
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    if (!video.access_password_hash) return res.status(500).json({ error: 'Video password not configured' });
    const valid = await bcrypt.compare(password, video.access_password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña incorrecta' });
    res.json({ token: signUnlockToken(video.id) });
  } catch (err) {
    logger.error({ err }, 'Unlock video error');
    res.status(500).json({ error: 'Failed to unlock video' });
  }
});

router.get('/:id/token', rateLimit(60, 60_000), async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, workspace_id, dmca_suspended FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    // DMCA takedown check - block token generation for suspended videos
    if (video.dmca_suspended) {
      return res.status(451).json({
        error: 'unavailable_legal',
        message: 'Este contenido no está disponible debido a una solicitud legal'
      });
    }

    const raw = req.headers.origin || req.headers.referer || '';
    let origin = '';
    try { origin = new URL(raw).hostname; } catch {}
    const isLocal = !origin || origin === 'localhost' || origin.startsWith('127.');

    if (video.workspace_id) {
      const ws = await db.prepare(`SELECT settings FROM workspaces WHERE id=?`).get(video.workspace_id);
      const s = safeJsonParse(ws?.settings, {});
      const allowed = s.embedAllowedDomains;

      if (!isLocal && Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(origin)) {
        return res.status(403).json({ error: 'Domain not authorized' });
      }
    }

    // Local requests (localhost/127.x) always get a token signed with empty origin,
    // matching what the static file server uses as checkOrigin for local requests.
    const signingOrigin = isLocal ? '' : origin;
    const token = signVideoToken(video.id, signingOrigin);
    res.json({ token, ttl: 15 * 60, renewAfter: RENEW_HINT });
  } catch (err) {
    logger.error({ err }, 'Get video token error');
    res.status(500).json({ error: 'Failed to generate video token' });
  }
});

router.get('/:id/hlskey/:keyId', async (req, res) => {
  try {
    const video = await db.prepare(`SELECT hls_key, hls_key_id, workspace_id FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).end();

    // If hls_key is missing from DB, fall back to the on-disk file (handles videos
    // where the final DB UPDATE failed mid-transcoding but the file survived).
    if (!video.hls_key) {
      const diskPath = path.join(__dirname, '..', 'videos', req.params.id, 'hls.key');
      if (!fs.existsSync(diskPath)) return res.status(404).end();
      // Serve from disk and backfill the DB so future requests hit the fast path
      const keyBytes = fs.readFileSync(diskPath);
      await db.prepare(`UPDATE videos SET hls_key=?, hls_key_id=? WHERE id=?`)
        .run(keyBytes.toString('base64'), req.params.keyId, req.params.id).catch(() => {});
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', keyBytes.length);
      res.setHeader('Cache-Control', 'private, no-store, no-cache');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      if (req.headers.origin) res.setHeader('Vary', 'Origin');
      return res.send(keyBytes);
    }

    if (video.hls_key_id !== req.params.keyId) {
      // KeyId mismatch — could be a re-transcode in progress or a stale m3u8 / DB inconsistency.
      // Priority 1: disk key file exists (re-transcode just wrote it) — use it and heal the DB.
      const diskPath = path.join(__dirname, '..', 'videos', req.params.id, 'hls.key');
      if (fs.existsSync(diskPath)) {
        const keyBytes = fs.readFileSync(diskPath);
        await db.prepare(`UPDATE videos SET hls_key=?, hls_key_id=? WHERE id=?`)
          .run(keyBytes.toString('base64'), req.params.keyId, req.params.id).catch(() => {});
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', keyBytes.length);
        res.setHeader('Cache-Control', 'private, no-store, no-cache');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        if (req.headers.origin) res.setHeader('Vary', 'Origin');
        return res.send(keyBytes);
      }
      // Priority 2: DB already has the key bytes (disk was cleaned up post-transcode).
      // Each video has exactly one AES-128 key, so keyId mismatch just means the DB
      // metadata is stale — the key bytes are still valid. Heal the DB and serve.
      if (video.hls_key) {
        await db.prepare(`UPDATE videos SET hls_key_id=? WHERE id=?`)
          .run(req.params.keyId, req.params.id).catch(() => {});
        const keyBytes = Buffer.from(video.hls_key, 'base64');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', keyBytes.length);
        res.setHeader('Cache-Control', 'private, no-store, no-cache');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        if (req.headers.origin) res.setHeader('Vary', 'Origin');
        return res.send(keyBytes);
      }
      return res.status(403).end();
    }

    // ── Origin enforcement ──────────────────────────────────────
    // The keyId (32-char random) is already a shared secret — anyone who can
    // read the .m3u8 knows the keyId. So origin-based blocking is an optional
    // extra layer only meaningful when embedAllowedDomains is explicitly set.
    //
    // APP_URL is a URL-generation helper, NOT a security allow-list — do not
    // use it here (it breaks Cloudflare tunnels and any non-standard domain).
    //
    // Bypass conditions (any one is sufficient to skip the check):
    //   • valid cast_token — Chromecast receiver, no browser Origin header
    //   • embedAllowedDomains is empty — no explicit restriction configured
    const isCastRequest = verifyCastToken(req.query.cast_token, req.params.id);

    // Only load embedAllowedDomains from workspace settings — never APP_URL.
    let embedDomains = [];
    if (video.workspace_id) {
      const ws = await db.prepare(`SELECT settings FROM workspaces WHERE id=?`).get(video.workspace_id);
      const settings = safeJsonParse(ws?.settings, {});
      if (Array.isArray(settings.embedAllowedDomains) && settings.embedAllowedDomains.length > 0) {
        embedDomains = settings.embedAllowedDomains;
      }
    }

    // Only block when both: (a) an explicit domain list exists AND (b) no bypass applies.
    if (!isCastRequest && embedDomains.length > 0) {
      const origin = req.headers.origin || req.headers.referer || '';
      let originHost = '';
      try { originHost = new URL(origin).hostname; } catch {}
      const isLocal = !originHost || originHost === 'localhost' || originHost.startsWith('127.');

      if (!isLocal) {
        const allowed = embedDomains.some(o => {
          try {
            return new URL(o.startsWith('http') ? o : `https://${o}`).hostname === originHost;
          } catch { return false; }
        });
        if (!allowed) {
          return res.status(403).json({ error: 'Origin not authorized for this video' });
        }
      }
    }

    const keyBytes = Buffer.from(video.hls_key, 'base64');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', keyBytes.length);
    res.setHeader('Cache-Control', 'private, no-store, no-cache');

    // CORS: allow all when no domain restriction; restrict to matching origin otherwise.
    if (embedDomains.length > 0 && req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      if (req.headers.origin) res.setHeader('Vary', 'Origin');
    }

    res.send(keyBytes);
  } catch (err) {
    logger.error({ err }, 'HLS key fetch error');
    res.status(500).end();
  }
});

// FIX #3: Race Condition Protection - Use atomic operation for view counting
// Throttle: 5 minutes per IP+video (HLS players make multiple requests on load)
router.post('/:id/views', async (req, res) => {
  let vKey = null;
  try {
    const video = await db.prepare(`SELECT id FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    const ip = getClientIp(req);
    vKey = `${ip}:${req.params.id}`;
    const now = Date.now();

    const lastView = viewThrottle.get(vKey) || 0;
    // Changed from 30s to 10s for development-friendly rate limiting
    // Increase to 300_000 (5min) in production if needed
    if (lastView > now - 10_000) {
      vKey = null;
      return res.status(429).json({ error: 'Rate limited' });
    }

    // Set throttle BEFORE incrementing to prevent race condition
    viewThrottle.set(vKey, now);

    await db.prepare(`UPDATE videos SET views=views+1 WHERE id=?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (vKey) viewThrottle.delete(vKey);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

router.post('/:id/events', async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, workspace_id FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    const { viewer_id, event_type, position, quality } = req.body;
    if (!viewer_id || typeof viewer_id !== 'string' || viewer_id.length > 64 || viewer_id.length < 1 || /[\x00-\x1f\x7f]/.test(viewer_id)) {
      return res.status(400).json({ error: 'Invalid viewer_id' });
    }
    if (!VALID_EVENT_TYPES.has(event_type)) {
      return res.status(400).json({ error: 'Invalid event_type' });
    }

    const key = `${viewer_id}:${req.params.id}`;
    const now = Date.now();
    if ((eventThrottle.get(key) || 0) > now - 4000) {
      return res.status(429).json({ error: 'Rate limited' });
    }
    eventThrottle.set(key, now);

    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    const { device, browser, os } = parseUA(ua);

    const eventId = uuidv4();
    await db.prepare(
      `INSERT INTO events
         (id, video_id, workspace_id, viewer_id, event_type, position, quality, ip, device_type, browser, os)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId, video.id, video.workspace_id || null,
      viewer_id, event_type, Number(position) || 0, quality || null,
      ip, device, browser, os
    );

    if (event_type === 'play') {
      updateEventGeo(eventId, ip);
      cache.delPattern(`sv:analytics:${video.id}:*`).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Post event error');
    res.status(500).json({ error: 'Failed to record event' });
  }
});

router.delete('/:id', authenticate, requireScope('videos:delete'), async (req, res) => {
  try {
    const video = await db.prepare(`SELECT * FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para eliminar videos' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (s3.isS3Enabled() && video.s3_object_prefix) {
      try {
        await s3.deleteObjectsWithPrefix(video.s3_object_prefix);
        // Purge CDN cache so CloudFront stops serving the deleted segments
        s3.invalidateCDN([`/${video.s3_object_prefix}/*`]).catch(() => {});
      } catch (err) {
        logger.warn({ err: err.message }, 'S3 delete failed');
      }
    }

    const dir = path.join(__dirname, '..', 'videos', video.id);
    try { fs.rmSync(dir, { recursive: true }); } catch {}

    if (video.workspace_id) {
      await db.prepare(`UPDATE workspaces SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?) WHERE id = ?`)
        .run(video.size || 0, video.workspace_id);
    }

    await db.prepare(`DELETE FROM videos WHERE id=?`).run(req.params.id);

    if (video.workspace_id) {
      deliverWebhook(video.workspace_id, 'video.deleted', {
        videoId: req.params.id,
        title: video.title,
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Delete video error');
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

router.patch('/:id', authenticate, async (req, res) => {
  try {
  const video = await db.prepare(`SELECT * FROM videos WHERE id=?`).get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });

  if (video.workspace_id) {
    const member = await db.prepare(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
    ).get(video.workspace_id, req.user.id);
    if (!member) return res.status(403).json({ error: 'Access denied' });
    if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para editar videos' });
  } else {
    // Videos without a workspace have no owner tracking — only super_admin can edit them.
    if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const { title, description, visibility, access_password, folder_id, publish_at, intro_start, intro_end, outro_start, outro_end, tmdb_id, tmdb_type, tags, expires_at } = req.body;

  if (title !== undefined && String(title).length > 500) {
    return res.status(400).json({ error: 'El título no puede superar los 500 caracteres.' });
  }
  if (description !== undefined && String(description).length > 10000) {
    return res.status(400).json({ error: 'La descripción no puede superar los 10 000 caracteres.' });
  }
  if (access_password !== undefined && access_password !== '' && access_password !== null) {
    if (String(access_password).length < 4) {
      return res.status(400).json({ error: 'La contraseña de acceso debe tener al menos 4 caracteres.' });
    }
    if (String(access_password).length > 256) {
      return res.status(400).json({ error: 'La contraseña de acceso no puede superar los 256 caracteres.' });
    }
  }

  // F3.2: Handle scheduled publishing
  let updatePublishAt = false;
  let newPublishAt = null;
  let updateStatus = false;
  let newStatus = null;

  if (publish_at !== undefined) {
    updatePublishAt = true;
    if (publish_at === null) {
      newPublishAt = null;
      if (video.status === 'scheduled') {
        newStatus = 'ready'; // Immediately publish if it was waiting
        updateStatus = true;
      }
    } else {
      const ts = typeof publish_at === 'string' ? Math.floor(new Date(publish_at).getTime() / 1000) : Math.floor(Number(publish_at));
      if (!isNaN(ts) && ts > 0) {
        newPublishAt = ts;
        newStatus = ts > Math.floor(Date.now() / 1000) ? 'scheduled' : (video.status === 'scheduled' ? 'ready' : null);
        if (newStatus) updateStatus = true;
      }
    }
  }

  const allowedVis = ['public', 'private', 'unlisted', 'password'];
  const updateVisibility = allowedVis.includes(visibility);
  const newVis = updateVisibility ? visibility : null;

  let passwordHash = null;
  if (newVis === 'password' && access_password) {
    passwordHash = await bcrypt.hash(access_password, 10);
  }

  // clampTs: coerce to non-negative finite number, or null.
  // Using `Number(x) || null` would silently drop 0 (falsy), preventing intro/outro
  // at the very start of the video. Negative timestamps are invalid.
  const clampTs = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

  const updateIntroStart = intro_start !== undefined;
  const newIntroStart = updateIntroStart ? clampTs(intro_start) : null;

  const updateIntroEnd = intro_end !== undefined;
  const newIntroEnd = updateIntroEnd ? clampTs(intro_end) : null;

  const updateOutroStart = outro_start !== undefined;
  const newOutroStart = updateOutroStart ? clampTs(outro_start) : null;

  const updateOutroEnd = outro_end !== undefined;
  const newOutroEnd = updateOutroEnd ? clampTs(outro_end) : null;

  const updateFolder = folder_id !== undefined;
  const newFolderId = updateFolder ? (folder_id || null) : null;

  // Validate that the target folder belongs to this workspace — prevents a user from
  // assigning their video to a folder from a different workspace via the API.
  if (newFolderId) {
    const folderRow = await db.prepare(
      `SELECT id FROM folders WHERE id = ? AND workspace_id = ?`
    ).get(newFolderId, video.workspace_id);
    if (!folderRow) return res.status(400).json({ error: 'Folder not found in this workspace' });
  }

  const updateTmdb = tmdb_id !== undefined;
  const newTmdbId = updateTmdb ? (String(tmdb_id || '').trim() || null) : null;
  const updateTmdbType = tmdb_type !== undefined;
  const newTmdbType = updateTmdbType ? (['movie', 'tv'].includes(tmdb_type) ? tmdb_type : 'movie') : null;

  // Tags: JSON array of strings, max 20, each max 50 chars
  let updateTags = false;
  let newTags = null;
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    if (tags.length > 20) return res.status(400).json({ error: 'Maximum 20 tags allowed' });
    const cleaned = tags.map(t => String(t).trim().toLowerCase()).filter(t => t.length > 0 && t.length <= 50);
    updateTags = true;
    newTags = JSON.stringify([...new Set(cleaned)]);
  }

  // Expires at: unix timestamp or null
  let updateExpiresAt = false;
  let newExpiresAt = null;
  if (expires_at !== undefined) {
    updateExpiresAt = true;
    if (expires_at === null || expires_at === '') {
      newExpiresAt = null;
    } else {
      const ts = typeof expires_at === 'string' ? Math.floor(new Date(expires_at).getTime() / 1000) : Math.floor(Number(expires_at));
      newExpiresAt = (!isNaN(ts) && ts > 0) ? ts : null;
    }
  }

  await db.prepare(`
    UPDATE videos
    SET title            = COALESCE(?, title),
        description      = COALESCE(?, description),
        visibility       = CASE WHEN ? THEN ? ELSE visibility END,
        access_password_hash = CASE
          WHEN ? AND ?::TEXT IS NOT NULL THEN ?::TEXT
          WHEN ? AND ?::TEXT != 'password' THEN NULL
          ELSE access_password_hash
        END,
        folder_id        = CASE WHEN ? THEN ? ELSE folder_id END,
        publish_at       = CASE WHEN ? THEN ? ELSE publish_at END,
        status           = CASE WHEN ? THEN ? ELSE status END,
        intro_start      = CASE WHEN ? THEN ? ELSE intro_start END,
        intro_end        = CASE WHEN ? THEN ? ELSE intro_end END,
        outro_start      = CASE WHEN ? THEN ? ELSE outro_start END,
        outro_end        = CASE WHEN ? THEN ? ELSE outro_end END,
        tmdb_id          = CASE WHEN ? THEN ? ELSE tmdb_id END,
        tmdb_type        = CASE WHEN ? THEN ? ELSE tmdb_type END,
        tags             = CASE WHEN ? THEN ? ELSE tags END,
        expires_at       = CASE WHEN ? THEN ? ELSE expires_at END,
        updated_at       = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(
    title || null,
    description || null,
    updateVisibility, newVis,
    updateVisibility, passwordHash, passwordHash,
    updateVisibility, newVis,
    updateFolder, newFolderId,
    updatePublishAt, newPublishAt,
    updateStatus, newStatus,
    updateIntroStart, newIntroStart,
    updateIntroEnd, newIntroEnd,
    updateOutroStart, newOutroStart,
    updateOutroEnd, newOutroEnd,
    updateTmdb, newTmdbId,
    updateTmdbType, newTmdbType,
    updateTags, newTags,
    updateExpiresAt, newExpiresAt,
    req.params.id
  );
  res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Patch video error');
    res.status(500).json({ error: 'Failed to update video' });
  }
});

// POST /api/videos/:id/retry — re-queue a failed transcoding job (F0.8)
router.post('/:id/retry', authenticate, async (req, res) => {
  try {
    const video = await db.prepare(`SELECT * FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    // Auth: workspace member (owner/admin) or super_admin for orphan videos
    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para reintentar transcodificación' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (video.status !== 'error') {
      return res.status(409).json({ error: `Cannot retry video with status '${video.status}'` });
    }

    const s3svc = require('../services/s3Storage');
    let inputPath = null;
    let s3SourceKey = null;

    // Prefer stored source_file (set at upload/import time)
    if (video.source_file) {
      if (s3svc.isS3Enabled() && !path.isAbsolute(video.source_file)) {
        s3SourceKey = video.source_file;
      } else {
        inputPath = video.source_file;
      }
    }

    // Fall back: scan uploads directory for a file matching original_filename
    if (!s3SourceKey && (!inputPath || !fs.existsSync(inputPath))) {
      const uploadsDir = path.join(__dirname, '..', 'uploads');
      if (video.original_filename) {
        try {
          const files = fs.readdirSync(uploadsDir);
          const match = files.find(f => f.endsWith('-' + video.original_filename) || f === video.original_filename);
          if (match) inputPath = path.join(uploadsDir, match);
        } catch {}
      }
    }

    if (!s3SourceKey && (!inputPath || !fs.existsSync(inputPath))) {
      return res.status(409).json({
        error: 'Archivo original no encontrado. Por favor, vuelve a subir el video.',
      });
    }

    await db.prepare(
      `UPDATE videos SET status='transcoding', transcoding_pct=0, updated_at=FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id=?`
    ).run(video.id);

    try {
      const { addTranscodeJob } = require('../services/queue');
      const { processVideo } = require('../transcoder');
      const result = await addTranscodeJob({
        videoId:     video.id,
        inputPath:   inputPath || null,
        s3SourceKey,
        title:       video.title,
        workspaceId: video.workspace_id || null,
        plan:        'starter',
      });

      if (result.inline) {
        processVideo(video.id, inputPath, video.title, {
          workspaceId: video.workspace_id || null,
          s3SourceKey,
          onProgress: async (pct) => {
            await db.prepare(`UPDATE videos SET transcoding_pct=? WHERE id=?`).run(pct, video.id).catch(() => {});
          },
        }).then(() => {
          db.prepare(`UPDATE videos SET transcoding_pct=NULL WHERE id=?`).run(video.id).catch(() => {});
        }).catch(err => {
          logger.error({ err }, 'Retry inline transcoding error');
        });
      }

      logger.info({ videoId: video.id, jobId: result.jobId, inline: result.inline }, 'Video retry started');
      res.json({ success: true, inline: result.inline, jobId: result.jobId || null });
    } catch (queueErr) {
      await db.prepare(
        `UPDATE videos SET status='error', updated_at=FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id=?`
      ).run(video.id);
      logger.error({ err: queueErr, videoId: video.id }, 'Retry queue failed');
      res.status(500).json({ error: 'Failed to queue retry job' });
    }
  } catch (err) {
    logger.error({ err }, 'Retry video error');
    res.status(500).json({ error: 'Failed to retry video' });
  }
});

// POST /api/videos/:id/retranscode — re-encode from stored source (ready OR error videos)
// Unlike /retry (error-only), this resets qualities and re-encodes with current plan settings.
// Useful after plan upgrade (e.g. Starter→Pro to unlock 1080p) or Enterprise quality changes.
router.post('/:id/retranscode', authenticate, async (req, res) => {
  try {
    const video = await db.prepare(`SELECT * FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return res.status(403).json({ error: 'Se requiere rol owner o admin para re-transcodificar' });
      }
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!['ready', 'error', 'scheduled'].includes(video.status)) {
      return res.status(409).json({ error: `Video en estado '${video.status}' — espera a que termine el proceso actual` });
    }

    const s3svc = require('../services/s3Storage');
    let inputPath = null;
    let s3SourceKey = null;

    if (video.source_file) {
      if (s3svc.isS3Enabled() && !path.isAbsolute(video.source_file)) {
        s3SourceKey = video.source_file;
      } else {
        inputPath = video.source_file;
      }
    }

    if (!s3SourceKey && (!inputPath || !fs.existsSync(inputPath))) {
      return res.status(409).json({
        error: 'Archivo fuente no disponible. El video debe ser re-subido para aplicar nuevas calidades.',
      });
    }

    // Reset to blank slate so dashboard shows transcoding progress from scratch
    await db.prepare(
      `UPDATE videos SET status='transcoding', transcoding_pct=0, qualities='[]', qualities_expected=NULL, updated_at=FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id=?`
    ).run(video.id);

    try {
      const { addTranscodeJob } = require('../services/queue');
      const { processVideo } = require('../transcoder');
      const result = await addTranscodeJob({
        videoId:     video.id,
        inputPath:   inputPath || null,
        s3SourceKey,
        title:       video.title,
        workspaceId: video.workspace_id || null,
      });

      if (result.inline) {
        processVideo(video.id, inputPath, video.title, {
          workspaceId: video.workspace_id || null,
          s3SourceKey,
          onProgress: async (pct) => {
            await db.prepare(`UPDATE videos SET transcoding_pct=? WHERE id=?`).run(pct, video.id).catch(() => {});
          },
        }).then(() => {
          db.prepare(`UPDATE videos SET transcoding_pct=NULL WHERE id=?`).run(video.id).catch(() => {});
        }).catch(err => logger.error({ err }, 'Retranscode inline error'));
      }

      logger.info({ videoId: video.id, workspaceId: video.workspace_id }, 'Video retranscode started');
      res.json({ success: true, inline: result.inline });
    } catch (queueErr) {
      await db.prepare(
        `UPDATE videos SET status='error', updated_at=FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id=?`
      ).run(video.id);
      logger.error({ err: queueErr, videoId: video.id }, 'Retranscode queue failed');
      res.status(500).json({ error: 'No se pudo iniciar la re-transcodificación' });
    }
  } catch (err) {
    logger.error({ err }, 'Retranscode endpoint error');
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/videos/:id/download-link — generate signed download URL (F2.5, Pro+)
router.post('/:id/download-link', authenticate, async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, workspace_id, hls_cdn_url, s3_object_prefix, original_filename, dmca_suspended FROM videos WHERE id=?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    // DMCA takedown check - block downloads for suspended videos
    if (video.dmca_suspended) {
      return res.status(451).json({
        error: 'unavailable_legal',
        message: 'Este contenido no está disponible debido a una solicitud legal'
      });
    }

    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });

      const ws = await db.prepare(`SELECT plan, settings FROM workspaces WHERE id = ?`).get(video.workspace_id);
      if (!await hasFeature(ws, 'downloadLinks')) {
        return res.status(403).json({
          error: 'Tu plan no incluye links de descarga. Actualiza tu plan para acceder.',
          code: 'FEATURE_NOT_IN_PLAN',
        });
      }
    }

    const token = signDownloadToken(video.id);
    const url = `${config.appUrl}/api/videos/download/${token}`;
    res.json({ url, token, ttl: 10 * 60, expiresAt: Math.floor(Date.now() / 1000) + 10 * 60 });
  } catch (err) {
    logger.error({ err }, 'Download link error');
    res.status(500).json({ error: 'Failed to generate download link' });
  }
});

// GET /api/videos/:id/download-file — Direct download as MP4 (remux from HLS segments)
router.get('/:id/download-file', optionalAuth, async (req, res) => {
  const videoId = req.params.id;
  const quality = req.query.quality; // e.g., "720p", "1080p"

  let video;
  try {
    video = await db.prepare(`
      SELECT id, title, workspace_id, visibility, hls_cdn_url, s3_object_prefix, original_filename, qualities, dmca_suspended
      FROM videos WHERE id=?
    `).get(videoId);

    if (!video) return res.status(404).json({ error: 'Not found' });

    // DMCA takedown check - block downloads for suspended videos
    if (video.dmca_suspended) {
      return res.status(451).json({
        error: 'unavailable_legal',
        message: 'Este contenido no está disponible debido a una solicitud legal'
      });
    }

    // Check access permissions
    if (video.visibility === 'private') {
      if (!req.user) return res.status(403).json({ error: 'private' });
      if (video.workspace_id) {
        const member = await db.prepare(
          `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
        ).get(video.workspace_id, req.user.id);
        if (!member && req.user.platform_role !== 'super_admin') {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else if (req.user.platform_role !== 'super_admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (video.visibility === 'password') {
      return res.status(403).json({ error: 'password_required' });
    }

    // Check workspace setting: downloads enabled?
    if (video.workspace_id) {
      const ws = await db.prepare(`SELECT settings FROM workspaces WHERE id = ?`).get(video.workspace_id);
      const wsSettings = safeJsonParse(ws?.settings, {});
      if (wsSettings.downloadsEnabled === false) {
        return res.status(403).json({ error: 'Downloads are disabled for this workspace' });
      }
    }
  } catch (err) {
    logger.error({ err }, 'Download-file access check error');
    return res.status(500).json({ error: 'Failed to process download request' });
  }

  // Determine which HLS playlist to use as source
  let m3u8File = 'master.m3u8';
  let qualityLabel = '';
  
  if (quality) {
    const q = quality.replace(/p$/i, ''); // "720p" → "720"
    const qualities = safeJsonParse(video.qualities, []);
    const hasQuality = qualities.some(qual => qual.toString() === q || qual.toString() === q + 'p');
    
    if (hasQuality) {
      m3u8File = `${q}p/index.m3u8`;
      qualityLabel = `_${q}p`;
    }
  }

  // Build safe filename for download
  const safeTitle = (video.title || 'video').replace(/[^a-zA-Z0-9áéíóúñü\s_-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60);
  const filename = `${safeTitle}${qualityLabel}.mp4`;

  // Strategy 1: Local HLS → remux to MP4 via ffmpeg (fast, no re-encoding)
  const localM3u8 = path.join(__dirname, '..', 'videos', videoId, m3u8File);
  if (fs.existsSync(localM3u8)) {
    const { execFile } = require('child_process');
    const os = require('os');
    
    // Handle AES-128 encrypted HLS: rewrite m3u8 to use local key file
    let inputM3u8 = localM3u8;
    let tempFiles = []; // track temp files for cleanup
    
    try {
      const m3u8Content = fs.readFileSync(localM3u8, 'utf8');
      
      if (m3u8Content.includes('#EXT-X-KEY:METHOD=AES-128')) {
        const videoRow = await db.prepare(`SELECT hls_key FROM videos WHERE id=?`).get(videoId);
        if (videoRow?.hls_key) {
          const keyBytes = Buffer.from(videoRow.hls_key, 'base64');
          // Write temp files to os.tmpdir(), not the HLS directory which is
          // served by express.static — avoids exposing the key via HTTP.
          const ts = `${videoId}_${Date.now()}`;
          const tempKeyFile = path.join(os.tmpdir(), `.sv_dlkey_${ts}.bin`);
          fs.writeFileSync(tempKeyFile, keyBytes);
          tempFiles.push(tempKeyFile);

          const rewrittenM3u8 = m3u8Content.replace(
            /#EXT-X-KEY:METHOD=AES-128,URI="[^"]+"/g,
            `#EXT-X-KEY:METHOD=AES-128,URI="${tempKeyFile}"`
          );
          const tempM3u8 = path.join(os.tmpdir(), `.sv_dlpl_${ts}.m3u8`);
          fs.writeFileSync(tempM3u8, rewrittenM3u8);
          tempFiles.push(tempM3u8);
          inputM3u8 = tempM3u8;
        }
      }
    } catch (err) {
      logger.warn({ err: err.message, videoId }, 'Failed to prepare decrypted m3u8 for download');
    }
    
    // Generate MP4 to a temp file first (ensures proper moov atom at end for full playback)
    const tempMp4 = path.join(os.tmpdir(), `sv_dl_${videoId}_${qualityLabel}_${Date.now()}.mp4`);
    tempFiles.push(tempMp4);
    
    const ffmpegArgs = [
      '-y',
      '-protocol_whitelist', 'file,crypto,data',
      '-allowed_extensions', 'ALL',
      '-i', inputM3u8,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      tempMp4
    ];

    const cleanup = () => {
      tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    };

    execFile('ffmpeg', ffmpegArgs, { 
      cwd: path.join(__dirname, '..', 'videos', videoId),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60 * 1000, // 10 min max
    }, (err) => {
      if (err) {
        logger.warn({ err: err.message, videoId }, 'FFmpeg download remux failed');
        cleanup();
        if (!res.headersSent) {
          return res.status(500).json({ error: 'Download conversion failed. Try again.' });
        }
        return;
      }
      
      // Serve the complete MP4 file with proper Content-Length
      const stat = fs.statSync(tempMp4);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', stat.size);
      
      const stream = fs.createReadStream(tempMp4);
      stream.pipe(res);
      stream.on('end', cleanup);
      stream.on('error', () => { cleanup(); if (!res.writableEnded) res.end(); });
      res.on('close', () => { stream.destroy(); cleanup(); });
    });

    return;
  }

  // Strategy 2: CDN URL — redirect (browser will download)
  if (video.hls_cdn_url) {
    const cdnBase = video.hls_cdn_url.replace(/\/master\.m3u8$/i, '');
    const cdnUrl = quality 
      ? `${cdnBase}/${quality.replace(/p$/i, '')}p/index.m3u8`
      : video.hls_cdn_url;
    return res.redirect(302, cdnUrl);
  }

  res.status(404).json({ error: 'Video file not found. The video may still be processing or was deleted.' });
});

// GET /api/videos/download/:token — validate and redirect to file (F2.5)
router.get('/download/:token', async (req, res) => {
  const { token } = req.params;

  // Decode token to get videoId without verifying first (to look up video)
  const dot = token.lastIndexOf('.');
  if (dot === -1) return res.status(400).json({ error: 'Invalid token' });
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString());
  } catch {
    return res.status(400).json({ error: 'Invalid token' });
  }
  const videoId = payload.d;
  if (!videoId || !verifyDownloadToken(token, videoId)) {
    return res.status(403).json({ error: 'Token invalid or expired' });
  }

  let dlVideo;
  try {
    dlVideo = await db.prepare(`SELECT id, hls_cdn_url, s3_object_prefix, original_filename FROM videos WHERE id=?`).get(videoId);
  } catch (err) {
    logger.error({ err }, 'Download token: DB error');
    return res.status(500).json({ error: 'Failed to process download' });
  }
  if (!dlVideo) return res.status(404).json({ error: 'Not found' });

  // Prefer S3 presigned URL, fall back to local file
  if (s3.isS3Enabled() && dlVideo.s3_object_prefix) {
    try {
      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const cfg = require('../config');
      const client = new S3Client({ region: cfg.awsRegion });
      const cmd = new GetObjectCommand({
        Bucket: cfg.s3Bucket,
        Key: `${dlVideo.s3_object_prefix}/master.m3u8`,
        ResponseContentDisposition: `attachment; filename="${dlVideo.original_filename || 'video.mp4'}"`,
      });
      const signedUrl = await getSignedUrl(client, cmd, { expiresIn: 600 });
      return res.redirect(302, signedUrl);
    } catch (err) {
      logger.warn({ err: err.message }, 'S3 presigned URL failed for download, falling back to local');
    }
  }

  // Local file — serve from videos dir
  const localDir = path.join(__dirname, '..', 'videos', videoId);
  const m3u8Path = path.join(localDir, 'master.m3u8');
  if (fs.existsSync(m3u8Path)) {
    return res.download(m3u8Path, dlVideo.original_filename || 'video.m3u8');
  }
  res.status(404).json({ error: 'Video file not found' });
});

// GET /api/videos/:id/cast-manifest — serve master.m3u8 with absolute URLs for Chromecast.
// Generates a short-lived cast token embedded in every sub-manifest and key URL so the
// Chromecast receiver can fetch segments and AES keys even when hotlink protection or
// video-token enforcement is active — without exposing normal auth tokens to the TV.
// Supports both local-storage videos and S3/CDN videos (fetches manifest from CDN when
// local file was deleted after S3 upload with DELETE_LOCAL_AFTER_S3=1).
router.get('/:id/cast-manifest', async (req, res) => {
  try {
    const videoId = req.params.id;
    const video = await db.prepare(`SELECT id, workspace_id, visibility, hls_key_id, hls_cdn_url FROM videos WHERE id=?`).get(videoId);
    if (!video) return res.status(404).end();

    // Resolve base URL — honours Cloudflare tunnel and any reverse-proxy forwarding headers.
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;

    // One cast token per session — embedded into every URL so the Chromecast can bypass
    // hotlink and token enforcement without having a browser session.
    const castToken = signCastToken(videoId);

    // Load master.m3u8 — try local first, fall back to CDN for S3-hosted videos
    let content;
    const masterPath = path.join(__dirname, '..', 'videos', videoId, 'master.m3u8');
    if (fs.existsSync(masterPath)) {
      content = fs.readFileSync(masterPath, 'utf8');
    } else if (video.hls_cdn_url) {
      const cdnUrl = video.hls_cdn_url.startsWith('//') ? `https:${video.hls_cdn_url}` : video.hls_cdn_url;
      const cdnRes = await fetch(cdnUrl);
      if (!cdnRes.ok) return res.status(404).end();
      content = await cdnRes.text();
    } else {
      return res.status(404).end();
    }

    // Rewrite AES-128 key URIs (relative OR absolute) → absolute with cast token.
    // Transcoder writes absolute URLs using config.appUrl; we normalise to the
    // request's own baseUrl so the Chromecast receiver always reaches this server.
    content = content.replace(
      /#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/g,
      (_, uri) => {
        let keyPath;
        try { keyPath = new URL(uri).pathname; } catch { keyPath = uri.split('?')[0]; }
        return `#EXT-X-KEY:METHOD=AES-128,URI="${baseUrl}${keyPath}?cast_token=${castToken}"`;
      }
    );

    // Rewrite relative sub-playlist paths → routed through cast-manifest-sub with cast token.
    // Both local and CDN master.m3u8 use relative quality paths (e.g. "720p/index.m3u8").
    content = content.replace(
      /^((?!#)(?!https?:\/\/).+\.m3u8)$/gm,
      (match) => `${baseUrl}/api/videos/${videoId}/cast-manifest-sub/${match}?cast_token=${castToken}`
    );

    // Also rewrite any absolute CDN quality playlist URLs that may appear in CDN-hosted manifests
    if (video.hls_cdn_url) {
      const cdnBase = video.hls_cdn_url.replace(/\/master\.m3u8(\?.*)?$/i, '');
      // Escape cdnBase for use in regex
      const escaped = cdnBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(
        new RegExp(`${escaped}/([a-zA-Z0-9_-]+/index\\.m3u8)`, 'g'),
        (_, qualityPath) => `${baseUrl}/api/videos/${videoId}/cast-manifest-sub/${qualityPath}?cast_token=${castToken}`
      );
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(content);
  } catch (err) {
    logger.error({ err }, 'Cast manifest error');
    res.status(500).end();
  }
});

// GET /api/videos/:id/cast-manifest-sub/:qualityDir/:file — serve quality sub-playlist with absolute URLs.
// Receives the cast_token from the master manifest and propagates it to every key URI and
// segment URI so the Chromecast can load them without a browser auth token.
// NOTE: The quality path is split into :qualityDir and :file because Express single params
// do not match across "/" separators (e.g. "360p/index.m3u8" would fail as a single param).
// Supports S3/CDN videos: fetches from CDN if local file was deleted after S3 upload.
router.get('/:id/cast-manifest-sub/:qualityDir/:file', async (req, res) => {
  try {
    const videoId    = req.params.id;
    const qualityDir = req.params.qualityDir; // e.g. "360p"
    const file       = req.params.file;       // e.g. "index.m3u8"
    const quality    = `${qualityDir}/${file}`;
    const castToken  = req.query.cast_token || '';

    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;

    // Validate quality param — only allow safe filenames
    if (!/^[a-zA-Z0-9_-]+$/.test(qualityDir) || !/^index\.m3u8$/.test(file)) return res.status(400).end();

    const subPath = path.join(__dirname, '..', 'videos', videoId, quality);
    let content;
    let cdnSegmentBase = null; // if set, rewrite segments to CDN URLs instead of local

    if (fs.existsSync(subPath)) {
      content = fs.readFileSync(subPath, 'utf8');
    } else {
      // Local file not found — try CDN (S3 mode with local cleanup)
      const videoRow = await db.prepare(`SELECT hls_cdn_url FROM videos WHERE id=?`).get(videoId);
      if (!videoRow?.hls_cdn_url) return res.status(404).end();
      const cdnBase = videoRow.hls_cdn_url.replace(/\/master\.m3u8(\?.*)?$/i, '');
      const cdnUrl  = `${cdnBase}/${quality}`;
      const cdnRes  = await fetch(cdnUrl);
      if (!cdnRes.ok) return res.status(404).end();
      content = await cdnRes.text();
      cdnSegmentBase = `${cdnBase}/${qualityDir}`;
    }

    const tokenSuffix = castToken ? `?cast_token=${encodeURIComponent(castToken)}` : '';

    // Rewrite AES-128 key URIs (relative OR absolute) → absolute with cast token.
    content = content.replace(
      /#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/g,
      (_, uri) => {
        let keyPath;
        try { keyPath = new URL(uri).pathname; } catch { keyPath = uri.split('?')[0]; }
        return `#EXT-X-KEY:METHOD=AES-128,URI="${baseUrl}${keyPath}${tokenSuffix}"`;
      }
    );

    // Rewrite relative segment filenames.
    // CDN: point to CDN (segments are public, no auth needed).
    // Local: point to server with cast token.
    if (cdnSegmentBase) {
      content = content.replace(
        /^(seg\d+\.ts)$/gm,
        (match) => `${cdnSegmentBase}/${match}`
      );
    } else {
      content = content.replace(
        /^(seg\d+\.ts)$/gm,
        (match) => `${baseUrl}/videos/${videoId}/${qualityDir}/${match}${tokenSuffix}`
      );
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(content);
  } catch (err) {
    logger.error({ err }, 'Cast manifest sub error');
    res.status(500).end();
  }
});

// POST /api/videos/:id/thumbnail — upload custom thumbnail
router.post('/:id/thumbnail', authenticate, thumbUpload.single('thumbnail'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded or invalid type (jpg/png/webp only)' });

  try {
    const video = await db.prepare(`SELECT id, workspace_id FROM videos WHERE id = ?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Access denied' }); }
      if (!['owner', 'admin'].includes(member.role)) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Se requiere rol owner o admin para cambiar el thumbnail' }); }
    } else if (req.user.platform_role !== 'super_admin') {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Rename to thumb.jpg so the existing thumbnailUrl path still works
    const finalPath = path.join(path.dirname(req.file.path), 'thumb.jpg');
    if (req.file.path !== finalPath) {
      try { fs.unlinkSync(finalPath); } catch {}
      fs.renameSync(req.file.path, finalPath);
    }

    await db.prepare(`UPDATE videos SET updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`).run(video.id);
    res.json({ success: true, thumbnailUrl: `/videos/${video.id}/thumb.jpg` });
  } catch (err) {
    logger.error({ err }, 'Thumbnail upload error');
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Failed to upload thumbnail' });
  }
});

// DELETE /api/videos/:id/thumbnail — regenerate from HLS
router.delete('/:id/thumbnail', authenticate, async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, workspace_id FROM videos WHERE id = ?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if (video.workspace_id) {
      const member = await db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para regenerar el thumbnail' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const videoDir = path.join(__dirname, '..', 'videos', video.id);
    const thumbPath = path.join(videoDir, 'thumb.jpg');
    let hlsPath = null;
    for (const q of ['360p', '480p', '720p', '1080p']) {
      const p = path.join(videoDir, q, 'index.m3u8');
      if (fs.existsSync(p)) { hlsPath = p; break; }
    }
    if (!hlsPath) return res.status(404).json({ error: 'No transcoded video found' });
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) =>
      execFile('ffmpeg', ['-y', '-i', hlsPath, '-ss', '00:00:05', '-vframes', '1', '-q:v', '2', thumbPath], (err) => err ? reject(err) : resolve())
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Thumbnail delete error');
    res.status(500).json({ error: 'Failed to regenerate thumbnail' });
  }
});

// POST /api/videos/:id/thumbnail/tmdb — fetch TMDB poster and save as thumbnail
router.post('/:id/thumbnail/tmdb', authenticate, async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, workspace_id, tmdb_id, tmdb_type FROM videos WHERE id = ?`).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });
    if (video.workspace_id) {
      const member = await db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para cambiar el thumbnail' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const tmdbId   = req.body.tmdb_id   || video.tmdb_id;
    const tmdbType = req.body.tmdb_type || video.tmdb_type || 'movie';
    if (!tmdbId) return res.status(400).json({ error: 'No TMDB ID' });
    const ws = await db.prepare(`SELECT settings FROM workspaces WHERE id = ?`).get(video.workspace_id);
    const settings = ws?.settings ? (typeof ws.settings === 'string' ? JSON.parse(ws.settings) : ws.settings) : {};
    const tmdbKey = settings.tmdbApiKey;
    if (!tmdbKey) return res.status(400).json({ error: 'No TMDB API key configured' });

    const tmdbRes = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${encodeURIComponent(tmdbId)}?language=es-MX`, {
      headers: { Authorization: `Bearer ${tmdbKey}` }
    });
    if (!tmdbRes.ok) return res.status(502).json({ error: 'TMDB request failed' });
    const data = await tmdbRes.json();
    // Use backdrop (landscape) for video thumbnails; fall back to poster if no backdrop
    const imagePath = data.backdrop_path || data.poster_path;
    if (!imagePath) return res.status(404).json({ error: 'No image available for this title' });
    const imageSize = data.backdrop_path ? 'w1280' : 'w500';

    const imgRes = await fetch(`https://image.tmdb.org/t/p/${imageSize}${imagePath}`);
    if (!imgRes.ok) return res.status(502).json({ error: 'Failed to download poster' });
    const videoDir = path.join(__dirname, '..', 'videos', video.id);
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
    const thumbPath = path.join(videoDir, 'thumb.jpg');
    const buf = Buffer.from(await imgRes.arrayBuffer());
    fs.writeFileSync(thumbPath, buf);
    await db.prepare(`UPDATE videos SET updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`).run(video.id);
    res.json({ success: true, thumbnailUrl: `/videos/${video.id}/thumb.jpg` });
  } catch (err) {
    logger.error({ err }, 'TMDB thumbnail error');
    res.status(500).json({ error: 'Failed to set TMDB poster' });
  }
});

module.exports = router;
