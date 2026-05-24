/**
 * Advanced Rate Limiting Middleware
 * Múltiples niveles de protección contra abuso y ataques de fuerza bruta
 * 
 * Features:
 * - Rate limiting por IP
 * - Rate limiting por usuario
 * - Detección de patrones de ataque
 * - Blacklist automática temporal
 * - Whitelist de IPs confiables
 * - Logging de intentos sospechosos
 */

const cfg    = require('../config');
const logger = require('../services/logger').child({ module: 'advancedRateLimit' });

// ── Redis client (lazy — shared blacklist across PM2 cluster workers) ─────────
let _redis = null;

function getRedis() {
  if (_redis) return _redis;
  if (!cfg.redisUrl) return null;
  try {
    const Redis = require('ioredis');
    _redis = new Redis(cfg.redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      lazyConnect: true,
      commandTimeout: 200,
    });
    _redis.on('error', () => {});
    return _redis;
  } catch {
    return null;
  }
}

const BL_PREFIX = 'sv:blk:';

// Stores
const ipStore = new Map();           // IP → { count, firstHit, blocked }
const userStore = new Map();         // userId → { count, firstHit }
const blacklist = new Map();         // IP → expiryTimestamp (in-memory mirror / fallback)
const whitelist = new Set();         // IPs confiables (admin, monitoring)

// Pre-load trusted IPs from TRUSTED_IPS env var (comma-separated)
// e.g. TRUSTED_IPS=186.85.11.203,10.0.0.1
// These IPs bypass all rate limiting and can never be auto-blocked.
if (process.env.TRUSTED_IPS) {
  process.env.TRUSTED_IPS.split(',').map(ip => ip.trim()).filter(Boolean).forEach(ip => {
    whitelist.add(ip);
  });
}

// Configuración
const config = {
  // Límites globales por IP — aumentado a 500 para soportar reproducciones HLS
  // simultáneas y múltiples ventanas del player sin rate limiting falso positivo.
  // Las rutas /videos/ y /api/videos/ se excluyen en server.js adicionalmente.
  globalIpLimit: 500,           // 500 requests
  globalIpWindow: 60 * 1000,    // por minuto
  
  // Límites por endpoint
  endpoints: {
    '/auth/login': {
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,  // 15 minutos
      blockDuration: 30 * 60 * 1000, // 30 minutos de bloqueo
    },
    '/auth/verify-2fa-login': {
      maxAttempts: 10,
      windowMs: 15 * 60 * 1000,  // 15 minutos
      blockDuration: 15 * 60 * 1000, // 15 minutos (complementa el lockout por userId)
    },
    '/auth/register': {
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000,  // 1 hora
      blockDuration: 60 * 60 * 1000, // 1 hora de bloqueo
    },
    '/auth/forgot-password': {
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000,  // 1 hora
      blockDuration: 2 * 60 * 60 * 1000, // 2 horas
    },
    '/api/admin': {
      maxAttempts: 20,
      windowMs: 60 * 1000,       // 1 minuto
      blockDuration: 10 * 60 * 1000, // 10 minutos
    },
    '/api/playlists': {
      maxAttempts: 30,
      windowMs: 60 * 1000,       // 1 minuto
      blockDuration: 5 * 60 * 1000,
    },
    '/api/webhooks': {
      maxAttempts: 20,
      windowMs: 60 * 1000,
      blockDuration: 5 * 60 * 1000,
    },
    '/api/folders': {
      maxAttempts: 30,
      windowMs: 60 * 1000,
      blockDuration: 5 * 60 * 1000,
    },
    '/api/workspaces': {
      maxAttempts: 30,
      windowMs: 60 * 1000,
      blockDuration: 5 * 60 * 1000,
    },
    '/api/apikeys': {
      maxAttempts: 20,
      windowMs: 60 * 1000,
      blockDuration: 10 * 60 * 1000,
    },
  },
  
  // Detección de patrones de ataque
  patternDetection: {
    enabled: true,
    suspiciousThreshold: 50,    // 50 requests en ventana = sospechoso
    attackThreshold: 100,       // 100 requests = ataque activo
    windowMs: 60 * 1000,        // ventana de 1 minuto
  },
};

// Limpieza periódica de stores
setInterval(() => {
  const now = Date.now();
  
  // Limpiar ipStore
  for (const [ip, data] of ipStore) {
    if (now - data.firstHit > config.globalIpWindow) {
      ipStore.delete(ip);
    }
  }
  
  // Limpiar userStore
  for (const [userId, data] of userStore) {
    if (now - data.firstHit > config.globalIpWindow) {
      userStore.delete(userId);
    }
  }
  
  // Limpiar blacklist expiradas
  for (const [ip, expiry] of blacklist) {
    if (now > expiry) {
      blacklist.delete(ip);
      logger.info(`IP ${ip} removida de blacklist (expiración)`);
    }
  }
}, 5 * 60 * 1000); // Cada 5 minutos

