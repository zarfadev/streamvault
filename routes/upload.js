const express = require('express');
const router = express.Router();
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('../db');
const { processVideo } = require('../transcoder');
const { addTranscodeJob } = require('../services/queue');
const s3 = require('../services/s3Storage');
const { optionalAuth } = require('../middleware/auth');
const { resolveWorkspace, checkLimit } = require('../middleware/workspace');
const logger = require('../services/logger').child({ module: 'upload' });

// Magic byte signatures for allowed video/audio formats
const MAGIC_SIGS = [
  { offset: 4,  bytes: [0x66, 0x74, 0x79, 0x70] }, // MP4/MOV/M4V (ftyp box)
  { offset: 0,  bytes: [0x1A, 0x45, 0xDF, 0xA3] }, // MKV / WebM
  { offset: 0,  bytes: [0x52, 0x49, 0x46, 0x46] }, // AVI / WAV (RIFF)
  { offset: 0,  bytes: [0x46, 0x4C, 0x56, 0x01] }, // FLV
  { offset: 0,  bytes: [0x00, 0x00, 0x01, 0xBA] }, // MPEG-PS
  { offset: 0,  bytes: [0x00, 0x00, 0x01, 0xB3] }, // MPEG video
  { offset: 0,  bytes: [0x4F, 0x67, 0x67, 0x53] }, // OGG
  { offset: 0,  bytes: [0x66, 0x4C, 0x61, 0x43] }, // FLAC
  { offset: 0,  bytes: [0xFF, 0xFB]               }, // MP3
  { offset: 0,  bytes: [0xFF, 0xF3]               }, // MP3
  { offset: 0,  bytes: [0xFF, 0xF2]               }, // MP3
  { offset: 0,  bytes: [0x49, 0x44, 0x33]         }, // MP3 (ID3 tag)
  { offset: 0,  bytes: [0xFF, 0xF1]               }, // AAC ADTS
  { offset: 0,  bytes: [0xFF, 0xF9]               }, // AAC ADTS
  { offset: 0,  bytes: [0x30, 0x26, 0xB2, 0x75]  }, // WMV / ASF
];

// Async version — reads only the first ~34 bytes using non-blocking fs.read
// to validate magic bytes without blocking the event loop.
async function validateMagicBytes(filePath) {
  try {
    const needed = Math.max(...MAGIC_SIGS.map(s => s.offset + s.bytes.length));
    const buf = Buffer.alloc(needed);
    const fh = await fs.promises.open(filePath, 'r');
    let bytesRead = 0;
    try {
      ({ bytesRead } = await fh.read(buf, 0, needed, 0));
    } finally {
      await fh.close();
    }
    return MAGIC_SIGS.some(sig => {
      const end = sig.offset + sig.bytes.length;
      if (bytesRead < end) return false;
      return sig.bytes.every((b, i) => buf[sig.offset + i] === b);
    });
  } catch {
    return false;
  }
}

// Secondary validation with FFprobe — catches malformed files that pass magic byte check.
// Returns { valid: true } on success, { valid: false, reason } on rejection.
// Falls back gracefully (valid: true) if ffprobe is not installed.
async function validateWithFFprobe(filePath) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      filePath,
    ], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        // ffprobe not available — skip check (graceful degradation)
        if (err.code === 'ENOENT') return resolve({ valid: true });
        // ffprobe exited with error — file is corrupt or unsupported
        return resolve({ valid: false, reason: 'El archivo de video parece estar corrupto o dañado.' });
      }
      try {
        const data = JSON.parse(stdout);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        if (streams.length === 0) {
          return resolve({ valid: false, reason: 'El archivo no contiene streams de video o audio reconocibles.' });
        }
        resolve({ valid: true });
      } catch {
        resolve({ valid: true }); // parse error = ffprobe gave unexpected output, allow it
      }
    });
  });
}

// Lee la configuración guest desde system_config (con defaults seguros)
async function getGuestConfig() {
  try {
    const row = await db.prepare(`SELECT value FROM system_config WHERE key = 'guest_config'`).get();
    const cfg = row?.value ? JSON.parse(row.value) : {};
    return {
      enabled:       cfg.enabled       ?? true,
      maxFileSizeMB: cfg.maxFileSizeMB ?? 2048,
      expiryHours:   cfg.expiryHours   ?? 24,
      maxVideos:     cfg.maxVideos     ?? 3,
    };
  } catch {
    return { enabled: true, maxFileSizeMB: 2048, expiryHours: 24, maxVideos: 3 };
  }
}

