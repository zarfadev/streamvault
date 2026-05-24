// Quick diagnostic: check videos with error/transcoding status
const db = require('../db');

db.init().then(async () => {
  const errors = await db.prepare(
    `SELECT id, title, status, qualities, created_at FROM videos WHERE status IN ('error','transcoding') ORDER BY created_at DESC LIMIT 10`
  ).all();
  
  console.log('=== Videos con problemas ===');
  errors.forEach(v => {
    const q = JSON.parse(v.qualities || '[]').join(',') || 'ninguna';
    console.log(`${v.status.padEnd(12)} ${v.id.slice(0,8)} [${q}] | ${(v.title || '').slice(0, 40)}`);
  });
  console.log(`\nTotal: ${errors.length}`);

  const ready = await db.prepare(
    `SELECT id, title, qualities FROM videos WHERE status='ready' ORDER BY created_at DESC LIMIT 5`
  ).all();
  
  console.log('\n=== Videos ready recientes ===');
  ready.forEach(v => {
    const q = JSON.parse(v.qualities || '[]').join(',');
    console.log(`${v.id.slice(0,8)} [${q}] | ${(v.title || '').slice(0, 40)}`);
  });

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
