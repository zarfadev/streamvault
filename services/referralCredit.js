/**
 * referralCredit.js
 *
 * Shared helper: awards 1 free month to the referrer of a newly-converted user.
 * Called from each payment gateway's webhook handler when a referred user makes
 * their first paid subscription.
 *
 * DB schema assumptions:
 *   referrals:  referrer_id, referred_id, credited_at (BIGINT, NULL until converted)
 *   workspaces: free_months_remaining INTEGER DEFAULT 0, owner_id
 */

const db     = require('../db');
const logger = require('./logger').child({ module: 'referralCredit' });

/**
 * Award referral credit to the user who referred `referredUserId`.
 *
 * - Marks the referral row as credited (sets credited_at)
 * - Increments free_months_remaining by 1 on the referrer's default workspace
 * - Is idempotent: if credited_at is already set, does nothing
 *
 * @param {string} referredUserId  — the user who just converted (bought their first plan)
 * @returns {Promise<boolean>}     — true if credit was awarded, false if already credited / no referral
 */
async function awardReferralCredit(referredUserId) {
  if (!referredUserId) return false;

  try {
    // Find the referral row that hasn't been credited yet
    const referral = await db.prepare(
      `SELECT id, referrer_id FROM referrals WHERE referred_id = ? AND credited_at IS NULL LIMIT 1`
    ).get(referredUserId);

    if (!referral) {
      // Either no referral exists, or already credited — idempotent, no action needed
      return false;
    }

    const now = Math.floor(Date.now() / 1000);

    // Mark referral as credited
    await db.prepare(
      `UPDATE referrals SET credited_at = ? WHERE id = ? AND credited_at IS NULL`
    ).run(now, referral.id);

    // Find the referrer's primary workspace (oldest / first created)
    const ws = await db.prepare(
      `SELECT id FROM workspaces WHERE owner_id = ? ORDER BY created_at ASC LIMIT 1`
    ).get(referral.referrer_id);

    if (ws) {
      await db.prepare(
        `UPDATE workspaces
         SET free_months_remaining = free_months_remaining + 1,
             updated_at = ?
         WHERE id = ?`
      ).run(now, ws.id);
      logger.info(
        { referrerId: referral.referrer_id, referredId: referredUserId, wsId: ws.id },
        'Referral credit awarded: +1 free month'
      );
    } else {
      logger.warn({ referrerId: referral.referrer_id }, 'Referrer has no workspace — credit not applied to workspace');
    }

    return true;
  } catch (err) {
    logger.error({ err: err.message, referredUserId }, 'awardReferralCredit failed');
    return false;
  }
}

module.exports = { awardReferralCredit };
