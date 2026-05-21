#!/usr/bin/env node
/**
 * Crea (o actualiza) una cuenta super_admin directamente en la DB.
 * Uso: node scripts/create-super-admin.js <email> <password>
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const [,, email, password] = process.argv;
if (!email) {
  console.error('Uso: node scripts/create-super-admin.js <email> [password]');
  process.exit(1);
}

const pwd = password || crypto.randomBytes(10).toString('base64url');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    const hash = bcrypt.hashSync(pwd, 12);
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();
    const lowerEmail = email.trim().toLowerCase();

    const { rows: existing } = await pool.query(
      `SELECT id, platform_role FROM users WHERE email = $1`, [lowerEmail]
    );

    if (existing.length) {
      await pool.query(
        `UPDATE users SET password_hash = $1, platform_role = 'super_admin', updated_at = $2 WHERE email = $3`,
        [hash, now, lowerEmail]
      );
      console.log(`\n✓ Cuenta existente actualizada → super_admin`);
    } else {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, platform_role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'super_admin', $5, $5)`,
        [id, lowerEmail, hash, 'Admin', now]
      );
      console.log(`\n✓ Cuenta creada`);
    }

    console.log(`  Email   : ${lowerEmail}`);
    console.log(`  Password: ${pwd}`);
    console.log(`  Rol     : super_admin\n`);
  } finally {
    await pool.end();
  }
})();
