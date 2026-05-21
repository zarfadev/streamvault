/**
 * Two-Factor Authentication (2FA) Service
 * Implementación con TOTP (Time-based One-Time Password)
 * Compatible con Google Authenticator, Authy, Microsoft Authenticator
 * 
 * Requiere: npm install speakeasy qrcode
 */

const crypto = require('crypto');
const logger = require('./logger').child({ module: '2fa' });

function bufferToBase32(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    result += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return result;
}

/**
 * Genera un secreto único para 2FA
 * @param {string} email - Email del usuario
 * @param {string} issuer - Nombre de la aplicación
 * @returns {Object} { secret, qrCodeUrl, backupCodes }
 */
function generateSecret(email, issuer = 'Platform') {
  // Generar secreto aleatorio
  const secret = bufferToBase32(crypto.randomBytes(20));
  
  // Crear URL para QR code (compatible con Google Authenticator)
  const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
  
  // FIX #12: Generate backup codes that will be hashed before storage
  // Return plain codes to user, but caller must hash them before storing
  const backupCodes = Array.from({ length: 8 }, () => 
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
  
  logger.info({
    event: '2fa_secret_generated',
    email,
    secretLength: secret.length,
  });
  
  return {
    secret,
    otpauthUrl,
    backupCodes,
  };
}

/**
 * Verifica un código TOTP
 * @param {string} token - Código de 6 dígitos ingresado por el usuario
 * @param {string} secret - Secreto del usuario
 * @returns {boolean} True si el código es válido
 */
function verifyToken(token, secret) {
  if (!token || !secret) return false;
  
  // Limpiar el token (remover espacios, guiones)
  const cleanToken = token.replace(/[\s-]/g, '');
  
  // Verificar que sea numérico y de 6 dígitos
  if (!/^\d{6}$/.test(cleanToken)) return false;
  
  // Generar el código esperado basado en el tiempo actual
  const expectedToken = generateTOTP(secret);
  
  // Permitir un margen de ±30 segundos (1 paso antes/después)
  const time = Math.floor(Date.now() / 1000);
  const step = 30; // segundos por paso
  
  const tokens = [
    generateTOTP(secret, time - step),  // paso anterior
    generateTOTP(secret, time),         // paso actual
    generateTOTP(secret, time + step),  // paso siguiente
  ];
  
  const isValid = tokens.includes(cleanToken);
  
  if (isValid) {
    logger.info({
      event: '2fa_token_verified',
      success: true,
    });
  } else {
    logger.warn({
      event: '2fa_token_verification_failed',
      tokenProvided: cleanToken.substring(0, 2) + '****', // Log parcial por seguridad
    });
  }
  
  return isValid;
}

/**
 * Genera un código TOTP para un tiempo específico
 * @param {string} secret - Secreto base32
 * @param {number} time - Timestamp en segundos (opcional)
 * @returns {string} Código de 6 dígitos
 */
function generateTOTP(secret, time) {
  const epoch = time || Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30); // Ventana de 30 segundos
  
  // Convertir secret de base32 a buffer
  const keyBuffer = base32ToBuffer(secret);
  
  // Crear mensaje con el tiempo (8 bytes, big-endian)
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(timeStep));
  
  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', keyBuffer);
  hmac.update(message);
  const hash = hmac.digest();
  
  // Dynamic truncation (RFC 4226)
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = 
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  
  // Obtener últimos 6 dígitos
  const otp = (binary % 1000000).toString().padStart(6, '0');
  
  return otp;
}

/**
 * Convierte string base32 a Buffer
 * @param {string} base32 - String en base32
 * @returns {Buffer}
 */
function base32ToBuffer(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanBase32 = base32.toUpperCase().replace(/=+$/, '');
  
  let bits = '';
  for (const char of cleanBase32) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error('Invalid base32 character');
    bits += val.toString(2).padStart(5, '0');
  }
  
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  
  return Buffer.from(bytes);
}

/**
 * Verifica un código de respaldo
 * @param {string} code - Código de respaldo
 * @param {Array<string>} backupCodes - Lista de códigos válidos
 * @returns {Object} { valid: boolean, remainingCodes: Array }
 */
function verifyBackupCode(code, backupCodes) {
  if (!code || !Array.isArray(backupCodes)) {
    return { valid: false, remainingCodes: backupCodes };
  }
  
  const cleanCode = code.replace(/[\s-]/g, '').toUpperCase();
  const index = backupCodes.indexOf(cleanCode);
  
  if (index === -1) {
    logger.warn({
      event: '2fa_backup_code_invalid',
      codeProvided: cleanCode.substring(0, 4) + '****',
    });
    return { valid: false, remainingCodes: backupCodes };
  }
  
  // Remover el código usado
  const remainingCodes = backupCodes.filter((_, i) => i !== index);
  
  logger.info({
    event: '2fa_backup_code_used',
    remainingCodesCount: remainingCodes.length,
  });
  
  return { valid: true, remainingCodes };
}

