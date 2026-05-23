const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { sendPasswordReset, sendWelcome, sendEmailVerification } = require('../services/email');
const rateLimit = require('../middleware/rateLimit');
const logger = require('../services/logger').child({ module: 'auth' });

// ─── reCAPTCHA v3 validation (graceful: skipped when key not configured) ──────
function validatePasswordStrength(password) {
  if (!password || password.length < 8)  return 'Password must be at least 8 characters';
  if (password.length > 128)             return 'Password too long (max 128 characters)';
  if (!/[A-Z]/.test(password))           return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password))           return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password))           return 'Password must contain at least one number';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password))
    return 'Password must contain at least one special character';
  return null;
}

async function verifyCaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true; // not configured — skip
  const siteKey = process.env.RECAPTCHA_SITE_KEY;
  if (!siteKey) return true; // site key not set — frontend can't generate tokens, skip enforcement
  if (!token) return false;
  try {
    const https = require('https');
    const body = `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`;
    const data = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'www.google.com', path: '/recaptcha/api/siteverify', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    return data.success && (data.score === undefined || data.score >= 0.5);
  } catch {
    return true; // fail open: network error shouldn't block legitimate users
  }
}

async function generateTokens(userId) {
  // Add jti (JWT ID) to enable per-token revocation on logout/compromise
  const jti = uuidv4();
  const accessToken = jwt.sign({ userId, jti }, config.jwtSecret, { expiresIn: config.jwtAccessExpiry });
  const refreshToken = jwt.sign({ userId, type: 'refresh' }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiry });

  const tokenId = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
  await db.prepare(`INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`)
    .run(tokenId, userId, refreshToken, expiresAt);

  return { accessToken, refreshToken };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// F3.3: Generate unique referral code — uses random bytes to avoid collisions
async function generateReferralCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const existing = await db.prepare(`SELECT id FROM users WHERE referral_code = ?`).get(code).catch(() => null);
    if (!existing) return code;
  }
  throw new Error('Failed to generate unique referral code after 10 attempts');
}

