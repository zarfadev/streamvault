// Audit DB: check tables, columns, and migration status
const db = require('../db');

db.init().then(async () => {
  // 1. All tables
  const tables = await db.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  console.log('=== TABLAS EN LA DB ===');
  tables.rows.forEach(r => console.log(' ', r.tablename));
  console.log('Total:', tables.rows.length);

  // 2. Critical workspaces columns (from migrations)
  const wsCols = await db.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'workspaces' ORDER BY ordinal_position`);
  console.log('\n=== WORKSPACES columns ===');
  console.log(wsCols.rows.map(r => r.column_name).join(', '));

  // 3. Check billing tables (migration 002)
  const billingTables = ['subscriptions', 'payment_history', 'invoices'];
  console.log('\n=== BILLING TABLES ===');
  for (const t of billingTables) {
    const r = await db.pool.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [t]);
    console.log(r.rows.length ? 'OK' : 'MISSING', t);
  }

  // 4. Check system_config & plan_features (migration 005)
  const featureTables = ['system_config', 'plan_features'];
  console.log('\n=== FEATURE TABLES ===');
  for (const t of featureTables) {
    const r = await db.pool.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [t]);
    console.log(r.rows.length ? 'OK' : 'MISSING', t);
  }

  // 5. Key columns from specific migrations
  const checks = [
    ['workspaces', 'payment_gateway', '001'],
    ['workspaces', 'custom_embed_domain', '007'],
    ['workspaces', 'custom_domain_verified', '007'],
    ['videos', 'dmca_suspended', '004'],
    ['videos', 'source_file', 'schema'],
    ['videos', 'tags', 'schema'],
    ['videos', 'expires_at', 'schema'],
    ['workspaces', 'bandwidth_used_bytes', 'schema'],
  ];
  console.log('\n=== COLUMN CHECKS ===');
  for (const [tbl, col, mig] of checks) {
    const r = await db.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [tbl, col]);
    console.log(r.rows.length ? 'OK  ' : 'MISS', `${tbl}.${col} (migration ${mig})`);
  }

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