/**
 * Extrae la IP real del cliente.
 * Usa req.ip que Express calcula correctamente según la configuración de
 * "trust proxy". Si trust proxy está activo, req.ip refleja el XFF del proxy
 * de confianza; si no, usa la dirección del socket directamente.
 * Nunca leer X-Forwarded-For manualmente — puede ser falsificado por el cliente.
 */
function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Verifica si una IP está en whitelist
 */
function isWhitelisted(ip) {
  if (whitelist.has(ip)) return true;
  // Solo confiar en loopback como whitelist automático.
  // 192.168.x y 10.x se excluyen: en cloud pueden ser IPs de clientes reales.
  return ip === '127.0.0.1' || ip === '::1';
}

/**
 * Verifica si una IP está bloqueada.
 * Checks Redis first (shared across cluster workers), falls back to in-memory.
 * Returns { blocked: bool, remainingMs: number }.
 */
async function isBlacklisted(ip) {
  const r = getRedis();
  if (r) {
    try {
      const pttl = await r.pttl(BL_PREFIX + ip); // -2=missing, -1=no TTL, >0=ms left
      if (pttl > 0) return { blocked: true, remainingMs: pttl };
      if (pttl === -1) { r.del(BL_PREFIX + ip).catch(() => {}); } // stale key, clean up
      // pttl === -2: not in Redis — check in-memory mirror below
    } catch {}
  }

  // In-memory fallback
  const expiry = blacklist.get(ip);
  if (!expiry) return { blocked: false, remainingMs: 0 };
  const remainingMs = expiry - Date.now();
  if (remainingMs <= 0) { blacklist.delete(ip); return { blocked: false, remainingMs: 0 }; }
  return { blocked: true, remainingMs };
}

/**
 * Agrega IP a blacklist temporal.
 * Writes to both Redis (shared) and in-memory (fast local path).
 */
function blockIp(ip, durationMs, reason) {
  const expiry = Date.now() + durationMs;
  blacklist.set(ip, expiry);

  // Fire-and-forget Redis write — other cluster workers will read this
  const r = getRedis();
  if (r) r.set(BL_PREFIX + ip, '1', 'PX', durationMs).catch(() => {});

  logger.warn({
    event: 'ip_blocked',
    ip,
    reason,
    durationMinutes: Math.round(durationMs / 60000),
    expiresAt: new Date(expiry).toISOString(),
  });
}

/**
 * Detecta patrones de ataque
 */
function detectAttackPattern(ip) {
  if (!config.patternDetection.enabled) return false;
  
  const data = ipStore.get(ip);
  if (!data) return false;
  
  const now = Date.now();
  const windowStart = now - config.patternDetection.windowMs;
  
  // Contar requests en ventana reciente
  const recentCount = data.count;
  
  if (recentCount >= config.patternDetection.attackThreshold) {
    logger.error({
      event: 'attack_pattern_detected',
      ip,
      requestCount: recentCount,
      windowMs: config.patternDetection.windowMs,
    });
    
    // Bloqueo automático por 1 hora
    blockIp(ip, 60 * 60 * 1000, 'attack_pattern_detected');
    return true;
  }
  
  if (recentCount >= config.patternDetection.suspiciousThreshold) {
    logger.warn({
      event: 'suspicious_activity',
      ip,
      requestCount: recentCount,
      windowMs: config.patternDetection.windowMs,
    });
  }
  
  return false;
}

/**
 * Rate limiting global por IP
 */
function checkGlobalLimit(ip) {
  const now = Date.now();
  let data = ipStore.get(ip);
  
  if (!data) {
    data = { count: 0, firstHit: now, blocked: false };
    ipStore.set(ip, data);
  }
  
  // Reset si pasó la ventana
  if (now - data.firstHit > config.globalIpWindow) {
    data.count = 0;
    data.firstHit = now;
  }
  
  data.count++;
  
  // Verificar límite global
  if (data.count > config.globalIpLimit) {
    detectAttackPattern(ip);
    return false;
  }
  
  return true;
}

/**
 * Rate limiting específico por endpoint
 */
