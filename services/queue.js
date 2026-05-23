/**
 * Job queues — Bull/Redis.
 *
 * Two queues:
 *   • "transcoding"    — video transcode jobs (FFmpeg HLS pipeline)
 *   • "transcription"  — Whisper AI subtitle jobs (OpenAI API)
 *
 * SERVER  uses: addTranscodeJob, addTranscribeJob, getQueueStats
 * WORKER  uses: startWorker (registers both processors — never call from server.js)
 *
 * Inline fallback (no Redis): transcoding falls back to running in-process.
 * Transcription jobs are silently dropped with a DB error status when Redis
 * is unavailable — Whisper must never block the API server.
 */
const cfg    = require('../config');
const logger = require('./logger').child({ module: 'queue' });

// ─── Queue singletons ─────────────────────────────────────────────────────────

let _transcodeQueue     = null;
let _transcriptionQueue = null;

function makeBullQueue(name) {
  const Bull = require('bull');
  const Redis = require('ioredis');

  // Bull requires enableReadyCheck:false and maxRetriesPerRequest:null for
  // bclient/subscriber connections (blocking job fetch + pub/sub). Using
  // the default enableReadyCheck:true causes Bull to throw an unhandled
  // rejection and the bclient never connects — so jobs sit in the queue
  // forever even though the worker appears healthy.
  const makeRedisClient = (type) => {
    const isBlocking = type === 'bclient' || type === 'subscriber';
    const client = new Redis(cfg.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: !isBlocking, // must be false for bclient/subscriber
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 500, 10_000),
      reconnectOnError: (err) => err.message.includes('READONLY'),
    });
    client.on('error', () => {});
    return client;
  };

  return new Bull(name, {
    redis: cfg.redisUrl,
    createClient: makeRedisClient,
    settings: {
      // Default lockDuration is 30s — too short for builds/deploys that take > 30s.
      // Worker restarts expire the lock, Bull marks job stalled, retries run out fast.
      // 15 minutes gives plenty of headroom for any deploy window.
      lockDuration:    900_000,   // 15 min lock per renewal (default: 30s)
      lockRenewTime:   450_000,   // renew every 7.5 min (half of lockDuration)
      stalledInterval: 300_000,   // check for stalled jobs every 5 min (default: 30s)
      maxStalledCount: 2,         // allow 2 stalls before failing (default: 1)
    },
    defaultJobOptions: {
      attempts:          3,
      timeout:           3_600_000, // 1 hour max per job
      backoff:           { type: 'exponential', delay: 10_000 },
      removeOnComplete:  100,
      removeOnFail:      200,
    },
  });
}

async function getTranscodeQueue() {
  if (_transcodeQueue) return _transcodeQueue;
  if (!cfg.redisUrl) return null;
  try {
    _transcodeQueue = makeBullQueue('transcoding');
    _transcodeQueue.on('error', err => logger.error({ err: err.message }, 'Transcode queue error'));
    return _transcodeQueue;
  } catch (e) {
    logger.warn({ err: e.message }, 'Redis unavailable — transcode queue falling back to inline mode');
    return null;
  }
}

async function getTranscriptionQueue() {
  if (_transcriptionQueue) return _transcriptionQueue;
  if (!cfg.redisUrl) return null;
  try {
    _transcriptionQueue = makeBullQueue('transcription');
    _transcriptionQueue.on('error', err => logger.error({ err: err.message }, 'Transcription queue error'));
    return _transcriptionQueue;
  } catch (e) {
    logger.warn({ err: e.message }, 'Redis unavailable — transcription queue disabled');
    return null;
  }
}

// ─── Producer API (used by server / routes) ───────────────────────────────────

// ── Plan → prioridad Bull (mayor número = mayor prioridad) ───────────────────
// Enterprise: 1 (más alta), Pro: 2, Starter/free: 3 (más baja)
// Bull procesa primero los jobs con prioridad más baja numéricamente.
const PLAN_PRIORITY = {
  enterprise: 1,
  pro:        2,
  starter:    3,
};

/**
 * Check if the worker process is alive by reading its last heartbeat.
 * The worker writes to status_checks every 60s. If no heartbeat in 3 minutes,
 * the worker is considered dead and jobs fall back to inline processing.
 */
async function isWorkerAlive() {
  try {
    const db = require('../db');
    const threshold = Math.floor(Date.now() / 1000) - 180; // 3 minutes
    const row = await db.prepare(
      `SELECT checked_at FROM status_checks WHERE service = 'worker' AND healthy = 1 AND checked_at >= ?`
    ).get(threshold);
    return !!row;
  } catch {
    return true; // If check fails, assume alive so we don't break uploads
  }
}

