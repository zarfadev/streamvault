/**
 * Worker Process
 *
 * Consumes two Bull/Redis queues:
 *   • "transcoding"   — FFmpeg HLS pipeline (CPU-bound)
 *   • "transcription" — OpenAI Whisper subtitles (I/O-bound, API call)
 *
 * Must share the uploads/ and videos/ volumes with the API server
 * (same host, NFS, or EFS in production).
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node worker.js
 *   npm run worker
 *
 * Env vars:
 *   REDIS_URL                — required
 *   DATABASE_URL             — required (same DB as the API server)
 *   WORKER_CONCURRENCY       — parallel transcode jobs (default: 2)
 *   TRANSCRIPTION_CONCURRENCY — parallel Whisper jobs (default: 4)
 *
 * Note: OpenAI API Key is now managed per workspace in workspace settings.
 * Each workspace configures its own key in Dashboard → Settings → General.
 */
require('dotenv').config();

const config = require('./config');
const db     = require('./db');
const logger = require('./services/logger').child({ module: 'worker' });
const { deliverWebhook } = require('./services/webhooks');
const { sendTranscodeComplete } = require('./services/email');

if (!config.redisUrl) {
  logger.fatal('REDIS_URL is required to run the worker.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  logger.fatal('DATABASE_URL is required.');
  process.exit(1);
}

const os = require('os');
// Default: one slot per CPU core, capped at 8 to avoid memory pressure.
// Override with WORKER_CONCURRENCY env var.
const defaultConc       = Math.min(8, Math.max(2, os.cpus().length));
const transcodeConc     = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || String(defaultConc), 10));
const transcriptionConc = Math.max(1, parseInt(process.env.TRANSCRIPTION_CONCURRENCY || '4', 10));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let _shuttingDown = false;

