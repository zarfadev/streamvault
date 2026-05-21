/**
 * Toast Notification System
 * Usage: svToast('Mensaje', 'success' | 'error' | 'warning' | 'info', durationMs?)
 * Replaces native alert() across all pages.
 */
(function () {
  const STYLES = `
    #sv-toast-container {
      position: fixed; top: 20px; right: 20px; z-index: 9999;
      display: flex; flex-direction: column; gap: 10px;
      pointer-events: none; font-family: var(--sans, 'DM Sans', sans-serif);
    }
    .sv-toast {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 14px 18px; border-radius: 12px; min-width: 280px; max-width: 380px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.45);
      border: 1px solid rgba(255,255,255,0.08);
      pointer-events: all; cursor: default;
      transform: translateX(120%); opacity: 0;
      transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease;
      position: relative; overflow: hidden;
    }
    .sv-toast.show { transform: translateX(0); opacity: 1; }
    .sv-toast.hide { transform: translateX(120%); opacity: 0; }
    .sv-toast-success { background: #0f2a1e; border-color: rgba(34,211,165,0.3); }
    .sv-toast-error   { background: #2a0f0f; border-color: rgba(248,113,113,0.3); }
    .sv-toast-warning { background: #2a1f0a; border-color: rgba(251,191,36,0.3); }
    .sv-toast-info    { background: #0f1a2a; border-color: rgba(124,108,250,0.3); }
    .sv-toast-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
    .sv-toast-body { flex: 1; }
    .sv-toast-msg  { font-size: 14px; font-weight: 500; line-height: 1.4; }
    .sv-toast-success .sv-toast-msg { color: #6ee7c7; }
    .sv-toast-error   .sv-toast-msg { color: #fca5a5; }
    .sv-toast-warning .sv-toast-msg { color: #fcd34d; }
    .sv-toast-info    .sv-toast-msg { color: #a5b4fc; }
    .sv-toast-close {
      background: none; border: none; font-size: 16px; cursor: pointer;
      color: rgba(255,255,255,0.4); padding: 0; line-height: 1; flex-shrink: 0;
      transition: color 0.15s;
    }
    .sv-toast-close:hover { color: rgba(255,255,255,0.8); }
    .sv-toast-progress {
      position: absolute; bottom: 0; left: 0; height: 2px;
      border-radius: 0 0 12px 12px;
      transition: width linear;
    }
    .sv-toast-success .sv-toast-progress { background: rgba(34,211,165,0.5); }
    .sv-toast-error   .sv-toast-progress { background: rgba(248,113,113,0.5); }
    .sv-toast-warning .sv-toast-progress { background: rgba(251,191,36,0.5); }
    .sv-toast-info    .sv-toast-progress { background: rgba(124,108,250,0.5); }
  `;

  const ICONS = {
    success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  function ensureContainer() {
    let c = document.getElementById('sv-toast-container');
    if (!c) {
      const style = document.createElement('style');
      style.textContent = STYLES;
      document.head.appendChild(style);
      c = document.createElement('div');
      c.id = 'sv-toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  window.svToast = function (message, type = 'info', duration = 4000) {
    const container = ensureContainer();
    // Validate type to prevent CSS class injection
    const safeType = ['success','error','warning','info'].includes(type) ? type : 'info';
    const el = document.createElement('div');
    el.className = `sv-toast sv-toast-${safeType}`;

    // SECURITY: Build element structure carefully.
    // 'message' may come from API error responses or user-derived content.
    const iconSpan = document.createElement('span');
    iconSpan.className = 'sv-toast-icon';
    iconSpan.innerHTML = ICONS[safeType] || ICONS.info; // Safe: SVG from trusted constant

    const msgDiv = document.createElement('div');
    msgDiv.className = 'sv-toast-msg';
    msgDiv.textContent = message; // Safe: never interprets HTML

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'sv-toast-body';
    bodyDiv.appendChild(msgDiv);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'sv-toast-close';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.textContent = '×';

    const progress = document.createElement('div');
    progress.className = 'sv-toast-progress';
    progress.style.width = '100%';

    el.appendChild(iconSpan);
    el.appendChild(bodyDiv);
    el.appendChild(closeBtn);
    el.appendChild(progress);
    container.appendChild(el);

    function dismiss() {
      el.classList.add('hide');
      el.classList.remove('show');
      setTimeout(() => el.remove(), 350);
    }

    closeBtn.addEventListener('click', dismiss);
    el.addEventListener('click', dismiss);

    // Show
    requestAnimationFrame(() => {
      el.classList.add('show');
      // Progress bar
      progress.style.transition = `width ${duration}ms linear`;
      requestAnimationFrame(() => { progress.style.width = '0%'; });
    });

    const timer = setTimeout(dismiss, duration);
    el.addEventListener('mouseenter', () => clearTimeout(timer));

    return { dismiss };
  };

  // Alias for dashboard compatibility (dashboard uses toast('msg', 'type'))
  if (!window.toast) {
    window.toast = window.svToast;
  }
})();
