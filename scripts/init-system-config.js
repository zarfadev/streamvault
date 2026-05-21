#!/usr/bin/env node
/**
 * Inicializa system_config con valores por defecto
 * Ejecutar: node scripts/init-system-config.js
 */

const db = require('../db');

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
  try {
    console.log('🔧 Inicializando configuración del sistema...');
    
    const NOW = 'FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT';
    
    // Insertar features
    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ('features', ?, ${NOW})
      ON CONFLICT(key) DO UPDATE 
      SET value = excluded.value, updated_at = ${NOW}
    `).run(JSON.stringify(DEFAULT_CONFIG.features));
    
    console.log('✅ Features configurados');
    
    // Insertar platform
    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ('platform', ?, ${NOW})
      ON CONFLICT(key) DO UPDATE 
      SET value = excluded.value, updated_at = ${NOW}
    `).run(JSON.stringify(DEFAULT_CONFIG.platform));
    
    console.log('✅ Platform configurado');
    
    console.log('🎉 Configuración inicial completada');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error inicializando configuración:', err);
    process.exit(1);
  }
}

init();
