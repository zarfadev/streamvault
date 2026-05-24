// Fix videos that have qualities[] but no CDN url (orphaned local transcode)
// These videos show "Video no disponible" because the local files were deleted
// but S3 upload never completed (disk was full). Reset so watch page shows processing.
const db = require('../db');

db.init().then(async () => {
  const r = await db.pool.query(`
    UPDATE videos
    SET qualities = '[]', transcoding_pct = 0
    WHERE status = 'transcoding'
      AND hls_cdn_url IS NULL
      AND qualities IS NOT NULL
      AND qualities != '[]'
      AND qualities != ''
    RETURNING id, qualities
  `);
  console.log(`Fixed ${r.rowCount} videos with orphaned qualities (no CDN url)`);
  r.rows.forEach(v => console.log(' ', v.id.slice(0, 8), '← was:', v.qualities));
  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
