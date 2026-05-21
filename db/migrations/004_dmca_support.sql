-- ════════════════════════════════════════════════════════════════════════════
-- Migration 004: DMCA Support
-- ════════════════════════════════════════════════════════════════════════════
-- Adds DMCA suspension fields to videos table for copyright compliance
-- Allows admins to suspend videos and track DMCA takedown notices

-- Add DMCA fields to videos table
ALTER TABLE videos 
ADD COLUMN IF NOT EXISTS dmca_suspended BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS dmca_reason TEXT,
ADD COLUMN IF NOT EXISTS dmca_suspended_at BIGINT,
ADD COLUMN IF NOT EXISTS dmca_suspended_by TEXT REFERENCES users(id);

-- Create index for quick filtering of DMCA suspended videos
CREATE INDEX IF NOT EXISTS idx_videos_dmca_suspended ON videos(dmca_suspended) WHERE dmca_suspended = TRUE;

-- Add audit log entry (generate UUID for id)
INSERT INTO audit_log (id, actor_id, actor_email, action, target_type, target_id, metadata, ip, created_at)
VALUES (
  gen_random_uuid()::text,
  'system',
  'system@streamvault.link',
  'migration.executed',
  'database',
  '004_dmca_support',
  '{"description": "Added DMCA suspension support to videos table"}',
  '127.0.0.1',
  FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
) ON CONFLICT DO NOTHING;
