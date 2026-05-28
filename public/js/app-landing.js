/**
 * app-landing.js
 * Maneja:
 *  1. Configuración guest (límites, expiración) desde /api/plans
 *  2. Upload anónimo con drag-and-drop, progreso y estados visuales
 *  3. Countdown en tiempo real hasta que expira el video guest
 *  4. Planes de precios dinámicos desde /api/plans
 *  5. CTAs con guest_session_id embebido
 */

// ─── Estado global ─────────────────────────────────────────────────────────
let guestConfig = {
  enabled: true,
  maxFileSizeMB: 2048,    // 2 GB default
  expiryHours: 24,
  maxVideos: 3,
};

let countdownInterval = null;
let uploadExpiryTs = null; // timestamp Unix (ms) de cuándo expira el video

// Guest session ID — persiste entre visitas
let guestSessionId = localStorage.getItem('sv_guest_id');
if (!guestSessionId) {
  guestSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  localStorage.setItem('sv_guest_id', guestSessionId);
}

// ─── 1. Cargar configuración y planes desde /api/plans ─────────────────────
(async function init() {
  let plans = null;
  try {
    const r = await fetch('/api/plans');
    if (r.ok) plans = await r.json();
  } catch { /* silencioso */ }

  if (plans) {
    // Guest config viene del endpoint
    if (plans.guest) {
      guestConfig = {
        enabled:       plans.guest.enabled       ?? true,
        maxFileSizeMB: plans.guest.maxFileSizeMB ?? 2048,
        expiryHours:   plans.guest.expiryHours   ?? 24,
        maxVideos:     plans.guest.maxVideos      ?? 3,
      };
    }

    // Actualizar UI con la config guest
    updateGuestUI();

    // Renderizar planes de precios
    renderPlans(plans);
  } else {
    renderPlansError();
  }

  // Actualizar todos los botones de registro con el guest_id
  updateRegisterLinks();
})();

function updateGuestUI() {
  const maxSizeEl = document.getElementById('sv-max-size');
  const expiryLabelEl = document.getElementById('sv-expiry-label');

  if (maxSizeEl) {
    const mb = guestConfig.maxFileSizeMB;
    maxSizeEl.textContent = mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
  }
  if (expiryLabelEl) {
    const h = guestConfig.expiryHours;
    expiryLabelEl.textContent = h >= 24
      ? `${h / 24} día${h / 24 !== 1 ? 's' : ''}`
      : `${h} hora${h !== 1 ? 's' : ''}`;
  }
}

function updateRegisterLinks() {
  const ids = ['hero-register-btn', 'drawer-register-btn', 'sv-save-btn', 'cta-register-btn'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const url = new URL(el.href, window.location.origin);
    url.searchParams.set('guest_id', guestSessionId);
    el.href = url.toString();
  });
}

