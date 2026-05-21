-- Migration 006: Player features (custom embed domain, ads system)
-- Run: psql $DATABASE_URL -f db/migrations/006_player_features.sql

-- Custom embed domain verification status
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_embed_domain TEXT DEFAULT NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_domain_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_domain_verified_at TIMESTAMP DEFAULT NULL;

-- Ads configuration per workspace (stored in settings JSON already, but add dedicated columns for indexing)
-- The ads config is stored in workspace settings JSON field as:
-- ads: { enabled, type: 'vast'|'banner'|'popup', vastUrl, bannerHtml, bannerPosition, popupUrl, popupDelay, popupFrequency }

-- Platform branding is stored in system_config as 'platform' key JSON:
-- platformLogoUrl: URL del logo de StreamVault que aparece en players branded
-- platformLogoPos: posición del logo (tr, tl, br, bl) default: tr
-- platformName: nombre que aparece en el player
