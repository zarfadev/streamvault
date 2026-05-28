-- Migration 008: user_reports table for contact form messages from /status
CREATE TABLE IF NOT EXISTS user_reports (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  subject      TEXT,
  message      TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'contact',  -- contact | incident | feedback
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | reviewed | resolved
  admin_note   TEXT,
  reviewed_at  BIGINT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_reports_status     ON user_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_created_at ON user_reports(created_at DESC);
