// Check if all videos are stored in S3 or if any remain local
const db = require('../db');
const fs = require('fs');
const path = require('path');

db.init().then(async () => {
  // 1. Check DB: how many videos have CDN url (= stored in S3) vs not
  const r = await db.pool.query(`
    SELECT 
      COUNT(*) FILTER(WHERE hls_cdn_url IS NOT NULL) as s3_count,
      COUNT(*) FILTER(WHERE hls_cdn_url IS NULL) as no_cdn_count,
      COUNT(*) as total
    FROM videos 
    WHERE status = 'ready'
  `);
  const row = r.rows[0];
  console.log('=== VIDEOS EN DB ===');
  console.log('Total ready:', row.total);
  console.log('Con CDN url (en S3 + CloudFront):', row.s3_count);
  console.log('Sin CDN url:', row.no_cdn_count);

  // 2. Check if any have CDN url pointing to CloudFront
  const sample = await db.pool.query(`
    SELECT id, title, hls_cdn_url FROM videos 
    WHERE status = 'ready' 
    ORDER BY created_at DESC LIMIT 5
  `);
  console.log('\n=== VIDEOS RECIENTES ===');
  sample.rows.forEach(v => {
    const loc = v.hls_cdn_url ? 'S3/CDN: ' + v.hls_cdn_url.slice(0, 60) : 'LOCAL (sin CDN)';
    console.log(`${v.id.slice(0,8)} | ${(v.title||'').slice(0,30)} | ${loc}`);
  });

  // 3. Check local videos directory
  const localDir = '/app/videos';
  let localCount = 0;
  try {
    const entries = fs.readdirSync(localDir);
    const videoFolders = entries.filter(e => {
      try {
        return fs.statSync(path.join(localDir, e)).isDirectory();
      } catch { return false; }
    });
    localCount = videoFolders.length;
    console.log('\n=== DIRECTORIO LOCAL /app/videos ===');
    console.log('Carpetas de video en disco local:', localCount);
    if (videoFolders.length > 0) {
      console.log('ATENCIÓN: Hay videos en disco local:', videoFolders.join(', '));
    } else {
      console.log('OK: No hay videos en disco local (todos en S3)');
    }
  } catch (e) {
    console.log('Directorio /app/videos:', e.message);
  }

  // 4. Check worker tmp files
  const tmpDir = '/tmp';
  try {
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('sv-src-'));
    console.log('\n=== WORKER TMP (/tmp) ===');
    console.log('Sources en /tmp:', tmpFiles.length);
    if (tmpFiles.length > 0) {
      let totalSize = 0;
      tmpFiles.forEach(f => {
        try {
          const stat = fs.statSync(path.join(tmpDir, f));
          totalSize += stat.size;
        } catch {}
      });
      console.log('Tamaño total:', (totalSize / 1024 / 1024 / 1024).toFixed(2), 'GB');
      console.log('Estos son sources temporales usados durante transcodificación');
    }
  } catch (e) {
    console.log('No se pudo leer /tmp:', e.message);
  }

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