async function shutdown(signal, transcodeQueue, transcriptionQueue) {
  if (_shuttingDown) return;
  _shuttingDown = true;

  logger.info(`Received ${signal} — draining queues and shutting down…`);

  // 1. Kill all active FFmpeg processes immediately to prevent zombies
  try {
    const { killAllFFmpeg } = require('./transcoder');
    killAllFFmpeg();
    logger.info('FFmpeg processes terminated');
  } catch {}

  // 2. Pause queues — stop accepting new jobs
  try {
    const pausePromises = [transcodeQueue.pause(true)];
    if (transcriptionQueue) pausePromises.push(transcriptionQueue.pause(true));
    await Promise.all(pausePromises);
    logger.info('Queues paused — waiting for active jobs (max 60s)…');
  } catch (err) {
    logger.warn({ err }, 'Error pausing queues');
  }

  // 3. Close queues with a 60s timeout
  const timeout = setTimeout(() => {
    logger.warn('Timeout waiting for jobs — forcing exit');
    process.exit(1);
  }, 60_000);

  try {
    const closePromises = [transcodeQueue.close()];
    if (transcriptionQueue) closePromises.push(transcriptionQueue.close());
    await Promise.all(closePromises);
    clearTimeout(timeout);
    logger.info('All queues closed');
  } catch (err) {
    logger.warn({ err }, 'Error closing queues');
    clearTimeout(timeout);
  }

  // 4. Flush logger
  try { logger.flush(); } catch {}

  logger.info('Worker shutdown complete. Goodbye.');
  process.exit(0);
}

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in worker — process will exit');
  try { logger.flush(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err: { message: err.message, stack: err.stack } }, 'Unhandled promise rejection in worker');
});

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info({
    redis:              config.redisUrl.replace(/:\/\/.*@/, '://***@'),
    db:                 (process.env.DATABASE_URL || '').split('@').pop(),
    transcodeConc,
    transcriptionConc,
  }, 'Worker starting');

  await db.init();
  logger.info('Database connected');

  const { startWorker, startTranscribeWorker, getQueue } = require('./services/queue');

  // ── Start both processors ─────────────────────────────────────────────────
  const transcodeQueue     = await startWorker(transcodeConc);
  const transcriptionQueue = await startTranscribeWorker(transcriptionConc);

  // ── Register shutdown handlers now that we have queue references ──────────
  process.on('SIGTERM', () => shutdown('SIGTERM', transcodeQueue, transcriptionQueue));
  process.on('SIGINT',  () => shutdown('SIGINT',  transcodeQueue, transcriptionQueue));

  // ── Heartbeat — logs queue depths every 30s when there is activity ────────
  setInterval(async () => {
    if (_shuttingDown) return;
    try {
      const [tw, ta, tc, tf] = await Promise.all([
        transcodeQueue.getWaitingCount(),
        transcodeQueue.getActiveCount(),
        transcodeQueue.getCompletedCount(),
        transcodeQueue.getFailedCount(),
      ]);

      let transcriptionStats = {};
      if (transcriptionQueue) {
        const [rw, ra, rc, rf] = await Promise.all([
          transcriptionQueue.getWaitingCount(),
          transcriptionQueue.getActiveCount(),
          transcriptionQueue.getCompletedCount(),
          transcriptionQueue.getFailedCount(),
        ]);
        if (ra > 0 || rw > 0) {
          transcriptionStats = { txWaiting: rw, txActive: ra, txDone: rc, txFailed: rf };
        }
      }

      if (ta > 0 || tw > 0 || Object.keys(transcriptionStats).length) {
        logger.info({
          transcode: { waiting: tw, active: ta, done: tc, failed: tf },
          ...transcriptionStats,
        }, 'Worker heartbeat');
      }
    } catch {}
  }, 30_000);

  // ── F3.2: Scheduled publishing — runs every 60s ───────────────────────────
  setInterval(async () => {
    if (_shuttingDown) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      // Atomic UPDATE + RETURNING: only the worker that wins the UPDATE processes
      // each video, so two concurrent workers can never double-publish the same row.
      const scheduled = await db.pool.query(
        `UPDATE videos SET status = 'ready', updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
         WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= $1
         RETURNING id, title`,
        [now]
      ).then(r => r.rows);
      for (const v of scheduled) {
        logger.info({ videoId: v.id, title: v.title }, 'Scheduled video published');

        // Fire video.ready webhook and completion email
        const fullVideo = await db.prepare(
          `SELECT v.id, v.title, v.duration, v.thumbnail, v.workspace_id, w.owner_id
           FROM videos v LEFT JOIN workspaces w ON w.id = v.workspace_id WHERE v.id = ?`
        ).get(v.id).catch(() => null);
        if (fullVideo?.workspace_id) {
          deliverWebhook(fullVideo.workspace_id, 'video.ready', {
            videoId: fullVideo.id,
            title:   fullVideo.title,
          }).catch(() => {});
        }
        if (fullVideo?.owner_id) {
          const owner = await db.prepare(`SELECT email, name FROM users WHERE id = ?`)
            .get(fullVideo.owner_id).catch(() => null);
          if (owner) {
            sendTranscodeComplete(
              owner.email,
              fullVideo.title,
              `/watch/${fullVideo.id}`
            ).catch(() => {});
          }
        }
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Scheduled publish job failed');
    }
  }, 60_000);

  // ── F4.2: Analytics retention — runs weekly (every 7 days) ───────────────
  setInterval(async () => {
    if (_shuttingDown) return;
    try {
      const workspaces = await db.prepare(
        `SELECT id, analytics_retention_days FROM workspaces WHERE analytics_retention_days IS NOT NULL`
      ).all();
      for (const ws of workspaces) {
        const retDays = ws.analytics_retention_days || 90;
        const cutoff = Math.floor(Date.now() / 1000) - retDays * 86400;
        const res = await db.prepare(
          `DELETE FROM events WHERE workspace_id = ? AND created_at < ?`
        ).run(ws.id, cutoff);
        if (res?.changes > 0) {
          logger.info({ workspaceId: ws.id, deleted: res.changes }, 'Analytics retention cleanup');
        }
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Analytics retention job failed');
    }
  }, 7 * 24 * 60 * 60 * 1000);

  // ── Anonymous uploads cleanup — runs every hour ─────────────────────────
  setInterval(async () => {
    if (_shuttingDown) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const s3 = require('./services/s3Storage');
      const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24 hours ago
      
      const expiredVideos = await db.prepare(
        `SELECT id, s3_object_prefix FROM videos WHERE workspace_id IS NULL AND created_at < ?`
      ).all(cutoff);

      for (const v of expiredVideos) {
        try {
          if (s3.isS3Enabled() && v.s3_object_prefix) {
            await s3.deleteObjectsWithPrefix(v.s3_object_prefix).catch(err => logger.warn({ err: err.message }, 'S3 delete failed for anonymous video'));
          }
          const dir = path.join(__dirname, 'videos', v.id);
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

          await db.prepare(`DELETE FROM videos WHERE id = ?`).run(v.id);
          logger.info({ videoId: v.id }, 'Deleted expired anonymous video');
        } catch (innerErr) {
          logger.error({ err: innerErr.message, videoId: v.id }, 'Failed to clean up anonymous video');
        }
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Anonymous uploads cleanup job failed');
    }
  }, 60 * 60 * 1000); // every hour

  // ── Cleanup expired revoked tokens — runs hourly ──────────────────────────
  // Access tokens live max 15m; remove from revocation list after 30m to keep table small.
  async function cleanupRevokedTokens() {
    if (_shuttingDown) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
      const result = await db.prepare(
        `DELETE FROM revoked_tokens WHERE expires_at < ?`
      ).run(cutoff);
      if (result?.changes > 0) {
        logger.info({ deleted: result.changes }, 'Cleaned up expired revoked tokens');
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Revoked tokens cleanup failed');
    }
  }
  cleanupRevokedTokens();
  setInterval(cleanupRevokedTokens, 60 * 60 * 1000); // every hour

  // ── Audit log retention — runs daily, keeps 90 days ──────────────────────
  async function cleanupAuditLog() {
    if (_shuttingDown) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
      const result = await db.prepare(`DELETE FROM audit_log WHERE created_at < ?`).run(cutoff);
      if (result?.changes > 0) {
        logger.info({ deleted: result.changes }, 'Cleaned up old audit log entries');
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Audit log cleanup failed');
    }
  }
  cleanupAuditLog();
  setInterval(cleanupAuditLog, 24 * 60 * 60 * 1000); // every 24 hours

  // ── Video expiry enforcement — runs every 5 min ──────────────────────────
  // Marks videos as 'expired' when their expires_at timestamp has passed.
  // This is separate from the anonymous cleanup (which deletes them outright).
  async function enforceVideoExpiry() {
    if (_shuttingDown) return;
    try {
      const result = await db.pool.query(
        `UPDATE videos
         SET status = 'expired', updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
         WHERE status IN ('ready', 'scheduled')
           AND expires_at IS NOT NULL
           AND expires_at <= FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
         RETURNING id, title`
      );
      if (result.rows.length > 0) {
        logger.info({ expired: result.rows.map(r => r.id) }, `Marked ${result.rows.length} video(s) as expired`);
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Video expiry enforcement failed');
    }
  }
  enforceVideoExpiry();
  setInterval(enforceVideoExpiry, 5 * 60 * 1000); // every 5 minutes

  // ── Storage counter reconciliation — runs every 6 hours ──────────────────
  // Recalculates storage_used_bytes from actual video sizes to fix drift
  // caused by crashes mid-upload or out-of-band file changes.
  async function reconcileStorage() {
    if (_shuttingDown) return;
    try {
      const result = await db.pool.query(
        `UPDATE workspaces w
         SET storage_used_bytes = COALESCE((
           SELECT SUM(COALESCE(size, 0))
           FROM videos
           WHERE workspace_id = w.id
             AND status NOT IN ('deleted', 'expired')
         ), 0)
         WHERE w.id IS NOT NULL
         RETURNING id`
      );
      if (result.rows.length > 0) {
        logger.info({ workspaces: result.rows.length }, 'Storage counter reconciliation complete');
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Storage reconciliation failed');
    }
  }
  setInterval(reconcileStorage, 6 * 60 * 60 * 1000); // every 6 hours

  // ── Subscription expiry enforcement — runs every hour ────────────────────
  // Downgrades workspaces whose current_period_end has passed and no renewal
  // payment arrived. Covers cases where the cancellation/failure webhook was
  // lost or never delivered by the payment provider.
  async function enforceSubscriptionExpiry() {
    if (_shuttingDown) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      // Grace period: 3 days after period_end before we downgrade hard.
      // This avoids false positives from clock drift or delayed webhooks.
      const graceCutoff = now - 3 * 86400;

      // Find workspaces with an active paid plan whose period ended > 3 days ago
      // and still have a subscription ID set (not already downgraded by webhook).
      const result = await db.pool.query(
        `SELECT id, plan, payment_provider, payment_subscription_id, payment_metadata
         FROM workspaces
         WHERE plan != 'starter'
           AND payment_subscription_id IS NOT NULL
           AND payment_metadata IS NOT NULL
           AND payment_metadata != '{}'
           AND (payment_metadata::jsonb->>'current_period_end') IS NOT NULL
           AND CAST(payment_metadata::jsonb->>'current_period_end' AS BIGINT) < $1`,
        [graceCutoff]
      );

      if (result.rows.length === 0) return;

      logger.warn({ count: result.rows.length }, `Subscription expiry: ${result.rows.length} workspace(s) past period_end grace — downgrading`);

      const emailService = require('./services/email');
      const cfgPlans = require('./config').plans;

      for (const ws of result.rows) {
        try {
          const starter = cfgPlans.starter;
          await db.pool.query(
            `UPDATE workspaces
             SET plan                    = 'starter',
                 payment_subscription_id = NULL,
                 payment_customer_id     = NULL,
                 suspended               = 0,
                 max_videos              = $1,
                 max_storage_bytes       = $2,
                 max_bandwidth_bytes     = $3,
                 payment_metadata        = '{}',
                 updated_at              = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
             WHERE id = $4`,
            [starter.maxVideos, starter.maxStorageGB * 1e9, starter.maxBandwidthGB * 1e9, ws.id]
          );

          const cache = require('./services/cache');
          cache.invalidate(`sv:ws:${ws.id}`).catch(() => {});

          logger.info({ workspaceId: ws.id, fromPlan: ws.plan, provider: ws.payment_provider }, 'Workspace downgraded by expiry worker');

          // Notify owner by email
          const ownerRes = await db.pool.query(
            `SELECT u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = $1`,
            [ws.id]
          );
          const owner = ownerRes.rows[0];
          if (owner) {
            emailService.sendSubscriptionCancelled(owner.email, owner.name, {
              planName: cfgPlans[ws.plan]?.name || ws.plan,
              reason: 'expiry',
            }).catch(e => logger.error({ err: e.message }, 'sendSubscriptionCancelled error (expiry worker)'));
          }
        } catch (innerErr) {
          logger.error({ err: innerErr.message, workspaceId: ws.id }, 'Subscription expiry: failed to downgrade workspace');
        }
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Subscription expiry enforcement failed');
    }
  }
  enforceSubscriptionExpiry();
  setInterval(enforceSubscriptionExpiry, 60 * 60 * 1000); // every hour

  // ── Stuck video watchdog — runs every 30 min ──────────────────────────────
  // If a video stays in 'transcoding' or 'downloading' for > 2 hours the
  // worker likely crashed mid-job without updating the DB. Mark as error so
  // the dashboard shows a clear failure instead of a spinner forever.
  async function rescueStuckVideos() {
    if (_shuttingDown) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 2 * 60 * 60; // 2 hours ago

      // Mark videos stuck in transcoding/downloading for >2h as error
      const result = await db.pool.query(
        `UPDATE videos
         SET status = 'error', transcoding_pct = NULL, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
         WHERE status IN ('transcoding', 'downloading')
           AND updated_at < $1
         RETURNING id, title`,
        [cutoff]
      );
      if (result.rows.length > 0) {
        logger.warn({ rescued: result.rows.map(r => r.id) }, `Watchdog: marked ${result.rows.length} stuck video(s) as error`);
      }

      // Detect ready videos with fewer qualities than expected (secondary encode died silently).
      // Log only — don't auto-retry since the video is still watchable. Users can retranscode manually.
      const partialCutoff = Math.floor(Date.now() / 1000) - 3 * 60 * 60; // 3 hours ago
      const partial = await db.pool.query(
        `SELECT id, title, qualities, qualities_expected FROM videos
         WHERE status = 'ready'
           AND qualities_expected IS NOT NULL
           AND jsonb_array_length(qualities::jsonb) < qualities_expected
           AND updated_at < $1`,
        [partialCutoff]
      );
      if (partial.rows.length > 0) {
        logger.warn(
          {
            videos: partial.rows.map(r => ({
              id: r.id,
              title: r.title,
              have: (JSON.parse(r.qualities || '[]')).length,
              expected: r.qualities_expected,
            })),
          },
          `Watchdog: ${partial.rows.length} video(s) have fewer qualities than expected — secondary encode may have failed. Re-transcode from dashboard to fix.`
        );
      }
    } catch (e) {
      logger.error({ err: e.message }, 'Stuck video watchdog failed');
    }
  }
  rescueStuckVideos();
  setInterval(rescueStuckVideos, 30 * 60 * 1000);

  // ── F4.3: Worker heartbeat to status_checks ───────────────────────────────
  // Alert threshold: warn when more than N jobs are waiting (signals need for more workers)
  const QUEUE_ALERT_THRESHOLD = parseInt(process.env.QUEUE_ALERT_THRESHOLD || '20', 10);

  async function writeHeartbeat() {
    if (_shuttingDown) return;
    try {
      await db.prepare(
        `INSERT INTO status_checks (service, healthy, checked_at) VALUES ('worker', 1, FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
         ON CONFLICT (service) DO UPDATE SET healthy = 1, checked_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`
      ).run();
    } catch {}

    // Queue depth check — log warning when backlog grows beyond threshold
    try {
      const { getQueueStats } = require('./services/queue');
      const stats = await getQueueStats();
      if (stats.waiting > QUEUE_ALERT_THRESHOLD) {
        logger.warn(
          { waiting: stats.waiting, active: stats.active, threshold: QUEUE_ALERT_THRESHOLD },
          `⚠️  Queue backlog: ${stats.waiting} jobs waiting — consider adding more worker instances (WORKER_CONCURRENCY or --scale worker=N)`
        );
      } else {
        logger.debug({ waiting: stats.waiting, active: stats.active }, 'Queue depth OK');
      }
    } catch {}
  }
  writeHeartbeat();
  setInterval(writeHeartbeat, 60_000);

  logger.info('Worker ready — waiting for jobs…');
}

main().catch(err => {
  logger.fatal({ err }, 'Worker fatal startup error');
  process.exit(1);
});
