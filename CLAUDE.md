# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the API server (requires PostgreSQL + Redis running)
npm start           # node server.js — port 3000

# Start the background worker (must run alongside the server)
npm run worker      # node worker.js — consumes Bull/Redis queues

# Full stack via Docker (recommended for development)
docker-compose up

# Direct dependency stack (no Docker)
# PostgreSQL on :5432, Redis on :6379, then:
DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 npm start
DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 npm run worker
```

There is no test runner or linter configured. No build step — Node.js runs files directly.

## Architecture

StreamVault is split into two processes that **must both run**:

| Process | File | Role |
|---|---|---|
| API server | `server.js` | HTTP, auth, static files, HLS delivery |
| Worker | `worker.js` | FFmpeg transcoding, OpenAI Whisper subtitles |

They share the same PostgreSQL DB, Redis (Bull queues), and the `uploads/` + `videos/` directories (or an S3 bucket). In Docker, both containers mount the same volumes.

### Database layer (`db/`)

`db/index.js` is a thin async adapter over `pg`. It exposes a **better-sqlite3-compatible API** (`db.prepare(sql).get/all/run(...)`) so routes read like sync SQLite code but use `await`. All `?` placeholders are converted to `$N` PostgreSQL style internally. `db.pool` is exposed for raw transactions.

`db/schema.js` runs on every startup (`db.init()`) and is fully idempotent — uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for migrations.

`db.js` at root is just `module.exports = require('./db/index')` — a redirect kept for backwards compat.

### Request flow

```
Request → CORS → Security headers → /api/billing/webhooks (raw body) → express.json()
       → /videos/* (HLS token enforcement + bandwidth tracking + static files)
       → Route handlers
```

Auth middleware (`middleware/auth.js`):
- `authenticate` — requires JWT or `sv_live_xxx` API key
- `optionalAuth` — sets `req.user` if present, continues either way
- `superAdminAuth` — JWT with `platform_role=super_admin`, or `ADMIN_API_KEY`, or localhost in dev

Workspace middleware (`middleware/workspace.js`):
- `resolveWorkspace` — reads `X-Workspace-Id` header or `:workspaceId` param, sets `req.workspace` + `req.workspaceRole`. Always called after `authenticate`.
- `requireRole(...roles)` — must follow `resolveWorkspace`
- `checkLimit('video_count' | 'storage')` — enforces plan quotas before upload

### Video pipeline

Upload → `uploads/{timestamp}-{filename}` → Bull job on `"transcoding"` queue → `worker.js` picks up → `transcoder.js`:
1. `ffprobe` → detect resolution
2. Per applicable quality preset: `ffmpeg` → HLS segments + AES-128 key → `videos/{id}/{quality}/`
3. Generate `master.m3u8` with `EXT-X-MEDIA` for subtitle/audio tracks
4. Generate `thumb.jpg` + sprite sheet
5. Optional: upload everything to S3, set `hls_cdn_url`
6. DB update: `status = 'ready'`, `qualities`, `duration`, etc.
7. Send completion email

Quality presets are hardcoded in `transcoder.js`: 360p, 480p, 720p, 1080p, 1440p, 4K. Only presets ≤ source height are applied.

The transcoder falls back to **inline mode** (runs in the API server process) when Redis is unavailable.

### Queues (`services/queue.js`)

Two Bull queues share the same Redis:
- `"transcoding"` — FFmpeg jobs, max 1h timeout, 3 retries with exponential backoff
- `"transcription"` — Whisper jobs (OpenAI API), silently disabled when Redis unavailable

Both queue singletons are lazy-created and cached. The server only uses `addTranscodeJob` / `addTranscribeJob`; `startWorker` / `startTranscribeWorker` are only called from `worker.js`.

### HLS token system (`services/tokenSigning.js`)

HMAC-SHA256 tokens with 15-min TTL, bound to `videoId + origin hostname`. Tokens are enforced on `/videos/*` in `server.js` when `REQUIRE_VIDEO_TOKENS=true` or when the video's workspace has `embedAllowedDomains` configured. The player auto-renews tokens 2 minutes before expiry.

### Storage

- **Local**: `videos/{videoId}/` served via `express.static`
- **S3**: `services/s3Storage.js` uses streaming uploads (no RAM spike). `CLOUDFRONT_BASE_URL` is used as the CDN base for playlist URLs. `DELETE_LOCAL_AFTER_S3=1` cleans local files post-upload.

### AI features (`services/bedrock.js`, `services/whisper.js`)

- Whisper transcription → VTT stored in `transcriptions` table, searchable cues
- Bedrock (Claude via AWS) → `ai_title`, `ai_description`, `ai_summary` on `videos` table. Only runs for Pro/Enterprise workspaces. Auto-creates chapters if none exist. Called from `services/queue.js` after transcription completes.
- Model default: `BEDROCK_MODEL_ID` env var (update to `claude-haiku-4-5-20251001` for current Claude 4 Haiku)

### Frontend

All frontend is **vanilla JS + HTML, no framework, no build step**. Pages:

| Path | File |
|---|---|
| `/dashboard` | `public/dashboard/index.html` (~4200 lines) |
| `/admin` | `public/admin/index.html` |
| `/embed/:id` | `public/embed/index.html` |
| `/watch/:id` | `public/player/index.html` |
| `/login` | `public/login/index.html` |

The dashboard is a single-file SPA. All JS is inline. HLS.js is loaded from CDN (`cdn.jsdelivr.net`). The embed and player pages are near-duplicates of each other.

### Multi-tenancy

Every resource belongs to a `workspace`. Users are members of workspaces with roles `owner | admin | viewer`. Plan limits (`max_videos`, `max_storage_bytes`, `max_bandwidth_bytes`) are stored on the workspace row and enforced at upload time by `checkLimit` middleware.

`settings` on workspaces is a JSON blob (`TEXT` column) containing `embedAllowedDomains`, player branding, etc. Always access via `req.workspace.settings` (already parsed by `resolveWorkspace`).

### Billing (`services/stripe.js`, `routes/billing.js`)

Stripe webhooks update workspace `plan`, `stripe_customer_id`, `stripe_subscription_id`. Webhook handler is at `POST /api/billing/webhooks` and receives raw body (bypasses `express.json()`). Plan tier changes are applied in the webhook handler, not in the checkout flow.

### Key env vars

Required in production: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`. Everything else degrades gracefully (email falls back to console, S3 falls back to local, Stripe/Whisper/Bedrock features simply disabled).

`config.js` reads all env vars and exports a frozen object — all modules import from `config`, never `process.env` directly.

### SQL conventions

- All timestamps are **UNIX epoch integers** (`BIGINT`), not `TIMESTAMP`. Use `FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT` in raw SQL.
- Use `db.prepare(sql).run(...)` for writes, `.get(...)` for single row, `.all(...)` for many.
- For transactions, use `db.pool` directly: `const client = await db.pool.connect(); await client.query('BEGIN'); ...`
- PostgreSQL-specific SQL required — no SQLite functions.
