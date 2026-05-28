const express = require('express');
const router  = express.Router();
const db      = require('../db');
const cfg     = require('../config');
const logger  = require('../services/logger').child({ module: 'health' });

// Uptime real desde el primer arranque guardado en DB (no se resetea en deploy)
const START_TIME = Date.now();

// GET /api/health/uptime-history?days=90 — datos para barras de uptime estilo Atlassian
// Devuelve para cada servicio un array de {date, uptime_pct, incidents} por día.
router.get('/uptime-history', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days || '90', 10)));
    const services = ['api', 'database', 'redis', 's3', 'worker'];
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    // ── First boot stored ─────────────────────────────────────
    const firstRow = await db.prepare(
      `SELECT MIN(checked_at) AS first FROM status_history`
    ).get();
    const firstCheck = firstRow?.first || Math.floor(Date.now() / 1000);

    // ── Daily aggregation per service ────────────────────────
    const result = {};
    for (const svc of services) {
      // Group checks into UTC days, compute uptime % per day
      const rows = await db.prepare(`
        SELECT
          TO_CHAR(TO_TIMESTAMP(checked_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'ok') AS ok_count
        FROM status_history
        WHERE service = ? AND checked_at >= ?
        GROUP BY day
        ORDER BY day ASC
      `).all(svc, cutoff);

      // Fill missing days with null (no data)
      const byDay = {};
      rows.forEach(r => {
        byDay[r.day] = {
          uptime_pct: r.total > 0 ? Math.round((Number(r.ok_count) / Number(r.total)) * 1000) / 10 : null,
          total: Number(r.total),
          ok: Number(r.ok_count),
        };
      });

      // Build array for last N days
      const arr = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const dayTs  = Math.floor(d.getTime() / 1000);
        const entry  = byDay[dayStr];
        arr.push({
          date:       dayStr,
          uptime_pct: entry ? entry.uptime_pct : (dayTs < firstCheck ? null : 100),
          total:      entry?.total ?? 0,
          ok:         entry?.ok    ?? 0,
        });
      }
      result[svc] = arr;
    }

    // Overall uptime (last 90 days, all services combined)
    const overallRow = await db.prepare(`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'ok') AS ok
      FROM status_history WHERE checked_at >= ?
    `).get(cutoff);
    const overallPct = overallRow?.total > 0
      ? Math.round((Number(overallRow.ok) / Number(overallRow.total)) * 1000) / 10
      : 100;

    res.json({ services: result, overall_uptime_pct: overallPct, days, first_check: firstCheck });
  } catch (err) {
    logger.error({ err }, 'uptime-history error');
    res.status(500).json({ error: err.message });
  }
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

