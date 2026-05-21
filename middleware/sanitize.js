/**
 * FIX #14: Input Sanitization Middleware
 * Sanitiza todo el input del usuario para prevenir XSS y injection attacks
 */

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

/**
 * Sanitiza strings HTML para prevenir XSS
 * @param {string} dirty - Input potencialmente peligroso
 * @returns {string} - String sanitizado
 */
function sanitizeHTML(dirty) {
  if (typeof dirty !== 'string') return dirty;
  
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],
    ALLOWED_ATTR: ['href'],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Sanitiza strings simples (nombres, títulos, etc)
 * Remueve caracteres de control y limita longitud
 */
function sanitizeText(text, maxLength = 500) {
  if (typeof text !== 'string') return text;
  
  // Remover caracteres de control (excepto espacios, tabs, newlines)
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  // Trimear y limitar longitud
  clean = clean.trim().slice(0, maxLength);
  
  return clean;
}

/**
 * Sanitiza objetos recursivamente
 */
function sanitizeObject(obj, options = {}) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return sanitizeText(String(obj));
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, options));
  }
  
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip prototype pollution
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    
    if (typeof value === 'string') {
      // Campos que aceptan HTML (con sanitización estricta)
      if (options.htmlFields && options.htmlFields.includes(key)) {
        sanitized[key] = sanitizeHTML(value);
      } else {
        sanitized[key] = sanitizeText(value);
      }
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeObject(value, options);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Middleware Express para sanitizar req.body
 */
function sanitizeBody(options = {}) {
  return (req, res, next) => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body, options);
    }
    next();
  };
}

/**
 * Middleware Express para sanitizar req.query
 */
function sanitizeQuery(req, res, next) {
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query);
  }
  next();
}

/**
 * Valida y sanitiza URLs para prevenir inyección
 */
function sanitizeURL(url) {
  if (typeof url !== 'string') return '';
  
  try {
    const parsed = new URL(url);
    // Solo permitir http y https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

module.exports = {
  sanitizeHTML,
  sanitizeText,
  sanitizeObject,
  sanitizeBody,
  sanitizeQuery,
  sanitizeURL,
};
