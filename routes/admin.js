const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const config  = require('../config');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const s3svc   = require('../services/s3Storage');
const { getQueueStats, getFailedJobs, retryJob, cleanQueue } = require('../services/queue');
const { superAdminAuth } = require('../middleware/auth');
const { logAudit } = require('../services/auditLog');
const cache   = require('../services/cache');
const logger  = require('../services/logger').child({ module: 'admin' });

// NO aplicamos superAdminAuth globalmente porque /metrics/stream necesita auth especial (query token para SSE)
// Cada endpoint lo aplica individualmente

async function getConfig(key, defaultVal = null) {
  try {
    const row = await db.prepare('SELECT value FROM system_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultVal;
  } catch { return defaultVal; }
}

async function setConfig(key, value) {
  await db.prepare(`INSERT INTO system_config (key, value, updated_at)
    VALUES (?, ?, FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`
  ).run(key, JSON.stringify(value));
  // Sincronizar caché en memoria de dynamicConfig para que getDynConfig()
  // retorne el valor actualizado inmediatamente (sin reinicio del servidor)
  try {
    const dynCfg = require('../services/dynamicConfig');
    await dynCfg.reloadDynConfig();
  } catch {}
}

router.get('/s3/test', superAdminAuth, async (req, res) => {
  try {
    const r = await s3svc.headBucket();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/s3/prune', superAdminAuth, async (req, res) => {
  try {
    const records = await db.prepare('SELECT s3_object_prefix FROM videos WHERE s3_object_prefix IS NOT NULL').all();
    const validPrefixes = new Set(records.map(r => r.s3_object_prefix));
    
    const result = await s3svc.pruneOrphans(validPrefixes);
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error({ err: e.message }, 'S3 prune error');
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', superAdminAuth, async (req, res) => {
  try {
    const workspaceId = req.headers['x-workspace-id'];
    let total, ready, processing, error, views, storage;

    if (workspaceId) {
      total      = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE workspace_id = ?`).get(workspaceId);
      ready      = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status='ready' AND workspace_id = ?`).get(workspaceId);
      processing = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status IN ('queued','transcoding') AND workspace_id = ?`).get(workspaceId);
      error      = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status='error' AND workspace_id = ?`).get(workspaceId);
      views      = await db.prepare(`SELECT COALESCE(SUM(views),0) as t FROM videos WHERE workspace_id = ?`).get(workspaceId);
      storage    = await db.prepare(`SELECT COALESCE(SUM(size),0) as t FROM videos WHERE workspace_id = ?`).get(workspaceId);
    } else {
      total      = await db.prepare(`SELECT COUNT(*) as c FROM videos`).get();
      ready      = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status='ready'`).get();
      processing = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status IN ('queued','transcoding')`).get();
      error      = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE status='error'`).get();
      views      = await db.prepare(`SELECT COALESCE(SUM(views),0) as t FROM videos`).get();
      storage    = await db.prepare(`SELECT COALESCE(SUM(size),0) as t FROM videos`).get();
    }

    const users      = await db.prepare(`SELECT COUNT(*) as c FROM users`).get();
    const workspaces = await db.prepare(`SELECT COUNT(*) as c FROM workspaces`).get();

    const recentSignups = await db.prepare(`
      SELECT COUNT(*) as c FROM users
      WHERE created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - 604800
    `).get();

    const recentVideos = await db.prepare(`
      SELECT COUNT(*) as c FROM videos
      WHERE created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - 604800
    `).get();

    const queue = await getQueueStats();
    let s3 = { enabled: s3svc.isS3Enabled() };
    if (s3svc.isS3Enabled()) s3 = { ...s3, ...(await s3svc.headBucket()) };

    res.json({
      total:        Number(total?.c)      || 0,
      ready:        Number(ready?.c)      || 0,
      processing:   Number(processing?.c) || 0,
      error:        Number(error?.c)      || 0,
      totalViews:   Number(views?.t)      || 0,
      totalStorage: Number(storage?.t)    || 0,
      totalUsers:   Number(users?.c)      || 0,
      totalWorkspaces: Number(workspaces?.c) || 0,
      recentSignups:   Number(recentSignups?.c) || 0,
      recentVideos:    Number(recentVideos?.c)  || 0,
      queue,
      s3,
    });
  } catch (err) {
    logger.error({ err }, 'Admin stats error');
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/workspaces', superAdminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;
    const workspaces = await db.prepare(`
      SELECT w.*, u.email as owner_email, u.name as owner_name,
        (SELECT COUNT(*) FROM videos WHERE workspace_id = w.id) as video_count,
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) as member_count,
        (SELECT COALESCE(SUM(views),0) FROM videos WHERE workspace_id = w.id) as total_views,
        (SELECT COALESCE(SUM(size),0) FROM videos WHERE workspace_id = w.id) as storage_used
      FROM workspaces w
      JOIN users u ON w.owner_id = u.id
      ORDER BY w.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const countRow = await db.prepare(`SELECT COUNT(*) as cnt FROM workspaces`).get();
    
    // Parsear custom_limits para cada workspace
    const parsedWorkspaces = workspaces.map(ws => {
      let customLimits = null;
      try {
        if (ws.custom_limits) customLimits = JSON.parse(ws.custom_limits);
      } catch {}
      return { ...ws, custom_limits: customLimits };
    });
    
    res.json({ workspaces: parsedWorkspaces, total: Number(countRow?.cnt || 0), page, limit });
  } catch (err) {
    logger.error({ err }, 'Admin list workspaces error');
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

router.put('/workspaces/:id', superAdminAuth, async (req, res) => {
  const { plan, suspended, name, custom_limits } = req.body;
  const updates = [], values = [];

  // ── Plan change: also update quota limits to match the new plan ──────────
  // Without this, a workspace changed from Starter → Pro would keep Starter
  // limits even though the plan badge shows Pro.
  if (plan !== undefined) {
    const planConfig = config.plans[plan];
    if (!planConfig) {
      return res.status(400).json({ error: `Plan desconocido: "${plan}". Planes válidos: ${Object.keys(config.plans).join(', ')}` });
    }

    updates.push('plan = ?');
    values.push(plan);

    if (planConfig) {
      updates.push('max_videos = ?');
      values.push(planConfig.maxVideos);

      updates.push('max_storage_bytes = ?');
      values.push(planConfig.maxStorageGB * 1e9);

      updates.push('max_bandwidth_bytes = ?');
      values.push(planConfig.maxBandwidthGB * 1e9);

      // Lift suspension when manually upgrading a plan
      updates.push('suspended = ?');
      values.push(0);
    }
  }

  // ── Custom limits: permite ajustes personalizados para casos especiales ──
  if (custom_limits !== undefined) {
    if (custom_limits === null) {
      // Remover límites personalizados (usar defaults del plan)
      updates.push('custom_limits = ?');
      values.push(null);
    } else if (typeof custom_limits === 'object') {
      // Validar y aplicar límites personalizados
      const customLimits = {};
      
      if (custom_limits.maxVideos !== undefined) {
        const val = parseInt(custom_limits.maxVideos, 10);
        if (val >= -1 && val <= 100000) customLimits.maxVideos = val;
      }
      
      if (custom_limits.maxStorageGB !== undefined) {
        const val = parseInt(custom_limits.maxStorageGB, 10);
        if (val >= 0 && val <= 100000) customLimits.maxStorageGB = val;
      }
      
      if (custom_limits.maxBandwidthGB !== undefined) {
        const val = parseInt(custom_limits.maxBandwidthGB, 10);
        if (val >= 0 && val <= 100000) customLimits.maxBandwidthGB = val;
      }

      if (Object.keys(customLimits).length > 0) {
        updates.push('custom_limits = ?');
        values.push(JSON.stringify(customLimits));
        
        // Aplicar los límites personalizados a las columnas correspondientes
        if (customLimits.maxVideos !== undefined) {
          updates.push('max_videos = ?');
          values.push(customLimits.maxVideos);
        }
        if (customLimits.maxStorageGB !== undefined) {
          updates.push('max_storage_bytes = ?');
          values.push(customLimits.maxStorageGB * 1e9);
        }
        if (customLimits.maxBandwidthGB !== undefined) {
          updates.push('max_bandwidth_bytes = ?');
          values.push(customLimits.maxBandwidthGB * 1e9);
        }
      }
    }
  }

  if (suspended !== undefined) { updates.push('suspended = ?'); values.push(suspended ? 1 : 0); }
  if (name !== undefined)      { updates.push('name = ?');      values.push(name); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push('updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT');
  values.push(req.params.id);

  try {
    await db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    cache.invalidate(`sv:ws:${req.params.id}`).catch(() => {});
    // F3.4: Audit log
    const action = plan !== undefined ? 'workspace.plan_changed'
                  : custom_limits !== undefined ? 'workspace.custom_limits_changed'
                  : (suspended !== undefined ? 'workspace.suspended' : 'workspace.updated');
    logAudit(req, action, 'workspace', req.params.id, { plan, suspended, name, custom_limits }).catch(() => {});
    res.json({ ok: true, plan, custom_limits, limits: plan && config.plans[plan] ? {
      maxVideos:      config.plans[plan].maxVideos,
      maxStorageGB:   config.plans[plan].maxStorageGB,
      maxBandwidthGB: config.plans[plan].maxBandwidthGB,
    } : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/workspaces/:id/custom-limits — obtener límites personalizados
router.get('/workspaces/:id/custom-limits', superAdminAuth, async (req, res) => {
  try {
    const ws = await db.prepare(
      'SELECT custom_limits, plan, max_videos, max_storage_bytes, max_bandwidth_bytes FROM workspaces WHERE id = ?'
    ).get(req.params.id);
    
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' });
    
    // Parsear custom_limits si existe
    let customLimits = null;
    try {
      if (ws.custom_limits) customLimits = JSON.parse(ws.custom_limits);
    } catch {}
    
    // Si hay límites personalizados, devolverlos
    if (customLimits) {
      return res.json(customLimits);
    }
    
    // Si no hay límites personalizados, devolver los del plan actual
    return res.json({
      max_videos: ws.max_videos,
      max_storage_gb: ws.max_storage_bytes ? Math.round(ws.max_storage_bytes / 1024 / 1024 / 1024) : null,
      max_bandwidth_gb: ws.max_bandwidth_bytes ? Math.round(ws.max_bandwidth_bytes / 1024 / 1024 / 1024) : null,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'Get custom limits error');
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/workspaces/:id/custom-limits — establecer límites personalizados
router.put('/workspaces/:id/custom-limits', superAdminAuth, async (req, res) => {
  try {
    const { max_videos, max_storage_gb, max_bandwidth_gb, max_filesize_mb, max_members } = req.body;
    
    const customLimits = {};
    const clampInt = (v, min, max) => Math.min(max, Math.max(min, parseInt(v) || 0));
    if (max_videos !== undefined)      customLimits.max_videos      = clampInt(max_videos, 0, 1_000_000);
    if (max_storage_gb !== undefined)  customLimits.max_storage_gb  = clampInt(max_storage_gb, 0, 1_000_000);
    if (max_bandwidth_gb !== undefined) customLimits.max_bandwidth_gb = clampInt(max_bandwidth_gb, 0, 1_000_000);
    if (max_filesize_mb !== undefined) customLimits.max_filesize_mb = clampInt(max_filesize_mb, 1, 1_000_000);
    if (max_members !== undefined)     customLimits.max_members     = clampInt(max_members, 1, 100_000);
    
    const updates = ['custom_limits = ?'];
    const values = [JSON.stringify(customLimits)];
    
    // Aplicar límites a las columnas correspondientes
    if (customLimits.max_videos !== undefined) {
      updates.push('max_videos = ?');
      values.push(customLimits.max_videos);
    }
    if (customLimits.max_storage_gb !== undefined) {
      updates.push('max_storage_bytes = ?');
      values.push(customLimits.max_storage_gb * 1024 * 1024 * 1024);
    }
    if (customLimits.max_bandwidth_gb !== undefined) {
      updates.push('max_bandwidth_bytes = ?');
      values.push(customLimits.max_bandwidth_gb * 1024 * 1024 * 1024);
    }
    
    updates.push('updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT');
    values.push(req.params.id);
    
    await db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    cache.invalidate(`sv:ws:${req.params.id}`).catch(() => {});
    logAudit(req, 'workspace.custom_limits_set', 'workspace', req.params.id, customLimits).catch(() => {});

    res.json({ ok: true, custom_limits: customLimits });
  } catch (e) {
    logger.error({ err: e.message }, 'Set custom limits error');
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/workspaces/:id/custom-limits — eliminar límites personalizados
router.delete('/workspaces/:id/custom-limits', superAdminAuth, async (req, res) => {
  try {
    // Obtener el plan actual para restaurar los límites
    const ws = await db.prepare('SELECT id, plan FROM workspaces WHERE id = ?').get(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' });
    
    const planConfig = config.plans[ws.plan];
    if (!planConfig) return res.status(400).json({ error: 'Plan no configurado' });
    
    await db.prepare(`
      UPDATE workspaces 
      SET custom_limits = NULL,
          max_videos = ?,
          max_storage_bytes = ?,
          max_bandwidth_bytes = ?,
          updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ?
    `).run(
      planConfig.maxVideos,
      planConfig.maxStorageGB * 1024 * 1024 * 1024,
      planConfig.maxBandwidthGB * 1024 * 1024 * 1024,
      req.params.id
    );
    cache.invalidate(`sv:ws:${req.params.id}`).catch(() => {});
    logAudit(req, 'workspace.custom_limits_removed', 'workspace', req.params.id, { plan: ws.plan }).catch(() => {});
    
    res.json({ ok: true, restored_to_plan: ws.plan });
  } catch (e) {
    logger.error({ err: e.message }, 'Remove custom limits error');
    res.status(500).json({ error: e.message });
  }
});

router.delete('/workspaces/:id', superAdminAuth, async (req, res) => {
  try {
    const workspaceId = req.params.id;

    // ── Step 1: Collect all video records before deleting from DB ────────────
    // We need s3_object_prefix and video id BEFORE the DB rows are gone.
    const videos = await db.prepare(
      `SELECT id, s3_object_prefix FROM videos WHERE workspace_id = ?`
    ).all(workspaceId);

    // ── Step 2: Delete DB records atomically, then clean up files ───────────
    const wsClient = await db.pool.connect();
    try {
      await wsClient.query('BEGIN');
      await wsClient.query('DELETE FROM workspace_members    WHERE workspace_id = $1', [workspaceId]);
      await wsClient.query('DELETE FROM workspace_invitations WHERE workspace_id = $1', [workspaceId]);
      await wsClient.query('DELETE FROM videos               WHERE workspace_id = $1', [workspaceId]);
      await wsClient.query('DELETE FROM workspaces           WHERE id = $1',           [workspaceId]);
      await wsClient.query('COMMIT');
    } catch (txErr) {
      await wsClient.query('ROLLBACK');
      throw txErr;
    } finally {
      wsClient.release();
    }
    cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

    // ── Step 3: Clean up physical files after DB commit (fire-and-forget) ───
    const cleanupResults = await Promise.allSettled(
      videos.map(async (v) => {
        if (s3svc.isS3Enabled() && v.s3_object_prefix) {
          await s3svc.deleteObjectsWithPrefix(v.s3_object_prefix);
        }
        const localDir = path.join(__dirname, '..', 'videos', v.id);
        try { fs.rmSync(localDir, { recursive: true, force: true }); } catch {}
      })
    );

    const failed = cleanupResults.filter(r => r.status === 'rejected');
    if (failed.length) {
      logger.warn({ workspaceId, errors: failed.map(r => r.reason?.message) },
        `${failed.length} file cleanup error(s) during workspace deletion`);
    }

    res.json({
      ok: true,
      videosDeleted: videos.length,
      cleanupErrors: failed.length,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'DELETE workspace error');
    res.status(500).json({ error: e.message });
  }
});

router.get('/users', superAdminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const offset = (page - 1) * limit;
    const users = await db.prepare(`
      SELECT id, email, name, email_verified, created_at,
        COALESCE(platform_role, 'user') as platform_role,
        referral_code, two_factor_enabled,
        (SELECT COUNT(*) FROM workspace_members WHERE user_id = users.id) as workspace_count,
        (SELECT COUNT(*) FROM workspaces WHERE owner_id = users.id) as owned_workspaces
      FROM users
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const countRow = await db.prepare(`SELECT COUNT(*) as cnt FROM users`).get();
    res.json({ users, total: Number(countRow?.cnt || 0), page, limit });
  } catch (err) {
    logger.error({ err }, 'Admin list users error');
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.put('/users/:id', superAdminAuth, async (req, res) => {
  const { email_verified, name } = req.body;
  const updates = [], values = [];
  if (email_verified !== undefined) { updates.push('email_verified = ?'); values.push(email_verified ? 1 : 0); }
  if (name !== undefined)           { updates.push('name = ?');           values.push(name); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.params.id);
  try {
    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/users/:id/role — cambiar rol de un usuario
router.put('/users/:id/role', superAdminAuth, async (req, res) => {
  const { role, reason } = req.body;
  const VALID_ROLES = ['user', 'admin', 'super_admin'];

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Rol inválido. Valores permitidos: ${VALID_ROLES.join(', ')}` });
  }

  try {
    // Obtener usuario actual para validaciones y audit
    const targetUser = await db.prepare(`SELECT id, email, name, platform_role FROM users WHERE id = ?`).get(req.params.id);
    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado' });

    // No permitir cambiar el rol del mismo admin que ejecuta la acción
    // (req.user viene del superAdminAuth middleware)
    const adminUser = await db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(req.user?.id);
    if (targetUser.id === adminUser?.id && role !== 'super_admin') {
      return res.status(400).json({ error: 'No puedes cambiar tu propio rol a uno inferior' });
    }

    const previousRole = targetUser.platform_role;
    await db.prepare(`UPDATE users SET platform_role = ? WHERE id = ?`).run(role, req.params.id);

    // Audit log detallado
    await logAudit(req, 'admin.role_changed', 'user', req.params.id, {
      email: targetUser.email,
      previousRole,
      newRole: role,
      reason: reason || 'Sin razón especificada',
      changedBy: adminUser?.email || 'admin',
    });

    logger.info({
      event: 'admin_role_change',
      targetUserId: req.params.id,
      targetEmail: targetUser.email,
      previousRole,
      newRole: role,
      adminId: req.user?.id,
      reason,
    });

    res.json({
      ok: true,
      userId: req.params.id,
      email: targetUser.email,
      previousRole,
      newRole: role,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'Role change error');
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id/2fa', superAdminAuth, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.prepare(
      `UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL, two_factor_backup_codes = NULL WHERE id = ?`
    ).run(req.params.id);
    // Also clear any active lockout
    try { await require('../services/twoFactorLockout').adminUnlock(req.params.id); } catch {}
    logAudit(req, 'admin.2fa_reset', 'user', req.params.id, { targetEmail: user.email }).catch(() => {});
    logger.info({ event: 'admin_2fa_reset', targetUserId: req.params.id, targetEmail: user.email, adminId: req.user?.id });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'Admin 2FA reset error');
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', superAdminAuth, async (req, res) => {
  try {
    const targetUser = await db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Prevent admins from deleting themselves
    if (req.user?.id === req.params.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Collect all owned workspaces and their videos BEFORE touching the DB
    const ownedWorkspaces = await db.prepare('SELECT id FROM workspaces WHERE owner_id = ?').all(req.params.id);
    const workspaceVideos = [];
    for (const ws of ownedWorkspaces) {
      const videos = await db.prepare('SELECT id, s3_object_prefix FROM videos WHERE workspace_id = ?').all(ws.id);
      workspaceVideos.push(...videos);
    }

    // Delete all DB records atomically before touching the filesystem
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const ws of ownedWorkspaces) {
        await client.query('DELETE FROM workspace_members    WHERE workspace_id = $1', [ws.id]);
        await client.query('DELETE FROM workspace_invitations WHERE workspace_id = $1', [ws.id]);
        await client.query('DELETE FROM videos               WHERE workspace_id = $1', [ws.id]);
        await client.query('DELETE FROM workspaces           WHERE id = $1',           [ws.id]);
      }
      await client.query('DELETE FROM workspace_members WHERE user_id = $1', [req.params.id]);
      await client.query('DELETE FROM users             WHERE id = $1',       [req.params.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Clean up physical files after the DB transaction committed (fire-and-forget)
    const cdnPaths = [];
    for (const v of workspaceVideos) {
      if (s3svc.isS3Enabled() && v.s3_object_prefix) {
        s3svc.deleteObjectsWithPrefix(v.s3_object_prefix).catch(() => {});
        cdnPaths.push(`/${v.s3_object_prefix}/*`);
      }
      try { fs.rmSync(path.join(__dirname, '..', 'videos', v.id), { recursive: true, force: true }); } catch {}
    }
    if (cdnPaths.length) s3svc.invalidateCDN(cdnPaths).catch(() => {});

    logAudit(req, 'admin.user_deleted', 'user', req.params.id, { email: targetUser.email }).catch(() => {});
    logger.warn({ event: 'admin_user_deleted', targetUserId: req.params.id, targetEmail: targetUser.email, adminId: req.user?.id });

    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'Admin delete user error');
    res.status(500).json({ error: e.message });
  }
});

router.post('/impersonate/:id', superAdminAuth, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // jti is required — isTokenRevoked() blocks tokens without it (fail-closed)
    const jti = uuidv4();
    const accessToken = jwt.sign({ userId: user.id, jti }, config.jwtSecret, { expiresIn: config.jwtAccessExpiry || '15m' });
    const refreshToken = jwt.sign({ userId: user.id, type: 'refresh' }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiry || '7d' });

    const tokenId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
    await db.prepare(`INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`)
      .run(tokenId, user.id, refreshToken, expiresAt);

    logAudit(req, 'admin.impersonate', 'user', user.id, { email: user.email }).catch(() => {});
    res.json({ accessToken, refreshToken });
  } catch(e) {
    logger.error({ err: e.message }, 'Impersonate error');
    res.status(500).json({ error: e.message });
  }
});

router.get('/videos', superAdminAuth, async (req, res) => {
  try {
    const videos = await db.prepare(`
      SELECT v.id, v.title, v.status, v.views, v.size as file_size, v.created_at,
             v.qualities, v.short_code, v.visibility, v.dmca_suspended, v.dmca_reason,
             v.workspace_id,
             w.name as workspace_name, u.email as owner_email
      FROM videos v
      LEFT JOIN workspaces w ON v.workspace_id = w.id
      LEFT JOIN users u ON w.owner_id = u.id
      ORDER BY v.created_at DESC
      LIMIT 200
    `).all();
    res.json(videos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/videos/:id — editar título, visibilidad, contraseña, suspensión DMCA
router.put('/videos/:id', superAdminAuth, async (req, res) => {
  const { title, visibility, password, dmca_suspended, dmca_reason } = req.body;
  const updates = [], values = [];

  if (title !== undefined)          { updates.push('title = ?');           values.push(title); }
  const VALID_VIS = ['public', 'private', 'unlisted', 'password'];
  if (visibility !== undefined) {
    if (!VALID_VIS.includes(visibility)) return res.status(400).json({ error: `visibility must be one of: ${VALID_VIS.join(', ')}` });
    updates.push('visibility = ?');
    values.push(visibility);
  }
  if (visibility === 'password' && password) {
    // Hash the password before storing
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(password, 10);
    updates.push('access_password_hash = ?');
    values.push(hashed);
  } else if (visibility !== undefined && visibility !== 'password') {
    // Clear password when switching away from password visibility
    updates.push('access_password_hash = ?');
    values.push(null);
  }

  // DMCA suspension
  if (dmca_suspended !== undefined) {
    updates.push('dmca_suspended = ?');
    values.push(dmca_suspended ? true : false);
    
    if (dmca_suspended) {
      // Suspending video - record timestamp and admin who suspended it
      updates.push('dmca_suspended_at = ?');
      values.push(Math.floor(Date.now() / 1000));
      updates.push('dmca_suspended_by = ?');
      values.push(req.user?.id || 'admin');
    } else {
      // Reinstating video - clear DMCA fields
      updates.push('dmca_suspended_at = ?');
      values.push(null);
      updates.push('dmca_suspended_by = ?');
      values.push(null);
    }
  }

  if (dmca_reason !== undefined) {
    updates.push('dmca_reason = ?');
    values.push(dmca_reason || null);
  }

  // Add updated_at timestamp
  updates.push('updated_at = ?');
  values.push(Math.floor(Date.now() / 1000));
  
  // Add video ID for WHERE clause
  values.push(req.params.id);

  try {
    const result = await db.prepare(
      `UPDATE videos SET ${updates.join(', ')} WHERE id = ?`
    ).run(...values);

    if (result.changes === 0) return res.status(404).json({ error: 'Video not found' });

    // Different audit action for DMCA vs regular update
    const action = dmca_suspended !== undefined
      ? (dmca_suspended ? 'video.dmca_suspended' : 'video.dmca_reinstated')
      : 'video.updated';

    logAudit(req, action, 'video', req.params.id, {
      title, visibility, dmca_suspended, dmca_reason
    }).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bulk operations — MUST be before /:id to avoid Express matching 'bulk' as an id ──

// DELETE /api/admin/videos/bulk — Eliminar múltiples videos
router.delete('/videos/bulk', superAdminAuth, async (req, res) => {
  const { video_ids } = req.body;

  if (!Array.isArray(video_ids) || video_ids.length === 0) {
    return res.status(400).json({ error: 'video_ids array required' });
  }

  if (video_ids.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 videos per bulk operation' });
  }

  let deleted = 0;
  const errors = [];

  for (const id of video_ids) {
    try {
      const video = await db.prepare(
        'SELECT id, s3_object_prefix, size, workspace_id, title FROM videos WHERE id = ?'
      ).get(id);
      
      if (!video) { errors.push({ id, error: 'Video not found' }); continue; }

      if (s3svc.isS3Enabled() && video.s3_object_prefix) {
        try { await s3svc.deleteObjectsWithPrefix(video.s3_object_prefix); } catch (e) {
          logger.warn({ videoId: id, err: e.message }, 'S3 cleanup failed in bulk delete');
        }
      }

      const localDir = path.join(__dirname, '..', 'videos', id);
      try { fs.rmSync(localDir, { recursive: true, force: true }); } catch {}

      await db.prepare('DELETE FROM videos WHERE id = ?').run(id);

      if (video.workspace_id && video.size) {
        await db.prepare(
          'UPDATE workspaces SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?) WHERE id = ?'
        ).run(video.size, video.workspace_id).catch(() => {});
      }

      deleted++;
      logAudit(req, 'video.bulk_deleted', 'video', id, { title: video.title }).catch(() => {});
    } catch (err) {
      logger.warn({ err: err.message, videoId: id }, 'Bulk delete failed for video');
      errors.push({ id, error: err.message });
    }
  }

  res.json({ deleted, requested: video_ids.length, errors: errors.length > 0 ? errors : undefined });
});

// PATCH /api/admin/videos/bulk/visibility
router.patch('/videos/bulk/visibility', superAdminAuth, async (req, res) => {
  const { video_ids, visibility, password } = req.body;

  if (!Array.isArray(video_ids) || video_ids.length === 0) {
    return res.status(400).json({ error: 'video_ids array required' });
  }

  const validVisibility = ['public', 'private', 'unlisted', 'password'];
  if (!validVisibility.includes(visibility)) {
    return res.status(400).json({ error: `visibility must be one of: ${validVisibility.join(', ')}` });
  }

  if (video_ids.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 videos per bulk operation' });
  }

  // Pre-hash password once if needed
  let passwordHash = null;
  if (visibility === 'password' && password) {
    const bcrypt = require('bcryptjs');
    passwordHash = await bcrypt.hash(password, 10);
  }

  let updated = 0;
  const errors = [];

  for (const id of video_ids) {
    try {
      let result;
      if (visibility === 'password' && passwordHash) {
        result = await db.prepare(
          'UPDATE videos SET visibility = ?, access_password_hash = ?, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?'
        ).run(visibility, passwordHash, id);
      } else {
        result = await db.prepare(
          'UPDATE videos SET visibility = ?, access_password_hash = NULL, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?'
        ).run(visibility, id);
      }
      if (result.changes > 0) {
        updated++;
        logAudit(req, 'video.bulk_visibility_changed', 'video', id, { new_visibility: visibility }).catch(() => {});
      } else {
        errors.push({ id, error: 'Video not found' });
      }
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }

  res.json({ updated, requested: video_ids.length, errors: errors.length > 0 ? errors : undefined });
});

// DELETE /api/admin/videos/:id — single video delete
router.delete('/videos/:id', superAdminAuth, async (req, res) => {
  try {
    // Fetch video record BEFORE deleting so we have the S3 prefix and local path
    const video = await db.prepare(
      `SELECT id, s3_object_prefix, size, workspace_id FROM videos WHERE id = ?`
    ).get(req.params.id);

    if (!video) return res.status(404).json({ error: 'Video not found' });

    // ── Clean up physical files (S3 + local disk) ─────────────────────────
    if (s3svc.isS3Enabled() && video.s3_object_prefix) {
      try { await s3svc.deleteObjectsWithPrefix(video.s3_object_prefix); } catch (e) {
        logger.warn({ videoId: video.id, err: e.message }, 'S3 cleanup failed during video delete');
      }
    }
    const localDir = path.join(__dirname, '..', 'videos', video.id);
    try { fs.rmSync(localDir, { recursive: true, force: true }); } catch {}

    // ── Update workspace storage counter ──────────────────────────────────
    if (video.workspace_id && video.size) {
      await db.prepare(
        `UPDATE workspaces SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?) WHERE id = ?`
      ).run(video.size, video.workspace_id).catch(() => {});
    }

    await db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/config', superAdminAuth, async (req, res) => {
  try {
  const dynCfg = require('../services/dynamicConfig');
  const cfg = {
    platform: await dynCfg.getDynSection('platform', {
      siteName: 'StreamVault',
      supportEmail: '',
      appUrl: process.env.APP_URL || 'http://localhost:3000',
      allowRegistration: true,
      requireEmailVerification: false,
      analyticsRetentionDays: 90,
    }),
    plans: await dynCfg.getDynSection('plans', {
      starter: { maxVideos: 25,  maxStorageGB: 50,   maxBandwidthGB: 100,  label: 'Starter' },
      pro:     { maxVideos: 200, maxStorageGB: 500,  maxBandwidthGB: 1000, label: 'Pro' },
      enterprise: { maxVideos: -1, maxStorageGB: 2000, maxBandwidthGB: 5000, label: 'Enterprise' },
    }),
    transcoding: await dynCfg.getDynSection('transcoding', {
      qualities: ['360p', '480p', '720p', '1080p'],
      defaultQuality: '720p',
      maxConcurrent: parseInt(process.env.WORKER_CONCURRENCY || '2'),
    }),
    security: {
      ...await dynCfg.getDynSection('security', {
        jwtExpiryHours: 24,
        refreshExpiryDays: 30,
        bcryptRounds: 12,
        maxLoginAttempts: 10,
      }),
      requireVideoTokens: process.env.REQUIRE_VIDEO_TOKENS === 'true',
    },
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.AWS_REGION || '',
      keyPrefix: config.s3KeyPrefix,
      cdnBaseUrl: process.env.CLOUDFRONT_BASE_URL || '',
    },
    smtp: {
      host: process.env.SMTP_HOST || '',
      user: process.env.SMTP_USER || '',
      from: process.env.SMTP_FROM || '',
    },
    bedrock: {
      modelId: config.bedrockModelId,
    },
    features: await dynCfg.getDynSection('features', {
      foldersEnabled: true,
      playlistsEnabled: true,
      webhooksEnabled: true,
      transcriptionsEnabled: true,
      downloadLinksEnabled: true,
      watermarkEnabled: true,
      analyticsEnabled: true,
    }),
    referrals: await dynCfg.getDynSection('referrals', {
      enabled: true,
      creditUSD: 10,
      maxCreditsPerUser: 0,
      minPlanToRedeem: 'pro',
      publicPageUrl: '',
    }),
  };
  res.json(cfg);
  } catch (e) {
    logger.error({ err: e.message }, 'Admin get config error');
    res.status(500).json({ error: e.message });
  }
});

router.put('/config', superAdminAuth, async (req, res) => {
  const { section, data } = req.body;
  const allowed = ['platform', 'plans', 'transcoding', 'security', 'features', 'guest_config', 'referrals', 'platformAds'];
  if (!allowed.includes(section)) return res.status(400).json({ error: 'Invalid section' });
  try {
    const dynCfg = require('../services/dynamicConfig');
    // Platform section merges to avoid callers clobbering fields they don't own
    if (section === 'platform') {
      const current = await dynCfg.getDynSection('platform', {});
      await dynCfg.setDynConfig(section, { ...current, ...data });
    } else {
      await dynCfg.setDynConfig(section, data);
    }

    // ── Sync plans.starter / plans.pro / plans.enterprise ─────────────────────
    // checkFeature.js reads `plans.<planName>` (individual keys) while the admin
    // UI saves to the aggregate `plans` key. Keep both in sync so feature checks
    // always see the latest admin configuration.
    //
    // Also normalises feature keys: the admin UI uses short names (folders, webhooks)
    // while checkFeature uses canonical Enabled names (foldersEnabled, webhooksEnabled).
    // Both formats are stored so checkFeature's legacy-fallback lookup works too.
    if (section === 'plans') {
      const { FEATURE_NAME_MAP } = require('../middleware/checkFeature');
      for (const planName of ['starter', 'pro', 'enterprise']) {
        const planData = data[planName];
        if (!planData) continue;
        // Normalise feature keys: ensure both short and Enabled variants are present
        const rawFeatures = planData.features || {};
        const normalised = {};
        for (const [key, val] of Object.entries(rawFeatures)) {
          normalised[key] = val; // keep original (short OR long)
          // If this is a short key that has a canonical mapping, also add the Enabled version
          const canonical = FEATURE_NAME_MAP[key];
          if (canonical && canonical !== key) normalised[canonical] = val;
          // If this is already a canonical key (ends with Enabled), also add the short version
          const shortKey = Object.keys(FEATURE_NAME_MAP).find(k => FEATURE_NAME_MAP[k] === key);
          if (shortKey && shortKey !== key) normalised[shortKey] = val;
        }
        await dynCfg.setDynConfig(`plans.${planName}`, { ...planData, features: normalised });

        // ── Propagate new limits to existing workspaces on this plan ──────────
        // Workspaces store max_videos / max_storage_bytes / max_bandwidth_bytes
        // on their own row. Updating the plan template doesn't update them
        // automatically — we do it here, skipping those with admin custom limits.
        const GB = 1_000_000_000; // 1e9 — same as individual workspace update
        const maxVid = (planData.maxVideos    != null && planData.maxVideos    >= 0) ? planData.maxVideos    : 0;
        const maxSto = (planData.maxStorageGB != null && planData.maxStorageGB >= 0) ? Math.round(planData.maxStorageGB   * GB) : 0;
        const maxBw  = (planData.maxBandwidthGB != null && planData.maxBandwidthGB >= 0) ? Math.round(planData.maxBandwidthGB * GB) : 0;
        await db.prepare(`
          UPDATE workspaces
          SET max_videos = ?, max_storage_bytes = ?, max_bandwidth_bytes = ?,
              updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
          WHERE plan = ?
            AND (custom_limits IS NULL
                 OR TRIM(custom_limits::TEXT) IN ('{}','null',''))
        `).run(maxVid, maxSto, maxBw, planName);
      }
    }

    logger.info({ section }, 'Admin config updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public settings endpoint — used by dashboard/frontend to get platform settings
// No auth required — only returns non-sensitive data
router.get('/public-settings', async (req, res) => {
  try {
    const dynCfg = require('../services/dynamicConfig');
    const platform = await dynCfg.getDynSection('platform', { siteName: 'StreamVault', allowRegistration: true });
    const features = await dynCfg.getDynSection('features', {
      foldersEnabled: true,
      playlistsEnabled: true,
      webhooksEnabled: true,
      transcriptionsEnabled: true,
      downloadLinksEnabled: true,
      watermarkEnabled: true,
      analyticsEnabled: true,
    });
    res.json({
      siteName: platform.siteName || 'StreamVault',
      supportEmail: platform.supportEmail || '',
      allowRegistration: platform.allowRegistration !== false,
      features,
    });
  } catch {
    res.json({ siteName: 'StreamVault', supportEmail: '', allowRegistration: true, features: {} });
  }
});

router.get('/activity', superAdminAuth, async (req, res) => {
  try {
    const recentUsers = await db.prepare(`
      SELECT 'user_registered' as type, name as label, email as sublabel, created_at as ts
      FROM users ORDER BY created_at DESC LIMIT 5
    `).all();
    const recentVideos = await db.prepare(`
      SELECT 'video_uploaded' as type, v.title as label, w.name as sublabel, v.created_at as ts
      FROM videos v JOIN workspaces w ON v.workspace_id = w.id
      ORDER BY v.created_at DESC LIMIT 5
    `).all();
    const activity = [...recentUsers, ...recentVideos]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 10);
    res.json(activity);
  } catch (e) {
    res.json([]);
  }
});

// ─── Queue management ─────────────────────────────────────────

router.get('/queue', superAdminAuth, async (req, res) => {
  try {
    const [stats, failedJobs] = await Promise.all([getQueueStats(), getFailedJobs(20)]);
    res.json({
      ...stats,
      failed_jobs: failedJobs,
      workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '2'),
      transcriptionConcurrency: parseInt(process.env.TRANSCRIPTION_CONCURRENCY || '4'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/queue/retry/:jobId', superAdminAuth, async (req, res) => {
  try {
    await retryJob(req.params.jobId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/queue/clean', superAdminAuth, async (req, res) => {
  try {
    await cleanQueue(0);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/growth', superAdminAuth, async (req, res) => {
  try {
    const days = 14;
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = Math.floor(Date.now() / 1000) - i * 86400;
      const dayEnd   = dayStart + 86400;
      const users  = await db.prepare(`SELECT COUNT(*) as c FROM users  WHERE created_at >= ? AND created_at < ?`).get(dayStart, dayEnd);
      const videos = await db.prepare(`SELECT COUNT(*) as c FROM videos WHERE created_at >= ? AND created_at < ?`).get(dayStart, dayEnd);
      const date = new Date(dayStart * 1000);
      result.push({
        date: `${date.getMonth()+1}/${date.getDate()}`,
        users:  Number(users?.c)  || 0,
        videos: Number(videos?.c) || 0,
      });
    }
    res.json(result);
  } catch (e) {
    res.json([]);
  }
});

// ─── Admin email send ──────────────────────────────────────────
router.post('/email', superAdminAuth, async (req, res) => {
  const { userId, subject, message } = req.body;
  if (!userId || !subject || !message) {
    return res.status(400).json({ error: 'userId, subject, and message are required' });
  }
  try {
    const user = await db.prepare(`SELECT id, email, name FROM users WHERE id = ?`).get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const emailService = require('../services/email');
    // Use sendWelcome-style plain email — works even if template missing
    if (typeof emailService.sendCustomEmail === 'function') {
      await emailService.sendCustomEmail(user.email, subject, message);
    } else {
      // Fallback: use the underlying sendMail helper if available
      const nodemailer = require('nodemailer');
      const smtpOpts = {
        host: process.env.SMTP_HOST || 'localhost',
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: process.env.SMTP_USER ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        } : undefined,
      };
      const transporter = nodemailer.createTransport(smtpOpts);
      const _plat = await require('../services/dynamicConfig').getDynSection('platform', {}).catch(() => ({}));
      const _sn = _plat.siteName || 'StreamVault';
      await transporter.sendMail({
        from: config.smtp.from,
        to: user.email,
        subject,
        text: message,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#7c6cfa;">${_sn}</h2>
          <p style="white-space:pre-wrap;color:#333;line-height:1.6;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#999;font-size:12px;">Este mensaje fue enviado por el equipo de ${_sn}.</p>
        </div>`,
      });
    }

    logAudit(req, 'admin.email_sent', 'user', userId, { email: user.email, subject }).catch(() => {});
    logger.info({ adminUserId: req.user?.id, targetEmail: user.email, subject }, 'Admin email sent');
    res.json({ ok: true, to: user.email });
  } catch (e) {
    logger.error({ err: e.message }, 'Admin email send failed');
    res.status(500).json({ error: `Failed to send email: ${e.message}` });
  }
});

// F3.4: Audit log — paginated list
router.get('/audit-log', superAdminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;
    const actorFilter = req.query.actor || null;
    const actionFilter = req.query.action || null;

    const escapeLike = s => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    let where = [];
    let params = [];
    if (actorFilter) { where.push("actor_email ILIKE ? ESCAPE '\\'"); params.push('%' + escapeLike(actorFilter) + '%'); }
    if (actionFilter) { where.push("action ILIKE ? ESCAPE '\\'"); params.push('%' + escapeLike(actionFilter) + '%'); }

    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const logs = await db.prepare(
      `SELECT * FROM audit_log ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const countRow = await db.prepare(
      `SELECT COUNT(*) as c FROM audit_log ${whereStr}`
    ).get(...params);

    res.json({
      logs,
      pagination: {
        page, limit,
        total: Number(countRow?.c) || 0,
        pages: Math.ceil((Number(countRow?.c) || 0) / limit),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SSE Metrics Stream ───────────────────────────────────────────────────────

// In-memory store for short-lived SSE tokens (cleared on expiry or process restart)
const _sseTokens = new Map();
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of _sseTokens) {
    if (v.expires < now) _sseTokens.delete(k);
  }
}, 30_000);

// POST /api/admin/metrics/sse-token — emite un token SSE de vida corta (2 min, solo para /metrics/stream)
// EventSource no soporta headers, por eso usamos query param — pero con un token de vida muy corta
// específico para SSE, no el JWT de sesión completo.
router.post('/metrics/sse-token', superAdminAuth, (req, res) => {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + 120; // 2 minutos
  _sseTokens.set(token, { userId: req.user.id, expires });
  res.json({ token, expiresIn: 120 });
});

// GET /api/admin/metrics/stream — Server-Sent Events para métricas en tiempo real.
// Autenticación: requiere un SSE token de corta duración obtenido de POST /metrics/sse-token.
// No se acepta el JWT de sesión como query param — protege contra CSRF y fuga de tokens en logs.
router.get('/metrics/stream', async (req, res) => {
  const sseToken = req.query.token;
  if (!sseToken) return res.status(401).json({ error: 'SSE token requerido' });

  const entry = _sseTokens.get(sseToken);
  if (!entry || entry.expires < Math.floor(Date.now() / 1000)) {
    _sseTokens.delete(sseToken);
    return res.status(401).json({ error: 'SSE token inválido o expirado. Obtén uno nuevo.' });
  }
  _sseTokens.delete(sseToken); // one-time use

  const user = await db.prepare(
    `SELECT id, email, COALESCE(platform_role,'user') as platform_role FROM users WHERE id = ?`
  ).get(entry.userId);
  if (!user || user.platform_role !== 'super_admin') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  req.user = user;

  // Configurar headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Para Nginx: deshabilitar buffering
  res.flushHeaders();

  const metricsStream = require('../services/metricsStream');
  const userId = req.user?.id || 'admin';

  // Registrar conexión
  const connId = metricsStream.addConnection(res, userId);

  // Enviar evento inicial inmediatamente con datos básicos (antes del ticker)
  try {
    const systemStats = metricsStream.getSystemStats();
    res.write(`event: metrics\ndata: ${JSON.stringify({
      videos: { total: 0, ready: 0, processing: 0, error: 0, totalViews: 0, totalStorageBytes: 0, recentHour: 0 },
      users: { total: 0 },
      workspaces: { total: 0 },
      queue: { waiting: 0, active: 0, failed: 0, completed: 0, mode: 'fallback' },
      system: systemStats
    })}\n\n`);
    logger.debug({ event: 'initial_metrics_sent', connId, userId });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to send initial metrics');
  }

  // Recolectar y enviar métricas reales después de un breve delay
  setTimeout(() => {
    metricsStream.collectAndBroadcast(db).catch((err) => {
      logger.warn({ err: err.message }, 'Failed initial collectAndBroadcast');
    });
  }, 100);

  // Heartbeat cada 30s para mantener conexión viva
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30_000);

  // Limpiar al desconectar
  req.on('close', () => {
    clearInterval(heartbeat);
    logger.debug({ event: 'sse_stream_closed', connId, userId });
  });
});

// GET /api/admin/metrics/snapshot — Snapshot puntual de métricas (sin SSE)
router.get('/metrics/snapshot', superAdminAuth, async (req, res) => {
  try {
    const metricsStream = require('../services/metricsStream');
    const db = require('../db');

    const [videoStats, userCount, wsCount] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='ready') as ready, COUNT(*) FILTER (WHERE status IN ('queued','transcoding')) as processing, COALESCE(SUM(views),0) as total_views FROM videos`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM users`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM workspaces`).get(),
    ]);

    let queueStats = { waiting: 0, active: 0, failed: 0, mode: 'fallback' };
    try { const { getQueueStats } = require('../services/queue'); queueStats = await getQueueStats(); } catch {}

    res.json({
      videos: { total: Number(videoStats?.total)||0, ready: Number(videoStats?.ready)||0, processing: Number(videoStats?.processing)||0, totalViews: Number(videoStats?.total_views)||0 },
      users: { total: Number(userCount?.c)||0 },
      workspaces: { total: Number(wsCount?.c)||0 },
      queue: queueStats,
      system: metricsStream.getSystemStats(),
      sseConnections: metricsStream.getConnectionCount(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 2FA Lockout Management ───────────────────────────────────────────────────

// GET /api/admin/2fa-lockouts — ver todos los lockouts activos
router.get('/2fa-lockouts', superAdminAuth, async (req, res) => {
  try {
    const lockoutService = require('../services/twoFactorLockout');
    const stats = await lockoutService.getStats();
    res.json(stats);
  } catch (e) {
    logger.error({ err: e.message }, '2FA lockout stats error');
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/2fa-lockouts/:userId — ver lockout de un usuario específico
router.get('/2fa-lockouts/:userId', superAdminAuth, async (req, res) => {
  try {
    const lockoutService = require('../services/twoFactorLockout');
    const status = await lockoutService.getLockoutStatus(req.params.userId);
    
    if (!status) {
      return res.json({ userId: req.params.userId, locked: false, attempts: 0, message: 'Sin lockout activo' });
    }
    
    res.json({ userId: req.params.userId, ...status });
  } catch (e) {
    logger.error({ err: e.message }, '2FA lockout status error');
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/2fa-lockouts/:userId — desbloquear usuario específico
router.delete('/2fa-lockouts/:userId', superAdminAuth, async (req, res) => {
  try {
    const lockoutService = require('../services/twoFactorLockout');
    const wasLocked = await lockoutService.adminUnlock(req.params.userId);

    logAudit(req, '2fa_lockout_cleared', 'user', req.params.userId, { wasLocked }).catch(() => {});

    logger.info({
      event: 'admin_2fa_unlock',
      targetUserId: req.params.userId,
      adminId: req.user?.id,
      wasLocked,
    });

    res.json({
      success: true,
      userId: req.params.userId,
      wasLocked,
      message: wasLocked ? 'Usuario desbloqueado correctamente' : 'El usuario no estaba bloqueado',
    });
  } catch (e) {
    logger.error({ err: e.message }, '2FA admin unlock error');
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/2fa-lockouts/ip/:ip — desbloquear IP específica (bloqueo 2FA)
router.delete('/2fa-lockouts/ip/:ip', superAdminAuth, async (req, res) => {
  try {
    const lockoutService = require('../services/twoFactorLockout');
    const wasLocked = await lockoutService.adminUnlockIp(req.params.ip);

    logAudit(req, '2fa_ip_lockout_cleared', 'ip', req.params.ip, { wasLocked }).catch(() => {});
    logger.info({ event: 'admin_2fa_ip_unlock', ip: req.params.ip, adminId: req.user?.id, wasLocked });

    res.json({
      success: true,
      ip: req.params.ip,
      wasLocked,
      message: wasLocked ? 'IP desbloqueada correctamente' : 'La IP no estaba bloqueada',
    });
  } catch (e) {
    logger.error({ err: e.message }, '2FA IP admin unlock error');
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/blocked-ips — lista todas las IPs bloqueadas (2FA + rate-limit)
router.get('/blocked-ips', superAdminAuth, async (req, res) => {
  try {
    const lockoutService = require('../services/twoFactorLockout');
    const advancedRL    = require('../middleware/advancedRateLimit');

    const [lockoutStats, rlStats] = await Promise.all([
      lockoutService.getStats(),
      advancedRL.getStats(),
    ]);

    res.json({
      twofa: lockoutStats.lockedIps || [],        // IPs bloqueadas por intentos 2FA
      rateLimit: rlStats.blacklist || [],          // IPs en blacklist por actividad sospechosa
    });
  } catch (e) {
    logger.error({ err: e.message }, 'blocked-ips fetch error');
    res.status(500).json({ error: e.message });
  }
});


/**
 * GET /api/admin/plans-config
 * Obtiene la configuración completa de todos los planes
 */
router.get('/plans-config', superAdminAuth, async (req, res) => {
  try {
    const [starter, pro, enterprise] = await Promise.all([
      getConfig('plans.starter', null),
      getConfig('plans.pro', null),
      getConfig('plans.enterprise', null)
    ]);

    res.json({ 
      success: true, 
      plans: { starter, pro, enterprise } 
    });
  } catch (e) {
    logger.error({ err: e.message }, 'Get plans config error');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/plans-config/:planName
 * Obtiene la configuración de un plan específico (starter, pro, enterprise)
 */
router.get('/plans-config/:planName', superAdminAuth, async (req, res) => {
  try {
    const { planName } = req.params;
    const validPlans = ['starter', 'pro', 'enterprise'];
    
    if (!validPlans.includes(planName)) {
      return res.status(400).json({ 
        error: `Plan inválido. Valores permitidos: ${validPlans.join(', ')}` 
      });
    }

    const planConfig = await getConfig(`plans.${planName}`, null);
    
    // Usar los mismos defaults que checkFeature.js para evitar inconsistencias
    const { PLAN_FEATURE_DEFAULTS } = require('../middleware/checkFeature');
    const defaults = {
      starter:    { features: PLAN_FEATURE_DEFAULTS.starter    || {} },
      pro:        { features: PLAN_FEATURE_DEFAULTS.pro        || {} },
      enterprise: { features: PLAN_FEATURE_DEFAULTS.enterprise || {} },
    };

    const result = planConfig || defaults[planName];

    res.json({ success: true, plan: planName, features: result?.features || {} });
  } catch (e) {
    logger.error({ err: e.message, planName: req.params.planName }, 'Get plan config error');
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/admin/plans-config/:planName
 * Actualiza la configuración de un plan específico
 * Body: { name, price, maxVideos, features: { webhooks: true, ... }, ... }
 */
router.put('/plans-config/:planName', superAdminAuth, async (req, res) => {
  try {
    const { planName } = req.params;
    const validPlans = ['starter', 'pro', 'enterprise'];
    
    if (!validPlans.includes(planName)) {
      return res.status(400).json({ 
        error: `Plan inválido. Valores permitidos: ${validPlans.join(', ')}` 
      });
    }

    const updates = req.body;
    
    // Obtener configuración actual del plan
    const currentPlan = await getConfig(`plans.${planName}`, {});
    
    // Merge de configuración
    const newPlan = {
      ...currentPlan,
      ...updates,
      // Merge especial para features para no perder keys no actualizadas
      features: {
        ...(currentPlan.features || {}),
        ...(updates.features || {})
      }
    };

    await setConfig(`plans.${planName}`, newPlan);

    logAudit(req, 'plan_config_updated', 'system_config', `plans.${planName}`, { updates, previous: currentPlan }).catch(() => {});

    logger.info({ planName, updates, admin: req.userEmail }, 'Plan configuration updated');

    res.json({ success: true, plan: newPlan });
  } catch (e) {
    logger.error({ err: e.message, planName: req.params.planName }, 'Update plan config error');
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment Gateway Configuration (Multi-Gateway Support)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payment-gateways
 * Obtiene la configuración actual de payment gateways habilitados
 */
router.get('/payment-gateways', superAdminAuth, async (req, res) => {
  try {
    const config = await getConfig('payment_gateways', {
      stripe:   { enabled: true  },
      paypal:   { enabled: false },
      binance:  { enabled: false },
      dlocalgo: { enabled: false },
    });

    res.json({ success: true, gateways: config });
  } catch (e) {
    logger.error({ err: e.message }, 'Get payment gateways config error');
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/admin/payment-gateways
 * Actualiza la configuración de gateways habilitados
 * Body: { stripe: { enabled: true }, paypal: { enabled: true }, binance: { enabled: false } }
 */
router.put('/payment-gateways', superAdminAuth, async (req, res) => {
  try {
    const { stripe, paypal, binance, dlocalgo } = req.body;

    if (!stripe && !paypal && !binance && !dlocalgo) {
      return res.status(400).json({
        error: 'Al menos un gateway debe estar habilitado'
      });
    }

    const config = {
      stripe:   stripe   || { enabled: false },
      paypal:   paypal   || { enabled: false },
      binance:  binance  || { enabled: false },
      dlocalgo: dlocalgo || { enabled: false },
    };

    await setConfig('payment_gateways', config);

    logAudit(req, 'payment_gateways_updated', 'system_config', 'payment_gateways', config).catch(() => {});

    logger.info({ config, admin: req.userEmail }, 'Payment gateways configuration updated');

    res.json({ success: true, gateways: config });
  } catch (e) {
    logger.error({ err: e.message }, 'Update payment gateways config error');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/payment-gateways/status
 * Verifica el estado y disponibilidad de cada gateway (reads from DB + env)
 */
router.get('/payment-gateways/status', superAdminAuth, async (req, res) => {
  try {
    const gwCreds = require('../services/gatewayCredentials');
    const [stripeStatus, paypalStatus, binanceStatus, dlocalgoStatus] = await Promise.all([
      gwCreds.getProviderStatus('stripe'),
      gwCreds.getProviderStatus('paypal'),
      gwCreds.getProviderStatus('binance'),
      gwCreds.getProviderStatus('dlocalgo'),
    ]);

    const status = {
      stripe: stripeStatus,
      paypal: paypalStatus,
      binance: binanceStatus,
      dlocalgo: dlocalgoStatus,
    };

    res.json({ success: true, status });
  } catch (e) {
    logger.error({ err: e.message }, 'Get payment gateways status error');
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/admin/payment-gateways/credentials
 * Guarda las credenciales de un gateway específico en la DB (cifradas).
 * Body: { provider: 'dlocalgo', credentials: { DLOCALGO_API_KEY: '...', ... } }
 * 
 * Los campos vacíos ("") se ignoran y se usa el valor de .env como fallback.
 * Efecto inmediato: no requiere reiniciar el servidor.
 */
router.put('/payment-gateways/credentials', superAdminAuth, async (req, res) => {
  try {
    const { provider, credentials } = req.body;

    if (!provider || !['stripe', 'paypal', 'binance', 'dlocalgo'].includes(provider)) {
      return res.status(400).json({ error: 'Provider inválido. Opciones: stripe, paypal, binance, dlocalgo' });
    }

    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'Se requiere un objeto "credentials" con los campos a configurar' });
    }

    const gwCreds = require('../services/gatewayCredentials');
    await gwCreds.saveCredentials(provider, credentials);

    // Re-check status after saving
    const newStatus = await gwCreds.getProviderStatus(provider);

    logAudit(req, 'gateway_credentials_updated', 'system_config', provider, {
      fieldsUpdated: Object.keys(credentials).filter(k => credentials[k]),
    }).catch(() => {});

    logger.info({ provider, admin: req.userEmail }, 'Gateway credentials updated via admin panel');

    res.json({
      success: true,
      message: `Credenciales de ${provider} guardadas correctamente. Efecto inmediato.`,
      status: newStatus,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'Save gateway credentials error');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/payment-gateways/credentials/:provider
 * Obtiene las credenciales guardadas (masked para seguridad).
 * Solo muestra si están configuradas, no revela los valores completos.
 */
router.get('/payment-gateways/credentials/:provider', superAdminAuth, async (req, res) => {
  try {
    const { provider } = req.params;
    if (!['stripe', 'paypal', 'binance', 'dlocalgo'].includes(provider)) {
      return res.status(400).json({ error: 'Provider inválido' });
    }

    const gwCreds = require('../services/gatewayCredentials');
    const creds = await gwCreds.getCredentials(provider);

    // Return masked values (show first 4 and last 4 chars only)
    const masked = {};
    for (const [key, val] of Object.entries(creds)) {
      if (val && val.length > 8) {
        masked[key] = val.slice(0, 4) + '••••' + val.slice(-4);
      } else if (val) {
        masked[key] = '••••••••';
      } else {
        masked[key] = '';
      }
    }

    res.json({ success: true, provider, credentials: masked });
  } catch (e) {
    logger.error({ err: e.message }, 'Get gateway credentials error');
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PLATFORM BRANDING CONFIG
// ══════════════════════════════════════════════════════════════════════════

// GET /api/admin/platform-config — Obtener configuración de branding de plataforma
router.get('/platform-config', superAdminAuth, async (req, res) => {
  try {
    const config = await getConfig('platform', {
      siteName: 'StreamVault',
      allowRegistration: true,
      platformLogoUrl: '/favicon.svg',
      platformLogoPos: 'tr',
      platformName: 'StreamVault'
    });
    res.json(config);
  } catch (e) {
    logger.error({ err: e.message }, 'GET platform-config error');
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/platform-config — Actualizar configuración de branding de plataforma
router.put('/platform-config', superAdminAuth, async (req, res) => {
  try {
    const { platformLogoUrl, platformLogoPos, platformName, siteName, allowRegistration } = req.body;
    
    // Obtener config actual
    const current = await getConfig('platform', {});
    
    // Merge con nuevos valores
    const updated = {
      ...current,
      ...(platformLogoUrl !== undefined && { platformLogoUrl }),
      ...(platformLogoPos !== undefined && { platformLogoPos }),
      ...(platformName !== undefined && { platformName }),
      ...(siteName !== undefined && { siteName }),
      ...(allowRegistration !== undefined && { allowRegistration })
    };
    
    // Guardar
    await setConfig('platform', updated);
    
    // Audit log
    logAudit(req, 'platform.branding_updated', 'system', 'platform', { 
      platformLogoUrl, platformLogoPos, platformName 
    }).catch(() => {});
    
    res.json({ ok: true, config: updated });
  } catch (e) {
    logger.error({ err: e.message }, 'PUT platform-config error');
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/platform-ads — Obtener config de Platform Ads (monetización plan gratuito)
router.get('/platform-ads', superAdminAuth, async (req, res) => {
  try {
    const dynCfg = require('../services/dynamicConfig');
    const cfg = await dynCfg.getDynSection('platformAds', {
      enabled: false,
      applyToPlans: ['starter'],
      ad: null,
    });
    res.json(cfg);
  } catch (e) {
    logger.error({ err: e.message }, 'GET platform-ads error');
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/platform-ads — Guardar config de Platform Ads
router.put('/platform-ads', superAdminAuth, async (req, res) => {
  try {
    const dynCfg = require('../services/dynamicConfig');
    const { enabled, applyToPlans, ad } = req.body;
    const data = {
      enabled: !!enabled,
      applyToPlans: Array.isArray(applyToPlans) ? applyToPlans : ['starter'],
      ad: ad || null,
    };
    await dynCfg.setDynConfig('platformAds', data);
    logAudit(req, 'platform_ads_updated', 'system_config', 'platformAds', data).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'PUT platform-ads error');
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/features — Obtener features globales
router.get('/features', superAdminAuth, async (req, res) => {
  try {
    const features = await getConfig('features', {});
    res.json(features);
  } catch (e) {
    logger.error({ err: e.message }, 'GET features error');
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/features — Actualizar features globales
router.put('/features', superAdminAuth, async (req, res) => {
  try {
    const current = await getConfig('features', {});
    const updated = { ...current, ...req.body };
    await setConfig('features', updated);
    
    logAudit(req, 'platform.features_updated', 'system', 'features', req.body).catch(() => {});
    
    res.json({ ok: true, features: updated });
  } catch (e) {
    logger.error({ err: e.message }, 'PUT features error');
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/referrals — Referral statistics
router.get('/referrals', superAdminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [rows, totals, topRows] = await Promise.all([
      db.prepare(`
        SELECT
          r.id,
          r.created_at,
          r.plan_at_signup,
          r.credited_at,
          u_ref.id    AS referrer_id,
          u_ref.email AS referrer_email,
          u_ref.name  AS referrer_name,
          u_ref.referral_code,
          u_inv.id    AS referred_id,
          u_inv.email AS referred_email,
          u_inv.name  AS referred_name
        FROM referrals r
        JOIN users u_ref ON u_ref.id = r.referrer_id
        JOIN users u_inv ON u_inv.id = r.referred_id
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset),
      db.prepare(`
        SELECT
          COUNT(*)                                               AS total,
          COUNT(credited_at)                                     AS credited,
          COUNT(DISTINCT referrer_id)                            AS unique_referrers,
          COUNT(CASE WHEN plan_at_signup != 'free' THEN 1 END)  AS paid_signups
        FROM referrals
      `).get(),
      db.prepare(`
        SELECT
          u.id, u.email, u.name, u.referral_code,
          COUNT(r.id)          AS total_referrals,
          COUNT(r.credited_at) AS credited_referrals
        FROM users u
        JOIN referrals r ON r.referrer_id = u.id
        GROUP BY u.id, u.email, u.name, u.referral_code
        ORDER BY total_referrals DESC
        LIMIT 10
      `).all(),
    ]);

    res.json({
      referrals: rows,
      totals: totals || { total: 0, credited: 0, unique_referrers: 0, paid_signups: 0 },
      top_referrers: topRows,
      page,
      has_more: rows.length === limit,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'GET admin/referrals error');
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/retranscode-bulk — Re-queue all ready/error videos for a workspace (or all)
// Admin use: after changing global transcoding quality settings, re-encode existing videos.
// ─── Upload asset (logo de plataforma) ───────────────────────────────────────
// Acepta PNG/SVG/JPG/WEBP hasta 2MB. Sube a S3 si está configurado,
// o guarda en /public/uploads/ como fallback.
const _multerAsset = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter(req, file, cb) {
    const allowed = ['image/png','image/jpeg','image/svg+xml','image/webp','image/gif'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Tipo de archivo no permitido. Usa PNG, JPG, SVG o WEBP.'));
  },
});
router.post('/upload-asset', superAdminAuth, _multerAsset.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
    const filename = `platform-logo-${Date.now()}${ext}`;

    // Intenta S3 primero
    if (s3svc.isS3Enabled()) {
      const { Upload } = require('@aws-sdk/lib-storage');
      const s3cfg = require('../config');
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      // Usar método interno de s3svc para subir buffer
      const keyPrefix = ['streamvault', 'platform-assets'].join('/');
      const key = `${keyPrefix}/${filename}`;
      const client = s3svc._getClient ? s3svc._getClient() : null;
      if (client) {
        const cfg = require('../config');
        const { s3Bucket, cdnBaseUrl, awsRegion } = cfg;
        await client.send(new PutObjectCommand({
          Bucket: s3Bucket,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        }));
        const cdnBase = cdnBaseUrl
          ? cdnBaseUrl.replace(/\/$/, '')
          : `https://${s3Bucket}.s3.${awsRegion}.amazonaws.com`;
        return res.json({ url: `${cdnBase}/${key}` });
      }
    }

    // Fallback: guardar en public/uploads/assets/
    const uploadsDir = path.join(__dirname, '../public/uploads/assets');
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, filename), req.file.buffer);
    const appUrl = process.env.APP_URL || '';
    return res.json({ url: `${appUrl}/uploads/assets/${filename}` });
  } catch (err) {
    logger.error({ err }, 'upload-asset failed');
    res.status(500).json({ error: err.message || 'Error al subir el archivo' });
  }
});

router.post('/retranscode-bulk', superAdminAuth, async (req, res) => {
  try {
    const { workspaceId } = req.body; // optional: limit to one workspace
    const { addTranscodeJob } = require('../services/queue');
    const s3svc = require('../services/s3Storage');
    const fs    = require('fs');

    const where = workspaceId
      ? `WHERE status IN ('ready','error','scheduled') AND workspace_id = $1`
      : `WHERE status IN ('ready','error','scheduled')`;
    const params = workspaceId ? [workspaceId] : [];

    const videos = await db.prepare(
      `SELECT id, title, source_file, workspace_id FROM videos ${where} ORDER BY created_at DESC LIMIT 200`
    ).all(...params);

    let queued = 0;
    let skipped = 0;
    const errors = [];

    for (const video of videos) {
      try {
        let inputPath = null;
        let s3SourceKey = null;
        if (video.source_file) {
          if (s3svc.isS3Enabled() && !require('path').isAbsolute(video.source_file)) {
            s3SourceKey = video.source_file;
          } else {
            inputPath = video.source_file;
          }
        }
        if (!s3SourceKey && (!inputPath || !fs.existsSync(inputPath))) {
          skipped++;
          continue;
        }
        await db.prepare(
          `UPDATE videos SET status='transcoding', transcoding_pct=0, qualities='[]', qualities_expected=NULL, updated_at=FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id=?`
        ).run(video.id);
        await addTranscodeJob({ videoId: video.id, inputPath, s3SourceKey, title: video.title, workspaceId: video.workspace_id });
        queued++;
      } catch (e) {
        errors.push({ videoId: video.id, err: e.message });
      }
    }

    logger.info({ queued, skipped, total: videos.length, workspaceId }, 'Admin bulk retranscode queued');
    res.json({ ok: true, queued, skipped, errors: errors.length, total: videos.length });
  } catch (e) {
    logger.error({ err: e.message }, 'Admin bulk retranscode error');
    res.status(500).json({ error: e.message });
  }
});

// ─── User Reports (contact messages from /status) ────────────────────────────

// GET /api/admin/reports — list contact messages stored in DB
router.get('/reports', superAdminAuth, async (req, res) => {
  try {
    const limit  = Math.min(100, parseInt(req.query.limit  || '50', 10));
    const offset = Math.max(0,   parseInt(req.query.offset || '0',  10));
    const status = req.query.status || null; // 'pending' | 'reviewed' | null = all
    const rows = await db.prepare(`
      SELECT * FROM user_reports
      ${status ? 'WHERE status = ?' : ''}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...(status ? [status, limit, offset] : [limit, offset]));
    const total = await db.prepare(`SELECT COUNT(*) AS n FROM user_reports${status ? ' WHERE status = ?' : ''}`).get(...(status ? [status] : []));
    res.json({ reports: rows, total: Number(total?.n || 0) });
  } catch (err) {
    // Table may not exist yet — return empty
    if (err.message?.includes('user_reports') || err.code === '42P01') {
      return res.json({ reports: [], total: 0 });
    }
    logger.error({ err }, 'GET /admin/reports error');
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/reports/:id — mark as reviewed / add note
router.patch('/reports/:id', superAdminAuth, async (req, res) => {
  try {
    const { status, note } = req.body;
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`
      UPDATE user_reports SET status = ?, admin_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?
    `).run(status || 'reviewed', note || null, now, now, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/reports/:id
router.delete('/reports/:id', superAdminAuth, async (req, res) => {
  try {
    await db.prepare(`DELETE FROM user_reports WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
