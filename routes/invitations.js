const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger').child({ module: 'invitations' });

// Public lookup — no auth required, returns safe invite info
router.get('/:token', async (req, res) => {
  try {
    // Validate token format: must be 64-char hex string (32 random bytes)
    if (!req.params.token || !/^[0-9a-f]{64}$/.test(req.params.token)) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    const inv = await db.prepare(`
      SELECT wi.role, wi.expires_at,
             w.id AS workspace_id, w.name AS workspace_name,
             u.name AS inviter_name
      FROM workspace_invitations wi
      JOIN workspaces w ON w.id = wi.workspace_id
      LEFT JOIN users u ON u.id = wi.invited_by
      WHERE wi.token = ? AND wi.accepted_at IS NULL AND wi.expires_at > ?
    `).get(req.params.token, Math.floor(Date.now() / 1000));

    if (!inv) return res.status(404).json({ error: 'Invalid or expired invitation' });
    res.json({ workspace_name: inv.workspace_name, inviter_name: inv.inviter_name, role: inv.role });
  } catch (err) {
    logger.error({ err }, 'Get invitation error');
    res.status(500).json({ error: 'Failed to lookup invitation' });
  }
});

router.post('/:token/accept', authenticate, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      SELECT * FROM workspace_invitations
      WHERE token = $1 AND accepted_at IS NULL AND expires_at > $2
    `, [req.params.token, Math.floor(Date.now() / 1000)]);
    const invitation = rows[0];

    if (!invitation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    // Validate the logged-in user's email matches the invited email
    if (invitation.email && invitation.email.toLowerCase() !== req.user.email.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Esta invitación fue enviada a otra dirección de correo' });
    }

    // Atomically mark invitation as accepted — prevents duplicate accepts in race conditions
    const claimed = await client.query(`
      UPDATE workspace_invitations SET accepted_at = $1 WHERE id = $2 AND accepted_at IS NULL
    `, [Math.floor(Date.now() / 1000), invitation.id]);

    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Invitation already accepted' });
    }

    // Check if already a member (may have joined another way while invite was pending)
    const existingRes = await client.query(
      `SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [invitation.workspace_id, req.user.id]
    );
    if (existingRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You are already a member of this workspace' });
    }

    await client.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, accepted_at) VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), invitation.workspace_id, req.user.id, invitation.role, Math.floor(Date.now() / 1000)]
    );

    await client.query('COMMIT');

    const workspace = await db.prepare(`SELECT id, name, slug, plan FROM workspaces WHERE id = ?`)
      .get(invitation.workspace_id);

    res.json({ success: true, workspace, role: invitation.role });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'Accept invitation error');
    res.status(500).json({ error: 'Failed to accept invitation' });
  } finally {
    client.release();
  }
});

module.exports = router;
