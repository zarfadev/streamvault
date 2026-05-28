// ─── reCAPTCHA v3 (loaded dynamically if key is configured) ───────────────────
let _rcKey = '';
let _rcReady = false;
(async () => {
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    _rcKey = s.recaptchaSiteKey || '';
    if (_rcKey) {
      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?render=${_rcKey}`;
      script.onload = () => { _rcReady = true; };
      document.head.appendChild(script);
    }
    if (s.siteName) {
      document.title = s.siteName + ' — Iniciar sesión';
      document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = s.siteName; });
    }
  } catch {}
})();

// ─── StreamVault Drag CAPTCHA ─────────────────────────────────────────────────
const _svc = {
  token:      null,   // token firmado del servidor
  targetPct:  0.5,    // posición objetivo (0–1), rango [0.20, 0.75]
  startedAt:  null,   // cuando se mostró el captcha
  solved:     false,  // ¿resuelto?
  solvedPct:  null,   // posición donde soltó el usuario
};

// Deben coincidir con los valores en el CSS (#sv-piece, #sv-slot width)
const PIECE_W   = 48;   // px — ancho de pieza y slot (idénticos)
const PIECE_M   = 4;    // px — margen izquierdo inicial y derecho mínimo
const TOLERANCE = 0.08; // ±8% de rango útil
let _svcLastTargetPct = null; // posición anterior para garantizar cambio significativo

// AbortController activo para limpiar listeners al re-inicializar
let _svcAC = null;

async function initSvCaptcha() {
  // Cancelar listeners de la instancia anterior
  if (_svcAC) { _svcAC.abort(); }
  _svcAC = new AbortController();
  const signal = _svcAC.signal;

  _svc.solved    = false;
  _svc.token     = null;
  _svc.solvedPct = null;

  const piece  = document.getElementById('sv-piece');
  const slot   = document.getElementById('sv-slot');
  const track  = document.getElementById('sv-track');
  const status = document.getElementById('sv-status');
  const btnReg = document.getElementById('btn-register');
  if (!piece || !track) return;

  // ── Reset visual ──────────────────────────────────────────────────────────
  piece.style.transition = 'none';
  piece.style.left       = PIECE_M + 'px';
  piece.style.background = 'linear-gradient(135deg,#7c6cfa,#5b4fd4)';
  piece.style.boxShadow  = '0 2px 12px rgba(124,108,250,.45)';
  piece.style.cursor     = 'grab';
  slot.style.borderColor = '';
  status.textContent     = '';
  status.style.color     = 'var(--muted)';
  if (btnReg) { btnReg.disabled = true; btnReg.style.opacity = '.5'; btnReg.style.cursor = 'not-allowed'; }

  // ── Fetch challenge ───────────────────────────────────────────────────────
  // Intenta obtener una posición ≥20% diferente a la anterior (anti-brute-force).
  // Si tras 3 intentos no hay una posición suficientemente diferente, usa la última de todas formas
  // para garantizar que SIEMPRE se asigna una nueva posición y el slot se mueve visiblemente.
  try {
    let bestChallenge = null;
    for (let attempts = 0; attempts < 3; attempts++) {
      const r = await fetch('/api/captcha/challenge');
      if (!r.ok) throw new Error('captcha fetch failed');
      const d = await r.json();
      bestChallenge = d;
      if (_svcLastTargetPct === null || Math.abs(d.targetPct - _svcLastTargetPct) >= 0.20) {
        break; // posición suficientemente diferente
      }
    }
    // Siempre asignar el mejor challenge encontrado
    _svc.token        = bestChallenge.token;
    _svc.targetPct    = bestChallenge.targetPct;
    _svc.startedAt    = Date.now();
    _svcLastTargetPct = bestChallenge.targetPct;
  } catch {
    status.textContent = '⚠ Error al cargar el captcha';
    return;
  }

  // ── Esperar DOS frames para que el layout esté comprometido ──────────────
  // (el form puede haber estado en display:none hasta hace un momento)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ── Posicionar el slot ────────────────────────────────────────────────────
  // Rango útil: de PIECE_M hasta trackW - PIECE_W - PIECE_M
  const trackW  = track.offsetWidth;
  const usable  = trackW - PIECE_W - PIECE_M * 2;   // espacio navegable
  const slotLeft = PIECE_M + Math.round(_svc.targetPct * usable);
  slot.style.left = slotLeft + 'px';

  // ── Drag logic ────────────────────────────────────────────────────────────
  let dragging       = false;
  let startX         = 0;
  let startPieceLeft = PIECE_M;

  function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }

  function onDragStart(clientX) {
    if (_svc.solved) return;
    dragging       = true;
    startX         = clientX;
    startPieceLeft = parseInt(piece.style.left) || PIECE_M;
    piece.style.cursor     = 'grabbing';
    piece.style.transition = 'none';
  }

  function onDragMove(clientX) {
    if (!dragging) return;
    const tb   = track.getBoundingClientRect();
    const maxX = tb.width - PIECE_W - PIECE_M;
    const newX = clamp(startPieceLeft + (clientX - startX), PIECE_M, maxX);
    piece.style.left = newX + 'px';
  }

  function onDragEnd(clientX) {
    if (!dragging) return;
    dragging = false;
    piece.style.cursor = 'grab';

    const tb      = track.getBoundingClientRect();
    const usable2 = tb.width - PIECE_W - PIECE_M * 2;
    const curLeft = parseInt(piece.style.left) || PIECE_M;
    const pct     = (curLeft - PIECE_M) / usable2;
    _svc.solvedPct = pct;

    if (Math.abs(pct - _svc.targetPct) <= TOLERANCE) {
      // ✅ Correcto
      _svc.solved = true;
      piece.style.transition = 'left .2s ease';
      piece.style.left       = slotLeft + 'px';
      piece.style.background = 'linear-gradient(135deg,#22c55e,#16a34a)';
      piece.style.boxShadow  = '0 4px 16px rgba(34,197,94,.5)';
      piece.style.cursor     = 'default';
      slot.style.borderColor = 'rgba(34,197,94,.6)';
      status.textContent     = '✓ Verificado';
      status.style.color     = '#22c55e';
      if (btnReg) { btnReg.disabled = false; btnReg.style.opacity = '1'; btnReg.style.cursor = ''; }
    } else {
      // ❌ Incorrecto — mostrar error y pedir nuevo challenge (posición diferente)
      piece.style.transition = 'left .15s ease';
      piece.style.background = 'linear-gradient(135deg,#ef4444,#dc2626)';
      piece.style.boxShadow  = '0 4px 14px rgba(239,68,68,.5)';
      status.textContent     = '✗ No coincide — inténtalo de nuevo';
      status.style.color     = '#ef4444';
      // Reiniciar con nueva posición tras un breve delay para que el bot
      // no pueda predecir dónde estará el target en el siguiente intento
      setTimeout(() => initSvCaptcha(), 900);
    }
  }

  // Eventos — con signal para limpiar automáticamente al re-inicializar
  piece.addEventListener('mousedown',  e => { e.preventDefault(); onDragStart(e.clientX); }, { signal });
  window.addEventListener('mousemove', e => onDragMove(e.clientX), { signal });
  window.addEventListener('mouseup',   e => onDragEnd(e.clientX),  { signal });
  piece.addEventListener('touchstart',  e => { e.preventDefault(); onDragStart(e.touches[0].clientX); }, { passive: false, signal });
  window.addEventListener('touchmove',  e => { if (dragging) { e.preventDefault(); onDragMove(e.touches[0].clientX); } }, { passive: false, signal });
  window.addEventListener('touchend',   e => onDragEnd(e.changedTouches[0]?.clientX || 0), { signal });
}

async function getCaptchaToken(action = 'submit') {
  if (!_rcKey) return '';
  if (!_rcReady) {
    // Wait up to 4s for reCAPTCHA script to finish loading
    await new Promise(resolve => {
      let waited = 0;
      const iv = setInterval(() => {
        waited += 100;
        if (_rcReady || waited >= 4000) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }
  if (!_rcReady) return '';
  try { return await grecaptcha.execute(_rcKey, { action }); } catch { return ''; }
}

// ─── Handle URL params ────────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('tab') === 'register') switchTab('register');
if (urlParams.get('verified') === '1') {
  showAlert('¡Correo verificado! Ya puedes iniciar sesión.', 'success');
}
if (urlParams.get('verified') === 'invalid') {
  showAlert('Enlace de verificación inválido o expirado. Inicia sesión y solicita uno nuevo.', 'error');
}

function switchTab(tab) {
  ['login','register','forgot','check-email'].forEach(t => {
    document.getElementById(`form-${t}`).style.display = 'none';
    const tabEl = document.getElementById(`tab-${t}`);
    if (tabEl) tabEl.classList.remove('active');
  });
  document.getElementById(`form-${tab}`).style.display = 'block';
  const tabEl = document.getElementById(`tab-${tab}`);
  if (tabEl) tabEl.classList.add('active');
  const tabsSwitcher = document.getElementById('tabs-switcher');
  if (tabsSwitcher) tabsSwitcher.style.display = (tab === 'forgot' || tab === 'check-email') ? 'none' : 'flex';
  clearAlert();
  // Inicializar CAPTCHA al entrar al tab de registro
  if (tab === 'register') {
    setTimeout(() => initSvCaptcha(), 80); // pequeño delay para que el layout esté visible
  }
}

function showAlert(msg, type = 'error') {
  const el = document.getElementById('alert-msg');
  el.textContent = msg;
  el.className = `alert ${type}`;
}

let _pendingVerifyEmail = '';
function showVerifyAlert(email) {
  _pendingVerifyEmail = email;
  const el = document.getElementById('alert-msg');
  el.className = 'alert error';
  el.innerHTML = 'Por favor verifica tu correo antes de iniciar sesión. <button onclick="resendVerification()" style="background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;padding:0;font-family:inherit;">Reenviar email</button>';
}

async function resendVerification() {
  if (!_pendingVerifyEmail) return;
  const btn = document.querySelector('#alert-msg button');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
  try {
    const r = await fetch('/auth/request-verification', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingVerifyEmail }),
    });
    showAlert(r.ok ? 'Email de verificación enviado. Revisa tu bandeja de entrada.' : 'No se pudo enviar. Inténtalo más tarde.', r.ok ? 'success' : 'error');
  } catch {
    showAlert('Error de conexión. Inténtalo más tarde.');
  }
}
function clearAlert() {
  document.getElementById('alert-msg').className = 'alert hidden';
}

function setLoading(btnId, spinId, textId, loading, text) {
  document.getElementById(btnId).disabled = loading;
  document.getElementById(spinId).classList.toggle('show', loading);
  document.getElementById(textId).textContent = loading ? 'Cargando...' : text;
}

// Stores tokens in localStorage (remember=true) or sessionStorage (remember=false).
// All token readers check both storages, so the rest of the app works transparently.
function storeTokens(data, remember) {
  const store = remember ? localStorage : sessionStorage;
  // Clear the opposite storage to avoid stale tokens
  if (remember) {
    sessionStorage.removeItem('sv_access_token');
    sessionStorage.removeItem('sv_refresh_token');
    sessionStorage.removeItem('sv_user');
    sessionStorage.removeItem('sv_workspace');
  } else {
    localStorage.removeItem('sv_access_token');
    // Do NOT remove sv_refresh_token from localStorage here:
    // it will be stored there anyway (see below) for cross-tab auth detection.
    localStorage.removeItem('sv_user');
    localStorage.removeItem('sv_workspace');
  }
  store.setItem('sv_access_token', data.accessToken);
  store.setItem('sv_refresh_token', data.refreshToken);
  store.setItem('sv_user', JSON.stringify(data.user));
  // Always persist the refresh token in localStorage regardless of remember-me.
  // This lets other tabs/pages (download, watch) detect the active session even
  // when the access token lives only in sessionStorage (remember-me OFF).
  // Logout always clears both storages, so no security regression.
  if (!remember) localStorage.setItem('sv_refresh_token', data.refreshToken);
  if (data.workspaces?.length) store.setItem('sv_workspace', JSON.stringify(data.workspaces[0]));
  if (data.workspace)          store.setItem('sv_workspace', JSON.stringify(data.workspace));
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const remember = document.getElementById('remember-me')?.checked ?? false;
  clearAlert();
  if (!email || !pass) return showAlert('Por favor completa todos los campos.');

  setLoading('btn-login','spin-login','btn-login-text', true, 'Iniciar sesión');
  try {
    const captchaToken = await getCaptchaToken('login');
    const r = await fetch('/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, password: pass, captchaToken })
    });
    const data = await r.json();
    if (!r.ok) {
      if (data.code === 'EMAIL_NOT_VERIFIED') return showVerifyAlert(email);
      return showAlert(data.error || 'Error al iniciar sesión.');
    }

    // Si requiere 2FA, guardar flag de remember-me y redirigir
    if (data.requiresTwoFactor) {
      setLoading('btn-login','spin-login','btn-login-text', false, 'Iniciar sesión');
      sessionStorage.setItem('sv_temp_2fa_token', data.tempToken);
      sessionStorage.setItem('sv_remember_me', remember ? '1' : '0');
      const redirectParam = urlParams.get('redirect');
      const redirectUrl = redirectParam ? `?redirect=${encodeURIComponent(redirectParam)}` : '';
      window.location.href = `/verify-2fa${redirectUrl}`;
      return;
    }

    storeTokens(data, remember);

    // Support both ?redirect= (from admin panel) and ?next= (from dashboard idle-logout)
    const redirectTo = urlParams.get('redirect') || urlParams.get('next');
    const role = data.user?.platform_role;
    if (redirectTo && redirectTo.startsWith('/')) {
      window.location.href = redirectTo;
    } else if (role === 'super_admin') {
      window.location.href = '/admin';
    } else {
      window.location.href = '/dashboard';
    }
  } catch (e) {
    showAlert('Error de conexión. Intenta nuevamente.');
  } finally {
    setLoading('btn-login','spin-login','btn-login-text', false, 'Iniciar sesión');
  }
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass = document.getElementById('reg-pass').value;
  clearAlert();
  if (!name || !email || !pass) return showAlert('Por favor completa todos los campos.');
  if (pass.length < 8) return showAlert('La contraseña debe tener al menos 8 caracteres.');

  // Verificar que el SV CAPTCHA fue resuelto
  if (!_svc.solved || !_svc.token) {
    showAlert('Por favor completa el CAPTCHA de seguridad.');
    // Sacudir el captcha visualmente para indicar que falta
    const box = document.getElementById('sv-captcha-box');
    if (box) {
      box.style.outline = '2px solid #ef4444';
      setTimeout(() => { box.style.outline = ''; }, 2000);
    }
    return;
  }

  const refCode = urlParams.get('ref') || null;

  setLoading('btn-register','spin-register','btn-register-text', true, 'Crear cuenta gratis');
  try {
    const captchaToken = await getCaptchaToken('register');
    const guestSessionId = urlParams.get('guest_id') || localStorage.getItem('guest_session_id') || undefined;

    const body = {
      name, email, password: pass, captchaToken, guestSessionId,
      // SV CAPTCHA fields
      svToken:      _svc.token,
      svSolvedPct:  _svc.solvedPct,
      svStartedAt:  _svc.startedAt,
    };
    if (refCode) body.ref = refCode;
    const r = await fetch('/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      // Si falla el captcha en el servidor, reinicializar el widget
      if (data.error?.toLowerCase().includes('captcha')) {
        _svc.solved = false;
        await initSvCaptcha();
      }
      return showAlert(data.error || 'Error al registrarse.');
    }

    storeTokens(data, true);
    document.getElementById('reg-email-display').textContent = email;
    switchTab('check-email');
  } catch (e) {
    showAlert('Error de conexión. Intenta nuevamente.');
  } finally {
    setLoading('btn-register','spin-register','btn-register-text', false, 'Crear cuenta gratis');
  }
}

async function doForgot() {
  const email = document.getElementById('forgot-email').value.trim();
  clearAlert();
  if (!email) return showAlert('Por favor ingresa tu correo.');

  setLoading('btn-forgot','spin-forgot','btn-forgot-text', true, 'Enviar enlace');
  try {
    const captchaToken = await getCaptchaToken('forgot_password');
    const r = await fetch('/auth/forgot-password', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, captchaToken })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      showAlert(e.error || 'No se pudo enviar el enlace. Intenta de nuevo.');
    } else {
      showAlert('Si existe una cuenta con ese correo, recibirás un enlace en breve.', 'success');
    }
  } catch (e) {
    showAlert('Error de conexión.');
  } finally {
    setLoading('btn-forgot','spin-forgot','btn-forgot-text', false, 'Enviar enlace');
  }
}

// Super admin re-login: clear session
const sp = new URLSearchParams(window.location.search);
if (sp.get('need_super_admin') === '1') {
  ['sv_token', 'sv_access_token', 'sv_refresh', 'sv_refresh_token', 'sv_user', 'sv_workspace'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('login-alerts') || document.querySelector('.card');
    if (b) {
      const d = document.createElement('p');
      d.style.cssText = 'color:var(--warn,#e8a);font-size:13px;margin-bottom:16px;';
      d.textContent = 'Se requiere cuenta de super administrador. Inicia con un usuario con ese rol o configura SUPER_ADMIN_EMAIL en el servidor.';
      b.insertBefore(d, b.firstChild.nextSibling);
    }
  });
}
// ─── Show/hide password ──────────────────────────────────────
const EYE_OPEN  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_SLASH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22"/></svg>`;
function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = show ? EYE_SLASH : EYE_OPEN;
  btn.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
}

// ─── Real-time validation ─────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateRegEmail(input) {
  const val  = input.value.trim();
  const hint = document.getElementById('reg-email-hint');
  if (!val) {
    input.style.borderColor = '';
    hint.textContent = '';
    return;
  }
  if (EMAIL_RE.test(val)) {
    input.style.borderColor = 'var(--green)';
    hint.style.color = 'var(--green)';
    hint.textContent = 'OK - Correo válido';
  } else {
    input.style.borderColor = 'var(--red)';
    hint.style.color = 'var(--red)';
    hint.textContent = 'Ingresa un correo válido (ej: nombre@dominio.com)';
  }
}

function validateRegPass(input) {
  const val  = input.value;
  const hint = document.getElementById('reg-pass-hint');
  const b1   = document.getElementById('str-bar-1');
  const b2   = document.getElementById('str-bar-2');
  const b3   = document.getElementById('str-bar-3');

  if (!val) {
    input.style.borderColor = '';
    [b1, b2, b3].forEach(b => b.style.background = 'var(--border2)');
    hint.textContent = '';
    return;
  }

  // Strength scoring
  let score = 0;
  if (val.length >= 8)  score++;
  if (val.length >= 12) score++;
  if (/[A-Z]/.test(val) && /[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score = Math.min(3, score + 1);

  const colors = ['var(--red)', 'var(--amber)', 'var(--green)'];
  const labels = ['Débil — agrega números o mayúsculas', 'Aceptable', 'Fuerte - OK'];
  const color  = colors[Math.min(score - 1, 2)] || 'var(--border2)';

  b1.style.background = score >= 1 ? color : 'var(--border2)';
  b2.style.background = score >= 2 ? color : 'var(--border2)';
  b3.style.background = score >= 3 ? color : 'var(--border2)';

  if (val.length < 8) {
    input.style.borderColor = 'var(--red)';
    hint.style.color = 'var(--red)';
    hint.textContent = `Mínimo 8 caracteres (${val.length}/8)`;
  } else {
    input.style.borderColor = color;
    hint.style.color = color;
    hint.textContent = labels[Math.min(score - 1, 2)];
  }
}

// If already logged in, redirect respecting role
const existingToken = localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token') || localStorage.getItem('sv_token');
if (existingToken) {
  const redirectTo = new URLSearchParams(window.location.search).get('redirect');
  if (redirectTo && redirectTo.startsWith('/')) {
    window.location.href = redirectTo;
  } else {
    // Determine target by role — super_admin goes to /admin
    let role = '';
    try {
      const stored = localStorage.getItem('sv_user') || sessionStorage.getItem('sv_user');
      role = JSON.parse(stored)?.platform_role || '';
    } catch {}
    window.location.href = role === 'super_admin' ? '/admin' : '/dashboard';
  }
}
