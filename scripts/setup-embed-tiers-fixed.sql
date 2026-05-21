-- ============================================================================
-- Setup Embed Tiers & Ads Features (Sistema Real - system_config)
-- Ejecutar: psql streamvault < scripts/setup-embed-tiers-fixed.sql
-- ============================================================================

BEGIN;

-- ── ACTUALIZAR PLAN STARTER ────────────────────────────────────────────────
UPDATE system_config
SET value = jsonb_set(
  jsonb_set(
    value::jsonb,
    '{features,embed}',
    '"branded"'
  ),
  '{features,ads}',
  'false'
)::text,
updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE key = 'plans.starter';

-- ── ACTUALIZAR PLAN PRO (PROFESSIONAL) ─────────────────────────────────────
UPDATE system_config
SET value = jsonb_set(
  jsonb_set(
    value::jsonb,
    '{features,embed}',
    '"unbranded"'
  ),
  '{features,ads}',
  'false'
)::text,
updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE key = 'plans.pro';

-- ── ACTUALIZAR PLAN ENTERPRISE ──────────────────────────────────────────────
UPDATE system_config
SET value = jsonb_set(
  jsonb_set(
    jsonb_set(
      value::jsonb,
      '{features,embed}',
      '"custom"'
    ),
    '{features,ads}',
    'true'
  ),
  '{features,adsConfig}',
  '{"types": ["vast", "banner", "popup"], "positions": ["preroll", "midroll", "postroll"], "maxBanners": 3, "maxPopups": 2}'::jsonb
)::text,
updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE key = 'plans.enterprise';

COMMIT;

-- ── VERIFICACIÓN ────────────────────────────────────────────────────────────
SELECT 
  key,
  value::jsonb->'name' as plan_name,
  value::jsonb->'features'->>'embed' as embed_tier,
  value::jsonb->'features'->>'ads' as ads_enabled,
  value::jsonb->'features'->'adsConfig' as ads_config
FROM system_config 
WHERE key LIKE 'plans.%'
ORDER BY 
  CASE key
    WHEN 'plans.starter' THEN 1
    WHEN 'plans.pro' THEN 2
    WHEN 'plans.enterprise' THEN 3
    ELSE 4
  END;
