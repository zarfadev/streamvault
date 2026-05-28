/**
 * PostgreSQL schema — idempotent (safe to run on every startup).
 * Uses BIGINT unix timestamps to keep parity with existing data.
 */
const logger = require('../services/logger').child({ module: 'schema' });

const NOW = `FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT`;

async function createSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id                   TEXT PRIMARY KEY,
      title                TEXT NOT NULL,
      description          TEXT DEFAULT '',
      original_filename    TEXT,
      status               TEXT DEFAULT 'processing',
      qualities            TEXT DEFAULT '[]',
      thumbnail            TEXT,
      duration             DOUBLE PRECISION DEFAULT 0,
      size                 BIGINT DEFAULT 0,
      views                INTEGER DEFAULT 0,
      workspace_id         TEXT,
      guest_session_id     TEXT,
      hls_cdn_url          TEXT,
      s3_object_prefix     TEXT,
      visibility           TEXT DEFAULT 'public',
      access_password_hash TEXT,
      hls_key              TEXT,
      hls_key_id           TEXT,
      created_at           BIGINT DEFAULT ${NOW},
      updated_at           BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      name            TEXT NOT NULL DEFAULT '',
      email_verified  INTEGER DEFAULT 0,
      reset_token     TEXT,
      reset_token_expires BIGINT,
      platform_role   TEXT DEFAULT 'user',
      created_at      BIGINT DEFAULT ${NOW},
      updated_at      BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      slug                  TEXT UNIQUE NOT NULL,
      owner_id              TEXT NOT NULL REFERENCES users(id),
      plan                  TEXT DEFAULT 'starter',
      max_videos            INTEGER DEFAULT 10,
      max_storage_bytes     BIGINT DEFAULT 5368709120,
      max_bandwidth_bytes   BIGINT DEFAULT 107374182400,
      storage_used_bytes    BIGINT DEFAULT 0,
      bandwidth_used_bytes  BIGINT DEFAULT 0,
      suspended             INTEGER DEFAULT 0,
      settings              TEXT DEFAULT '{}',
      custom_limits         TEXT DEFAULT NULL,
      stripe_customer_id    TEXT,
      stripe_subscription_id TEXT,
      payment_provider      TEXT DEFAULT 'stripe',
      payment_customer_id   TEXT,
      payment_subscription_id TEXT,
      payment_metadata      TEXT DEFAULT '{}',
      created_at            BIGINT DEFAULT ${NOW},
      updated_at            BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         TEXT DEFAULT 'viewer',
      accepted_at  BIGINT,
      created_at   BIGINT DEFAULT ${NOW},
      UNIQUE(workspace_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email        TEXT NOT NULL,
      role         TEXT DEFAULT 'viewer',
      token        TEXT UNIQUE NOT NULL,
      invited_by   TEXT REFERENCES users(id),
      accepted_at  BIGINT,
      expires_at   BIGINT NOT NULL,
      created_at   BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chapters (
      id         TEXT PRIMARY KEY,
      video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      start_time DOUBLE PRECISION NOT NULL DEFAULT 0,
      position   INTEGER DEFAULT 0,
      created_at BIGINT DEFAULT ${NOW},
      updated_at BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      workspace_id TEXT,
      viewer_id   TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      position    DOUBLE PRECISION DEFAULT 0,
      quality     TEXT,
      ip          TEXT,
      country     TEXT,
      city        TEXT,
      device_type TEXT,
      browser     TEXT,
      os          TEXT,
      created_at  BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_config (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id           TEXT PRIMARY KEY,
      video_id     TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      language     TEXT NOT NULL DEFAULT 'es',
      status       TEXT NOT NULL DEFAULT 'pending',
      vtt_content  TEXT,
      word_count   INTEGER DEFAULT 0,
      duration_secs DOUBLE PRECISION DEFAULT 0,
      error_msg    TEXT,
      created_at   BIGINT DEFAULT ${NOW},
      updated_at   BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_progress (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      position   DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at BIGINT DEFAULT ${NOW},
      PRIMARY KEY (user_id, video_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_tracks (
      id             TEXT PRIMARY KEY,
      video_id       TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      kind           TEXT NOT NULL,
      language       TEXT NOT NULL DEFAULT 'und',
      label          TEXT NOT NULL DEFAULT '',
      src_path       TEXT,
      format         TEXT,
      default_track  INTEGER DEFAULT 0,
      created_at     BIGINT DEFAULT ${NOW}
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      prefix       TEXT NOT NULL,
      last_used_at BIGINT,
      created_at   BIGINT DEFAULT ${NOW}
    )
  `);

  // Columns added after initial schema release
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires BIGINT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0`);

  // 2FA columns
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_backup_codes TEXT`);
  // Tracks the last consumed TOTP window (floor(epoch/30)) to block same-window replay
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_used_window BIGINT`);

  // AI Content Intelligence columns (added for Pro/Enterprise plan feature)
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_title       TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_description TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_summary     TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_generated_at BIGINT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS intro_start INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS intro_end   INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS outro_start INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS outro_end   INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS short_code  VARCHAR(10) UNIQUE`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_short_code ON videos(short_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_videos_guest_session_id ON videos(guest_session_id) WHERE guest_session_id IS NOT NULL`);
  // Backfill short_code for existing videos that don't have one yet
  await (async () => {
    const crypto = require('crypto');
    const rows = await pool.query(`SELECT id FROM videos WHERE short_code IS NULL`);
    for (const row of rows.rows) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = crypto.randomBytes(4).toString('hex');
        try {
          await pool.query(`UPDATE videos SET short_code = $1 WHERE id = $2 AND short_code IS NULL`, [code, row.id]);
          break;
        } catch (_) { /* collision — retry */ }
      }
    }
  })();

  // ── F2.1: Folders ─────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS folders (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      parent_id    TEXT REFERENCES folders(id) ON DELETE SET NULL,
      created_at   BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_folders_workspace ON folders(workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id)`);

  // ── F2.2: Playlists ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playlists (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT DEFAULT '',
      visibility   TEXT DEFAULT 'public',
      created_at   BIGINT DEFAULT ${NOW},
      updated_at   BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playlist_videos (
      id          TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      position    INTEGER DEFAULT 0,
      created_at  BIGINT DEFAULT ${NOW},
      UNIQUE(playlist_id, video_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_playlist_videos ON playlist_videos(playlist_id, position ASC)`);

  // ── F2.3: Webhooks ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      url          TEXT NOT NULL,
      events       TEXT NOT NULL DEFAULT '[]',
      secret       TEXT NOT NULL DEFAULT '',
      enabled      INTEGER DEFAULT 1,
      created_at   BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id          TEXT PRIMARY KEY,
      webhook_id  TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event       TEXT NOT NULL,
      payload     TEXT,
      status_code INTEGER,
      response_body TEXT,
      created_at  BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhooks_workspace ON webhooks(workspace_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, created_at DESC)`);

  // PPV feature removed — table retained for historical data only, no new code uses it

  // ── F3.2: Scheduled publishing ────────────────────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS publish_at BIGINT`);

  // ── TMDB metadata ─────────────────────────────────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS tmdb_id   TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS tmdb_type TEXT DEFAULT 'movie'`);

  // ── Transcoding progress (inline mode) ────────────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcoding_pct INTEGER DEFAULT NULL`);

  // ── F3.3: Referrals ───────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id             TEXT PRIMARY KEY,
      referrer_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_at_signup TEXT,
      credited_at    BIGINT,
      created_at     BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS free_months_remaining INTEGER DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)`);

  // ── F3.4: Audit log ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      actor_id    TEXT,
      actor_email TEXT,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      metadata    TEXT,
      ip          TEXT,
      created_at  BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC)`);

  // ── F4.2: Analytics retention ─────────────────────────────────
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS analytics_retention_days INTEGER DEFAULT 90`);

  // ── F4.3: Status checks ───────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_checks (
      service    TEXT NOT NULL,
      healthy    INTEGER DEFAULT 1,
      checked_at BIGINT DEFAULT ${NOW},
      PRIMARY KEY (service)
    )
  `);

  // ── F2.7: Custom embed domain ─────────────────────────────────
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_embed_domain TEXT`);
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_domain_verified BOOLEAN DEFAULT FALSE`);

  // ── F2.6: Watermarking settings (stored in workspace.settings JSON) ──
  // No schema change needed — stored as JSON in workspaces.settings

  // ── Missing columns added after initial schema ─────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'processing'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`);

  // ── User profile fields ────────────────────────────────────────
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS channel_name TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL`);

  // ── Workspace avatar (per-workspace logo, separate from owner's user avatar) ──
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS avatar_url TEXT`);

  // ── API Key Scopes (Fase 2) ────────────────────────────────────
  await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT DEFAULT '["videos:read"]'`);

  // ── JWT Revocation (jti) ──────────────────────────────────────
  // Stores revoked access token IDs so that compromised tokens can be invalidated
  // before their natural expiry (15m). Cleaned up automatically every hour.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti        TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      revoked_at BIGINT DEFAULT ${NOW},
      expires_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user    ON revoked_tokens(user_id)`);
  // Index on users.email for fast lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  // Index on users.referral_code for fast referral lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`);
  // ── Referral credit balance (USD, ready to apply on next checkout) ─────────
  // Populated when user redeems referral credits; zeroed after gateway confirms payment.
  await pool.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS referral_credit_usd NUMERIC(10,2) DEFAULT 0`);
  // Index on videos.status for fast status filtering
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status)`);
  // Index on videos.visibility for public video queries
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_videos_visibility ON videos(visibility)`);
  // Index on refresh_tokens.token for fast token validation
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)`);
  // Index on audit_log target
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id)`);
  // Index on workspace_invitations token
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invitations_token ON workspace_invitations(token)`);
  // Index on workspace_invitations workspace+email
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON workspace_invitations(workspace_id, email)`);

  // ── Indexes ────────────────────────────────────────────────────
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_videos_workspace    ON videos(workspace_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_events_video        ON events(video_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_events_video_viewer ON events(video_id, viewer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_workspace    ON events(workspace_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chapters_video      ON chapters(video_id, start_time ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_video ON transcriptions(video_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ws_members_user     ON workspace_members(user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_members_ws_user ON workspace_members(workspace_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_video_tracks_video  ON video_tracks(video_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_workspace  ON api_keys(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix     ON api_keys(prefix)`,
    // Full-text search index for video title/description ILIKE queries (M-06)
    `CREATE INDEX IF NOT EXISTS idx_videos_title_search ON videos USING gin(to_tsvector('simple', coalesce(title, '')))`,
    `CREATE INDEX IF NOT EXISTS idx_videos_ws_status    ON videos(workspace_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_publish_at   ON videos(publish_at) WHERE publish_at IS NOT NULL`,
  ];
  for (const idx of indexes) await pool.query(idx);

  // ── Billing: payment_invoices + subscription_events ───────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_invoices (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      invoice_number      TEXT NOT NULL,
      amount              NUMERIC(10,2) NOT NULL DEFAULT 0,
      currency            TEXT NOT NULL DEFAULT 'USD',
      status              TEXT NOT NULL DEFAULT 'pending',
      provider            TEXT NOT NULL DEFAULT 'stripe',
      plan                TEXT NOT NULL DEFAULT 'starter',
      description         TEXT DEFAULT '',
      period_start        BIGINT,
      period_end          BIGINT,
      invoice_url         TEXT,
      invoice_pdf_url     TEXT,
      provider_invoice_id TEXT,
      created_at          BIGINT NOT NULL DEFAULT ${NOW},
      paid_at             BIGINT
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_invoices_number ON payment_invoices(invoice_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_invoices_workspace ON payment_invoices(workspace_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_invoices_provider_id ON payment_invoices(provider_invoice_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_events (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      from_plan       TEXT,
      to_plan         TEXT,
      provider        TEXT,
      subscription_id TEXT,
      metadata        TEXT DEFAULT '{}',
      created_at      BIGINT NOT NULL DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscription_events_workspace ON subscription_events(workspace_id, created_at DESC)`);

  // ── Tags (JSON array of strings) ──────────────────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]'`);

  // ── Video expiry ────────────────────────────────────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS expires_at BIGINT DEFAULT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_videos_expires_at ON videos(expires_at) WHERE expires_at IS NOT NULL`);

  // ── In-app notifications ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL DEFAULT 'info',
      title        TEXT NOT NULL,
      body         TEXT DEFAULT '',
      link         TEXT,
      read_at      BIGINT,
      created_at   BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at) WHERE read_at IS NULL`);

  // ── DMCA suspension columns ────────────────────────────────────
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS dmca_suspended   BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS dmca_suspended_at BIGINT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS dmca_suspended_by TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS dmca_reason       TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS dmca_notice_date  BIGINT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS dmca_notes        TEXT`);

  // ── Source file reference for manual retry ────────────────────────────────
  // Stores the upload path (local: absolute path) or S3 source key (S3 mode).
  // Kept until the video is deleted so users can re-trigger transcoding.
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS source_file TEXT`);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS qualities_expected INTEGER DEFAULT NULL`);

  // ── Early thumbnail CDN URL ────────────────────────────────────
  // Set as soon as thumbnail is generated (before full S3 upload) so the UI
  // can show a thumbnail during transcoding even in S3/multi-container mode.
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail_url TEXT DEFAULT NULL`);

  // ── Security: password change timestamp ────────────────────────
  // Used by middleware/auth.js to invalidate JWTs issued before a password reset.
  // A JWT whose iat < password_changed_at is rejected immediately (no need to wait for expiry).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at BIGINT DEFAULT NULL`);

  // ── Status history — uptime persistente entre reinicios ────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_history (
      id         BIGSERIAL PRIMARY KEY,
      service    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'ok',
      latency_ms INTEGER,
      checked_at BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_status_history_service_time ON status_history(service, checked_at DESC)`);

  // ── Status incidents & maintenance ─────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_incidents (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL DEFAULT 'incident',
      title        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'investigating',
      impact       TEXT NOT NULL DEFAULT 'minor',
      services     TEXT DEFAULT '[]',
      scheduled_at BIGINT,
      resolved_at  BIGINT,
      created_by   TEXT,
      created_at   BIGINT DEFAULT ${NOW},
      updated_at   BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS status_updates (
      id          TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
      body        TEXT NOT NULL,
      status      TEXT,
      created_by  TEXT,
      created_at  BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_status_incidents_type ON status_incidents(type, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_status_updates_incident ON status_updates(incident_id, created_at ASC)`);

  // ── Ad Creatives Library ────────────────────────────────────────
  // Biblioteca de creativos de anuncios gestionada por el super admin.
  // Los creativos tipo 'vast_video' tienen un endpoint VAST propio en /api/ads/vast/:id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_creatives (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'vast_url',
      -- VAST URL externo (Google IMA, DoubleClick, etc.)
      vast_url     TEXT,
      -- VAST con video propio (subido o URL externa al video)
      video_url    TEXT,
      click_url    TEXT,
      duration_sec INTEGER DEFAULT 15,
      -- Banner HTML
      banner_html     TEXT,
      banner_position TEXT DEFAULT 'bottom',
      banner_delay    INTEGER DEFAULT 0,
      banner_duration INTEGER DEFAULT 0,
      -- Popup
      popup_url       TEXT,
      popup_delay     INTEGER DEFAULT 10,
      popup_frequency INTEGER DEFAULT 1,
      -- Shared
      vast_position TEXT DEFAULT 'preroll',
      notes         TEXT,
      is_active     BOOLEAN DEFAULT TRUE,
      created_at    BIGINT DEFAULT ${NOW},
      updated_at    BIGINT DEFAULT ${NOW}
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ad_creatives_type ON ad_creatives(type)`);

  // ── Seed demo account (dev / SEED_DEMO_USER=1) ─────────────────
  await seedDemo(pool);
  await applySuperAdminBootstrap(pool);

  logger.info('Schema ready (PostgreSQL)');
}

async function seedDemo(pool) {
  const nodeEnv = process.env.NODE_ENV || 'development';

  // [CRIT-06] Guard estricto: en producción el seed demo NUNCA se ejecuta,
  // incluso si SEED_DEMO_USER=1. Las credenciales demo son públicas y conocidas.
  if (nodeEnv === 'production') {
    logger.warn('seedDemo: SKIPPED in production (demo credentials are publicly known)');
    return;
  }

  // En development/test, solo si SEED_DEMO_USER=1 está explícitamente seteado
  if (process.env.SEED_DEMO_USER !== '1') return;

  const { rows } = await pool.query(`SELECT id FROM users WHERE email = 'demo@streamvault.local'`);
  if (rows.length) return;

  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const { v4: uuidv4 } = require('uuid');
  const config = require('../config');

  const userId = uuidv4();
  // [CRIT-06] Generar un password aleatorio en cada seed en lugar de usar 'demo12345' hardcodeado
  const demoPassword = crypto.randomBytes(12).toString('base64');
  const hash = bcrypt.hashSync(demoPassword, config.bcryptRounds);
  const wsId = uuidv4();
  const slug = `demo-${userId.slice(0, 8)}`;
  const plan = config.plans?.starter || { maxVideos: 10, maxStorageGB: 5, maxBandwidthGB: 100 };
  const NOW = Math.floor(Date.now() / 1000);

  try {
    // ON CONFLICT guards against the API server + worker racing through the SELECT
    // above simultaneously — both see 0 rows, both try to insert; the loser is a no-op.
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, platform_role, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'user',$5,$5) ON CONFLICT (email) DO NOTHING`,
      [userId, 'demo@streamvault.local', hash, 'Demo', NOW]
    );
    // Verify we actually inserted (the other process may have won the race)
    const { rows: inserted } = await pool.query(`SELECT id FROM users WHERE email = 'demo@streamvault.local'`);
    if (!inserted.length) return;
    const actualUserId = inserted[0].id;

    await pool.query(
      `INSERT INTO workspaces (id, name, slug, owner_id, plan, max_videos, max_storage_bytes, max_bandwidth_bytes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'starter',$5,$6,$7,$8,$8) ON CONFLICT DO NOTHING`,
      [wsId, 'Espacio de Demo', slug, actualUserId, plan.maxVideos, (plan.maxStorageGB || 5) * 1e9, (plan.maxBandwidthGB || 100) * 1e9, NOW]
    );
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, accepted_at)
       VALUES ($1,$2,$3,'owner',$4) ON CONFLICT DO NOTHING`,
      [uuidv4(), wsId, actualUserId, NOW]
    );
    // Only log if this process actually created the demo user
    if (actualUserId === userId) {
      logger.info(`Demo account seeded: demo@streamvault.local / ${demoPassword}  ← SOLO PARA DESARROLLO`);
    }
  } catch (err) {
    // Race condition — the other process inserted first. Safe to ignore.
    if (err.code === '23505') return;
    throw err;
  }
}

async function applySuperAdminBootstrap(pool) {
  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (!rows.length) {
    logger.warn({ email }, 'SUPER_ADMIN_EMAIL not found — register the account first and restart');
    return;
  }
  await pool.query(`UPDATE users SET platform_role = 'super_admin' WHERE email = $1`, [email]);
  logger.info({ email }, 'Super admin assigned');
}

module.exports = { createSchema };
