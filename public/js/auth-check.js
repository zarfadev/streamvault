/**
 * Auth Check - Dashboard entry guard
 * Verifica que el usuario tenga un token válido y no expirado antes de cargar el dashboard.
 *
 * Bug corregido:
 * - Antes usaba dos claves distintas (sv_access_token / sv_token) causando desincronización.
 * - Ahora usa solo 'sv_access_token' (clave canónica) y verifica expiración del JWT.
 * - Redirige a /login?redirect=<current_url> para volver después del login.
 */
(function () {
  const TOKEN_KEY = 'sv_access_token';

  /**
   * Decodifica el payload de un JWT sin verificar la firma
   * (la verificación real ocurre en el servidor; aquí solo evitamos
   *  una redirección innecesaria para tokens claramente expirados).
   */
  function parseJwtPayload(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      // Añadir padding base64 si falta
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  function redirectToLogin() {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace('/login?redirect=' + redirect);
  }

  // Migración: si existe el token en la clave antigua, moverlo a la clave canónica
  const legacyToken = localStorage.getItem('sv_token');
  if (legacyToken && !localStorage.getItem(TOKEN_KEY)) {
    localStorage.setItem(TOKEN_KEY, legacyToken);
  }
  if (legacyToken) {
    localStorage.removeItem('sv_token');
  }

  // Support sessionStorage (when "remember me" was NOT checked at login)
  const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

  if (!token) {
    redirectToLogin();
    return;
  }

  // Verificar expiración del JWT en el cliente (sin verificar firma)
  const payload = parseJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    // Token mal formado — eliminarlo y redirigir
    localStorage.removeItem(TOKEN_KEY);
    redirectToLogin();
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Add 30-second buffer to refresh before exact expiry
  if (payload.exp <= nowSec + 30) {
    // Token expirado (o a punto de expirar) — intentar renovar con el refresh token antes de redirigir
    const refreshToken = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token');
    // Determine which storage the session lives in
    const inSession = !localStorage.getItem(TOKEN_KEY) && !!sessionStorage.getItem(TOKEN_KEY);
    const store = inSession ? sessionStorage : localStorage;
    if (refreshToken) {
      document.documentElement.style.visibility = 'hidden';
      fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
        .then(r => {
          if (!r.ok) return Promise.reject(new Error('refresh_failed'));
          return r.json();
        })
        .then(data => {
          if (data.accessToken) {
            store.setItem(TOKEN_KEY, data.accessToken);
            if (data.refreshToken) store.setItem('sv_refresh_token', data.refreshToken);
            document.documentElement.style.visibility = '';
          } else {
            return Promise.reject(new Error('no_token'));
          }
        })
        .catch(() => {
          localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('sv_refresh_token');
          sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem('sv_refresh_token');
          redirectToLogin();
        });
    } else {
      localStorage.removeItem(TOKEN_KEY);
      redirectToLogin();
    }
  }
  // Token válido — continuar cargando el dashboard
})();
