// Fix stuck/error videos — retry errors, reset stuck transcoding
const db = require('../db');
const { addTranscodeJob } = require('../services/queue');

db.init().then(async () => {
  // 1. Find error videos with s3_source_key (can retry)
  const errors = await db.pool.query(`
    SELECT id, title, status, qualities, source_file, workspace_id,
           FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - created_at as age_secs
    FROM videos
    WHERE status = 'error'
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log('\n=== ERROR VIDEOS ===');
  errors.rows.forEach(v => {
    console.log(`${v.id.slice(0,8)} | ${v.title.slice(0,40)} | source: ${v.source_file ? 'YES' : 'NO'}`);
  });

  // 2. Find transcoding videos stuck >20 min with no qualities
  const stuck = await db.pool.query(`
    SELECT id, title, qualities, source_file, workspace_id,
           FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - created_at as age_secs
    FROM videos
    WHERE status = 'transcoding'
      AND FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - created_at > 1200
    ORDER BY created_at DESC
  `);
  console.log(`\n=== STUCK TRANSCODING (>20 min) ===`);
  stuck.rows.forEach(v => {
    const mins = Math.floor(v.age_secs / 60);
    const quals = JSON.parse(v.qualities || '[]');
    console.log(`${v.id.slice(0,8)} | ${mins}min | quals:[${quals.join(',')}] | source:${v.source_file ? 'YES' : 'NO'} | ${v.title.slice(0,35)}`);
  });

  // 3. Check queue
  const { getQueueStats } = require('../services/queue');
  const q = await getQueueStats();
  console.log('\n=== QUEUE ===', JSON.stringify(q));

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