/**
 * Add a transcoding job.
 * Returns { inline: true } when Redis is unavailable OR worker is not running.
 * Returns { inline: false, jobId } when queued successfully.
 *
 * @param {object} payload - { videoId, inputPath, title, workspaceId, plan? }
 */
async function addTranscodeJob(payload) {
  const q = await getTranscodeQueue();
  if (!q) return { inline: true };

  // If worker hasn't heartbeated recently, skip Redis queue and process inline.
  // This handles the common case of running only `npm start` without `npm run worker`.
  const workerAlive = await isWorkerAlive();
  if (!workerAlive) {
    logger.warn({ videoId: payload.videoId }, 'Worker not alive — falling back to inline transcoding');
    return { inline: true };
  }

  // Prioridad según plan del workspace — Enterprise y Pro van primero
  const plan     = (payload.plan || 'starter').toLowerCase();
  const priority = PLAN_PRIORITY[plan] ?? 3;

  const job = await q.add(payload, {
    jobId:    payload.videoId,
    priority,           // Bull: menor número = se procesa primero
  });
  logger.info({ jobId: job.id, videoId: payload.videoId, plan, priority }, 'Transcode job queued');
  return { inline: false, jobId: job.id };
}

/**
 * Add a Whisper transcription job.
 * If Redis is unavailable the transcription record is marked as error
 * immediately — the API server never runs Whisper in-process.
 *
 * Payload: { transcriptionId, videoId, language }
 */
async function addTranscribeJob(payload) {
  const q = await getTranscriptionQueue();
  if (!q) {
    // Redis not available — mark the transcription as failed immediately
    // so the UI shows a clear error instead of hanging in "pending".
    const db = require('../db');
    await db.prepare(
      `UPDATE transcriptions
       SET status = 'error',
           error_msg = 'Redis not available — transcription worker is not running',
           updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
       WHERE id = ?`
    ).run(payload.transcriptionId).catch(err => logger.error({ err, transcriptionId: payload.transcriptionId }, 'Failed to mark transcription as error'));
    logger.error({ transcriptionId: payload.transcriptionId }, 'Redis unavailable — transcription job dropped');
    return { queued: false };
  }
  const job = await q.add(payload, { jobId: payload.transcriptionId });
  logger.info({ jobId: job.id, videoId: payload.videoId, language: payload.language }, 'Transcription job queued');
  return { queued: true, jobId: job.id };
}

// ─── Stats (used by admin panel) ─────────────────────────────────────────────

async function getQueueStats() {
  const q = await getTranscodeQueue();
  if (!q) return { mode: 'inline', waiting: 0, active: 0, completed: 0, failed: 0 };

  try {
    const [waiting, active, completed, failed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
    ]);
    return { mode: 'bull', waiting, active, completed, failed };
  } catch (err) {
    logger.warn({ err: err.message }, 'getQueueStats: Redis not ready yet');
    return { mode: 'bull', waiting: 0, active: 0, completed: 0, failed: 0, redisReconnecting: true };
  }
}

async function getFailedJobs(limit = 20) {
  const q = await getTranscodeQueue();
  if (!q) return [];
  try {
    const jobs = await q.getFailed(0, limit - 1);
    return jobs.map(j => ({
      id:        j.id,
      videoId:   j.data?.videoId,
      title:     j.data?.title,
      failedAt:  j.finishedOn,
      attempts:  j.attemptsMade,
      error:     j.failedReason,
    }));
  } catch (err) {
    logger.warn({ err: err.message }, 'getFailedJobs: Redis not ready yet');
    return [];
  }
}

async function getJobProgress(videoId) {
  const q = await getTranscodeQueue();
  if (!q) return null;
  try {
    const job = await q.getJob(videoId);
    if (!job) return null;
    return job._progress ?? null;
  } catch { return null; }
}

async function retryJob(jobId) {
  const q = await getTranscodeQueue();
  if (!q) throw new Error('Queue not available');
  const job = await q.getJob(jobId);
  if (!job) throw new Error('Job not found');
  await job.retry();
}

async function cleanQueue(gracePeriodMs = 0) {
  const q = await getTranscodeQueue();
  if (!q) return { removed: 0 };
  await q.clean(gracePeriodMs, 'completed');
  await q.clean(gracePeriodMs, 'failed');
  return { ok: true };
}

// ─── Worker processors (called ONLY from worker.js) ───────────────────────────

