const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { addTranscribeJob } = require('../services/queue');
const { authenticate, optionalAuth } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { hasFeature } = require('../middleware/checkFeature');

function vttTimeToSeconds(t) {
  const parts = t.trim().split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
}

function parseVttCues(vttContent) {
  const cues = [];
  const blocks = vttContent.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeIdx = lines.findIndex(l => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [startStr, endStr] = lines[timeIdx].split('-->');
    const text = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    cues.push({
      startTime: vttTimeToSeconds(startStr),
      endTime: vttTimeToSeconds(endStr),
      text,
    });
  }
  return cues;
}

function buildSnippet(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 120);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + query.length + 60);
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  return pre + text.slice(start, end) + post;
}

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2 || q.length > 200) {
    return res.status(400).json({ error: 'Query must be 2–200 characters' });
  }

  try {
    // Visibility gate — mirrors subtitles.vtt behaviour
    const videoMeta = await db.prepare(`SELECT visibility, workspace_id FROM videos WHERE id = ?`).get(req.params.videoId);
    if (!videoMeta) return res.status(404).json({ error: 'Video not found' });
    if (videoMeta.visibility === 'private' || videoMeta.visibility === 'password') {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const member = await db.prepare(
        `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(videoMeta.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });
    }

    const lang = req.query.lang || null;

    let row;
    if (lang) {
      row = await db.prepare(
        `SELECT vtt_content, language FROM transcriptions
         WHERE video_id = ? AND language = ? AND status = 'ready'
         ORDER BY created_at DESC LIMIT 1`
      ).get(req.params.videoId, lang);
    }
    if (!row) {
      row = await db.prepare(
        `SELECT vtt_content, language FROM transcriptions
         WHERE video_id = ? AND status = 'ready'
         ORDER BY created_at DESC LIMIT 1`
      ).get(req.params.videoId);
    }

    if (!row?.vtt_content) {
      return res.status(404).json({ error: 'No ready transcription found for this video' });
    }

    const lowerQ = q.toLowerCase();
    const results = parseVttCues(row.vtt_content)
      .filter(c => c.text.toLowerCase().includes(lowerQ))
      .map(c => ({ startTime: c.startTime, endTime: c.endTime, text: c.text, snippet: buildSnippet(c.text, q) }));

    res.json({ query: q, language: row.language, total: results.length, results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search transcriptions' });
  }
});

router.get('/', optionalAuth, async (req, res) => {
  try {
    const video = await db.prepare(`SELECT id, visibility, workspace_id FROM videos WHERE id = ?`).get(req.params.videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    if (video.visibility === 'private' || video.visibility === 'password') {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const member = await db.prepare(
        `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Access denied' });
    }

    const rows = await db.prepare(
      `SELECT id, language, status, word_count, duration_secs, error_msg, created_at, updated_at
       FROM transcriptions WHERE video_id = ? ORDER BY created_at DESC`
    ).all(req.params.videoId);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transcriptions' });
  }
});