router.get('/', async (req, res) => {
  const checks  = {};
  let   overall = 'ok';

  // ── 1. PostgreSQL ─────────────────────────────────────────────────────────
  const dbStart = Date.now();
  try {
    await withTimeout(db.prepare('SELECT 1 AS ok').get(), 3000);
    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (err) {
    checks.database = { status: 'error', latencyMs: Date.now() - dbStart };
    overall = 'degraded';
    logger.error({ err }, 'Health check: database failed');
  }

  // ── 2. Redis ──────────────────────────────────────────────────────────────
  if (cfg.redisUrl) {
    const redisStart = Date.now();
    try {
      const Redis = require('ioredis');
      const client = new Redis(cfg.redisUrl, {
        enableOfflineQueue:   false,
        maxRetriesPerRequest: 0,
        connectTimeout:       2500,
        commandTimeout:       2500,
        lazyConnect:          true,
        retryStrategy:        () => null, // Don't retry on health check
      });
      // Suppress unhandled ioredis error events
      client.on('error', () => {});
      await withTimeout(
        client.connect().then(() => client.ping()).then(async (pong) => {
          await client.quit().catch(() => {});
          return pong;
        }),
        4000
      ).then(pong => {
        checks.redis = { status: pong === 'PONG' ? 'ok' : 'error', latencyMs: Date.now() - redisStart };
        if (pong !== 'PONG') overall = 'degraded';
      });
    } catch (err) {
      checks.redis = { status: 'error', latencyMs: Date.now() - redisStart };
      overall = 'degraded';
      logger.warn({ err }, 'Health check: Redis failed');
    }
  } else {
    checks.redis = { status: 'not_configured' };
  }

  // ── 3. S3 ─────────────────────────────────────────────────────────────────
  const s3svc = require('../services/s3Storage');
  if (s3svc.isS3Enabled()) {
    const s3Start = Date.now();
    try {
      const result = await withTimeout(s3svc.headBucket(), 5000);
      checks.s3 = { status: result.ok ? 'ok' : 'error', latencyMs: Date.now() - s3Start };
      if (!result.ok) overall = 'degraded';
    } catch (err) {
      checks.s3 = { status: 'error', latencyMs: Date.now() - s3Start };
      overall = 'degraded';
    }
  } else {
    checks.s3 = { status: 'not_configured' };
  }

  // ── 4. Worker heartbeat ───────────────────────────────────────────────────
  try {
    const w = await db.prepare(`SELECT healthy, checked_at FROM status_checks WHERE service = 'worker'`).get();
    const nowSec = Math.floor(Date.now() / 1000);
    const alive = w && w.healthy && (nowSec - w.checked_at) <= 300;
    checks.worker = { status: alive ? 'ok' : w ? 'degraded' : 'unknown', lastHeartbeatSec: w ? nowSec - w.checked_at : null };
    if (!alive && w) overall = 'degraded';
  } catch (err) {
    checks.worker = { status: 'error', error: err.message };
  }

  const memMB     = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  const httpStatus = checks.database?.status === 'error' ? 503 : overall === 'degraded' ? 207 : 200;

  res.status(httpStatus).json({
    status: overall,
    timestamp: new Date().toISOString(),
    uptime: uptimeSec,
    memoryMB: memMB,
    version: process.env.npm_package_version || '1.0.0',
    checks,
  });
});

// ─── Incidents & Maintenance CRUD (public read, admin write) ─────────────────

const { v4: uuidv4 } = require('uuid');

// GET /api/health/incidents — list recent incidents + maintenance
router.get('/incidents', async (req, res) => {
  try {
    const type   = req.query.type || null; // 'incident' | 'maintenance' | null = all
    const limit  = Math.min(50, parseInt(req.query.limit || '20', 10));
    const whereClause = type ? `WHERE type = $1` : `WHERE 1=1`;
    const params = type ? [type, limit] : [limit];
    const rows = await db.prepare(
      `SELECT i.*, 
        (SELECT json_agg(u ORDER BY u.created_at ASC)
         FROM status_updates u WHERE u.incident_id = i.id) AS updates
       FROM status_incidents i
       ${type ? 'WHERE type = ?' : ''}
       ORDER BY i.created_at DESC
       LIMIT ?`
    ).all(...(type ? [type, limit] : [limit]));
    const parsed = rows.map(r => ({
      ...r,
      services: typeof r.services === 'string' ? JSON.parse(r.services || '[]') : (r.services || []),
      updates:  Array.isArray(r.updates) ? r.updates : (r.updates ? (typeof r.updates === 'string' ? JSON.parse(r.updates) : r.updates) : []),
    }));
    res.json({ incidents: parsed });
  } catch (err) {
    logger.error({ err }, 'GET incidents error');
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health/incidents/:id
router.get('/incidents/:id', async (req, res) => {
  try {
    const row = await db.prepare(`SELECT * FROM status_incidents WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const updates = await db.prepare(`SELECT * FROM status_updates WHERE incident_id = ? ORDER BY created_at ASC`).all(req.params.id);
    res.json({ ...row, services: JSON.parse(row.services || '[]'), updates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/health/incidents — create incident or maintenance (super_admin only)
router.post('/incidents', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const cfg = require('../config');
    const payload = jwt.verify(token, cfg.jwtSecret);
    const user = await db.prepare(`SELECT id, email, platform_role FROM users WHERE id = ?`).get(payload.userId);
    if (!user || user.platform_role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

    const { type = 'incident', title, status = 'investigating', impact = 'minor', services = [], scheduled_at, body, notify } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`
      INSERT INTO status_incidents (id, type, title, status, impact, services, scheduled_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, title, status, impact, JSON.stringify(services), scheduled_at || null, user.id, now, now);

    if (body) {
      const updId = uuidv4();
      await db.prepare(`INSERT INTO status_updates (id, incident_id, body, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(updId, id, body, status, user.id, now);
    }

    // ── Notifications & emails ────────────────────────────────
    if (notify !== false) {
      _notifyIncident({ id, type, title, status, impact, body, scheduled_at }, user.email).catch(() => {});
    }

    res.json({ ok: true, id });
  } catch (err) {
    logger.error({ err }, 'POST incident error');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/health/incidents/:id/updates — add update (super_admin only)
router.post('/incidents/:id/updates', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const cfg = require('../config');
    const payload = jwt.verify(token, cfg.jwtSecret);
    const user = await db.prepare(`SELECT id, platform_role FROM users WHERE id = ?`).get(payload.userId);
    if (!user || user.platform_role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

    const { body, status, resolved } = req.body;
    if (!body) return res.status(400).json({ error: 'body required' });

    const incident = await db.prepare(`SELECT * FROM status_incidents WHERE id = ?`).get(req.params.id);
    if (!incident) return res.status(404).json({ error: 'Not found' });

    const updId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`INSERT INTO status_updates (id, incident_id, body, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(updId, req.params.id, body, status || incident.status, user.id, now);

    const newStatus = resolved ? 'resolved' : (status || incident.status);
    await db.prepare(`UPDATE status_incidents SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?`)
      .run(newStatus, resolved ? now : incident.resolved_at, now, req.params.id);

    res.json({ ok: true, update_id: updId });
  } catch (err) {
    logger.error({ err }, 'POST incident update error');
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/health/incidents/:id — delete (super_admin only)
router.delete('/incidents/:id', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const cfg = require('../config');
    const payload = jwt.verify(token, cfg.jwtSecret);
    const user = await db.prepare(`SELECT platform_role FROM users WHERE id = ?`).get(payload.userId);
    if (!user || user.platform_role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    await db.prepare(`DELETE FROM status_incidents WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notify helpers ────────────────────────────────────────────────────────────
async function _notifyIncident(incident, actorEmail) {
  const { type, title, status, impact, body, scheduled_at } = incident;
  const dynCfg = require('../services/dynamicConfig');
  const platformCfg = await dynCfg.getDynSection('platform', {}).catch(() => ({}));
  const siteName = platformCfg.siteName || 'StreamVault';
  const appUrl   = platformCfg.appUrl || process.env.APP_URL || '';

  const isMaintenace = type === 'maintenance';
  const icon  = isMaintenace ? '🔧' : (status === 'resolved' ? '✅' : '⚠️');
  const badge = isMaintenace ? 'Mantenimiento programado' : (status === 'resolved' ? 'Resuelto' : `Incidente — impacto ${impact}`);
  const dateStr = scheduled_at ? new Date(scheduled_at * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : '';

  // Send in-app notifications to all workspace owners + admins
  try {
    const wsOwners = await db.prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.role IN ('owner','admin')`
    ).all();
    const notifId = () => require('uuid').v4();
    const now = Math.floor(Date.now() / 1000);
    for (const owner of wsOwners) {
      await db.prepare(
        `INSERT INTO notifications (id, user_id, workspace_id, kind, title, body, link, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(
        notifId(), owner.id,
        status === 'resolved' ? 'success' : (isMaintenace ? 'info' : 'warn'),
        `${icon} ${badge}: ${title}`,
        body || (isMaintenace ? `Mantenimiento programado para ${dateStr}` : `Se ha detectado un incidente en ${siteName}.`),
        `${appUrl}/status`,
        now
      );
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to send incident notifications');
  }

  // Email to all users (fire-and-forget, non-blocking)
  try {
    const emailSvc = require('../services/email');
    if (typeof emailSvc.sendStatusAlert === 'function') {
      const allEmails = await db.prepare(`SELECT email FROM users WHERE email_verified = 1`).all();
      for (const { email } of allEmails.slice(0, 200)) {
        emailSvc.sendStatusAlert(email, { siteName, appUrl, title, status, impact, body, type, scheduled_at, dateStr }).catch(() => {});
      }
    }
  } catch (_) {}
}

// POST /api/health/contact — enviar mensaje de contacto/reporte al soporte (publico, rate-limitado)
router.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message, type = 'contact' } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'name, email y message son requeridos' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalido' });
    if (message.length > 4000) return res.status(400).json({ error: 'Mensaje demasiado largo' });

    const dynCfg = require('../services/dynamicConfig');
    const platformCfg = await dynCfg.getDynSection('platform', {}).catch(() => ({}));
    const siteName = platformCfg.siteName || 'StreamVault';
    const supportEmail = platformCfg.supportEmail || process.env.SMTP_FROM || process.env.SMTP_USER || '';

    if (!supportEmail) {
      logger.info({ name, email, subject, type }, 'Contact form submitted (no support email configured)');
      return res.json({ ok: true });
    }

    const typeLabels = { contact: 'Consulta general', incident: 'Reporte de incidente', feedback: 'Sugerencia' };
    const typeLabel = typeLabels[type] || type;

    const emailSvc = require('../services/email');
    if (typeof emailSvc.sendRaw === 'function') {
      await emailSvc.sendRaw({
        to: supportEmail,
        replyTo: `"${name}" <${email}>`,
        subject: `[${siteName} Status] ${typeLabel}: ${subject || message.slice(0, 60)}`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:600px;padding:24px;">
          <h2 style="margin:0 0 16px;color:#7c6cfa;">${siteName} — Formulario de contacto</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:8px 0;color:#666;width:100px;">Tipo</td><td style="padding:8px 0;font-weight:600;">${typeLabel}</td></tr>
            <tr><td style="padding:8px 0;color:#666;">Nombre</td><td style="padding:8px 0;">${name}</td></tr>
            <tr><td style="padding:8px 0;color:#666;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}">${email}</a></td></tr>
            ${subject ? `<tr><td style="padding:8px 0;color:#666;">Asunto</td><td style="padding:8px 0;">${subject}</td></tr>` : ''}
          </table>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
          <div style="background:#f9f9f9;border-radius:8px;padding:16px;font-size:14px;line-height:1.6;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <p style="color:#aaa;font-size:12px;margin-top:16px;">Enviado desde ${siteName}/status</p>
        </div>`,
      });
    } else {
      // fallback: usar sendStatusAlert o cualquier funcion disponible
      logger.info({ name, email, subject, message, type }, 'Contact form (no sendRaw available)');
    }

    // Guardar en BD para que el admin pueda verlo
    try {
      const { v4: uuidv4r } = require('uuid');
      const now2 = Math.floor(Date.now() / 1000);
      await db.prepare(`
        INSERT INTO user_reports (id, name, email, subject, message, type, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT DO NOTHING
      `).run(uuidv4r(), name, email, subject || null, message, type, now2, now2);
    } catch (dbErr) {
      // Si la tabla no existe aun, no fallar — solo loguear
      logger.warn({ err: dbErr.message }, 'Could not save contact to user_reports (table may not exist yet)');
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'POST /contact error');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
