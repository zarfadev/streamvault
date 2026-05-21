/**
 * Cookie Consent Banner
 * Inserta un banner de consentimiento de cookies en la parte inferior de la página.
 * Guarda la preferencia en localStorage para no volver a mostrar.
 * Uso: <script src="/js/cookie-banner.js"></script>
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'sv_cookie_consent';

  // Si ya aceptó o rechazó, no mostrar de nuevo
  if (localStorage.getItem(STORAGE_KEY)) return;

  // Esperar a que el DOM esté listo
  function init() {
    injectStyles();
    const banner = createBanner();
    document.body.appendChild(banner);
    // Animación de entrada
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        banner.classList.add('sv-cb--visible');
      });
    });
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .sv-cb {
        position: fixed;
        bottom: 24px; right: 24px;
        width: 380px;
        max-width: calc(100vw - 48px);
        z-index: 99999;
        background: rgba(17, 17, 24, 0.85);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        font-family: var(--sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        font-size: 14px;
        color: #94a3b8;
        transform: translateY(40px) scale(0.95);
        opacity: 0;
        transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.05);
        pointer-events: none;
      }
      .sv-cb--visible {
        transform: translateY(0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }
      .sv-cb__header {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .sv-cb__icon {
        width: 44px;
        height: 44px;
        background: linear-gradient(135deg, rgba(124, 108, 250, 0.2), rgba(167, 139, 250, 0.1));
        border-radius: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #a78bfa;
        flex-shrink: 0;
        border: 1px solid rgba(124, 108, 250, 0.2);
      }
      .sv-cb__title {
        font-size: 17px;
        font-weight: 700;
        color: #f8fafc;
        margin: 0;
        letter-spacing: -0.01em;
      }
      .sv-cb__text {
        line-height: 1.6;
        margin: 0;
      }
      .sv-cb__text a {
        color: #a78bfa;
        text-decoration: none;
        font-weight: 600;
        border-bottom: 1px solid rgba(167, 139, 250, 0.2);
        transition: all 0.2s;
      }
      .sv-cb__text a:hover {
        border-bottom-color: #a78bfa;
        color: #c4b5fd;
      }
      .sv-cb__actions {
        display: flex;
        gap: 12px;
        margin-top: 4px;
      }
      .sv-cb__btn {
        flex: 1;
        padding: 12px 16px;
        border-radius: 14px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.2s ease;
        white-space: nowrap;
        font-family: inherit;
      }
      .sv-cb__btn--accept {
        background: #7c6cfa;
        color: #fff;
        box-shadow: 0 4px 12px rgba(124, 108, 250, 0.35);
      }
      .sv-cb__btn--accept:hover {
        background: #6a5be8;
        transform: translateY(-1px);
        box-shadow: 0 8px 20px rgba(124, 108, 250, 0.45);
      }
      .sv-cb__btn--minimal {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #94a3b8;
      }
      .sv-cb__btn--minimal:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f8fafc;
        border-color: rgba(255, 255, 255, 0.2);
      }
      @media (max-width: 480px) {
        .sv-cb {
          bottom: 16px; left: 16px; right: 16px;
          width: auto;
          padding: 24px;
          border-radius: 28px;
        }
        .sv-cb__actions {
          flex-direction: column-reverse;
        }
        .sv-cb__btn {
          width: 100%;
          padding: 14px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createBanner() {
    const banner = document.createElement('div');
    banner.className = 'sv-cb';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Aviso de cookies');
    banner.setAttribute('aria-live', 'polite');

    banner.innerHTML = `
      <div class="sv-cb__header">
        <div class="sv-cb__icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"></path>
            <path d="M8.5 8.5v.01"></path>
            <path d="M16 15.5v.01"></path>
            <path d="M12 12v.01"></path>
            <path d="M11 17v.01"></path>
            <path d="M7 14v.01"></path>
          </svg>
        </div>
        <h3 class="sv-cb__title">Cookies</h3>
      </div>
      <p class="sv-cb__text">
        Utilizamos cookies esenciales para el funcionamiento del servicio y recordar tus preferencias. No usamos cookies de rastreo de terceros.
        <a href="/cookies" target="_blank" rel="noopener">Ver política</a>
      </p>
      <div class="sv-cb__actions">
        <button class="sv-cb__btn sv-cb__btn--minimal" id="sv-cb-minimal">Solo necesarias</button>
        <button class="sv-cb__btn sv-cb__btn--accept" id="sv-cb-accept">Aceptar todas</button>
      </div>
    `;

    banner.querySelector('#sv-cb-accept').addEventListener('click', function () {
      localStorage.setItem(STORAGE_KEY, 'all');
      hideBanner(banner);
    });

    banner.querySelector('#sv-cb-minimal').addEventListener('click', function () {
      localStorage.setItem(STORAGE_KEY, 'necessary');
      hideBanner(banner);
    });

    return banner;
  }

  function hideBanner(banner) {
    banner.classList.remove('sv-cb--visible');
    setTimeout(function () {
      banner.remove();
    }, 400);
  }

  // Inicializar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