router.get('/:lang/subtitles.vtt', optionalAuth, async (req, res) => {
  try {
    // Enforce video visibility — private videos require workspace membership
    const video = await db.prepare(`SELECT id, visibility, workspace_id FROM videos WHERE id = ?`).get(req.params.videoId);
    if (!video) return res.status(404).send('WEBVTT\n\n/* Video not found */');
    if (video.visibility === 'private' || video.visibility === 'password') {
      if (!req.user) return res.status(401).send('WEBVTT\n\n/* Authentication required */');
      const member = await db.prepare(
        `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).send('WEBVTT\n\n/* Access denied */');
    }

    const row = await db.prepare(
      `SELECT vtt_content FROM transcriptions
       WHERE video_id = ? AND language = ? AND status = 'ready'
       ORDER BY created_at DESC LIMIT 1`
    ).get(req.params.videoId, req.params.lang);

    if (!row?.vtt_content) {
      return res.status(404).send('WEBVTT\n\n/* No subtitles available */');
    }

    // Apply timing offset if provided (in seconds, can be negative)
    let vttContent = row.vtt_content;
    const offsetSecs = parseFloat(req.query.offset || '0');

    if (offsetSecs !== 0) {
      vttContent = adjustVttTimestamps(vttContent, offsetSecs);
    }

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(vttContent);
  } catch (err) {
    res.status(500).send('WEBVTT\n\n/* Error loading subtitles */');
  }
});

// Helper: Adjust all timestamps in a VTT file by offset seconds
function adjustVttTimestamps(vttContent, offsetSecs) {
  return vttContent.replace(
    /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g,
    (match, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
      // Convert to total seconds
      const start = parseInt(h1) * 3600 + parseInt(m1) * 60 + parseInt(s1) + parseInt(ms1) / 1000;
      const end = parseInt(h2) * 3600 + parseInt(m2) * 60 + parseInt(s2) + parseInt(ms2) / 1000;
      
      // Apply offset (don't go negative)
      const newStart = Math.max(0, start + offsetSecs);
      const newEnd = Math.max(0, end + offsetSecs);
      
      // Convert back to VTT format
      const formatTime = (totalSecs) => {
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = Math.floor(totalSecs % 60);
        const ms = Math.round((totalSecs % 1) * 1000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
      };
      
      return `${formatTime(newStart)} --> ${formatTime(newEnd)}`;
    }
  );
}

router.post('/', rateLimit(5, 60_000), authenticate, async (req, res) => {
  try {
    const video = await db.prepare(
      `SELECT v.id, v.status, v.original_filename, v.workspace_id, w.plan, w.settings
       FROM videos v LEFT JOIN workspaces w ON w.id = v.workspace_id
       WHERE v.id = ?`
    ).get(req.params.videoId);

    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Verify caller is an owner or admin of the video's workspace
    if (video.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(video.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Forbidden' });
      if (!['owner', 'admin'].includes(member.role)) {
        return res.status(403).json({ error: 'Se requiere rol owner o admin para iniciar transcripciones' });
      }
    }
    if (video.status !== 'ready') {
      return res.status(409).json({ error: 'Video is not ready yet' });
    }

    // [MED-12] Límite de tamaño de archivo para Whisper.
    // Whisper tiene un límite práctico de ~25 MB de audio extraído.
    // Videos muy grandes consumen demasiada memoria y tiempo de proceso.
    // Máximo configurable vía env, default 2 GB.
    const MAX_TRANSCRIPTION_SIZE_BYTES = parseInt(process.env.MAX_TRANSCRIPTION_FILE_BYTES || String(2 * 1024 * 1024 * 1024));
    const videoSize = await db.prepare(`SELECT size FROM videos WHERE id = ?`).get(req.params.videoId);
    if (videoSize?.size && videoSize.size > MAX_TRANSCRIPTION_SIZE_BYTES) {
      const maxGB = (MAX_TRANSCRIPTION_SIZE_BYTES / 1e9).toFixed(1);
      return res.status(413).json({
        error: `El archivo es demasiado grande para transcribir. Límite: ${maxGB} GB.`,
        code: 'FILE_TOO_LARGE_FOR_TRANSCRIPTION',
      });
    }

    // Verificar permisos de transcripciones (Global + Plan)
    if (video.workspace_id) {
      const ws = { id: video.workspace_id, plan: video.plan };
      const canTranscribe = await hasFeature(ws, 'transcriptions');
      if (!canTranscribe) {
        return res.status(403).json({
          error: 'Tu plan no incluye transcripciones automáticas. Actualiza tu workspace para habilitar esta funcionalidad.',
          code: 'FEATURE_NOT_IN_PLAN',
          currentPlan: video.plan,
          requiredUpgrade: true,
        });
      }
    }

    const language = req.body.language || 'en';
    const LANGUAGES = ['es', 'en', 'fr', 'de', 'it', 'pt', 'ja', 'zh', 'ko', 'ar', 'ru'];
    if (!LANGUAGES.includes(language)) {
      return res.status(400).json({ error: `Unsupported language. Allowed: ${LANGUAGES.join(', ')}` });
    }

    // Check for OpenAI API key from workspace settings only
    let openaiApiKey = '';
    try {
      const settings = JSON.parse(video.settings || '{}');
      openaiApiKey = settings.openaiApiKey || '';
    } catch {}

    if (!openaiApiKey) {
      return res.status(503).json({
        error: 'OpenAI API Key no configurada. Configura tu clave en Ajustes → General de tu workspace para usar transcripciones con Whisper AI.',
      });
    }

    const existing = await db.prepare(
      `SELECT id, status FROM transcriptions
       WHERE video_id = ? AND language = ? AND status IN ('pending', 'processing')`
    ).get(req.params.videoId, language);

    if (existing) {
      return res.status(409).json({ error: 'Transcription already in progress', status: existing.status });
    }

    const id = uuidv4();
    await db.prepare(
      `INSERT INTO transcriptions (id, video_id, language, status) VALUES (?, ?, ?, 'pending')`
    ).run(id, video.id, language);

    // ── Enqueue Whisper job — never runs in the API server process ──
    await addTranscribeJob({ transcriptionId: id, videoId: video.id, language });

    res.status(202).json({ id, status: 'pending', language });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create transcription' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const row = await db.prepare(
      `SELECT t.id, v.workspace_id FROM transcriptions t
       JOIN videos v ON v.id = t.video_id
       WHERE t.id = ? AND t.video_id = ?`
    ).get(req.params.id, req.params.videoId);

    if (!row) return res.status(404).json({ error: 'Transcription not found' });

    if (row.workspace_id) {
      const member = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(row.workspace_id, req.user.id);
      if (!member) return res.status(403).json({ error: 'Forbidden' });
      if (!['owner', 'admin'].includes(member.role)) {
        return res.status(403).json({ error: 'Se requiere rol owner o admin para eliminar transcripciones' });
      }
    }

    await db.prepare(`DELETE FROM transcriptions WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete transcription' });
  }
});

module.exports = router;