/**
 * Register the Bull processor for transcoding jobs.
 * Must only be called from worker.js — never from server.js.
 */
async function startWorker(concurrency = 2) {
  const q = await getTranscodeQueue();
  if (!q) {
    logger.error('Cannot start transcode worker: REDIS_URL is not set');
    process.exit(1);
  }

  const { processVideo } = require('../transcoder');

  q.process(concurrency, async job => {
    const { videoId, inputPath, s3SourceKey, title, workspaceId } = job.data;
    logger.info({ jobId: job.id, videoId, s3SourceKey: !!s3SourceKey }, 'Transcode worker job started');
    await job.progress(5);
    let _lastProgressAt = 0;
    await processVideo(videoId, inputPath, title, {
      workspaceId,
      s3SourceKey,
      onProgress: async (pct) => {
        const now = Date.now();
        if (now - _lastProgressAt < 2000 && pct < 100) return;
        _lastProgressAt = now;
        await job.progress(pct);
      },
    });
    logger.info({ jobId: job.id, videoId }, 'Transcode worker job complete');
  });

  q.on('completed', job => logger.info({ jobId: job.id }, 'Transcode job completed'));
  q.on('failed', async (job, err) => {
    logger.error({ jobId: job.id, attempt: job.attemptsMade, err: err.message }, 'Transcode job failed');
    // F0.4: Clean up orphan files and mark DB status=error after all retries exhausted
    if (job.attemptsMade >= (job.opts?.attempts || 3)) {
      const db   = require('../db');
      const fs   = require('fs');
      const s3Storage = require('./s3Storage');
      const { videoId, inputPath, s3SourceKey } = job.data || {};
      if (videoId) {
        // Delete local upload file if it still exists (no s3SourceKey = local mode)
        // S3 source is kept so the user can trigger a manual retry from the dashboard.
        if (inputPath && !s3SourceKey) {
          try { fs.unlinkSync(inputPath); } catch (_) {}
        }
        await db.prepare(
          `UPDATE videos SET status = 'error', updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = ?`
        ).run(videoId).catch(e => logger.error({ e: e.message, videoId }, 'Failed to mark video as error'));
        logger.info({ videoId }, 'Marked video as error after all retries exhausted');
      }
    }
  });
  q.on('stalled',   job => logger.warn({ jobId: job.id }, 'Transcode job stalled — will retry'));
  q.on('progress',  (job, pct) => process.stdout.write(`\r[worker:transcode] Job ${job.id}: ${pct}%   `));

  logger.info({ concurrency }, 'Transcode worker processor registered');
  return q;
}

/**
 * Register the Bull processor for Whisper transcription jobs.
 * Must only be called from worker.js — never from server.js.
 */
