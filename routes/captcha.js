/**
 * StreamVault Custom CAPTCHA — backend seguro sin dependencias externas.
 *
 * Flujo:
 *  1. GET  /api/captcha/challenge  → genera token HMAC con posición objetivo
 *  2. POST /api/captcha/verify     → valida token + posición + timing
 *     (también exporta verifySvCaptcha() para uso interno en auth.js)
 *
 * Seguridad:
 *  - HMAC-SHA256 firmado con JWT_SECRET → no falsificable
 *  - TTL de 5 minutos incrustado en el token
 *  - One-time use con Set en memoria (limpiado cada 10 min)
 *  - Timing check: rechaza si < 800ms (bots resuelven instantáneo)
 *  - Tolerancia de posición: ±8% del ancho del track
 *  - Rate limit en el endpoint de challenge (30 req/min)
 */
const express  = require('express');
const crypto   = require('crypto');
const config   = require('../config');
const rateLimit = require('../middleware/rateLimit');

const router = express.Router();

// ─── Constantes ────────────────────────────────────────────────────────────────
const CAPTCHA_TTL_MS  = 5 * 60 * 1000;   // 5 min
const TOLERANCE       = 0.08;             // ±8% del track
const MIN_SOLVE_MS    = 800;              // mínimo tiempo para resolver (ms)

// ─── One-time use: Set en memoria limpiado cada 10 min ─────────────────────────
const usedTokens = new Set();
setInterval(() => usedTokens.clear(), 10 * 60 * 1000);

// ─── Helpers de firma ──────────────────────────────────────────────────────────
function signToken(targetPct, nonce, ts) {
  const payload = `${targetPct}:${nonce}:${ts}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret || 'sv-captcha-secret')
    .update(payload).digest('hex');
  // Encodear en base64url para que sea URL-safe
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  let raw;
  try { raw = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }

  const lastDot = raw.lastIndexOf('.');
  if (lastDot < 0) return null;

  const payload = raw.substring(0, lastDot);
  const sig     = raw.substring(lastDot + 1);

  // Verificar firma con timing-safe compare
  const expectedSig = crypto.createHmac('sha256', config.jwtSecret || 'sv-captcha-secret')
    .update(payload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) return null;
  } catch { return null; }

  const parts = payload.split(':');
  if (parts.length < 3) return null;
  const [targetPctStr, nonce, tsStr] = parts;
  const ts = parseInt(tsStr, 10);

  // Verificar TTL
  if (Date.now() - ts > CAPTCHA_TTL_MS) return null;

  return { targetPct: parseFloat(targetPctStr), nonce, ts };
}

// ─── Verificación interna (usada por auth.js) ──────────────────────────────────
/**
 * @param {string}  token      - token recibido del cliente
 * @param {number}  solvedPct  - posición donde soltó el usuario (0–1)
 * @param {number}  startedAt  - timestamp cuando se mostró el captcha (ms)
 * @returns {boolean}
 */
function verifySvCaptcha(token, solvedPct, startedAt) {
  if (!token) return false;
  if (usedTokens.has(token)) return false; // ya usado

  const data = verifyToken(token);
  if (!data) return false;

  // Timing: rechazar si se resolvió demasiado rápido
  const elapsed = typeof startedAt === 'number' ? Date.now() - startedAt : MIN_SOLVE_MS;
  if (elapsed < MIN_SOLVE_MS) return false;

  // Posición dentro de tolerancia
  const diff = Math.abs(parseFloat(solvedPct) - data.targetPct);
  if (diff > TOLERANCE) return false;

  // Marcar como usado (one-time)
  usedTokens.add(token);
  return true;
}

// ─── GET /api/captcha/challenge ───────────────────────────────────────────────
router.get('/challenge', rateLimit(30, 60_000), (req, res) => {
  // Posición aleatoria entre 20% y 75% (dejar margen a ambos lados)
  const targetPct = 0.20 + Math.random() * 0.55;
  const nonce     = crypto.randomBytes(10).toString('hex');
  const ts        = Date.now();
  const token     = signToken(targetPct.toFixed(4), nonce, ts);

  res.json({ token, targetPct: parseFloat(targetPct.toFixed(4)) });
});

// ─── POST /api/captcha/verify (endpoint HTTP opcional para debug) ──────────────
router.post('/verify', rateLimit(20, 60_000), (req, res) => {
  const { token, solvedPct, startedAt } = req.body;
  const ok = verifySvCaptcha(token, solvedPct, startedAt);
  res.json({ ok });
});

module.exports = { router, verifySvCaptcha };