router.post('/register', rateLimit(5, 60_000), async (req, res) => {
  try {
    const { email, password, name, ref, captchaToken } = req.body;

    const _plat = await require('../services/dynamicConfig')
      .getDynSection('platform', { allowRegistration: true })
      .catch(() => ({ allowRegistration: true }));
    if (_plat.allowRegistration === false) {
      return res.status(403).json({ error: 'El registro público está deshabilitado. Contacta al administrador para obtener acceso.' });
    }

    if (!await verifyCaptcha(captchaToken)) {
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ error: pwError });

    if (name !== undefined && String(name).length > 100) {
      return res.status(400).json({ error: 'Name too long (max 100 characters)' });
    }

    const existing = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const userName = name || email.split('@')[0];

    await db.prepare(`INSERT INTO users (id, email, password_hash, name, platform_role) VALUES (?, ?, ?, ?, 'user')`)
      .run(userId, email.toLowerCase(), passwordHash, userName);

    const workspaceId = uuidv4();
    const slug = userName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + userId.slice(0, 6);
    const plan = config.plans.starter;

    await db.prepare(`INSERT INTO workspaces (id, name, slug, owner_id, plan, max_videos, max_storage_bytes, max_bandwidth_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, `${userName}'s Workspace`, slug, userId, 'starter', plan.maxVideos || 50, (Number(plan.maxStorageGB) || 10) * 1e9, (Number(plan.maxBandwidthGB) || 100) * 1e9);

    await db.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, accepted_at) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), workspaceId, userId, 'owner', Math.floor(Date.now() / 1000));

    // Claim anonymous videos if a guest_session_id is provided
    // NOTE: uses SQLite-compatible syntax (unixepoch() instead of EXTRACT/EPOCH)
    const guestSessionId = req.body.guestSessionId;
    if (guestSessionId) {
      // SQLite does not support RETURNING in all versions; query first, then update
      const pendingVideos = await db.prepare(
        `SELECT id, size FROM videos WHERE guest_session_id = ? AND workspace_id IS NULL`
      ).all(guestSessionId);

      if (pendingVideos.length > 0) {
        const nowUnix = Math.floor(Date.now() / 1000);
        await db.prepare(
          `UPDATE videos SET workspace_id = ?, updated_at = ? WHERE guest_session_id = ? AND workspace_id IS NULL`
        ).run(workspaceId, nowUnix, guestSessionId);

        const claimedSize = pendingVideos.reduce((acc, v) => acc + (Number(v.size) || 0), 0);
        if (claimedSize > 0) {
          await db.prepare(`UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?`)
            .run(claimedSize, workspaceId);
        }
        logger.info({ userId, workspaceId, claimedVideosCount: pendingVideos.length }, 'Claimed anonymous videos for new user');
      }
    }

    const tokens = await generateTokens(userId);

    // Send email verification
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = Math.floor(Date.now() / 1000) + 86400; // 24h
    await db.prepare(`UPDATE users SET verify_token = ?, verify_token_expires = ? WHERE id = ?`)
      .run(verifyToken, verifyExpires, userId);

    // F3.3: Assign referral code and handle referral tracking
    const referralCode = await generateReferralCode();
    await db.prepare(`UPDATE users SET referral_code = ? WHERE id = ?`).run(referralCode, userId).catch(() => {});

    if (ref) {
      // Find referrer by code
      const referrer = await db.prepare(`SELECT id FROM users WHERE referral_code = ?`).get(ref.toUpperCase()).catch(() => null);
      if (referrer && referrer.id !== userId) {
        await db.prepare(
          `INSERT INTO referrals (id, referrer_id, referred_id, plan_at_signup) VALUES (?, ?, ?, 'starter')`
        ).run(uuidv4(), referrer.id, userId).catch(() => {});
      }
    }

    sendEmailVerification(email, userName, verifyToken).catch(err => logger.warn({ err: err.message }, 'Verify email failed'));
    sendWelcome(email, userName).catch(err => logger.warn({ err: err.message }, 'Welcome email failed'));

    res.status(201).json({
      user: { id: userId, email: email.toLowerCase(), name: userName, platform_role: 'user', email_verified: 0 },
      workspace: { id: workspaceId, name: `${userName}'s Workspace`, slug, plan: 'starter' },
      ...tokens,
    });
  } catch (err) {
    logger.error({ err }, 'Register error');
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', rateLimit(10, 60_000), async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body;

    if (!await verifyCaptcha(captchaToken)) {
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.prepare(
      `SELECT id, email, password_hash, name, COALESCE(platform_role, 'user') as platform_role, two_factor_enabled, COALESCE(email_verified, 0) as email_verified FROM users WHERE email = ?`
    ).get(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Por favor verifica tu correo electrónico antes de iniciar sesión', code: 'EMAIL_NOT_VERIFIED' });
    }

    // Si 2FA está habilitado, NO generar tokens todavía
    if (user.two_factor_enabled) {
      // Generar token temporal de 5 minutos
      const tempToken = jwt.sign(
        { userId: user.id, type: 'temp_2fa' },
        config.jwtSecret,
        { expiresIn: '5m' }
      );
      
      logger.info({ userId: user.id, email: user.email }, '2FA required for login');
      
      return res.json({
        requiresTwoFactor: true,
        tempToken,
        message: 'Por favor ingresa tu código de autenticación de dos factores'
      });
    }

    // Login normal sin 2FA
    const workspaces = await db.prepare(`
      SELECT w.id, w.name, w.slug, w.plan, w.avatar_url, wm.role
      FROM workspaces w
      JOIN workspace_members wm ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.created_at ASC
    `).all(user.id);

    const tokens = await generateTokens(user.id);

    res.json({
      user: { id: user.id, email: user.email, name: user.name, platform_role: user.platform_role || 'user' },
      workspaces,
      ...tokens,
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    res.status(500).json({ error: 'Login failed' });
  }
});

// Nuevo endpoint: Verificar 2FA en login
router.post('/verify-2fa-login', rateLimit(5, 300_000), async (req, res) => {
  try {
    const { tempToken, code } = req.body;
    const lockout = require('../services/twoFactorLockout');
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || req.ip || 'unknown';

    if (!tempToken || !code) {
      return res.status(400).json({ error: 'Token temporal y código son requeridos' });
    }

    // Accept TOTP (6 digits) or backup code (8 hex chars)
    const isTOTP = /^\d{6}$/.test(code);
    const isBackup = /^[0-9A-Fa-f]{8}$/.test(code);
    if (!isTOTP && !isBackup) {
      return res.status(400).json({ error: 'Código inválido. Debe ser 6 dígitos o un código de respaldo.' });
    }

    // Verificar tempToken
    let decoded;
    try {
      decoded = jwt.verify(tempToken, config.jwtSecret);
      if (decoded.type !== 'temp_2fa') {
        throw new Error('Invalid token type');
      }
    } catch {
      return res.status(401).json({ error: 'Token temporal inválido o expirado. Intenta hacer login nuevamente.' });
    }

    const userId = decoded.userId;

    // ─── Verificar lockout ANTES de procesar el código ─────────────────────────
    const lockStatus = await lockout.checkLockout(userId, ip);
    if (lockStatus.locked) {
      logger.warn({ userId, ip, remainingMin: lockStatus.remainingMin }, '2FA login blocked — lockout active');
      return res.status(429).json({
        error: `Demasiados intentos fallidos. Inténtalo en ${lockStatus.remainingMin} ${lockStatus.remainingMin === 1 ? 'minuto' : 'minutos'}.`,
        locked: true,
        remainingSec: lockStatus.remainingSec,
        remainingMin: lockStatus.remainingMin,
        attempts: lockStatus.attempts,
      });
    }

    // Obtener secret del usuario
    const user = await db.prepare(
      `SELECT id, email, name, COALESCE(platform_role, 'user') as platform_role, two_factor_secret, two_factor_backup_codes, totp_last_used_window FROM users WHERE id = ?`
    ).get(userId);

    if (!user || !user.two_factor_secret) {
      return res.status(400).json({ error: 'Usuario no tiene 2FA configurado' });
    }

    const twoFactorService = require('../services/twoFactor');
    let authenticated = false;
    const codeType = isTOTP ? 'totp' : 'backup';

    if (isTOTP) {
      const currentWindow = Math.floor(Date.now() / 30000);
      // Reject codes already consumed in the current (or adjacent) TOTP window
      if (user.totp_last_used_window !== null && user.totp_last_used_window !== undefined &&
          currentWindow - user.totp_last_used_window <= 1) {
        lockout.recordFailure(userId, ip);
        return res.status(401).json({ error: 'Código ya utilizado. Espera el siguiente código.' });
      }
      authenticated = twoFactorService.verifyToken(code, user.two_factor_secret);
      if (authenticated) {
        await db.prepare(`UPDATE users SET totp_last_used_window = ? WHERE id = ?`).run(currentWindow, userId);
      }
    }

    if (!authenticated) {
      // Try backup codes — supports both hashed (new) and plain (legacy) formats
      if (user.two_factor_backup_codes) {
        const backupCodes = JSON.parse(user.two_factor_backup_codes);
        const normalised = code.toUpperCase();
        
        // Detect format: hashed codes are 64-char hex strings (SHA-256)
        const isHashedFormat = backupCodes.length > 0 && /^[a-f0-9]{64}$/.test(backupCodes[0]);
        
        if (isHashedFormat) {
          // New hashed format
          const { valid, remainingHashes } = twoFactorService.verifyBackupCodeHashed(code, backupCodes);
          if (valid) {
            await db.prepare(`UPDATE users SET two_factor_backup_codes = ? WHERE id = ?`)
              .run(JSON.stringify(remainingHashes), userId);
            authenticated = true;
            logger.info({ userId, remainingCodes: remainingHashes.length }, '2FA login via hashed backup code');
            // Enviar alerta por email
            const { sendBackupCodeUsedAlert } = require('../services/email');
            sendBackupCodeUsedAlert(user.email, user.name, remainingHashes.length).catch(() => {});
          }
        } else {
          // Legacy plain format
          const idx = backupCodes.findIndex(c => c.toUpperCase() === normalised);
          if (idx !== -1) {
            backupCodes.splice(idx, 1);
            await db.prepare(`UPDATE users SET two_factor_backup_codes = ? WHERE id = ?`)
              .run(JSON.stringify(backupCodes), userId);
            authenticated = true;
            logger.info({ userId, remainingCodes: backupCodes.length }, '2FA login via legacy backup code');
            // Enviar alerta por email
            const { sendBackupCodeUsedAlert } = require('../services/email');
            sendBackupCodeUsedAlert(user.email, user.name, backupCodes.length).catch(() => {});
          }
        }
      }
    }

    // ─── Resultado del intento ─────────────────────────────────────────────────
    if (!authenticated) {
      // Registrar fallo y calcular nuevo estado de lockout
      const failResult = await lockout.recordFailedAttempt(userId, ip, codeType);

      logger.warn({ userId, ip, codeType, attempts: failResult.attempts }, '2FA login failed — invalid code');

      if (failResult.blocked) {
        // Acaba de quedar bloqueado en este intento
        return res.status(429).json({
          error: `Cuenta bloqueada por ${failResult.remainingMin} ${failResult.remainingMin === 1 ? 'minuto' : 'minutos'} tras demasiados intentos fallidos.`,
          locked: true,
          remainingSec: failResult.remainingSec,
          remainingMin: failResult.remainingMin,
          attempts: failResult.attempts,
        });
      }

      // Advertencia de intentos restantes (cuando quedan ≤3)
      const attemptsLeft = failResult.attemptsLeft;
      let warningMsg = 'Código inválido o expirado.';
      if (attemptsLeft > 0 && attemptsLeft <= 3) {
        warningMsg += ` Te quedan ${attemptsLeft} ${attemptsLeft === 1 ? 'intento' : 'intentos'} antes del bloqueo.`;
      }
      
      return res.status(401).json({
        error: warningMsg,
        attemptsLeft,
        locked: false,
      });
    }

    // ─── Login exitoso ─────────────────────────────────────────────────────────
    // Limpiar lockout tras login exitoso
    await lockout.clearLockout(userId, ip);

    const workspaces = await db.prepare(`
      SELECT w.id, w.name, w.slug, w.plan, w.avatar_url, wm.role
      FROM workspaces w
      JOIN workspace_members wm ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.created_at ASC
    `).all(userId);

    const tokens = await generateTokens(userId);

    logger.info({ userId, email: user.email }, 'Login 2FA exitoso');

    res.json({
      user: { id: user.id, email: user.email, name: user.name, platform_role: user.platform_role || 'user' },
      workspaces,
      ...tokens,
    });
  } catch (err) {
    logger.error({ err }, 'Verify 2FA login error');
    res.status(500).json({ error: 'Verificación de 2FA falló' });
  }
});

router.post('/refresh', rateLimit(10, 60_000), async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const stored = await db.prepare(`SELECT * FROM refresh_tokens WHERE token = ? AND user_id = ?`)
      .get(refreshToken, decoded.userId);

    if (!stored) {
      return res.status(401).json({ error: 'Refresh token not found or revoked' });
    }

    if (stored.expires_at < Math.floor(Date.now() / 1000)) {
      await db.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).run(stored.id);
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    await db.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).run(stored.id);
    const tokens = await generateTokens(decoded.userId);

    res.json(tokens);
  } catch (err) {
    logger.error({ err }, 'Refresh error');
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    // 1. Revoke the current access token (jti-based) so it can't be reused
    if (req.tokenJti) {
      // Access tokens expire in 15m — only store revocation until then
      const accessExpiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
      await db.prepare(
        `INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (jti) DO NOTHING`
      ).run(req.tokenJti, req.user.id, accessExpiresAt).catch(() => {});
    }

    // 2. Revoke the refresh token so it can't be used to get new access tokens
    if (refreshToken) {
      await db.prepare(`DELETE FROM refresh_tokens WHERE token = ? AND user_id = ?`)
        .run(refreshToken, req.user.id);
    }

    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.json({ success: true, message: 'Logged out' }); // Always succeed on logout
  }
});

