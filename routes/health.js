const express = require('express');
const router  = express.Router();
const db      = require('../db');
const cfg     = require('../config');
const logger  = require('../services/logger').child({ module: 'health' });

const START_TIME = Date.now();

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

module.exports = router;
