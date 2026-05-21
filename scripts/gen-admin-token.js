#!/usr/bin/env node
// Script temporal para generar token de admin para testing
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

async function main() {
  const user = await db.prepare(
    "SELECT id, email FROM users WHERE platform_role = 'super_admin' LIMIT 1"
  ).get();
  
  if (!user) {
    console.log('ERROR: No super_admin found in database');
    process.exit(1);
  }
  
  const token = jwt.sign({ userId: user.id }, config.jwtSecret, { expiresIn: '1h' });
  console.log('EMAIL:', user.email);
  console.log('TOKEN:', token);
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
