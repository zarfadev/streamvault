/**
 * F3.4 — Audit Log
 * Logs admin actions for compliance and debugging.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger').child({ module: 'audit' });

/**
 * Log an auditable admin action.
 * Fire-and-forget safe — never throws.
 */
async function logAudit(req, action, targetType, targetId, metadata = {}) {
  try {
    const db = require('../db');
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    await db.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_email, action, target_type, target_id, metadata, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(),
      req.user?.id || null,
      req.user?.email || null,
      action,
      targetType || null,
      targetId || null,
      JSON.stringify(metadata),
      ip
    );
  } catch (e) {
    logger.error({ err: e.message, action }, 'Failed to write audit log');
  }
}

module.exports = { logAudit };
