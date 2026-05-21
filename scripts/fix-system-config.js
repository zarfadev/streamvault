#!/usr/bin/env node

/**
 * ════════════════════════════════════════════════════════════════════
 * Script: Fix System Config - Inicialización completa
 * Propósito: Arreglar error 400 en /api/admin/features
 * Fecha: Mayo 13, 2026
 * ════════════════════════════════════════════════════════════════════
 */

const db = require('../db');

const NOW = Math.floor(Date.now() / 1000);

async function fixSystemConfig() {
  console.log('🔧 Iniciando corrección de system_config...\n');

  try {
    // ──────────────────────────────────────────────────────────────────────
    // 1. FEATURES GLOBALES (Arregla error 400 en /api/admin/features)
    // ──────────────────────────────────────────────────────────────────────
    console.log('📦 Configurando features globales...');
    
    const features = {
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
      adsEnabled: true,
      customDomainEnabled: true
    };

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
    `).run('features', JSON.stringify(features), NOW);

    console.log('   ✅ Features globales configurados\n');

    // ──────────────────────────────────────────────────────────────────────
    // 2. PLATFORM BRANDING (Logo StreamVault configurable desde admin)
    // ──────────────────────────────────────────────────────────────────────
    console.log('🎨 Configurando platform branding...');

    const platform = {
      siteName: 'StreamVault',
      allowRegistration: true,
      requireEmailVerification: false,
      analyticsRetentionDays: 90,
      supportEmail: 'support@streamvault.io',
      appUrl: process.env.APP_URL || 'http://localhost:3000',
      platformLogoUrl: '/favicon.svg',
      platformLogoPos: 'tr',
      platformName: 'StreamVault'
    };

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
    `).run('platform', JSON.stringify(platform), NOW);

    console.log('   ✅ Platform branding configurado\n');

    // ──────────────────────────────────────────────────────────────────────
    // 3. PLANES CON EMBED TIERS
    // ──────────────────────────────────────────────────────────────────────
    console.log('💎 Configurando planes con embed tiers...');

    // Plan STARTER con embed tier BRANDED
    const starter = {
      name: 'Starter',
      description: 'Plan básico ideal para creadores individuales',
      price: 19,
      highlighted: false,
      badge: null,
      maxVideos: 25,
      maxStorageGB: 50,
      maxBandwidthGB: 100,
      maxFileSizeMB: 10240,
      maxWorkspaces: 1,
      maxMembers: 1,
      features: {
        folders: true,
        playlists: true,
        embed: 'branded',
        analytics: false,
        subtitles: false,
        apiKeys: false,
        webhooks: false,
        transcriptions: false,
        downloadLinks: true,
        watermark: false,
        bulkOperations: false,
        tracks: true,
        invitations: false,
        multiWorkspace: false,
        customDomain: false,
        adsEnabled: false,
        prioritySupport: false
      }
    };

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
    `).run('plans.starter', JSON.stringify(starter), NOW);

    console.log('   ✅ Plan Starter (embed: branded)');

    // Plan PRO con embed tier UNBRANDED
    const pro = {
      name: 'Pro',
      description: 'Plan profesional para equipos y negocios',
      price: 59,
      highlighted: true,
      badge: 'Más popular',
      maxVideos: 200,
      maxStorageGB: 500,
      maxBandwidthGB: 1000,
      maxFileSizeMB: 10240,
      maxWorkspaces: 1,
      maxMembers: 5,
      features: {
        folders: true,
        playlists: true,
        embed: 'unbranded',
        analytics: 'full',
        subtitles: true,
        apiKeys: true,
        webhooks: true,
        transcriptions: true,
        downloadLinks: true,
        watermark: true,
        bulkOperations: true,
        tracks: true,
        invitations: true,
        multiWorkspace: false,
        customDomain: false,
        adsEnabled: false,
        prioritySupport: true
      }
    };

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
    `).run('plans.pro', JSON.stringify(pro), NOW);

    console.log('   ✅ Plan Pro (embed: unbranded)');

    // Plan ENTERPRISE con embed tier CUSTOM
    const enterprise = {
      name: 'Enterprise',
      description: 'Plan empresarial con todas las funcionalidades',
      price: 99,
      highlighted: false,
      badge: null,
      maxVideos: -1,
      maxStorageGB: 2000,
      maxBandwidthGB: 5000,
      maxFileSizeMB: 10240,
      maxWorkspaces: 10,
      maxMembers: 50,
      features: {
        folders: true,
        playlists: true,
        embed: 'custom',
        analytics: 'full',
        subtitles: true,
        apiKeys: true,
        webhooks: true,
        transcriptions: true,
        downloadLinks: true,
        watermark: true,
        bulkOperations: true,
        tracks: true,
        invitations: true,
        multiWorkspace: true,
        customDomain: true,
        adsEnabled: true,
        prioritySupport: true
      }
    };

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3
    `).run('plans.enterprise', JSON.stringify(enterprise), NOW);

    console.log('   ✅ Plan Enterprise (embed: custom)\n');

    // ──────────────────────────────────────────────────────────────────────
    // 4. OTRAS CONFIGURACIONES
    // ──────────────────────────────────────────────────────────────────────
    console.log('⚙️  Configurando transcoding, security, payment gateways...');

    const transcoding = {
      qualities: ['360p', '480p', '720p', '1080p'],
      defaultQuality: '720p',
      maxConcurrent: 2
    };

    const security = {
      jwtExpiryHours: 24,
      refreshExpiryDays: 30,
      bcryptRounds: 12,
      maxLoginAttempts: 10
    };

    const paymentGateways = {
      stripe: { enabled: true },
      paypal: { enabled: false },
      binance: { enabled: false }
    };

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO NOTHING
    `).run('transcoding', JSON.stringify(transcoding), NOW);

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO NOTHING
    `).run('security', JSON.stringify(security), NOW);

    await db.prepare(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (key) DO NOTHING
    `).run('payment_gateways', JSON.stringify(paymentGateways), NOW);

    console.log('   ✅ Configuraciones adicionales completadas\n');

    // ──────────────────────────────────────────────────────────────────────
    // VERIFICACIÓN
    // ──────────────────────────────────────────────────────────────────────
    console.log('══════════════════════════════════════════════════════════════');
    console.log('📊 VERIFICACIÓN DE CONFIGURACIONES\n');

    const configs = await db.prepare(`
      SELECT key, value FROM system_config ORDER BY key
    `).all();

    console.log('Configuraciones en system_config:');
    for (const config of configs) {
      const preview = config.value.length > 80 
        ? config.value.substring(0, 77) + '...'
        : config.value;
      console.log(`  • ${config.key}: ${preview}`);
    }

    console.log('\n📋 Embed Tiers por Plan:');
    const plans = configs.filter(c => c.key.startsWith('plans.'));
    for (const plan of plans) {
      const data = JSON.parse(plan.value);
      const embedTier = data.features?.embed || 'N/A';
      const adsEnabled = data.features?.adsEnabled || false;
      const customDomain = data.features?.customDomain || false;
      console.log(`  • ${plan.key}: embed=${embedTier}, ads=${adsEnabled}, domain=${customDomain}`);
    }

    const platformConfig = configs.find(c => c.key === 'platform');
    if (platformConfig) {
      const platformData = JSON.parse(platformConfig.value);
      console.log('\n🎨 Platform Branding:');
      console.log(`  • Logo URL: ${platformData.platformLogoUrl || 'N/A'}`);
      console.log(`  • Logo Position: ${platformData.platformLogoPos || 'N/A'}`);
      console.log(`  • Platform Name: ${platformData.platformName || 'N/A'}`);
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('✅ CONFIGURACIÓN COMPLETADA EXITOSAMENTE');
    console.log('══════════════════════════════════════════════════════════════\n');

    console.log('🎯 Próximos pasos:');
    console.log('   1. Reinicia el servidor: npm start');
    console.log('   2. Verifica /api/admin/features (debe devolver 200 OK)');
    console.log('   3. Revisa el panel admin para configurar el logo de StreamVault');
    console.log('   4. Configura embed settings en el dashboard de cada workspace\n');

  } catch (error) {
    console.error('❌ Error al configurar system_config:', error);
    process.exit(1);
  }
}

// Ejecutar
fixSystemConfig()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
  });