// ─── 2. Upload Widget ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const fileInput     = document.getElementById('sv-file-input');
  const dropzone      = document.getElementById('sv-dropzone');
  const stateDropzone = document.getElementById('sv-state-dropzone');
  const stateProgress = document.getElementById('sv-state-progress');
  const stateSuccess  = document.getElementById('sv-state-success');
  const guestLimits   = document.getElementById('sv-guest-limits');

  if (!fileInput || !dropzone) return;

  // Referencia al archivo pendiente (para "Continuar como invitado" después del modal de usuario logueado)
  let _pendingFile = null;
  // Archivo soltado por drag&drop cuando el usuario no estaba logueado
  let _svPendingGuestDrop = null;

  // Expuesto globalmente para que el botón del modal pueda llamarlo
  window._svContinueAsGuest = () => {
    if (_pendingFile) {
      // Drag&drop: ya hay archivo seleccionado, procesar como invitado
      const f = _pendingFile;
      _pendingFile = null;
      window._svForceGuestUpload = true;
      handleFile(f);
    } else {
      // Click: aún no hay archivo, abrir el file picker como invitado
      window._svForceGuestUpload = true;
      if (fileInput) fileInput.click();
    }
  };

  // Exponer referencia al archivo de drag&drop pendiente para el botón del modal
  Object.defineProperty(window, '_svPendingGuestDrop', {
    get() { return _svPendingGuestDrop; },
    set(v) { _svPendingGuestDrop = v; },
    configurable: true,
  });
  // Callback para procesar el archivo soltado después de elegir "invitado"
  window._handleGuestDrop = (f) => { handleFile(f); };

  // Helper: determinar destino del dashboard según rol
  function _dashboardDest() {
    try {
      const u = localStorage.getItem('sv_user') || sessionStorage.getItem('sv_user');
      if (u && JSON.parse(u)?.platform_role === 'super_admin') return '/admin';
    } catch {}
    return '/dashboard/upload';
  }

  // Interceptar click del dropzone — siempre mostramos un modal antes de abrir el file picker
  window._svHandleDropzoneClick = () => {
    if (!isLoggedIn()) {
      // ── Usuario NO logueado: modal "login / registrarse / subir como invitado" ──
      _svPendingGuestDrop = null;
      const expEl = document.getElementById('sv-choice-expiry');
      if (expEl) expEl.textContent = guestConfig.expiryHours === 1 ? '1h' : `${guestConfig.expiryHours}h`;
      const guestBtn = document.getElementById('sv-choice-guest-btn');
      if (guestBtn) guestBtn.textContent = `Subir como invitado (expira en ${guestConfig.expiryHours}h)`;
      const loginBtn = document.getElementById('sv-choice-login-btn');
      const regBtn   = document.getElementById('sv-choice-register-btn');
      if (loginBtn) { const u = new URL('/login', location.origin); u.searchParams.set('guest_id', guestSessionId); loginBtn.href = u.toString(); }
      if (regBtn)   { const u = new URL('/login', location.origin); u.searchParams.set('tab','register'); u.searchParams.set('guest_id', guestSessionId); regBtn.href = u.toString(); }
      const modal = document.getElementById('sv-guest-choice-modal');
      if (modal) modal.style.display = 'flex';
    } else {
      // ── Usuario logueado: modal "ir al dashboard / subir como invitado" ──
      // Mostrar ANTES de abrir el file picker para no confundir al usuario
      _pendingFile = null; // sin archivo aún (click, no drag&drop)
      const fnEl  = document.getElementById('sv-auth-modal-filename');
      if (fnEl) fnEl.textContent = 'Selecciona dónde quieres subir tu video:';
      const goBtn = document.getElementById('sv-auth-modal-go-btn');
      if (goBtn) goBtn.href = _dashboardDest();
      const modal = document.getElementById('sv-auth-upload-modal');
      if (modal) modal.style.display = 'flex';
    }
    return true; // siempre interceptamos — nunca abrir el file picker directamente
  };

  // Drag & drop
  // NOTA: Solo aplicamos preventDefault() en la dropzone, NO en document.body.
  // El listener en body con preventDefault() bloqueaba el scroll táctil en móvil
  // porque en algunos browsers touch-drag dispara dragover y preventDefault() en body
  // cancela el comportamiento de scroll nativo.
  // Para evitar que el browser abra el archivo si se suelta fuera del dropzone,
  // capturamos drop en body pero SIN preventDefault() (solo stopPropagation).
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
  });
  // Prevenir que el browser abra el archivo si se suelta fuera del dropzone (desktop)
  // pero sin bloquear scroll en touch.
  document.body.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); });
  document.body.addEventListener('dragover', e => { e.preventDefault(); }); // solo en desktop real
  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, () => dropzone.classList.add('dragover'));
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, () => dropzone.classList.remove('dragover'));
  });
  dropzone.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    const f = e.dataTransfer.files[0];
    if (!isLoggedIn()) {
      // Show choice modal with file already selected
      _svPendingGuestDrop = f;
      const expEl = document.getElementById('sv-choice-expiry');
      if (expEl) expEl.textContent = guestConfig.expiryHours === 1 ? '1h' : `${guestConfig.expiryHours}h`;
      const guestBtn = document.getElementById('sv-choice-guest-btn');
      if (guestBtn) guestBtn.textContent = `Subir como invitado: ${f.name} (expira en ${guestConfig.expiryHours}h)`;
      const modal = document.getElementById('sv-guest-choice-modal');
      if (modal) modal.style.display = 'flex';
    } else {
      // Logueado + drag&drop: mostrar modal con info del archivo y dejar elegir
      _pendingFile = f;
      const fnEl = document.getElementById('sv-auth-modal-filename');
      if (fnEl) fnEl.textContent = `Archivo listo: ${f.name} (${f.size >= 1073741824 ? (f.size/1073741824).toFixed(1)+' GB' : (f.size/1048576).toFixed(0)+' MB'})`;
      const goBtn = document.getElementById('sv-auth-modal-go-btn');
      if (goBtn) goBtn.href = _dashboardDest();
      const modal = document.getElementById('sv-auth-upload-modal');
      if (modal) modal.style.display = 'flex';
    }
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files?.length) handleFile(e.target.files[0]);
  });

  // ── Validar y subir archivo ───────────────────────────────────────────────
  function isLoggedIn() {
    return !!(
      localStorage.getItem('sv_access_token')  ||
      sessionStorage.getItem('sv_access_token') ||
      localStorage.getItem('sv_token')          ||
      localStorage.getItem('sv_refresh_token')  ||
      sessionStorage.getItem('sv_refresh_token')
    );
  }

  function handleFile(file) {
    if (!file.type.startsWith('video/')) {
      showFileError('Por favor selecciona un archivo de video (MP4, MOV, AVI, MKV, WebM).');
      return;
    }

    // Si llegó aquí con _svForceGuestUpload (usuario logueado que eligió "subir como invitado"), reset flag
    window._svForceGuestUpload = false;

    const maxBytes = guestConfig.maxFileSizeMB * 1024 * 1024;
    if (file.size > maxBytes) {
      const maxLabel = guestConfig.maxFileSizeMB >= 1024
        ? `${(guestConfig.maxFileSizeMB / 1024).toFixed(1)} GB`
        : `${guestConfig.maxFileSizeMB} MB`;
      showFileError(`El archivo supera el límite de ${maxLabel} para subidas sin cuenta. Regístrate para subir archivos más grandes.`);
      return;
    }

    // Cambiar a estado "progreso"
    showState('progress');
    document.getElementById('sv-filename').textContent = file.name;
    setProgress(0, 'Subiendo archivo...');
    setStep('upload');

    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', file.name.replace(/\.[^.]+$/, ''));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.setRequestHeader('X-Guest-Id', guestSessionId);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setProgress(pct, pct < 100 ? 'Subiendo archivo...' : 'Procesando video...');
        if (pct === 100) setStep('process');
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let res = {};
        try { res = JSON.parse(xhr.responseText); } catch { /* empty */ }
        setProgress(100, '¡Listo!');
        setStep('ready');
        setTimeout(() => showSuccess(res), 500);
      } else {
        let msg = 'Error al subir el video. Inténtalo de nuevo.';
        try {
          const body = JSON.parse(xhr.responseText);
          if (body.error) msg = body.error;
        } catch { /* empty */ }
        showUploadError(msg);
      }
    };

    xhr.onerror = () => {
      showUploadError('Error de conexión. Verifica tu internet e inténtalo de nuevo.');
    };

    xhr.send(formData);
  }

  function showSuccess(res) {
    const watchUrl = window.location.origin + (res.watchUrl || `/watch/${res.id}`);

    const watchLinkInput = document.getElementById('sv-watch-link');
    const watchBtn       = document.getElementById('sv-watch-btn');
    const saveBtn        = document.getElementById('sv-save-btn');

    if (watchLinkInput) watchLinkInput.value = watchUrl;
    if (watchBtn)       watchBtn.href = watchUrl;
    if (saveBtn) {
      const url = new URL(saveBtn.href, window.location.origin);
      url.searchParams.set('guest_id', guestSessionId);
      saveBtn.href = url.toString();
    }

    // Calcular timestamp de expiración
    uploadExpiryTs = Date.now() + guestConfig.expiryHours * 3600 * 1000;
    // Guardar en localStorage para que el countdown persista entre recargas
    localStorage.setItem('sv_upload_expiry', String(uploadExpiryTs));

    showState('success');
    startCountdown();
  }

  // ── Helpers de UI ──────────────────────────────────────────────────────────
  function showState(state) {
    if (stateDropzone) stateDropzone.style.display = state === 'dropzone' ? 'block' : 'none';
    if (stateProgress) stateProgress.style.display = state === 'progress' ? 'block' : 'none';
    if (stateSuccess)  stateSuccess.style.display  = state === 'success'  ? 'block' : 'none';
    // guest bar vive dentro de sv-state-dropzone, no necesita toggle separado
    if (state === 'dropzone') fileInput.value = '';
  }

  function setProgress(pct, label) {
    const bar  = document.getElementById('sv-progress-bar');
    const pctEl = document.getElementById('sv-progress-pct');
    const stepEl = document.getElementById('sv-progress-step');
    if (bar)   bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (stepEl) stepEl.textContent = label;
  }

  function setStep(active) {
    ['upload', 'process', 'ready'].forEach((s, i) => {
      const el = document.getElementById(`sv-step-${s}`);
      if (!el) return;
      el.className = 'sv-step';
      const order = ['upload', 'process', 'ready'].indexOf(active);
      if (i < order)   el.classList.add('done');
      if (i === order) el.classList.add('active');
    });
  }

  function showFileError(msg) {
    // Mostrar un mini banner de error dentro del dropzone
    let errEl = document.getElementById('sv-dz-error');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.id = 'sv-dz-error';
      errEl.style.cssText = `
        margin-top: 12px; padding: 10px 14px; border-radius: 8px;
        background: rgba(248,113,113,.08); border: 1px solid rgba(248,113,113,.2);
        color: #fca5a5; font-size: 13px; line-height: 1.5; text-align: center;
      `;
      dropzone.appendChild(errEl);
    }
    errEl.textContent = msg;
    errEl.style.display = 'block';
    setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 6000);
  }

  function showUploadError(msg) {
    showState('dropzone');
    showFileError(msg);
  }

  // Exponer reset para botones externos
  window.svResetUpload = () => showState('dropzone');
});

