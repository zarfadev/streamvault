const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const s3 = require('../services/s3Storage');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const { checkFeature } = require('../middleware/checkFeature');
const { sendWorkspaceInvitation } = require('../services/email');
const logger    = require('../services/logger').child({ module: 'workspaces' });
const rateLimit = require('../middleware/rateLimit');
const cache     = require('../services/cache');

// Keys that must never be returned to clients — they are write-only credentials.
const REDACTED_SETTINGS_KEYS = new Set(['openaiApiKey', 'tmdbApiKey']);
function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings || {};
  const out = { ...settings };
  for (const k of REDACTED_SETTINGS_KEYS) {
    if (out[k]) out[k] = '__set__'; // indicates configured without exposing value
    else delete out[k];
  }
  return out;
}

router.use(authenticate);

router.post('/', rateLimit(5, 60_000), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Workspace name is required' });
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: 'Name too long (max 100 chars)' });
  }

  // First workspace is always allowed. Additional workspaces require multiWorkspaceEnabled on the existing plan.
  const existing = await db.prepare(
    `SELECT w.id, w.plan, w.settings FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = ? AND wm.role = 'owner' LIMIT 1`
  ).get(req.user.id);

  if (existing) {
    const { hasFeature } = require('../middleware/checkFeature');
    if (!await hasFeature(existing, 'multiWorkspace')) {
      return res.status(403).json({
        error: 'Tu plan no permite crear múltiples workspaces. Actualiza tu plan para acceder.',
        code: 'FEATURE_NOT_IN_PLAN',
      });
    }
  }

  const id = uuidv4();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + id.slice(0, 6);
  const plan = config.plans.starter;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO workspaces (id, name, slug, owner_id, plan, max_videos, max_storage_bytes, max_bandwidth_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, name.trim(), slug, req.user.id, 'starter', plan.maxVideos, plan.maxStorageGB * 1e9, plan.maxBandwidthGB * 1e9]
    );
    await client.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, accepted_at) VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), id, req.user.id, 'owner', Math.floor(Date.now() / 1000)]
    );
    await client.query('COMMIT');
    res.status(201).json({ id, name: name.trim(), slug, plan: 'starter' });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Create workspace error');
    res.status(500).json({ error: 'Failed to create workspace' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  try {
    const workspaces = await db.prepare(`
      SELECT w.*, wm.role
      FROM workspaces w
      JOIN workspace_members wm ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.created_at ASC
    `).all(req.user.id);

    res.json(workspaces.map(ws => {
      let settings = {};
      try { settings = JSON.parse(ws.settings || '{}'); } catch {}
      return { ...ws, settings: sanitizeSettings(settings) };
    }));
  } catch (err) {
    logger.error({ err }, 'List workspaces error');
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

router.get('/:workspaceId', resolveWorkspace, async (req, res) => {
  try {
    const ws = req.workspace;

    const [videoCount, totalViews, members] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as count FROM videos WHERE workspace_id = ?`).get(ws.id),
      db.prepare(`SELECT COALESCE(SUM(views), 0) as total FROM videos WHERE workspace_id = ?`).get(ws.id),
      db.prepare(`
        SELECT wm.role, wm.accepted_at, u.id, u.email, u.name
        FROM workspace_members wm
        JOIN users u ON wm.user_id = u.id
        WHERE wm.workspace_id = ?
        ORDER BY wm.accepted_at ASC
      `).all(ws.id),
    ]);

    res.json({
      ...ws,
      settings: sanitizeSettings(ws.settings),
      usage: {
        videos: Number(videoCount?.count || 0),
        maxVideos: ws.max_videos,
        storageUsedBytes: ws.storage_used_bytes,
        maxStorageBytes: ws.max_storage_bytes,
        bandwidthUsedBytes: ws.bandwidth_used_bytes,
        maxBandwidthBytes: ws.max_bandwidth_bytes,
        totalViews: Number(totalViews?.total || 0),
      },
      members,
    });
  } catch (err) {
    logger.error({ err }, 'Get workspace error');
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

router.patch('/:workspaceId', resolveWorkspace, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, slug, settings, custom_embed_domain, avatar_url } = req.body;
    const ws = req.workspace;

    // Validate name length
    if (name !== undefined) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return res.status(400).json({ error: 'Workspace name cannot be empty' });
      if (trimmed.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
      await db.prepare(`UPDATE workspaces SET name = ?, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`)
        .run(trimmed, ws.id);
    }

    // Slug update (channel URL)
    if (slug !== undefined) {
      const cleanSlug = String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
      if (!cleanSlug || cleanSlug.length < 3) return res.status(400).json({ error: 'Slug must be at least 3 characters' });
      if (cleanSlug.length > 80) return res.status(400).json({ error: 'Slug too long (max 80 chars)' });
      const existing = await db.prepare(`SELECT id FROM workspaces WHERE slug = ? AND id != ?`).get(cleanSlug, ws.id);
      if (existing) return res.status(409).json({ error: 'Ese slug ya está en uso' });
      await db.prepare(`UPDATE workspaces SET slug = ?, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`)
        .run(cleanSlug, ws.id);
    }

    if (avatar_url !== undefined) {
      const av = String(avatar_url || '').trim();
      if (av && !/^(https?:\/\/|\/|data:image\/)/.test(av)) {
        return res.status(400).json({ error: 'URL de avatar inválida' });
      }
      await db.prepare(`UPDATE workspaces SET avatar_url = ?, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`)
        .run(av || null, ws.id);
    }

    if (settings && typeof settings === 'object') {
      // Whitelist of allowed settings keys — never merge arbitrary keys (prototype pollution prevention)
      const ALLOWED_SETTINGS_KEYS = new Set([
        // Embed / player branding
        'embedAllowedDomains', 'embedPlayerName', 'embedLogo', 'embedColor',
        'embedEnabled', 'embedShowTitle', 'embedShowProgress',
        'playerBranding', 'playerColor', 'playerLogo',
        'playerLogoUrl', 'playerLogoLink', 'playerAutoplay', 'playerMuted',
        'playerControls', 'playerPreload', 'playerPoster', 'playerTheme',
        // Integrations
        'openaiApiKey', 'tmdbApiKey', 'webhookSecret',
        // Notifications
        'emailNotifications', 'notifyOnUpload', 'notifyOnReady', 'notifyOnError',
        // Video defaults
        'defaultVideoVisibility', 'requireVideoPassword', 'enableChapters',
        'enableSubtitles', 'enableTranscription', 'subtitleLanguage',
        'showDownloadButton', 'downloadsEnabled', 'downloadEnabled', 'downloadExpiry',
        // Access & visibility
        'channelEnabled', 'playlistsPublic',
        'hotlinkProtection', 'requireTokensAlways',
        // Analytics
        'analyticsEnabled', 'analyticsRetentionDays',
        // Watermark (snake_case from dashboard)
        'watermark_enabled', 'watermark_text', 'watermark_position', 'watermark_opacity',
        // Watermark (camelCase legacy)
        'watermarkEnabled', 'watermarkText', 'watermarkPosition', 'watermarkOpacity',
        // Ads
        'ads',
        // Player security
        'adblock_detection', 'devtools_blocker',
        // Enterprise transcoding quality selection
        'transcodingQualities',
        // Misc
        'customCss', 'customJs', 'streamQuality', 'maxUploadSize',
      ]);
      const safeSettings = Object.fromEntries(
        Object.entries(settings).filter(([k]) => ALLOWED_SETTINGS_KEYS.has(k))
      );
      const merged = { ...ws.settings, ...safeSettings };
      if (JSON.stringify(merged).length > 100_000) {
        return res.status(400).json({ error: 'Settings payload too large (max 100 KB)' });
      }
      await db.prepare(`UPDATE workspaces SET settings = ?, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`)
        .run(JSON.stringify(merged), ws.id);
    }

    // F2.7: Custom embed domain (Enterprise only)
    if (typeof custom_embed_domain !== 'undefined') {
      const { hasFeature } = require('../middleware/checkFeature');
      if (!await hasFeature(ws, 'customDomain')) {
        return res.status(403).json({
          error: 'Tu plan no incluye dominios personalizados. Actualiza a Enterprise para acceder.',
          code: 'FEATURE_NOT_IN_PLAN',
          requiredUpgrade: true,
        });
      }
      // Basic domain validation
      if (custom_embed_domain && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(custom_embed_domain)) {
        return res.status(400).json({ error: 'Invalid domain format' });
      }
      // Setting a new domain clears verified status; removing domain also clears it
      await db.prepare(`UPDATE workspaces SET custom_embed_domain = ?, custom_domain_verified = FALSE, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`)
        .run(custom_embed_domain || null, ws.id);
    }

    // Invalidate workspace cache so next request gets fresh data
    cache.invalidate(`sv:ws:${ws.id}`).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Patch workspace error');
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// Verify that a custom domain is pointing to this server
router.post('/:workspaceId/verify-domain', rateLimit(10, 60_000), resolveWorkspace, requireRole('owner', 'admin'), async (req, res) => {
  const ws = req.workspace;
  const { hasFeature } = require('../middleware/checkFeature');
  if (!await hasFeature(ws, 'customDomain')) {
    return res.status(403).json({
      error: 'Tu plan no incluye dominios personalizados. Actualiza a Enterprise para acceder.',
      code: 'FEATURE_NOT_IN_PLAN',
      requiredUpgrade: true,
    });
  }

  const domain = (req.body.domain || '').trim().toLowerCase();

  if (!domain) return res.status(400).json({ error: 'Domain is required' });
  if (!ws.custom_embed_domain) return res.status(400).json({ error: 'No custom domain configured. Save a domain first.' });
  if (ws.custom_embed_domain !== domain) {
    return res.status(400).json({ error: 'Domain does not match saved domain. Save the domain first.' });
  }

  // Resolve domain first and reject private/loopback IPs (SSRF prevention).
  const { promises: dns } = require('dns');
  let resolvedIp;
  try {
    const result = await dns.lookup(domain);
    resolvedIp = result.address;
  } catch {
    return res.status(400).json({ error: `Domain "${domain}" does not resolve. Check your DNS CNAME record.` });
  }

  // Block RFC-1918, loopback, link-local, and APIPA ranges.
  const isPrivate = (ip) => /^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip === '::1' || ip.startsWith('fd') || ip.startsWith('fc');

  if (isPrivate(resolvedIp)) {
    return res.status(400).json({ error: 'Domain resolves to a private or reserved IP address.' });
  }

  // Attempt an HTTP request to the domain — if it resolves and returns any response,
  // the DNS is pointing somewhere. Mark as verified so the embed config includes it.
  try {
    const https = require('https');
    const http  = require('http');
    const appUrl = process.env.APP_URL || '';
    const useHttps = appUrl.startsWith('https');
    const lib = useHttps ? https : http;

    await new Promise((resolve, reject) => {
      const req2 = lib.get(
        { hostname: domain, path: '/', timeout: 5000 },
        res2 => { res2.resume(); resolve(); }
      );
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
      req2.on('error', reject);
    });

    await db.prepare(`UPDATE workspaces SET custom_domain_verified = TRUE, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`).run(ws.id);
    cache.invalidate(`sv:ws:${ws.id}`).catch(() => {});
    res.json({ success: true, verified: true });
  } catch (err) {
    // Even if the HTTP check fails (SSL error, redirect, etc.), DNS already resolved
    // to a public IP above — treat as verified.
    await db.prepare(`UPDATE workspaces SET custom_domain_verified = TRUE, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`).run(ws.id);
    cache.invalidate(`sv:ws:${ws.id}`).catch(() => {});
    return res.json({ success: true, verified: true });
  }
});

router.delete('/:workspaceId', resolveWorkspace, requireRole('owner'), async (req, res) => {
  const ws = req.workspace;

  // Fetch video list first (outside transaction — read-only)
  const videos = await db.prepare(`SELECT id, s3_object_prefix, size FROM videos WHERE workspace_id = ?`).all(ws.id);

  // Delete DB records atomically
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM videos WHERE workspace_id = $1`, [ws.id]);
    await client.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [ws.id]);
    await client.query(`DELETE FROM workspace_invitations WHERE workspace_id = $1`, [ws.id]);
    await client.query(`DELETE FROM workspaces WHERE id = $1`, [ws.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, workspaceId: ws.id }, 'Delete workspace transaction failed');
    return res.status(500).json({ error: 'Failed to delete workspace' });
  } finally {
    client.release();
  }

  // Delete physical files after successful DB removal (fire-and-forget)
  const cdnPaths = [];
  for (const video of videos) {
    if (s3.isS3Enabled() && video.s3_object_prefix) {
      s3.deleteObjectsWithPrefix(video.s3_object_prefix).catch(err =>
        logger.warn({ videoId: video.id, err: err.message }, 'S3 cleanup failed during workspace delete')
      );
      cdnPaths.push(`/${video.s3_object_prefix}/*`);
    }
    const dir = path.join(__dirname, '..', 'videos', video.id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  if (cdnPaths.length) s3.invalidateCDN(cdnPaths).catch(() => {});

  res.json({ success: true, message: 'Workspace deleted' });
});

router.post('/:workspaceId/invite', rateLimit(10, 60_000), resolveWorkspace, requireRole('owner', 'admin'), checkFeature('invitations'), async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required' });
    
    // FIX #8: Strong email validation to prevent injection attacks
    // Use more strict regex and length limits
    if (typeof email !== 'string' || email.length > 254 || email.length < 3) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Strict email regex: no special chars in local part that could inject headers
    const emailRegex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (role && !['admin', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or viewer' });
    }

    const ws = req.workspace;
    const inviteRole = role || 'viewer';

    const existingUser = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase());
    if (existingUser) {
      const existingMember = await db.prepare(`SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
        .get(ws.id, existingUser.id);
      if (existingMember) {
        return res.status(409).json({ error: 'User is already a member of this workspace' });
      }
    }

    const inviteId = uuidv4();
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);

    await db.prepare(`INSERT INTO workspace_invitations (id, workspace_id, email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(inviteId, ws.id, email.toLowerCase(), inviteRole, inviteToken, req.user.id, expiresAt);

    const emailSent = await sendWorkspaceInvitation(email, req.user.name, ws.name, inviteToken)
      .catch(() => false);

    if (!emailSent) logger.warn({ email, workspaceId: ws.id }, 'Invitation email failed to send');

    res.status(201).json({ success: true, invitationId: inviteId, message: 'Invitation sent', emailSent });
  } catch (err) {
    logger.error({ err }, 'Invite error');
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

router.get('/:workspaceId/members', resolveWorkspace, async (req, res) => {
  try {
    const [members, pendingInvitations] = await Promise.all([
      db.prepare(`
        SELECT wm.id as membership_id, wm.role, wm.accepted_at, u.id, u.email, u.name
        FROM workspace_members wm
        JOIN users u ON wm.user_id = u.id
        WHERE wm.workspace_id = ?
        ORDER BY wm.accepted_at ASC
      `).all(req.workspace.id),
      db.prepare(`
        SELECT id, email, role, created_at, expires_at
        FROM workspace_invitations
        WHERE workspace_id = ? AND accepted_at IS NULL AND expires_at > ?
      `).all(req.workspace.id, Math.floor(Date.now() / 1000)),
    ]);
    res.json({ members, pendingInvitations });
  } catch (err) {
    logger.error({ err }, 'List members error');
    res.status(500).json({ error: 'Failed to list members' });
  }
});

// FIX #7: Insecure Direct Object Reference - Validate role hierarchy
router.patch('/:workspaceId/members/:userId', resolveWorkspace, requireRole('owner'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || !['admin', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or viewer' });
    }

    if (req.params.userId === req.workspace.owner_id) {
      return res.status(400).json({ error: 'Cannot change the owner\'s role' });
    }

    const member = await db.prepare(`SELECT id, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .get(req.workspace.id, req.params.userId);

    if (!member) return res.status(404).json({ error: 'Member not found' });

    if (req.user.id !== req.workspace.owner_id) {
      return res.status(403).json({ error: 'Only workspace owner can change member roles' });
    }

    await db.prepare(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`)
      .run(role, req.workspace.id, req.params.userId);

    const { logAudit } = require('../services/auditLog');
    logAudit(req, 'workspace.member_role_changed', 'workspace_member', req.params.userId, {
      workspaceId: req.workspace.id,
      oldRole: member.role,
      newRole: role,
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Patch member role error');
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

router.delete('/:workspaceId/members/:userId', resolveWorkspace, async (req, res) => {
  try {
    const ws = req.workspace;
    const targetUserId = req.params.userId;

    if (targetUserId === ws.owner_id) {
      return res.status(400).json({ error: 'Cannot remove the workspace owner' });
    }

    if (targetUserId !== req.user.id && !['owner', 'admin'].includes(req.workspaceRole)) {
      return res.status(403).json({ error: 'Only owners and admins can remove other members' });
    }

    await db.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .run(ws.id, targetUserId);

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Remove member error');
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

router.delete('/:workspaceId/invitations/:invitationId', resolveWorkspace, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const inv = await db.prepare(
      `SELECT id FROM workspace_invitations WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL`
    ).get(req.params.invitationId, req.workspace.id);

    if (!inv) return res.status(404).json({ error: 'Invitation not found or already accepted' });

    await db.prepare(`DELETE FROM workspace_invitations WHERE id = ?`).run(inv.id);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Cancel invitation error');
    res.status(500).json({ error: 'Failed to cancel invitation' });
  }
});

router.get('/:workspaceId/tmdb', resolveWorkspace, async (req, res) => {
  const tmdbId   = String(req.query.tmdb_id   || '').trim();
  const tmdbType = req.query.tmdb_type === 'tv' ? 'tv' : 'movie';
  if (!tmdbId) return res.status(400).json({ error: 'tmdb_id required' });
  const tmdbKey = req.workspace?.settings?.tmdbApiKey;
  if (!tmdbKey) return res.status(400).json({ error: 'no_tmdb_key' });
  try {
    const url = `https://api.themoviedb.org/3/${tmdbType}/${encodeURIComponent(tmdbId)}?append_to_response=credits&language=es-MX`;
    const tmdbRes = await fetch(url, { headers: { Authorization: `Bearer ${tmdbKey}` } });
    if (!tmdbRes.ok) {
      const body = await tmdbRes.json().catch(() => ({}));
      return res.status(tmdbRes.status).json({ error: 'tmdb_error', detail: body });
    }
    res.json({ ...await tmdbRes.json(), _type: tmdbType });
  } catch (err) {
    logger.error({ err }, 'TMDB proxy error');
    res.status(500).json({ error: 'Failed to fetch TMDB data' });
  }
});

router.get('/:workspaceId/analytics', resolveWorkspace, checkFeature('analytics'), async (req, res) => {
  const ws = req.workspace;
  const VALID_DAYS = [7, 30, 90];
  const days = VALID_DAYS.includes(parseInt(req.query.days)) ? parseInt(req.query.days) : null;
  const dateFilter = days ? `AND e.created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - ${days} * 86400` : '';

  try {
    const totalViewsRow = await db.prepare(`SELECT COALESCE(SUM(views), 0) as total FROM videos WHERE workspace_id = ?`).get(ws.id);
    
    const dailyPlays = await db.prepare(`
      SELECT
        TO_CHAR(TO_TIMESTAMP(e.created_at), 'YYYY-MM-DD') AS day,
        COUNT(*) AS plays
      FROM events e
      JOIN videos v ON e.video_id = v.id
      WHERE v.workspace_id = ? AND e.event_type = 'play' ${dateFilter}
      GROUP BY day
      ORDER BY day ASC
    `).all(ws.id);

    const topVideos = await db.prepare(`
      SELECT id, title, views
      FROM videos
      WHERE workspace_id = ?
      ORDER BY views DESC
      LIMIT 5
    `).all(ws.id);

    res.json({
      totalViews: Number(totalViewsRow?.total || 0),
      storageUsedBytes: Number(ws.storage_used_bytes || 0),
      bandwidthUsedBytes: Number(ws.bandwidth_used_bytes || 0),
      dailyPlays: dailyPlays.map(r => ({ day: r.day, plays: Number(r.plays) })),
      topVideos: topVideos.map(v => ({ ...v, views: Number(v.views || 0) })),
    });
  } catch(e) {
    logger.error({ err: e.message }, 'Workspace analytics error');
    res.status(500).json({ error: 'Failed to fetch workspace analytics' });
  }
});

module.exports = router;