function checkEndpointLimit(ip, path) {
  // Buscar configuración del endpoint
  let endpointConfig = null;
  for (const [pattern, conf] of Object.entries(config.endpoints)) {
    if (path.startsWith(pattern)) {
      endpointConfig = conf;
      break;
    }
  }
  
  if (!endpointConfig) return true; // Sin límite específico
  
  const key = `${ip}:${path}`;
  const now = Date.now();
  
  let data = ipStore.get(key);
  if (!data) {
    data = { count: 0, firstHit: now };
    ipStore.set(key, data);
  }
  
  // Reset si pasó la ventana
  if (now - data.firstHit > endpointConfig.windowMs) {
    data.count = 0;
    data.firstHit = now;
  }
  
  data.count++;
  
  // Verificar límite del endpoint
  if (data.count > endpointConfig.maxAttempts) {
    // Bloquear IP temporalmente
    blockIp(ip, endpointConfig.blockDuration, `exceeded_limit_${path}`);
    
    logger.warn({
      event: 'endpoint_limit_exceeded',
      ip,
      path,
      attempts: data.count,
      maxAttempts: endpointConfig.maxAttempts,
    });
    
    return false;
  }
  
  return true;
}

/**
 * Middleware principal de rate limiting avanzado
 */
function advancedRateLimit(options = {}) {
  const skipPaths = options.skipPaths || [];
  
  return async (req, res, next) => {
    // Skip para paths específicos
    if (skipPaths.some(p => req.path.startsWith(p))) {
      return next();
    }

    const ip = getClientIp(req);

    // 1. Verificar whitelist
    if (isWhitelisted(ip)) {
      return next();
    }

    // 2. Verificar blacklist (async — reads Redis so all workers share the list)
    const blResult = await isBlacklisted(ip);
    if (blResult.blocked) {
      const remainingMin = Math.ceil(blResult.remainingMs / 60000);

      logger.warn({
        event: 'blocked_request_attempt',
        ip,
        path: req.path,
        method: req.method,
        remainingMinutes: remainingMin,
      });

      return res.status(403).json({
        error: 'Tu IP ha sido bloqueada temporalmente por actividad sospechosa.',
        retryAfter: remainingMin,
        retryAfterSeconds: Math.ceil(blResult.remainingMs / 1000),
      });
    }

    // 3. Verificar límite global
    if (!checkGlobalLimit(ip)) {
      logger.warn({
        event: 'global_limit_exceeded',
        ip,
        path: req.path,
        method: req.method,
      });
      
      return res.status(429).json({
        error: 'Demasiadas solicitudes. Por favor intenta más tarde.',
        retryAfter: Math.ceil(config.globalIpWindow / 1000),
      });
    }
    
    // 4. Verificar límite por endpoint
    if (!checkEndpointLimit(ip, req.path)) {
      const endpointConfig = Object.entries(config.endpoints)
        .find(([pattern]) => req.path.startsWith(pattern))?.[1];
      
      const retryAfter = endpointConfig ? Math.ceil(endpointConfig.blockDuration / 1000) : 1800;
      
      return res.status(429).json({
        error: 'Demasiados intentos fallidos. Tu IP ha sido bloqueada temporalmente.',
        retryAfter,
        retryAfterSeconds: retryAfter,
      });
    }
    
    // Todo OK, continuar
    next();
  };
}

/**
 * Agregar IP a whitelist manualmente
 */
function addToWhitelist(ip) {
  whitelist.add(ip);
  logger.info(`IP ${ip} agregada a whitelist`);
}

/**
 * Remover IP de whitelist
 */
function removeFromWhitelist(ip) {
  whitelist.delete(ip);
  logger.info(`IP ${ip} removida de whitelist`);
}

/**
 * Obtener estadísticas
 */
function getStats() {
  return {
    activeIps: ipStore.size,
    blacklistedIps: blacklist.size,
    whitelistedIps: whitelist.size,
    config: {
      globalLimit: `${config.globalIpLimit} req/${config.globalIpWindow}ms`,
      endpoints: Object.keys(config.endpoints),
    },
    blacklist: Array.from(blacklist.entries()).map(([ip, expiry]) => ({
      ip,
      expiresIn: Math.ceil((expiry - Date.now()) / 60000) + ' min',
    })),
  };
}

/**
 * Limpiar manualmente un IP de blacklist (para admin)
 */
function unblockIp(ip) {
  const wasBlocked = blacklist.delete(ip);
  const r = getRedis();
  if (r) r.del(BL_PREFIX + ip).catch(() => {});
  if (wasBlocked) {
    logger.info(`IP ${ip} manualmente desbloqueada por administrador`);
  }
  return wasBlocked;
}

module.exports = {
  globalLimiter: advancedRateLimit,
  advancedRateLimit,
  createLimiter: advancedRateLimit,
  addToWhitelist,
  removeFromWhitelist,
  getStats,
  unblockIp,
  isBlacklisted,
  getClientIp,
};
