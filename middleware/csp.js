/**
 * Content Security Policy Middleware
 * Protege contra XSS, injection attacks y otros vectores de ataque
 */

const crypto = require('crypto');

module.exports = function cspMiddleware(req, res, next) {
  // Generar nonce único para scripts inline
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  // Directivas CSP
  const directives = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'unsafe-hashes'", // Permite event handlers inline (onclick, onchange, etc.)
      'https://cdn.jsdelivr.net',
      'https://www.gstatic.com',
      'https://js.stripe.com',
      // Chart.js y HLS.js desde CDN
      'https://cdn.jsdelivr.net/npm/chart.js@4',
      'https://cdn.jsdelivr.net/npm/hls.js@latest',
    ],
    'style-src': [
      "'self'",
      "'unsafe-inline'", // Google Fonts require inline styles
      'https://fonts.googleapis.com',
    ],
    'font-src': [
      "'self'",
      'https://fonts.gstatic.com',
      'data:',
    ],
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      'https:', // Para thumbnails y logos externos
    ],
    'media-src': [
      "'self'",
      'blob:',
      'https:', // Para streaming de video
    ],
    'connect-src': [
      "'self'",
      'https://api.stripe.com',
      // CDN y dominios de la plataforma (signed cookies, HLS keys, sprites)
      'https://cdn.streamvault.es',
      'https://streamvault.link',
      'https://*.streamvault.es',
      // Necesario para la detección de AdBlock via fetch().
      // El fetch a este dominio falla SOLO si hay una extensión bloqueando la red.
      // Sin esta entrada el CSP lo bloquea antes, causando falsos positivos.
      'https://pagead2.googlesyndication.com',
    ],
    'frame-src': [
      "'self'",
      'https://js.stripe.com',
    ],
    'worker-src': [
      "'self'",
      'blob:',
    ],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
    'upgrade-insecure-requests': [],
  };

  // Construir header CSP
  const cspHeader = Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');

  // Aplicar headers de seguridad
  res.setHeader('Content-Security-Policy', cspHeader);
  
  // Headers adicionales de seguridad
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
};

// Exportar también función helper para generar SRI hashes
module.exports.generateSRI = function(algorithm = 'sha384') {
  return function(content) {
    const crypto = require('crypto');
    const hash = crypto.createHash(algorithm).update(content).digest('base64');
    return `${algorithm}-${hash}`;
  };
};
