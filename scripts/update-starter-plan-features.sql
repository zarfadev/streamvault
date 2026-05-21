-- ════════════════════════════════════════════════════════════════════════════
-- Script de Actualización: Plan Starter - Restricción de Analytics
-- ════════════════════════════════════════════════════════════════════════════
-- Propósito:
--   Actualizar la configuración del plan Starter en workspaces existentes
--   para que analytics esté en false en lugar de "basic"
--
-- Uso:
--   psql -d streamvault -f scripts/update-starter-plan-features.sql
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Actualizar la configuración del plan Starter en system_config
-- ──────────────────────────────────────────────────────────────────────────
UPDATE system_config 
SET value = jsonb_set(
  value::jsonb, 
  '{features,analytics}', 
  'false'::jsonb
)::text,
updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE key = 'plans.starter';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Verificar el cambio
-- ──────────────────────────────────────────────────────────────────────────
SELECT 
  key,
  value::jsonb->'features'->>'analytics' as analytics_value,
  TO_TIMESTAMP(updated_at) as last_update
FROM system_config 
WHERE key = 'plans.starter';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Listar workspaces afectados (solo para información)
-- ──────────────────────────────────────────────────────────────────────────
SELECT 
  w.id,
  w.name,
  w.plan,
  w.created_at,
  COUNT(wm.user_id) as members
FROM workspaces w
LEFT JOIN workspace_members wm ON w.id = wm.workspace_id
WHERE w.plan = 'starter'
GROUP BY w.id, w.name, w.plan, w.created_at
ORDER BY w.created_at DESC;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Registrar la actualización
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, updated_at)
VALUES ('migration.update_starter_analytics', 
        '{"completed": true, "timestamp": "' || 
        TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') || '", "description": "Updated analytics from basic to false for starter plan"}', 
        FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════
-- RESULTADO ESPERADO
-- ══════════════════════════════════════════════════════════════════════════
-- La consulta debería mostrar:
--   key: plans.starter
--   analytics_value: false
--   last_update: [timestamp actual]
--
-- Los usuarios en plan Starter ya NO verán el menú Analytics en su dashboard
-- y recibirán un error 403 si intentan acceder a la API de analytics.
-- ══════════════════════════════════════════════════════════════════════════
