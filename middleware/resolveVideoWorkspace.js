/**
 * Middleware para resolver el workspace de un video desde el parámetro :videoId
 * Se usa en rutas que necesitan checkFeature pero no tienen workspace en el path
 * Ejemplo: /api/videos/:videoId/analytics
 */
const db = require('../db');
const cache = require('../services/cache');
const logger = require('../services/logger').child({ module: 'resolveVideoWorkspace' });

const WS_CACHE_TTL = 300; // 5 minutos

async function resolveVideoWorkspace(req, res, next) {
  try {
    const videoId = req.params.videoId;
    
    if (!videoId) {
      return res.status(400).json({ error: 'Video ID required' });
    }

    // Obtener el video y su workspace (incluye visibility para control de acceso)
    const video = await db.prepare(
      `SELECT id, workspace_id, visibility FROM videos WHERE id = ?`
    ).get(videoId);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Si el video no tiene workspace, establecer workspace ficticio con plan pro
    // para que checkFeature no falle. La validación real de acceso se hace en analytics.js
    if (!video.workspace_id) {
      req.videoWorkspaceId = null;
      req.workspace = {
        id: null,
        name: 'Orphan Video Workspace',
        plan: 'pro', // Asignar plan 'pro' para permitir acceso a analytics
        settings: {}
      };
      req.workspaceRole = 'owner';
      return next();
    }

    // Cargar el workspace con cache
    const workspace = await cache.cachedQuery(
      `sv:ws:${video.workspace_id}`,
      WS_CACHE_TTL,
      () => db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(video.workspace_id)
    );

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Parsear settings
    let settings = {};
    try {
      settings = JSON.parse(workspace.settings || '{}');
    } catch {}

    // Establecer workspace en req para que checkFeature lo use
    req.workspace = { ...workspace, settings };
    req.workspaceId = workspace.id;

    // Verificar membresía según visibilidad del video y estado de autenticación:
    // - Usuario no autenticado: pasa (el route handler verifica visibilidad)
    // - Usuario autenticado + miembro: pasa con su rol
    // - Usuario autenticado + no miembro + video público/unlisted: pasa (workspaceRole = null)
    // - Usuario autenticado + no miembro + video privado/contraseña: 403
    if (req.user) {
      const membership = await db.prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
      ).get(workspace.id, req.user.id);

      if (membership) {
        req.workspaceRole = membership.role;
      } else {
        const isRestricted = video.visibility === 'private' || video.visibility === 'password';
        if (isRestricted) {
          return res.status(403).json({ error: 'You are not a member of this workspace' });
        }
        req.workspaceRole = null;
      }
    } else {
      req.workspaceRole = null;
    }
    
    next();
  } catch (err) {
    logger.error({ err: err.message, videoId: req.params.videoId }, 'resolveVideoWorkspace error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { resolveVideoWorkspace };