async function startTranscribeWorker(concurrency = 2) {
  const q = await getTranscriptionQueue();
  if (!q) {
    logger.warn('Redis not available — transcription worker not started');
    return null;
  }

  const db = require('../db');
  const path = require('path');
  const fs   = require('fs');

  q.process(concurrency, async job => {
    const { transcriptionId, videoId, language } = job.data;
    logger.info({ jobId: job.id, videoId, language }, 'Transcription worker job started');

    await db.prepare(
      `UPDATE transcriptions
       SET status = 'processing',
           updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
       WHERE id = ?`
    ).run(transcriptionId);

    await job.progress(10);

    // FIX: Locate video file for transcription
    // Strategy: 1) Use original file if exists, 2) Use decrypted HLS playlist
    const videoDir = path.join(__dirname, '..', 'videos', videoId);
    
    // Strategy 1: Look for original video file (uploaded before transcoding)
    let videoPath = null;
    const possibleFiles = ['original.mp4', 'original.mov', 'original.avi', 'original.mkv', 'original.webm'];
    
    for (const filename of possibleFiles) {
      const filePath = path.join(videoDir, filename);
      if (fs.existsSync(filePath)) {
        videoPath = filePath;
        logger.info({ videoId, file: filename }, 'Using original video file for transcription');
        break;
      }
    }
    
    // Strategy 2: Use HLS playlist with decryption if original is missing
    if (!videoPath) {
      const qualityDirs = ['360p', '480p', '720p', '1080p']; // Prefer lower quality for speed
      
      for (const quality of qualityDirs) {
        const m3u8Path = path.join(videoDir, quality, 'index.m3u8');
        
        if (!fs.existsSync(m3u8Path)) continue;
        
        try {
          const m3u8Content = fs.readFileSync(m3u8Path, 'utf8');
          
          // Check if encrypted
          if (m3u8Content.includes('#EXT-X-KEY:METHOD=AES-128')) {
            // Get decryption key from database
            const videoRow = await db.prepare(`SELECT hls_key FROM videos WHERE id=?`).get(videoId);
            
            if (videoRow?.hls_key) {
              // Write key to temporary file
              const keyBytes = Buffer.from(videoRow.hls_key, 'base64');
              const keyFile = path.join(videoDir, quality, `.transcribe_key_${Date.now()}.bin`);
              fs.writeFileSync(keyFile, keyBytes);
              
              // Rewrite m3u8 to use local key file
              const rewrittenM3u8 = m3u8Content.replace(
                /#EXT-X-KEY:METHOD=AES-128,URI="[^"]+"/g,
                `#EXT-X-KEY:METHOD=AES-128,URI="${keyFile}"`
              );
              
              // Write modified playlist
              const modifiedM3u8 = path.join(videoDir, quality, `.transcribe_playlist_${Date.now()}.m3u8`);
              fs.writeFileSync(modifiedM3u8, rewrittenM3u8);
              
              videoPath = modifiedM3u8;
              logger.info({ 
                videoId, 
                quality, 
                encrypted: true,
                keyFile,
                m3u8File: modifiedM3u8
              }, 'Using decrypted HLS playlist for transcription');
              break;
            } else {
              logger.warn({ videoId, quality }, 'HLS encrypted but no key in database');
            }
          } else {
            // Not encrypted, use directly
            videoPath = m3u8Path;
            logger.info({ videoId, quality, encrypted: false }, 'Using HLS playlist for transcription');
            break;
          }
        } catch (err) {
          logger.warn({ err: err.message, videoId, quality }, 'Failed to prepare HLS for transcription');
        }
      }
    }

    if (!videoPath) {
      throw new Error('Could not locate video file for transcription. Original file may have been deleted.');
    }

    await job.progress(20);

    // Get video duration and workspace OpenAI API key from database
    const videoRow = await db.prepare(`
      SELECT v.duration, v.workspace_id, w.settings 
      FROM videos v 
      LEFT JOIN workspaces w ON w.id = v.workspace_id
      WHERE v.id = ?
    `).get(videoId);
    
    const videoDuration = videoRow?.duration || null;

    if (!videoDuration) {
      logger.warn({ videoId }, 'Video duration not found in database, transcription may have timing issues');
    }

    // Get OpenAI API key: first from workspace settings, then from .env
    let openaiApiKey = '';
    try {
      const settings = JSON.parse(videoRow?.settings || '{}');
      openaiApiKey = settings.openaiApiKey || '';
    } catch {}

    if (!openaiApiKey) {
      throw new Error('OpenAI API Key not configured. Configure your key in workspace settings.');
    }

    const { transcribeVideo } = require('./whisper');
    let vttContent, wordCount, durationSecs;
    try {
      ({ vttContent, wordCount, durationSecs } = await transcribeVideo(videoPath, language, { videoDuration, openaiApiKey }));
    } finally {
      // Clean up temp files created for encrypted HLS decryption (regardless of success/failure)
      const tempPattern = /\.(transcribe_key_|transcribe_playlist_)/;
      try {
        const videoDir = path.dirname(videoPath);
        for (const f of fs.readdirSync(videoDir)) {
          if (tempPattern.test(f)) {
            fs.unlinkSync(path.join(videoDir, f));
          }
        }
      } catch {}
    }

    await job.progress(90);

    await db.prepare(`
      UPDATE transcriptions
      SET status       = 'ready',
          vtt_content  = ?,
          word_count   = ?,
          duration_secs = ?,
          updated_at   = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ?
    `).run(vttContent, wordCount, durationSecs, transcriptionId);

    await job.progress(95);
    logger.info({ jobId: job.id, wordCount }, 'Transcription done');

    // ── AI Content Intelligence (Pro/Enterprise only) ─────────────────────
    // After the transcription is saved, check if the workspace plan qualifies
    // for AI-generated title, description and chapter suggestions via Bedrock.
    await runAiContentIntelligence({ db, videoId, vttContent, durationSecs, language });

    await job.progress(100);
    logger.info({ jobId: job.id }, 'Transcription job complete');
  });

  q.on('completed', job => logger.info({ jobId: job.id }, 'Transcription job completed'));
  q.on('failed', async (job, err) => {
    logger.error({ jobId: job.id, err: err.message }, 'Transcription job failed');
    const db = require('../db');
    await db.prepare(
      `UPDATE transcriptions
       SET status = 'error',
           error_msg = ?,
           updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
       WHERE id = ?`
    ).run(err.message.slice(0, 500), job.data?.transcriptionId).catch(() => {});
  });

  logger.info({ concurrency }, 'Transcription worker processor registered');
  return q;
}