// Changed from 3/min to 3/10min - more aggressive against password reset spam attacks
router.post('/forgot-password', rateLimit(3, 600_000), async (req, res) => {
  try {
    const { email, captchaToken } = req.body;
    if (!await verifyCaptcha(captchaToken)) {
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await db.prepare(`SELECT id, email FROM users WHERE email = ?`).get(email.toLowerCase());

    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = Math.floor(Date.now() / 1000) + 3600;

      await db.prepare(`UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`)
        .run(resetToken, expires, user.id);

      sendPasswordReset(user.email, resetToken).catch(err =>
        logger.error({ err: err.message }, 'Reset email failed')
      );
    }

    res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    logger.error({ err }, 'Forgot password error');
    res.status(500).json({ error: 'Failed to process request' });
  }
});

router.post('/reset-password', rateLimit(5, 60_000), async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const user = await db.prepare(
      `SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > ?`
    ).get(token, Math.floor(Date.now() / 1000));

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    await db.prepare(`UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`)
      .run(passwordHash, user.id);

    // Revoke all sessions after password reset
    await db.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).run(user.id);

    res.json({ success: true, message: 'Password reset successful. Please log in again.' });
  } catch (err) {
    logger.error({ err }, 'Reset password error');
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /auth/verify-email?token=xxx  — called from the link in the email
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/login?verified=invalid');

    const user = await db.prepare(
      `SELECT id FROM users WHERE verify_token = ? AND verify_token_expires > ?`
    ).get(token, Math.floor(Date.now() / 1000));

    if (!user) return res.redirect('/login?verified=invalid');

    await db.prepare(
      `UPDATE users SET email_verified = 1, verify_token = NULL, verify_token_expires = NULL WHERE id = ?`
    ).run(user.id);

    res.redirect('/login?verified=1');
  } catch (err) {
    logger.error({ err }, 'Verify email error');
    res.redirect('/login?verified=invalid');
  }
});

