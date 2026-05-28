/**
 * URL video import — download a remote video and queue it for transcoding.
 *
 * POST /api/import
 * Body: { url, title?, workspace_id? }
 * Headers: Authorization: Bearer <token>
 *
 * Streams the download directly to the uploads/ directory so memory usage
 * stays flat regardless of file size. Max 10 GB (same limit as direct upload).
 */
const express       = require('express');
const router        = express.Router();
const fs            = require('fs');
const path          = require('path');
const https         = require('https');
const http          = require('http');
const dns           = require('dns');
const { spawn }     = require('child_process');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { authenticate }  = require('../middleware/auth');
const { resolveWorkspace, checkLimit } = require('../middleware/workspace');
const { processVideo }  = require('../transcoder');
const { addTranscodeJob, getJobProgress } = require('../services/queue');
const rateLimit = require('../middleware/rateLimit');
const s3        = require('../services/s3Storage');
const logger    = require('../services/logger').child({ module: 'import' });

const MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

const ALLOWED_CONTENT_TYPES = new Set([
  'video/mp4', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo',
  'video/x-flv', 'video/webm', 'video/mpeg', 'video/ogg',
  'video/3gpp', 'video/x-ms-wmv', 'application/octet-stream',
]);

// Block SSRF — reject private/loopback/link-local hostnames and IPs
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  // Loopback / localhost
  if (h === 'localhost' || h === 'ip6-localhost') return true;
  // IPv6 loopback
  if (h === '::1' || h === '[::1]') return true;
  // Dotted-decimal private ranges
  const parts = h.replace(/^\[|\]$/g, '').split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p))) {
    const [a, b] = parts;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 127) return true;                         // 127.0.0.0/8
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local / AWS metadata)
    if (a === 0) return true;                           // 0.0.0.0/8
  }
  return false;
}

function isM3u8Url(url) {
  try { return new URL(url).pathname.toLowerCase().endsWith('.m3u8'); } catch { return false; }
}

function downloadM3u8WithFfmpeg(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', destPath];
    let durationSec = 0;
    let stderr = '';
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      if (!durationSec) {
        const dm = text.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
        if (dm) durationSec = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
      }
      const tm = text.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (tm && durationSec > 0) {
        const elapsed = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
        onProgress(Math.min(99, Math.round((elapsed / durationSec) * 100)));
      }
    });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
      resolve({ size: fs.statSync(destPath).size });
    });
    proc.on('error', err => reject(new Error(`ffmpeg not found: ${err.message}`)));
  });
}

function guessTitle(url) {
  try {
    const p = new URL(url).pathname;
    const base = path.basename(p).replace(/\.[^.]+$/, '');
    return decodeURIComponent(base) || 'Imported Video';
  } catch {
    return 'Imported Video';
  }
}

// Timeout de conexión inicial (ms) — tiempo máximo para establecer la conexión y recibir headers
const CONNECT_TIMEOUT_MS = 60_000;       // 60 s
// Timeout total de descarga (ms) — tiempo máximo para descargar todo el archivo
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000; // 30 min

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let total    = 0;
    let downloadTimer = null;

    function cleanup() {
      if (downloadTimer) { clearTimeout(downloadTimer); downloadTimer = null; }
    }

    function doRequest(requestUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects'));

      const parsed = new URL(requestUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Protocol not allowed'));
      if (isPrivateHost(parsed.hostname)) return reject(new Error('URL resolves to a private or reserved address'));

      // Resolve DNS first to catch domains like 169.254.169.254.nip.io that pass the hostname check
      dns.lookup(parsed.hostname, (dnsErr, address) => {
        if (dnsErr || !address) return reject(new Error('Domain does not resolve'));
        if (isPrivateHost(address)) return reject(new Error('URL resolves to a private or reserved address'));
        doFetch(parsed, requestUrl, redirects);
      });
    }

    function doFetch(parsed, requestUrl, redirects) {
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.get(requestUrl, { timeout: CONNECT_TIMEOUT_MS }, res => {
        // Follow redirects — re-validate destination to prevent SSRF via open redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return doRequest(new URL(res.headers.location, requestUrl).href, redirects + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} — ${requestUrl}`));
        }

        // Content-type check (relaxed: accept octet-stream and any video/*)
        const ct = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct && !ct.startsWith('video/') && !ALLOWED_CONTENT_TYPES.has(ct)) {
          return reject(new Error(`Content-Type not allowed: ${ct}`));
        }

        // Content-length check (if provided)
        total = parseInt(res.headers['content-length'] || '0', 10);
        if (total > MAX_BYTES) {
          return reject(new Error(`File too large (${(total / 1e9).toFixed(1)} GB, max 10 GB)`));
        }

        // Iniciar timer de descarga total (30 min máximo para descargar el archivo)
        downloadTimer = setTimeout(() => {
          req.destroy();
          reject(new Error('Download timeout — el archivo tardó demasiado en descargarse'));
        }, DOWNLOAD_TIMEOUT_MS);

        const out = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            cleanup();
            req.destroy();
            out.destroy();
            reject(new Error('File exceeded 10 GB limit during download'));
            return;
          }
          if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(out);
        out.on('finish', () => { cleanup(); resolve({ size: received, contentType: ct }); });
        out.on('error', err => { cleanup(); reject(err); });
      });

      req.on('timeout', () => { cleanup(); req.destroy(); reject(new Error('Connection timeout — no se pudo conectar al servidor')); });
      req.on('error', err => { cleanup(); reject(err); });
    }

    doRequest(url);
  });
}