/**
 * Genera nuevo conjunto de códigos de respaldo
 * @param {number} count - Cantidad de códigos (default: 8)
 * @returns {{ plainCodes: Array<string>, hashedCodes: Array<string> }}
 */
function regenerateBackupCodes(count = 8) {
  const plainCodes = Array.from({ length: count }, () => 
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
  
  const hashedCodes = plainCodes.map(code => hashBackupCode(code));
  
  logger.info({
    event: '2fa_backup_codes_regenerated',
    count: plainCodes.length,
  });
  
  return { plainCodes, hashedCodes };
}

/**
 * Genera códigos de respaldo en formato legacy (solo plain text)
 * Para compatibilidad con código existente durante migración
 * @param {number} count
 * @returns {Array<string>}
 */
function regenerateBackupCodesLegacy(count = 8) {
  return Array.from({ length: count }, () => 
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
}

/**
 * Hashea un código de respaldo individual con SHA-256
 * @param {string} code - Código en texto plano
 * @returns {string} Hash SHA-256 en hex
 */
function hashBackupCode(code) {
  return crypto.createHash('sha256')
    .update(code.toUpperCase().trim())
    .digest('hex');
}

/**
 * Verifica un código de respaldo contra una lista de hashes
 * @param {string} code - Código proporcionado por el usuario
 * @param {Array<string>} hashedCodes - Lista de hashes almacenados
 * @returns {{ valid: boolean, remainingHashes: Array<string>, usedIndex: number }}
 */
function verifyBackupCodeHashed(code, hashedCodes) {
  if (!code || !Array.isArray(hashedCodes) || hashedCodes.length === 0) {
    return { valid: false, remainingHashes: hashedCodes || [], usedIndex: -1 };
  }
  
  const codeHash = hashBackupCode(code);
  const index = hashedCodes.findIndex(h => h === codeHash);
  
  if (index === -1) {
    logger.warn({
      event: '2fa_backup_code_invalid_hashed',
      codeProvided: code.substring(0, 4) + '****',
    });
    return { valid: false, remainingHashes: hashedCodes, usedIndex: -1 };
  }
  
  // Remover el código usado
  const remainingHashes = hashedCodes.filter((_, i) => i !== index);
  
  logger.info({
    event: '2fa_backup_code_used_hashed',
    remainingCodesCount: remainingHashes.length,
  });
  
  return { valid: true, remainingHashes, usedIndex: index };
}

/**
 * Genera QR code como Data URL para mostrar en frontend
 * Requiere: npm install qrcode
 * @param {string} otpauthUrl - URL otpauth://
 * @returns {Promise<string>} Data URL del QR code
 */
async function generateQRCode(otpauthUrl) {
  try {
    const QRCode = require('qrcode');
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
    });
    return qrDataUrl;
  } catch (error) {
    logger.error({
      event: '2fa_qr_generation_failed',
      error: error.message,
    });
    throw new Error('No se pudo generar el código QR');
  }
}

/**
 * Middleware para requerir 2FA
 * Verifica que el usuario tenga 2FA habilitado y validado en la sesión
 */
function require2FA(req, res, next) {
  const user = req.user;
  
  if (!user) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  
  // Si el usuario tiene 2FA habilitado pero no verificado en esta sesión
  if (user.two_factor_enabled && !req.session?.twoFactorVerified) {
    return res.status(403).json({
      error: 'Verificación de 2FA requerida',
      require2FA: true,
    });
  }
  
  next();
}

/**
 * Estadísticas de uso de 2FA
 */
function getStats(db) {
  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN two_factor_enabled = 1 THEN 1 ELSE 0 END) as users_with_2fa,
        SUM(CASE WHEN two_factor_enabled = 0 THEN 1 ELSE 0 END) as users_without_2fa
      FROM users
    `).get();
    
    const percentage = stats.total_users > 0 
      ? Math.round((stats.users_with_2fa / stats.total_users) * 100)
      : 0;
    
    return {
      ...stats,
      adoption_percentage: percentage,
    };
  } catch (error) {
    logger.error({
      event: '2fa_stats_error',
      error: error.message,
    });
    return null;
  }
}

module.exports = {
  generateSecret,
  verifyToken,
  verifyBackupCode,
  verifyBackupCodeHashed,
  regenerateBackupCodes,
  regenerateBackupCodesLegacy,
  hashBackupCode,
  generateQRCode,
  require2FA,
  getStats,
};
