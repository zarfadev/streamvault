-- Migration 007: Embed Tiers, Custom Domain y Sistema de Anuncios
-- Fecha: 13 de Mayo de 2026

-- ════════════════════════════════════════════════════════════════════
-- 1. CUSTOM DOMAIN para embeds (Plan Enterprise)
-- ════════════════════════════════════════════════════════════════════

-- Ya existe custom_embed_domain en db/schema.js línea 359
-- Agregar columnas de verificación
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_domain_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_domain_verified_at BIGINT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_domain_last_check BIGINT;

-- Índice para búsquedas rápidas de dominios verificados
CREATE INDEX IF NOT EXISTS idx_workspaces_custom_domain 
  ON workspaces(custom_embed_domain) 
  WHERE custom_domain_verified = TRUE;

-- ════════════════════════════════════════════════════════════════════
-- 2. ADS SYSTEM - Sistema de anuncios configurado por plan
-- ════════════════════════════════════════════════════════════════════

-- Los anuncios se guardan en workspaces.settings JSON:
-- {
--   "ads": {
--     "enabled": true,
--     "type": "vast" | "banner" | "popup" | "all",
--     "vastUrl": "https://...",
--     "vastPosition": "preroll" | "midroll" | "postroll",
--     "vastMidrollTime": 30,
--     "bannerHtml": "<div>...</div>",
--     "bannerPosition": "top" | "bottom",
--     "bannerDelay": 5,
--     "bannerAutoClose": 10,
--     "popupUrl": "https://...",
--     "popupDelay": 10,
--     "popupFrequency": 3
--   }
-- }

-- Los permisos de ads se controlan en system_config:
-- plans.starter.features.adsEnabled = 'enabled' | 'disabled'
-- plans.pro.features.adsEnabled = 'enabled'
-- plans.enterprise.features.adsEnabled = 'enabled'

-- No necesita columnas adicionales, todo en JSON settings

-- ════════════════════════════════════════════════════════════════════
-- 3. PLATFORM BRANDING - Logo de StreamVault configurable por admin
-- ════════════════════════════════════════════════════════════════════

-- Se guarda en system_config con clave 'platform':
-- {
--   "platformLogoUrl": "https://cdn.streamvault.com/logo.svg",
--   "platformLogoPos": "tr" | "tl" | "br" | "bl",
--   "platformName": "StreamVault"
-- }

-- Los embed tiers se configuran por plan en system_config:
-- plans.starter.features.embedEnabled = 'branded'     (con logo StreamVault)
-- plans.pro.features.embedEnabled = 'unbranded'       (sin logo StreamVault)
-- plans.enterprise.features.embedEnabled = 'custom'   (control total)

COMMENT ON COLUMN workspaces.custom_domain_verified IS 'TRUE si el dominio personalizado ha sido verificado vía DNS';
COMMENT ON COLUMN workspaces.custom_domain_verified_at IS 'Timestamp de última verificación exitosa (Unix epoch seconds)';