// ── Silent token refresh for long-running uploads ────────────────────────────
// Large file uploads (>15 min) cause the access token to expire while the file
// is still being transferred. The client sends x-refresh-token so the server
// can silently obtain a new access token and continue as an authenticated user.
async function _refreshUserForUpload(req) {
  const rt = req.headers['x-refresh-token'];
  if (!rt) return null;
  try {
    const stored = await db.prepare(
      `SELECT rt.user_id, rt.expires_at, u.id, u.email, u.platform_role,
              u.email_verified, u.two_factor_enabled
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token = ?`
    ).get(rt);
    if (!stored) return null;
    if (stored.expires_at < Math.floor(Date.now() / 1000)) return null;
    return { id: stored.user_id, email: stored.email, platform_role: stored.platform_role };
  } catch { return null; }
}

router.post('/', optionalAuth, async (req, res, next) => {
  // ── Cleanup partial file if client disconnects mid-upload ─────────────────
  // When multer is writing a large file and the connection drops (e.g. server
  // restart, browser cancel), it throws "Request aborted" but leaves the
  // partial file on disk.  We register an 'aborted'/'close' handler here so
  // those orphaned chunks are cleaned up immediately.
  req.once('aborted', () => {
    if (req.file?.path) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} }
  });
  req.once('close', () => {
    if (!res.headersSent && req.file?.path) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) {}
    }
  });

  // ── Authenticated users MUST provide a workspace ──────────────────────────
  // This prevents bypassing plan limits by uploading without a workspace context.
  // Unauthenticated uploads (public API without token) are still allowed without
  // a workspace — they create orphan videos with no quota enforcement.

  // If access token expired mid-upload but client sent x-refresh-token, silently
  // restore the user so the video is linked to their workspace (not saved as guest).
  // IMPORTANT: we await here so the code falls through to the workspace checks
  // below (instead of the old .then(next) which bypassed resolveWorkspace).
  if (!req.user && req.headers['x-refresh-token']) {
    const user = await _refreshUserForUpload(req).catch(() => null);
    if (user) req.user = user;
    // fall through — do NOT call next() here
  }

  if (req.user && !req.headers['x-workspace-id']) {
    return res.status(400).json({
      error: 'X-Workspace-Id header is required for authenticated uploads.',
      code: 'WORKSPACE_REQUIRED',
    });
  }

  if (req.user && req.headers['x-workspace-id']) {
    // Wrap res.status so we can clean up the temp file if a quota check rejects
    const cleanupOnReject = (origStatus) => function (code) {
      if (code >= 400 && req.file?.path) {
        const fs = require('fs');
        fs.unlink(req.file.path, () => {});
      }
      return origStatus.call(res, code);
    };
    res.status = cleanupOnReject(res.status.bind(res));

    return resolveWorkspace(req, res, () => {
      checkLimit('video_count')(req, res, () => {
        checkLimit('storage')(req, res, next);
      });
    });
  }
  req.workspace = null;
  next();
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Magic byte validation — async, non-blocking read of first ~34 bytes.
  const magicOk = await validateMagicBytes(req.file.path);
  if (!magicOk) {
    fs.unlink(req.file.path, () => {});
    return res.status(422).json({ error: 'El archivo no es un formato de video/audio válido.', code: 'INVALID_MAGIC_BYTES' });
  }

  // Secondary deep validation with FFprobe — catches corrupt files that pass magic bytes.
  const ffprobeCheck = await validateWithFFprobe(req.file.path);
  if (!ffprobeCheck.valid) {
    fs.unlink(req.file.path, () => {});
    return res.status(422).json({ error: ffprobeCheck.reason, code: 'INVALID_FILE_STRUCTURE' });
  }

  try {
    const id = uuidv4();
    const title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '');
    const workspaceId = req.workspace?.id || null;

    // ── Validaciones para uploads anónimos (guest) ─────────────────────────
    const guestSessionId = req.headers['x-guest-id'] || null;
    if (!req.user && guestSessionId) {
      const guestCfg = await getGuestConfig();

      // ¿Uploads anónimos habilitados?
      if (!guestCfg.enabled) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({
          error: 'Los uploads sin cuenta están temporalmente deshabilitados.',
          code: 'GUEST_UPLOAD_DISABLED',
        });
      }

      // ¿Tamaño del archivo dentro del límite?
      const maxBytes = guestCfg.maxFileSizeMB * 1024 * 1024;
      if (req.file.size > maxBytes) {
        const label = guestCfg.maxFileSizeMB >= 1024
          ? `${(guestCfg.maxFileSizeMB / 1024).toFixed(1)} GB`
          : `${guestCfg.maxFileSizeMB} MB`;
        fs.unlink(req.file.path, () => {});
        return res.status(413).json({
          error: `El archivo supera el límite de ${label} para subidas sin cuenta. Regístrate para subir archivos más grandes.`,
          code: 'GUEST_FILE_TOO_LARGE',
          maxFileSizeMB: guestCfg.maxFileSizeMB,
        });
      }

      // ¿Número de videos guest dentro del límite?
      if (guestCfg.maxVideos > 0) {
        const count = await db.prepare(
          `SELECT COUNT(*) as cnt FROM videos WHERE guest_session_id = ? AND workspace_id IS NULL`
        ).get(guestSessionId);
        if ((count?.cnt ?? 0) >= guestCfg.maxVideos) {
          fs.unlink(req.file.path, () => {});
          return res.status(429).json({
            error: `Has alcanzado el límite de ${guestCfg.maxVideos} video${guestCfg.maxVideos !== 1 ? 's' : ''} sin cuenta. Regístrate para subir más.`,
            code: 'GUEST_VIDEO_LIMIT',
            maxVideos: guestCfg.maxVideos,
          });
        }
      }
    }

    // Optional folder assignment — validate it belongs to the workspace if provided
    let folderId = req.body.folder_id || null;
    if (folderId && workspaceId) {
      const folder = await db.prepare(
        `SELECT id FROM folders WHERE id = ? AND workspace_id = ?`
      ).get(folderId, workspaceId);
      if (!folder) folderId = null;
    } else if (folderId && !workspaceId) {
      folderId = null;
    }

    // Generate unique 8-char hex short code with collision retry
    let shortCode = null;
    for (let i = 0; i < 5; i++) {
      const candidate = crypto.randomBytes(4).toString('hex');
      const clash = await db.prepare(`SELECT id FROM videos WHERE short_code = ?`).get(candidate);
      if (!clash) { shortCode = candidate; break; }
    }

    // Apply workspace default visibility (if configured); guests default to 'public'
    const VALID_VISIBILITIES = new Set(['public', 'private', 'unlisted']);
    const wsDefaultVisibility = req.workspace?.settings?.defaultVideoVisibility;
    const initialVisibility = VALID_VISIBILITIES.has(wsDefaultVisibility) ? wsDefaultVisibility : 'public';

    await db.prepare(
      `INSERT INTO videos (id, title, description, original_filename, status, size, workspace_id, folder_id, short_code, guest_session_id, visibility)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
    ).run(id, title, req.body.description || '', req.file.originalname, req.file.size || 0, workspaceId, folderId, shortCode, guestSessionId, initialVisibility);

    if (workspaceId && req.file.size) {
      await db.prepare(`UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?`)
        .run(req.file.size, workspaceId);
    }

    // ── Fast path: respond to the client immediately ──────────────────────────
    // For large files (1-10 GB), waiting for S3 upload before responding would
    // block the client for minutes. Instead we:
    //   1. Respond immediately with the video ID (status = 'queued')
    //   2. Upload to S3 in background
    //   3. Queue the transcode job AFTER S3 upload completes (so the worker gets the S3 key)
    //
    // The dashboard polls /api/videos/:id every few seconds and will see the
    // status change from 'queued' → 'transcoding' → 'ready' in real time.

    const localPath = req.file.path;
    const plan = req.workspace?.plan || (workspaceId ? 'starter' : 'guest');

    if (!s3.isS3Enabled()) {
      // No S3 — queue job immediately with local path
      const sourceFile = localPath;
      db.prepare(`UPDATE videos SET source_file=? WHERE id=?`).run(sourceFile, id).catch(() => {});
      const { inline } = await addTranscodeJob({ videoId: id, inputPath: localPath, s3SourceKey: null, title, workspaceId, plan });
      db.prepare(`UPDATE videos SET status='transcoding', transcoding_pct=0 WHERE id=?`).run(id).catch(() => {});
      if (inline) {
        processVideo(id, localPath, title, {
          workspaceId, s3SourceKey: null,
          onProgress: async (pct) => {
            await db.prepare(`UPDATE videos SET transcoding_pct=? WHERE id=?`).run(pct, id).catch(() => {});
          },
        }).then(() => {
          db.prepare(`UPDATE videos SET transcoding_pct=NULL WHERE id=?`).run(id).catch(() => {});
        }).catch(err => logger.error({ err }, 'Transcoding error'));
      }
    } else {
      // S3 enabled — respond immediately, upload in background, then queue transcode
      db.prepare(`UPDATE videos SET source_file=? WHERE id=?`).run(localPath, id).catch(() => {});

      // Fire-and-forget: upload to S3 then queue transcoding
      (async () => {
        try {
          const s3SourceKey = await s3.uploadSourceFile(localPath, workspaceId, id);
          fs.unlink(localPath, () => {});
          logger.info({ videoId: id, s3SourceKey }, 'Source uploaded to S3 — queuing transcode');
          // Update source_file to S3 key so retry works
          await db.prepare(`UPDATE videos SET source_file=? WHERE id=?`).run(s3SourceKey, id).catch(() => {});
          // Now queue the transcode job with the S3 key
          const { inline } = await addTranscodeJob({ videoId: id, inputPath: null, s3SourceKey, title, workspaceId, plan });
          db.prepare(`UPDATE videos SET status='transcoding', transcoding_pct=0 WHERE id=?`).run(id).catch(() => {});
          if (inline) {
            processVideo(id, null, title, {
              workspaceId, s3SourceKey,
              onProgress: async (pct) => {
                await db.prepare(`UPDATE videos SET transcoding_pct=? WHERE id=?`).run(pct, id).catch(() => {});
              },
            }).then(() => {
              db.prepare(`UPDATE videos SET transcoding_pct=NULL WHERE id=?`).run(id).catch(() => {});
            }).catch(err => logger.error({ err }, 'Inline transcoding error'));
          }
        } catch (s3Err) {
          logger.warn({ err: s3Err.message, videoId: id }, 'S3 upload failed — falling back to local queue');
          // Fallback: queue with local path (file still on disk since we only delete on success)
          db.prepare(`UPDATE videos SET source_file=? WHERE id=?`).run(localPath, id).catch(() => {});
          const { inline } = await addTranscodeJob({ videoId: id, inputPath: localPath, s3SourceKey: null, title, workspaceId, plan }).catch(() => ({ inline: false }));
          db.prepare(`UPDATE videos SET status='transcoding', transcoding_pct=0 WHERE id=?`).run(id).catch(() => {});
          if (inline) {
            processVideo(id, localPath, title, {
              workspaceId, s3SourceKey: null,
              onProgress: async (pct) => {
                await db.prepare(`UPDATE videos SET transcoding_pct=? WHERE id=?`).run(pct, id).catch(() => {});
              },
            }).then(() => {
              db.prepare(`UPDATE videos SET transcoding_pct=NULL WHERE id=?`).run(id).catch(() => {});
            }).catch(err => logger.error({ err }, 'Fallback transcoding error'));
          }
        }
      })().catch(err => logger.error({ err, videoId: id }, 'Background S3+transcode pipeline error'));
    }

    // Respond immediately — client does not wait for S3 upload
    res.json({
      id,
      shortCode,
      shortUrl: shortCode ? `/v/${shortCode}` : null,
      message: 'Upload received, processing queued',
      watchUrl: `/watch/${id}`,
      m3u8Url: `/videos/${id}/master.m3u8`,
    });
  } catch (err) {
    logger.error({ err }, 'Upload handler error');
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
