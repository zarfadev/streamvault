-- ============================================================================
-- Setup Embed Tiers & Ads Features
-- Ejecutar: psql streamvault < scripts/setup-embed-tiers.sql
-- ============================================================================

BEGIN;

-- Limpiar features existentes si existen
DELETE FROM plan_features WHERE feature_key IN ('embed_tier', 'ads');

-- ── EMBED TIERS ─────────────────────────────────────────────────────────────
-- Branded: Logo de plataforma (StreamVault)
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
('starter', 'embed_tier', true, '{"tier": "branded"}');

-- Unbranded: Logo del workspace
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
('professional', 'embed_tier', true, '{"tier": "unbranded"}');

-- Custom: Logo workspace + dominio personalizado + ads opcionales
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
('enterprise', 'embed_tier', true, '{"tier": "custom"}');

-- ── ADS FEATURES ────────────────────────────────────────────────────────────
-- Starter: Sin ads
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
('starter', 'ads', false, NULL);

-- Professional: Sin ads
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
('professional', 'ads', false, NULL);

-- Enterprise: Ads opcionales (todas las funciones disponibles)
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
('enterprise', 'ads', true, '{
  "types": ["vast", "banner", "popup"],
  "positions": ["preroll", "midroll", "postroll"],
  "maxBanners": 3,
  "maxPopups": 2
}');

COMMIT;

-- ── VERIFICACIÓN ────────────────────────────────────────────────────────────
SELECT 
  plan_id,
  feature_key,
  enabled,
  config
FROM plan_features 
WHERE feature_key IN ('embed_tier', 'ads')
ORDER BY 
  CASE plan_id 
    WHEN 'starter' THEN 1
    WHEN 'professional' THEN 2
    WHEN 'enterprise' THEN 3
    ELSE 4
  END,
  feature_key;