// ─── POST /api/import ────────────────────────────────────────────
router.post(
  '/',
  rateLimit(20, 60_000),
  authenticate,
  async (req, res, next) => {
    // Optional workspace scope
    if (req.headers['x-workspace-id']) {
      return resolveWorkspace(req, res, () =>
        checkLimit('video_count')(req, res, () =>
          checkLimit('storage')(req, res, next)
        )
      );
    }
    req.workspace = null;
    next();
  },
  async (req, res) => {
    const { url, title } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are supported' });
    }
    if (isPrivateHost(parsed.hostname)) {
      return res.status(400).json({ error: 'URL apunta a una dirección privada o reservada' });
    }

    const workspaceId = req.workspace?.id || null;
    const useM3u8     = isM3u8Url(url);

    if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//i.test(url)) {
      return res.status(422).json({
        error: 'La importación desde YouTube y Vimeo no está disponible. Usa una URL directa a un archivo de video (MP4, MKV, M3U8, etc.).',
      });
    }

    const videoId     = uuidv4();
    const uploadsDir  = path.join(__dirname, '..', 'uploads');
    const ext         = useM3u8 ? '.mp4' : (path.extname(parsed.pathname) || '.mp4');
    const destPath    = path.join(uploadsDir, `${videoId}${ext}`);
    const videoTitle  = (title || guessTitle(url)).slice(0, 200);

    try {
      await db.prepare(
        `INSERT INTO videos (id, title, original_filename, status, workspace_id) VALUES (?, ?, ?, 'downloading', ?)`
      ).run(videoId, videoTitle, path.basename(parsed.pathname) || 'remote', workspaceId);
    } catch (err) {
      logger.error({ err }, 'Import: failed to create video record');
      return res.status(500).json({ error: 'Failed to create video record' });
    }

    // Respond immediately — download + transcode happen in background
    res.status(202).json({
      id:       videoId,
      title:    videoTitle,
      status:   'downloading',
      watchUrl: `/watch/${videoId}`,
    });

    // ── Background: download → transcode ───────────────────────
    ;(async () => {
      let finalPath = destPath;
      try {
        let size;

        let lastPct = -1;
        const onDlProgress = pct => {
          if (pct - lastPct >= 5) {
            lastPct = pct;
            db.prepare(`UPDATE videos SET status='downloading', transcoding_pct=? WHERE id=?`).run(pct, videoId).catch(() => {});
          }
        };

        if (useM3u8) {
          logger.info({ videoId, url }, 'Importing M3U8 stream via ffmpeg');
          const result = await downloadM3u8WithFfmpeg(url, destPath, onDlProgress);
          size = result.size;
        } else {
          logger.info({ videoId, url }, 'Downloading imported video');
          const result = await download(url, destPath, onDlProgress);
          size = result.size;
        }

        logger.info({ videoId, sizeMB: (size / 1e6).toFixed(1) }, 'Downloaded — starting transcode');
        await db.prepare(`UPDATE videos SET status='transcoding', transcoding_pct=0, size=? WHERE id=?`).run(size, videoId);

        if (workspaceId && size) {
          await db.prepare(
            `UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?`
          ).run(size, workspaceId);
        }

        // In multi-server mode upload the source to S3 so any worker can read it.
        let s3SourceKey = null;
        if (s3.isS3Enabled()) {
          try {
            s3SourceKey = await s3.uploadSourceFile(finalPath, workspaceId, videoId);
            fs.unlink(finalPath, () => {});
            logger.info({ videoId, s3SourceKey }, 'Source uploaded to S3 for multi-server worker access');
          } catch (s3Err) {
            logger.warn({ videoId, err: s3Err.message }, 'S3 upload failed — worker will use local file (same-server only)');
          }
        }

        await db.prepare(`UPDATE videos SET source_file=? WHERE id=?`).run(s3SourceKey || finalPath, videoId).catch(() => {});

        const { inline } = await addTranscodeJob({ videoId, inputPath: finalPath, s3SourceKey, title: videoTitle, workspaceId });
        if (inline) {
          processVideo(videoId, finalPath, videoTitle, { workspaceId, s3SourceKey }).catch(err => {
            logger.error({ videoId, err: err.message }, 'Transcode error after import');
          });
        }
      } catch (err) {
        logger.error({ videoId, err: err.message }, 'Import download failed');
        await db.prepare(`UPDATE videos SET status='error' WHERE id=?`).run(videoId).catch(() => {});
        try { fs.unlinkSync(finalPath); } catch {}
      }
    })();
  }
);

// ─── GET /api/import/:id/status ──────────────────────────────────
// Lightweight poll endpoint for the dashboard progress indicator.
router.get('/:id/status', authenticate, async (req, res) => {
  try {
    const video = await db.prepare(
      `SELECT id, status, title, qualities, workspace_id, transcoding_pct FROM videos WHERE id = ?`
    ).get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Not found' });

    // Verify caller belongs to the video's workspace
    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member && req.user.platform_role !== 'super_admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Resolve real progress pct:
    // - downloading: from transcoding_pct (we store dl% there during download)
    // - transcoding: from Bull queue job progress, fallback to transcoding_pct
    let pct = null;
    if (video.status === 'downloading') {
      pct = video.transcoding_pct ?? null;
    } else if (video.status === 'transcoding') {
      const queuePct = await getJobProgress(video.id).catch(() => null);
      pct = queuePct ?? video.transcoding_pct ?? null;
    } else if (video.status === 'ready') {
      pct = 100;
    }

    res.json({
      id:        video.id,
      status:    video.status,
      title:     video.title,
      qualities: JSON.parse(video.qualities || '[]'),
      watchUrl:  `/watch/${video.id}`,
      pct,
    });
  } catch (err) {
    logger.error({ err }, 'Import status error');
    res.status(500).json({ error: 'Failed to fetch import status' });
  }
});

module.exports = router;
