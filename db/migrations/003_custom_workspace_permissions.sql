-- Migration 003: Custom workspace permissions and free plan support
-- Permite a los admins ajustar límites personalizados por workspace
-- y soporta planes gratuitos (precio = 0) sin requerir pasarela de pago

-- Agregar columna para permisos/límites personalizados por workspace
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_limits TEXT DEFAULT NULL;

-- Comentario explicativo
COMMENT ON COLUMN workspaces.custom_limits IS 'JSON object with custom overrides for workspace limits (e.g., {"maxVideos": 500, "maxStorageGB": 1000}). NULL means use plan defaults.';

-- Índice para búsquedas de workspaces con límites custom
CREATE INDEX IF NOT EXISTS idx_workspaces_custom_limits ON workspaces(custom_limits) WHERE custom_limits IS NOT NULL;
