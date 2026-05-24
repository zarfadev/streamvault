// Retry ERROR videos and re-queue STUCK transcoding videos
const db = require('../db');
const { addTranscodeJob } = require('../services/queue');

db.init().then(async () => {
  let retried = 0;

  // 1. Retry ERROR videos that have a source file
  const errors = await db.pool.query(`
    SELECT v.id, v.source_file, v.workspace_id, w.plan
    FROM videos v
    LEFT JOIN workspaces w ON w.id = v.workspace_id
    WHERE v.status = 'error' AND v.source_file IS NOT NULL
    LIMIT 20
  `);
  console.log(`Found ${errors.rows.length} ERROR videos to retry`);
  for (const v of errors.rows) {
    await db.pool.query(`UPDATE videos SET status='transcoding', transcoding_pct=0 WHERE id=$1`, [v.id]);
    const isS3 = v.source_file && !v.source_file.startsWith('/');
    await addTranscodeJob({
      videoId: v.id,
      inputPath: isS3 ? null : v.source_file,
      s3SourceKey: isS3 ? v.source_file : null,
      title: 'retry',
      workspaceId: v.workspace_id,
      plan: v.plan || 'starter',
    });
    console.log('  Queued ERROR:', v.id.slice(0, 8));
    retried++;
  }

  // 2. Re-queue STUCK transcoding (>25 min, no qualities produced)
  const stuck = await db.pool.query(`
    SELECT v.id, v.source_file, v.workspace_id, w.plan
    FROM videos v
    LEFT JOIN workspaces w ON w.id = v.workspace_id
    WHERE v.status = 'transcoding'
      AND (v.qualities = '[]' OR v.qualities IS NULL OR v.qualities = '')
      AND v.source_file IS NOT NULL
      AND FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - v.created_at > 1500
  `);
  console.log(`Found ${stuck.rows.length} STUCK videos to re-queue`);
  for (const v of stuck.rows) {
    await db.pool.query(`UPDATE videos SET status='transcoding', transcoding_pct=0 WHERE id=$1`, [v.id]);
    const isS3 = v.source_file && !v.source_file.startsWith('/');
    await addTranscodeJob({
      videoId: v.id,
      inputPath: isS3 ? null : v.source_file,
      s3SourceKey: isS3 ? v.source_file : null,
      title: 'retry-stuck',
      workspaceId: v.workspace_id,
      plan: v.plan || 'starter',
    });
    console.log('  Re-queued STUCK:', v.id.slice(0, 8));
    retried++;
  }

  const { getQueueStats } = require('../services/queue');
  const q = await getQueueStats();
  console.log(`\nTotal re-queued: ${retried}`);
  console.log('Queue now:', JSON.stringify(q));
  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