// ─── 3. Countdown ──────────────────────────────────────────────────────────
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);

  // Recuperar expiración persistida si no tenemos una nueva
  if (!uploadExpiryTs) {
    const saved = localStorage.getItem('sv_upload_expiry');
    if (saved) uploadExpiryTs = parseInt(saved, 10);
  }
  if (!uploadExpiryTs) return;

  function tick() {
    const remaining = uploadExpiryTs - Date.now();
    const el = document.getElementById('sv-countdown');
    if (!el) { clearInterval(countdownInterval); return; }

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      el.textContent = '00:00:00';
      el.style.color = '#f87171';
      return;
    }

    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    el.textContent = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');

    // Urgencia visual cuando quedan < 1 hora
    if (remaining < 3600000) el.style.color = '#f87171';
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

// Copy link
window.svCopyLink = function() {
  const input = document.getElementById('sv-watch-link');
  const btn   = document.getElementById('sv-copy-btn');
  if (!input || !btn) return;

  // Clipboard API moderna con fallback
  const text = input.value;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '¡Copiado!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2500);
    }).catch(() => legacyCopy(input, btn));
  } else {
    legacyCopy(input, btn);
  }
};

function legacyCopy(input, btn) {
  input.select();
  try {
    document.execCommand('copy');
    btn.textContent = '¡Copiado!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2500);
  } catch { /* silent */ }
}

