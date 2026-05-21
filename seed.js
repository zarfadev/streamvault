#!/usr/bin/env node
/**
 * seed.js — StreamVault bootstrap seeder
 *
 * Creates a Super Admin user + a test Workspace so you can log in immediately.
 *
 * Usage:
 *   node seed.js
 *   node seed.js --email admin@example.com --password MySecret123 --name "John Doe"
 *
 * Environment variables (override CLI flags):
 *   SEED_ADMIN_EMAIL    — super admin email    (default: admin@streamvault.local)
 *   SEED_ADMIN_PASSWORD — super admin password (default: Admin1234!)
 *   SEED_ADMIN_NAME     — display name         (default: Super Admin)
 *   DATABASE_URL        — PostgreSQL connection string (required)
 *
 * Safe to run multiple times — skips creation if the email already exists.
 */

'use strict';

require('dotenv').config();

const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ─── Parse CLI args (--key value) ────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key && val) out[key] = val;
  }
  return out;
}

const cli = parseArgs();

const ADMIN_EMAIL    = cli.email    || process.env.SEED_ADMIN_EMAIL    || 'admin@streamvault.local';
const ADMIN_PASSWORD = cli.password || process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';
const ADMIN_NAME     = cli.name     || process.env.SEED_ADMIN_NAME     || 'Super Admin';
const DATABASE_URL   = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('\n❌  DATABASE_URL is not set. Copy .env.example to .env and configure it.\n');
  process.exit(1);
}

if (ADMIN_PASSWORD.length < 8) {
  console.error('\n❌  Password must be at least 8 characters.\n');
  process.exit(1);
}

// ─── DB connection ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ─── Retry helper — wait for PG to be ready ──────────────────────────────────
async function waitForDb(retries = 10, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries) throw err;
      console.log(`  ⏳ Waiting for database… (attempt ${i}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱  StreamVault Seeder\n');
  console.log(`  Email    : ${ADMIN_EMAIL}`);
  console.log(`  Name     : ${ADMIN_NAME}`);
  console.log(`  Database : ${DATABASE_URL.replace(/:([^:@]+)@/, ':****@')}\n`);

  // 1. Wait for DB
  console.log('  Connecting to database…');
  await waitForDb();
  console.log('  ✓ Database reachable\n');

  // 2. Ensure schema tables exist (run the same idempotent schema as the app)
  console.log('  Applying schema…');
  const { createSchema } = require('./db/schema');
  await createSchema(pool);
  console.log('  ✓ Schema ready\n');

  // 3. Check if admin already exists
  const { rows: existing } = await pool.query(
    'SELECT id, platform_role FROM users WHERE email = $1',
    [ADMIN_EMAIL.toLowerCase()]
  );

  let adminId;

  if (existing.length) {
    adminId = existing[0].id;
    const alreadyAdmin = existing[0].platform_role === 'super_admin';

    if (alreadyAdmin) {
      console.log(`  ℹ️  User "${ADMIN_EMAIL}" already exists as super_admin — skipping user creation.\n`);
    } else {
      // Promote existing user to super_admin
      await pool.query(
        `UPDATE users SET platform_role = 'super_admin', updated_at = $1 WHERE id = $2`,
        [Math.floor(Date.now() / 1000), adminId]
      );
      console.log(`  ✓ Existing user "${ADMIN_EMAIL}" promoted to super_admin.\n`);
    }
  } else {
    // Create new super admin user
    adminId = uuidv4();
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const now  = Math.floor(Date.now() / 1000);

    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, email_verified, platform_role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'super_admin', $5, $5)`,
      [adminId, ADMIN_EMAIL.toLowerCase(), hash, ADMIN_NAME, now]
    );
    console.log(`  ✓ Super admin created: ${ADMIN_EMAIL}\n`);
  }

  // 4. Create a test workspace (if none exists for this user)
  const { rows: wsRows } = await pool.query(
    'SELECT id FROM workspaces WHERE owner_id = $1 LIMIT 1',
    [adminId]
  );

  if (wsRows.length) {
    console.log(`  ℹ️  Workspace already exists for this user (id: ${wsRows[0].id}) — skipping.\n`);
  } else {
    const wsId   = uuidv4();
    const slug   = `test-${wsId.slice(0, 8)}`;
    const now    = Math.floor(Date.now() / 1000);
    const maxVid = -1;   // unlimited videos
    const maxSto = -1;   // unlimited storage  (-1 = skip limit check)
    const maxBw  = -1;   // unlimited bandwidth (-1 = skip limit check)

    await pool.query(
      `INSERT INTO workspaces
         (id, name, slug, owner_id, plan, max_videos, max_storage_bytes, max_bandwidth_bytes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'enterprise', $5, $6, $7, $8, $8)`,
      [wsId, 'Workspace de Prueba', slug, adminId, maxVid, maxSto, maxBw, now]
    );

    // Add owner as member
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, accepted_at, created_at)
       VALUES ($1, $2, $3, 'owner', $4, $4)`,
      [uuidv4(), wsId, adminId, now]
    );

    console.log(`  ✓ Test workspace created: "Workspace de Prueba" (slug: ${slug})\n`);
  }

  // 5. Summary
  console.log('─'.repeat(52));
  console.log('  🎉  Seed complete! You can now log in:\n');
  console.log(`  URL      : http://localhost:${process.env.PORT || 3000}/login`);
  console.log(`  Email    : ${ADMIN_EMAIL}`);
  console.log(`  Password : ${ADMIN_PASSWORD}`);
  console.log(`  Role     : super_admin  →  redirects to /admin`);
  console.log('─'.repeat(52) + '\n');
}

main()
  .catch(err => {
    console.error('\n❌  Seed failed:', err.message);
    if (process.env.NODE_ENV !== 'production') console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
