/**
 * Ad Creatives — biblioteca de anuncios del super admin.
 *
 * CRUD:  GET/POST /api/admin/ad-creatives
 *        GET/PUT/DELETE /api/admin/ad-creatives/:id
 *
 * VAST:  GET /api/ads/vast/:id   ← endpoint público, devuelve VAST 2.0 XML
 *        para creativos tipo 'vast_video'. El player lo consume como VAST tag URL.
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { superAdminAuth } = require('../middleware/auth');
const logger  = require('../services/logger').child({ module: 'adCreatives' });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const NOW = `FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`;

const ALLOWED_TYPES = ['vast_url', 'vast_video', 'banner', 'popup'];

function sanitize(body) {
  const {
    name, type,
    // vast_url
    vast_url,
    // vast_video
    video_url, click_url, duration_sec,
    // banner
    banner_html, banner_position, banner_delay, banner_duration,
    // popup
    popup_url, popup_delay, popup_frequency,
    // shared
    vast_position, notes, is_active,
  } = body;

  if (!name?.trim())           throw new Error('name es requerido');
  if (!ALLOWED_TYPES.includes(type)) throw new Error(`type inválido: ${type}`);

  return {
    name:            name.trim(),
    type,
    vast_url:        vast_url        || null,
    video_url:       video_url       || null,
    click_url:       click_url       || null,
    duration_sec:    Number(duration_sec)    || 15,
    banner_html:     banner_html     || null,
    banner_position: banner_position || 'bottom',
    banner_delay:    Number(banner_delay)    ?? 0,
    banner_duration: Number(banner_duration) ?? 0,
    popup_url:       popup_url       || null,
    popup_delay:     Number(popup_delay)     ?? 10,
    popup_frequency: Number(popup_frequency) ?? 1,
    vast_position:   vast_position   || 'preroll',
    notes:           notes           || null,
    is_active:       is_active !== false && is_active !== 'false',
  };
}

// ─── Admin CRUD routes ────────────────────────────────────────────────────────
const adminRouter = express.Router();

// GET /api/admin/ad-creatives
adminRouter.get('/', superAdminAuth, async (req, res) => {
  try {
    const rows = await db.prepare(
      `SELECT * FROM ad_creatives ORDER BY created_at DESC`
    ).all();
    res.json({ creatives: rows });
  } catch (e) {
    logger.error({ err: e.message }, 'GET ad-creatives error');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/ad-creatives
adminRouter.post('/', superAdminAuth, async (req, res) => {
  try {
    const d  = sanitize(req.body);
    const id = uuidv4();
    await db.prepare(`
      INSERT INTO ad_creatives
        (id, name, type, vast_url, video_url, click_url, duration_sec,
         banner_html, banner_position, banner_delay, banner_duration,
         popup_url, popup_delay, popup_frequency,
         vast_position, notes, is_active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NOW},${NOW})
    `).run(
      id, d.name, d.type, d.vast_url, d.video_url, d.click_url, d.duration_sec,
      d.banner_html, d.banner_position, d.banner_delay, d.banner_duration,
      d.popup_url, d.popup_delay, d.popup_frequency,
      d.vast_position, d.notes, d.is_active,
    );
    const created = await db.prepare(`SELECT * FROM ad_creatives WHERE id = ?`).get(id);
    res.json({ ok: true, creative: created });
  } catch (e) {
    logger.error({ err: e.message }, 'POST ad-creatives error');
    res.status(400).json({ error: e.message });
  }
});

// GET /api/admin/ad-creatives/:id
adminRouter.get('/:id', superAdminAuth, async (req, res) => {
  try {
    const row = await db.prepare(`SELECT * FROM ad_creatives WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/ad-creatives/:id
adminRouter.put('/:id', superAdminAuth, async (req, res) => {
  try {
    const d = sanitize(req.body);
    await db.prepare(`
      UPDATE ad_creatives SET
        name=?, type=?, vast_url=?, video_url=?, click_url=?, duration_sec=?,
        banner_html=?, banner_position=?, banner_delay=?, banner_duration=?,
        popup_url=?, popup_delay=?, popup_frequency=?,
        vast_position=?, notes=?, is_active=?, updated_at=${NOW}
      WHERE id=?
    `).run(
      d.name, d.type, d.vast_url, d.video_url, d.click_url, d.duration_sec,
      d.banner_html, d.banner_position, d.banner_delay, d.banner_duration,
      d.popup_url, d.popup_delay, d.popup_frequency,
      d.vast_position, d.notes, d.is_active, req.params.id,
    );
    const updated = await db.prepare(`SELECT * FROM ad_creatives WHERE id = ?`).get(req.params.id);
    res.json({ ok: true, creative: updated });
  } catch (e) {
    logger.error({ err: e.message }, 'PUT ad-creatives error');
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/admin/ad-creatives/:id
adminRouter.delete('/:id', superAdminAuth, async (req, res) => {
  try {
    await db.prepare(`DELETE FROM ad_creatives WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Public VAST XML endpoint ─────────────────────────────────────────────────
const publicRouter = express.Router();

/**
 * GET /api/ads/vast/:id
 * Devuelve VAST 2.0 XML para creativos tipo 'vast_video'.
 * El VAST URL que configuras en Platform Ads sería:
 *   https://tudominio.com/api/ads/vast/{id}
 */
publicRouter.get('/:id', async (req, res) => {
  try {
    const row = await db.prepare(
      `SELECT * FROM ad_creatives WHERE id = ? AND is_active = TRUE`
    ).get(req.params.id);

    if (!row || row.type !== 'vast_video') {
      return res.status(404).send('Not found');
    }

    const videoUrl   = row.video_url   || '';
    const clickUrl   = row.click_url   || 'https://example.com';
    const duration   = row.duration_sec || 15;
    const title      = row.name || 'Ad';
    const mediaType  = videoUrl.endsWith('.webm') ? 'video/webm'
                     : videoUrl.endsWith('.ogg')  ? 'video/ogg'
                     : 'video/mp4';

    // Calcular duración en formato HH:MM:SS
    const h = Math.floor(duration / 3600).toString().padStart(2, '0');
    const m = Math.floor((duration % 3600) / 60).toString().padStart(2, '0');
    const s = (duration % 60).toString().padStart(2, '0');
    const durationStr = `${h}:${m}:${s}`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="2.0">
  <Ad id="${row.id}">
    <InLine>
      <AdSystem>StreamVault AdServer</AdSystem>
      <AdTitle><![CDATA[${title}]]></AdTitle>
      <Impression><![CDATA[]]></Impression>
      <Creatives>
        <Creative>
          <Linear>
            <Duration>${durationStr}</Duration>
            <TrackingEvents/>
            <VideoClicks>
              <ClickThrough><![CDATA[${clickUrl}]]></ClickThrough>
            </VideoClicks>
            <MediaFiles>
              <MediaFile type="${mediaType}" delivery="progressive"
                width="1280" height="720"
                bitrate="500" scalable="true" maintainAspectRatio="true">
                <![CDATA[${videoUrl}]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'no-store');
    res.send(xml);
  } catch (e) {
    logger.error({ err: e.message }, 'GET /api/ads/vast error');
    res.status(500).send('Error');
  }
});

module.exports = { adminRouter, publicRouter };
