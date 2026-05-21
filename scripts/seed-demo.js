#!/usr/bin/env node
/**
 * seed-demo.js — StreamVault demo seed (SIN videos reales)
 *
 * Crea un entorno de demo completo con usuarios, workspaces, carpetas,
 * playlists, analíticas, API keys, webhooks, billing y audit log.
 * NO inserta videos para evitar referencias a archivos inexistentes.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/seed-demo.js
 *   docker exec streamvault_api node scripts/seed-demo.js
 *
 * ⚠ Borra TODOS los datos existentes antes de insertar.
 */

'use strict';
require('dotenv').config();

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL no está definida');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 15_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const NOW          = Math.floor(Date.now() / 1000);
const DAY          = 86400;
const daysAgo      = n => NOW - n * DAY;
const daysFromNow  = n => NOW + n * DAY;
const rnd          = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const hashPwd      = pwd => bcrypt.hash(pwd, 10);
const GB           = n => BigInt(Math.round(n * 1e9));

async function main() {
  console.log('\n🌱  StreamVault — Seed de Demo (sin videos)\n');

  // ── 0. Esperar DB ──────────────────────────────────────────────────────────
  for (let i = 1; i <= 15; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) {
      if (i === 15) throw e;
      console.log(`  ⏳ Esperando base de datos… (${i}/15)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('  ✓ Base de datos conectada\n');

  // ── 1. Schema idempotente ──────────────────────────────────────────────────
  console.log('  Aplicando schema…');
  const { createSchema } = require('../db/schema');
  await createSchema(pool);
  console.log('  ✓ Schema listo\n');

  // ── 2. Limpiar datos existentes ────────────────────────────────────────────
  console.log('  Limpiando datos existentes…');
  await pool.query(`
    TRUNCATE TABLE
      webhook_deliveries, webhooks,
      audit_log,
      subscription_events, payment_invoices,
      events, video_progress,
      chapters, transcriptions, video_tracks,
      playlist_videos, playlists,
      api_keys,
      revoked_tokens,
      workspace_invitations, workspace_members,
      referrals,
      refresh_tokens,
      status_checks,
      videos, folders,
      workspaces, users
    RESTART IDENTITY CASCADE
  `);
  console.log('  ✓ Datos eliminados\n');

  // ── 3. Usuarios ────────────────────────────────────────────────────────────
  console.log('  Creando usuarios…');

  const adminId   = uuidv4();
  const mariaId   = uuidv4();
  const sofiaId   = uuidv4();
  const robertoId = uuidv4();
  const carlosId  = uuidv4();
  const pabloId   = uuidv4();

  const USERS = [
    { id: adminId,   email: 'admin@streamvault.io',           name: 'Admin StreamVault', pwd: 'Admin@SV2024!',     role: 'super_admin', ref: 'SV-ADMIN-001' },
    { id: mariaId,   email: 'maria.gomez@streamingpro.com',   name: 'María Gómez',       pwd: 'Maria@Pro2024!',    role: 'user',        ref: 'MARIA-REF-01' },
    { id: sofiaId,   email: 'sofia.ramirez@streamingpro.com', name: 'Sofía Ramírez',     pwd: 'Sofia@Admin2024!',  role: 'user',        ref: 'SOFIA-REF-01' },
    { id: robertoId, email: 'roberto.silva@gmail.com',        name: 'Roberto Silva',     pwd: 'Roberto@View2024!', role: 'user',        ref: 'ROB-REF-0001' },
    { id: carlosId,  email: 'carlos.lopez@miempresa.io',      name: 'Carlos López',      pwd: 'Carlos@Start2024!', role: 'user',        ref: 'CARL-REF-01' },
    { id: pabloId,   email: 'pablo.torres@suspendido.co',     name: 'Pablo Torres',      pwd: 'Pablo@Susp2024!',   role: 'user',        ref: 'PABL-REF-01' },
  ];

  for (const u of USERS) {
    const h = await hashPwd(u.pwd);
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, platform_role, email_verified, referral_code, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7)`,
      [u.id, u.email, h, u.name, u.role, u.ref, daysAgo(rnd(90, 180))]
    );
  }
  console.log(`  ✓ ${USERS.length} usuarios creados\n`);

  // ── 4. Workspaces ──────────────────────────────────────────────────────────
  console.log('  Creando workspaces…');

  const wsAdminId     = uuidv4();
  const wsProId       = uuidv4();
  const wsStarterId   = uuidv4();
  const wsSuspendedId = uuidv4();

  // Enterprise — StreamVault HQ
  await pool.query(`
    INSERT INTO workspaces
      (id, name, slug, owner_id, plan,
       max_videos, max_storage_bytes, max_bandwidth_bytes,
       storage_used_bytes, bandwidth_used_bytes,
       settings, created_at, updated_at)
    VALUES ($1,$2,$3,$4,'enterprise',
            -1, -1, -1,
            $5, $6,
            $7, $8, $8)`,
    [
      wsAdminId, 'StreamVault HQ', 'streamvault-hq', adminId,
      GB(15), GB(450),
      JSON.stringify({
        embedAllowedDomains: ['streamvault.io', 'demo.streamvault.io'],
        playerBranding: { color: '#6366f1', showLogo: false },
        watermark: { enabled: false },
      }),
      daysAgo(180),
    ]
  );

  // Pro — StreamingPro Media
  await pool.query(`
    INSERT INTO workspaces
      (id, name, slug, owner_id, plan,
       max_videos, max_storage_bytes, max_bandwidth_bytes,
       storage_used_bytes, bandwidth_used_bytes,
       stripe_customer_id, stripe_subscription_id,
       settings, created_at, updated_at)
    VALUES ($1,$2,$3,$4,'pro',
            200, $5, $6,
            $7, $8,
            'cus_QxK9mN3pL2jR8v', 'sub_1QxPro2Kj8mN9pL',
            $9, $10, $10)`,
    [
      wsProId, 'StreamingPro Media', 'streamingpro-media', mariaId,
      GB(500), GB(1000),
      GB(187), GB(620),
      JSON.stringify({
        embedAllowedDomains: ['streamingpro.com', 'embed.streamingpro.com'],
        playerBranding: { color: '#10b981', showLogo: true },
        watermark: { enabled: true, text: 'StreamingPro', position: 'bottom-right', opacity: 0.3 },
      }),
      daysAgo(120),
    ]
  );

  // Starter — MiEmpresa Digital
  await pool.query(`
    INSERT INTO workspaces
      (id, name, slug, owner_id, plan,
       max_videos, max_storage_bytes, max_bandwidth_bytes,
       storage_used_bytes, bandwidth_used_bytes,
       created_at, updated_at)
    VALUES ($1,$2,$3,$4,'starter',
            25, $5, $6,
            $7, $8,
            $9, $9)`,
    [
      wsStarterId, 'MiEmpresa Digital', 'miempresa-digital', carlosId,
      GB(50), GB(100),
      GB(8), GB(34),
      daysAgo(45),
    ]
  );

  // Pro SUSPENDIDO — MediaCorp TV
  await pool.query(`
    INSERT INTO workspaces
      (id, name, slug, owner_id, plan,
       max_videos, max_storage_bytes, max_bandwidth_bytes,
       storage_used_bytes, bandwidth_used_bytes,
       suspended,
       stripe_customer_id, stripe_subscription_id,
       created_at, updated_at)
    VALUES ($1,$2,$3,$4,'pro',
            200, $5, $6,
            $7, $8,
            1,
            'cus_Susp7mN3pLxyz','sub_SuspKj9pLabc',
            $9, $9)`,
    [
      wsSuspendedId, 'MediaCorp TV', 'mediacorp-tv', pabloId,
      GB(500), GB(1000),
      GB(92), GB(310),
      daysAgo(60),
    ]
  );

  console.log('  ✓ 4 workspaces creados\n');

  // ── 5. Miembros de workspace ───────────────────────────────────────────────
  const MEMBERS = [
    { ws: wsAdminId,     user: adminId,    role: 'owner' },
    { ws: wsProId,       user: mariaId,    role: 'owner' },
    { ws: wsProId,       user: sofiaId,    role: 'admin' },
    { ws: wsProId,       user: robertoId,  role: 'viewer' },
    { ws: wsStarterId,   user: carlosId,   role: 'owner' },
    { ws: wsSuspendedId, user: pabloId,    role: 'owner' },
  ];
  for (const m of MEMBERS) {
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, accepted_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)`,
      [uuidv4(), m.ws, m.user, m.role, daysAgo(60)]
    );
  }
  console.log('  ✓ Miembros de workspace asignados\n');

  // ── 6. Carpetas ────────────────────────────────────────────────────────────
  const folderTutId  = uuidv4();
  const folderWebId  = uuidv4();
  const folderMktId  = uuidv4();
  const folderProdId = uuidv4();

  const FOLDERS = [
    { id: folderTutId,  ws: wsProId,     name: 'Tutoriales',          parent: null        },
    { id: folderWebId,  ws: wsProId,     name: 'Webinars',            parent: null        },
    { id: folderMktId,  ws: wsProId,     name: 'Marketing',           parent: null        },
    { id: folderProdId, ws: wsProId,     name: 'Demos de Producto',   parent: folderMktId },
    { id: uuidv4(),     ws: wsAdminId,   name: 'Onboarding',          parent: null        },
    { id: uuidv4(),     ws: wsAdminId,   name: 'Internas',            parent: null        },
    { id: uuidv4(),     ws: wsStarterId, name: 'Videos corporativos', parent: null        },
  ];
  for (const f of FOLDERS) {
    await pool.query(
      `INSERT INTO folders (id, workspace_id, name, parent_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [f.id, f.ws, f.name, f.parent, daysAgo(80)]
    );
  }
  console.log('  ✓ Carpetas creadas\n');

  // ── 7. Playlists vacías (sin videos) ──────────────────────────────────────
  const pl1Id = uuidv4();
  const pl2Id = uuidv4();
  await pool.query(
    `INSERT INTO playlists (id, workspace_id, title, description, visibility, created_at, updated_at) VALUES ($1,$2,$3,$4,'public',$5,$5)`,
    [pl1Id, wsProId, 'Curso completo de streaming profesional', 'Todo para dominar el video streaming desde cero.', daysAgo(70)]
  );
  await pool.query(
    `INSERT INTO playlists (id, workspace_id, title, description, visibility, created_at, updated_at) VALUES ($1,$2,$3,$4,'public',$5,$5)`,
    [pl2Id, wsProId, 'Webinars y masterclasses 2025', 'Colección de nuestros mejores webinars del año.', daysAgo(50)]
  );
  console.log('  ✓ Playlists creadas (vacías — sin videos)\n');

  // ── 8. API Keys ────────────────────────────────────────────────────────────
  const rawKey1    = `sv_live_${crypto.randomBytes(24).toString('hex')}`;
  const rawKey2    = `sv_live_${crypto.randomBytes(24).toString('hex')}`;
  const rawKeyAdmin = `sv_live_${crypto.randomBytes(24).toString('hex')}`;

  await pool.query(
    `INSERT INTO api_keys (id, workspace_id, name, key_hash, prefix, scopes, last_used_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv4(), wsProId, 'Producción (acceso completo)',
     crypto.createHash('sha256').update(rawKey1).digest('hex'), rawKey1.slice(0, 12),
     JSON.stringify(['videos:read','videos:write','videos:delete','analytics:read','playlists:read','playlists:write']),
     daysAgo(1), daysAgo(100)]
  );
  await pool.query(
    `INSERT INTO api_keys (id, workspace_id, name, key_hash, prefix, scopes, last_used_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv4(), wsProId, 'Zapier (solo lectura)',
     crypto.createHash('sha256').update(rawKey2).digest('hex'), rawKey2.slice(0, 12),
     JSON.stringify(['videos:read','analytics:read']),
     daysAgo(2), daysAgo(60)]
  );
  await pool.query(
    `INSERT INTO api_keys (id, workspace_id, name, key_hash, prefix, scopes, last_used_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv4(), wsAdminId, 'Admin CI/CD',
     crypto.createHash('sha256').update(rawKeyAdmin).digest('hex'), rawKeyAdmin.slice(0, 12),
     JSON.stringify(['videos:read','videos:write','analytics:read']),
     daysAgo(0), daysAgo(30)]
  );
  console.log('  ✓ API keys creadas\n');

  // ── 9. Webhooks ────────────────────────────────────────────────────────────
  const wh1Id     = uuidv4();
  const wh1Secret = `whsec_${crypto.randomBytes(20).toString('hex')}`;
  await pool.query(
    `INSERT INTO webhooks (id, workspace_id, url, events, secret, enabled, created_at) VALUES ($1,$2,$3,$4,$5,1,$6)`,
    [wh1Id, wsProId, 'https://hooks.zapier.com/hooks/catch/12345678/abcdef/',
     JSON.stringify(['video.ready','video.deleted','video.updated']),
     wh1Secret, daysAgo(60)]
  );

  const DELIVERIES = [
    { event: 'video.ready',   code: 200, d: 5  },
    { event: 'video.ready',   code: 200, d: 12 },
    { event: 'video.deleted', code: 200, d: 15 },
    { event: 'video.ready',   code: 500, d: 20 },
    { event: 'video.ready',   code: 200, d: 25 },
    { event: 'video.updated', code: 200, d: 30 },
  ];
  for (const d of DELIVERIES) {
    await pool.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, response_body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), wh1Id, d.event, `{"event":"${d.event}","videoId":"demo-video-id"}`,
       d.code, d.code === 200 ? '{"ok":true}' : '{"error":"Internal Server Error"}', daysAgo(d.d)]
    );
  }
  console.log('  ✓ Webhooks e historial de entregas creados\n');

  // ── 10. Facturación ────────────────────────────────────────────────────────
  console.log('  Creando historial de facturación…');
  for (let mes = 3; mes >= 1; mes--) {
    const pStart = daysAgo(mes * 30 + 30);
    const pEnd   = daysAgo(mes * 30);
    await pool.query(
      `INSERT INTO payment_invoices
         (id, workspace_id, invoice_number, amount, currency, status, provider, plan,
          description, period_start, period_end, provider_invoice_id, created_at, paid_at)
       VALUES ($1,$2,$3,59.00,'USD','paid','stripe','pro',$4,$5,$6,$7,$8,$8)`,
      [uuidv4(), wsProId, `INV-2025-${String(mes).padStart(3,'0')}`,
       'Plan Pro — StreamingPro Media', pStart, pEnd,
       `in_${crypto.randomBytes(8).toString('hex')}`, pStart]
    );
  }
  await pool.query(
    `INSERT INTO subscription_events
       (id, workspace_id, event_type, from_plan, to_plan, provider, subscription_id, metadata, created_at)
     VALUES ($1,$2,'upgraded','starter','pro','stripe','sub_1QxPro2Kj8mN9pL',$3,$4)`,
    [uuidv4(), wsProId, JSON.stringify({ price: 59, currency: 'USD' }), daysAgo(120)]
  );
  await pool.query(
    `INSERT INTO subscription_events
       (id, workspace_id, event_type, from_plan, to_plan, provider, subscription_id, metadata, created_at)
     VALUES ($1,$2,'suspended',null,null,'stripe','sub_SuspKj9pLabc',$3,$4)`,
    [uuidv4(), wsSuspendedId, JSON.stringify({ reason: 'payment_failed', retries: 3 }), daysAgo(10)]
  );
  console.log('  ✓ Facturación creada\n');

  // ── 11. Invitación pendiente ───────────────────────────────────────────────
  await pool.query(
    `INSERT INTO workspace_invitations
       (id, workspace_id, email, role, token, invited_by, expires_at, created_at)
     VALUES ($1,$2,'nuevoadmin@empresa.com','admin',$3,$4,$5,$6)`,
    [uuidv4(), wsProId, crypto.randomBytes(32).toString('hex'), mariaId, daysFromNow(7), daysAgo(1)]
  );
  console.log('  ✓ Invitación pendiente creada\n');

  // ── 12. System config ──────────────────────────────────────────────────────
  const SYS_CFG = [
    ['guest_config',             JSON.stringify({ enabled: true, maxFileSizeMB: 2048, expiryHours: 24, maxVideos: 3 })],
    ['payment_gateways',         JSON.stringify({ stripe: { enabled: true, default: true }, paypal: { enabled: false }, binance: { enabled: false } })],
    ['plan_features',            JSON.stringify({
      starter:    { customPlayer: false, apiAccess: false, analytics: 'basic',  subtitles: false, customDomain: false, watermark: false, chapters: true,  playlists: true, webhooks: false, apiKeys: false },
      pro:        { customPlayer: true,  apiAccess: true,  analytics: 'full',   subtitles: true,  customDomain: true,  watermark: true,  chapters: true,  playlists: true, webhooks: true,  apiKeys: true  },
      enterprise: { customPlayer: true,  apiAccess: true,  analytics: 'full',   subtitles: true,  customDomain: true,  watermark: true,  chapters: true,  playlists: true, webhooks: true,  apiKeys: true  },
    })],
    ['maintenance_mode',          'false'],
    ['allow_new_registrations',   'true'],
    ['default_video_visibility',  '"public"'],
    ['max_upload_size_mb',        '10240'],
    ['platform_name',             '"StreamVault"'],
    ['support_email',             '"soporte@streamvault.io"'],
  ];
  for (const [k, v] of SYS_CFG) {
    await pool.query(
      `INSERT INTO system_config (key, value, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=$3`,
      [k, v, NOW]
    );
  }
  console.log('  ✓ Configuración del sistema establecida\n');

  // ── 13. Audit log ──────────────────────────────────────────────────────────
  const AUDIT = [
    { actor: adminId,  email: 'admin@streamvault.io',           action: 'workspace_suspended', type: 'workspace',    target: wsSuspendedId, meta: { reason: 'payment_failed' }, d: 10 },
    { actor: adminId,  email: 'admin@streamvault.io',           action: 'plan_config_updated', type: 'system_config',target: 'plans.pro',   meta: { price: 59 },               d: 45 },
    { actor: mariaId,  email: 'maria.gomez@streamingpro.com',   action: 'member_invited',      type: 'invitation',   target: 'nuevoadmin@empresa.com', meta: { role: 'admin' }, d: 1 },
    { actor: mariaId,  email: 'maria.gomez@streamingpro.com',   action: 'webhook_created',     type: 'webhook',      target: wh1Id,         meta: { url: 'hooks.zapier.com' }, d: 60 },
    { actor: sofiaId,  email: 'sofia.ramirez@streamingpro.com', action: 'playlist_created',    type: 'playlist',     target: pl1Id,         meta: { title: 'Curso completo' }, d: 70 },
    { actor: carlosId, email: 'carlos.lopez@miempresa.io',      action: 'workspace_created',   type: 'workspace',    target: wsStarterId,   meta: { plan: 'starter' },         d: 45 },
    { actor: adminId,  email: 'admin@streamvault.io',           action: 'user_promoted',       type: 'user',         target: adminId,       meta: { role: 'super_admin' },     d: 180 },
  ];
  for (const e of AUDIT) {
    await pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_email, action, target_type, target_id, metadata, ip, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv4(), e.actor, e.email, e.action, e.type, e.target, JSON.stringify(e.meta), '127.0.0.1', daysAgo(e.d)]
    );
  }
  console.log('  ✓ Audit log creado\n');

  // ── 14. Analíticas de ancho de banda (workspace level) ────────────────────
  // Simular ~60 días de bandwidth en la tabla de eventos vacía,
  // sin referenciar videos reales.
  // Los eventos requieren video_id, que no tenemos — los saltamos.
  // El storage_used / bandwidth_used ya están en el workspace row.
  console.log('  ℹ️  Sin videos reales → eventos de analítica omitidos\n');

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  console.log('═'.repeat(64));
  console.log('\n  🎉  SEED DE DEMO COMPLETADO\n');
  console.log('  ACCESOS');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  Super Admin    admin@streamvault.io         Admin@SV2024!');
  console.log('                 → /admin  (panel de administración)');
  console.log('                 → workspace: StreamVault HQ (Enterprise)');
  console.log('');
  console.log('  Owner Pro      maria.gomez@streamingpro.com Maria@Pro2024!');
  console.log('                 → workspace: StreamingPro Media (Pro)');
  console.log('                 → carpetas, playlists, billing, webhooks');
  console.log('');
  console.log('  Admin Pro      sofia.ramirez@streamingpro.com Sofia@Admin2024!');
  console.log('                 → mismo workspace (rol: admin)');
  console.log('');
  console.log('  Viewer Pro     roberto.silva@gmail.com       Roberto@View2024!');
  console.log('                 → mismo workspace (rol: viewer, sin edición)');
  console.log('');
  console.log('  Starter        carlos.lopez@miempresa.io     Carlos@Start2024!');
  console.log('                 → workspace: MiEmpresa Digital (Starter)');
  console.log('');
  console.log('  SUSPENDIDO     pablo.torres@suspendido.co    Pablo@Susp2024!');
  console.log('                 → workspace: MediaCorp TV (Pro, SUSPENDIDO)');
  console.log('');
  console.log('  DATOS GENERADOS');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  Videos:        0 (listo para subir los tuyos)');
  console.log('  Carpetas:      7 (Pro ×4, Admin ×2, Starter ×1)');
  console.log('  Playlists:     2 (vacías)');
  console.log('  Facturas:      3 meses pagados (Pro)');
  console.log('  API Keys:      3 (Pro ×2, Admin ×1)');
  console.log('  Webhooks:      1 con historial de 6 entregas');
  console.log('  Invitaciones:  1 pendiente (nuevoadmin@empresa.com)');
  console.log('  Audit log:     7 entradas');
  console.log('');
  console.log(`  URL: http://localhost:${process.env.PORT || 3000}/login`);
  console.log('═'.repeat(64) + '\n');
}

main()
  .catch(err => {
    console.error('\n❌  Seed falló:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
