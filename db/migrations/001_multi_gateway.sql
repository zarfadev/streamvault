-- ══════════════════════════════════════════════════════════════════════════════
-- Migration: Multi-Gateway Payment Support
-- Description: Migra de campos específicos de Stripe a campos genéricos que 
--              soportan múltiples proveedores (Stripe, PayPal, Binance Pay)
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Respaldar datos existentes de Stripe en una tabla temporal
CREATE TABLE IF NOT EXISTS workspaces_stripe_backup AS
SELECT 
  id,
  stripe_customer_id,
  stripe_subscription_id
FROM workspaces
WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL;

-- 2. Agregar nuevos campos genéricos
ALTER TABLE workspaces 
  ADD COLUMN IF NOT EXISTS payment_provider TEXT DEFAULT 'stripe';

ALTER TABLE workspaces 
  ADD COLUMN IF NOT EXISTS payment_customer_id TEXT;

ALTER TABLE workspaces 
  ADD COLUMN IF NOT EXISTS payment_subscription_id TEXT;

ALTER TABLE workspaces 
  ADD COLUMN IF NOT EXISTS payment_metadata TEXT DEFAULT '{}';

-- 3. Migrar datos de Stripe a campos genéricos
UPDATE workspaces
SET 
  payment_provider = 'stripe',
  payment_customer_id = stripe_customer_id,
  payment_subscription_id = stripe_subscription_id
WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL;

-- 4. Eliminar columnas antiguas de Stripe (opcional, comentado por seguridad)
-- ⚠️ Descomentar solo después de verificar que la migración funciona correctamente
-- ALTER TABLE workspaces DROP COLUMN IF EXISTS stripe_customer_id;
-- ALTER TABLE workspaces DROP COLUMN IF EXISTS stripe_subscription_id;

-- 5. Crear índices para mejorar performance en consultas de billing
CREATE INDEX IF NOT EXISTS idx_workspaces_payment_provider 
  ON workspaces(payment_provider);

CREATE INDEX IF NOT EXISTS idx_workspaces_payment_subscription 
  ON workspaces(payment_subscription_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- Para ejecutar esta migración:
-- psql -U your_user -d streamvault -f db/migrations/001_multi_gateway.sql
-- ══════════════════════════════════════════════════════════════════════════════
