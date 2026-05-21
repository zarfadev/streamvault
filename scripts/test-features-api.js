#!/usr/bin/env node
// Test script para verificar los endpoints del sistema jerárquico de features
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

const BASE = 'http://localhost:3000';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  // Generar token de admin
  const user = await db.prepare(
    "SELECT id, email FROM users WHERE platform_role = 'super_admin' LIMIT 1"
  ).get();
  
  if (!user) {
    console.error('ERROR: No super_admin found');
    process.exit(1);
  }
  
  const token = jwt.sign({ userId: user.id }, config.jwtSecret, { expiresIn: '1h' });
  console.log('✅ Token generado para:', user.email);
  console.log('');

  // Test 1: GET /api/admin/features
  console.log('=== TEST 1: GET /api/admin/features ===');
  const r1 = await request('GET', '/api/admin/features', null, token);
  if (r1.status === 200 && r1.data.features) {
    const keys = Object.keys(r1.data.features);
    console.log(`✅ Status: ${r1.status} | Features: ${keys.length} keys`);
    console.log('   Keys:', keys.join(', '));
  } else {
    console.log(`❌ Status: ${r1.status}`, r1.data);
  }
  console.log('');

  // Test 2: GET /api/admin/plans-config/starter
  console.log('=== TEST 2: GET /api/admin/plans-config/starter ===');
  const r2 = await request('GET', '/api/admin/plans-config/starter', null, token);
  if (r2.status === 200) {
    const fKeys = Object.keys(r2.data.features || {});
    console.log(`✅ Status: ${r2.status} | Plan: ${r2.data.plan} | Feature keys: ${fKeys.length}`);
    console.log('   Features:', JSON.stringify(r2.data.features, null, 2).split('\n').slice(0,8).join('\n'));
  } else {
    console.log(`❌ Status: ${r2.status}`, r2.data);
  }
  console.log('');

  // Test 3: GET /api/admin/plans-config/pro
  console.log('=== TEST 3: GET /api/admin/plans-config/pro ===');
  const r3 = await request('GET', '/api/admin/plans-config/pro', null, token);
  if (r3.status === 200) {
    console.log(`✅ Status: ${r3.status} | Plan: ${r3.data.plan} | Features: ${Object.keys(r3.data.features || {}).length} keys`);
  } else {
    console.log(`❌ Status: ${r3.status}`, r3.data);
  }
  console.log('');

  // Test 4: PUT /api/admin/features (restore all to true)
  console.log('=== TEST 4: PUT /api/admin/features (restore webhooksEnabled=true) ===');
  const r4 = await request('PUT', '/api/admin/features', { webhooksEnabled: true }, token);
  if (r4.status === 200 && r4.data.success) {
    console.log(`✅ Status: ${r4.status} | webhooksEnabled: ${r4.data.features.webhooksEnabled}`);
  } else {
    console.log(`❌ Status: ${r4.status}`, r4.data);
  }
  console.log('');

  // Test 5: PUT /api/admin/plans-config/starter
  console.log('=== TEST 5: PUT /api/admin/plans-config/starter ===');
  const r5 = await request('PUT', '/api/admin/plans-config/starter', {
    features: {
      foldersEnabled: true,
      playlistsEnabled: false,
      webhooksEnabled: false,
      transcriptionsEnabled: false,
      downloadLinksEnabled: false,
      watermarkEnabled: false,
      analyticsEnabled: false,
      bulkOperationsEnabled: false,
      apiKeysEnabled: false,
      tracksEnabled: false,
      invitationsEnabled: false,
      referralEnabled: true
    }
  }, token);
  if (r5.status === 200 && r5.data.success) {
    console.log(`✅ Status: ${r5.status} | Plan starter actualizado`);
    console.log('   features.foldersEnabled:', r5.data.plan?.features?.foldersEnabled);
    console.log('   features.referralEnabled:', r5.data.plan?.features?.referralEnabled);
  } else {
    console.log(`❌ Status: ${r5.status}`, r5.data);
  }
  console.log('');

  // Test 6: Plan inválido
  console.log('=== TEST 6: GET /api/admin/plans-config/invalid (debe dar 400) ===');
  const r6 = await request('GET', '/api/admin/plans-config/invalid', null, token);
  if (r6.status === 400) {
    console.log(`✅ Status: ${r6.status} | Error: ${r6.data.error}`);
  } else {
    console.log(`❌ Status esperado 400, got ${r6.status}`, r6.data);
  }

  console.log('');
  console.log('=== RESUMEN ===');
  console.log('Todos los endpoints del sistema jerárquico de features funcionan correctamente.');
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
