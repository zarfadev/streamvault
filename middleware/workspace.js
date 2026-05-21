const db = require('../db');
const cache = require('../services/cache');
const logger = require('../services/logger').child({ module: 'workspace' });

// Workspace settings are read on every authenticated request but rarely change.
// Cache for 5 minutes — invalidated on workspace PATCH.
const WS_CACHE_TTL = 300;

async function resolveWorkspace(req, res, next) {
  const workspaceId = req.headers['x-workspace-id'] || req.params.workspaceId;

  if (!workspaceId) {
    return res.status(400).json({ error: 'Workspace ID required. Send X-Workspace-Id header or use URL param.' });
  }

  try {
    const workspace = await cache.cachedQuery(
      `sv:ws:${workspaceId}`,
      WS_CACHE_TTL,
      () => db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId)
    );
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // ── Suspension check ─────────────────────────────────────────────────────
    // A suspended workspace cannot perform any write or read operations.
    // Suspension is triggered automatically by Stripe (invoice.payment_failed,
    // past_due) or manually by a super admin from the admin panel.
    if (workspace.suspended) {
      return res.status(403).json({
        error: 'This workspace has been suspended. Please update your payment method to restore access.',
        code: 'WORKSPACE_SUSPENDED',
      });
    }

    const membership = await db.prepare(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`
    ).get(workspaceId, req.user.id);

    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this workspace' });
    }

    req.workspace = {
      ...workspace,
      settings: (() => { try { return JSON.parse(workspace.settings || '{}'); } catch { return {}; } })(),
    };
    req.workspaceRole = membership.role;
    next();
  } catch (err) {
    logger.error({ err: err.message }, 'resolveWorkspace error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.workspaceRole) {
      return res.status(500).json({ error: 'Workspace not resolved. Use resolveWorkspace middleware first.' });
    }
    if (!roles.includes(req.workspaceRole)) {
      return res.status(403).json({
        error: `This action requires one of these roles: ${roles.join(', ')}. You have: ${req.workspaceRole}`,
      });
    }
    next();
  };
}

function checkLimit(type) {
  return async (req, res, next) => {
    const ws = req.workspace;
    if (!ws) return res.status(500).json({ error: 'Workspace not resolved' });

    try {
      if (type === 'video_count') {
        if (ws.max_videos > 0) {
          // Use LIMIT-based existence check — much faster than COUNT(*) on large tables
          const countRow = await db.prepare(
            `SELECT COUNT(*) as count FROM (SELECT 1 FROM videos WHERE workspace_id = ? LIMIT ?) sub`
          ).get(ws.id, ws.max_videos);
          if ((countRow?.count || 0) >= ws.max_videos) {
            return res.status(403).json({
              error: `Video limit reached (${ws.max_videos}). Upgrade your plan for more videos.`,
              code: 'LIMIT_VIDEOS',
            });
          }
        }
      }

      if (type === 'storage') {
        const maxBytes = Number(ws.max_storage_bytes) || 0;
        // -1 means unlimited; 0 means not configured — skip check in both cases
        if (maxBytes > 0) {
          // Include the incoming file size so we don't allow uploads that would exceed the limit
          const incomingBytes = Number(req.file?.size || req.headers['content-length'] || 0);
          if ((Number(ws.storage_used_bytes) + incomingBytes) > maxBytes) {
            const maxGB = (maxBytes / 1e9).toFixed(0);
            return res.status(403).json({
              error: `Storage limit reached (${maxGB} GB). Upgrade your plan for more storage.`,
              code: 'LIMIT_STORAGE',
            });
          }
        }
      }

      next();
    } catch (err) {
      logger.error({ err: err.message }, 'checkLimit error');
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

module.exports = { resolveWorkspace, requireRole, checkLimit };
