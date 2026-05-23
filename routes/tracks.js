/**
 * POST /api/videos/:videoId/tracks
 * Upload subtitle (.srt / .vtt) or audio tracks.
 * Audio tracks are re-muxed to AAC and referenced in the HLS master playlist.
 *
 * Multipart fields:
 *   file      — the track file
 *   kind      — 'subtitle' | 'audio'
 *   language  — BCP-47 code, e.g. 'es', 'en', 'pt'
 *   label     — human-readable label, e.g. 'Español', 'English Commentary'
 *   default   — '1' to mark as default track
 */
const express = require('express');
const router  = express.Router({ mergeParams: true });
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg  = require('fluent-ffmpeg');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');
const { hasFeature } = require('../middleware/checkFeature');

const SUBTITLE_EXTS = new Set(['.srt', '.vtt']);
const AUDIO_EXTS    = new Set(['.mp3', '.aac', '.m4a', '.wav', '.flac', '.ogg', '.opus']);

const logger = require('../services/logger').child({ module: 'tracks' });

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const trackUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!UUID_REGEX.test(req.params.videoId)) {
        return cb(new Error('Invalid video ID format'));
      }
      const dir = path.join(__dirname, '..', 'videos', req.params.videoId, 'tracks');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB for audio
});

// GET is public — viewers need tracks to display subtitles even without a session.
// Write operations (POST/PATCH/DELETE) still require authentication.
router.get('/', async (req, res) => {
  try {
    // Fetch full rows (including src_path) to derive public URLs, then strip
    // the raw filesystem path before sending to clients.
    const fullTracks = await db.prepare(
      `SELECT * FROM video_tracks WHERE video_id = ? ORDER BY kind, created_at ASC`
    ).all(req.params.videoId);

    const result = fullTracks.map(t => {
      let publicUrl = null;
      if (t.src_path) {
        if (t.kind === 'subtitle' && t.format === 'vtt') {
          const filename = t.src_path.split('/').pop();
          publicUrl = `/videos/${t.video_id}/tracks/${filename}`;
        } else if (t.kind === 'audio' && t.format === 'hls') {
          // Audio HLS track — relative to video dir
          const filename = t.src_path.split('/').pop();
          const subdir   = t.src_path.split('/').slice(-2, -1)[0] || '';
          publicUrl = `/videos/${t.video_id}/tracks/${subdir ? subdir + '/' : ''}${filename}`;
        }
      }
      // Never expose the raw filesystem path to clients
      const { src_path, ...safe } = t;
      return { ...safe, url: publicUrl };
    });

    res.json(result);
  } catch (err) {
    logger.error({ err }, 'List tracks error');
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// All write routes require authentication
router.use(authenticate);

router.post('/', trackUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const video = await db.prepare(
      `SELECT v.id, v.workspace_id, w.plan FROM videos v LEFT JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = ?`
    ).get(req.params.videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Verify caller is owner or admin of this video's workspace
    if (video.workspace_id) {
      const member = await db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
        .get(video.workspace_id, req.user.id);
      if (!member) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Forbidden' }); }
      if (!['owner', 'admin'].includes(member.role)) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Se requiere rol owner o admin para subir pistas' }); }
    } else if (req.user.platform_role !== 'super_admin') {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const ext  = path.extname(req.file.filename).toLowerCase();
    const kind = req.body.kind === 'audio' ? 'audio' : 'subtitle';

    // Verificar permisos según tipo de track
    if (video.workspace_id) {
      const ws = { id: video.workspace_id, plan: video.plan };
      const featureKey = kind === 'audio' ? 'multiAudio' : 'subtitleTracks';
      const allowed = await hasFeature(ws, featureKey);
      if (!allowed) {
        fs.unlinkSync(req.file.path);
        const featureLabel = kind === 'audio' ? 'pistas de audio múltiples' : 'subtítulos personalizados';
        return res.status(403).json({
          error: `Tu plan no incluye ${featureLabel}. Actualiza tu workspace para habilitar esta funcionalidad.`,
          code: 'FEATURE_NOT_IN_PLAN',
          currentPlan: video.plan,
          requiredUpgrade: true,
        });
      }
    }

    if (kind === 'subtitle' && !SUBTITLE_EXTS.has(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Subtitles must be .srt or .vtt' });
    }
    if (kind === 'audio' && !AUDIO_EXTS.has(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Unsupported audio format' });
    }

    const language = (req.body.language || 'und').slice(0, 10);
    const label    = (req.body.label    || language).slice(0, 80);
    const isDefault = req.body.default === '1' ? 1 : 0;

    let finalPath = req.file.path;
    let format    = ext.replace('.', '');

    // Convert SRT → WebVTT so browsers can use it natively
    if (ext === '.srt') {
      finalPath = req.file.path.replace('.srt', '.vtt');
      format    = 'vtt';
      await convertSrtToVtt(req.file.path, finalPath);
      fs.unlinkSync(req.file.path);
    }

    // For audio tracks: transcode to AAC HLS segments
    if (kind === 'audio') {
      const trackDir    = path.join(path.dirname(req.file.path), path.basename(req.file.path, ext));
      const hlsPath     = await transcodeAudioTrack(req.file.path, trackDir, language);
      fs.unlinkSync(req.file.path);
      finalPath = hlsPath;
      format    = 'hls';
    }

    // If this track is default, unset existing defaults of same kind
    if (isDefault) {
      await db.prepare(`UPDATE video_tracks SET default_track = 0 WHERE video_id = ? AND kind = ?`)
        .run(req.params.videoId, kind);
    }

    const trackId = uuidv4();
    await db.prepare(`
      INSERT INTO video_tracks (id, video_id, kind, language, label, src_path, format, default_track)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trackId, req.params.videoId, kind, language, label, finalPath, format, isDefault);

    // Regenerate master playlist to include new audio tracks
    if (kind === 'audio') {
      await rebuildMasterPlaylist(req.params.videoId).catch(err =>
        logger.warn({ err: err.message }, 'Master playlist rebuild failed')
      );
    }

    res.status(201).json({ id: trackId, kind, language, label, format, default_track: isDefault });
  } catch (err) {
    logger.error({ err }, 'Upload track error');
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Failed to upload track' });
  }
});

// PATCH /:trackId — update label and/or default_track
router.patch('/:trackId', async (req, res) => {
  try {
    const track = await db.prepare(
      `SELECT vt.*, v.workspace_id FROM video_tracks vt JOIN videos v ON v.id = vt.video_id WHERE vt.id = ? AND vt.video_id = ?`
    ).get(req.params.trackId, req.params.videoId);
    if (!track) return res.status(404).json({ error: 'Not found' });

    if (track.workspace_id) {
      const member = await db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
        .get(track.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Forbidden' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para modificar pistas' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { label, default: makeDefault } = req.body;
    const updates = [];
    const values  = [];

    if (typeof label === 'string' && label.trim()) {
      updates.push('label = ?');
      values.push(label.trim().slice(0, 80));
    }

    if (makeDefault === true || makeDefault === 1) {
      // Unset existing defaults of same kind first
      await db.prepare(`UPDATE video_tracks SET default_track = 0 WHERE video_id = ? AND kind = ?`)
        .run(req.params.videoId, track.kind);
      updates.push('default_track = ?');
      values.push(1);
    } else if (makeDefault === false || makeDefault === 0) {
      updates.push('default_track = ?');
      values.push(0);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    values.push(req.params.trackId);
    await db.prepare(`UPDATE video_tracks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    // Rebuild master playlist if this is an audio track (label/default affects EXT-X-MEDIA)
    if (track.kind === 'audio') {
      await rebuildMasterPlaylist(req.params.videoId).catch(() => {});
    }

    const updated = await db.prepare(`SELECT * FROM video_tracks WHERE id = ?`).get(req.params.trackId);
    const { src_path: _sp, ...safeTrack } = updated || {};
    res.json(safeTrack);
  } catch (err) {
    logger.error({ err }, 'Patch track error');
    res.status(500).json({ error: 'Failed to update track' });
  }
});

router.delete('/:trackId', async (req, res) => {
  try {
    const track = await db.prepare(
      `SELECT vt.*, v.workspace_id FROM video_tracks vt JOIN videos v ON v.id = vt.video_id WHERE vt.id = ? AND vt.video_id = ?`
    ).get(req.params.trackId, req.params.videoId);
    if (!track) return res.status(404).json({ error: 'Not found' });

    if (track.workspace_id) {
      const member = await db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
        .get(track.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Forbidden' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para eliminar pistas' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (track.src_path) {
      try {
        if (track.format === 'hls') {
          fs.rmSync(path.dirname(track.src_path), { recursive: true, force: true });
        } else {
          fs.unlinkSync(track.src_path);
        }
      } catch {}
    }

    await db.prepare(`DELETE FROM video_tracks WHERE id = ?`).run(track.id);

    if (track.kind === 'audio') {
      await rebuildMasterPlaylist(req.params.videoId).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Delete track error');
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

// POST /api/videos/:videoId/tracks/rebuild-playlist — force-rebuild master.m3u8
router.post('/rebuild-playlist', async (req, res) => {
  try {
    const video = await db.prepare(
      `SELECT v.id, v.workspace_id FROM videos v WHERE v.id = ?`
    ).get(req.params.videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Forbidden' });
      if (!['owner', 'admin'].includes(member.role)) return res.status(403).json({ error: 'Se requiere rol owner o admin para reconstruir la lista de reproducción' });
    } else if (req.user.platform_role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await rebuildMasterPlaylist(req.params.videoId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Rebuild playlist error');
    res.status(500).json({ error: 'Failed to rebuild playlist' });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function convertSrtToVtt(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const src  = fs.readFileSync(srcPath, 'utf8');
    const vtt  = 'WEBVTT\n\n' + src
      .replace(/\r\n/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    fs.writeFileSync(destPath, vtt, 'utf8');
    resolve();
  });
}

function transcodeAudioTrack(inputPath, outputDir, language) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const m3u8Path     = path.join(outputDir, 'index.m3u8');
    const segPattern   = path.join(outputDir, 'seg%03d.aac');

    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('aac')
      .audioBitrate('128k')
      .audioFrequency(48000)
      .addOptions([
        `-hls_time 6`,
        `-hls_playlist_type vod`,
        `-hls_segment_filename ${segPattern}`,
        `-f hls`,
      ])
      .output(m3u8Path)
      .on('end', () => resolve(m3u8Path))
      .on('error', reject)
      .run();
  });
}

async function rebuildMasterPlaylist(videoId) {
  const video = await db.prepare(`SELECT qualities FROM videos WHERE id = ?`).get(videoId);
  if (!video) return;

  const qualities       = JSON.parse(video.qualities || '[]');
  const audioTracks     = await db.prepare(
    `SELECT * FROM video_tracks WHERE video_id = ? AND kind = 'audio' ORDER BY created_at ASC`
  ).all(videoId);
  const subtitleTracks  = await db.prepare(
    `SELECT * FROM video_tracks WHERE video_id = ? AND kind = 'subtitle' ORDER BY created_at ASC`
  ).all(videoId);

  const bitrateMap = { '360p':800000,'480p':1400000,'720p':2800000,'1080p':5000000,'1440p':10000000,'4k':20000000 };
  const resMap     = { '360p':'640x360','480p':'854x480','720p':'1280x720','1080p':'1920x1080','1440p':'2560x1440','4k':'3840x2160' };

  const version = subtitleTracks.length ? 7 : 3;
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${version}`];

  if (audioTracks.length) {
    const anyCustomDefault = audioTracks.some(t => t.default_track);
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="und",NAME="Original",` +
      `DEFAULT=${anyCustomDefault ? 'NO' : 'YES'},AUTOSELECT=${anyCustomDefault ? 'NO' : 'YES'}`
    );
    for (const t of audioTracks) {
      const isDefault = !!t.default_track ? 'YES' : 'NO';
      const relPath   = path.relative(path.join(__dirname, '..', 'videos', videoId), t.src_path);
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${t.language}",NAME="${t.label}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="${relPath}"`
      );
    }
  }

  if (subtitleTracks.length) {
    for (const t of subtitleTracks) {
      const isDefault = !!t.default_track ? 'YES' : 'NO';
      const relPath   = path.relative(path.join(__dirname, '..', 'videos', videoId), t.src_path);
      const lang      = t.language || 'und';
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${t.label || lang}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},FORCED=NO,URI="${relPath}"`
      );
    }
  }

  const audioAttr = audioTracks.length    ? ',AUDIO="audio"'    : '';
  const subsAttr  = subtitleTracks.length ? ',SUBTITLES="subs"' : '';
  for (const q of qualities) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bitrateMap[q]},RESOLUTION=${resMap[q]},NAME="${q}"${audioAttr}${subsAttr}`);
    lines.push(`${q}/index.m3u8`);
  }

  const outputDir = path.join(__dirname, '..', 'videos', videoId);
  fs.writeFileSync(path.join(outputDir, 'master.m3u8'), lines.join('\n'));
}

module.exports = router;