// ─── 4. Planes de precios dinámicos ────────────────────────────────────────
function renderPlans(plans) {
  const grid = document.getElementById('plans-grid');
  if (!grid) return;

  const s = plans.starter    || {};
  const p = plans.pro        || {};
  const e = plans.enterprise || {};

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtPrice(plan) {
    if (!plan.price || plan.price === 0) return '$0';
    return `$${plan.price}`;
  }
  function fmtPeriod(plan) {
    if (!plan.price || plan.price === 0) return 'gratis para siempre';
    return '/ mes';
  }
  function fmtVideos(n) {
    if (n === -1 || n == null) return 'Videos ilimitados';
    return `${n} videos`;
  }
  function fmtGB(gb, label = 'almacenamiento') {
    if (gb === -1 || gb == null) return `Almacenamiento ilimitado`;
    const val = gb >= 1000 ? `${(gb / 1000).toFixed(0)} TB` : `${gb} GB`;
    return `${val} ${label}`;
  }
  function fmtBW(gb) {
    if (gb === -1 || gb == null) return `Bandwidth ilimitado`;
    const val = gb >= 1000 ? `${(gb / 1000).toFixed(0)} TB` : `${gb} GB`;
    return `${val} bandwidth/mes`;
  }
  function fmtMembers(n) {
    if (!n || n === -1) return null;
    return `Hasta ${n} miembro${n !== 1 ? 's' : ''} por workspace`;
  }

  // Iconos check/dash SVG — clases sv-plan-* del nuevo diseño
  const chk = `<svg class="sv-plan-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const dsh = `<span class="sv-plan-dash" aria-hidden="true">—</span>`;

  function feat(has, label) {
    return `<li${has ? '' : ' class="dim"'}>${has ? chk : dsh}<span>${esc(label)}</span></li>`;
  }

  function buildCard(plan, highlight, ctaClass, ctaHref, ctaLabel, badge) {
    const f = plan.features || {};
    const members = plan.maxMembers;

    const allFeatures = [
      // Límites básicos
      fmtVideos(plan.maxVideos),
      fmtGB(plan.maxStorageGB),
      fmtBW(plan.maxBandwidthGB),
      
      // Analytics - mostrar el nivel correcto
      f.analytics === 'full' ? 'Analytics avanzados' : (f.analytics === 'basic' ? 'Analytics básicos' : null),
      
      // Miembros por workspace
      members && members > 0 && members !== -1 ? `Hasta ${members} miembro${members !== 1 ? 's' : ''} por workspace` : null,
      
      // Transcripciones IA
      'Transcripciones IA',
      
      // API Keys
      'API Keys',
      
      // Webhooks
      'Webhooks',
      
      // Player sin marca
      'Player sin marca',
    ];

    // Evaluar qué features TIENE el plan (true/false para cada una)
    const hasFeature = [
      true, // Videos - todos los planes tienen
      true, // Storage - todos los planes tienen
      true, // Bandwidth - todos los planes tienen
      f.analytics === 'full' || f.analytics === 'basic', // Analytics (cualquier nivel)
      members && members > 0 && members !== -1, // Miembros
      !!f.transcriptions, // Transcripciones IA
      !!f.apiKeys, // API Keys
      !!f.webhooks, // Webhooks
      f.embed === 'unbranded' || f.embed === 'custom', // Player sin marca
    ];

    // Generar HTML para cada característica
    const featureList = allFeatures.map((label, idx) => {
      if (!label) return ''; // Saltar características null (como analytics básicos cuando tiene avanzados)
      const has = hasFeature[idx];
      return feat(has, label);
    }).filter(Boolean).join('');

    return `
      <div class="sv-plan${highlight ? ' featured' : ''}">
        ${badge ? `<div class="sv-plan-badge">${esc(badge)}</div>` : ''}
        <div class="sv-plan-name">${esc(plan.name || 'Plan')}</div>
        <div class="sv-plan-price">${fmtPrice(plan)}</div>
        <div class="sv-plan-period">${fmtPeriod(plan)}</div>
        <p class="sv-plan-desc">${esc(plan.description || '')}</p>
        <ul class="sv-plan-feats">${featureList}</ul>
        <a href="${esc(ctaHref)}" class="sv-plan-cta ${ctaClass}">${esc(ctaLabel)}</a>
      </div>
    `;
  }

  const gidParam = `&guest_id=${guestSessionId}`;

  grid.innerHTML = buildCard(
    s, false, 'sv-plan-cta-ghost',
    `/login?tab=register${gidParam}`,
    `Empezar con ${s.name || 'Starter'}`,
    null
  ) + buildCard(
    p, true, 'sv-plan-cta-primary',
    `/login?tab=register${gidParam}`,
    `Comenzar con ${p.name || 'Pro'}`,
    p.badge || 'Más popular'
  ) + buildCard(
    e, false, 'sv-plan-cta-ghost',
    e.price && e.price > 0
      ? `/login?tab=register${gidParam}`
      : `mailto:${window._svSupportEmail || ''}`,
    e.price && e.price > 0 ? `Comenzar con ${e.name || 'Enterprise'}` : 'Contactar ventas',
    null
  );
}

function renderPlansError() {
  const grid = document.getElementById('plans-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="sv-plans-loading" style="grid-column:1/-1">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span style="font-size:13px;color:var(--muted);">No se pudieron cargar los planes.
        <a href="javascript:location.reload()" style="color:var(--accent2)">Reintentar</a>
      </span>
    </div>
  `;
}

