-- ════════════════════════════════════════════════════════════════════
-- Script: Fix System Config - Inicialización completa
-- Propósito: Arreglar error 400 en /api/admin/features y otros errores
-- Fecha: Mayo 13, 2026
-- ════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────
-- 1. FEATURES GLOBALES (Arregla error 400 en /api/admin/features)
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, updated_at)
VALUES ('features', '{
  "foldersEnabled": true,
  "playlistsEnabled": true,
  "webhooksEnabled": true,
  "transcriptionsEnabled": true,
  "downloadLinksEnabled": true,
  "watermarkEnabled": true,
  "analyticsEnabled": true,
  "bulkOperationsEnabled": true,
  "apiKeysEnabled": true,
  "tracksEnabled": true,
  "invitationsEnabled": true,
  "referralEnabled": true,
  "multiWorkspaceEnabled": true,
  "adsEnabled": true,
  "customDomainEnabled": true
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

-- ──────────────────────────────────────────────────────────────────────
-- 2. PLATFORM BRANDING (Logo StreamVault configurable desde admin)
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, updated_at)
VALUES ('platform', '{
  "siteName": "StreamVault",
  "allowRegistration": true,
  "requireEmailVerification": false,
  "analyticsRetentionDays": 90,
  "supportEmail": "support@streamvault.io",
  "appUrl": "http://localhost:3000",
  "platformLogoUrl": "/favicon.svg",
  "platformLogoPos": "tr",
  "platformName": "StreamVault"
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = jsonb_set(
    value::jsonb,
    ''{platformLogoUrl}'',
    COALESCE((value::jsonb)->''platformLogoUrl'', ''"/favicon.svg"''::jsonb)
  )::text,
  updated_at = excluded.updated_at
WHERE (value::jsonb)->>'platformLogoUrl' IS NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 3. PLANES CON EMBED TIERS
-- ──────────────────────────────────────────────────────────────────────

-- Plan STARTER con embed tier BRANDED
INSERT INTO system_config (key, value, updated_at)
VALUES ('plans.starter', '{
  "name": "Starter",
  "description": "Plan básico ideal para creadores individuales",
  "price": 19,
  "highlighted": false,
  "badge": null,
  "maxVideos": 25,
  "maxStorageGB": 50,
  "maxBandwidthGB": 100,
  "maxFileSizeMB": 10240,
  "maxWorkspaces": 1,
  "maxMembers": 1,
  "features": {
    "folders": true,
    "playlists": true,
    "embed": "branded",
    "analytics": false,
    "subtitles": false,
    "apiKeys": false,
    "webhooks": false,
    "transcriptions": false,
    "downloadLinks": true,
    "watermark": false,
    "bulkOperations": false,
    "tracks": true,
    "invitations": false,
    "multiWorkspace": false,
    "customDomain": false,
    "adsEnabled": false,
    "prioritySupport": false
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = jsonb_set(
    value::jsonb,
    ''{features,embed}'',
    ''"branded"''::jsonb
  )::text,
  updated_at = excluded.updated_at;

-- Plan PRO con embed tier UNBRANDED
INSERT INTO system_config (key, value, updated_at)
VALUES ('plans.pro', '{
  "name": "Pro",
  "description": "Plan profesional para equipos y negocios",
  "price": 59,
  "highlighted": true,
  "badge": "Más popular",
  "maxVideos": 200,
  "maxStorageGB": 500,
  "maxBandwidthGB": 1000,
  "maxFileSizeMB": 10240,
  "maxWorkspaces": 1,
  "maxMembers": 5,
  "features": {
    "folders": true,
    "playlists": true,
    "embed": "unbranded",
    "analytics": "full",
    "subtitles": true,
    "apiKeys": true,
    "webhooks": true,
    "transcriptions": true,
    "downloadLinks": true,
    "watermark": true,
    "bulkOperations": true,
    "tracks": true,
    "invitations": true,
    "multiWorkspace": false,
    "customDomain": false,
    "adsEnabled": false,
    "prioritySupport": true
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = jsonb_set(
    value::jsonb,
    ''{features,embed}'',
    ''"unbranded"''::jsonb
  )::text,
  updated_at = excluded.updated_at;

-- Plan ENTERPRISE con embed tier CUSTOM
INSERT INTO system_config (key, value, updated_at)
VALUES ('plans.enterprise', '{
  "name": "Enterprise",
  "description": "Plan empresarial con todas las funcionalidades",
  "price": 99,
  "highlighted": false,
  "badge": null,
  "maxVideos": -1,
  "maxStorageGB": 2000,
  "maxBandwidthGB": 5000,
  "maxFileSizeMB": 10240,
  "maxWorkspaces": 10,
  "maxMembers": 50,
  "features": {
    "folders": true,
    "playlists": true,
    "embed": "custom",
    "analytics": "full",
    "subtitles": true,
    "apiKeys": true,
    "webhooks": true,
    "transcriptions": true,
    "downloadLinks": true,
    "watermark": true,
    "bulkOperations": true,
    "tracks": true,
    "invitations": true,
    "multiWorkspace": true,
    "customDomain": true,
    "adsEnabled": true,
    "prioritySupport": true
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = jsonb_set(
    jsonb_set(
      value::jsonb,
      ''{features,embed}'',
      ''"custom"''::jsonb
    ),
    ''{features,adsEnabled}'',
    ''true''::jsonb
  )::text,
  updated_at = excluded.updated_at;

-- ──────────────────────────────────────────────────────────────────────
-- 4. TRANSCODING CONFIG
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, updated_at)
VALUES ('transcoding', '{
  "qualities": ["360p", "480p", "720p", "1080p"],
  "defaultQuality": "720p",
  "maxConcurrent": 2
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- 5. SECURITY CONFIG
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, updated_at)
VALUES ('security', '{
  "jwtExpiryHours": 24,
  "refreshExpiryDays": 30,
  "bcryptRounds": 12,
  "maxLoginAttempts": 10
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- 6. PAYMENT GATEWAYS CONFIG
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, updated_at)
VALUES ('payment_gateways', '{
  "stripe": {
    "enabled": true
  },
  "paypal": {
    "enabled": false
  },
  "binance": {
    "enabled": false
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ══════════════════════════════════════════════════════════════════════

-- Ver todas las configuraciones insertadas
SELECT 
  key,
  CASE 
    WHEN LENGTH(value) > 100 THEN LEFT(value, 97) || '...'
    ELSE value
  END as value_preview,
  TO_TIMESTAMP(updated_at) as updated_at
FROM system_config
ORDER BY key;

-- Verificar embed tiers específicamente
SELECT 
  key,
  value::jsonb->'features'->>'embed' as embed_tier,
  value::jsonb->'features'->>'adsEnabled' as ads_enabled,
  value::jsonb->'features'->>'customDomain' as custom_domain
FROM system_config
WHERE key LIKE 'plans.%'
ORDER BY key;

-- Verificar platform branding
SELECT 
  key,
  value::jsonb->>'platformLogoUrl' as logo_url,
  value::jsonb->>'platformLogoPos' as logo_pos,
  value::jsonb->>'platformName' as platform_name
FROM system_config
WHERE key = 'platform';

-- ══════════════════════════════════════════════════════════════════════
-- NOTAS
-- ══════════════════════════════════════════════════════════════════════
-- 
-- Este script:
-- 1. ✅ Arregla error 400 en /api/admin/features
-- 2. ✅ Inicializa platform branding (logo StreamVault configurable)
-- 3. ✅ Configura embed tiers por plan (branded/unbranded/custom)
-- 4. ✅ Habilita anuncios solo en plan Enterprise
-- 5. ✅ Configura dominio personalizado solo en Enterprise
--
-- Para ejecutar:
-- psql -U postgres streamvault < scripts/fix-system-config.sql
--
-- O desde psql:
-- \i scripts/fix-system-config.sql
-- ══════════════════════════════════════════════════════════════════════
