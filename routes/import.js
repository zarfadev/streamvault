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

// Detect YouTube/Vimeo URLs that require yt-dlp
const YT_VIMEO_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/|vimeo\.com\/)/i;

function isYtDlpUrl(url) {
  try { return YT_VIMEO_RE.test(url); } catch { return false; }
}

async function checkYtDlp() {
  return new Promise(resolve => {
    const proc = spawn('yt-dlp', ['--version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', code => resolve(code === 0));
  });
}

function downloadWithYtDlp(url, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    // yt-dlp writes the best video+audio merged to a single file
    const tmplPath = path.join(destDir, '%(id)s.%(ext)s');
    let outputFile = null;
    let title = 'Imported Video';

    const cookiesFile = '/app/cookies.txt';
    const hasCookies = fs.existsSync(cookiesFile);
    const args = [
      '--no-playlist',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--output', tmplPath,
      '--print', 'after_move:filepath',
      '--newline',
      '--progress',
      '--no-warnings',
      '--extractor-retries', '5',
      '--fragment-retries', '5',
      '--retries', '5',
      '--socket-timeout', '60',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--sleep-requests', '1',
      '--sleep-interval', '2',
      '--max-sleep-interval', '5',
      ...(hasCookies ? ['--cookies', cookiesFile] : []),
      url,
    ];

    const proc = spawn('yt-dlp', args);
    let stderr = '';

    proc.stdout.on('data', chunk => {
      const line = chunk.toString().trim();
      // Line printed by --print after_move:filepath is the final output path
      if (line && !line.startsWith('[') && fs.existsSync(line)) {
        outputFile = line;
      }
      // Parse download progress: [download]  34.2% of 120.00MiB
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) onProgress(Math.floor(parseFloat(m[1])));
    });

    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    // Also try to get the title via a separate --get-title call that ran before
    // (we start it in parallel at the call site)

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(0, 300)}`));
      if (!outputFile || !fs.existsSync(outputFile)) {
        return reject(new Error('yt-dlp did not produce an output file'));
      }
      const stat = fs.statSync(outputFile);
      resolve({ filePath: outputFile, size: stat.size, title });
    });

    proc.on('error', err => reject(new Error(`yt-dlp not found: ${err.message}`)));
  });
}

async function getYtDlpTitle(url) {
  return new Promise(resolve => {
    const proc = spawn('yt-dlp', ['--no-playlist', '--get-title', url], { timeout: 15000 });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => resolve(out.trim().slice(0, 200) || 'Imported Video'));
    proc.on('error', () => resolve('Imported Video'));
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

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let total    = 0;

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

      const req = lib.get(requestUrl, { timeout: 30_000 }, res => {
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

        const out = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            req.destroy();
            out.destroy();
            reject(new Error('File exceeded 10 GB limit during download'));
            return;
          }
          if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(out);
        out.on('finish', () => resolve({ size: received, contentType: ct }));
        out.on('error', reject);
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
      req.on('error', reject);
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
    const useYtDlp    = isYtDlpUrl(url);

    // For yt-dlp URLs, verify yt-dlp is installed before committing to the import
    if (useYtDlp) {
      const ytAvailable = await checkYtDlp();
      if (!ytAvailable) {
        return res.status(422).json({
          error: 'yt-dlp no está instalado en el servidor. Soportamos URLs directas a archivos de video (MP4, MKV, etc.). Para importar desde YouTube o Vimeo instala yt-dlp en el servidor.',
        });
      }
    }

    const videoId     = uuidv4();
    const uploadsDir  = path.join(__dirname, '..', 'uploads');
    const ext         = useYtDlp ? '.mp4' : (path.extname(parsed.pathname) || '.mp4');
    const destPath    = path.join(uploadsDir, `${videoId}${ext}`);

    // For yt-dlp, fetch the title in parallel before inserting
    const videoTitle = useYtDlp
      ? (title || await getYtDlpTitle(url)).slice(0, 200)
      : (title || guessTitle(url)).slice(0, 200);

    try {
      await db.prepare(
        `INSERT INTO videos (id, title, original_filename, status, workspace_id) VALUES (?, ?, ?, 'downloading', ?)`
      ).run(videoId, videoTitle, useYtDlp ? 'yt-dlp' : (path.basename(parsed.pathname) || 'remote'), workspaceId);
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

        if (useYtDlp) {
          logger.info({ videoId, url }, 'Importing video via yt-dlp');
          const result = await downloadWithYtDlp(url, uploadsDir, onDlProgress);
          finalPath = result.filePath;
          size = result.size;
        } else {
          logger.info({ videoId, url }, 'Downloading imported video');
          const result = await download(url, destPath, onDlProgress);
          size = result.size;
        }

        logger.info({ videoId, sizeMB: (size / 1e6).toFixed(1) }, 'Downloaded — queueing transcode');
        await db.prepare(`UPDATE videos SET status='queued', size=? WHERE id=?`).run(size, videoId);

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