// POST /auth/resend-verification — sends a new verification email
router.post('/resend-verification', rateLimit(3, 60_000), authenticate, async (req, res) => {
  try {
    const user = await db.prepare(`SELECT id, email, name, email_verified FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Invalid request' });
    if (user.email_verified) return res.json({ success: true, message: 'Already verified' });

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = Math.floor(Date.now() / 1000) + 86400;
    await db.prepare(`UPDATE users SET verify_token = ?, verify_token_expires = ? WHERE id = ?`)
      .run(verifyToken, verifyExpires, user.id);

    sendEmailVerification(user.email, user.name, verifyToken).catch(err =>
      logger.warn({ err: err.message }, 'Resend verify failed')
    );

    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    logger.error({ err }, 'Resend verification error');
    res.status(500).json({ error: 'Failed to resend verification' });
  }
});

// POST /auth/request-verification — public, rate-limited; lets unverified users request a new email
router.post('/request-verification', rateLimit(3, 300_000), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' });

    const user = await db.prepare(
      `SELECT id, email, name, email_verified FROM users WHERE email = ?`
    ).get(email.toLowerCase().trim());

    // Always respond success — prevents email enumeration
    if (!user || user.email_verified) return res.json({ success: true });

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = Math.floor(Date.now() / 1000) + 86400;
    await db.prepare(
      `UPDATE users SET verify_token = ?, verify_token_expires = ? WHERE id = ?`
    ).run(verifyToken, verifyExpires, user.id);

    sendEmailVerification(user.email, user.name, verifyToken).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Request verification error');
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const [workspaces, userRow, refStats] = await Promise.all([
      db.prepare(`
        SELECT w.id, w.name, w.slug, w.plan, w.avatar_url, wm.role
        FROM workspaces w
        JOIN workspace_members wm ON w.id = wm.workspace_id
        WHERE wm.user_id = ?
        ORDER BY w.created_at ASC
      `).all(req.user.id),
      db.prepare(`SELECT email_verified, referral_code, two_factor_enabled, channel_name, username, avatar_url FROM users WHERE id = ?`).get(req.user.id),
      db.prepare(`
        SELECT
          COUNT(*)                                              AS total,
          COUNT(*) FILTER (WHERE credited_at IS NOT NULL)      AS converted
        FROM referrals WHERE referrer_id = ?
      `).get(req.user.id),
    ]);

    // Enriquecer workspaces con features disponibles según su plan
    const { getWorkspaceFeatures } = require('../middleware/checkFeature');
    const workspacesWithFeatures = await Promise.all(
      workspaces.map(async (ws) => {
        const features = await getWorkspaceFeatures(ws);
        return { ...ws, features };
      })
    );

    res.json({
      user: { ...req.user, email_verified: userRow?.email_verified || 0, referral_code: userRow?.referral_code || null, twoFactorEnabled: !!(userRow?.two_factor_enabled), channel_name: userRow?.channel_name || null, username: userRow?.username || null, avatar_url: userRow?.avatar_url || null },
      workspaces: workspacesWithFeatures,
      referrals: {
        total:     Number(refStats?.total     ?? 0),
        converted: Number(refStats?.converted ?? 0),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Get me error');
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// ─── Update Profile — PUT /auth/me ───────────────────────────────────────────
router.put('/me', rateLimit(10, 60_000), authenticate, async (req, res) => {
  try {
    const { name, channel_name, username, email, avatar_url } = req.body;
    const updates = {};
    const errors = {};

    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) errors.name = 'El nombre no puede estar vacío';
      else updates.name = n;
    }

    if (channel_name !== undefined) {
      updates.channel_name = String(channel_name).trim() || null;
    }

    if (username !== undefined) {
      const u = String(username).trim().toLowerCase();
      if (u && !/^[a-z0-9_]{3,30}$/.test(u)) {
        errors.username = 'Solo letras, números y guiones bajos. Entre 3 y 30 caracteres.';
      } else if (u) {
        const taken = await db.prepare(`SELECT id FROM users WHERE username = ? AND id != ?`).get(u, req.user.id);
        if (taken) errors.username = 'Ese nombre de usuario ya está en uso.';
        else updates.username = u;
      } else {
        updates.username = null;
      }
    }

    if (email !== undefined) {
      const e = String(email).trim().toLowerCase();
      if (!e || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        errors.email = 'Correo electrónico inválido';
      } else if (e !== req.user.email) {
        const taken = await db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`).get(e, req.user.id);
        if (taken) errors.email = 'Ese correo ya está registrado.';
        else { updates.email = e; updates.email_verified = 0; }
      }
    }

    if (avatar_url !== undefined) {
      const av = String(avatar_url || '').trim();
      // Accept data URLs (base64 images) and https URLs
      if (av && !av.startsWith('data:image/') && !av.startsWith('https://')) {
        errors.avatar_url = 'URL de avatar inválida';
      } else {
        updates.avatar_url = av || null;
      }
    }

    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }
    if (!Object.keys(updates).length) {
      return res.json({ user: req.user });
    }

    const NOW_TS = Math.floor(Date.now() / 1000);
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), NOW_TS, req.user.id];
    await db.prepare(`UPDATE users SET ${setClauses}, updated_at = ? WHERE id = ?`).run(...values);

    const updated = await db.prepare(
      `SELECT id, email, name, channel_name, username, avatar_url, created_at, COALESCE(platform_role, 'user') as platform_role FROM users WHERE id = ?`
    ).get(req.user.id);

    res.json({ user: updated });
  } catch (err) {
    logger.error({ err }, 'Update profile error');
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// F4.1: GDPR Data Export — GET /auth/me/export
const exportRateLimit = rateLimit(1, 24 * 60 * 60 * 1000); // 1 per 24h
router.get('/me/export', exportRateLimit, authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const [user, workspaces, videos, transcriptions] = await Promise.all([
      db.prepare(`SELECT id, email, name, platform_role, created_at, email_verified, referral_code FROM users WHERE id = ?`).get(userId),
      db.prepare(`SELECT w.id, w.name, w.slug, w.plan, wm.role FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id WHERE wm.user_id = ?`).all(userId),
      db.prepare(`SELECT v.id, v.title, v.description, v.status, v.duration, v.views, v.visibility, v.created_at FROM videos v JOIN workspaces w ON v.workspace_id = w.id JOIN workspace_members wm ON w.id = wm.workspace_id WHERE wm.user_id = ?`).all(userId),
      db.prepare(`SELECT t.id, t.language, t.status, t.word_count, t.duration_secs, t.created_at FROM transcriptions t JOIN videos v ON t.video_id = v.id JOIN workspaces w ON v.workspace_id = w.id JOIN workspace_members wm ON w.id = wm.workspace_id WHERE wm.user_id = ?`).all(userId),
    ]);

    const export_data = {
      exported_at: new Date().toISOString(),
      profile: user,
      workspaces,
      videos,
      transcriptions,
    };

    const _platExp = await require('../services/dynamicConfig').getDynSection('platform', {}).catch(() => ({}));
    const _expSlug = (_platExp.siteName || 'StreamVault').toLowerCase().replace(/\s+/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="${_expSlug}-export-${userId}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(export_data);
  } catch (err) {
    logger.error({ err }, 'GDPR export error');
    res.status(500).json({ error: 'Export failed' });
  }
});

