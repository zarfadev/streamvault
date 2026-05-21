/**
 * HTML Sanitization Utilities
 * Previene XSS sanitizando contenido antes de insertar en DOM.
 *
 * SECURITY: sanitizeHTMLBasic usa allowlist estricta de tags/atributos.
 * isSafeURL solo permite https://, http:// y rutas relativas (/…).
 */

// ─── Allowlist de tags y atributos seguros ────────────────────────────────────
const ALLOWED_TAGS = new Set([
  'b', 'i', 'em', 'strong', 'a', 'span', 'div', 'p', 'br',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'code', 'pre', 'blockquote', 'hr',
]);

const ALLOWED_ATTRS = new Set(['href', 'title', 'target', 'rel', 'class', 'id']);

/**
 * Escapa texto para uso seguro como contenido HTML (textContent).
 * Usar siempre que el valor sea texto plano, no HTML.
 * @param {string} text
 * @returns {string}
 */
function escapeHTML(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * Sanitiza HTML contra XSS usando allowlist estricta de tags y atributos.
 * Elimina: <script>, <iframe>, <object>, <svg>, <style>, <base>, <form>,
 * event handlers (on*), javascript: URLs, data: URLs.
 *
 * @param {string} dirty - HTML sin sanitizar
 * @returns {string} - HTML sanitizado
 */
function sanitizeHTMLBasic(dirty) {
  if (!dirty) return '';

  const template = document.createElement('template');
  template.innerHTML = dirty;
  const root = template.content;

  // Recorrido en profundidad — recolectar nodos a eliminar
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toRemove = [];
  let node = walker.nextNode();
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      toRemove.push(node);
    } else {
      // Filtrar atributos no permitidos
      const attrs = Array.from(node.attributes);
      for (const attr of attrs) {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
          node.removeAttribute(attr.name);
          continue;
        }
        // Validar URLs en href/src
        if ((name === 'href' || name === 'src') && !isSafeURL(attr.value)) {
          node.removeAttribute(attr.name);
        }
        // Forzar rel="noopener noreferrer" en <a target="_blank">
        if (tag === 'a' && node.getAttribute('target') === '_blank') {
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
    }
    node = walker.nextNode();
  }
  // Eliminar nodos no permitidos (sin sus hijos — reemplazar con hijos)
  for (const el of toRemove) {
    const parent = el.parentNode;
    if (parent) {
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }

  const out = document.createElement('div');
  out.appendChild(root);
  return out.innerHTML;
}

/**
 * Convierte texto plano a HTML escapado (alias de escapeHTML para compatibilidad).
 */
function sanitizeHTML(dirty) {
  return escapeHTML(dirty);
}

/**
 * Sanitiza un valor para uso seguro como atributo HTML.
 * @param {string} attr
 * @returns {string}
 */
function sanitizeAttr(attr) {
  if (attr == null) return '';
  return String(attr)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Crea elemento DOM de forma segura (sin innerHTML).
 * @param {string} tag
 * @param {Object} attrs
 * @param {string|Node|Array} children
 * @returns {HTMLElement}
 */
function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);

  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'textContent') {
      el.textContent = value;
    } else if (key === 'className') {
      el.className = value;
    } else if (key === 'href' || key === 'src') {
      if (isSafeURL(value)) el.setAttribute(key, value);
    } else if (key.startsWith('data-') || ['title', 'alt', 'id', 'rel', 'target'].includes(key)) {
      el.setAttribute(key, sanitizeAttr(value));
    }
    // Silently drop event handler props (onclick, etc.)
  });

  const childArray = Array.isArray(children) ? children : [children];
  childArray.forEach(child => {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  });

  return el;
}

/**
 * Wrapper seguro para innerHTML — sanitiza antes de insertar.
 * @param {HTMLElement} element
 * @param {string} html
 */
function safeInnerHTML(element, html) {
  if (!element) return;
  element.innerHTML = sanitizeHTMLBasic(html);
}

/**
 * Valida URL — solo permite https://, http:// y rutas relativas (/…).
 * Bloquea: javascript:, data:, vbscript: y cualquier otro protocolo.
 * @param {string} url
 * @returns {boolean}
 */
function isSafeURL(url) {
  if (!url) return false;
  const s = String(url).trim();
  // Relative paths are safe
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  // Only allow explicit http/https absolute URLs
  return /^https?:\/\//i.test(s);
}

// ─── Exports ─────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanitizeHTML, sanitizeHTMLBasic, escapeHTML, sanitizeAttr, createElement, safeInnerHTML, isSafeURL };
}

if (typeof window !== 'undefined') {
  window.SVSanitize = { sanitizeHTML, sanitizeHTMLBasic, escapeHTML, sanitizeAttr, createElement, safeInnerHTML, isSafeURL };
}
