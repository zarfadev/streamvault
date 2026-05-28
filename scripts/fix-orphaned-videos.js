#!/usr/bin/env node
/**
 * fix-orphaned-videos.js
 *
 * Busca videos sin workspace_id que fueron subidos por usuarios autenticados
 * (el bug era: _refreshUserForUpload llamaba next() directamente, saltándose
 *  resolveWorkspace, por lo que req.workspace quedaba null).
 *
 * Estrategia de reparación:
 *   1. Busca videos con workspace_id IS NULL y guest_session_id IS NULL
 *      (son videos "huérfanos" — no son guest, no tienen workspace).
 *   2. Para cada video huérfano, intenta deducir el workspace del contexto:
 *      - Si hay un solo workspace activo en el sistema (caso mono-tenant):
 *        asigna ese workspace.
 *      - Si hay múltiples workspaces, el admin debe especificar el workspace_id
 *        con --workspace=<id>.
 *
 * Uso:
 *   node scripts/fix-orphaned-videos.js --dry-run
 *   node scripts/fix-orphaned-videos.js --workspace=abc123
 *   node scripts/fix-orphaned-videos.js --workspace=abc123 --dry-run
 *   node scripts/fix-orphaned-videos.js --list   (solo listar, no tocar)
 */

'use strict';

const { Pool } = require('pg');
require('dotenv').config();

const args = process.argv.slice(2);
const isDryRun  = args.includes('--dry-run');
const isList    = args.includes('--list');
const wsArg     = args.find(a => a.startsWith('--workspace='));
const targetWs  = wsArg ? wsArg.split('=')[1].trim() : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('amazonaws') ? { rejectUnauthorized: false } : false,
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('\n=== StreamVault — Fix Orphaned Videos ===\n');

    // 1. Contar y listar videos huérfanos
    const { rows: orphans } = await client.query(`
      SELECT id, title, status, size, created_at
      FROM videos
      WHERE workspace_id IS NULL
        AND guest_session_id IS NULL
      ORDER BY created_at DESC
    `);

    if (!orphans.length) {
      console.log('✅ No hay videos huérfanos. Todo está bien.\n');
      return;
    }

    console.log(`⚠️  Encontrados ${orphans.length} video(s) huérfano(s) (sin workspace ni guest):\n`);
    orphans.forEach((v, i) => {
      const date = new Date(Number(v.created_at) * 1000).toLocaleString('es-CO');
      const mb   = v.size ? (Number(v.size) / 1e6).toFixed(1) + ' MB' : '—';
      console.log(`  ${i + 1}. [${v.id}] "${v.title}" — ${v.status} — ${mb} — ${date}`);
    });
    console.log('');

    if (isList) {
      console.log('(Modo --list: solo se listaron, no se modificó nada)\n');
      return;
    }

    // 2. Resolver workspace destino
    let workspaceId = targetWs;

    if (!workspaceId) {
      // Intentar auto-detectar si solo hay un workspace
      const { rows: wsList } = await client.query(
        `SELECT id, name, owner_id FROM workspaces WHERE suspended = FALSE ORDER BY created_at ASC`
      );

      if (wsList.length === 1) {
        workspaceId = wsList[0].id;
        console.log(`ℹ️  Auto-detectado workspace único: "${wsList[0].name}" (${workspaceId})\n`);
      } else if (wsList.length === 0) {
        console.error('❌ No hay workspaces en la base de datos. Crea uno primero.\n');
        process.exit(1);
      } else {
        console.log('Workspaces disponibles:\n');
        wsList.forEach(w => console.log(`  - ${w.id}  →  "${w.name}"`));
        console.error('\n❌ Hay múltiples workspaces. Especifica el destino con:');
        console.error('   node scripts/fix-orphaned-videos.js --workspace=<id>\n');
        process.exit(1);
      }
    }

    // 3. Verificar que el workspace existe
    const { rows: wsCheck } = await client.query(
      `SELECT id, name FROM workspaces WHERE id = $1`, [workspaceId]
    );
    if (!wsCheck.length) {
      console.error(`❌ Workspace "${workspaceId}" no encontrado.\n`);
      process.exit(1);
    }
    console.log(`🎯 Workspace destino: "${wsCheck[0].name}" (${workspaceId})\n`);

    if (isDryRun) {
      console.log('🔍 DRY RUN — no se realizarán cambios en la base de datos.\n');
      console.log(`   Se asignarían ${orphans.length} video(s) al workspace "${wsCheck[0].name}".\n`);
      return;
    }

    // 4. Ejecutar la reparación
    console.log('🔧 Reparando...\n');

    await client.query('BEGIN');
    try {
      // Asignar workspace_id a los videos huérfanos
      const { rowCount } = await client.query(`
        UPDATE videos
        SET workspace_id = $1,
            updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
        WHERE workspace_id IS NULL
          AND guest_session_id IS NULL
      `, [workspaceId]);

      // Recalcular storage_used_bytes del workspace
      // (puede haber discrepancia si los videos huérfanos tenían tamaño)
      await client.query(`
        UPDATE workspaces
        SET storage_used_bytes = (
          SELECT COALESCE(SUM(size), 0)
          FROM videos
          WHERE workspace_id = $1
        )
        WHERE id = $1
      `, [workspaceId]);

      await client.query('COMMIT');
      console.log(`✅ ${rowCount} video(s) reparado(s) — asignados al workspace "${wsCheck[0].name}".\n`);
      console.log('   El contador de almacenamiento del workspace fue recalculado.\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
