-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 002: Billing Tables
-- Tablas para facturas y eventos de suscripción
-- ═══════════════════════════════════════════════════════════════════════════

-- Tabla de facturas / comprobantes de pago
CREATE TABLE IF NOT EXISTS payment_invoices (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_number   TEXT NOT NULL UNIQUE,
  amount           NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed | refunded | void
  provider         TEXT NOT NULL DEFAULT 'stripe',   -- stripe | paypal | binance
  plan             TEXT NOT NULL DEFAULT 'starter',
  description      TEXT DEFAULT '',
  period_start     BIGINT,
  period_end       BIGINT,
  invoice_url      TEXT,                             -- URL externa (Stripe hosted invoice)
  invoice_pdf_url  TEXT,                             -- URL del PDF generado localmente
  provider_invoice_id TEXT,                          -- ID en Stripe/PayPal
  created_at       BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  paid_at          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_payment_invoices_workspace
  ON payment_invoices(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_invoices_status
  ON payment_invoices(status);

CREATE INDEX IF NOT EXISTS idx_payment_invoices_provider_id
  ON payment_invoices(provider_invoice_id);

-- Tabla de eventos de suscripción (auditoría de cambios de plan)
CREATE TABLE IF NOT EXISTS subscription_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,  -- activated | cancelled | upgraded | downgraded | suspended | restored | payment_failed
  from_plan    TEXT,
  to_plan      TEXT,
  provider     TEXT,
  subscription_id TEXT,
  metadata     TEXT DEFAULT '{}',
  created_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_workspace
  ON subscription_events(workspace_id, created_at DESC);
