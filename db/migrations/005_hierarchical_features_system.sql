-- ════════════════════════════════════════════════════════════════════════════
-- Migration: Sistema Jerárquico de Features (Global → Plan)
-- ════════════════════════════════════════════════════════════════════════════
-- Descripción:
--   Implementa un sistema de permisos jerárquico donde:
--   1. Configuración GLOBAL controla qué features están disponibles en el sistema
--   2. Configuración POR PLAN permite habilitar/deshabilitar features específicas
--   3. Los planes pueden ANULAR (override) la configuración global
--
-- Ejemplo de Flujo:
--   - Global: transcriptions = ENABLED
--   - Plan Starter: transcriptions = false → Usuarios en Starter NO pueden usar
--   - Plan Pro: transcriptions = true → Usuarios en Pro SÍ pueden usar
--   - Plan Enterprise: (heredado de Global) → Usuarios en Enterprise SÍ pueden usar
--
-- Estructura:
--   system_config con clave 'features' → Configuración global de features
--   system_config con claves 'plans.starter', 'plans.pro', 'plans.enterprise'
-- ════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Configuración Global de Features (Activas para el sistema completo)
-- ──────────────────────────────────────────────────────────────────────────
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
  "multiWorkspaceEnabled": true
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Plan STARTER - Features Limitadas
-- ──────────────────────────────────────────────────────────────────────────
-- Características:
--   ✓ Funciones básicas de videos y playlists
--   ✗ Sin webhooks, API, transcripciones automáticas, watermark personalizado
--   ✗ Sin múltiples workspaces
--   ✗ Analytics básico únicamente
-- ──────────────────────────────────────────────────────────────────────────
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
    "prioritySupport": false
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Plan PRO - Features Intermedias
-- ──────────────────────────────────────────────────────────────────────────
-- Características:
--   ✓ Todas las funciones de Starter
--   ✓ Webhooks, API Keys, Transcripciones
--   ✓ Analytics completo, embed sin marca
--   ✓ Subtítulos, watermark personalizado
--   ✓ Operaciones en lote
--   ✗ Sin múltiples workspaces ni dominio personalizado
-- ──────────────────────────────────────────────────────────────────────────
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
    "prioritySupport": true
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Plan ENTERPRISE - Todas las Features
-- ──────────────────────────────────────────────────────────────────────────
-- Características:
--   ✓ TODAS las funcionalidades del sistema
--   ✓ Múltiples workspaces
--   ✓ Dominio personalizado
--   ✓ Soporte prioritario
--   ✓ Recursos ilimitados o muy altos
-- ──────────────────────────────────────────────────────────────────────────
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
    "prioritySupport": true
  }
}', FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

-- ══════════════════════════════════════════════════════════════════════════
-- NOTAS IMPORTANTES
-- ══════════════════════════════════════════════════════════════════════════
-- 1. El middleware checkFeature valida en este orden:
--    a) ¿Feature habilitada globalmente? (system_config.features)
--    b) ¿Plan del workspace incluye el feature? (system_config.plans.{planName})
--    c) Si ambos son true, el usuario puede usar el feature
--
-- 2. Para DESHABILITAR un feature globalmente:
--    UPDATE system_config 
--    SET value = jsonb_set(value::jsonb, '{transcriptionsEnabled}', 'false'::jsonb)::text
--    WHERE key = 'features';
--    → NINGÚN plan podrá usar transcripciones sin importar su configuración
--
-- 3. Para HABILITAR un feature solo en un plan específico:
--    UPDATE system_config
--    SET value = jsonb_set(value::jsonb, '{features,webhooks}', 'true'::jsonb)::text
--    WHERE key = 'plans.pro';
--    → Solo usuarios en plan Pro podrán usar webhooks
--
-- 4. Features con valores especiales:
--    - embed: 'branded' | 'unbranded' | 'custom'
--    - analytics: 'basic' | 'full'
--    - Otros: true | false
--
-- 5. El Admin Panel permite modificar estas configuraciones en tiempo real
--    sin necesidad de reiniciar el servidor
-- ══════════════════════════════════════════════════════════════════════════

-- Registrar migración completada
INSERT INTO system_config (key, value, updated_at)
VALUES ('migration.005_hierarchical_features', '{"completed": true, "timestamp": "' || 
        TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') || '"}', 
        FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
