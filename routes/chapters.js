const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger').child({ module: 'chapters' });

async function getVideo(videoId) {
  return db.prepare(`SELECT * FROM videos WHERE id = ?`).get(videoId);
}

async function getChapters(videoId) {
  return db.prepare(
    `SELECT * FROM chapters WHERE video_id = ? ORDER BY start_time ASC`
  ).all(videoId);
}

async function assertOwner(videoId, userId, platformRole) {
  const video = await db.prepare(`SELECT id, workspace_id FROM videos WHERE id = ?`).get(videoId);
  if (!video) return null;
  if (video.workspace_id) {
    const member = await db.prepare(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
    ).get(video.workspace_id, userId);
    if (!member) return false;
    if (!['owner', 'admin'].includes(member.role)) return false;
  } else if (platformRole !== 'super_admin') {
    return false;
  }
  return video;
}

function secondsToVttTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = (secs % 60).toFixed(3);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(6, '0')}`;
}


router.get('/', async (req, res) => {
  try {
    const video = await getVideo(req.params.videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (video.visibility === 'private' || video.visibility === 'password') {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (video.workspace_id) {
        const member = await db.prepare(
          `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
        ).get(video.workspace_id, req.user.id);
        if (!member) return res.status(403).json({ error: 'Access denied' });
      }
    }
    res.json(await getChapters(req.params.videoId));
  } catch (err) {
    logger.error({ err }, 'list chapters failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Returns empty WEBVTT (200) when no chapters — lets the player load gracefully.
router.get('/export.vtt', async (req, res) => {
  try {
    const video = await getVideo(req.params.videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (video.visibility === 'private' || video.visibility === 'password') {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (video.workspace_id) {
        const member = await db.prepare(
          `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
        ).get(video.workspace_id, req.user.id);
        if (!member) return res.status(403).json({ error: 'Access denied' });
      }
    }

    const chapters = await getChapters(req.params.videoId);
    const duration = video.duration || 0;
    let vtt = 'WEBVTT\n\n';

    chapters.forEach((ch, i) => {
      const start   = secondsToVttTime(ch.start_time);
      const endSecs = i + 1 < chapters.length ? chapters[i + 1].start_time : duration;
      const end     = secondsToVttTime(Math.max(endSecs, ch.start_time + 1));
      vtt += `${start} --> ${end}\n${ch.title}\n\n`;
    });

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Content-Disposition', `attachment; filename="chapters-${req.params.videoId}.vtt"`);
    res.send(vtt);
  } catch (err) {
    logger.error({ err }, 'export chapters vtt failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const video = await assertOwner(req.params.videoId, req.user.id, req.user.platform_role);
    if (video === null) return res.status(404).json({ error: 'Video not found' });
    if (video === false) return res.status(403).json({ error: 'Forbidden' });

    const { title, start_time } = req.body;
    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (title.trim().length > 200) {
      return res.status(400).json({ error: 'title must be 200 characters or less' });
    }
    if (start_time === undefined || isNaN(Number(start_time)) || Number(start_time) < 0) {
      return res.status(400).json({ error: 'start_time must be a non-negative number (seconds)' });
    }

    const id = uuidv4();
    const posRow = await db.prepare(
      `SELECT COUNT(*) as cnt FROM chapters WHERE video_id = ?`
    ).get(req.params.videoId);
    const position = posRow?.cnt || 0;

    await db.prepare(
      `INSERT INTO chapters (id, video_id, title, start_time, position) VALUES (?, ?, ?, ?, ?)`
    ).run(id, req.params.videoId, title.trim(), Number(start_time), position);

    const chapter = await db.prepare(`SELECT * FROM chapters WHERE id = ?`).get(id);
    res.status(201).json(chapter);
  } catch (err) {
    logger.error({ err }, 'create chapter failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:cid', authenticate, async (req, res) => {
  try {
    const video = await assertOwner(req.params.videoId, req.user.id, req.user.platform_role);
    if (video === null) return res.status(404).json({ error: 'Video not found' });
    if (video === false) return res.status(403).json({ error: 'Forbidden' });

    const chapter = await db.prepare(
      `SELECT * FROM chapters WHERE id = ? AND video_id = ?`
    ).get(req.params.cid, req.params.videoId);

    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    const { title, start_time } = req.body;
    if (title !== undefined && title.trim().length === 0) {
      return res.status(400).json({ error: 'title cannot be empty' });
    }
    if (title !== undefined && title.trim().length > 200) {
      return res.status(400).json({ error: 'title must be 200 characters or less' });
    }
    if (start_time !== undefined && (isNaN(Number(start_time)) || Number(start_time) < 0)) {
      return res.status(400).json({ error: 'start_time must be a non-negative number' });
    }

    await db.prepare(
      `UPDATE chapters SET
        title = COALESCE(?, title),
        start_time = COALESCE(?, start_time)
       WHERE id = ?`
    ).run(title?.trim() ?? null, start_time !== undefined ? Number(start_time) : null, req.params.cid);

    res.json(await db.prepare(`SELECT * FROM chapters WHERE id = ?`).get(req.params.cid));
  } catch (err) {
    logger.error({ err }, 'update chapter failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /reorder — receive ordered array of chapter ids and reassign positions
router.patch('/reorder', authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const video = await assertOwner(req.params.videoId, req.user.id, req.user.platform_role);
    if (video === null) return res.status(404).json({ error: 'Video not found' });
    if (video === false) return res.status(403).json({ error: 'Forbidden' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          `UPDATE chapters SET position = $1 WHERE id = $2 AND video_id = $3`,
          [i, ids[i], req.params.videoId]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'reorder chapters failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:cid', authenticate, async (req, res) => {
  try {
    const video = await assertOwner(req.params.videoId, req.user.id, req.user.platform_role);
    if (video === null) return res.status(404).json({ error: 'Video not found' });
    if (video === false) return res.status(403).json({ error: 'Forbidden' });

    const chapter = await db.prepare(
      `SELECT * FROM chapters WHERE id = ? AND video_id = ?`
    ).get(req.params.cid, req.params.videoId);

    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    await db.prepare(`DELETE FROM chapters WHERE id = ?`).run(req.params.cid);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'delete chapter failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
