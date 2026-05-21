#!/usr/bin/env node
/**
 * Inicializa system_config con valores por defecto
 * Ejecutar: node scripts/init-system-config-fixed.js
 */

// Cargar variables de entorno primero
require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const DEFAULT_CONFIG = {
  features: {
    foldersEnabled: true,
    playlistsEnabled: true,
    webhooksEnabled: true,
    transcriptionsEnabled: true,
    downloadLinksEnabled: true,
    watermarkEnabled: true,
    analyticsEnabled: true,
    bulkOperationsEnabled: true,
    apiKeysEnabled: true,
    tracksEnabled: true,
    invitationsEnabled: true,
    referralEnabled: true,
    multiWorkspaceEnabled: true,
  },
  platform: {
    siteName: 'StreamVault',
    allowRegistration: true,
    // Branding para embed tier branded
    platformLogoUrl: '/favicon.svg',
    platformLogoPos: 'tr',
    platformName: 'StreamVault',
  },
};

async function init() {
  const client = await pool.connect();
  try {
    console.log('🔧 Inicializando configuración del sistema...');
    console.log('📍 Conectado a:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@'));
    
    // Verificar si la tabla existe
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'system_config'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('⚠️  Tabla system_config no existe. Creándola...');
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
        )
      `);
      console.log('✅ Tabla system_config creada');
    }
    
    const NOW = Math.floor(Date.now() / 1000);
    
    // Insertar features
    await client.query(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE 
      SET value = excluded.value, updated_at = excluded.updated_at
    `, ['features', JSON.stringify(DEFAULT_CONFIG.features), NOW]);
    
    console.log('✅ Features configurados');
    
    // Insertar platform
    await client.query(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE 
      SET value = excluded.value, updated_at = excluded.updated_at
    `, ['platform', JSON.stringify(DEFAULT_CONFIG.platform), NOW]);
    
    console.log('✅ Platform configurado');
    
    // Verificar
    const features = await client.query('SELECT * FROM system_config WHERE key = $1', ['features']);
    const platform = await client.query('SELECT * FROM system_config WHERE key = $1', ['platform']);
    
    console.log('\n📋 Configuración actual:');
    console.log('Features:', JSON.parse(features.rows[0].value));
    console.log('Platform:', JSON.parse(platform.rows[0].value));
    
    console.log('\n🎉 Configuración inicial completada');
  } catch (err) {
    console.error('❌ Error inicializando configuración:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

init();
