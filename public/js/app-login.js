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

async function getCaptchaToken(action = 'submit') {
  if (!_rcKey || !_rcReady) return '';
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
    localStorage.removeItem('sv_refresh_token');
    localStorage.removeItem('sv_user');
    localStorage.removeItem('sv_workspace');
  }
  store.setItem('sv_access_token', data.accessToken);
  store.setItem('sv_refresh_token', data.refreshToken);
  store.setItem('sv_user', JSON.stringify(data.user));
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

    const redirectTo = urlParams.get('redirect');
    const role = data.user?.platform_role;
    if (role === 'super_admin') {
      window.location.href = '/admin';
    } else if (redirectTo && redirectTo.startsWith('/')) {
      window.location.href = redirectTo;
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

  const refCode = urlParams.get('ref') || null;

  setLoading('btn-register','spin-register','btn-register-text', true, 'Crear cuenta gratis');
  try {
    const captchaToken = await getCaptchaToken('register');
    
    // Check if we have a guest session ID in query params or local storage
    const guestSessionId = urlParams.get('guest_id') || localStorage.getItem('guest_session_id') || undefined;

    const body = { name, email, password: pass, captchaToken, guestSessionId };
    if (refCode) body.ref = refCode;
    const r = await fetch('/auth/register', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return showAlert(data.error || 'Error al registrarse.');

    storeTokens(data, true); // new registrations always persist session

    // Show "check your email" panel
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
    showAlert('Si existe una cuenta con ese correo, recibirás un enlace en breve.', 'success');
  } catch (e) {
    showAlert('Error de conexión.');
  } finally {
    setLoading('btn-forgot','spin-forgot','btn-forgot-text', false, 'Enviar enlace');
  }
}

// Super admin re-login: clear session
const sp = new URLSearchParams(window.location.search);
if (sp.get('need_super_admin') === '1') {
  ['sv_token', 'sv_access_token', 'sv_refresh', 'sv_refresh_token', 'sv_user', 'sv_workspace'].forEach(k => localStorage.removeItem(k));
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

// If already logged in, redirect
const existingToken = localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token') || localStorage.getItem('sv_token');
if (existingToken) {
  const redirectTo = new URLSearchParams(window.location.search).get('redirect');
  window.location.href = (redirectTo && redirectTo.startsWith('/')) ? redirectTo : '/dashboard';
}