// ─── Detección de sesión activa en páginas públicas ─────────────────────────
// Si el usuario ya está logueado, cambia los botones del nav de
// "Iniciar sesión / Empezar gratis" a "Ir al dashboard".
// Aplica también a todas las páginas que usen este script.
(function applySessionState() {
  // Considerar "logueado" si hay access token O refresh token vigente.
  // No validamos expiración aquí — las páginas estáticas no hacen llamadas API;
  // el dashboard refresca el token automáticamente al cargar.
  const hasAccess  = localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token') || localStorage.getItem('sv_token');
  const hasRefresh = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token') || localStorage.getItem('sv_refresh');
  if (!hasAccess && !hasRefresh) return;

  // Determine destination based on role
  let _dest = '/dashboard';
  try {
    const _su = localStorage.getItem('sv_user') || sessionStorage.getItem('sv_user');
    if (JSON.parse(_su)?.platform_role === 'super_admin') _dest = '/admin';
  } catch {}

  // Swap ALL "Iniciar sesión" / "Empezar gratis" CTAs to "Ir al dashboard"
  const dashBtn = `<a href="${_dest}" class="nav-btn-primary" style="white-space:nowrap;">Ir al dashboard →</a>`;

  // Desktop nav actions — IMPORTANT: preserve the hamburger button so mobile nav still works.
  // The hamburger is inside .nav-actions; replacing innerHTML removes it from the DOM and
  // breaks the mobile drawer. We save the element reference, replace the HTML, then re-append.
  const navActions = document.querySelector('.nav-actions');
  if (navActions) {
    const hamburger = navActions.querySelector('.nav-hamburger');
    navActions.innerHTML = dashBtn;
    if (hamburger) {
      navActions.appendChild(hamburger);
    }
  }

  // Mobile drawer actions — replace login/register links with a single dashboard link.
  // Keep all the non-action anchor links (section links like #how-it-works) intact.
  const mobileActions = document.querySelector('.nav-mobile-actions');
  if (mobileActions) {
    mobileActions.innerHTML = `<a href="${_dest}" class="nav-btn-primary" style="flex:1;text-align:center;">Ir al dashboard →</a>`;
  }

  // Any CTA buttons with register links on the page
  document.querySelectorAll(
    '#hero-register-btn, #drawer-register-btn, #sv-save-btn, #cta-register-btn'
  ).forEach(el => {
    el.href = _dest;
    el.textContent = 'Ir al dashboard →';
  });
})();
