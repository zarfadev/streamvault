#!/usr/bin/env node
/**
 * Inicializa system_config con valores por defecto (versión SQLite)
 * Ejecutar: node scripts/init-system-config-sqlite.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../streamvault.db'));

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

try {
  console.log('🔧 Inicializando configuración del sistema...');
  
  // Verificar si la tabla system_config existe
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='system_config'
  `).get();
  
  if (!tableExists) {
    console.log('⚠️  Tabla system_config no existe. Creándola...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);
    console.log('✅ Tabla system_config creada');
  }
  
  const NOW = Math.floor(Date.now() / 1000);
  
  // Insertar features
  db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE 
    SET value = excluded.value, updated_at = excluded.updated_at
  `).run('features', JSON.stringify(DEFAULT_CONFIG.features), NOW);
  
  console.log('✅ Features configurados');
  
  // Insertar platform
  db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE 
    SET value = excluded.value, updated_at = excluded.updated_at
  `).run('platform', JSON.stringify(DEFAULT_CONFIG.platform), NOW);
  
  console.log('✅ Platform configurado');
  
  // Verificar
  const features = db.prepare('SELECT * FROM system_config WHERE key = ?').get('features');
  const platform = db.prepare('SELECT * FROM system_config WHERE key = ?').get('platform');
  
  console.log('\n📋 Configuración actual:');
  console.log('Features:', JSON.parse(features.value));
  console.log('Platform:', JSON.parse(platform.value));
  
  console.log('\n🎉 Configuración inicial completada');
  db.close();
  process.exit(0);
} catch (err) {
  console.error('❌ Error inicializando configuración:', err);
  db.close();
  process.exit(1);
}