// F4.1: GDPR Account Deletion — DELETE /auth/me
const deleteRateLimit = rateLimit(1, 24 * 60 * 60 * 1000); // only once ever
router.delete('/me', deleteRateLimit, authenticate, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password confirmation required' });

  try {
    const user = await db.prepare(`SELECT id, password_hash, stripe_customer_id FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Invalid request' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Collect file paths BEFORE the transaction so cleanup can run after commit
    const s3 = require('../services/s3Storage');
    const ownedWorkspaces = await db.prepare(`SELECT id FROM workspaces WHERE owner_id = ?`).all(req.user.id);

    const fileCleanupTasks = []; // { localPath?, s3Prefix? }
    const cdnPaths = [];
    const wsIds = [];

    for (const ws of ownedWorkspaces) {
      wsIds.push(ws.id);
      const videos = await db.prepare(`SELECT id, s3_object_prefix FROM videos WHERE workspace_id = ?`).all(ws.id);
      for (const v of videos) {
        fileCleanupTasks.push({ localId: v.id, s3Prefix: v.s3_object_prefix || null });
        if (s3.isS3Enabled() && v.s3_object_prefix) {
          cdnPaths.push(`/${v.s3_object_prefix}/*`);
        }
      }
    }

    // Cancel Stripe subscription before deleting the user record
    if (user.stripe_customer_id) {
      try {
        const stripe = require('../services/stripe');
        if (stripe.isStripeEnabled?.()) {
          const stripeClient = stripe.getStripeClient?.();
          if (stripeClient) {
            const subs = await stripeClient.subscriptions.list({ customer: user.stripe_customer_id, limit: 10 });
            for (const sub of subs.data) {
              await stripeClient.subscriptions.cancel(sub.id);
            }
          }
        }
      } catch {}
    }

    // Single transaction: cascade-delete all owned workspace data, then the user
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const wsId of wsIds) {
        await client.query('DELETE FROM workspace_invitations WHERE workspace_id = $1', [wsId]);
        await client.query('DELETE FROM workspace_members    WHERE workspace_id = $1', [wsId]);
        await client.query('DELETE FROM videos               WHERE workspace_id = $1', [wsId]);
        await client.query('DELETE FROM workspaces           WHERE id = $1',           [wsId]);
      }
      // Remove memberships in workspaces the user doesn't own
      await client.query('DELETE FROM workspace_members WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM refresh_tokens    WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM users             WHERE id = $1',      [req.user.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // File cleanup runs AFTER the DB commit so a failure here doesn't leave orphaned records
    for (const task of fileCleanupTasks) {
      try { require('fs').rmSync(require('path').join(__dirname, '..', 'videos', task.localId), { recursive: true, force: true }); } catch {}
      if (s3.isS3Enabled() && task.s3Prefix) {
        s3.deleteObjectsWithPrefix(task.s3Prefix).catch(() => {});
      }
    }
    if (cdnPaths.length) s3.invalidateCDN(cdnPaths).catch(() => {});

    for (const wsId of wsIds) {
      require('../services/cache').invalidate(`sv:ws:${wsId}`).catch(() => {});
    }

    logger.info({ userId: req.user.id }, 'User account deleted (GDPR)');
    res.json({ success: true, message: 'Account and all data permanently deleted.' });
  } catch (err) {
    logger.error({ err }, 'GDPR account deletion error');
    res.status(500).json({ error: 'Deletion failed' });
  }
});

// ─── Change Password ──────────────────────────────────────────────────────────
router.post('/change-password', rateLimit(5, 60_000), authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });
    const user = await db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(newHash, req.user.id);
    // Invalidate all sessions (refresh tokens + current access token)
    await db.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).run(req.user.id);
    if (req.tokenJti) {
      const accessExpiry = Math.floor(Date.now() / 1000) + 15 * 60;
      await db.prepare(
        `INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (jti) DO NOTHING`
      ).run(req.tokenJti, req.user.id, accessExpiry);
    }
    logger.info({ userId: req.user.id }, 'Password changed — all sessions revoked');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Change password error');
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ─── 2FA Management (regular users) ──────────────────────────────────────────

// GET /auth/2fa/status — whether 2FA is enabled for the current user
router.get('/2fa/status', authenticate, async (req, res) => {
  try {
    const user = await db.prepare(
      `SELECT two_factor_enabled, two_factor_backup_codes FROM users WHERE id = ?`
    ).get(req.user.id);
    const backupCodesRemaining = user?.two_factor_backup_codes
      ? JSON.parse(user.two_factor_backup_codes).length
      : 0;
    res.json({
      twoFactorEnabled: !!(user?.two_factor_enabled),
      backupCodesRemaining,
    });
  } catch (err) {
    logger.error({ err }, '2FA status error');
    res.status(500).json({ error: 'Failed to get 2FA status' });
  }
});

// POST /auth/2fa/enable — generate TOTP secret + QR code (does NOT activate yet)
router.post('/2fa/enable', rateLimit(5, 60_000), authenticate, async (req, res) => {
  try {
    const user = await db.prepare(`SELECT email, two_factor_enabled FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Invalid request' });
    if (user.two_factor_enabled) {
      return res.status(400).json({ error: '2FA is already enabled' });
    }
    const twoFactor = require('../services/twoFactor');
    const _plat2fa = await require('../services/dynamicConfig').getDynSection('platform', {}).catch(() => ({}));
    const { secret, otpauthUrl } = twoFactor.generateSecret(user.email, _plat2fa.siteName || 'StreamVault');
    await db.prepare(`UPDATE users SET two_factor_secret = ? WHERE id = ?`).run(secret, req.user.id);

    // Try to generate QR code — use local package first, fall back to Google Charts API
    let qrCode = null;
    try {
      qrCode = await twoFactor.generateQRCode(otpauthUrl);
    } catch (qrErr) {
      logger.warn({ err: qrErr.message }, '2FA local QR generation failed, using fallback');
      // Fallback: use Google Charts API (data URL compatible)
      const encoded = encodeURIComponent(otpauthUrl);
      qrCode = `https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=${encoded}`;
    }

    res.json({ qrCode, secret });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, '2FA enable error');
    res.status(500).json({ error: err.message || 'Failed to generate 2FA secret' });
  }
});

// POST /auth/2fa/verify — verify TOTP code and activate 2FA
router.post('/2fa/verify', rateLimit(10, 60_000), authenticate, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ error: 'A 6-digit code is required' });
    }
    const user = await db.prepare(
      `SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = ?`
    ).get(req.user.id);
    if (!user?.two_factor_secret) {
      return res.status(400).json({ error: 'Run POST /auth/2fa/enable first' });
    }
    if (user.two_factor_enabled) {
      return res.status(400).json({ error: '2FA is already active' });
    }
    const twoFactor = require('../services/twoFactor');
    const valid = twoFactor.verifyToken(token, user.two_factor_secret);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid code — check your authenticator app clock' });
    }
    // Generar códigos hasheados (almacenar hashes, devolver plain)
    const { plainCodes, hashedCodes } = twoFactor.regenerateBackupCodes();
    await db.prepare(
      `UPDATE users SET two_factor_enabled = 1, two_factor_backup_codes = ? WHERE id = ?`
    ).run(JSON.stringify(hashedCodes), req.user.id);
    logger.info({ userId: req.user.id }, '2FA activated with hashed backup codes');
    res.json({ success: true, backupCodes: plainCodes, message: 'Guarda estos códigos en un lugar seguro. No podrás verlos de nuevo.' });
  } catch (err) {
    logger.error({ err }, '2FA verify error');
    res.status(500).json({ error: 'Failed to verify 2FA code' });
  }
});

// POST /auth/2fa/disable — disable 2FA (requires password confirmation)
router.post('/2fa/disable', rateLimit(5, 60_000), authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password confirmation required' });
    const user = await db.prepare(`SELECT password_hash, two_factor_enabled FROM users WHERE id = ?`).get(req.user.id);
    if (!user?.two_factor_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    await db.prepare(
      `UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL, two_factor_backup_codes = NULL WHERE id = ?`
    ).run(req.user.id);
    logger.info({ userId: req.user.id }, '2FA disabled');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '2FA disable error');
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// GET /auth/2fa/backup-codes — fetch remaining backup codes
router.get('/2fa/backup-codes', authenticate, async (req, res) => {
  try {
    const user = await db.prepare(
      `SELECT two_factor_enabled, two_factor_backup_codes FROM users WHERE id = ?`
    ).get(req.user.id);
    if (!user?.two_factor_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }
    // [CRIT-10] Nunca devolver los hashes de backup codes al cliente.
    // Solo informar cuántos códigos quedan disponibles.
    const codes = user.two_factor_backup_codes ? JSON.parse(user.two_factor_backup_codes) : [];
    res.json({ remainingCodes: codes.length });
  } catch (err) {
    logger.error({ err }, 'Backup codes fetch error');
    res.status(500).json({ error: 'Failed to get backup codes' });
  }
});

// POST /auth/2fa/backup-codes/regenerate — burn old codes, generate new ones (hashed)
router.post('/2fa/backup-codes/regenerate', rateLimit(3, 60_000), authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Se requiere confirmación de contraseña' });

    const user = await db.prepare(`SELECT two_factor_enabled, password_hash FROM users WHERE id = ?`).get(req.user.id);
    if (!user?.two_factor_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }
    
    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) return res.status(401).json({ error: 'Contraseña incorrecta' });

    const twoFactor = require('../services/twoFactor');
    const { plainCodes, hashedCodes } = twoFactor.regenerateBackupCodes();
    await db.prepare(`UPDATE users SET two_factor_backup_codes = ? WHERE id = ?`)
      .run(JSON.stringify(hashedCodes), req.user.id);
    logger.info({ userId: req.user.id }, '2FA backup codes regenerated (hashed)');
    res.json({ 
      backupCodes: plainCodes, 
      message: 'Nuevos códigos generados. Guárdalos en un lugar seguro. Los códigos anteriores ya no son válidos.' 
    });
  } catch (err) {
    logger.error({ err }, 'Backup codes regenerate error');
    res.status(500).json({ error: 'Failed to regenerate backup codes' });
  }
});

// ─── Sessions Management ──────────────────────────────────────────────────────

// GET /auth/sessions — list active sessions (refresh tokens)
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const sessions = await db.prepare(
      `SELECT id, created_at, expires_at FROM refresh_tokens WHERE user_id = ? ORDER BY created_at DESC`
    ).all(req.user.id);
    res.json({ sessions });
  } catch (err) {
    logger.error({ err }, 'Sessions list error');
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// DELETE /auth/sessions/:id — revoke a specific session
router.delete('/sessions/:id', authenticate, async (req, res) => {
  try {
    const result = await db.prepare(
      `DELETE FROM refresh_tokens WHERE id = ? AND user_id = ?`
    ).run(req.params.id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Session revoke error');
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// DELETE /auth/sessions — revoke ALL sessions except the current refresh token
router.delete('/sessions', authenticate, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      // Delete all tokens EXCEPT the caller's current refresh token
      await db.prepare(
        `DELETE FROM refresh_tokens WHERE user_id = ? AND token != ?`
      ).run(req.user.id, refreshToken);
    } else {
      // No refresh token provided — delete all (user accepts being logged out)
      await db.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).run(req.user.id);
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Sessions revoke-all error');
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

module.exports = router;