// ─── AI Content Intelligence — post-transcription hook ───────────────────────

/**
 * After a transcription completes, check if the video's workspace is on
 * Pro or Enterprise plan. If so, call Bedrock/Claude to generate:
 *   • ai_title       — SEO-optimized title
 *   • ai_description — SEO-optimized description
 *   • ai_summary     — JSON string of chapter suggestions
 *
 * Also auto-creates chapters in the DB from the AI suggestions
 * (only if the video has no chapters yet).
 *
 * This function is fire-and-forget safe — all errors are caught and logged.
 * A failure here never affects the transcription job status.
 *
 * @param {object} params
 * @param {object} params.db            — DB instance
 * @param {string} params.videoId
 * @param {string} params.vttContent    — Full VTT text from Whisper
 * @param {number} params.durationSecs  — Video duration in seconds
 * @param {string} params.language      — Transcription language code
 */
async function runAiContentIntelligence({ db, videoId, vttContent, durationSecs, language }) {
  const AI_PLANS = new Set(['pro', 'enterprise']);

  try {
    // ── 1. Check workspace plan ───────────────────────────────────────────
    const video = await db.prepare(
      `SELECT v.title, v.workspace_id, w.plan
       FROM videos v
       LEFT JOIN workspaces w ON w.id = v.workspace_id
       WHERE v.id = ?`
    ).get(videoId);

    if (!video) {
      logger.warn({ videoId }, 'Video not found — skipping AI analysis');
      return;
    }

    if (!AI_PLANS.has(video.plan)) {
      logger.info({ videoId, plan: video.plan }, 'Plan does not include AI analysis — skipping');
      return;
    }

    logger.info({ videoId, plan: video.plan }, 'Starting AI content analysis');

    // ── 2. Call Bedrock ───────────────────────────────────────────────────
    const { analyzeTranscription } = require('./bedrock');
    const result = await analyzeTranscription({
      vttContent,
      videoTitle:   video.title,
      durationSecs: durationSecs || 0,
      language,
    });

    if (!result) {
      logger.warn({ videoId }, 'No AI result — Bedrock may not be configured');
      return;
    }

    const { aiTitle, aiDescription, aiChapters } = result;

    // ── 3. Save AI metadata to videos table ───────────────────────────────
    await db.prepare(`
      UPDATE videos
      SET ai_title        = ?,
          ai_description  = ?,
          ai_summary      = ?,
          ai_generated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT,
          updated_at      = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ?
    `).run(
      aiTitle       || null,
      aiDescription || null,
      aiChapters.length ? JSON.stringify(aiChapters) : null,
      videoId
    );

    logger.info({ videoId, titlePreview: aiTitle?.slice(0, 50), chaptersCount: aiChapters.length }, 'AI metadata saved');

    // ── 4. Auto-create chapters if none exist yet ─────────────────────────
    if (aiChapters.length > 0) {
      const existing = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM chapters WHERE video_id = ?`
      ).get(videoId);

      if (Number(existing?.cnt) === 0) {
        const { v4: uuidv4 } = require('uuid');
        for (let i = 0; i < aiChapters.length; i++) {
          const ch = aiChapters[i];
          await db.prepare(
            `INSERT INTO chapters (id, video_id, title, start_time, position) VALUES (?, ?, ?, ?, ?)`
          ).run(uuidv4(), videoId, ch.title, ch.start_time, i);
        }
        logger.info({ videoId, count: aiChapters.length }, 'Auto-created AI chapters');
      } else {
        logger.info({ videoId }, 'Video already has chapters — skipping AI auto-create');
      }
    }

  } catch (err) {
    // Non-fatal: log and continue — transcription is already saved
    logger.error({ videoId, err: err.message }, 'AI content intelligence failed');
  }
}

// ─── Expose the queue getter for worker.js heartbeat ─────────────────────────
async function getQueue() {
  return getTranscodeQueue();
}

module.exports = {
  // Producers
  addTranscodeJob,
  addTranscribeJob,
  // Stats / management
  getQueueStats,
  getJobProgress,
  getFailedJobs,
  retryJob,
  cleanQueue,
  // Worker bootstrappers (worker.js only)
  startWorker,
  startTranscribeWorker,
  // Internal
  getQueue,
};
