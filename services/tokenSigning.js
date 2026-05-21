/**
 * Video token signing — HMAC-SHA256.
 *
 * Two token types:
 *   • Video tokens  — short-lived (15 min), domain-bound, gate HLS access.
 *   • Unlock tokens — 24 h, gate password-protected video metadata.
 *
 * Format: base64url(json_payload).base64url(hmac_signature)
 */
const crypto = require('crypto');
const cfg    = require('../config');

const TOKEN_TTL  = 15 * 60;          // 15 minutes — tight window for theft
const RENEW_HINT = TOKEN_TTL - 120;  // renew 2 min before expiry

function _hmac(data, prefix = '') {
  return crypto
    .createHmac('sha256', cfg.jwtSecret)
    .update(prefix + data)
    .digest('base64url');
}

function _sign(payload, prefix = '') {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${p}.${_hmac(p, prefix)}`;
}

function _verify(token, prefix = '') {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const p   = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = _hmac(p, prefix);
  // Pad the provided sig to match HMAC length so timingSafeEqual never throws,
  // and length differences don't leak timing information.
  const expBuf = Buffer.from(exp);
  const sigBuf = Buffer.alloc(expBuf.length, 0);
  Buffer.from(sig).copy(sigBuf, 0, 0, Math.min(sig.length, expBuf.length));
  if (!crypto.timingSafeEqual(expBuf, sigBuf)) return null;
  // Reject if original sig length doesn't match (padding attack guard).
  if (sig.length !== exp.length) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}

// ─── Video tokens (HLS access) ────────────────────────────────
// `origin` — the requesting hostname (e.g. "example.com").
// A token issued for origin A is rejected on origin B.
function signVideoToken(videoId, origin = '') {
  return _sign({ v: videoId, o: origin, e: Math.floor(Date.now() / 1000) + TOKEN_TTL });
}

function verifyVideoToken(token, videoId, origin = '') {
  const d = _verify(token);
  if (!d) return false;
  if (d.v !== videoId) return false;
  if (d.e < Math.floor(Date.now() / 1000)) return false;
  // Origin binding is mandatory: a token issued for origin A is always rejected on origin B.
  // Tokens issued for '' (localhost/dev) only work when origin is also '' or localhost.
  const tokenOrigin = d.o || '';
  const reqOrigin   = origin || '';
  if (tokenOrigin !== reqOrigin) return false;
  return true;
}

// Seconds until the token expires (for client-side renewal scheduling).
function tokenExpiresIn(token) {
  const d = _verify(token);
  if (!d) return 0;
  return Math.max(0, d.e - Math.floor(Date.now() / 1000));
}

const tokensRequired = () => process.env.REQUIRE_VIDEO_TOKENS === 'true';

// ─── Unlock tokens (password-protected videos) ───────────────
const UNLOCK_TTL = 24 * 60 * 60; // 24 hours

function signUnlockToken(videoId) {
  return _sign({ u: videoId, e: Math.floor(Date.now() / 1000) + UNLOCK_TTL }, 'unlock:');
}

function verifyUnlockToken(token, videoId) {
  const d = _verify(token, 'unlock:');
  if (!d) return false;
  if (d.u !== videoId) return false;
  if (d.e < Math.floor(Date.now() / 1000)) return false;
  return true;
}

// ─── Download tokens (F2.5) ───────────────────────────────────
const DOWNLOAD_TTL = 10 * 60; // 10 minutes

function signDownloadToken(videoId) {
  return _sign({ d: videoId, e: Math.floor(Date.now() / 1000) + DOWNLOAD_TTL }, 'dl:');
}

function verifyDownloadToken(token, videoId) {
  const data = _verify(token, 'dl:');
  if (!data) return false;
  if (data.d !== videoId) return false;
  if (data.e < Math.floor(Date.now() / 1000)) return false;
  return true;
}

// ─── Cast tokens (Chromecast session access) ──────────────────
// Longer TTL because TV cast sessions can run for hours.
// Bound only to videoId — no origin, since the Chromecast device has its own IP.
const CAST_TTL = 4 * 60 * 60; // 4 hours

function signCastToken(videoId) {
  return _sign({ c: videoId, e: Math.floor(Date.now() / 1000) + CAST_TTL }, 'cast:');
}

function verifyCastToken(token, videoId) {
  if (!token || !videoId) return false;
  const d = _verify(token, 'cast:');
  if (!d) return false;
  if (d.c !== videoId) return false;
  if (d.e < Math.floor(Date.now() / 1000)) return false;
  return true;
}

module.exports = {
  signVideoToken, verifyVideoToken, tokenExpiresIn, tokensRequired,
  signUnlockToken, verifyUnlockToken,
  signDownloadToken, verifyDownloadToken,
  signCastToken, verifyCastToken,
  RENEW_HINT,
};
