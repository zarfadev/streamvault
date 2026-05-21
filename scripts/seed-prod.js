#!/usr/bin/env node
/**
 * seed-prod.js — StreamVault production-like seed
 *
 * Crea un conjunto realista de usuarios, workspaces, videos y configuración
 * que simula un entorno de producción para testing exhaustivo.
 *
 * Usage:
 *   docker exec streamvault_api node scripts/seed-prod.js
 *   DATABASE_URL=postgres://streamvault:streamvault@127.0.0.1:5432/streamvault node scripts/seed-prod.js
 *
 * ⚠  ADVERTENCIA: Borra TODOS los datos existentes antes de insertar.
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

// ─── Time helpers ─────────────────────────────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const daysAgo      = n => NOW - n * DAY;
const daysFromNow  = n => NOW + n * DAY;
const rnd          = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shortCode    = () => crypto.randomBytes(4).toString('hex');
const hashPwd      = pwd => bcrypt.hash(pwd, 10);

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱  StreamVault — Seed de Producción\n');

  // ── 0. Wait for DB ──────────────────────────────────────────────────────────
  for (let i = 1; i <= 15; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) {
      if (i === 15) throw e;
      console.log(`  ⏳ Esperando base de datos… (${i}/15)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('  ✓ Base de datos conectada\n');

  // ── 1. Aplicar schema (idempotente) ─────────────────────────────────────────
  console.log('  Aplicando schema…');
  const { createSchema } = require('../db/schema');
  await createSchema(pool);
  console.log('  ✓ Schema listo\n');

  // ── 2. Limpiar todos los datos ──────────────────────────────────────────────
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

  // ── 3. Usuarios ─────────────────────────────────────────────────────────────
  console.log('  Creando usuarios…');

  const adminId    = uuidv4();
  const mariaId    = uuidv4();
  const sofiaId    = uuidv4();
  const robertoId  = uuidv4();
  const carlosId   = uuidv4();
  const pabloId    = uuidv4();

  const USERS = [
    { id: adminId,   email: 'admin@streamvault.io',             name: 'Admin StreamVault',   pwd: 'Admin@SV2024!',     role: 'super_admin', ref: 'SV-ADMIN-001' },
    { id: mariaId,   email: 'maria.gomez@streamingpro.com',     name: 'María Gómez',         pwd: 'Maria@Pro2024!',    role: 'user',        ref: 'MARIA-REF-01' },
    { id: sofiaId,   email: 'sofia.ramirez@streamingpro.com',   name: 'Sofía Ramírez',       pwd: 'Sofia@Admin2024!',  role: 'user',        ref: 'SOFIA-REF-01' },
    { id: robertoId, email: 'roberto.silva@gmail.com',          name: 'Roberto Silva',       pwd: 'Roberto@View2024!', role: 'user',        ref: 'ROB-REF-0001' },
    { id: carlosId,  email: 'carlos.lopez@miempresa.io',        name: 'Carlos López',        pwd: 'Carlos@Start2024!', role: 'user',        ref: 'CARL-REF-01' },
    { id: pabloId,   email: 'pablo.torres@suspendido.co',       name: 'Pablo Torres',        pwd: 'Pablo@Susp2024!',   role: 'user',        ref: 'PABL-REF-01' },
  ];

  for (const u of USERS) {
    const h = await hashPwd(u.pwd);
    await pool.query(
      `INSERT INTO users
         (id, email, password_hash, name, platform_role, email_verified, referral_code, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7)`,
      [u.id, u.email, h, u.name, u.role, u.ref, daysAgo(rnd(90, 180))]
    );
  }
  console.log(`  ✓ ${USERS.length} usuarios creados\n`);

  // ── 4. Workspaces ───────────────────────────────────────────────────────────
  console.log('  Creando workspaces…');

  const wsAdminId     = uuidv4();
  const wsProId       = uuidv4();
  const wsStarterId   = uuidv4();
  const wsSuspendedId = uuidv4();

  const GB = n => BigInt(Math.round(n * 1e9));

  // Enterprise — StreamVault HQ (admin)
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
       payment_provider, payment_subscription_id,
       payment_metadata,
       settings, created_at, updated_at)
    VALUES ($1,$2,$3,$4,'pro',
            200, $5, $6,
            $7, $8,
            'cus_QxK9mN3pL2jR8v', 'sub_1QxPro2Kj8mN9pL',
            'stripe', 'sub_1QxPro2Kj8mN9pL',
            $9,
            $10, $11, $11)`,
    [
      wsProId, 'StreamingPro Media', 'streamingpro-media', mariaId,
      GB(500), GB(1000),
      GB(187), GB(620),
      JSON.stringify({ current_period_end: daysFromNow(14), cancel_at_period_end: false }),
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
            $9,$9)`,
    [
      wsSuspendedId, 'MediaCorp TV', 'mediacorp-tv', pabloId,
      GB(500), GB(1000),
      GB(92), GB(310),
      daysAgo(60),
    ]
  );

  console.log('  ✓ 4 workspaces creados\n');

  // ── 5. Miembros de workspace ────────────────────────────────────────────────
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

  // ── 6. Carpetas ─────────────────────────────────────────────────────────────
  const folderTutId  = uuidv4();
  const folderWebId  = uuidv4();
  const folderMktId  = uuidv4();
  const folderProdId = uuidv4();

  const FOLDERS = [
    { id: folderTutId,  ws: wsProId,     name: 'Tutoriales',        parent: null        },
    { id: folderWebId,  ws: wsProId,     name: 'Webinars',          parent: null        },
    { id: folderMktId,  ws: wsProId,     name: 'Marketing',         parent: null        },
    { id: folderProdId, ws: wsProId,     name: 'Demos de Producto', parent: folderMktId },
    { id: uuidv4(),     ws: wsAdminId,   name: 'Onboarding',        parent: null        },
    { id: uuidv4(),     ws: wsAdminId,   name: 'Internas',          parent: null        },
    { id: uuidv4(),     ws: wsStarterId, name: 'Videos corporativos',parent: null       },
  ];
  for (const f of FOLDERS) {
    await pool.query(
      `INSERT INTO folders (id, workspace_id, name, parent_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [f.id, f.ws, f.name, f.parent, daysAgo(80)]
    );
  }
  console.log('  ✓ Carpetas creadas\n');

  // ── 7. Videos ───────────────────────────────────────────────────────────────
  console.log('  Creando videos…');

  const Q3 = JSON.stringify(['360p', '720p', '1080p']);
  const Q2 = JSON.stringify(['360p', '720p']);

  // Precompute password hash for protected video (sync is fine in seed)
  const protectedHash = bcrypt.hashSync('Premium2024', 8);

  function vid(overrides) {
    return {
      id:                uuidv4(),
      title:             'Video sin título',
      description:       '',
      original_filename: 'video.mp4',
      status:            'ready',
      qualities:         Q3,
      duration:          rnd(180, 5400),
      size:              rnd(100, 3000) * 1024 * 1024,
      views:             rnd(0, 5000),
      workspace_id:      null,
      folder_id:         null,
      guest_session_id:  null,
      visibility:        'public',
      access_password_hash: null,
      short_code:        shortCode(),
      publish_at:        null,
      thumbnail:         null,
      created_at:        daysAgo(rnd(5, 90)),
      updated_at:        daysAgo(rnd(0, 4)),
      ...overrides,
    };
  }

  // ── Pro workspace ──────────────────────────────────────────────────────────
  const tutVids = [
    vid({ workspace_id: wsProId, folder_id: folderTutId, title: 'Guía completa: Primeros pasos con StreamingPro', description: 'Todo lo que necesitas para publicar videos profesionales desde cero.', duration: 1847, size: 892*1024*1024, views: 4823, qualities: Q3, created_at: daysAgo(85) }),
    vid({ workspace_id: wsProId, folder_id: folderTutId, title: 'Cómo configurar tu canal en 10 minutos',          description: 'Tutorial rápido de configuración inicial.',                                     duration: 634,  size: 305*1024*1024, views: 2341, qualities: Q2, created_at: daysAgo(78) }),
    vid({ workspace_id: wsProId, folder_id: folderTutId, title: 'Optimización de video para móviles',              description: 'Mejores prácticas para mobile-first streaming.',                                duration: 2103, size: 1012*1024*1024, views: 1789, qualities: Q3, created_at: daysAgo(60) }),
    vid({ workspace_id: wsProId, folder_id: folderTutId, title: 'Monetización avanzada: PPV y suscripciones',      description: 'Estrategias para generar ingresos con tu contenido.',                           duration: 3456, size: 1654*1024*1024, views: 987,  qualities: Q3, created_at: daysAgo(42) }),
  ];

  const webVids = [
    vid({ workspace_id: wsProId, folder_id: folderWebId, title: 'Webinar: El futuro del video marketing en 2025', description: 'Panel de expertos sobre tendencias en video digital.',       duration: 5400, size: 2590*1024*1024, views: 3210, created_at: daysAgo(55) }),
    vid({ workspace_id: wsProId, folder_id: folderWebId, title: 'Masterclass: SEO para videos online',           description: 'Optimiza tu contenido para los primeros resultados.',        duration: 4200, size: 2012*1024*1024, views: 2876, created_at: daysAgo(40) }),
    vid({ workspace_id: wsProId, folder_id: folderWebId, title: 'Live Q&A: Streaming profesional',              description: 'Sesión de preguntas y respuestas con nuestro equipo.',       duration: 7200, size: 3456*1024*1024, views: 1543, created_at: daysAgo(25) }),
  ];

  const mktVids = [
    vid({ workspace_id: wsProId, folder_id: folderProdId, title: 'Demo: Panel de analíticas en tiempo real', description: 'Nuevo dashboard de métricas.', duration: 432, size: 208*1024*1024, views: 1234, created_at: daysAgo(30) }),
    vid({ workspace_id: wsProId, folder_id: folderProdId, title: 'Demo: Integración API con Zapier',         description: 'Automatiza tu workflow.',       duration: 756, size: 362*1024*1024, views: 876,  created_at: daysAgo(20) }),
    vid({ workspace_id: wsProId, folder_id: folderMktId,  title: 'Caso de éxito: EduTech Colombia',          description: 'Cómo aumentaron ventas 300%.', duration: 312, size: 150*1024*1024, views: 2109, created_at: daysAgo(15) }),
  ];

  const specialVids = [
    // Protegido con contraseña
    vid({ workspace_id: wsProId, title: 'Contenido exclusivo Enterprise',     description: 'Solo con contraseña.',    visibility: 'password', access_password_hash: protectedHash, views: 45,  qualities: Q3, created_at: daysAgo(10) }),
    // Privado
    vid({ workspace_id: wsProId, title: '[BORRADOR] Campaña Q1 2025',         description: 'No publicar aún.',        visibility: 'private',  views: 3,   qualities: Q2, created_at: daysAgo(5) }),
    // Publicación programada
    vid({ workspace_id: wsProId, title: 'Anuncio: Nueva funcionalidad (PROGRAMADO)', description: 'Publicación futura.', visibility: 'public', publish_at: daysFromNow(3), views: 0, qualities: Q3, status: 'ready', created_at: daysAgo(1) }),
    // Procesando
    vid({ workspace_id: wsProId, title: 'Webinar grabado en vivo (procesando)',      description: '',                    visibility: 'public', status: 'processing', qualities: '[]', duration: 0, views: 0, created_at: daysAgo(0) }),
    // Error de transcoding
    vid({ workspace_id: wsProId, title: 'Upload corrupto (error)',                   description: 'Fallo en transcoding.', visibility: 'public', status: 'error',    qualities: '[]', duration: 0, views: 0, created_at: daysAgo(3) }),
    // DMCA suspendido
    vid({ workspace_id: wsProId, title: 'Video con disputa DMCA',                   description: 'Removido por copyright.', status: 'ready', qualities: Q2, views: 892, created_at: daysAgo(20),
          dmca_suspended: true, dmca_suspended_at: daysAgo(5), dmca_suspended_by: 'admin@streamvault.io',
          dmca_reason: 'Reclamo de copyright por Warner Music Group', dmca_notice_date: daysAgo(6) }),
  ];

  // ── Admin workspace ────────────────────────────────────────────────────────
  const adminVids = [
    vid({ workspace_id: wsAdminId, title: 'StreamVault: Video de bienvenida',          description: 'Para nuevos usuarios.',       duration: 234,  size: 112*1024*1024, views: 891,  qualities: Q2 }),
    vid({ workspace_id: wsAdminId, title: 'Guía de administración del panel',          description: 'Para admins de plataforma.',  duration: 1823, size: 876*1024*1024, views: 234,  qualities: Q3, visibility: 'private' }),
    vid({ workspace_id: wsAdminId, title: 'Actualizaciones de plataforma — May 2025',  description: '',                            duration: 547,  size: 263*1024*1024, views: 1203, qualities: Q2 }),
  ];

  // ── Starter workspace ──────────────────────────────────────────────────────
  const starterVids = [
    vid({ workspace_id: wsStarterId, title: 'Presentación corporativa 2025',    duration: 890,  size: 428*1024*1024, views: 342 }),
    vid({ workspace_id: wsStarterId, title: 'Tour virtual de instalaciones',    duration: 654,  size: 314*1024*1024, views: 189 }),
    vid({ workspace_id: wsStarterId, title: 'Capacitación: Protocolo seguridad', duration: 2340, size: 1123*1024*1024, views: 67, visibility: 'private' }),
  ];

  // ── Workspace suspendido ────────────────────────────────────────────────────
  const suspVids = [
    vid({ workspace_id: wsSuspendedId, title: 'MediaCorp: Noticias del día', duration: 1800, views: 4521, qualities: Q3 }),
  ];

  // ── Video sin cuenta (guest) ───────────────────────────────────────────────
  const guestVids = [
    vid({ workspace_id: null, title: 'Prueba upload sin cuenta', guest_session_id: 'guest-abc123xyz', status: 'ready', duration: 120, size: 48*1024*1024, views: 2 }),
  ];

  const ALL_VIDS = [...tutVids, ...webVids, ...mktVids, ...specialVids, ...adminVids, ...starterVids, ...suspVids, ...guestVids];

  for (const v of ALL_VIDS) {
    await pool.query(
      `INSERT INTO videos
         (id, title, description, original_filename, status, qualities,
          duration, size, views,
          workspace_id, folder_id, guest_session_id,
          visibility, access_password_hash,
          short_code, publish_at, thumbnail,
          dmca_suspended, dmca_suspended_at, dmca_suspended_by,
          dmca_reason, dmca_notice_date,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,
               $7,$8,$9,
               $10,$11,$12,
               $13,$14,
               $15,$16,$17,
               $18,$19,$20,
               $21,$22,
               $23,$24)`,
      [
        v.id, v.title, v.description, v.original_filename, v.status, v.qualities,
        v.duration, v.size, v.views,
        v.workspace_id, v.folder_id, v.guest_session_id,
        v.visibility, v.access_password_hash,
        v.short_code, v.publish_at, v.thumbnail,
        v.dmca_suspended || false,
        v.dmca_suspended_at || null,
        v.dmca_suspended_by || null,
        v.dmca_reason || null,
        v.dmca_notice_date || null,
        v.created_at, v.updated_at,
      ]
    );
  }
  console.log(`  ✓ ${ALL_VIDS.length} videos creados\n`);

  // ── 8. Capítulos ────────────────────────────────────────────────────────────
  const chapSource = tutVids[0];
  const CHAPTERS = [
    { title: 'Introducción',                    start: 0    },
    { title: 'Crear tu primer workspace',       start: 180  },
    { title: 'Subir y gestionar videos',        start: 480  },
    { title: 'Configurar el reproductor',       start: 900  },
    { title: 'Analíticas y métricas',           start: 1380 },
    { title: 'Integraciones y API',             start: 1650 },
    { title: 'Preguntas frecuentes',            start: 1800 },
  ];
  for (let i = 0; i < CHAPTERS.length; i++) {
    await pool.query(
      `INSERT INTO chapters (id, video_id, title, start_time, position, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [uuidv4(), chapSource.id, CHAPTERS[i].title, CHAPTERS[i].start, i, daysAgo(80)]
    );
  }
  console.log('  ✓ Capítulos añadidos\n');

  // ── 9. Playlists ────────────────────────────────────────────────────────────
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
  for (let i = 0; i < tutVids.length; i++) {
    await pool.query(`INSERT INTO playlist_videos (id, playlist_id, video_id, position, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [uuidv4(), pl1Id, tutVids[i].id, i, daysAgo(70)]);
  }
  for (let i = 0; i < webVids.length; i++) {
    await pool.query(`INSERT INTO playlist_videos (id, playlist_id, video_id, position, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [uuidv4(), pl2Id, webVids[i].id, i, daysAgo(50)]);
  }
  console.log('  ✓ Playlists creadas\n');

  // ── 10. API Keys ─────────────────────────────────────────────────────────────
  const rawKey1 = `sv_live_${crypto.randomBytes(24).toString('hex')}`;
  const rawKey2 = `sv_live_${crypto.randomBytes(24).toString('hex')}`;
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

  // ── 11. Webhooks ────────────────────────────────────────────────────────────
  const wh1Id     = uuidv4();
  const wh1Secret = `whsec_${crypto.randomBytes(20).toString('hex')}`;
  await pool.query(
    `INSERT INTO webhooks (id, workspace_id, url, events, secret, enabled, created_at) VALUES ($1,$2,$3,$4,$5,1,$6)`,
    [wh1Id, wsProId, 'https://hooks.zapier.com/hooks/catch/12345678/abcdef/',
     JSON.stringify(['video.ready','video.deleted','video.updated']),
     wh1Secret, daysAgo(60)]
  );
  // Historial de entregas
  const DELIVERIES = [
    { event: 'video.ready',   code: 200, d: 5  },
    { event: 'video.ready',   code: 200, d: 12 },
    { event: 'video.deleted', code: 200, d: 15 },
    { event: 'video.ready',   code: 500, d: 20 }, // fallo
    { event: 'video.ready',   code: 200, d: 25 },
    { event: 'video.updated', code: 200, d: 30 },
  ];
  for (const d of DELIVERIES) {
    await pool.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, response_body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), wh1Id, d.event, `{"event":"${d.event}","videoId":"test"}`,
       d.code, d.code === 200 ? '{"ok":true}' : '{"error":"Internal Server Error"}', daysAgo(d.d)]
    );
  }
  console.log('  ✓ Webhooks creados\n');

  // ── 12. Eventos de analítica ────────────────────────────────────────────────
  console.log('  Generando eventos de analítica…');
  const COUNTRIES  = ['CO','MX','AR','ES','US','CL','PE','VE','EC','BR'];
  const CITIES     = ['Bogotá','Ciudad de México','Buenos Aires','Madrid','Miami','Santiago','Lima'];
  const DEVICES    = ['desktop','mobile','tablet'];
  const BROWSERS   = ['Chrome','Firefox','Safari','Edge'];
  const EVT_TYPES  = ['play','pause','seek','end','quality_change'];
  const readyProVids = [...tutVids, ...webVids, ...mktVids];

  let evtTotal = 0;
  for (const v of readyProVids) {
    const count = rnd(30, 80);
    for (let i = 0; i < count; i++) {
      await pool.query(
        `INSERT INTO events
           (id, video_id, workspace_id, viewer_id, event_type, position,
            quality, ip, country, city, device_type, browser, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          uuidv4(), v.id, wsProId,
          `viewer-${crypto.randomBytes(4).toString('hex')}`,
          EVT_TYPES[rnd(0, EVT_TYPES.length - 1)],
          rnd(0, v.duration || 300),
          ['360p','720p','1080p'][rnd(0,2)],
          `${rnd(1,254)}.${rnd(1,254)}.${rnd(1,254)}.${rnd(1,254)}`,
          COUNTRIES[rnd(0, COUNTRIES.length - 1)],
          CITIES[rnd(0, CITIES.length - 1)],
          DEVICES[rnd(0, DEVICES.length - 1)],
          BROWSERS[rnd(0, BROWSERS.length - 1)],
          daysAgo(rnd(0, 30)),
        ]
      );
      evtTotal++;
    }
  }
  // Algunos eventos en videos del workspace starter
  for (const v of starterVids.slice(0, 2)) {
    for (let i = 0; i < rnd(5, 15); i++) {
      await pool.query(
        `INSERT INTO events (id, video_id, workspace_id, viewer_id, event_type, position, country, device_type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv4(), v.id, wsStarterId, `viewer-${crypto.randomBytes(4).toString('hex')}`,
         EVT_TYPES[rnd(0,2)], rnd(0, v.duration || 300), COUNTRIES[rnd(0,5)],
         DEVICES[rnd(0,2)], daysAgo(rnd(0, 20))]
      );
      evtTotal++;
    }
  }
  console.log(`  ✓ ${evtTotal} eventos de analítica generados\n`);

  // ── 13. Facturas y eventos de suscripción ────────────────────────────────────
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

  // ── 14. Invitaciones pendientes ──────────────────────────────────────────────
  await pool.query(
    `INSERT INTO workspace_invitations
       (id, workspace_id, email, role, token, invited_by, expires_at, created_at)
     VALUES ($1,$2,'nuevoadmin@empresa.com','admin',$3,$4,$5,$6)`,
    [uuidv4(), wsProId, crypto.randomBytes(32).toString('hex'), mariaId, daysFromNow(7), daysAgo(1)]
  );
  console.log('  ✓ Invitaciones pendientes creadas\n');

  // ── 15. System config ────────────────────────────────────────────────────────
  const SYS_CFG = [
    ['guest_config', JSON.stringify({ enabled: true, maxFileSizeMB: 2048, expiryHours: 24, maxVideos: 3 })],
    ['payment_gateways', JSON.stringify({ stripe: { enabled: true, default: true }, paypal: { enabled: false }, binance: { enabled: false } })],
    ['plan_features', JSON.stringify({
      starter:    { customPlayer: false, apiAccess: false, analytics: 'basic',  subtitles: false, customDomain: false, watermark: false, chapters: true,  playlists: true, webhooks: false, apiKeys: false },
      pro:        { customPlayer: true,  apiAccess: true,  analytics: 'full',   subtitles: true,  customDomain: true,  watermark: true,  chapters: true,  playlists: true, webhooks: true,  apiKeys: true  },
      enterprise: { customPlayer: true,  apiAccess: true,  analytics: 'full',   subtitles: true,  customDomain: true,  watermark: true,  chapters: true,  playlists: true, webhooks: true,  apiKeys: true  },
    })],
    ['maintenance_mode',           'false'],
    ['allow_new_registrations',    'true'],
    ['default_video_visibility',   '"public"'],
    ['max_upload_size_mb',         '10240'],
    ['platform_name',              '"StreamVault"'],
    ['support_email',              '"soporte@streamvault.io"'],
  ];
  for (const [k, v] of SYS_CFG) {
    await pool.query(
      `INSERT INTO system_config (key, value, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=$3`,
      [k, v, NOW]
    );
  }
  console.log('  ✓ Configuración del sistema establecida\n');

  // ── 16. Audit log ────────────────────────────────────────────────────────────
  const AUDIT = [
    { actor: adminId,   email: 'admin@streamvault.io',           action: 'workspace_suspended',      type: 'workspace',    target: wsSuspendedId,       meta: { reason: 'payment_failed' },          d: 10 },
    { actor: adminId,   email: 'admin@streamvault.io',           action: 'plan_config_updated',      type: 'system_config',target: 'plans.pro',          meta: { price: 59 },                         d: 45 },
    { actor: adminId,   email: 'admin@streamvault.io',           action: 'dmca_suspend',             type: 'video',        target: specialVids[5].id,    meta: { reason: 'Warner Music Group' },      d: 5  },
    { actor: mariaId,   email: 'maria.gomez@streamingpro.com',   action: 'member_invited',           type: 'invitation',   target: 'nuevoadmin@empresa.com', meta: { role: 'admin' },               d: 1  },
    { actor: mariaId,   email: 'maria.gomez@streamingpro.com',   action: 'webhook_created',          type: 'webhook',      target: wh1Id,                meta: { url: 'hooks.zapier.com' },           d: 60 },
    { actor: sofiaId,   email: 'sofia.ramirez@streamingpro.com', action: 'video_visibility_changed', type: 'video',        target: specialVids[1].id,    meta: { from: 'public', to: 'private' },    d: 5  },
    { actor: carlosId,  email: 'carlos.lopez@miempresa.io',      action: 'workspace_created',        type: 'workspace',    target: wsStarterId,          meta: { plan: 'starter' },                   d: 45 },
  ];
  for (const e of AUDIT) {
    await pool.query(
      `INSERT INTO audit_log (id, actor_id, actor_email, action, target_type, target_id, metadata, ip, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv4(), e.actor, e.email, e.action, e.type, e.target,
       JSON.stringify(e.meta), '127.0.0.1', daysAgo(e.d)]
    );
  }
  console.log('  ✓ Audit log creado\n');

  // ── RESUMEN ──────────────────────────────────────────────────────────────────
  console.log('═'.repeat(64));
  console.log('\n  🎉  SEED COMPLETADO — Entorno de producción simulado\n');
  console.log('  USUARIOS Y ACCESOS');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log('  Super Admin    admin@streamvault.io         Admin@SV2024!');
  console.log('                 → /admin  (panel de administración)');
  console.log('                 → workspace: StreamVault HQ (Enterprise)');
  console.log('');
  console.log('  Owner Pro      maria.gomez@streamingpro.com Maria@Pro2024!');
  console.log('                 → workspace: StreamingPro Media (Pro)');
  console.log('                 → 14 videos, analíticas, billing, webhooks');
  console.log('');
  console.log('  Admin Pro      sofia.ramirez@streamingpro.com Sofia@Admin2024!');
  console.log('                 → mismo workspace (rol: admin)');
  console.log('');
  console.log('  Viewer Pro     roberto.silva@gmail.com       Roberto@View2024!');
  console.log('                 → mismo workspace (rol: viewer, sin edición)');
  console.log('');
  console.log('  Starter        carlos.lopez@miempresa.io     Carlos@Start2024!');
  console.log('                 → workspace: MiEmpresa Digital (Starter, 3 videos)');
  console.log('');
  console.log('  SUSPENDIDO     pablo.torres@suspendido.co    Pablo@Susp2024!');
  console.log('                 → workspace: MediaCorp TV (Pro, SUSPENDIDO)');
  console.log('');
  console.log('  DATOS GENERADOS');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log(`  Videos:        ${ALL_VIDS.length} (ready/processing/error/scheduled/dmca/password/private)`);
  console.log(`  Analíticas:    ~${evtTotal} eventos (30 días, múltiples países)`);
  console.log('  Playlists:     2 (con videos asignados)');
  console.log('  Facturas:      3 meses pagados (Pro)');
  console.log('  API Keys:      3 (Pro ×2, Admin ×1)');
  console.log('  Webhooks:      1 con historial de entregas');
  console.log('  Invitaciones:  1 pendiente para nuevoadmin@empresa.com');
  console.log('  Audit log:     7 entradas históricas');
  console.log('');
  console.log('  CONTRASEÑA VIDEO PROTEGIDO');
  console.log('  → "Contenido exclusivo Enterprise"  contraseña: Premium2024');
  console.log('');
  console.log('  API KEYS (guardar ahora — no se vuelven a mostrar)');
  console.log(`  Pro Full:   ${rawKey1}`);
  console.log(`  Pro Read:   ${rawKey2}`);
  console.log(`  Admin:      ${rawKeyAdmin}`);
  console.log('');
  console.log(`  URL: http://localhost:3000/login`);
  console.log('═'.repeat(64) + '\n');
}

main()
  .catch(err => {
    console.error('\n❌  Seed falló:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
