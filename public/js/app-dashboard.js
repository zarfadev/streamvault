    const BASE = window.location.origin;
    let selectedFile = null;
    let pollInterval = null;

    // ─── Impersonation banner ─────────────────────────────────────
    function initImpersonationBanner() {
      const email = localStorage.getItem('sv_imp_email');
      const name  = localStorage.getItem('sv_imp_name');
      if (!email) return;
      document.body.classList.add('impersonating');
      const banner = document.getElementById('imp-banner');
      if (!banner) return;
      banner.classList.add('visible');
      const nameEl  = document.getElementById('imp-banner-name');
      const emailEl = document.getElementById('imp-banner-email');
      if (nameEl)  nameEl.textContent  = name || email;
      if (emailEl) emailEl.textContent = email;
    }

    function exitImpersonation() {
      const adminAccess  = localStorage.getItem('sv_imp_admin_access');
      const adminRefresh = localStorage.getItem('sv_imp_admin_refresh');
      if (adminAccess)  localStorage.setItem('sv_access_token',  adminAccess);
      if (adminRefresh) localStorage.setItem('sv_refresh_token', adminRefresh);
      localStorage.removeItem('sv_imp_admin_access');
      localStorage.removeItem('sv_imp_admin_refresh');
      localStorage.removeItem('sv_imp_email');
      localStorage.removeItem('sv_imp_name');
      window.location.href = '/admin';
    }

    // ─── Auth state ───────────────────────────────────────────────
    // Support both localStorage (remember-me) and sessionStorage (session-only login)
    let authToken = localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token') || localStorage.getItem('sv_token') || '';
    let authUser = null;
    let authWorkspace = null;
    let authWorkspaces = [];
    let allVideosCache = [];
    let _libView = localStorage.getItem('sv_lib_view') || 'list';
    let _pageLimit = parseInt(localStorage.getItem('sv_lib_limit') || '20');
    let _searchTimer;
    let _editTags = [];
    let _editModalVideoId = null;

    function setLibView(mode) {
      _libView = mode;
      localStorage.setItem('sv_lib_view', mode);
      const grid = document.getElementById('video-grid');
      if (grid) grid.className = mode === 'list' ? 'video-grid list-view' : 'video-grid';
      document.getElementById('view-btn-grid')?.classList.toggle('active', mode === 'grid');
      document.getElementById('view-btn-list')?.classList.toggle('active', mode === 'list');
      document.getElementById('view-btn-grid')?.setAttribute('aria-pressed', mode === 'grid');
      document.getElementById('view-btn-list')?.setAttribute('aria-pressed', mode === 'list');
      // Re-render videos with the new view mode (only if we have data)
      if (allVideosCache.length > 0) applyLibraryFilters();
    }

    function setPageLimit(n) {
      _pageLimit = n;
      localStorage.setItem('sv_lib_limit', n);
      const sel = document.getElementById('library-limit');
      if (sel) sel.value = String(n);
      loadVideos(1);
    }

    // Build smart page number array: [1, 2, '…', 8, 9, 10, '…', 16]
    function buildPageNumbers(current, total) {
      if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
      const pages = new Set([1, total]);
      for (let i = Math.max(2, current - 2); i <= Math.min(total - 1, current + 2); i++) pages.add(i);
      const sorted = [...pages].sort((a, b) => a - b);
      const result = [];
      let prev = 0;
      for (const p of sorted) {
        if (p - prev > 1) result.push('…');
        result.push(p);
        prev = p;
      }
      return result;
    }

    function authHeaders() {
      return authToken ? { 'Authorization': `Bearer ${authToken}`, 'x-workspace-id': authWorkspace?.id || '' } : {};
    }

    let refreshInFlight = null;
    async function refreshTokens() {
      if (refreshInFlight) return refreshInFlight;
      const rt = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token') || localStorage.getItem('sv_refresh');
      if (!rt) return false;
      const _inSession = !localStorage.getItem('sv_access_token') && !!sessionStorage.getItem('sv_access_token');
      const _store = _inSession ? sessionStorage : localStorage;
      refreshInFlight = (async () => {
        try {
          const r = await fetch(`${BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rt }),
          });
          if (!r.ok) return false;
          const d = await r.json();
          authToken = d.accessToken;
          _store.setItem('sv_access_token', authToken);
          if (d.refreshToken) _store.setItem('sv_refresh_token', d.refreshToken);
          return true;
        } catch { return false; }
        finally { refreshInFlight = null; }
      })();
      return refreshInFlight;
    }

    async function apiFetch(input, init = {}) {
      const u = typeof input === 'string' ? input : input?.url || '';
      if (String(u).includes('/auth/refresh')) return fetch(input, init);
      const buildHeaders = () => {
        const h = new Headers(init.headers || {});
        if (authToken && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + authToken);
        if (authWorkspace?.id && !h.has('x-workspace-id')) h.set('x-workspace-id', authWorkspace.id);
        return h;
      };
      let r = await fetch(input, { ...init, headers: buildHeaders() });
      if (r.status !== 401) return r;
      const hasRt = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token') || localStorage.getItem('sv_refresh');
      if (!hasRt) return r;
      const ok = await refreshTokens();
      if (!ok) {
        authToken = ''; authUser = null; authWorkspace = null;
        ['sv_access_token', 'sv_token', 'sv_refresh_token', 'sv_refresh'].forEach(k => localStorage.removeItem(k));
        updateAuthBar();
        return r;
      }
      return fetch(input, { ...init, headers: buildHeaders() });
    }

    function _syncMenuToggle(isOpen) {
      const btn = document.getElementById('menu-toggle');
      if (!btn) return;
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      btn.setAttribute('aria-label', isOpen ? 'Cerrar navegación' : 'Abrir navegación');
    }
    function toggleMobileNav() {
      const isOpen = document.body.classList.toggle('nav-open');
      _syncMenuToggle(isOpen);
    }
    function openMobileNav() { document.body.classList.add('nav-open'); _syncMenuToggle(true); }
    function closeMobileNav() { document.body.classList.remove('nav-open'); _syncMenuToggle(false); }

    function routeFromPath() {
      const path = window.location.pathname.replace(/\/$/, '') || '/dashboard';
      if (path === '/dashboard') return 'videos';
      const seg = path.split('/').pop();
      return SECTIONS.includes(seg) ? seg : 'videos';
    }

    function goSection(ev, name) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      showSection(name);
      if (window.innerWidth <= 900) closeMobileNav();
      return false;
    }

function doLogout() {
      authToken = ''; authUser = null; authWorkspace = null;
      ['sv_access_token', 'sv_token', 'sv_refresh_token', 'sv_refresh'].forEach(k => localStorage.removeItem(k));
      window.location.href = '/login';
    }

    function getInitials(name, email) {
      const n = (name || '').trim();
      if (n.length >= 2) return n.slice(0, 2).toUpperCase();
      const e = (email || '').split('@')[0] || '?';
      return e.slice(0, 2).toUpperCase();
    }

    function toggleProfileMenu(ev) {
      ev.stopPropagation();
      const dd = document.getElementById('profile-dropdown');
      const open = dd.classList.toggle('open');
      document.getElementById('profile-trigger')?.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function closeProfileMenu() {
      document.getElementById('profile-dropdown')?.classList.remove('open');
      document.getElementById('profile-trigger')?.setAttribute('aria-expanded', 'false');
    }
    
    const handleDocumentClick = () => closeProfileMenu();
    const handleEscapeKey = (e) => {
      if (e.key === 'Escape') { 
        closeProfileMenu(); 
        closeMobileNav(); 
      }
    };
    const handlePopState = () => showSection(routeFromPath(), { skipUrl: true });
    
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleEscapeKey);

    function updateAuthBar() {
      const guest = document.getElementById('auth-form');
      const prof = document.getElementById('auth-profile-wrap');
      if (authUser) {
        guest.style.display = 'none'; prof.style.display = 'block';
        const display = authUser.name || authUser.email;
        document.getElementById('profile-display-name').textContent = display;
        const wsLine = document.getElementById('profile-ws-line');
        if (wsLine) {
          wsLine.textContent = authWorkspace ? authWorkspace.name : '';
          wsLine.style.display = authWorkspace ? '' : 'none';
        }
        document.getElementById('profile-avatar').textContent = getInitials(authUser.name, authUser.email);
        document.getElementById('dd-name').textContent = display;
        document.getElementById('dd-email').textContent = authUser.email || '';

        // Show admin panel link only for super_admin users
        const adminLink = document.getElementById('admin-panel-link');
        if (adminLink) {
          adminLink.style.display = (authUser.platform_role === 'super_admin') ? 'flex' : 'none';
        }

        // Hide workspace-dependent items when there is no workspace yet
        const channelItem = document.getElementById('view-channel-link');
        const settingsItem = document.getElementById('dd-settings-item');
        const hasWs = !!authWorkspace;
        if (channelItem) channelItem.style.display = hasWs ? 'flex' : 'none';
        if (settingsItem) settingsItem.style.display = hasWs ? 'flex' : 'none';

        // Workspace switcher
        const switcher = document.getElementById('dd-ws-switcher');
        const canMultiWs = !!_cachedFeatures?.multiWorkspaceEnabled;
        // Botón "Crear workspace" standalone (sin workspace aún)
        const ddCreateWs = document.getElementById('dd-create-ws-item');
        if (ddCreateWs) {
          ddCreateWs.style.display = (canMultiWs && authWorkspaces.length === 0) ? 'flex' : 'none';
        }
        // Switcher solo aparece cuando hay workspaces para listar
        if (switcher && authWorkspaces.length > 0) {
          switcher.style.display = 'block';
          const WS_LIMIT = 5;
          const visible = authWorkspaces.slice(0, WS_LIMIT);
          const hidden  = authWorkspaces.length - WS_LIMIT;
          const createBtn = canMultiWs
            ? `<button type="button" class="profile-dd-item" onclick="createWorkspace();closeProfileMenu()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Nuevo workspace
              </button>`
            : '';
          const overflowChip = hidden > 0
            ? `<div style="font-size:11px;color:var(--muted);padding:4px 10px;">+${hidden} más</div>`
            : '';
          const wsList = visible.map(ws => {
            const isActive = ws.id === authWorkspace?.id;
            return `<button type="button" class="profile-dd-item${isActive ? ' active-ws' : ''}" onclick="switchWorkspace('${ws.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              <span style="overflow:hidden;text-overflow:ellipsis;">${esc(ws.name)}</span>
              <span class="dd-ws-role">${esc(ws.role)}</span>
              ${isActive ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="flex-shrink:0;margin-left:2px;"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
            </button>`;
          }).join('');
          switcher.innerHTML =
            `<div style="padding:3px 0;"><div class="profile-dd-label">Workspace</div><div class="profile-dd-ws-list">${wsList}${overflowChip}</div>${createBtn}</div>`;
        } else if (switcher) {
          switcher.style.display = 'none';
        }
        // Update 2FA badge in sidebar
        const badge2fa = document.getElementById('nav-2fa-badge');
        if (badge2fa) {
          badge2fa.style.display = authUser.twoFactorEnabled ? 'inline' : 'none';
        }
        // Update channel link
        const channelLink = document.getElementById('view-channel-link');
        if (channelLink && authWorkspace?.slug) {
          channelLink.href = `${BASE}/c/${encodeURIComponent(authWorkspace.slug)}`;
        }
        // Update nav avatar photo
        if (typeof updateNavAvatar === 'function') updateNavAvatar();
      } else {
        guest.style.display = 'flex'; prof.style.display = 'none'; closeProfileMenu();
      }
    }

    async function switchWorkspace(wsId) {
      const ws = authWorkspaces.find(w => w.id === wsId);
      if (!ws || ws.id === authWorkspace?.id) return;
      authWorkspace = ws;
      localStorage.setItem('sv_workspace_id', ws.id);
      localStorage.setItem('sv_workspace', JSON.stringify(ws));
      closeProfileMenu();

      // Reset all workspace-scoped state
      allVideosCache = [];
      _currentFolderId = null;
      _allFolders = [];

      // Reset library filters UI
      const libSearch = document.getElementById('library-search');
      if (libSearch) libSearch.value = '';
      const filterStatus = document.getElementById('library-filter-status');
      if (filterStatus) filterStatus.value = 'all';
      const filterVis = document.getElementById('library-filter-visibility');
      if (filterVis) filterVis.value = 'all';
      const filterTag = document.getElementById('library-filter-tag');
      if (filterTag) filterTag.value = '';

      updateAuthBar();
      await applyFeatureFlags();
      updateNavigationVisibility();

      // Navigate to videos section — showSection('videos') calls loadFolders + loadVideos internally
      showSection('videos');
      loadPlanUsage();
      toast(`Workspace: ${ws.name}`);
    }

    async function createWorkspace() {
      closeProfileMenu();
      const name = await promptModal('Nuevo workspace', '', 'Nombre del workspace');
      if (name === null) return;
      if (!name.trim()) return toast('El nombre no puede estar vacío', 'error');
      const r = await apiFetch(`${BASE}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return toast(d.error || 'Error al crear workspace', 'error');
      toast(`Workspace "${name.trim()}" creado`);
      // Refresh workspace list and switch to the new one
      const listR = await apiFetch(`${BASE}/api/workspaces`);
      if (listR.ok) {
        authWorkspaces = await listR.json();
        const created = authWorkspaces.find(w => w.id === d.id);
        if (created) await switchWorkspace(created.id);
        else updateAuthBar();
      }
    }

    // ─── Helper para verificar si una feature está disponible ──────────────────
    function hasFeature(featureName) {
      if (!authWorkspace || !authWorkspace.features) return false;
      const features = authWorkspace.features;
      // Verificar tanto por clave canónica como por clave corta
      const value = features[featureName] || features[featureName + 'Enabled'];
      return value === true || value === 'full' || value === 'basic' || 
             value === 'unbranded' || value === 'branded' || value === 'custom';
    }

    // ─── Actualizar visibilidad del menú de navegación según plan ──────────────
    function updateNavigationVisibility() {
      // Analytics: requiere analyticsEnabled
      const navAnalytics = document.getElementById('nav-analytics');
      if (navAnalytics) {
        const hasAnalytics = hasFeature('analytics') || hasFeature('analyticsEnabled');
        navAnalytics.style.display = hasAnalytics ? 'flex' : 'none';
      }

      // Playlists: requiere playlistsEnabled
      const navPlaylists = document.getElementById('nav-playlists');
      if (navPlaylists) {
        const hasPlaylists = hasFeature('playlists') || hasFeature('playlistsEnabled');
        navPlaylists.style.display = hasPlaylists ? 'flex' : 'none';
      }

      // Puedes agregar más restricciones según sea necesario
      // Ejemplo: API Keys, Webhooks, etc.
    }

    async function restoreSession() {
      if (!authToken) {
        window.location.href = '/login';
        return;
      }
      try {
        const r = await apiFetch(`${BASE}/auth/me`);
        if (!r.ok) {
          authToken = ''; authUser = null; authWorkspace = null;
          ['sv_access_token', 'sv_token'].forEach(k => localStorage.removeItem(k));
          window.location.href = '/login';
          return;
        }
        const d = await r.json();
        authUser = d.user;
        authWorkspaces = d.workspaces || [];
        // Restore previously selected workspace if still available
        const savedId = localStorage.getItem('sv_workspace_id');
        authWorkspace = (savedId && authWorkspaces.find(w => w.id === savedId)) || authWorkspaces[0] || null;
      } catch {
        window.location.href = '/login';
        return;
      }
      updateAuthBar();
    }

    // ─── Settings ─────────────────────────────────────────────────
    function syncColorInput(val) { document.getElementById('cfg-color-hex').value = val; }
    function syncColorPicker(val) { if (/^#[0-9a-fA-F]{6}$/.test(val)) document.getElementById('cfg-color-picker').value = val; }

    const STAB_MAP = {
      perfil:   ['profile-grid'],
      general:  ['settings-grid-top', 'embed-code-card', 'ads-card', 'custom-domain-section', 'tmdb-settings-card', 'openai-settings-card', 'watermark-card', 'player-security-card', 'settings-save-row'],
      acceso:   ['access-security-card', 'settings-save-row'],
      api:      ['apikeys-card', 'webhooks-card'],
      billing:  ['plan-usage-card', 'membership-section-card', 'invoices-section-card', 'referidos-card', 'upgrade-plan-card'],
      equipo:   ['team-card'],
      cuenta:   ['gdpr-privacy-card', 'danger-zone-card'],
    };

    let _activeStab = 'general';
    function switchSettingsTab(tab, immediate = false) {
      _activeStab = tab;
      sessionStorage.setItem('sv_settings_tab', tab);
      const allIds = Object.values(STAB_MAP).flat();
      allIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('stab-hidden');
      });
      (STAB_MAP[tab] || []).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('stab-hidden');
      });
      document.querySelectorAll('.stab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      if (tab === 'billing') {
        loadBillingSection();
        loadUpgradePlans();
        loadPlanUsage();
        loadReferralInfo();
      }
      // Cargar datos del tab acceso (seguridad)
      if (tab === 'acceso') {
        loadSecuritySection();
      }
    }

    async function loadSettings() {
      if (!authToken || !authWorkspace) {
        document.getElementById('settings-login-required').style.display = 'block';
        document.getElementById('settings-form').style.display = 'none';
        return;
      }
      document.getElementById('settings-login-required').style.display = 'none';
      document.getElementById('settings-form').style.display = 'block';
      
      // Restaurar la pestaña guardada o usar 'general' por defecto
      const savedTab = sessionStorage.getItem('sv_settings_tab') || 'perfil';
      const validTabs = ['perfil', 'general', 'acceso', 'api', 'billing', 'equipo', 'cuenta'];
      _activeStab = validTabs.includes(savedTab) ? savedTab : 'perfil';
      
      switchSettingsTab(_activeStab, true);

      // Declarar ws fuera del try para que sea accesible en loadAdsConfiguration
      let ws = null;
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`);
        if (!r.ok) return;
        ws = await r.json();
        const s = ws.settings || {};
        document.getElementById('cfg-player-name').value = s.embedPlayerName || '';
        document.getElementById('cfg-logo-url').value = s.embedLogo || '';
        const color = s.embedColor || '#7c6cfa';
        document.getElementById('cfg-color-picker').value = color;
        document.getElementById('cfg-color-hex').value = color;
        document.getElementById('cfg-domains').value = (s.embedAllowedDomains || []).join('\n');
        // TMDB
        const tmdbEl = document.getElementById('cfg-tmdb-key');
        if (tmdbEl) { tmdbEl.value = ''; tmdbEl.placeholder = s.tmdbApiKey === '__set__' ? 'Configurada — escribe para cambiar' : 'eyJhbGciOiJIUzI1NiJ9...'; }
        // Access & Security toggles
        const dl = document.getElementById('cfg-downloads-enabled');
        if (dl) dl.checked = s.downloadsEnabled !== false;
        const ch = document.getElementById('cfg-channel-enabled');
        if (ch) ch.checked = s.channelEnabled !== false;
        const em = document.getElementById('cfg-embed-enabled');
        if (em) em.checked = s.embedEnabled !== false;
        const pp = document.getElementById('cfg-playlists-public');
        if (pp) pp.checked = s.playlistsPublic !== false;
        const hp = document.getElementById('cfg-hotlink-protection');
        if (hp) hp.checked = !!s.hotlinkProtection;
        const rt = document.getElementById('cfg-require-tokens');
        if (rt) rt.checked = !!s.requireTokensAlways;
      } catch { }
      try {
        const r = await apiFetch(`${BASE}/api/videos?limit=200`);
        const json = await r.json();
        const videos = json.videos || (Array.isArray(json) ? json : []);
        const sel = document.getElementById('embed-video-select');
        sel.innerHTML = '<option value="">— Selecciona un video —</option>' +
          videos.filter(v => v.status === 'ready').map(v =>
            `<option value="${esc(v.id)}">${esc(v.title)}</option>`
          ).join('');
      } catch { }
      loadProfileData();
      if (ws) loadAdsConfiguration(ws.settings);
      if (ws) loadCustomDomainConfiguration(ws);
    }

    async function saveSettings() {
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');
      const color = document.getElementById('cfg-color-hex').value.trim() || document.getElementById('cfg-color-picker').value;
      const domainsRaw = document.getElementById('cfg-domains').value.trim();
      const domains = domainsRaw ? domainsRaw.split('\n').map(d => d.trim()).filter(Boolean) : [];
      const settings = {
        embedPlayerName: document.getElementById('cfg-player-name').value.trim(),
        embedLogo: document.getElementById('cfg-logo-url').value.trim(),
        embedColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#7c6cfa',
        embedAllowedDomains: domains,
        // API keys: only send if user typed a new value — empty = preserve existing in DB
        ...(document.getElementById('cfg-tmdb-key')?.value.trim()   ? { tmdbApiKey:  document.getElementById('cfg-tmdb-key').value.trim()  } : {}),
        ...(document.getElementById('cfg-openai-key')?.value.trim() ? { openaiApiKey: document.getElementById('cfg-openai-key').value.trim() } : {}),
        // Access & Security toggles
        downloadsEnabled: document.getElementById('cfg-downloads-enabled')?.checked ?? true,
        channelEnabled: document.getElementById('cfg-channel-enabled')?.checked ?? true,
        embedEnabled: document.getElementById('cfg-embed-enabled')?.checked ?? true,
        playlistsPublic: document.getElementById('cfg-playlists-public')?.checked ?? true,
        hotlinkProtection: document.getElementById('cfg-hotlink-protection')?.checked ?? false,
        requireTokensAlways: document.getElementById('cfg-require-tokens')?.checked ?? false,
      };
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        });
        if (!r.ok) return toast('Error al guardar', 'error');
        const el = document.getElementById('save-status');
        el.classList.add('visible'); setTimeout(() => el.classList.remove('visible'), 2500);
        toast('Configuración guardada');
      } catch { toast('Error de conexión', 'error'); }
    }

    // ─── Ads Settings ─────────────────────────────────────────────
    function onAdsTypeChange() {
      const type = document.getElementById('cfg-ads-type')?.value || '';
      const vastFields = document.getElementById('ads-vast-fields');
      const bannerFields = document.getElementById('ads-banner-fields');
      const popupFields = document.getElementById('ads-popup-fields');
      
      if (!vastFields || !bannerFields || !popupFields) return;
      
      // Ocultar todos por defecto
      vastFields.style.display = 'none';
      bannerFields.style.display = 'none';
      popupFields.style.display = 'none';
      
      // Mostrar según selección
      if (type === 'vast' || type === 'all') {
        vastFields.style.display = 'flex';
      }
      if (type === 'banner' || type === 'all') {
        bannerFields.style.display = 'flex';
      }
      if (type === 'popup' || type === 'all') {
        popupFields.style.display = 'flex';
      }
      
      // Mostrar/ocultar campo de mid-roll según posición VAST
      const vastPos = document.getElementById('cfg-vast-position')?.value;
      const midrollWrap = document.getElementById('ads-midroll-wrap');
      if (midrollWrap) {
        midrollWrap.style.display = (vastPos === 'midroll') ? 'block' : 'none';
      }
    }

    async function saveAdsSettings() {
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');
      
      const type = document.getElementById('cfg-ads-type')?.value || '';
      if (!type) {
        return toast('Selecciona un tipo de anuncio', 'error');
      }
      
      const adsConfig = { type };
      
      // VAST config
      if (type === 'vast' || type === 'all') {
        const vastUrl = document.getElementById('cfg-vast-url')?.value.trim();
        if (!vastUrl) return toast('URL del tag VAST es requerida', 'error');
        
        adsConfig.vast = {
          url: vastUrl,
          position: document.getElementById('cfg-vast-position')?.value || 'preroll',
          midrollTime: parseInt(document.getElementById('cfg-vast-midroll')?.value) || 60
        };
      }
      
      // Banner config
      if (type === 'banner' || type === 'all') {
        const html = document.getElementById('cfg-banner-html')?.value.trim();
        if (!html) return toast('Código HTML del banner es requerido', 'error');
        
        adsConfig.banner = {
          html,
          position: document.getElementById('cfg-banner-position')?.value || 'bottom',
          delay: parseInt(document.getElementById('cfg-banner-delay')?.value) || 0,
          duration: parseInt(document.getElementById('cfg-banner-duration')?.value) || 0
        };
      }
      
      // Popup config
      if (type === 'popup' || type === 'all') {
        const url = document.getElementById('cfg-popup-url')?.value.trim();
        if (!url) return toast('URL del popup es requerida', 'error');
        
        adsConfig.popup = {
          url,
          delay: parseInt(document.getElementById('cfg-popup-delay')?.value) || 10,
          frequency: parseInt(document.getElementById('cfg-popup-frequency')?.value) || 1
        };
      }
      
      try {
        const currentSettings = authWorkspace.settings || {};
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            settings: { ...currentSettings, ads: adsConfig }
          })
        });
        
        if (!r.ok) {
          const err = await r.json();
          return toast(err.error || 'Error al guardar anuncios', 'error');
        }
        
        // Actualizar cache local
        authWorkspace.settings = { ...currentSettings, ads: adsConfig };
        toast('Configuración de anuncios guardada', 'success');
        // Actualizar badge del card de ads inmediatamente
        const adsPlanBadge = document.getElementById('ads-plan-badge');
        if (adsPlanBadge) {
          const typeLabels = { vast: 'VAST', banner: 'BANNER', popup: 'POPUP', all: 'TODOS' };
          adsPlanBadge.textContent = typeLabels[adsConfig.type] || adsConfig.type.toUpperCase();
          adsPlanBadge.style.background = 'rgba(34,211,165,0.12)';
          adsPlanBadge.style.color = 'var(--green, #22d3a5)';
          adsPlanBadge.style.display = 'inline-block';
        }
      } catch (err) {
        console.error('Error saving ads:', err);
        toast('Error de conexión', 'error');
      }
    }

    async function clearAdsSettings() {
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');
      
      if (!await confirmModal('Desactivar anuncios', '¿Desactivar todos los anuncios?')) return;
      
      try {
        const currentSettings = authWorkspace.settings || {};
        delete currentSettings.ads;
        
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: currentSettings })
        });
        
        if (!r.ok) return toast('Error al desactivar anuncios', 'error');
        
        // Limpiar UI
        document.getElementById('cfg-ads-type').value = '';
        onAdsTypeChange();
        
        // Actualizar cache
        authWorkspace.settings = currentSettings;
        toast('Anuncios desactivados', 'success');
      } catch {
        toast('Error de conexión', 'error');
      }
    }

    // ─── Custom Domain ────────────────────────────────────────────
    function onCustomDomainInput() {
      const input = document.getElementById('cfg-custom-domain');
      if (!input) return;
      
      // Limpiar y normalizar
      let val = input.value.trim().toLowerCase();
      val = val.replace(/^(https?:\/\/)?(www\.)?/, ''); // Quitar protocolo y www
      val = val.split('/')[0]; // Quitar path
      input.value = val;
      
      // Actualizar preview DNS
      const dnsNameField = document.getElementById('dns-name-field');
      if (dnsNameField) {
        dnsNameField.textContent = val || 'tu-subdominio';
      }
    }

    async function verifyCustomDomain() {
      const input = document.getElementById('cfg-custom-domain');
      const domain = input?.value.trim().toLowerCase();
      
      if (!domain) return toast('Ingresa un dominio primero', 'error');
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');
      
      const btn = document.getElementById('verify-domain-btn');
      const originalText = btn.textContent;
      btn.textContent = 'Verificando...';
      btn.disabled = true;
      
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/verify-domain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain })
        });
        
        const data = await r.json();
        
        if (!r.ok) {
          toast(data.error || 'Error al verificar dominio', 'error');
          showDomainStatus(false, data.error || 'Verifica la configuración DNS');
        } else {
          toast('Dominio verificado correctamente', 'success');
          showDomainStatus(true, 'Dominio verificado y activo');
        }
      } catch (err) {
        console.error('Error verifying domain:', err);
        toast('Error de conexión', 'error');
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }

    function showDomainStatus(success, message) {
      const statusBox = document.getElementById('custom-domain-status-box');
      const statusWrap = document.getElementById('custom-domain-status');
      
      if (!statusBox || !statusWrap) return;
      
      statusWrap.style.display = 'block';
      
      if (success) {
        statusBox.style.background = 'rgba(34,197,94,0.1)';
        statusBox.style.border = '1px solid rgba(34,197,94,0.3)';
        statusBox.style.color = 'var(--green)';
        statusBox.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>${esc(message)}</span>
        `;
      } else {
        statusBox.style.background = 'rgba(239,68,68,0.1)';
        statusBox.style.border = '1px solid rgba(239,68,68,0.3)';
        statusBox.style.color = 'var(--red)';
        statusBox.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>${esc(message)}</span>
        `;
      }
    }

    async function saveCustomDomain() {
      const input = document.getElementById('cfg-custom-domain');
      const domain = input?.value.trim().toLowerCase();

      if (!domain) return toast('Ingresa un dominio primero', 'error');
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');

      if (!/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(domain)) {
        return toast('Formato de dominio inválido', 'error');
      }

      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ custom_embed_domain: domain })
        });

        if (!r.ok) {
          const err = await r.json();
          return toast(err.error || 'Error al guardar dominio', 'error');
        }

        authWorkspace.custom_embed_domain = domain;
        authWorkspace.custom_domain_verified = false;
        toast('Dominio guardado. Configura el CNAME en tu DNS y luego haz clic en "Verificar"', 'success');

        const removeBtn = document.getElementById('remove-domain-btn');
        if (removeBtn) removeBtn.style.display = 'inline-block';
        const statusWrap = document.getElementById('custom-domain-status');
        if (statusWrap) statusWrap.style.display = 'none';
      } catch (err) {
        console.error('Error saving domain:', err);
        toast('Error de conexión', 'error');
      }
    }

    async function removeCustomDomain() {
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');

      if (!await confirmModal('Eliminar dominio', '¿Eliminar el dominio personalizado?', 'Eliminar', 'Cancelar', true)) return;

      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ custom_embed_domain: null })
        });

        if (!r.ok) return toast('Error al eliminar dominio', 'error');

        document.getElementById('cfg-custom-domain').value = '';
        document.getElementById('custom-domain-status').style.display = 'none';
        document.getElementById('remove-domain-btn').style.display = 'none';
        onCustomDomainInput();

        authWorkspace.custom_embed_domain = null;
        authWorkspace.custom_domain_verified = false;
        toast('Dominio personalizado eliminado', 'success');
      } catch {
        toast('Error de conexión', 'error');
      }
    }

    // ─── Load ADS Configuration ───────────────────────────────────
    function loadAdsConfiguration(settings) {
      const adsPlanBadge = document.getElementById('ads-plan-badge');
      if (!settings || !settings.ads) {
        if (adsPlanBadge) {
          adsPlanBadge.textContent = 'SIN CONFIGURAR';
          adsPlanBadge.style.background = 'rgba(255,255,255,0.07)';
          adsPlanBadge.style.color = 'var(--muted, rgba(255,255,255,0.4))';
          adsPlanBadge.style.display = 'inline-block';
        }
        return;
      }

      const ads = settings.ads;
      
      // Configurar tipo de anuncio
      const typeSelect = document.getElementById('cfg-ads-type');
      if (typeSelect && ads.type) {
        typeSelect.value = ads.type;
      }
      
      // VAST config
      if (ads.vast) {
        const vastUrl = document.getElementById('cfg-vast-url');
        const vastPos = document.getElementById('cfg-vast-position');
        const vastMid = document.getElementById('cfg-vast-midroll');
        
        if (vastUrl) vastUrl.value = ads.vast.url || '';
        if (vastPos) vastPos.value = ads.vast.position || 'preroll';
        if (vastMid) vastMid.value = ads.vast.midrollTime || 60;
      }
      
      // Banner config
      if (ads.banner) {
        const bannerHtml = document.getElementById('cfg-banner-html');
        const bannerPos = document.getElementById('cfg-banner-position');
        const bannerDelay = document.getElementById('cfg-banner-delay');
        const bannerDur = document.getElementById('cfg-banner-duration');
        
        if (bannerHtml) bannerHtml.value = ads.banner.html || '';
        if (bannerPos) bannerPos.value = ads.banner.position || 'bottom';
        if (bannerDelay) bannerDelay.value = ads.banner.delay || 0;
        if (bannerDur) bannerDur.value = ads.banner.duration || 0;
      }
      
      // Popup config
      if (ads.popup) {
        const popupUrl = document.getElementById('cfg-popup-url');
        const popupDelay = document.getElementById('cfg-popup-delay');
        const popupFreq = document.getElementById('cfg-popup-frequency');
        
        if (popupUrl) popupUrl.value = ads.popup.url || '';
        if (popupDelay) popupDelay.value = ads.popup.delay || 10;
        if (popupFreq) popupFreq.value = ads.popup.frequency || 1;
      }
      
      // Actualizar UI según el tipo seleccionado
      onAdsTypeChange();

      // Actualizar badge de estado
      if (adsPlanBadge) {
        const typeLabels = { vast: 'VAST', banner: 'BANNER', popup: 'POPUP', all: 'TODOS' };
        adsPlanBadge.textContent = typeLabels[ads.type] || ads.type.toUpperCase();
        adsPlanBadge.style.background = 'rgba(34,211,165,0.12)';
        adsPlanBadge.style.color = 'var(--green, #22d3a5)';
        adsPlanBadge.style.display = 'inline-block';
      }
    }

    // ─── Load Custom Domain Configuration ─────────────────────────
    // Acepta el objeto workspace completo (no solo settings) para leer
    // custom_embed_domain y custom_domain_verified de sus columnas dedicadas.
    function loadCustomDomainConfiguration(ws) {
      const domainInput = document.getElementById('cfg-custom-domain');
      const removeBtn = document.getElementById('remove-domain-btn');
      const statusWrap = document.getElementById('custom-domain-status');

      const currentDomain = ws?.custom_embed_domain || null;
      const isVerified = !!ws?.custom_domain_verified;

      if (currentDomain) {
        if (domainInput) {
          domainInput.value = currentDomain;
          onCustomDomainInput();
        }
        if (removeBtn) removeBtn.style.display = 'inline-block';
        if (isVerified) {
          showDomainStatus(true, 'Dominio verificado y activo');
        } else {
          if (statusWrap) statusWrap.style.display = 'none';
        }
      } else {
        if (domainInput) domainInput.value = '';
        if (removeBtn) removeBtn.style.display = 'none';
        if (statusWrap) statusWrap.style.display = 'none';
        onCustomDomainInput();
      }
    }

    // ─── Profile ──────────────────────────────────────────────────
    function loadProfileData() {
      if (!authUser) return;
      const wsNameEl = document.getElementById('profile-workspace-name');
      if (wsNameEl && authWorkspace) wsNameEl.value = authWorkspace.name || '';
      document.getElementById('profile-name').value = authUser.name || '';
      document.getElementById('profile-channel-name').value = authUser.channel_name || '';
      document.getElementById('profile-username').value = authUser.username || '';
      document.getElementById('profile-email').value = authUser.email || '';
      const slugEl = document.getElementById('profile-channel-slug');
      if (slugEl && authWorkspace?.slug) slugEl.value = authWorkspace.slug;
      // Use workspace avatar if available (each workspace has its own logo)
      updateProfileAvatarPreview(authWorkspace?.avatar_url || authUser.avatar_url);
      // Load channel description from workspace settings
      if (authWorkspace) {
        try {
          const s = typeof authWorkspace.settings === 'string'
            ? JSON.parse(authWorkspace.settings) : (authWorkspace.settings || {});
          const descEl = document.getElementById('profile-channel-desc');
          if (descEl) descEl.value = s.channelDescription || '';
        } catch {}
      }
      updateFeedUrlPreview();
    }

    function updateFeedUrlPreview() {
      const slug = document.getElementById('profile-channel-slug')?.value?.trim() || authWorkspace?.slug || '';
      const wrap = document.getElementById('profile-feed-wrap');
      const urlEl = document.getElementById('profile-feed-url');
      if (!wrap || !urlEl) return;
      if (!slug) { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
      urlEl.value = `${BASE}/feed/${slug}`;
    }

    function copyFeedUrl() {
      const url = document.getElementById('profile-feed-url')?.value;
      if (!url) return;
      navigator.clipboard.writeText(url).then(() => toast('URL del feed copiada')).catch(() => {
        document.getElementById('profile-feed-url')?.select();
        document.execCommand('copy');
        toast('URL del feed copiada');
      });
    }

    function validateSlugInput(input) {
      input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
    }

    function updateProfileAvatarPreview(url) {
      const initEl = document.getElementById('profile-avatar-initials-large');
      const imgEl  = document.getElementById('profile-avatar-img-large');
      const removeBtn = document.getElementById('avatar-remove-btn');
      if (!initEl || !imgEl) return;
      if (url) {
        imgEl.src = url;
        imgEl.style.display = 'block';
        initEl.style.display = 'none';
        if (removeBtn) removeBtn.style.display = 'inline-block';
      } else {
        imgEl.style.display = 'none';
        initEl.style.display = 'block';
        initEl.textContent = getInitials(authUser?.name, authUser?.email);
        if (removeBtn) removeBtn.style.display = 'none';
      }
    }

    function validateUsernameInput(input) {
      input.value = input.value.replace(/[^a-zA-Z0-9_]/g, '');
    }

    async function handleAvatarUpload(input) {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        toast('La foto no puede superar 2 MB', 'error');
        input.value = '';
        return;
      }
      const statusEl = document.getElementById('avatar-upload-status');
      statusEl.textContent = 'Procesando…';
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = e => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        updateProfileAvatarPreview(dataUrl);
        statusEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:3px;"><polyline points="20 6 9 17 4 12"/></svg> Listo — guarda el perfil para aplicar';
        statusEl.style.color = 'var(--green)';
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
      } catch {
        statusEl.textContent = 'Error al procesar la imagen';
        statusEl.style.color = 'var(--red)';
      }
      input.value = '';
    }

    function removeAvatar() {
      updateProfileAvatarPreview(null);
      // Also update nav avatar if it was showing a photo
      const navAvatarImg = document.getElementById('profile-avatar-photo');
      if (navAvatarImg) navAvatarImg.style.display = 'none';
      document.getElementById('profile-avatar').style.display = '';
    }

    async function saveProfile() {
      if (!authToken) return toast('Inicia sesión primero', 'error');
      const name         = document.getElementById('profile-name').value.trim();
      const channel_name = document.getElementById('profile-channel-name').value.trim();
      const username     = document.getElementById('profile-username').value.trim().toLowerCase();
      const email        = document.getElementById('profile-email').value.trim().toLowerCase();
      const imgEl        = document.getElementById('profile-avatar-img-large');
      const avatar_url   = imgEl?.style.display !== 'none' ? (imgEl?.src || null) : null;

      if (!name) return toast('El nombre no puede estar vacío', 'error');
      if (username && !/^[a-z0-9_]{3,30}$/.test(username)) {
        return toast('Nombre de usuario inválido: solo letras, números y guiones bajos (3–30 caracteres)', 'error');
      }

      try {
        const r = await apiFetch(`${BASE}/auth/me`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, channel_name, username, email, avatar_url }),
        });
        const d = await r.json();
        if (!r.ok) {
          const msg = d.errors ? Object.values(d.errors)[0] : (d.error || 'Error al guardar');
          return toast(msg, 'error');
        }
        authUser = { ...authUser, ...d.user };
        updateAuthBar();
        updateNavAvatar();

        // Save workspace fields (name, slug, avatar, channelDescription)
        if (authWorkspace) {
          const wsNameEl = document.getElementById('profile-workspace-name');
          const newWsName = wsNameEl?.value.trim();
          const slugEl = document.getElementById('profile-channel-slug');
          const newSlug = slugEl?.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
          const channelDesc = document.getElementById('profile-channel-desc')?.value?.trim() || '';
          const wsPatch = {};
          if (newWsName && newWsName !== authWorkspace.name) wsPatch.name = newWsName;
          if (newSlug && newSlug !== authWorkspace.slug) wsPatch.slug = newSlug;
          // Per-workspace avatar (so each workspace has its own logo)
          const wsAvatarCurrent = authWorkspace.avatar_url || null;
          if (avatar_url !== wsAvatarCurrent) wsPatch.avatar_url = avatar_url;
          try {
            const existingSettings = typeof authWorkspace.settings === 'string'
              ? JSON.parse(authWorkspace.settings) : (authWorkspace.settings || {});
            if (channelDesc !== (existingSettings.channelDescription || '')) {
              wsPatch.settings = { ...existingSettings, channelDescription: channelDesc };
            }
          } catch {}
          if (Object.keys(wsPatch).length) {
            const sr = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(wsPatch),
            });
            if (sr.ok) {
              authWorkspace = { ...authWorkspace, ...wsPatch };
              const channelLink = document.getElementById('nav-channel-link');
              if (channelLink && wsPatch.slug) channelLink.href = `${BASE}/c/${encodeURIComponent(wsPatch.slug)}`;
              updateAuthBar();
              updateFeedUrlPreview();
            } else {
              const sd = await sr.json().catch(() => ({}));
              return toast(sd.error || 'Error al guardar el workspace', 'error');
            }
          }
        }

        toast('Perfil actualizado');
      } catch { toast('Error de conexión', 'error'); }
    }

    function updateNavAvatar() {
      if (!authUser) return;
      const avatarEl = document.getElementById('profile-avatar');
      if (!avatarEl) return;
      let photoEl = document.getElementById('profile-avatar-photo');
      if (authUser.avatar_url) {
        if (!photoEl) {
          photoEl = document.createElement('img');
          photoEl.id = 'profile-avatar-photo';
          photoEl.alt = 'Avatar';
          photoEl.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0;border-radius:8px;';
          avatarEl.style.position = 'relative';
          avatarEl.style.overflow = 'hidden';
          avatarEl.appendChild(photoEl);
        }
        photoEl.src = authUser.avatar_url;
        photoEl.style.display = 'block';
      } else if (photoEl) {
        photoEl.style.display = 'none';
      }
    }

    async function profileChangePassword() {
      const current = document.getElementById('profile-pw-current').value;
      const newPw   = document.getElementById('profile-pw-new').value;
      const confirm = document.getElementById('profile-pw-confirm').value;
      if (!current || !newPw || !confirm) return toast('Completa todos los campos', 'error');
      if (newPw.length < 8) return toast('Mínimo 8 caracteres', 'error');
      if (newPw !== confirm) return toast('Las contraseñas no coinciden', 'error');
      const btn = document.getElementById('profile-pw-btn');
      btn.disabled = true; btn.textContent = 'Cambiando…';
      try {
        const r = await apiFetch(`${BASE}/auth/change-password`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: current, newPassword: newPw }),
        });
        const d = await r.json();
        if (!r.ok) return toast(d.error || 'Error cambiando contraseña', 'error');
        document.getElementById('profile-pw-current').value = '';
        document.getElementById('profile-pw-new').value = '';
        document.getElementById('profile-pw-confirm').value = '';
        toast('Contraseña actualizada correctamente', 'success');
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Cambiar contraseña'; }
    }

    // ─── Searchable select ────────────────────────────────────────
    function buildSearchableSelect(selectEl) {
      if (!selectEl || selectEl.dataset.svSearchable) return;
      selectEl.dataset.svSearchable = '1';
      selectEl.style.display = 'none';

      const wrap = document.createElement('div');
      wrap.className = 'sv-sel';
      selectEl.parentNode.insertBefore(wrap, selectEl);
      wrap.appendChild(selectEl);

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'sv-sel-trigger';
      trigger.innerHTML = '<span class="sv-sel-label"></span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';

      const dropdown = document.createElement('div');
      dropdown.className = 'sv-sel-dd';

      const searchWrap = document.createElement('div');
      searchWrap.className = 'sv-sel-srch';
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Buscar...';
      searchInput.setAttribute('autocomplete', 'off');
      searchInput.setAttribute('spellcheck', 'false');
      searchWrap.appendChild(searchInput);

      const list = document.createElement('div');
      list.className = 'sv-sel-list';

      dropdown.appendChild(searchWrap);
      dropdown.appendChild(list);
      wrap.appendChild(trigger);
      wrap.appendChild(dropdown);

      let isOpen = false;

      function updateTrigger() {
        const opt = [...selectEl.options].find(o => o.value === selectEl.value);
        const lbl = wrap.querySelector('.sv-sel-label');
        if (lbl) lbl.textContent = opt ? opt.textContent : (selectEl.options[0]?.textContent || '—');
      }

      function renderList(filter) {
        const fl = (filter || '').toLowerCase();
        const opts = [...selectEl.options];
        const filtered = fl ? opts.filter(o => !o.disabled && o.textContent.toLowerCase().includes(fl)) : opts;
        list.innerHTML = filtered.map(o =>
          `<div class="sv-sel-opt${o.value === selectEl.value ? ' sel' : ''}${o.disabled ? ' dis' : ''}" data-val="${o.value.replace(/"/g, '&quot;')}">${esc(o.textContent)}</div>`
        ).join('');
        list.querySelectorAll('.sv-sel-opt:not(.dis)').forEach(el => {
          el.onclick = () => {
            selectEl.value = el.dataset.val;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            updateTrigger();
            close();
          };
        });
      }

      // Move dropdown to <body> so it escapes any overflow:hidden/auto ancestors
      document.body.appendChild(dropdown);

      function positionDropdown() {
        const rect = trigger.getBoundingClientRect();
        const ddHeight = 320; // max expected height (search + list)
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const openAbove = spaceBelow < ddHeight && rect.top > ddHeight;
        dropdown.style.position = 'fixed';
        dropdown.style.width = rect.width + 'px';
        dropdown.style.left  = rect.left + 'px';
        if (openAbove) {
          dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
          dropdown.style.top = 'auto';
        } else {
          dropdown.style.top  = (rect.bottom + 4) + 'px';
          dropdown.style.bottom = 'auto';
        }
        dropdown.style.zIndex = '9999';
      }

      function open() {
        isOpen = true;
        dropdown.classList.add('open');
        wrap.classList.add('open');
        searchInput.value = '';
        renderList('');
        positionDropdown();
        requestAnimationFrame(() => searchInput.focus());
      }

      function close() {
        isOpen = false;
        dropdown.classList.remove('open');
        wrap.classList.remove('open');
      }

      trigger.onclick = (e) => { e.stopPropagation(); isOpen ? close() : open(); };
      searchInput.oninput = () => renderList(searchInput.value);
      searchInput.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

      window.addEventListener('resize', () => { if (isOpen) positionDropdown(); });
      window.addEventListener('scroll', () => { if (isOpen) positionDropdown(); }, true);
      document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target) && !dropdown.contains(e.target)) close(); });

      new MutationObserver(() => {
        // Options changed — defer trigger update so any .value assignment settles first
        setTimeout(() => {
          updateTrigger();
          if (isOpen) renderList(searchInput.value);
        }, 0);
      }).observe(selectEl, { childList: true });

      // Expose refresh on the wrapper for external callers
      wrap._svRefresh = updateTrigger;

      updateTrigger();
    }

    // F1.2: Embed mode state
    let _embedMode = 'fixed';

    function setEmbedMode(mode) {
      _embedMode = mode;
      ['fixed','responsive','fullwidth'].forEach(m => {
        const btn = document.getElementById(`embed-mode-${m}`);
        if (!btn) return;
        if (m === mode) {
          btn.style.background = 'var(--surface4)';
          btn.style.color = 'var(--text)';
        } else {
          btn.style.background = 'transparent';
          btn.style.color = 'var(--muted)';
        }
      });
      updateEmbedPreview();
    }

    function getEmbedSrc(id) {
      const color = encodeURIComponent(document.getElementById('cfg-color-hex').value || '#7c6cfa');
      const logo = document.getElementById('cfg-logo-url').value.trim();
      // Don't embed data: URLs — they bloat the iframe src enormously.
      // The player already loads the logo from workspace settings via the API.
      const logoParam = logo && !logo.startsWith('data:') ? '&logo=' + encodeURIComponent(logo) : '';
      return `${BASE}/embed/${id}?color=${color}${logoParam}`;
    }

    function buildEmbedCode(id, mode) {
      const src = getEmbedSrc(id);
      if (mode === 'responsive') {
        return `<div style="position:relative;padding-top:56.25%;overflow:hidden;">\n  <iframe src="${src}"\n    style="position:absolute;top:0;left:0;width:100%;height:100%;"\n    frameborder="0" allowfullscreen></iframe>\n</div>`;
      } else if (mode === 'fullwidth') {
        return `<iframe src="${src}"\n  style="width:100%;aspect-ratio:16/9;border:none;"\n  frameborder="0" allowfullscreen></iframe>`;
      } else {
        return `<iframe src="${src}"\n  width="640" height="360"\n  frameborder="0" allowfullscreen></iframe>`;
      }
    }

    function updateEmbedPreview() {
      const sel = document.getElementById('embed-video-select');
      const id = sel.value;
      const preview = document.getElementById('embed-code-preview');
      if (!id) { preview.innerHTML = 'Selecciona un video para ver el código de embed.'; return; }
      const code = buildEmbedCode(id, _embedMode);
      preview.innerHTML = esc(code)
        .replace(/&lt;/g, '<span class="hl">&lt;</span><span style="color:var(--accent);">')
        .replace(/&gt;/g, '</span><span class="hl">&gt;</span>');
      // Simple syntax highlight: show full code with accent on tags
      preview.innerHTML = `<code style="white-space:pre-wrap;">${esc(code)}</code>`;
    }

    function copyEmbedCode() {
      const id = document.getElementById('embed-video-select').value;
      if (!id) return toast('Selecciona un video primero', 'error');
      const code = buildEmbedCode(id, _embedMode);
      navigator.clipboard.writeText(code).then(() => toast('Código embed copiado'));
    }

    // ─── Section navigation ───────────────────────────────────────
    const SECTIONS = ['videos', 'upload', 'settings', 'analytics', 'playlists', 'security'];
    const SECTION_META = {
      videos: ['Mis Videos', 'Gestiona tu biblioteca de streaming'],
      upload: ['Subir Video', 'El sistema convierte automáticamente a múltiples calidades HLS'],
      settings: ['Configuración', 'Personaliza el player embebible de tu workspace'],
      analytics: ['Analytics', 'Métricas de retención, heatmap y engagement por video'],
      playlists: ['Playlists', 'Agrupa videos en listas reproducibles'],
      security: ['Seguridad', 'Controla el acceso a tu cuenta y gestiona la autenticación'],
    };
    function showSection(name, opts = {}) {
      if (_activeImports && _activeImports.size > 0) {
        _activeImports.forEach(timer => {
          if (timer) clearTimeout(timer);
        });
        _activeImports.clear();
      }
      
      if (name === 'videos') {
        startStatsMonitor();
      } else {
        stopStatsMonitor();
      }
      
      SECTIONS.forEach(s => {
        const el = document.getElementById(`section-${s}`);
        if (!el) return;
        el.style.display = s === name ? 'block' : 'none';
      });
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      document.querySelector(`.nav-item[data-section="${name}"]`)?.classList.add('active');
      const [title, sub] = SECTION_META[name] || ['', ''];
      document.getElementById('page-title').textContent = title;
      document.getElementById('page-sub').textContent = sub;
      const bc = document.getElementById('breadcrumb-current');
      if (bc) bc.textContent = title;
      const statsWrap = document.getElementById('videos-stats-wrap');
      if (statsWrap) statsWrap.style.display = name === 'videos' ? 'block' : 'none';
      const subirBtn = document.querySelector('.btn-subir');
      if (subirBtn) subirBtn.style.display = name === 'upload' ? 'none' : '';
      if (!opts.skipUrl) {
        const path = name === 'videos' ? '/dashboard' : `/dashboard/${name}`;
        if (window.location.pathname !== path) history.pushState({ section: name }, '', path);
      }
      if (name !== 'videos') clearBulkSelection();
      if (name === 'settings') loadSettings();
      if (name === 'analytics') populateAnalyticsVideoSelect();
      if (name === 'playlists') loadPlaylists();
      if (name === 'videos') {
        loadFolders();
        if (allVideosCache.length > 0) applyLibraryFilters();
        loadVideos();
      }
      if (name === 'security') loadSecuritySection();
      if (name !== 'analytics') stopAnalyticsAutoRefresh();
    }

    // ─── Analytics ────────────────────────────────────────────────
    let retentionChart = null, dailyChart = null, deviceChart = null;
    let analyticsRefreshTimer = null, analyticsCountdownTimer = null, analyticsCountdownSecs = 0;
    let analyticsCurrentVideoId = null;

    async function populateAnalyticsVideoSelect() {
      try {
        const r = await apiFetch(`${BASE}/api/videos?limit=1000`);
        const json = await r.json();
        const videos = json.videos || (Array.isArray(json) ? json : []);
        const sel = document.getElementById('analytics-video-select');
        
        if (!sel) {
          console.warn('Analytics video select element not found');
          return;
        }
        
        const prev = sel.value;
        sel.innerHTML = '<option value="__workspace__"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" style="vertical-align:middle;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Resumen Global del Workspace</option><option disabled>───</option>' +
          videos.filter(v => v.status === 'ready').map(v =>
            `<option value="${esc(v.id)}">${esc(v.title)}</option>`
          ).join('');
        buildSearchableSelect(sel);
        if (!prev) {
          sel.value = '__workspace__';
          sel.closest('.sv-sel')?._svRefresh?.();
          try {
            await loadAnalytics();
          } catch (err) {
            console.warn('Error loading initial analytics:', err);
          }
        } else {
          sel.value = prev;
          sel.closest('.sv-sel')?._svRefresh?.();
        }
      } catch (err) {
        console.error('Error populating analytics select:', err);
      }
    }

    function fmtSec(s) {
      const m = Math.floor(s / 60); const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    }

    function startAnalyticsAutoRefresh(videoId) {
      stopAnalyticsAutoRefresh();
      analyticsCurrentVideoId = videoId;
      analyticsCountdownSecs = 60;
      const countdownEl = document.getElementById('analytics-countdown');

      analyticsCountdownTimer = setInterval(() => {
        analyticsCountdownSecs--;
        if (countdownEl) countdownEl.textContent = analyticsCountdownSecs > 0 ? `auto-refresh en ${analyticsCountdownSecs}s` : '';
        if (analyticsCountdownSecs <= 0) {
          analyticsCountdownSecs = 60;
          refreshLiveViewers(analyticsCurrentVideoId);
          loadAnalytics(true);
        }
      }, 1000);
    }

    function stopAnalyticsAutoRefresh() {
      clearInterval(analyticsRefreshTimer);
      clearInterval(analyticsCountdownTimer);
      analyticsRefreshTimer = null;
      analyticsCountdownTimer = null;
      analyticsCurrentVideoId = null;
      const countdownEl = document.getElementById('analytics-countdown');
      if (countdownEl) countdownEl.textContent = '';
    }

    async function refreshLiveViewers(videoId) {
      if (!videoId) return;
      try {
        const r = await apiFetch(`${BASE}/api/videos/${videoId}/analytics/live`);
        if (!r.ok) return;
        const { live } = await r.json();
        const badge = document.getElementById('live-viewers-badge');
        const count = document.getElementById('live-viewers-count');
        if (badge && count) {
          count.textContent = live;
          badge.style.display = live > 0 ? 'inline-flex' : 'none';
        }
      } catch {}
    }

    async function downloadAnalyticsCsv(videoId) {
      try {
        const r = await apiFetch(`${BASE}/api/videos/${videoId}/analytics/export.csv`);
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          return toast(d.error || 'Error al exportar CSV', 'error');
        }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `analytics-${videoId}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        toast('Error al descargar CSV', 'error');
      }
    }

    async function loadAnalytics(silent = false) {
      const selectEl = document.getElementById('analytics-video-select');
      const daysEl = document.getElementById('analytics-days-select');
      const container = document.getElementById('analytics-content');
      
      if (!selectEl || !container) {
        console.warn('Analytics elements not found');
        return;
      }
      
      const id = selectEl.value;
      const days = daysEl?.value;
      if (!id) {
        stopAnalyticsAutoRefresh();
        document.getElementById('live-viewers-badge').style.display = 'none';
        container.innerHTML = '<div class="analytics-empty">Selecciona un video para ver sus métricas.</div>';
        return;
      }
      if (id === '__workspace__') {
        stopAnalyticsAutoRefresh();
        document.getElementById('live-viewers-badge').style.display = 'none';
        if (!silent) container.innerHTML = '<div class="analytics-empty"><span class="spinner" style="width:20px;height:20px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px;"></span> Cargando resumen global…</div>';
        try {
          const qs = days ? `?days=${days}` : '';
          const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/analytics${qs}`);
          if (!r.ok) throw new Error('failed');
          renderWorkspaceAnalytics(await r.json());
        } catch {
          if (!silent) container.innerHTML = '<div class="analytics-empty" style="color:var(--red)">Error cargando resumen global.</div>';
        }
        return;
      }
      if (!silent) {
        container.innerHTML = '<div class="analytics-empty"><span class="spinner" style="width:20px;height:20px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px;"></span> Cargando métricas…</div>';
      }
      try {
        const qs = days ? `?days=${days}` : '';
        const r = await apiFetch(`${BASE}/api/videos/${id}/analytics${qs}`);
        if (!r.ok) throw new Error('failed');
        renderAnalytics(await r.json());
        refreshLiveViewers(id);
        if (id !== analyticsCurrentVideoId) {
          startAnalyticsAutoRefresh(id);
        } else {
          analyticsCountdownSecs = 60;
        }
      } catch {
        if (!silent) container.innerHTML = '<div class="analytics-empty" style="color:var(--red)">Error cargando analytics.</div>';
      }
    }

    // ── Country flag helper ───────────────────────────────────────
    function countryFlag(code) {
      if (!code || code.length !== 2) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>';
      // Return 2-letter country code as text label for universal compatibility
      return `<span style="font-size:11px;font-weight:700;color:var(--muted);font-family:var(--mono);">${code.toUpperCase()}</span>`;
    }

    function renderWorkspaceAnalytics(d) {
      const container = document.getElementById('analytics-content');

      // Destroy any existing chart before replacing the DOM
      if (dailyChart) { dailyChart.destroy(); dailyChart = null; }

      container.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px;">
          <div class="stat-card accent-purple">
            <div class="stat-card-icon"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></div>
            <div class="stat-label">Vistas Totales</div>
            <div class="stat-value">${Number(d.totalViews || 0).toLocaleString('es')}</div>
          </div>
          <div class="stat-card accent-green">
            <div class="stat-card-icon"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
            <div class="stat-label">Almacenamiento Usado</div>
            <div class="stat-value">${fmtBytes(d.storageUsedBytes || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>
            <div class="stat-label">Tráfico Consumido</div>
            <div class="stat-value">${fmtBytes(d.bandwidthUsedBytes || 0)}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;">
          <div class="chart-card" style="margin-bottom:0;">
            <div class="chart-card-title">Evolución de Vistas</div>
            <div style="height:250px;" id="wsDailyChartWrap">${(d.dailyPlays && d.dailyPlays.length)
              ? `<canvas id="wsDailyChart"></canvas>`
              : `<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--muted);"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span style="font-size:13px;">Sin datos de reproducción en este período</span></div>`
            }</div>
          </div>
          <div class="chart-card" style="margin-bottom:0;display:flex;flex-direction:column;">
            <div class="chart-card-title">Videos más vistos</div>
            <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;flex:1;">
              ${(d.topVideos||[]).map(v => `<li style="display:flex;justify-content:space-between;padding:10px 12px;background:var(--surface2);border-radius:6px;font-size:13px;align-items:center;">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;" title="${esc(v.title)}">${esc(v.title)}</span>
                <span style="font-weight:600;color:var(--accent2);flex-shrink:0;">${v.views.toLocaleString()}</span>
              </li>`).join('') || '<li style="font-size:13px;color:var(--muted);padding:10px;">No hay datos</li>'}
            </ul>
          </div>
        </div>
      `;

      if (d.dailyPlays && d.dailyPlays.length > 0) {
        const ctx = document.getElementById('wsDailyChart').getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 250);
        gradient.addColorStop(0, 'rgba(34, 211, 165, 0.25)');
        gradient.addColorStop(1, 'rgba(34, 211, 165, 0)');
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: d.dailyPlays.map(x => { const p = x.day.split('-'); return p[2]+'/'+p[1]; }),
            datasets: [{
              label: 'Vistas',
              data: d.dailyPlays.map(x => x.plays),
              borderColor: '#22d3a5',
              backgroundColor: gradient,
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#22d3a5'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false, drawBorder: false }, ticks: { color: '#888', font: { family: 'Inter', size: 11 } } },
              y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false }, ticks: { color: '#888', font: { family: 'Inter', size: 11 } } }
            }
          }
        });
      }
    }

    function renderAnalytics(d) {
      const container = document.getElementById('analytics-content');

      // Determinar nivel de analytics usando d.tier (fuente de verdad del servidor)
      // El backend ya aplica las restricciones del plan y devuelve tier: 'basic' | 'full'
      // Fallback a _cachedFeatures si por alguna razón d.tier no está presente
      const serverTier = d.tier; // 'basic' | 'full' | undefined
      const cachedLevel = _cachedFeatures?.analyticsEnabled;
      // Prioridad: tier del servidor > cache del frontend
      const analyticsLevel = serverTier === 'basic' ? 'basic'
                           : serverTier === 'full'  ? 'full'
                           : cachedLevel;
      const isBasicAnalytics = analyticsLevel === 'basic';
      const isFullAnalytics  = analyticsLevel === 'full' || analyticsLevel === true;

      // Si no tiene acceso a analytics en absoluto, no renderizar nada
      if (analyticsLevel === false) {
        container.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;gap:16px;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <div style="font-size:16px;font-weight:700;color:var(--text);">Analytics no disponible</div>
            <div style="font-size:13px;color:var(--muted);max-width:380px;">Tu plan actual no incluye acceso a Analytics. Actualiza tu plan para ver métricas detalladas de tus videos.</div>
            <button class="btn btn-primary" style="margin-top:8px;" onclick="goSection(null,'settings');setTimeout(()=>switchSettingsTab('billing'),200);">Ver planes disponibles</button>
          </div>`;
        return;
      }

      // Valores por defecto para cuando el tier es 'basic' (sin datos avanzados)
      const retention   = d.retention   || [];
      const topSegments = d.topSegments || [];
      const dropOffs    = d.dropOffs    || [];
      const dailyPlays  = d.dailyPlays  || [];

      const heatmapSegs = retention.map((pt, i, arr) => {
        const pct = pt.pct / 100;
        const r = Math.round(255 * (1 - pct)); const g = Math.round(200 * pct);
        const width = 100 / arr.length; const left = (i / arr.length) * 100;
        return `<div class="heatmap-seg" style="left:${left}%;width:${width + 0.5}%;background:rgba(${r},${g},60,0.65);"></div>`;
      }).join('');
      const maxPlays = topSegments[0]?.plays || 1;
      const topSegsHtml = topSegments.map(s =>
        `<li><span class="tl-time">${fmtSec(s.second)}</span><div class="tl-bar"><div class="tl-fill" style="width:${Math.round(s.plays / maxPlays * 100)}%"></div></div><span class="tl-val">${s.plays}x</span></li>`
      ).join('') || '<li style="color:var(--muted);font-size:13px;">Sin datos aún</li>';
      const dropHtml = dropOffs.map(dp =>
        `<li><span class="tl-time">${fmtSec(dp.second)}</span><div class="tl-bar"><div class="tl-fill" style="width:${Math.min(100, dp.drop * 3)}%;background:var(--red);"></div></div><span class="tl-val" style="color:var(--red)">-${dp.drop}%</span></li>`
      ).join('') || '<li style="color:var(--muted);font-size:13px;">Sin caídas significativas</li>';

      // ── Engagement score (0–100) ──────────────────────────────────
      const engagementScore = Math.round(
        (d.completionRate * 0.4) +
        (Math.min(100, d.avgWatchTimePct) * 0.35) +
        (Math.min(100, (d.uniqueViewers > 0 ? (d.totalPlays / d.uniqueViewers) : 0) * 20) * 0.25)
      );
      const engColor = engagementScore >= 70 ? 'var(--green)' : engagementScore >= 40 ? 'var(--amber)' : 'var(--red)';
      const engLabel = engagementScore >= 70 ? 'Excelente' : engagementScore >= 40 ? 'Bueno' : 'Bajo';

      // ── Geo section (solo plan Full) ───────────────────────────────────────────
      const geoHtml = d.countryBreakdown?.length
        ? (() => {
            const mc = d.countryBreakdown[0]?.viewers || 1;
            return d.countryBreakdown.map((c, i) => {
              const flag = countryFlag(c.country);
              const pct  = Math.round((c.viewers / mc) * 100);
              const rank = ['1.','2.','3.'][i] || `${i+1}.`;
              return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
                <span style="font-size:18px;width:28px;text-align:center;flex-shrink:0;">${flag}</span>
                <div style="flex:1;min-width:0;">
                  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                    <span style="font-weight:600;">${esc(c.country || '?')}</span>
                    <span style="color:var(--muted);">${c.viewers} viewer${c.viewers !== 1 ? 's' : ''}</span>
                  </div>
                  <div style="background:var(--surface2);border-radius:99px;height:5px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:var(--green);border-radius:99px;transition:width .4s;"></div>
                  </div>
                </div>
                <span style="font-size:13px;width:24px;text-align:right;flex-shrink:0;">${rank}</span>
              </div>`;
            }).join('');
          })()
        : '<p style="color:var(--muted);font-size:13px;padding:12px 0;">Sin datos de geolocalización aún.<br><span style="font-size:12px;">Los datos aparecen después de los primeros plays.</span></p>';

      // ── Banner de upgrade para plan Basic ─────────────────────────
      const upgradeBannerHtml = isBasicAnalytics ? `
        <div style="margin-top:20px;padding:18px 20px;background:linear-gradient(135deg,rgba(124,108,250,0.12),rgba(34,211,165,0.08));border:1px solid rgba(124,108,250,0.3);border-radius:14px;display:flex;align-items:center;gap:16px;">
          <div style="flex-shrink:0;width:40px;height:40px;border-radius:10px;background:rgba(124,108,250,0.15);display:flex;align-items:center;justify-content:center;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent2)" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <div style="flex:1;">
            <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:3px;">Desbloquea Analytics Completo</div>
            <div style="font-size:12px;color:var(--muted);">Actualiza a <b style="color:var(--accent2);">Pro</b> para acceder a heatmaps, geolocalización, análisis de dispositivos, curvas de retención avanzadas y más.</div>
          </div>
          <button class="btn btn-primary" style="flex-shrink:0;font-size:12px;padding:8px 16px;white-space:nowrap;" onclick="goSection(null,'settings');setTimeout(()=>switchSettingsTab('billing'),200);">
            Actualizar plan
          </button>
        </div>` : '';

      container.innerHTML = `
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">Espectadores únicos</div><div class="metric-value">${d.uniqueViewers}</div></div>
      <div class="metric-card"><div class="metric-label">Reproducciones totales</div><div class="metric-value">${d.totalPlays}</div></div>
      <div class="metric-card"><div class="metric-label">Tiempo promedio</div><div class="metric-value">${fmtSec(d.avgWatchTime)}</div><div class="metric-sub">${d.avgWatchTimePct}% del video</div></div>
      <div class="metric-card"><div class="metric-label">Tasa de finalización</div><div class="metric-value">${d.completionRate}%</div></div>
      <div class="metric-card" style="border-color:${engColor}33;">
        <div class="metric-label">Engagement Score</div>
        <div class="metric-value" style="color:${engColor};">${engagementScore}</div>
        <div class="metric-sub" style="color:${engColor};">${engLabel}</div>
      </div>
    </div>

    ${isBasicAnalytics ? upgradeBannerHtml : `

    <!-- ── Retention Curve (Engagement) — solo Full ── -->
    <div class="chart-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div class="chart-card-title" style="margin:0;">Curva de Engagement — ¿En qué minuto se van?</div>
        <div style="font-size:11px;color:var(--muted);">Promedio: <b style="color:var(--accent2);">${d.avgWatchTimePct}%</b> del video</div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Cada punto muestra qué % de espectadores seguía viendo en ese momento.</div>
      <div class="chart-wrap" style="height:200px;"><canvas id="retention-chart"></canvas></div>
      <div style="margin-top:14px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Heatmap de calor</div>
        <div class="heatmap-track">${heatmapSegs}</div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:4px;"><span>0:00</span><span>${fmtSec(d.duration)}</span></div>
      </div>
      ${dropOffs.length ? `
      <div style="margin-top:14px;padding:12px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.15);border-radius:10px;">
        <div style="font-size:11px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:3px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Puntos críticos de abandono</div>
        <ul class="top-list">${dropHtml}</ul>
      </div>` : ''}
    </div>

    <div class="analytics-grid2">
      <div class="chart-card" style="margin-bottom:0;"><div class="chart-card-title">Segmentos más vistos</div><ul class="top-list">${topSegsHtml}</ul></div>
      <div class="chart-card" style="margin-bottom:0;">
        <div class="chart-card-title" style="margin-bottom:12px;">Dispositivos</div>
        <div style="position:relative;height:160px;"><canvas id="device-chart"></canvas></div>
        <div id="device-legend" style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;font-size:12px;"></div>
      </div>
    </div>

    ${dailyPlays.length ? `<div class="chart-card" style="margin-top:16px;"><div class="chart-card-title">Reproducciones diarias (últimos 30 días)</div><div class="chart-wrap"><canvas id="daily-chart"></canvas></div></div>` : ''}

    <!-- ── Geolocalización — solo Full ── -->
    <div class="chart-card" style="margin-top:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div class="chart-card-title" style="margin:0;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg> Geolocalización de Audiencia</div>
        ${d.countryBreakdown?.length ? `<span style="font-size:12px;color:var(--muted);">${d.countryBreakdown.length} países</span>` : ''}
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Top países por número de espectadores únicos.</div>
      ${geoHtml}
    </div>
    `}

    <div class="chart-card" style="margin-top:16px;${(_cachedFeatures.transcriptionsEnabled === false || isBasicAnalytics) ? 'display:none;' : ''}" id="transcription-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div class="chart-card-title" style="margin:0;">Transcripción con Whisper AI</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="tx-lang-select" style="background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius);color:var(--text);padding:6px 11px;font-size:13px;font-family:var(--sans);outline:none;">
            <option value="es">Español</option><option value="en">English</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="pt">Português</option><option value="ja">日本語</option><option value="zh">中文</option>
          </select>
          <button class="btn btn-primary" style="padding:7px 15px;font-size:13px;" onclick="triggerTranscription('${escAttr(d.videoId)}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Transcribir
          </button>
        </div>
      </div>
      <div id="tx-list">Cargando…</div>
    </div>
    <div class="chart-card" style="margin-top:16px;${isBasicAnalytics ? 'display:none;' : ''}" id="search-panel">
      <div style="margin-bottom:16px;"><div class="chart-card-title" style="margin:0 0 12px;">Buscar en transcripción</div></div>
      <div style="display:flex;gap:8px;">
        <input id="tx-search-input" type="text" placeholder="Buscar palabra o frase en el video…"
          style="flex:1;background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius);color:var(--text);padding:9px 13px;font-size:13px;font-family:var(--sans);outline:none;transition:border-color .14s;"
          onkeydown="if(event.key==='Enter') searchTranscript('${escAttr(d.videoId)}')">
        <button class="btn btn-primary" style="padding:9px 17px;font-size:13px;" onclick="searchTranscript('${escAttr(d.videoId)}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Buscar
        </button>
      </div>
      <div id="tx-search-results" style="margin-top:14px;"></div>
    </div>
    ${isFullAnalytics ? `<div style="margin-top:14px;text-align:right;">
      <button onclick="downloadAnalyticsCsv('${d.videoId}')" class="btn btn-ghost" style="font-size:13px;padding:9px 18px;display:inline-flex;align-items:center;gap:7px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Exportar CSV
      </button>
    </div>` : ''}`;

      loadTranscriptions(d.videoId);

      // Solo inicializar charts cuando el nivel de analytics es full
      // En modo basic, los canvas no existen en el DOM y causarían errores
      if (!isBasicAnalytics) {
        const _cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        const _ca = (hex, a) => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; };
        const _accent = _cv('--accent'); const _accent2 = _cv('--accent2');
        const _green = _cv('--green'); const _amber = _cv('--amber'); const _muted = _cv('--muted');

        if (retentionChart) retentionChart.destroy();
        retentionChart = new Chart(document.getElementById('retention-chart').getContext('2d'), {
          type: 'line',
          data: { labels: retention.map(pt => fmtSec(pt.second)), datasets: [{ label: 'Retención %', data: retention.map(pt => pt.pct), borderColor: _accent2, backgroundColor: _ca(_accent, 0.08), borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }] },
          options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: _muted, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { min: 0, max: 100, ticks: { color: _muted, font: { size: 11 }, callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.05)' } } }, plugins: { legend: { display: false } } },
        });

        if (dailyChart) dailyChart.destroy();
        const dailyEl = document.getElementById('daily-chart');
        if (dailyEl && dailyPlays.length) {
          dailyChart = new Chart(dailyEl.getContext('2d'), {
            type: 'bar',
            data: { labels: dailyPlays.map(p => p.day), datasets: [{ label: 'Reproducciones', data: dailyPlays.map(p => p.plays), backgroundColor: _ca(_accent, 0.5), borderColor: _accent, borderWidth: 1, borderRadius: 5 }] },
            options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: _muted, font: { size: 11 } }, grid: { display: false } }, y: { ticks: { color: _muted, font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } } }, plugins: { legend: { display: false } } },
          });
        }

        const deviceEl = document.getElementById('device-chart');
        if (deviceEl && d.deviceBreakdown) {
          if (deviceChart) { deviceChart.destroy(); deviceChart = null; }
          const DCOL = { desktop: _accent, mobile: _green, tablet: _amber, other: _muted };
          const devE = Object.entries(d.deviceBreakdown);
          if (devE.length) {
            deviceChart = new Chart(deviceEl.getContext('2d'), {
              type: 'doughnut',
              data: { labels: devE.map(([k]) => k), datasets: [{ data: devE.map(([, v]) => v), backgroundColor: devE.map(([k]) => DCOL[k] || _muted), borderWidth: 0 }] },
              options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '65%' },
            });
            const leg = document.getElementById('device-legend');
            if (leg) leg.innerHTML = devE.map(([k, v]) =>
              `<span style="display:flex;align-items:center;gap:4px;"><span style="width:9px;height:9px;border-radius:50%;background:${DCOL[k] || _muted};display:inline-block;"></span><span style="color:var(--muted);">${k}</span><b>${v}</b></span>`
            ).join('');
          }
        }
      } // end if (!isBasicAnalytics)
    }

    // ─── Transcriptions ───────────────────────────────────────────
    const TX_STATUS_LABELS = { pending: 'En cola', processing: 'Procesando…', ready: 'Listo', error: 'Error' };
    const TX_STATUS_COLORS = { pending: 'var(--accent2)', processing: 'var(--amber)', ready: 'var(--green)', error: 'var(--red)' };

    async function loadTranscriptions(videoId) {
      const list = document.getElementById('tx-list');
      if (!list) return;
      try {
        const r = await apiFetch(`${BASE}/api/videos/${videoId}/transcriptions`);
        if (!r.ok) { list.innerHTML = '<span style="color:var(--muted);font-size:13px;">Sin transcripciones.</span>'; return; }
        const txs = await r.json();
        if (!txs.length) { list.innerHTML = '<span style="color:var(--muted);font-size:13px;">Sin transcripciones. Pulsa "Transcribir" para generar subtítulos con Whisper AI.</span>'; return; }
        list.innerHTML = txs.map(tx => `
      <div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <span style="font-family:var(--mono);color:var(--accent2);min-width:28px;">${esc(tx.language.toUpperCase())}</span>
        <span style="color:${TX_STATUS_COLORS[tx.status]};">${TX_STATUS_LABELS[tx.status]}</span>
        ${tx.word_count ? `<span style="color:var(--muted);">${tx.word_count} palabras</span>` : ''}
        ${tx.error_msg ? `<span style="color:var(--red);font-size:12px;flex:1;">${esc(tx.error_msg.slice(0, 60))}</span>` : '<span style="flex:1;"></span>'}
        ${tx.status === 'ready' ? `<a href="${BASE}/api/videos/${videoId}/transcriptions/${tx.language}/subtitles.vtt" style="color:var(--accent2);font-size:12px;text-decoration:none;" download><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> VTT</a>` : ''}
        ${tx.status === 'ready' || tx.status === 'failed' ? `<button style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;padding:2px 7px;" title="Retranscribir con la IA mejorada" onclick="retranscribe('${videoId}','${tx.id}','${tx.language}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> Retranscribir</button>` : ''}
        <button style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;padding:2px 7px;" onclick="deleteTranscription('${videoId}','${tx.id}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`).join('');
        if (txs.some(t => ['pending', 'processing'].includes(t.status))) setTimeout(() => loadTranscriptions(videoId), 4000);
      } catch { list.innerHTML = '<span style="color:var(--muted);font-size:13px;">Error cargando transcripciones.</span>'; }
    }

    async function triggerTranscription(videoId) {
      const lang = document.getElementById('tx-lang-select')?.value || 'es';
      try {
        const r = await apiFetch(`${BASE}/api/videos/${videoId}/transcriptions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: lang }),
        });
        const d = await r.json();
        if (!r.ok) return toast(d.error || 'Error al iniciar transcripción', 'error');
        toast(`Transcripción iniciada (${lang}). Tardará 1–3 minutos.`);
        loadTranscriptions(videoId);
      } catch { toast('Error de conexión', 'error'); }
    }

    async function deleteTranscription(videoId, txId) {
      const ok = await confirmModal('¿Eliminar transcripción?', 'Esta acción no se puede deshacer y los subtítulos dejarán de estar disponibles.', 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      const r = await apiFetch(`${BASE}/api/videos/${videoId}/transcriptions/${txId}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(d.error || 'Error al eliminar transcripción', 'error'); }
      loadTranscriptions(videoId);
    }

    async function retranscribe(videoId, txId, language) {
      const ok = await confirmModal(
        '¿Retranscribir con IA mejorada?',
        `Se eliminará la transcripción de "${language.toUpperCase()}" actual y se generará una nueva con temperatura=0, filtros anti-alucinación y timestamps más precisos.`,
        'Retranscribir', 'Cancelar', true
      );
      if (!ok) return;
      // Delete current transcription first
      const delBtn = document.querySelector(`button[onclick*="retranscribe('${videoId}','${txId}'"]`);
      if (delBtn) { delBtn.disabled = true; delBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:3px;"><path d="M6 2h12M6 22h12M6 2a8 8 0 0 0 0 8M18 2a8 8 0 0 1 0 8M6 22a8 8 0 0 1 0-8M18 22a8 8 0 0 0 0-8"/></svg> Procesando…'; }
      try {
        // 1. Delete old
        const delR = await apiFetch(`${BASE}/api/videos/${videoId}/transcriptions/${txId}`, { method: 'DELETE' });
        if (!delR.ok) { const dd = await delR.json().catch(() => ({})); throw new Error(dd.error || 'Error al eliminar transcripción anterior'); }
        // 2. Trigger new transcription with same language
        const r = await apiFetch(`${BASE}/api/videos/${videoId}/transcriptions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language }),
        });
        const d = await r.json();
        if (!r.ok) return toast(d.error || 'Error al iniciar retranscripción', 'error');
        toast(`Retranscripción iniciada (${language.toUpperCase()}). Tardará 1–3 minutos.`);
        loadTranscriptions(videoId);
      } catch { toast('Error de conexión', 'error'); }
    }

    async function searchTranscript(videoId) {
      const input = document.getElementById('tx-search-input');
      const resultsEl = document.getElementById('tx-search-results');
      const q = input?.value?.trim();
      if (!resultsEl) return;
      if (!q || q.length < 2) { resultsEl.innerHTML = '<span style="color:var(--muted);font-size:13px;">Ingresa al menos 2 caracteres.</span>'; return; }
      resultsEl.innerHTML = '<span style="color:var(--muted);font-size:13px;"><span class="spinner"></span> Buscando…</span>';
      try {
        const r = await apiFetch(`${BASE}/api/videos/${videoId}/transcriptions/search?q=${encodeURIComponent(q)}`);
        if (r.status === 404) { resultsEl.innerHTML = '<span style="color:var(--muted);font-size:13px;">No hay transcripción lista para este video.</span>'; return; }
        if (!r.ok) { const e = await r.json().catch(() => ({})); resultsEl.innerHTML = `<span style="color:var(--red);font-size:13px;">${esc(e.error || 'Error al buscar')}</span>`; return; }
        const d = await r.json();
        if (!d.total) { resultsEl.innerHTML = `<span style="color:var(--muted);font-size:13px;">Sin resultados para "<b>${esc(q)}</b>".</span>`; return; }
        const rows = d.results.map(hit => {
          const ts = formatDuration(hit.startTime);
          // SECURITY FIX: Escape the entire snippet FIRST, then replace the escaped
          // query matches with highlighted marks. This prevents XSS via API-supplied
          // snippet text that could contain HTML/JS. Both the match and surrounding
          // text are safely escaped before being injected into innerHTML.
          const escapedSnippet = esc(hit.snippet);
          const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const highlighted = escapedSnippet.replace(
            new RegExp(escapedQ, 'gi'),
            m => `<mark style="background:rgba(124,108,250,0.35);color:var(--text);border-radius:2px;padding:0 2px;">${m}</mark>`
          );
          return `<div style="display:flex;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px;"><a href="${BASE}/watch/${videoId}?t=${Math.floor(hit.startTime)}" target="_blank" rel="noopener noreferrer" style="font-family:var(--mono);color:var(--accent2);white-space:nowrap;text-decoration:none;min-width:48px;padding-top:1px;" title="Ir al minuto ${esc(ts)}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:3px;"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${esc(ts)}</a><span style="color:var(--muted);line-height:1.55;">${highlighted}</span></div>`;
        }).join('');
        resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">${d.total} resultado${d.total !== 1 ? 's' : ''} · idioma: <b>${(d.language || '').toUpperCase()}</b></div>${rows}`;
      } catch { resultsEl.innerHTML = '<span style="color:var(--red);font-size:13px;">Error de conexión.</span>'; }
    }

    // ─── Toast ────────────────────────────────────────────────────
    function toast(msg, type = 'success') {
      // Mapear tipos al sistema svToast (con progress bar, iconos y dismiss)
      const typeMap = { success: 'success', error: 'error', warn: 'warning', warning: 'warning', info: 'info' };
      const svType = typeMap[type] || 'success';
      if (typeof window.svToast === 'function') {
        window.svToast(msg, svType);
        return;
      }
      // Fallback al #toast div del theme
      const el = document.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.className = `toast ${type} show`;
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('show'), 3200);
    }

    // ─── Utilities ────────────────────────────────────────────────
    function formatSize(bytes) {
      if (!bytes) return '—';
      const gb = bytes / 1e9;
      if (gb >= 1) return gb.toFixed(2) + ' GB';
      return (bytes / 1e6).toFixed(1) + ' MB';
    }
    function formatDuration(secs) {
      if (!secs) return '—';
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    function timeAgo(ts) {
      const diff = Date.now() / 1000 - ts;
      if (diff < 60) return 'ahora mismo';
      if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
      if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
      return `hace ${Math.floor(diff / 86400)}d`;
    }
    function esc(str) {
      return String(str||'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escAttr(str) {
      return String(str||'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function expiryBadge(expiresAt) {
      if (!expiresAt) return '';
      const now = Math.floor(Date.now() / 1000);
      const diff = expiresAt - now;
      if (diff < 0) return `<span class="expiry-badge expiry-urgent"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Expirado</span>`;
      const days = Math.ceil(diff / 86400);
      const urgent = days <= 3;
      const label = days === 0 ? 'Expira hoy' : days === 1 ? 'Expira mañana' : `Expira en ${days}d`;
      return `<span class="expiry-badge${urgent ? ' expiry-urgent' : ''}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${label}</span>`;
    }

    function filterByTag(tag) {
      const sel = document.getElementById('library-filter-tag');
      if (!sel) return;
      sel.value = tag;
      if (typeof showSection === 'function') showSection('videos');
      loadVideos(1);
    }

    // ─── Upload tab switcher ──────────────────────────────────────
    function switchUploadTab(tab) {
      const isFile = tab === 'file';
      const isUrl  = tab === 'url';
      const isCsv  = tab === 'csv';
      document.getElementById('file-upload-panel').style.display  = isFile ? '' : 'none';
      document.getElementById('url-import-panel').style.display   = isUrl  ? '' : 'none';
      document.getElementById('csv-import-panel').style.display   = isCsv  ? '' : 'none';
      document.getElementById('tab-file').classList.toggle('active', isFile);
      document.getElementById('tab-url').classList.toggle('active', isUrl);
      document.getElementById('tab-csv').classList.toggle('active', isCsv);
      if (isUrl && document.querySelectorAll('#url-rows .url-row').length === 0) addUrlRow();
    }

    // ─── Bulk CSV Import ──────────────────────────────────────────
    let _csvRows = []; // [{url, title, tags, status, statusEl}]

    function _parseCsv(text) {
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const rows = [];
      for (const line of lines) {
        // Simple CSV parse: split on first two commas (fields may not be quoted)
        // Support comma-separated fields; tags use | as separator
        const parts = line.split(',');
        if (parts.length < 1) continue;
        const url = (parts[0] || '').trim();
        if (!url || url.toLowerCase() === 'url') continue; // skip header
        try { new URL(url); } catch { continue; } // skip invalid URLs
        const title = (parts[1] || '').trim();
        const tagsRaw = (parts.slice(2).join(',') || '').trim();
        const tags = tagsRaw ? tagsRaw.split('|').map(t => t.trim()).filter(Boolean) : [];
        rows.push({ url, title, tags, status: 'pending', statusEl: null });
      }
      return rows;
    }

    function parseCsvPreview() {
      const raw = document.getElementById('csv-raw-input')?.value || '';
      _csvRows = _parseCsv(raw);
      _renderCsvPreview();
    }

    function _renderCsvPreview() {
      const preview = document.getElementById('csv-preview');
      const tbody   = document.getElementById('csv-preview-body');
      const countEl = document.getElementById('csv-row-count');
      const importBtn = document.getElementById('csv-import-btn');
      const importCnt = document.getElementById('csv-import-count');
      if (!preview || !tbody) return;
      if (!_csvRows.length) {
        preview.style.display = 'none';
        if (importBtn) importBtn.style.display = 'none';
        return;
      }
      countEl.textContent = _csvRows.length;
      importCnt.textContent = `${_csvRows.length} video${_csvRows.length !== 1 ? 's' : ''}`;
      tbody.innerHTML = _csvRows.map((r, i) => `
        <tr id="csv-row-${i}" style="border-bottom:1px solid var(--border2);">
          <td style="padding:5px 8px;font-family:var(--mono);font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.url)}">${esc(r.url.length > 50 ? r.url.slice(0,47)+'…' : r.url)}</td>
          <td style="padding:5px 8px;font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.title || '—')}</td>
          <td style="padding:5px 8px;font-size:11px;color:var(--muted);">${r.tags.length ? r.tags.map(t=>`<span style="background:rgba(124,108,250,.12);color:var(--accent2);border-radius:4px;padding:1px 6px;font-size:10px;">${esc(t)}</span>`).join(' ') : '—'}</td>
          <td id="csv-status-${i}" style="padding:5px 8px;font-size:11px;color:var(--muted);">Pendiente</td>
        </tr>`).join('');
      preview.style.display = '';
      importBtn.style.display = '';
    }

    function onCsvFileSelect(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        document.getElementById('csv-raw-input').value = ev.target.result;
        parseCsvPreview();
      };
      reader.readAsText(file);
    }

    function onCsvDrop(e) {
      e.preventDefault();
      document.getElementById('csv-dropzone').style.borderColor = 'var(--border2)';
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        document.getElementById('csv-raw-input').value = ev.target.result;
        parseCsvPreview();
      };
      reader.readAsText(file);
    }

    async function startCsvImport() {
      if (!_csvRows.length) return;
      const btn = document.getElementById('csv-import-btn');
      if (btn) btn.disabled = true;
      const errEl = document.getElementById('csv-import-error');
      if (errEl) errEl.style.display = 'none';

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < _csvRows.length; i++) {
        const row = _csvRows[i];
        const statusEl = document.getElementById(`csv-status-${i}`);
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent2);">Enviando…</span>';

        try {
          const body = { url: row.url };
          if (row.title) body.title = row.title;
          if (row.tags?.length) body.tags = row.tags;

          const r = await apiFetch('/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const d = await r.json().catch(() => ({}));

          if (r.ok) {
            successCount++;
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--green);">✓ En cola</span>`;
            // Patch tags onto the created video if provided
            if (row.tags?.length && d.id) {
              apiFetch(`/api/videos/${d.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: row.tags }),
              }).catch(() => {});
            }
          } else {
            failCount++;
            if (statusEl) statusEl.innerHTML = `<span style="color:var(--red);" title="${esc(d.error||'Error')}">✗ Error</span>`;
          }
        } catch {
          failCount++;
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--red);">✗ Fallo de red</span>';
        }

        // Brief pause between requests to avoid hammering the server
        if (i < _csvRows.length - 1) await new Promise(r => setTimeout(r, 300));
      }

      if (btn) btn.disabled = false;
      toast(
        `CSV: ${successCount} en cola${failCount ? `, ${failCount} con error` : ''}`,
        failCount ? 'warning' : 'success'
      );
      if (successCount > 0) {
        setTimeout(() => { switchUploadTab('file'); showSection('videos'); loadVideos(1); }, 1500);
      }
    }

    // ─── URL Import (multi-URL queue) ─────────────────────────────
    const _activeImports = new Map(); // videoId → timer
    const STATUS_LABELS    = { downloading:'Descargando…', queued:'En cola…', transcoding:'Transcodificando…', ready:'¡Listo!', error:'Error' };
    const STATUS_PCT_MIN   = { downloading:2, queued:2, transcoding:2, ready:100, error:0 };
    const STATUS_CLS       = { downloading:'imp-downloading', queued:'imp-queued', transcoding:'imp-transcoding', ready:'imp-ready', error:'imp-error' };
    let _urlRowIdx = 0;

    function addUrlRow() {
      const idx = _urlRowIdx++;
      const wrap = document.getElementById('url-rows');
      const row = document.createElement('div');
      row.className = 'url-row';
      row.dataset.idx = idx;
      row.innerHTML = `
        <input type="url" placeholder="https://example.com/video.mp4" oninput="document.getElementById('url-import-error').style.display='none'">
        <input type="text" class="url-title" placeholder="Título (opcional)">
        <button type="button" class="url-row-remove" onclick="this.closest('.url-row').remove()" title="Eliminar">×</button>`;
      wrap.appendChild(row);
      row.querySelector('input[type=url]').focus();
    }

    async function importAllUrls() {
      const rows = document.querySelectorAll('#url-rows .url-row');
      const errEl = document.getElementById('url-import-error');
      errEl.style.display = 'none';

      const jobs = [];
      for (const row of rows) {
        const url = row.querySelector('input[type=url]').value.trim();
        const title = row.querySelector('input.url-title').value.trim();
        if (!url) continue;
        try { new URL(url); } catch {
          errEl.textContent = `URL inválida: ${url}`;
          errEl.style.display = '';
          return;
        }
        jobs.push({ url, title });
      }
      if (!jobs.length) { errEl.textContent = 'Agrega al menos una URL.'; errEl.style.display = ''; return; }

      const btn = document.getElementById('import-all-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Enviando…';

      let ok = 0;
      for (const job of jobs) {
        try {
          const r = await apiFetch('/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: job.url, title: job.title || undefined }),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Error');
          _addImportCard(data.id, data.title || job.url);
          ok++;
        } catch (err) {
          _addImportCard(null, job.url, err.message);
        }
      }

      // Clear URL rows
      document.getElementById('url-rows').innerHTML = '';
      addUrlRow();
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:5px;vertical-align:-2px;"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/></svg>Importar';
      if (ok > 0) toast(`${ok} importación(es) iniciada(s). Ver progreso abajo.`);
    }

    function _addImportCard(videoId, titleOrUrl, errorMsg) {
      const wrap = document.getElementById('active-imports');
      const list = document.getElementById('active-imports-list');
      wrap.style.display = '';
      const card = document.createElement('div');
      card.className = 'imp-card';
      const shortLabel = titleOrUrl.length > 60 ? titleOrUrl.slice(0, 57) + '…' : titleOrUrl;
      if (errorMsg) {
        card.innerHTML = `<div class="imp-card-header"><div class="imp-card-title">${esc(shortLabel)}</div><span class="imp-card-status imp-error">Error</span></div><div style="font-size:12px;color:var(--red);margin-top:4px;">${esc(errorMsg)}</div>`;
      } else {
        card.id = 'imp-card-' + videoId;
        card.innerHTML = `<div class="imp-card-header"><div class="imp-card-title">${esc(shortLabel)}</div><span class="imp-card-status imp-downloading" id="imp-status-${videoId}">Descargando…</span></div><div class="uq-progress-row" style="margin-top:8px;"><div class="uq-progress-track"><div class="uq-progress-fill" id="imp-bar-${videoId}" style="width:5%"></div></div><span class="uq-pct" id="imp-pct-${videoId}">5%</span></div>`;
        _trackImport(videoId);
      }
      list.appendChild(card);
    }

    function _trackImport(videoId) {
      if (_activeImports.has(videoId)) return;
      _activeImports.set(videoId, null);
      _pollImport(videoId);
    }

    async function _pollImport(videoId) {
      try {
        const r = await fetch(`/api/import/${videoId}/status`, { headers: authHeaders() });
        if (!r.ok) {
          _activeImports.delete(videoId);
          showToast('Error al verificar el estado del import', 'error');
          return;
        }
        const d = await r.json();

        // Use real pct from API when available, fall back to a minimum floor per status
        const realPct = d.pct != null ? Math.max(STATUS_PCT_MIN[d.status] ?? 2, Math.min(99, d.pct)) : null;
        const pct = d.status === 'ready' ? 100 : (realPct ?? STATUS_PCT_MIN[d.status] ?? 2);
        const lbl = STATUS_LABELS[d.status] || d.status;
        const cls = STATUS_CLS[d.status] || '';

        const barEl = document.getElementById('imp-bar-' + videoId);
        const pctEl = document.getElementById('imp-pct-' + videoId);
        const stEl  = document.getElementById('imp-status-' + videoId);
        if (barEl) barEl.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        if (stEl)  { stEl.className = 'imp-card-status ' + cls; stEl.textContent = lbl; }

        if (d.status === 'ready' || d.status === 'error') {
          _activeImports.delete(videoId);
          if (d.status === 'ready') {
            loadVideos();
            startPolling();
            // Replace progress bar with a "Ver video" button
            const card = document.getElementById('imp-card-' + videoId);
            if (card) {
              const progressRow = card.querySelector('.uq-progress-row');
              if (progressRow) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-primary';
                btn.style.cssText = 'margin-top:8px;font-size:12px;padding:6px 14px;';
                btn.textContent = 'Ver video';
                btn.onclick = () => {
                  showSection('videos');
                  setTimeout(() => openVideoPreview(videoId), 400);
                };
                progressRow.replaceWith(btn);
              }
            }
          }
          return;
        }
        const t = setTimeout(() => _pollImport(videoId), 3000);
        _activeImports.set(videoId, t);
      } catch { _activeImports.delete(videoId); }
    }

    // ─── Upload (multi-file queue) ────────────────────────────────
    let _uploadQueue = []; // array of { uid, file, status }
    let _uploadRunning = false;

    function _queueRender() {
      const list = document.getElementById('uq-list');
      const wrap = document.getElementById('upload-queue');
      // Persist any in-progress title edits before replacing innerHTML
      _uploadQueue.forEach(item => {
        const el = document.getElementById('uq-title-' + item.uid);
        if (el) item.title = el.value;
      });
      document.getElementById('uq-count').textContent = _uploadQueue.length;
      if (!_uploadQueue.length) { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
      list.innerHTML = _uploadQueue.map(item => {
        return `<div class="uq-item${item.status === 'uploading' ? ' uq-uploading' : item.status === 'done' ? ' uq-done' : item.status === 'error' ? ' uq-error' : ''}" id="uq-${item.uid}">
          <div class="uq-header">
            <div class="uq-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent2)" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div>
            <div class="uq-meta"><div class="uq-name">${esc(item.title)}</div><div class="uq-size">${formatSize(item.file.size)}</div></div>
            <input class="uq-title-input" id="uq-title-${item.uid}" value="${esc(item.title)}" placeholder="Título" oninput="(function(el){const it=_uploadQueue.find(i=>i.uid==='${item.uid}');if(it)it.title=el.value;})(this)">
            <span class="uq-badge ${item.status === 'pending' ? 'uq-pending' : item.status === 'uploading' ? 'uq-uploading' : item.status === 'done' ? 'uq-done' : 'uq-error'}">${item.status === 'pending' ? 'Pendiente' : item.status === 'uploading' ? 'Subiendo…' : item.status === 'done' ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:2px;"><polyline points="20 6 9 17 4 12"/></svg> Listo' : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:2px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Error'}</span>
            ${item.status === 'pending' ? `<button class="uq-remove-btn" onclick="removeQueueItem('${item.uid}')">×</button>` : ''}
          </div>
          ${['uploading','done','error'].includes(item.status) ? `<div class="uq-progress-row"><div class="uq-progress-track"><div class="uq-progress-fill" id="uq-fill-${item.uid}" style="width:${item.pct||0}%"></div></div><span class="uq-pct" id="uq-pct-${item.uid}">${item.pct||0}%</span></div>` : ''}
        </div>`;
      }).join('');
    }

    function onFileSelect(e) {
      const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('video/') || f.name.match(/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|mts|m2ts)$/i));
      if (!files.length) return;
      files.forEach(f => _uploadQueue.push({ uid: Math.random().toString(36).slice(2), file: f, status: 'pending', pct: 0, title: f.name.replace(/\.[^.]+$/, '') }));
      _queueRender();
      document.getElementById('upload-zone').style.opacity = '0.5';
      document.getElementById('file-input').value = '';
    }

    const zone = document.getElementById('upload-zone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/') || f.name.match(/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|mts|m2ts)$/i));
      if (!files.length) return;
      files.forEach(f => _uploadQueue.push({ uid: Math.random().toString(36).slice(2), file: f, status: 'pending', pct: 0, title: f.name.replace(/\.[^.]+$/, '') }));
      _queueRender();
      zone.style.opacity = '0.5';
    });

    function removeQueueItem(uid) {
      _uploadQueue = _uploadQueue.filter(i => i.uid !== uid);
      if (!_uploadQueue.length) zone.style.opacity = '1';
      _queueRender();
    }

    function clearQueue() {
      _uploadQueue = _uploadQueue.filter(i => i.status !== 'pending');
      if (!_uploadQueue.length) zone.style.opacity = '1';
      _queueRender();
    }

    function cancelUpload() {
      _uploadQueue = [];
      _uploadRunning = false;
      zone.style.opacity = '1';
      _queueRender();
    }

    async function startQueueUpload() {
      if (_uploadRunning) return;
      const pending = _uploadQueue.filter(i => i.status === 'pending');
      if (!pending.length) return toast('Sin archivos pendientes', 'error');
      _uploadRunning = true;
      document.getElementById('uq-upload-btn').disabled = true;
      for (const item of pending) {
        await _uploadOneFile(item);
      }
      _uploadRunning = false;
      document.getElementById('uq-upload-btn').disabled = false;
      const allDone = _uploadQueue.every(i => i.status === 'done');
      if (allDone) {
        toast('¡Todos los videos subidos! Transcodificando en segundo plano…');
        setTimeout(() => { cancelUpload(); showSection('videos'); loadVideos(); startPolling(); }, 1800);
      } else {
        loadVideos(); startPolling();
      }
    }

    function _uploadOneFile(item) {
      return new Promise(resolve => {
        // Flush any last keystroke from the DOM before re-rendering
        const titleEl = document.getElementById('uq-title-' + item.uid);
        if (titleEl && titleEl.value.trim()) item.title = titleEl.value.trim();
        const title = item.title || item.file.name.replace(/\.[^.]+$/, '');
        item.status = 'uploading';
        _queueRender();
        const formData = new FormData();
        formData.append('video', item.file);
        formData.append('title', title);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        if (authToken) xhr.setRequestHeader('Authorization', 'Bearer ' + authToken);
        if (authWorkspace?.id) xhr.setRequestHeader('x-workspace-id', authWorkspace.id);
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            item.pct = Math.round((e.loaded / e.total) * 100);
            const fillEl = document.getElementById('uq-fill-' + item.uid);
            const pctEl  = document.getElementById('uq-pct-' + item.uid);
            if (fillEl) fillEl.style.width = item.pct + '%';
            if (pctEl)  pctEl.textContent = item.pct + '%';
          }
        };
        xhr.onload = () => {
          item.pct = 100;
          item.status = xhr.status >= 200 && xhr.status < 300 ? 'done' : 'error';
          _queueRender();
          resolve();
        };
        xhr.onerror = xhr.ontimeout = () => { item.status = 'error'; _queueRender(); resolve(); };
        xhr.send(formData);
      });
    }

    // Legacy single-file aliases (kept for any external callers)
    function doUpload() { startQueueUpload(); }

    // ─── Library ──────────────────────────────────────────────────
    function loadStats() {
      const videos = allVideosCache;
      document.getElementById('stat-total').textContent = videos.length;
      document.getElementById('stat-ready').textContent = videos.filter(v => v.status === 'ready').length;
      document.getElementById('stat-proc').textContent = videos.filter(v => ['queued', 'transcoding'].includes(v.status)).length;
      document.getElementById('stat-views').textContent = videos.reduce((s, v) => s + (v.views || 0), 0).toLocaleString('es');
    }

    // ─── Sort state for column headers ───────────────────────────
    let _libSortField = 'recent'; // 'recent'|'title'|'views'|'size'|'duration'
    let _libSortDir = 'desc';     // 'asc'|'desc'

    function sortByColumn(field) {
      if (_libSortField === field) {
        _libSortDir = _libSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _libSortField = field;
        _libSortDir = field === 'title' ? 'asc' : 'desc';
      }
      // Sync the dropdown
      const sortSel = document.getElementById('library-sort');
      if (sortSel) sortSel.value = field;
      applyLibraryFilters();
    }

    function applyLibraryFilters() {
      let list = [...allVideosCache];
      // Search: title + description + slug
      const q = (document.getElementById('library-search')?.value || '').trim().toLowerCase();
      if (q) list = list.filter(v =>
        (v.title || '').toLowerCase().includes(q) ||
        (v.description || '').toLowerCase().includes(q) ||
        (v.short_code || '').toLowerCase().includes(q) ||
        (v.id || '').toLowerCase().startsWith(q)
      );
      // Status filter
      const statusF = document.getElementById('library-filter-status')?.value || 'all';
      if (statusF === 'ready') list = list.filter(v => v.status === 'ready');
      else if (statusF === 'processing') list = list.filter(v => ['queued', 'transcoding'].includes(v.status));
      // Visibility filter
      const visF = document.getElementById('library-filter-visibility')?.value || 'all';
      if (visF !== 'all') list = list.filter(v => (v.visibility || 'public') === visF);
      // Tag filter
      const tagF = document.getElementById('library-filter-tag')?.value || '';
      if (tagF) list = list.filter(v => (v.tags || []).includes(tagF));
      // Sort — dropdown always wins unless a column header was clicked
      const sortSel = document.getElementById('library-sort')?.value || 'recent';
      // If dropdown changed, reset sort state from dropdown
      if (sortSel !== _libSortField) {
        _libSortField = sortSel;
        _libSortDir = sortSel === 'title' ? 'asc' : 'desc';
      }
      const sf = _libSortField;
      const sd = _libSortDir;
      if (sf === 'views') list.sort((a, b) => sd === 'asc' ? (a.views||0)-(b.views||0) : (b.views||0)-(a.views||0));
      else if (sf === 'title') list.sort((a, b) => sd === 'asc' ? (a.title||'').localeCompare(b.title||'','es') : (b.title||'').localeCompare(a.title||'','es'));
      else if (sf === 'duration') list.sort((a, b) => sd === 'asc' ? (a.duration||0)-(b.duration||0) : (b.duration||0)-(a.duration||0));
      else if (sf === 'size') list.sort((a, b) => sd === 'asc' ? (a.size||0)-(b.size||0) : (b.size||0)-(a.size||0));
      else list.sort((a, b) => sd === 'asc' ? (a.created_at||0)-(b.created_at||0) : (b.created_at||0)-(a.created_at||0));
      // Update hint — only show when filtered
      const hint = document.getElementById('library-count-hint');
      const isFiltered = list.length !== allVideosCache.length || !!q || visF !== 'all' || statusF !== 'all' || !!tagF;
      if (hint) hint.textContent = (isFiltered && allVideosCache.length) ? `${list.length} de ${allVideosCache.length} video${allVideosCache.length !== 1 ? 's' : ''}` : '';
      // Update visibility filter visual indicator
      const visEl = document.getElementById('library-filter-visibility');
      if (visEl) visEl.classList.toggle('vis-filter-active', visF !== 'all');
      renderVideos(list, { filteredView: isFiltered, hasMore: videosPage < videosTotalPages });
    }

    function renderVideoSkeletons(n = 5) {
      const grid = document.getElementById('video-grid');
      if (_libView === 'list') {
        grid.className = 'video-grid list-view';
        grid.innerHTML = `<table class="video-table"><thead><tr>
          <th style="width:32px;"></th><th style="width:auto;"></th><th style="width:90px;"></th><th style="width:90px;"></th><th style="width:70px;"></th><th style="width:90px;"></th><th style="width:100px;"></th><th style="width:90px;"></th><th style="width:130px;"></th>
        </tr></thead><tbody>${Array.from({ length: n }, () => `
          <tr style="animation:skeleton-pulse 1.15s ease-in-out infinite;">
            <td style="padding:10px 12px;"><div style="width:14px;height:14px;border-radius:3px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="display:flex;align-items:center;gap:10px;"><div style="width:88px;height:50px;border-radius:5px;background:var(--surface3);flex-shrink:0;"></div><div style="flex:1;"><div style="height:12px;width:70%;border-radius:4px;background:var(--surface3);margin-bottom:6px;"></div><div style="height:10px;width:40%;border-radius:4px;background:var(--surface3);opacity:.6;"></div></div></div></td>
            <td style="padding:10px 12px;"><div style="height:10px;width:60px;border-radius:4px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="height:10px;width:40px;border-radius:4px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="height:10px;width:30px;border-radius:4px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="height:10px;width:50px;border-radius:4px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="height:10px;width:45px;border-radius:4px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="height:18px;width:50px;border-radius:99px;background:var(--surface3);"></div></td>
            <td style="padding:10px 12px;"><div style="display:flex;gap:4px;"><div style="width:28px;height:28px;border-radius:6px;background:var(--surface3);"></div><div style="width:28px;height:28px;border-radius:6px;background:var(--surface3);"></div><div style="width:28px;height:28px;border-radius:6px;background:var(--surface3);"></div></div></td>
          </tr>`).join('')}</tbody></table>`;
      } else {
        grid.className = 'video-grid';
        grid.innerHTML = Array.from({ length: n }, () => `
          <div class="skeleton-card" aria-hidden="true" style="border-radius:var(--radius-lg);overflow:hidden;border:1px solid var(--border);animation:skeleton-pulse 1.15s ease-in-out infinite;">
            <div style="aspect-ratio:16/9;background:var(--surface2);"></div>
            <div style="padding:14px 16px;">
              <div style="height:13px;width:75%;border-radius:5px;background:var(--surface3);margin-bottom:10px;"></div>
              <div style="height:10px;width:50%;border-radius:4px;background:var(--surface3);margin-bottom:8px;"></div>
              <div style="display:flex;gap:5px;margin-bottom:12px;"><div style="height:18px;width:40px;border-radius:5px;background:var(--surface3);"></div><div style="height:18px;width:40px;border-radius:5px;background:var(--surface3);"></div></div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;"><div style="height:34px;border-radius:8px;background:var(--surface3);"></div><div style="height:34px;border-radius:8px;background:var(--surface3);"></div></div>
            </div>
          </div>`).join('');
      }
    }

    let videosPage = 1;
    let videosTotalPages = 1;

    // ─── Folder management ────────────────────────────────────────
    let _allFolders = [];
    let _currentFolderId = null; // null = all, 'none' = unfoldered

    async function loadFolders() {
      // Folders require a workspace — skip silently if none is selected
      if (!authWorkspace) { _allFolders = []; renderFoldersBar(); return; }
      try {
        const r = await apiFetch(`/api/folders`);
        if (!r.ok) { _allFolders = []; renderFoldersBar(); return; }
        _allFolders = await r.json();
      } catch { _allFolders = []; }
      renderFoldersBar();
    }

    function renderFoldersBar() {
      const bar = document.getElementById('folders-bar');
      if (!bar) return;
      // Populate toolbar folder select
      const folderSel = document.getElementById('library-filter-folder');
      if (folderSel) {
        if (!_allFolders.length) {
          folderSel.style.display = 'none';
        } else {
          folderSel.style.display = '';
          folderSel.innerHTML = '<option value="">Todas las carpetas</option>' +
            _allFolders.map(f => `<option value="${esc(f.id)}"${_currentFolderId === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
        }
      }
      if (!_allFolders.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const chips = _allFolders.map(f => `
        <button class="folder-chip${_currentFolderId === f.id ? ' active' : ''}"
          onclick="setCurrentFolder('${f.id}')" title="${esc(f.name)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          ${esc(f.name)}
          <span class="folder-chip-rename" onclick="event.stopPropagation();renameFolderPrompt('${f.id}','${escAttr(f.name)}')" title="Renombrar carpeta"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span>
          <span class="folder-chip-del" onclick="event.stopPropagation();deleteFolderConfirm('${f.id}','${escAttr(f.name)}')" title="Eliminar carpeta">×</span>
        </button>`).join('');
      bar.innerHTML = `
        <button class="folder-chip${_currentFolderId === null ? ' active' : ''}" onclick="setCurrentFolder(null)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          Todos los videos
        </button>
        ${chips}`;
    }

    function setCurrentFolder(id) {
      _currentFolderId = id;
      const sel = document.getElementById('library-filter-folder');
      if (sel) sel.value = id || '';
      renderFoldersBar();
      loadVideos(1);
    }

    function openCreateFolderModal() {
      document.getElementById('folder-create-name').value = '';
      openModal('create-folder-modal-overlay');
      setTimeout(() => document.getElementById('folder-create-name').focus(), 80);
    }

    async function submitCreateFolder() {
      const name = document.getElementById('folder-create-name').value.trim();
      if (!name) return toast('El nombre es requerido', 'error');
      try {
        const r = await apiFetch(`/api/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return toast(d.error || 'Error', 'error');
        closeModal('create-folder-modal-overlay');
        toast('Carpeta creada');
        await loadFolders();
        // Auto-select the newly created folder
        if (d.id) setCurrentFolder(d.id);
      } catch { toast('Error de conexión', 'error'); }
    }

    async function deleteFolderConfirm(id, name) {
      const ok = await confirmModal('¿Eliminar carpeta?', `Se eliminará "${name}". Los videos quedarán sin carpeta.`, 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      try {
        const r = await apiFetch(`/api/folders/${id}`, { method: 'DELETE' });
        if (!r.ok) return toast('Error al eliminar', 'error');
        if (_currentFolderId === id) _currentFolderId = null;
        toast('Carpeta eliminada');
        await loadFolders();
        loadVideos(1);
      } catch { toast('Error de conexión', 'error'); }
    }

    async function renameFolderPrompt(id, currentName) {
      const name = await promptModal('Renombrar carpeta', currentName, 'Nombre de la carpeta');
      if (!name || name === currentName) return;
      try {
        const r = await apiFetch(`/api/folders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        if (!r.ok) return toast('Error al renombrar', 'error');
        toast('Carpeta renombrada');
        await loadFolders();
      } catch { toast('Error de conexión', 'error'); }
    }

    async function moveVideoToFolder(videoId) { const title = (allVideosCache.find(x => x.id === videoId))?.title || '';
      const folderSel = document.getElementById('move-folder-select');
      document.getElementById('move-video-title').textContent = title;

      // Load folders first if not loaded yet (e.g. user opened modal before page loaded folders)
      if (!_allFolders.length && authWorkspace) {
        try {
          const r = await apiFetch(`/api/folders`);
          if (r.ok) _allFolders = await r.json();
        } catch {}
      }

      const folderList = _allFolders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
      folderSel.innerHTML = `<option value="">— Sin carpeta (raíz) —</option>${folderList}`;
      if (!_allFolders.length) {
        folderSel.innerHTML += `<option disabled>── No hay carpetas creadas ──</option>`;
      }
      buildSearchableSelect(folderSel);

      document.getElementById('move-folder-btn').onclick = async () => {
        const fid = folderSel.value || null;
        const btn = document.getElementById('move-folder-btn');
        btn.disabled = true; btn.textContent = 'Moviendo…';
        try {
          const r = await apiFetch(`/api/videos/${videoId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_id: fid }),
          });
          if (r.ok) {
            toast('Video movido correctamente');
            closeModal('move-folder-modal-overlay');
            loadVideos(videosPage);
            // Refresh folder bar in case the move changed counts
            loadFolders();
          } else {
            const d = await r.json().catch(() => ({}));
            toast(d.error || 'Error al mover el video', 'error');
          }
        } catch { toast('Error de conexión', 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Mover'; }
      };
      openModal('move-folder-modal-overlay');
    }

    let loadVideosInProgress = false;
    
    async function loadVideos(page = 1) {
      if (loadVideosInProgress) return;
      loadVideosInProgress = true;
      try {
        if (!pollInterval && page === 1 && !allVideosCache.length) renderVideoSkeletons(5);
        const q = document.getElementById('library-search')?.value?.trim() || '';
        const params = new URLSearchParams({ page, limit: _pageLimit });
        if (q) params.set('search', q);
        if (_currentFolderId !== null) params.set('folder_id', _currentFolderId);
        const tagF = document.getElementById('library-filter-tag')?.value || '';
        if (tagF) params.set('tag', tagF);
        const r = await apiFetch(`/api/videos?${params}`);
        if (!r.ok) throw new Error('failed');
        const json = await r.json();
        const list = json.videos || (Array.isArray(json) ? json : []);
        if (page === 1) {
          allVideosCache = list;
        } else {
          allVideosCache = [...allVideosCache, ...list];
        }
        videosPage = page;
        videosTotalPages = json.pagination?.pages || 1;
        refreshTagFilter();
        applyLibraryFilters();
        if (page === 1) {
          loadStats();
          const tb = document.getElementById('library-total-badge');
          if (tb) { const n = json.pagination?.total ?? allVideosCache.length; tb.textContent = n; tb.style.display = n ? '' : 'none'; }
        }
        const anyProc = allVideosCache.some(v => ['queued', 'transcoding'].includes(v.status));
        if (anyProc && !pollInterval) startPolling();
        else if (!anyProc && pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      } catch {
        // On network error: keep existing cache so in-progress videos don't disappear.
        // Only show the error state when there's nothing in cache to show.
        if (!allVideosCache.length) {
          document.getElementById('video-grid').innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon" style="background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.2);color:var(--red);box-shadow:0 0 0 10px rgba(248,113,113,.06);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/></svg></div><h3 style="color:var(--red);">Error de conexión</h3><p>No se pudo contactar el servidor. Intenta recargar.</p></div>`;
          document.getElementById('library-count-hint').textContent = '';
        }
      } finally {
        loadVideosInProgress = false;
      }
    }

    function loadMoreVideos() {
      if (videosPage < videosTotalPages) loadVideos(videosPage + 1);
    }

    function startPolling() {
      if (pollInterval) return;
      pollInterval = setInterval(loadVideos, 4000);
    }

    function stopPolling() {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }

    // When the tab comes back into focus after being idle/backgrounded, refresh immediately
    // so transcoding progress (and completion) is visible without requiring a manual reload.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const section = document.getElementById('section-videos');
        if (section && section.style.display !== 'none') loadVideos();
      }
    });

    function renderVideos(videos, opts = {}) {
      const grid = document.getElementById('video-grid');
      grid.className = _libView === 'list' ? 'video-grid list-view' : 'video-grid';
      const _canManage = authWorkspace?.role === 'owner' || authWorkspace?.role === 'admin';
      if (!videos.length) {
        grid.innerHTML = opts.filteredView && allVideosCache.length
          ? `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><h3>Sin coincidencias</h3><p>Prueba otro texto de búsqueda o cambia los filtros.</p></div>`
          : `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="5" width="15" height="14" rx="2"/><polygon points="23 7 16 12 23 17" fill="currentColor" stroke="none"/></svg></div><h3>Sin videos aún</h3><p>Sube tu primer video para empezar a compartir contenido.</p><button class="btn btn-primary btn-sm empty-state-cta" onclick="goSection(null,'upload')">Subir video</button></div>`;
        return;
      }

      // ── Table list view ─────────────────────────────────────────
      if (_libView === 'list') {
        const statusBadge = v => {
          const hasQ = Array.isArray(v.qualities) && v.qualities.length > 0;
          if (v.status === 'transcoding') {
            const pctStr = v.progress_pct != null ? ` ${v.progress_pct}%` : '';
            const label  = hasQ ? `Parcial${pctStr}` : `Procesando${pctStr}`;
            return `<div style="display:flex;flex-direction:column;gap:3px;">
              <span class="vt-status processing">${label}</span>
              ${v.progress_pct != null ? `<div style="height:3px;border-radius:2px;background:var(--surface3);overflow:hidden;width:80px;"><div style="height:100%;width:${v.progress_pct}%;background:var(--amber);border-radius:2px;transition:width .5s;"></div></div>` : ''}
            </div>`;
          }
          const map = {
            ready: ['ready','Listo'],
            error: ['error','Error'],
            queued: ['queued','En cola'],
            scheduled: ['queued','Programado'],
            processing: ['processing','Procesando'],
          };
          const [cls, lbl] = map[v.status] || ['queued', v.status];
          return `<span class="vt-status ${cls}">${lbl}</span>`;
        };
        // Build sort arrow helper
        const sortArrow = (field) => {
          const isActive = _libSortField === field;
          const arrow = isActive ? (_libSortDir === 'asc' ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>' : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>') : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/></svg>';
          return `<button class="vt-sort-btn${isActive ? ' active' : ''}" onclick="sortByColumn('${field}')">
            ${field === 'recent' ? 'Video' : field === 'views' ? 'Vistas' : field === 'size' ? 'Tamaño' : field === 'duration' ? 'Duración' : field}
            <span class="vt-sort-arrow">${arrow}</span>
          </button>`;
        };
        grid.innerHTML = `
          <table class="video-table">
            <thead>
              <tr>
                <th style="width:32px;padding-left:8px;"><input type="checkbox" id="vt-select-all" style="accent-color:var(--accent);cursor:pointer;width:14px;height:14px;" onchange="toggleSelectAll(this)"></th>
                <th style="width:auto;min-width:220px;">${sortArrow('recent')}</th>
                <th style="width:90px;">Slug</th>
                <th style="width:90px;">${sortArrow('duration')}</th>
                <th style="width:70px;">${sortArrow('views')}</th>
                <th style="width:90px;">${sortArrow('size')}</th>
                <th style="width:100px;">Creado</th>
                <th style="width:90px;">Estado</th>
                <th style="width:130px;">Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${videos.map(v => {
                const isReady = v.status === 'ready';
                const isPartial = v.status === 'transcoding' && Array.isArray(v.qualities) && v.qualities.length > 0;
                const canPlay = isReady || isPartial;
                const ts = v.updated_at || Date.now();
                const thumbSrc = (v.thumbnailUrl || `/videos/${v.id}/thumb.jpg`) + `?t=${ts}`;
                const slug = v.short_code || v.id.slice(0,8);
                return `<tr id="card-${v.id}">
                  <td style="padding-left:8px;"><input type="checkbox" class="vt-row-check" data-id="${v.id}" style="accent-color:var(--accent);cursor:pointer;width:14px;height:14px;" onchange="onRowCheckChange()"></td>
                  <td>
                    <div class="vt-name">
                      <div class="vt-thumb" ${canPlay ? `onclick="openVideoPreview('${v.id}')" title="Preview"` : ''}>
                        <img src="${thumbSrc}" alt="" loading="lazy" onerror="this.style.display='none'">
                        ${canPlay ? `<div class="vt-thumb-play"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>` : ''}
                      </div>
                      <div style="min-width:0;">
                        <span class="vt-title" title="${esc(v.title)}">${esc(v.title)}</span>
                        ${(v.tags||[]).length ? `<div class="video-tags">${(v.tags).map(t=>`<span class="video-tag-chip" onclick="filterByTag('${esc(t)}')">${esc(t)}</span>`).join('')}</div>` : ''}
                        ${v.expires_at ? expiryBadge(v.expires_at) : ''}
                      </div>
                    </div>
                  </td>
                  <td><span class="vt-slug">${esc(slug)}</span></td>
                  <td><span class="vt-duration">${v.duration ? formatDuration(v.duration) : '—'}</span></td>
                  <td style="font-family:var(--mono);font-size:12px;">${(v.views||0).toLocaleString()}</td>
                  <td style="font-family:var(--mono);font-size:12px;white-space:nowrap;">${v.size ? formatSize(v.size) : '—'}</td>
                  <td style="font-size:12px;white-space:nowrap;color:var(--muted);">${timeAgo(v.created_at)}</td>
                  <td>${statusBadge(v)}</td>
                  <td>
                    <div class="vt-actions">
                      ${canPlay ? `
                        <button class="vt-icon-btn" onclick="openVideoPreview('${v.id}')" title="Preview">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </button>
                        <a class="vt-icon-btn" href="${BASE}/watch/${v.id}" target="_blank" rel="noopener" title="Ver en watch page">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        </a>
                        ${isReady ? `<button class="vt-icon-btn" onclick="copyLink('${v.id}','embed')" title="Copiar embed">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        </button>` : ''}
                      ` : ''}
                      ${(authWorkspace?.role === 'owner' || authWorkspace?.role === 'admin') ? `
                      <button class="vt-icon-btn" onclick="openEditModal('${v.id}')" title="Editar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button class="vt-icon-btn danger" onclick="deleteVideo('${v.id}')" title="Eliminar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                      </button>` : ''}
                      <div class="more-wrap" id="more-lt-${v.id}" style="position:relative;">
                        <button class="vt-icon-btn" onclick="toggleMoreMenu('lt-${v.id}',event)" title="Más opciones">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                        </button>
                        <div class="more-menu" id="more-menu-lt-${v.id}" style="bottom:auto;top:calc(100% + 4px);left:auto;right:0;">
                          <button onclick="closeMoreMenu('lt-${v.id}');copyLink('${v.id}','watch')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                            Copiar link
                          </button>
                          ${v.short_code ? `<button onclick="closeMoreMenu('lt-${v.id}');copyLink('${v.id}','short')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                            Short link
                          </button>` : ''}
                          ${_cachedFeatures?.embedEnabled !== false ? `<button onclick="closeMoreMenu('lt-${v.id}');copyLink('${v.id}','embed')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                            Copiar embed
                          </button>` : ''}
                          ${_cachedFeatures?.downloadLinksEnabled !== false ? `<button onclick="closeMoreMenu('lt-${v.id}');window.open('${BASE}/download/${v.id}','_blank','noopener,noreferrer')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Página descarga
                          </button>` : ''}
                          <div class="more-menu-divider"></div>
                          ${_cachedFeatures?.foldersEnabled !== false ? `<button onclick="closeMoreMenu('lt-${v.id}');moveVideoToFolder('${v.id}')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                            Mover a carpeta
                          </button>` : ''}
                          ${_cachedFeatures?.playlistsEnabled !== false ? `<button onclick="closeMoreMenu('lt-${v.id}');openAddToPlaylistModal('${v.id}')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                            Añadir a playlist
                          </button>` : ''}
                          ${_cachedFeatures?.tracksEnabled !== false ? `<button onclick="closeMoreMenu('lt-${v.id}');openTracksModal('${v.id}')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                            Pistas y subtítulos
                          </button>` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`;
        // Pagination for list view — numeric + "Mostrando X-Y de Z"
        if (videosTotalPages > 1) {
          const prevDisabled = videosPage <= 1;
          const nextDisabled = videosPage >= videosTotalPages;
          const pageNums = buildPageNumbers(videosPage, videosTotalPages);
          const totalItems = allVideosCache.length;
          const startItem = (videosPage - 1) * _pageLimit + 1;
          const endItem = Math.min(videosPage * _pageLimit, totalItems);
          grid.insertAdjacentHTML('beforeend', `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 0;border-top:1px solid var(--border);margin-top:2px;flex-wrap:wrap;">
              <span class="pagination-info">Mostrando ${startItem}–${endItem} de ${totalItems} video${totalItems !== 1 ? 's' : ''}</span>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button class="btn btn-ghost" style="padding:6px 12px;font-size:13px;" onclick="loadVideos(${videosPage-1})" ${prevDisabled?'disabled style="opacity:0.4;cursor:not-allowed;"':''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>
                ${pageNums.map(p => p === '…'
                  ? `<span style="padding:6px 4px;font-size:13px;color:var(--muted);">…</span>`
                  : `<button class="btn ${p === videosPage ? 'btn-primary' : 'btn-ghost'}" style="padding:6px 11px;font-size:13px;min-width:34px;" onclick="loadVideos(${p})">${p}</button>`
                ).join('')}
                <button class="btn btn-ghost" style="padding:6px 12px;font-size:13px;" onclick="loadVideos(${videosPage+1})" ${nextDisabled?'disabled style="opacity:0.4;cursor:not-allowed;"':''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
              </div>
            </div>`);
        }
        return;
      }

      // ── Grid card view ───────────────────────────────────────────
      grid.innerHTML = videos.map(v => {
        const isReady = v.status === 'ready';
        const isError = v.status === 'error';
        const isProcessing = ['queued','transcoding'].includes(v.status);
        const isScheduled = v.status === 'scheduled';
        const isPartial = isProcessing && Array.isArray(v.qualities) && v.qualities.length > 0;
        const canPlay = isReady || isPartial;
        const ts = v.updated_at || Date.now();
        const thumbSrc = (v.thumbnailUrl || `/videos/${v.id}/thumb.jpg`) + `?t=${ts}`;

        // Status badge — pill style
        const _pill = (color, bg, icon, label) =>
          `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:99px;background:${bg};color:${color};font-size:10px;font-weight:700;letter-spacing:.2px;white-space:nowrap;flex-shrink:0;line-height:1.6;">${icon}${label}</span>`;
        const _dot = c => `<svg width="6" height="6" viewBox="0 0 12 12" fill="${c}"><circle cx="6" cy="6" r="6"/></svg>`;
        const statusLabel = {
          ready:       _pill('var(--green)',  'rgba(34,197,94,.13)',   _dot('var(--green)'),  'Listo'),
          transcoding: `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:99px;background:rgba(251,191,36,.12);color:var(--amber);font-size:10px;font-weight:700;white-space:nowrap;flex-shrink:0;line-height:1.6;"><span class="spinner" style="width:7px;height:7px;border-width:1.5px;border-color:var(--amber);border-top-color:transparent;"></span>${v.progress_pct != null ? v.progress_pct + '%' : 'Procesando'}</span>`,
          queued:      _pill('var(--accent2)','rgba(139,92,246,.12)',  _dot('var(--accent2)'),'En cola'),
          error:       _pill('var(--red)',    'rgba(239,68,68,.12)',   _dot('var(--red)'),    'Error'),
          scheduled:   _pill('#a78bfa',       'rgba(167,139,250,.12)', _dot('#a78bfa'),       'Programado'),
          downloading: _pill('var(--accent)', 'rgba(99,102,241,.12)',  _dot('var(--accent)'), 'Descargando'),
        }[v.status] || _pill('var(--muted)', 'var(--surface3)', '', v.status);

        return `
    <div class="video-card" id="card-${v.id}">
      <div class="video-thumb" ${canPlay ? `onclick="openVideoPreview('${v.id}')" style="cursor:pointer;" title="Click para previsualizar"` : ''}>
        ${canPlay
          ? `<img class="thumb-cover" src="${thumbSrc}" alt="" loading="lazy" onerror="this.style.display='none'">
             ${v.duration ? `<div class="video-duration-badge">${formatDuration(v.duration)}</div>` : ''}
             <div class="thumb-play-overlay" aria-hidden="true">
               <div style="width:48px;height:48px;border-radius:50%;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;">
                 <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>
               </div>
             </div>`
          : `<div class="thumb-placeholder">${
              isError
                ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.5" opacity=".8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
                : isProcessing
                ? '<span class="spinner"></span>'
                : isScheduled
                ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.5" opacity=".8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
                : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".25"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`
            }</div>`
        }
      </div>
      <div class="video-body">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:4px;">
          <div class="video-title" title="${esc(v.title)}">${esc(v.title)}</div>
          ${statusLabel}
        </div>
        ${isProcessing && v.progress_pct != null ? `<div style="margin:4px 0 6px;"><div style="height:3px;border-radius:2px;background:var(--surface3);overflow:hidden;"><div style="height:100%;width:${v.progress_pct}%;background:var(--amber);border-radius:2px;transition:width .5s ease;"></div></div><div style="font-size:10px;color:var(--amber);margin-top:3px;font-family:var(--mono);">${v.progress_pct}% completado</div></div>` : ''}
        <div class="video-meta">
          ${v.duration ? `<span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${formatDuration(v.duration)}</span>` : ''}
          ${v.size ? `<span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>${formatSize(v.size)}</span>` : ''}
          <span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${(v.views||0).toLocaleString()} vis.</span>
          <span>${timeAgo(v.created_at)}</span>
        </div>
        <div class="video-qualities">
          ${(v.qualities || []).map(q => `<span class="quality-pill">${q}</span>`).join('') || '<span style="color:var(--muted);font-size:12px;">—</span>'}
          ${v.visibility === 'private' ? `<span class="access-badge private"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Privado</span>` : ''}
          ${v.visibility === 'password' ? `<span class="access-badge password"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Clave</span>` : ''}
          ${v.ai_title ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(124,108,250,0.15);color:var(--accent2);border:1px solid rgba(124,108,250,0.25);" title="IA: ${esc(v.ai_title)}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a9 9 0 019 9c0 4.97-4.03 9-9 9S3 15.97 3 11a9 9 0 019-9z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> IA</span>` : ''}
          ${isScheduled && v.publish_at ? `<span style="font-size:10px;color:#a78bfa;font-weight:600;display:inline-flex;align-items:center;gap:2px;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${new Date(v.publish_at*1000).toLocaleDateString('es')}</span>` : ''}
          ${v.expires_at ? expiryBadge(v.expires_at) : ''}
        </div>
        ${(v.tags||[]).length ? `<div class="video-tags">${(v.tags).map(t=>`<span class="video-tag-chip" onclick="filterByTag('${esc(t)}')">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="video-actions">
          ${canPlay ? `
            <button class="action-btn" onclick="openVideoPreview('${v.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              ${isPartial ? 'Ver parcial' : 'Preview'}
            </button>
            ${_canManage ? `<button class="action-btn" onclick="openEditModal('${v.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Editar
            </button>` : ''}
            <div class="more-wrap" id="more-${v.id}">
              <button class="action-btn" onclick="toggleMoreMenu('${v.id}',event)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                Más
              </button>
              <div class="more-menu" id="more-menu-${v.id}">
                <button onclick="closeMoreMenu('${v.id}');copyLink('${v.id}','watch')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                  Copiar link
                </button>
                ${v.short_code ? `<button onclick="closeMoreMenu('${v.id}');copyLink('${v.id}','short')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                  Short link
                </button>` : ''}
                ${_cachedFeatures?.embedEnabled !== false ? `<button onclick="closeMoreMenu('${v.id}');copyLink('${v.id}','embed')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                  Copiar embed
                </button>` : ''}
                ${_cachedFeatures?.downloadLinksEnabled !== false ? `<button onclick="closeMoreMenu('${v.id}');window.open('${BASE}/download/${v.id}','_blank','noopener,noreferrer')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Página descarga
                </button>` : ''}
                <div class="more-menu-divider"></div>
                ${_cachedFeatures?.foldersEnabled !== false ? `<button onclick="closeMoreMenu('${v.id}');moveVideoToFolder('${v.id}')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                  Mover a carpeta
                </button>` : ''}
                ${_cachedFeatures?.playlistsEnabled !== false ? `<button onclick="closeMoreMenu('${v.id}');openAddToPlaylistModal('${v.id}')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                  Añadir a playlist
                </button>` : ''}
                ${_cachedFeatures?.tracksEnabled !== false ? `<button onclick="closeMoreMenu('${v.id}');openTracksModal('${v.id}')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  Pistas y subtítulos
                </button>` : ''}
                <div class="more-menu-divider"></div>
                ${_canManage ? `<button class="more-menu-danger" onclick="closeMoreMenu('${v.id}');deleteVideo('${v.id}')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                  Eliminar video
                </button>` : ''}
              </div>
            </div>
          ` : isError
          ? `${_canManage ? `<button class="action-btn" style="background:rgba(248,113,113,0.08);color:var(--red);border-color:rgba(248,113,113,0.25);" onclick="retryVideo('${v.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
              Reintentar transcodificación
            </button>
            <button class="action-btn" onclick="openEditModal('${v.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Editar
            </button>` : ''}`
          : isScheduled
          ? `${_canManage ? `<button class="action-btn" onclick="openEditModal('${v.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              Programado${v.publish_at ? ' · ' + new Date(v.publish_at*1000).toLocaleDateString('es') : ''}
            </button>` : ''}`
          : `<span style="font-size:12px;color:var(--muted);padding:6px 0;display:flex;align-items:center;gap:6px;"><span class="spinner"></span> ${isProcessing ? (v.progress_pct != null ? `Transcodificando… ${v.progress_pct}%` : 'Transcodificando…') : 'Procesando…'}</span>`}
        </div>
      </div>
    </div>`;}).join('');
      // Grid view pagination — numeric
      const totalPages = videosTotalPages;
      if (totalPages > 1) {
        const prevDisabled = videosPage <= 1;
        const nextDisabled = videosPage >= totalPages;
        const pageNums = buildPageNumbers(videosPage, totalPages);
        grid.insertAdjacentHTML('beforeend', `
          <div style="grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:6px;padding:20px 0;border-top:1px solid var(--border);margin-top:8px;flex-wrap:wrap;">
            <button class="btn btn-ghost" style="padding:6px 12px;font-size:13px;"
              onclick="loadVideos(${videosPage - 1})" ${prevDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>
            ${pageNums.map(p => p === '…'
              ? `<span style="padding:6px 4px;font-size:13px;color:var(--muted);">…</span>`
              : `<button class="btn ${p === videosPage ? 'btn-primary' : 'btn-ghost'}" style="padding:6px 11px;font-size:13px;min-width:34px;" onclick="loadVideos(${p})">${p}</button>`
            ).join('')}
            <button class="btn btn-ghost" style="padding:6px 12px;font-size:13px;"
              onclick="loadVideos(${videosPage + 1})" ${nextDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
          </div>`);
      }
    }

    // ─── Bulk select helpers ──────────────────────────────────────
    function toggleSelectAll(cb) {
      document.querySelectorAll('.vt-row-check').forEach(c => c.checked = cb.checked);
      updateBulkBar();
    }
    function onRowCheckChange() {
      const all = document.querySelectorAll('.vt-row-check');
      const checked = document.querySelectorAll('.vt-row-check:checked');
      const selectAll = document.getElementById('vt-select-all');
      if (selectAll) {
        selectAll.checked = checked.length === all.length && all.length > 0;
        selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
      }
      updateBulkBar();
    }
    function getSelectedVideoIds() {
      return [...document.querySelectorAll('.vt-row-check:checked')].map(c => c.dataset.id);
    }
    function updateBulkBar() {
      const ids = getSelectedVideoIds();
      const bar = document.getElementById('bulk-bar');
      const count = document.getElementById('bulk-bar-count');
      if (!bar) return;
      if (ids.length > 0) {
        bar.classList.add('visible');
        count.textContent = `${ids.length} video${ids.length !== 1 ? 's' : ''}`;
      } else {
        bar.classList.remove('visible');
      }
    }
    function clearBulkSelection() {
      document.querySelectorAll('.vt-row-check').forEach(c => c.checked = false);
      const sa = document.getElementById('vt-select-all');
      if (sa) { sa.checked = false; sa.indeterminate = false; }
      updateBulkBar();
    }
    async function bulkDelete() {
      const ids = getSelectedVideoIds();
      if (!ids.length) return;
      const ok = await confirmModal(`¿Eliminar ${ids.length} video${ids.length !== 1 ? 's' : ''}?`, 'Esta acción no se puede deshacer.', 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      const r = await apiFetch(`${BASE}/api/videos/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ids }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) toast(`${d.deleted ?? ids.length} video${ids.length !== 1 ? 's' : ''} eliminado${ids.length !== 1 ? 's' : ''}`);
      else toast(d.error || 'Error al eliminar', 'error');
      clearBulkSelection();
      loadVideos();
    }
    async function bulkMoveToFolder() {
      const ids = getSelectedVideoIds();
      if (!ids.length) return;
      const folderSel = document.getElementById('move-folder-select');
      document.getElementById('move-video-title').textContent = `${ids.length} ${ids.length === 1 ? 'video seleccionado' : 'videos seleccionados'}`;
      if (!_allFolders.length && authWorkspace) {
        try { const r = await apiFetch(`/api/folders`); if (r.ok) _allFolders = await r.json(); } catch {}
      }
      const folderList = _allFolders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
      folderSel.innerHTML = `<option value="">— Sin carpeta (raíz) —</option>${folderList}`;
      buildSearchableSelect(folderSel);
      document.getElementById('move-folder-btn').onclick = async () => {
        const fid = folderSel.value || null;
        const btn = document.getElementById('move-folder-btn');
        btn.disabled = true; btn.textContent = 'Moviendo…';
        const r = await apiFetch(`${BASE}/api/videos/bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'move', ids, folderId: fid }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok) toast(`${ids.length} video${ids.length !== 1 ? 's' : ''} movido${ids.length !== 1 ? 's' : ''}`);
        else toast(d.error || 'Error al mover', 'error');
        closeModal('move-folder-modal-overlay');
        clearBulkSelection();
        loadVideos(); loadFolders();
        btn.disabled = false; btn.textContent = 'Mover';
      };
      openModal('move-folder-modal-overlay');
    }
    async function bulkChangeVisibility() {
      const ids = getSelectedVideoIds();
      if (!ids.length) return;
      const vis = await visibilityModal(ids.length);
      if (!vis) return;
      let password = null;
      if (vis === 'password') {
        password = await promptModal('Contraseña de acceso', '', 'Contraseña para ver el video');
        if (password === null) return;
        if (!password) return toast('Debes ingresar una contraseña', 'error');
      }
      const body = { action: 'visibility', ids, visibility: vis };
      if (password) body.access_password = password;
      const r = await apiFetch(`${BASE}/api/videos/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) toast(`${ids.length} video${ids.length !== 1 ? 's' : ''} actualizado${ids.length !== 1 ? 's' : ''}`);
      else toast(d.error || 'Error al actualizar visibilidad', 'error');
      clearBulkSelection();
      loadVideos();
    }

    async function bulkAddToPlaylist() {
      const ids = getSelectedVideoIds();
      if (!ids.length) return;
      if (!_allPlaylists.length) {
        try { const r = await apiFetch(`${BASE}/api/playlists`); if (r.ok) _allPlaylists = await r.json(); } catch {}
      }
      const overlay = document.createElement('div');
      overlay.dataset.svOverlay = '1';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
      const opts = _allPlaylists.map(pl => `<option value="${esc(pl.id)}">${esc(pl.title)}</option>`).join('');
      overlay.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:400px;box-shadow:0 24px 80px rgba(0,0,0,.6);">
          <div style="padding:20px 24px 12px;display:flex;align-items:center;justify-content:space-between;">
            <h3 style="font-size:1.1rem;font-weight:700;">Añadir a Playlist</h3>
            <button class="btn btn-ghost" onclick="this.closest('[data-sv-overlay]').remove()" style="padding:4px 10px;font-size:18px;line-height:1;border-radius:8px;flex-shrink:0;" aria-label="Cerrar">×</button>
          </div>
          <div style="padding:0 24px 24px;">
            <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Añadiendo <strong style="color:var(--text);">${ids.length} video${ids.length !== 1 ? 's' : ''}</strong> seleccionado${ids.length !== 1 ? 's' : ''}</p>
            ${!opts ? `<p style="font-size:13px;color:var(--amber);">No tienes playlists. Crea una en la sección de Playlists primero.</p>` : `
              <select id="bulk-pl-select" style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:9px 12px;font-size:13px;font-family:var(--sans);outline:none;margin-bottom:16px;">
                <option value="">— Selecciona una playlist —</option>
                ${opts}
              </select>
              <button class="btn btn-primary" id="bulk-pl-add-btn" style="width:100%;" onclick="doBulkAddToPlaylist(${JSON.stringify(ids)},this.closest('[data-sv-overlay]'))">Añadir videos</button>
            `}
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    async function doBulkAddToPlaylist(ids, overlay) {
      const plId = overlay.querySelector('#bulk-pl-select')?.value;
      if (!plId) return toast('Selecciona una playlist', 'error');
      const btn = overlay.querySelector('.btn-primary');
      const ogText = btn.textContent; btn.textContent = 'Añadiendo…'; btn.disabled = true;
      let done = 0;
      for (const id of ids) {
        try {
          const r = await apiFetch(`${BASE}/api/playlists/${plId}/videos`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: id })
          });
          if (r.ok) done++;
        } catch {}
      }
      toast(`${done} video${done !== 1 ? 's' : ''} añadido${done !== 1 ? 's' : ''} a la playlist`);
      overlay.remove();
      clearBulkSelection();
      loadPlaylists();
    }
    function bulkOpenTracks() {
      const ids = getSelectedVideoIds();
      if (!ids.length) return;
      if (ids.length > 1) {
        toast('Selecciona un solo video para editar pistas y subtítulos', 'warn');
        return;
      }
      const videoEl = document.getElementById('card-' + ids[0]);
      const title = videoEl?.querySelector('.vt-title, .video-title')?.textContent?.trim() || ids[0];
      clearBulkSelection();
      openTracksModal(ids[0], title);
    }

    // ─── Search clear button ──────────────────────────────────────
    function debounceSearch() {
      const q = document.getElementById('library-search')?.value || '';
      const clearBtn = document.getElementById('search-clear-btn');
      if (clearBtn) clearBtn.classList.toggle('visible', q.length > 0);
      if (q && document.getElementById('section-videos')?.style.display === 'none') {
        showSection('videos');
      }
      applyLibraryFilters();
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => loadVideos(1), 400);
    }
    function clearSearch() {
      const inp = document.getElementById('library-search');
      if (inp) { inp.value = ''; inp.focus(); }
      const clearBtn = document.getElementById('search-clear-btn');
      if (clearBtn) clearBtn.classList.remove('visible');
      applyLibraryFilters();
      loadVideos(1);
    }

    function toggleMoreMenu(id, e) {
      e.stopPropagation();
      const menu = document.getElementById('more-menu-' + id);
      const isOpen = menu.classList.contains('open');
      document.querySelectorAll('.more-menu.open').forEach(m => { m.classList.remove('open'); m.style.top = ''; m.style.bottom = ''; m.style.left = ''; m.style.right = ''; });
      if (!isOpen) {
        // Position fixed menus relative to the trigger button
        const btn = e.currentTarget || e.target.closest('.vt-icon-btn') || e.target.closest('.action-btn');
        if (btn) {
          const rect = btn.getBoundingClientRect();
          const menuHeight = 280; // approximate max menu height
          const spaceBelow = window.innerHeight - rect.bottom;
          menu.style.right = (window.innerWidth - rect.right) + 'px';
          menu.style.left = 'auto';
          if (spaceBelow < menuHeight) {
            // Open upwards if not enough space below
            menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            menu.style.top = 'auto';
          } else {
            menu.style.top = (rect.bottom + 4) + 'px';
            menu.style.bottom = 'auto';
          }
        }
        menu.classList.add('open');
      }
    }
    function closeMoreMenu(id) {
      document.getElementById('more-menu-' + id)?.classList.remove('open');
    }
    document.addEventListener('click', () => {
      document.querySelectorAll('.more-menu.open').forEach(m => m.classList.remove('open'));
    });

    // ─── Video Preview Modal ──────────────────────────────────────
    let _previewVideoId = null;

    function openVideoPreview(videoId) {
      _previewVideoId = videoId;
      const v = allVideosCache.find(x => x.id === videoId);
      const title = v?.title || '';
      const watchUrl = `${BASE}/watch/${videoId}`;
      const iframeCode = `<iframe src="${BASE}/embed/${videoId}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen; picture-in-picture"></iframe>`;
      document.getElementById('preview-title').textContent = title;
      document.getElementById('preview-iframe').src = `${BASE}/player/${videoId}?preview=1`;
      document.getElementById('preview-iframe-code').value = iframeCode;
      document.getElementById('preview-link-input').value = watchUrl;
      const m3u8Url = v?.m3u8Url || (v?.hls_cdn_url) || `${BASE}/videos/${videoId}/master.m3u8`;
      document.getElementById('preview-m3u8-input').value = m3u8Url;
      const openLink = document.getElementById('preview-open-link');
      if (openLink) openLink.href = watchUrl;
      document.getElementById('preview-modal-overlay').classList.add('visible');
      document.addEventListener('keydown', _previewKeyHandler);
    }

    function closePreview() {
      _previewVideoId = null;
      document.getElementById('preview-modal-overlay').classList.remove('visible');
      document.getElementById('preview-iframe').src = '';
      document.removeEventListener('keydown', _previewKeyHandler);
    }

    function _previewKeyHandler(e) {
      if (e.key === 'Escape') closePreview();
    }

    function copyPreviewLink() {
      if (!_previewVideoId) return;
      navigator.clipboard.writeText(`${BASE}/watch/${_previewVideoId}`).then(() => toast('Link copiado'));
    }

    function copyPreviewIframe() {
      const el = document.getElementById('preview-iframe-code');
      if (el) navigator.clipboard.writeText(el.value).then(() => toast('Iframe copiado'));
    }

    function openPreviewInFull() {
      if (!_previewVideoId) return;
      window.open(`${BASE}/watch/${_previewVideoId}`, '_blank', 'noopener,noreferrer');
    }

    function copyLink(id, type) {
      const v = (allVideosCache || []).find(x => x.id === id);
      if (type === 'embed') {
        const src = `${BASE}/embed/${id}`;
        const code = `<iframe src="${src}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`;
        navigator.clipboard.writeText(code).then(() => toast('Código embed copiado'));
        return;
      }
      if (type === 'short') {
        const url = v?.short_code ? `${BASE}/v/${v.short_code}` : `${BASE}/watch/${id}`;
        navigator.clipboard.writeText(url).then(() => toast('Short link copiado'));
        return;
      }
      const m3u8 = v?.m3u8Url && (v.m3u8Url.startsWith('http') || v.m3u8Url.startsWith('//'))
        ? v.m3u8Url
        : `${BASE}/videos/${id}/master.m3u8`;
      const url = type === 'm3u8' ? m3u8 : `${BASE}/watch/${id}`;
      navigator.clipboard.writeText(url).then(() => toast(`${type === 'm3u8' ? 'HLS .m3u8' : 'Link'} copiado`));
    }

    async function deleteVideo(id) { const title = (allVideosCache.find(x => x.id === id))?.title || 'este video';
      const ok = await confirmModal('¿Eliminar video?', `¿Estás seguro de que deseas eliminar "${title}"? Esta acción no se puede deshacer.`, 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      const r = await apiFetch(`/api/videos/${id}`, { method: 'DELETE' });
      if (r.ok) { toast('Video eliminado'); loadVideos(); }
      else toast('Error al eliminar', 'error');
    }

    // F0.8: Retry failed transcoding job
    async function retryVideo(id) {
      const r = await apiFetch(`/api/videos/${id}/retry`, { method: 'POST' });
      if (r.ok) {
        toast('Transcodificación reintentada');
        loadVideos();
        startPolling();
      } else {
        const d = await r.json().catch(() => ({}));
        toast(d.error || 'Error al reintentar', 'error');
      }
    }

    // ─── Custom Modals Logic ──────────────────────────────────────
    function openModal(id) { document.getElementById(id).classList.add('visible'); }
    function closeModal(id) { document.getElementById(id).classList.remove('visible'); }

    function confirmModal(title, text, okLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false) {
      return new Promise((resolve) => {
        const overlay = document.getElementById('confirm-modal-overlay');
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-text').textContent = text;
        const okBtn = document.getElementById('confirm-modal-ok-btn');
        const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
        okBtn.textContent = okLabel;
        cancelBtn.textContent = cancelLabel;
        okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const cleanup = () => {
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          closeModal('confirm-modal-overlay');
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        openModal('confirm-modal-overlay');
      });
    }

    function promptModal(title, defaultValue = '', placeholder = '', desc = '') {
      return new Promise((resolve) => {
        document.getElementById('prompt-modal-title').textContent = title;
        const inp = document.getElementById('prompt-modal-input');
        inp.value = defaultValue;
        inp.placeholder = placeholder;
        const descEl = document.getElementById('prompt-modal-desc');
        if (desc) { descEl.textContent = desc; descEl.style.display = 'block'; }
        else { descEl.style.display = 'none'; }
        const okBtn = document.getElementById('prompt-modal-ok-btn');
        const cancelBtn = document.getElementById('prompt-modal-cancel-btn');

        const onOk = () => { const v = inp.value.trim(); cleanup(); resolve(v); }; // '' if empty; null only for cancel
        const onCancel = () => { cleanup(); resolve(null); };
        const cleanup = () => {
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          closeModal('prompt-modal-overlay');
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        openModal('prompt-modal-overlay');
        setTimeout(() => inp.focus(), 80);
      });
    }

    function visibilityModal(count) {
      return new Promise((resolve) => {
        document.getElementById('visibility-modal-desc').textContent =
          `Selecciona la visibilidad que se aplicará a ${count} video${count !== 1 ? 's' : ''} seleccionado${count !== 1 ? 's' : ''}.`;
        // Reset selection to public
        document.querySelectorAll('[name="vis-choice"]').forEach(r => { r.checked = r.value === 'public'; });
        // Update border highlight on change
        const updateHighlight = () => {
          ['public','private','password'].forEach(v => {
            const lbl = document.getElementById('vis-opt-' + v);
            const checked = document.querySelector(`[name="vis-choice"][value="${v}"]`)?.checked;
            lbl.style.borderColor = checked ? 'var(--accent)' : '';
            lbl.style.background = checked ? 'rgba(124,108,250,0.06)' : '';
          });
        };
        document.querySelectorAll('[name="vis-choice"]').forEach(r => r.addEventListener('change', updateHighlight));
        updateHighlight();
        const okBtn = document.getElementById('visibility-modal-ok-btn');
        const onOk = () => {
          const chosen = document.querySelector('[name="vis-choice"]:checked')?.value || null;
          cleanup(); resolve(chosen);
        };
        const onCancel = () => { cleanup(); resolve(null); };
        const cleanup = () => {
          okBtn.removeEventListener('click', onOk);
          document.querySelectorAll('[name="vis-choice"]').forEach(r => r.removeEventListener('change', updateHighlight));
          closeModal('visibility-modal-overlay');
        };
        okBtn.addEventListener('click', onOk);
        // Wire cancel button via onclick in HTML, but also resolve null on backdrop click
        const ovEl = document.getElementById('visibility-modal-overlay');
        const onBackdrop = (e) => { if (e.target === ovEl) { cleanup(); resolve(null); } };
        ovEl.addEventListener('click', onBackdrop, { once: true });
        openModal('visibility-modal-overlay');
      });
    }

    function onVisibilityChange() {
      const vis = document.getElementById('edit-visibility').value;
      const pwGroup = document.getElementById('edit-password-group');
      pwGroup.style.display = vis === 'password' ? 'block' : 'none';
      if (vis !== 'password') document.getElementById('edit-access-password').value = '';
    }
    // Placeholder — overridden below with full version including intro/outro, publish_at, AI, and thumbnail reset
    async function openEditModal(id) {
      // This initial definition will be overridden by the complete version below.
      // If for some reason the override hasn't loaded yet, provide a basic fallback:
      const video = allVideosCache.find(v => v.id === id);
      if (!video) return;
      document.getElementById('edit-video-title').value = video.title || '';
      document.getElementById('edit-video-desc').value = video.description || '';
      const visSelect = document.getElementById('edit-visibility');
      visSelect.value = video.visibility || 'public';
      onVisibilityChange();
      document.getElementById('edit-access-password').value = '';
      // Reset thumbnail file input and preview
      const thumbInput = document.getElementById('edit-thumb-file');
      if (thumbInput) thumbInput.value = '';
      const thumbPreview = document.getElementById('edit-thumb-preview');
      if (thumbPreview) { thumbPreview.style.display = 'none'; thumbPreview.src = ''; }
      openModal('edit-modal-overlay');
    }

    // ─── AI Suggestions helpers ──────────────────────────────────
    function applyAiTitle() {
      const text = document.getElementById('ai-title-text').textContent;
      if (text) document.getElementById('edit-video-title').value = text;
      toast('Título IA aplicado');
    }
    function applyAiDesc() {
      const text = document.getElementById('ai-desc-text').textContent;
      if (text) document.getElementById('edit-video-desc').value = text;
      toast('Descripción IA aplicada');
    }

    // ─── Thumbnail preview ───────────────────────────────────────
    function previewThumb(input) {
      const file = input.files[0];
      if (!file) return;
      const preview = document.getElementById('edit-thumb-preview');
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
      // Also update the larger current preview
      document.getElementById('edit-thumb-current').src = preview.src;
    }

    function updateEditThumbUI(videoId) {
      const cur = document.getElementById('edit-thumb-current');
      if (cur) {
        const ts = Date.now();
        cur.src = `/videos/${videoId}/thumb.jpg?_=${ts}`;
        cur.onerror = () => { cur.style.opacity = '0.3'; };
        cur.onload  = () => { cur.style.opacity = '1'; };
      }
      const tmdbBtn = document.getElementById('edit-thumb-tmdb-btn');
      if (tmdbBtn) {
        const hasTmdb = !!(document.getElementById('edit-tmdb-id')?.value.trim());
        tmdbBtn.style.display = hasTmdb ? '' : 'none';
      }
    }

    async function deleteVideoThumb() {
      if (!_editModalVideoId) return;
      const btn = document.getElementById('edit-thumb-delete-btn');
      btn.disabled = true; btn.textContent = 'Regenerando…';
      try {
        const r = await apiFetch(`/api/videos/${_editModalVideoId}/thumbnail`, { method: 'DELETE' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Error', 'error'); return; }
        toast('Miniatura restaurada');
        updateEditThumbUI(_editModalVideoId);
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg> Eliminar'; }
    }

    async function setThumbFromTmdb() {
      if (!_editModalVideoId) return;
      const tmdbId   = document.getElementById('edit-tmdb-id')?.value.trim();
      const tmdbType = document.getElementById('edit-tmdb-type')?.value || 'movie';
      if (!tmdbId) return toast('Primero ingresa un ID de TMDB', 'error');
      const btn = document.getElementById('edit-thumb-tmdb-btn');
      btn.disabled = true; btn.textContent = 'Descargando…';
      try {
        const r = await apiFetch(`/api/videos/${_editModalVideoId}/thumbnail/tmdb`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdb_id: tmdbId, tmdb_type: tmdbType })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Error al obtener poster', 'error'); return; }
        toast('Poster de TMDB aplicado');
        updateEditThumbUI(_editModalVideoId);
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> Poster TMDB'; }
    }

    // ─── Tracks modal ────────────────────────────────────────────
    let _tracksVideoId = null;

    async function openTracksModal(videoId) { const title = (allVideosCache.find(x => x.id === videoId))?.title || '';
      _tracksVideoId = videoId;
      document.querySelector('#tracks-modal-overlay .modal-head h3').textContent = `Pistas — ${title}`;
      // Reset subtitle tab fields
      const subFile = document.getElementById('track-sub-file');
      if (subFile) subFile.value = '';
      const subLang = document.getElementById('track-sub-language');
      if (subLang) subLang.value = 'es';
      const subLabel = document.getElementById('track-sub-label');
      if (subLabel) subLabel.value = '';
      const subDefault = document.getElementById('track-sub-default');
      if (subDefault) subDefault.checked = false;
      // Reset audio tab fields
      const audFile = document.getElementById('track-aud-file');
      if (audFile) audFile.value = '';
      const audLang = document.getElementById('track-aud-language');
      if (audLang) audLang.value = 'es';
      const audLabel = document.getElementById('track-aud-label');
      if (audLabel) audLabel.value = '';
      const audDefault = document.getElementById('track-aud-default');
      if (audDefault) audDefault.checked = false;
      // Reset file chips and drop zones
      clearTrackFile('sub');
      clearTrackFile('aud');
      // Reset "other language" fields
      const subOtherWrap = document.getElementById('track-sub-lang-other-wrap');
      if (subOtherWrap) subOtherWrap.style.display = 'none';
      const audOtherWrap = document.getElementById('track-aud-lang-other-wrap');
      if (audOtherWrap) audOtherWrap.style.display = 'none';
      // Reset to subtitle tab
      switchTrackTab('subtitle');
      await loadTracks();
      openModal('tracks-modal-overlay');
    }

    // ─── Track tab switcher ───────────────────────────────────────
    function switchTrackTab(tab) {
      const isSubtitle = tab === 'subtitle';
      const subContent = document.getElementById('track-content-subtitle');
      const audContent = document.getElementById('track-content-audio');
      const subTab = document.getElementById('track-tab-subtitle');
      const audTab = document.getElementById('track-tab-audio');
      // Use modal-tab-panel classes
      if (subContent) { subContent.classList.toggle('active', isSubtitle); subContent.style.display = isSubtitle ? 'block' : 'none'; }
      if (audContent) { audContent.classList.toggle('active', !isSubtitle); audContent.style.display = isSubtitle ? 'none' : 'block'; }
      if (subTab) subTab.classList.toggle('active', isSubtitle);
      if (audTab) audTab.classList.toggle('active', !isSubtitle);
    }

    // ─── Language "other" toggle ──────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
      initImpersonationBanner();
      // Subtitle language select
      document.getElementById('track-sub-language')?.addEventListener('change', function() {
        const wrap = document.getElementById('track-sub-lang-other-wrap');
        if (wrap) wrap.style.display = this.value === 'other' ? 'block' : 'none';
      });
      // Audio language select
      document.getElementById('track-aud-language')?.addEventListener('change', function() {
        const wrap = document.getElementById('track-aud-lang-other-wrap');
        if (wrap) wrap.style.display = this.value === 'other' ? 'block' : 'none';
      });
    });

    // ─── File Drop Zone helpers ───────────────────────────────────
    function handleTrackFileSelect(input, kind) {
      const file = input.files[0];
      if (!file) return;
      const chipId = `track-${kind}-file-chip`;
      const dropId = `track-${kind}-dropzone`;
      const chipEl = document.getElementById(chipId);
      const dropEl = document.getElementById(dropId);
      if (chipEl) {
        chipEl.style.display = 'block';
        chipEl.innerHTML = `<div class="file-chip">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent2)" stroke-width="2" style="flex-shrink:0;">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="file-chip-name">${esc(file.name)}</span>
          <span class="file-chip-size">${formatSize(file.size)}</span>
          <button class="file-chip-remove" onclick="clearTrackFile('${kind}')" title="Quitar archivo">×</button>
        </div>`;
      }
      if (dropEl) dropEl.classList.add('has-file');
      // Hide default drop zone content
      const dzIcon  = dropEl?.querySelector('.fdz-icon');
      const dzText  = dropEl?.querySelector('.fdz-text');
      const dzSub   = dropEl?.querySelector('.fdz-sub');
      if (dzIcon) dzIcon.style.display = 'none';
      if (dzText) dzText.style.display = 'none';
      if (dzSub)  dzSub.style.display  = 'none';
    }

    function handleTrackFileDrop(event, kind) {
      event.preventDefault();
      const dropEl = document.getElementById(`track-${kind}-dropzone`);
      dropEl?.classList.remove('drag-over');
      const file = event.dataTransfer.files[0];
      if (!file) return;
      const inputId = `track-${kind}-file`;
      const input = document.getElementById(inputId);
      if (input) {
        // Set file on the input using DataTransfer
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      }
      handleTrackFileSelect({ files: [file] }, kind);
    }

    function clearTrackFile(kind) {
      const input = document.getElementById(`track-${kind}-file`);
      const chipEl = document.getElementById(`track-${kind}-file-chip`);
      const dropEl = document.getElementById(`track-${kind}-dropzone`);
      if (input) input.value = '';
      if (chipEl) { chipEl.style.display = 'none'; chipEl.innerHTML = ''; }
      if (dropEl) {
        dropEl.classList.remove('has-file');
        const dzIcon = dropEl.querySelector('.fdz-icon');
        const dzText = dropEl.querySelector('.fdz-text');
        const dzSub  = dropEl.querySelector('.fdz-sub');
        if (dzIcon) dzIcon.style.display = '';
        if (dzText) dzText.style.display = '';
        if (dzSub)  dzSub.style.display  = '';
      }
    }

    // ─── Upload subtitle (tab: subtítulos) ───────────────────────
    async function uploadSubtitle() {
      const file = document.getElementById('track-sub-file')?.files[0];
      if (!file) return toast('Selecciona un archivo SRT o VTT primero', 'error');
      let language = document.getElementById('track-sub-language')?.value || 'es';
      if (language === 'other') {
        language = document.getElementById('track-sub-lang-other')?.value.trim() || 'und';
        if (!language || language.length < 2) return toast('Introduce un código de idioma válido (mín. 2 letras)', 'error');
      }
      const label     = document.getElementById('track-sub-label')?.value.trim() || language;
      const isDefault = document.getElementById('track-sub-default')?.checked ? '1' : '0';
      const btn  = document.querySelector('#track-content-subtitle .btn-primary');
      const spin = document.getElementById('track-sub-spin');
      const txt  = document.getElementById('track-sub-btn-text');
      if (btn) btn.disabled = true;
      if (spin) spin.style.display = 'block';
      if (txt)  txt.textContent = 'Subiendo…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('kind', 'subtitles');
        fd.append('language', language);
        fd.append('label', label);
        fd.append('default', isDefault);
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks`, { method: 'POST', body: fd });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          toast(err.error || 'Error al subir subtítulo', 'error');
        } else {
          toast('Subtítulo agregado');
          const subFile = document.getElementById('track-sub-file');
          if (subFile) subFile.value = '';
          const subLabel = document.getElementById('track-sub-label');
          if (subLabel) subLabel.value = '';
          await loadTracks();
        }
      } catch { toast('Error de conexión', 'error'); }
      finally {
        if (btn)  btn.disabled = false;
        if (spin) spin.style.display = 'none';
        if (txt)  txt.textContent = 'Subir subtítulo';
      }
    }

    // ─── Upload audio track (tab: audio) ─────────────────────────
    async function uploadAudio() {
      const file = document.getElementById('track-aud-file')?.files[0];
      if (!file) return toast('Selecciona un archivo de audio primero', 'error');
      let language = document.getElementById('track-aud-language')?.value || 'es';
      if (language === 'other') {
        language = document.getElementById('track-aud-lang-other')?.value.trim() || 'und';
        if (!language || language.length < 2) return toast('Introduce un código de idioma válido (mín. 2 letras)', 'error');
      }
      const label     = document.getElementById('track-aud-label')?.value.trim() || language;
      const isDefault = document.getElementById('track-aud-default')?.checked ? '1' : '0';
      const btn  = document.querySelector('#track-content-audio .btn-primary');
      const spin = document.getElementById('track-aud-spin');
      const txt  = document.getElementById('track-aud-btn-text');
      if (btn) btn.disabled = true;
      if (spin) spin.style.display = 'block';
      if (txt)  txt.textContent = 'Subiendo…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('kind', 'audio');
        fd.append('language', language);
        fd.append('label', label);
        fd.append('default', isDefault);
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks`, { method: 'POST', body: fd });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          toast(err.error || 'Error al subir audio', 'error');
        } else {
          toast('Pista de audio agregada');
          const audFile = document.getElementById('track-aud-file');
          if (audFile) audFile.value = '';
          const audLabel = document.getElementById('track-aud-label');
          if (audLabel) audLabel.value = '';
          await loadTracks();
        }
      } catch { toast('Error de conexión', 'error'); }
      finally {
        if (btn)  btn.disabled = false;
        if (spin) spin.style.display = 'none';
        if (txt)  txt.textContent = 'Subir audio';
      }
    }

    async function loadTracks() {
      const list = document.getElementById('tracks-list');
      list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Cargando...</p>';
      try {
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks`);
        const tracks = await r.json();
        if (!tracks.length) {
          list.innerHTML = '<p style="font-size:13px;color:var(--muted);">No hay pistas aún. Agrega subtítulos o audio adicional.</p>';
          return;
        }
        list.innerHTML = tracks.map(t => {
          const kindIcon = t.kind === 'audio'
            ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
            : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`;
          const kindColor = t.kind === 'audio' ? 'rgba(124,108,250,0.15)' : 'rgba(34,211,165,0.12)';
          const kindStroke = t.kind === 'audio' ? 'var(--accent2)' : 'var(--green)';
          const defaultBadge = t.default_track
            ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:99px;background:rgba(34,211,165,0.12);color:var(--green);border:1px solid rgba(34,211,165,0.2);">DEFAULT</span>`
            : '';
          return `<div id="track-row-${t.id}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:10px;border:1px solid var(--border2);margin-bottom:8px;">
            <div style="width:34px;height:34px;border-radius:8px;background:${kindColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${kindStroke};margin-top:1px;">
              ${kindIcon}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap;">
                <span style="font-size:13px;font-weight:600;color:var(--text);">${esc(t.label || t.language)}</span>
                <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:var(--surface3);color:var(--muted);font-family:var(--mono);">${t.language.toUpperCase()}</span>
                <span style="font-size:10px;color:var(--muted);">${t.kind === 'audio' ? 'Audio' : 'Subtítulos'} · ${(t.format||'').toUpperCase()}</span>
                ${defaultBadge}
              </div>
              <!-- Inline edit row -->
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;">
                <input id="track-label-${t.id}" type="text" value="${esc(t.label || t.language)}"
                  style="background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;font-family:var(--sans);outline:none;width:160px;transition:border-color .15s;"
                  onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border2)'"
                  onkeydown="if(event.key==='Enter')saveTrackLabel('${t.id}')">
                <button onclick="saveTrackLabel('${t.id}')"
                  style="background:var(--surface3);border:1px solid var(--border2);border-radius:6px;color:var(--text2);padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .12s;"
                  onmouseover="this.style.background='var(--surface4)'" onmouseout="this.style.background='var(--surface3)'">
                  Guardar
                </button>
                ${!t.default_track ? `<button onclick="setTrackDefault('${t.id}','${t.kind}')"
                  style="background:rgba(34,211,165,0.08);border:1px solid rgba(34,211,165,0.2);border-radius:6px;color:var(--green);padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .12s;"
                  onmouseover="this.style.background='rgba(34,211,165,0.15)'" onmouseout="this.style.background='rgba(34,211,165,0.08)'">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" style="vertical-align:middle;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Predeterminada
                </button>` : ''}
              </div>
            </div>
            <button onclick="deleteTrack('${t.id}')"
              style="background:none;border:none;color:var(--muted);cursor:pointer;padding:4px;border-radius:6px;transition:color .12s,background .12s;flex-shrink:0;"
              onmouseover="this.style.color='var(--red)';this.style.background='rgba(248,113,113,0.08)'"
              onmouseout="this.style.color='var(--muted)';this.style.background='none'"
              title="Eliminar pista">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>`;
        }).join('');
      } catch {
        list.innerHTML = '<p style="font-size:13px;color:var(--red);">Error cargando pistas</p>';
      }
    }

    async function saveTrackLabel(trackId) {
      const input = document.getElementById(`track-label-${trackId}`);
      const label = input?.value?.trim();
      if (!label) return toast('El nombre no puede estar vacío', 'error');
      try {
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks/${trackId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label }),
        });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); return; }
        toast('Nombre actualizado');
        await loadTracks();
      } catch { toast('Error de conexión', 'error'); }
    }

    async function setTrackDefault(trackId, kind) {
      try {
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks/${trackId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ default: true }),
        });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); return; }
        toast(`Pista marcada como predeterminada`);
        await loadTracks();
      } catch { toast('Error de conexión', 'error'); }
    }

    async function rebuildTracksPlaylist() {
      if (!_tracksVideoId) return;
      const btn = document.getElementById('rebuild-playlist-btn');
      if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
      try {
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks/rebuild-playlist`, { method: 'POST' });
        if (r.ok) toast('Playlist reconstruida — recarga el player');
        else { const d = await r.json(); toast(d.error || 'Error al reconstruir', 'error'); }
      } catch { toast('Error de conexión', 'error'); }
      finally { if (btn) { btn.disabled = false; btn.style.opacity = ''; } }
    }

    async function uploadTrack() {
      const file = document.getElementById('track-file').files[0];
      if (!file) return toast('Selecciona un archivo primero', 'error');
      const kind     = document.getElementById('track-kind').value;
      const language = document.getElementById('track-language').value.trim() || 'und';
      const label    = document.getElementById('track-label').value.trim() || language;
      const isDefault = document.getElementById('track-default').checked ? '1' : '0';

      const btn  = document.getElementById('track-upload-btn');
      const spin = document.getElementById('track-spin');
      const txt  = document.getElementById('track-btn-text');
      btn.disabled = true; spin.style.display = 'block'; txt.textContent = 'Subiendo…';

      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('kind', kind);
        fd.append('language', language);
        fd.append('label', label);
        fd.append('default', isDefault);
        const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks`, { method: 'POST', body: fd });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          toast(err.error || 'Error al subir', 'error');
        } else {
          toast('Pista agregada');
          document.getElementById('track-file').value = '';
          await loadTracks();
        }
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; spin.style.display = 'none'; txt.textContent = 'Subir pista'; }
    }

    async function deleteTrack(trackId) {
      const ok = await confirmModal('¿Eliminar pista?', 'Se eliminará esta pista de audio/subtítulos.', 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      const r = await apiFetch(`/api/videos/${_tracksVideoId}/tracks/${trackId}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(d.error || 'Error al eliminar pista', 'error'); }
      toast('Pista eliminada');
      loadTracks();
    }

    // ─── Chapters ────────────────────────────────────────────────
    let _chaptersVideoId = null;
    let _chaptersDuration = 0;
    const MAX_CHAPTERS = 5;

    function _updateChapterFormLimit(count) {
      const form = document.getElementById('ch-add-form');
      const msg  = document.getElementById('ch-limit-msg');
      if (!form || !msg) return;
      const atLimit = count >= MAX_CHAPTERS;
      form.style.display = atLimit ? 'none' : '';
      msg.style.display  = atLimit ? '' : 'none';
    }

    function secsToHms(s) {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
      if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
      return `${m}:${String(sec).padStart(2,'0')}`;
    }

    async function openChaptersModal(videoId, title, duration) {
      _chaptersVideoId = videoId;
      _chaptersDuration = duration || 0;
      document.getElementById('chapters-modal-title').textContent = `Capítulos — ${title}`;
      document.getElementById('ch-title-input').value = '';
      document.getElementById('ch-start-input').value = '';
      await loadChapters();
      openModal('chapters-modal-overlay');
    }

    async function loadChapters() {
      const list = document.getElementById('chapters-list');
      list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Cargando…</p>';
      try {
        const r = await apiFetch(`${BASE}/api/videos/${_chaptersVideoId}/chapters`);
        if (!r.ok) { list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Error cargando capítulos.</p>'; return; }
        const chapters = await r.json();
        if (!chapters.length) {
          list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Sin capítulos. Añade el primero abajo.</p>';
          _updateChapterFormLimit(0);
          return;
        }
        list.innerHTML = chapters.map(ch =>
          `<div class="ch-row" data-ch-id="${ch.id}" draggable="true"
            style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border2);cursor:grab;transition:opacity .15s,background .15s;">
            <svg style="flex-shrink:0;color:var(--muted);cursor:grab;" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="1" fill="currentColor"/><circle cx="15" cy="7" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="17" r="1" fill="currentColor"/><circle cx="15" cy="17" r="1" fill="currentColor"/></svg>
            <span style="font-size:11px;font-weight:700;color:var(--accent2);min-width:42px;font-variant-numeric:tabular-nums;">${secsToHms(ch.start_time)}</span>
            <span id="ch-label-${ch.id}" style="flex:1;font-size:13px;">${esc(ch.title)}</span>
            <button onclick="editChapterInline('${ch.id}','${escAttr(ch.title)}',${ch.start_time})"
              style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;padding:4px 6px;" title="Editar"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button onclick="deleteChapter('${ch.id}')"
              style="background:none;border:none;cursor:pointer;color:var(--red);font-size:16px;line-height:1;padding:4px 6px;" title="Eliminar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>`
        ).join('');
        initChaptersDrag(list);
        _updateChapterFormLimit(chapters.length);
      } catch { list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Error de conexión.</p>'; }
    }

    function initChaptersDrag(list) {
      let dragSrc = null;
      list.querySelectorAll('.ch-row').forEach(row => {
        row.addEventListener('dragstart', e => {
          dragSrc = row;
          row.style.opacity = '0.4';
          e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => { row.style.opacity = ''; });
        row.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (row !== dragSrc) row.style.background = 'var(--surface3)';
        });
        row.addEventListener('dragleave', () => { row.style.background = ''; });
        row.addEventListener('drop', async e => {
          e.preventDefault();
          row.style.background = '';
          if (!dragSrc || dragSrc === row) return;
          const rows = [...list.querySelectorAll('.ch-row')];
          const srcIdx = rows.indexOf(dragSrc);
          const dstIdx = rows.indexOf(row);
          if (srcIdx < dstIdx) row.after(dragSrc); else row.before(dragSrc);
          const newIds = [...list.querySelectorAll('.ch-row')].map(r => r.dataset.chId);
          try {
            await apiFetch(`${BASE}/api/videos/${_chaptersVideoId}/chapters/reorder`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: newIds }),
            });
          } catch { toast('Error guardando orden', 'error'); loadChapters(); }
        });
      });
    }

    async function addChapter() {
      const currentCount = document.querySelectorAll('#chapters-list .ch-row').length;
      if (currentCount >= MAX_CHAPTERS) { toast(`Límite de ${MAX_CHAPTERS} capítulos alcanzado`, 'error'); return; }
      const title = document.getElementById('ch-title-input').value.trim();
      const start = document.getElementById('ch-start-input').value;
      if (!title) { toast('Introduce un título para el capítulo', 'error'); return; }
      if (start === '' || isNaN(Number(start)) || Number(start) < 0) { toast('Introduce un tiempo de inicio válido', 'error'); return; }
      const btn = document.getElementById('ch-add-btn');
      btn.disabled = true; btn.textContent = 'Añadiendo…';
      try {
        const r = await apiFetch(`${BASE}/api/videos/${_chaptersVideoId}/chapters`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, start_time: Number(start) }),
        });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); return; }
        document.getElementById('ch-title-input').value = '';
        document.getElementById('ch-start-input').value = '';
        await loadChapters();
        toast('Capítulo añadido');
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Añadir capítulo'; }
    }

    async function deleteChapter(cid) {
      const ok = await confirmModal('¿Eliminar capítulo?', 'Esta acción no se puede deshacer.', 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      try {
        const r = await apiFetch(`${BASE}/api/videos/${_chaptersVideoId}/chapters/${cid}`, { method: 'DELETE' });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); return; }
        toast('Capítulo eliminado');
        loadChapters();
      } catch { toast('Error de conexión', 'error'); }
    }

    function editChapterInline(cid, currentTitle, currentStart) {
      const container = document.getElementById(`ch-label-${cid}`)?.parentElement;
      if (!container) return;
      container.innerHTML = `
        <input id="ch-edit-time-${cid}" type="number" value="${currentStart}" min="0" step="1"
          style="width:70px;background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;">
        <input id="ch-edit-title-${cid}" type="text" value="${esc(currentTitle)}"
          style="flex:1;background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:4px 8px;font-size:13px;">
        <button onclick="saveChapterEdit('${cid}')"
          style="background:var(--accent);border:none;border-radius:6px;color:white;cursor:pointer;padding:4px 10px;font-size:12px;">OK</button>
        <button onclick="loadChapters()"
          style="background:none;border:1px solid var(--border2);border-radius:6px;color:var(--muted);cursor:pointer;padding:4px 10px;font-size:12px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
      document.getElementById(`ch-edit-title-${cid}`)?.focus();
    }

    async function saveChapterEdit(cid) {
      const titleEl = document.getElementById(`ch-edit-title-${cid}`);
      const startEl = document.getElementById(`ch-edit-time-${cid}`);
      const title = titleEl?.value.trim();
      const start = startEl?.value;
      if (!title || start === '' || isNaN(Number(start))) { toast('Datos inválidos', 'error'); return; }
      try {
        const r = await apiFetch(`${BASE}/api/videos/${_chaptersVideoId}/chapters/${cid}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, start_time: Number(start) }),
        });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); return; }
        await loadChapters();
        toast('Capítulo actualizado');
      } catch { toast('Error de conexión', 'error'); }
    }

    // ─── Email verification banner ───────────────────────────────
    function showVerifyBanner() {
      const banner = document.getElementById('verify-banner');
      if (banner && authUser && !authUser.email_verified) {
        banner.style.display = 'flex';
      }
    }

    async function resendVerification() {
      const btn = document.getElementById('resend-verify-btn');
      btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const r = await apiFetch('/auth/resend-verification', { method: 'POST' });
        if (r.ok) toast('Correo de verificación enviado. Revisa tu bandeja.');
        else toast('No se pudo enviar. Intenta más tarde.', 'error');
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Reenviar enlace'; }
    }

    // ─── API Keys ────────────────────────────────────────────────
    async function loadApiKeys() {
      const list = document.getElementById('apikeys-list');
      if (!list || !authWorkspace) return;
      // Verificar si el feature está habilitado antes de hacer la llamada
      if (_cachedFeatures.apiKeysEnabled === false) {
        list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Disponible en plan Pro o Enterprise.</p>';
        return;
      }
      try {
        const r = await apiFetch('/api/apikeys');
        if (r.status === 403) {
          list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Disponible en plan Pro o Enterprise.</p>';
          return;
        }
        const keys = await r.json();
        if (!keys.length) {
          list.innerHTML = '<p style="font-size:13px;color:var(--muted);">No tienes claves de API. Crea una para comenzar.</p>';
          return;
        }
        list.innerHTML = keys.map(k => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:var(--text);">${esc(k.name)}</div>
              <div style="font-size:11px;color:var(--muted);font-family:var(--mono);">${k.prefix}••••••••••••••••••</div>
              <div style="font-size:11px;color:var(--muted);">Creada ${timeAgo(k.created_at)}${k.last_used_at ? ` · Usada ${timeAgo(k.last_used_at)}` : ' · Nunca usada'}</div>
            </div>
            <button class="action-btn del-btn" onclick="revokeApiKey('${k.id}','${escAttr(k.name)}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
              Revocar
            </button>
          </div>`).join('');
      } catch {
        list.innerHTML = '<p style="font-size:13px;color:var(--red);">Error cargando claves</p>';
      }
    }

    function createApiKey() {
      document.getElementById('apikey-create-name').value = '';
      openModal('create-apikey-modal-overlay');
      setTimeout(() => document.getElementById('apikey-create-name').focus(), 80);
    }

    async function submitCreateApiKey() {
      const name = document.getElementById('apikey-create-name').value.trim();
      if (!name) { document.getElementById('apikey-create-name').focus(); return toast('El nombre es requerido', 'error'); }
      try {
        const r = await apiFetch('/api/apikeys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (r.status === 403) return toast('Requiere plan Pro o Enterprise', 'error');
        if (!r.ok) { const e = await r.json().catch(() => {}); return toast(e?.error || 'Error', 'error'); }
        const data = await r.json();
        closeModal('create-apikey-modal-overlay');
        await loadApiKeys();
        // Show key once in a styled modal
        const modal = document.createElement('div');
        modal.className = 'modal-overlay visible';
        modal.innerHTML = `<div class="modal-card" style="max-width:500px;">
  <div class="modal-head">
    <h3>Clave creada</h3>
    <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" style="padding:4px 10px;font-size:18px;line-height:1;border-radius:8px;flex-shrink:0;" aria-label="Cerrar">×</button>
  </div>
  <div class="modal-body" style="padding-bottom:8px;">
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Copia esta clave ahora. <strong>No podrás verla de nuevo.</strong></p>
    <div style="display:flex;align-items:center;gap:8px;">
      <input id="apikey-reveal-input" type="text" readonly value="${esc(data.key)}"
        onclick="this.select()"
        style="flex:1;min-width:0;font-family:monospace;font-size:12.5px;letter-spacing:.03em;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:10px 14px;outline:none;cursor:text;">
      <button data-key="${esc(data.key)}"
        onclick="navigator.clipboard.writeText(this.dataset.key).then(()=>{this.textContent='✓ Copiada';setTimeout(()=>this.textContent='Copiar',2000);})"
        style="flex-shrink:0;background:var(--surface3);border:1px solid var(--border2);border-radius:8px;color:var(--text);cursor:pointer;padding:10px 16px;font-size:13px;font-weight:600;font-family:var(--sans);white-space:nowrap;transition:all .14s;" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text)'">Copiar</button>
    </div>
  </div>
  <div class="modal-foot">
    <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Entendido</button>
  </div>
</div>`;
        document.body.appendChild(modal);
      } catch { toast('Error de conexión', 'error'); }
    }

    async function revokeApiKey(id, name) {
      const ok = await confirmModal('¿Revocar clave?', `Se eliminará la clave "${name}". Las apps que la usen dejarán de funcionar.`, 'Revocar', 'Cancelar', true);
      if (!ok) return;
      const r = await apiFetch(`/api/apikeys/${id}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(d.error || 'Error al revocar clave', 'error'); }
      toast('Clave revocada');
      loadApiKeys();
    }

    // ─── Plan & Usage ─────────────────────────────────────────────
    function fmtBytes(b) {
      const n = Number(b) || 0;
      if (n <= 0) return '0 B';
      const units = ['B','KB','MB','GB','TB'];
      const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
      return (n / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }
    function usageBar(usedBytes, maxBytes, label) {
      const used = Number(usedBytes) || 0;
      const max  = Number(maxBytes)  || 0;
      // -1 means unlimited
      if (max < 0) {
        return `<div style="margin-bottom:4px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:5px;">
            <span>${label}</span>
            <span>${fmtBytes(used)} / <span style="color:var(--green);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/></svg> Ilimitado</span></span>
          </div>
          <div style="background:var(--surface2);border-radius:99px;height:6px;overflow:hidden;">
            <div style="width:5%;height:100%;background:var(--green);border-radius:99px;"></div>
          </div>
        </div>`;
      }
      const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
      const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--amber)' : 'var(--accent)';
      return `<div style="margin-bottom:4px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:5px;">
          <span>${label}</span>
          <span>${fmtBytes(used)} / ${max > 0 ? fmtBytes(max) : '—'}</span>
        </div>
        <div style="background:var(--surface2);border-radius:99px;height:6px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:99px;transition:width .4s;"></div>
        </div>
      </div>`;
    }
    async function loadPlanUsage() {
      if (!authWorkspace) return;
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`);
        if (!r.ok) return;
        const ws = await r.json();
        const u = ws.usage || {};
        const planName = (ws.plan || 'starter').toUpperCase();
        document.getElementById('plan-badge').textContent = planName;
        const maxVid = Number(u.maxVideos);
        const vidUsed = Number(u.videos) || 0;
        const vidMax  = maxVid < 0 ? '<span style="color:var(--green);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/></svg></span>' : (maxVid || '—');
        document.getElementById('plan-usage-body').innerHTML =
          usageBar(u.storageUsedBytes || 0, u.maxStorageBytes ?? -1, 'Almacenamiento') +
          usageBar(u.bandwidthUsedBytes || 0, u.maxBandwidthBytes ?? -1, 'Ancho de banda este mes') +
          `<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);padding-top:4px;">
            <span>Videos</span>
            <span style="color:var(--text);">${vidUsed} / ${vidMax}</span>
          </div>`;
        // Update sidebar footer
        const sbPlan = document.getElementById('sidebar-plan-badge');
        if (sbPlan) {
          sbPlan.textContent = planName;
          const planColors = { STARTER: 'rgba(124,108,250,0.15)', PRO: 'rgba(34,211,165,0.15)', ENTERPRISE: 'rgba(251,191,36,0.15)' };
          const planText = { STARTER: 'var(--accent2)', PRO: 'var(--green)', ENTERPRISE: 'var(--amber)' };
          sbPlan.style.background = planColors[planName] || planColors.STARTER;
          sbPlan.style.color = planText[planName] || planText.STARTER;
        }
        const storagePct = u.maxStorageBytes > 0 ? Math.min(100, Math.round((u.storageUsedBytes || 0) / u.maxStorageBytes * 100)) : 0;
        const sbBar = document.getElementById('sidebar-storage-bar');
        const sbLabel = document.getElementById('sidebar-storage-label');
        if (sbBar) {
          sbBar.style.width = storagePct + '%';
          sbBar.style.background = storagePct > 85 ? 'var(--red)' : storagePct > 65 ? 'var(--amber)' : 'var(--accent)';
        }
        if (sbLabel) sbLabel.textContent = fmtBytes(u.storageUsedBytes || 0);
      } catch { }
    }

    // ════════════════════════════════════════════════════════════
    // ─── BILLING — Membresía & Gestión de Plan ───────────────────
    // ════════════════════════════════════════════════════════════

    async function loadBillingSection() {
      try {
        const [statusRes, invoicesRes] = await Promise.all([
          apiFetch(`${BASE}/api/billing/status`),
          apiFetch(`${BASE}/api/billing/invoices`),
        ]);

        const status = statusRes.ok ? await statusRes.json() : null;
        const invoicesData = invoicesRes.ok ? await invoicesRes.json() : { invoices: [] };

        if (status) renderMembershipCard(status);
        renderInvoicesTable(invoicesData.invoices || []);
      } catch (e) {
        console.error('Error loading billing section:', e);
      }
    }

    function renderMembershipCard(status) {
      const card = document.getElementById('membership-info-card');
      if (!card) return;

      const planColors = {
        starter: { bg: 'rgba(124,108,250,0.15)', text: 'var(--accent2)', border: 'rgba(124,108,250,0.3)' },
        pro: { bg: 'rgba(34,211,165,0.12)', text: 'var(--green)', border: 'rgba(34,211,165,0.25)' },
        enterprise: { bg: 'rgba(251,191,36,0.12)', text: 'var(--amber)', border: 'rgba(251,191,36,0.25)' },
      };
      const pc = planColors[status.plan] || planColors.starter;

      const fmtDate = (ts) => ts
        ? new Date(ts * 1000).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })
        : null;

      const periodEndDate = fmtDate(status.currentPeriodEnd);
      const providerLabels = { stripe: 'Stripe', paypal: 'PayPal', binance: 'Binance Pay', dlocalgo: 'dLocal Go' };
      const providerLabel = providerLabels[status.paymentProvider] || status.paymentProvider || '—';

      // Determinar si es un plan de pago (asignado manualmente o via suscripción)
      const isPaidPlan = status.plan !== 'starter' && status.price > 0;
      const isActive = status.hasSubscription || isPaidPlan;

      let statusBadge = '';
      if (status.suspended) {
        statusBadge = `<span style="background:rgba(248,113,113,0.15);color:var(--red);font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px;">Suspendida</span>`;
      } else if (status.cancelAtPeriodEnd) {
        statusBadge = `<span style="background:rgba(251,191,36,0.12);color:var(--amber);font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px;">Cancela al vencer</span>`;
      } else if (isActive) {
        statusBadge = `<span style="background:rgba(34,211,165,0.12);color:var(--green);font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px;">Activa</span>`;
      } else {
        statusBadge = `<span style="background:rgba(124,108,250,0.1);color:var(--muted);font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px;">Free</span>`;
      }

      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:99px;background:${pc.bg};color:${pc.text};border:1px solid ${pc.border};text-transform:uppercase;letter-spacing:.8px;">${esc(status.planName || status.plan)}</span>
            ${statusBadge}
          </div>
          <div style="font-size:20px;font-weight:700;font-family:var(--mono);color:${pc.text};">
            ${status.price > 0 ? '$' + status.price + '/mes' : 'Gratis'}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:18px;">
          ${isActive ? `
          ${status.hasSubscription ? `<div style="background:var(--surface2);border-radius:8px;padding:10px 14px;border:1px solid var(--border);">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Método de pago</div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">${esc(providerLabel)}</div>
          </div>` : ''}
          ${periodEndDate ? `
          <div style="background:var(--surface2);border-radius:8px;padding:10px 14px;border:1px solid var(--border);">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">${status.cancelAtPeriodEnd ? 'Acceso hasta' : 'Próxima renovación'}</div>
            <div style="font-size:13px;font-weight:600;color:${status.cancelAtPeriodEnd ? 'var(--amber)' : 'var(--text)'};">${esc(periodEndDate)}</div>
          </div>` : ''}
          <div style="background:var(--surface2);border-radius:8px;padding:10px 14px;border:1px solid var(--border);">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Videos</div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">${status.limits?.videos?.used || 0} / ${status.limits?.videos?.max < 0 ? '∞' : status.limits?.videos?.max}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:10px 14px;border:1px solid var(--border);">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Almacenamiento</div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">${status.limits?.storage?.maxGB || 0} GB</div>
          </div>` : `
          <div style="background:var(--surface2);border-radius:8px;padding:10px 14px;border:1px solid var(--border);">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Videos</div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">${status.limits?.videos?.used || 0} / ${status.limits?.videos?.max || 0}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:10px 14px;border:1px solid var(--border);">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Almacenamiento</div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">${status.limits?.storage?.maxGB || 0} GB</div>
          </div>
          `}
        </div>

        ${status.suspended ? `
        <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:flex-start;gap:10px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" style="flex-shrink:0;margin-top:1px;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--red);">Workspace suspendido</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px;">Tu suscripción tiene un problema de pago. Actualiza tu método de pago para restablecer el acceso.</div>
          </div>
        </div>` : ''}

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${status.hasSubscription ? `
            <button class="btn btn-primary" style="padding:8px 18px;font-size:13px;" onclick="manageBillingPortal()">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
              Gestionar facturación
            </button>
            ${!status.cancelAtPeriodEnd ? `
            <button class="btn btn-ghost" style="padding:8px 18px;font-size:13px;color:var(--red);border-color:rgba(248,113,113,0.3);" onclick="openCancelSubscriptionModal()">
              Cancelar suscripción
            </button>` : `
            <div style="font-size:12px;color:var(--amber);padding:8px 12px;background:rgba(251,191,36,0.08);border-radius:8px;border:1px solid rgba(251,191,36,0.2);">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
              Se cancelará automáticamente al vencer el período
            </div>`}
          ` : isPaidPlan ? `
            <div style="font-size:12px;color:var(--green);padding:8px 14px;background:rgba(34,211,165,0.08);border-radius:8px;border:1px solid rgba(34,211,165,0.2);display:flex;align-items:center;gap:6px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              Plan asignado por administrador
            </div>
          ` : `
            <button class="btn btn-primary" style="padding:8px 18px;font-size:13px;" onclick="openUpgradeModal()">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><polyline points="17 11 21 7 17 3"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="15" y1="17" x2="3" y2="17"/></svg>
              Actualizar plan
            </button>
          `}
        </div>
      `;
    }

    function renderInvoicesTable(invoices) {
      const container = document.getElementById('invoices-container');
      if (!container) return;

      if (!invoices.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/><line x1="6" y1="17" x2="14" y2="17"/></svg></div><h3>Sin facturas aún</h3><p>Las facturas aparecerán aquí cuando realices un pago.</p></div>`;
        return;
      }

      const fmtDate = (ts) => ts
        ? new Date(ts * 1000).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
      const fmtMoney = (amt, cur) => `${cur || 'USD'} $${parseFloat(amt || 0).toFixed(2)}`;
      const statusStyle = {
        paid: 'background:rgba(34,211,165,0.1);color:var(--green);',
        pending: 'background:rgba(251,191,36,0.1);color:var(--amber);',
        failed: 'background:rgba(248,113,113,0.1);color:var(--red);',
        refunded: 'background:rgba(124,108,250,0.1);color:var(--accent2);',
      };
      const statusLabel = { paid: 'Pagada', pending: 'Pendiente', failed: 'Fallida', refunded: 'Reembolsada' };
      const providerIcon = {
        stripe: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
        paypal: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 7H5a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2z"/></svg>',
        binance: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        dlocalgo: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>',
      };

      container.innerHTML = `
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="border-bottom:1px solid var(--border2);">
                <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;">Factura</th>
                <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;">Fecha</th>
                <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;">Plan</th>
                <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;">Importe</th>
                <th style="text-align:center;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;">Estado</th>
                <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;"></th>
              </tr>
            </thead>
            <tbody>
              ${invoices.map(inv => `
              <tr style="border-bottom:1px solid var(--border);" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
                <td style="padding:10px 12px;">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="color:var(--muted);opacity:.6;">${providerIcon[inv.provider] || ''}</span>
                    <span style="font-family:var(--mono);font-size:12px;color:var(--accent2);">${esc(inv.invoice_number)}</span>
                  </div>
                </td>
                <td style="padding:10px 12px;color:var(--muted);">${fmtDate(inv.paid_at || inv.created_at)}</td>
                <td style="padding:10px 12px;font-weight:600;color:var(--text);">${esc(inv.plan?.charAt(0).toUpperCase() + inv.plan?.slice(1) || '—')}</td>
                <td style="padding:10px 12px;text-align:right;font-family:var(--mono);font-weight:700;color:var(--text);">${fmtMoney(inv.amount, inv.currency)}</td>
                <td style="padding:10px 12px;text-align:center;">
                  <span style="${statusStyle[inv.status] || ''}font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px;">
                    ${statusLabel[inv.status] || esc(inv.status)}
                  </span>
                </td>
                <td style="padding:10px 12px;text-align:right;">
                  <a href="${BASE}/api/billing/invoices/${esc(inv.id)}/download"
                     title="Descargar factura"
                     style="display:inline-flex;align-items:center;gap:4px;color:var(--accent);font-size:12px;text-decoration:none;padding:4px 8px;border-radius:6px;background:rgba(124,108,250,0.1);border:1px solid rgba(124,108,250,0.2);"
                     target="_blank" rel="noopener">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    PDF
                  </a>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    async function manageBillingPortal() {
      const btn = event?.target?.closest('button');
      if (btn) { btn.disabled = true; btn.textContent = 'Cargando...'; }
      try {
        const p = await apiFetch(`${BASE}/api/billing/portal?returnUrl=${encodeURIComponent(window.location.href)}`);
        const pd = await p.json();
        if (!p.ok) throw new Error(pd.error || 'Error al acceder al portal');
        if (pd.portalUrl) window.location.href = pd.portalUrl;
        else throw new Error('No se recibió URL del portal');
      } catch (e) {
        toast(e.message || 'Error de conexión', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Gestionar facturación'; }
      }
    }

    async function manageBilling() {
      const btn = document.getElementById('manage-billing-btn');
      const ogText = btn?.textContent || 'Gestionar plan';
      if (btn) { btn.disabled = true; btn.textContent = 'Cargando...'; }
      try {
        const statusRes = await apiFetch(`${BASE}/api/billing/status`);
        if (!statusRes.ok) throw new Error('Error al verificar estado');
        const status = await statusRes.json();

        if (status.hasSubscription) {
          const p = await apiFetch(`${BASE}/api/billing/portal?returnUrl=${encodeURIComponent(window.location.href)}`);
          const pd = await p.json();
          if (pd.portalUrl) window.location.href = pd.portalUrl;
          else throw new Error(pd.error || 'Error al acceder al portal');
        } else {
          openUpgradeModal();
          if (btn) { btn.disabled = false; btn.textContent = ogText; }
        }
      } catch (e) {
        toast(e.message || 'Error de conexión', 'error');
        if (btn) { btn.disabled = false; btn.textContent = ogText; }
      }
    }

    // ─── Cancel Subscription ──────────────────────────────────────
    function openCancelSubscriptionModal() {
      openModal('cancel-subscription-modal');
    }
    function closeCancelSubscriptionModal() {
      closeModal('cancel-subscription-modal');
    }

    async function confirmCancelSubscription() {
      const btn = document.getElementById('cancel-sub-confirm-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Cancelando...'; }
      try {
        const r = await apiFetch(`${BASE}/api/billing/subscription/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Error al cancelar');
        closeCancelSubscriptionModal();
        toast('Suscripción cancelada. Mantendrás acceso hasta el fin del período.', 'success');
        // Recargar panel de membresía
        setTimeout(loadBillingSection, 800);
      } catch (e) {
        toast(e.message || 'Error al cancelar suscripción', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Sí, cancelar suscripción'; }
      }
    }

    // ─── Team Members ─────────────────────────────────────────────
    let _teamUserRole = 'viewer';
    async function loadTeamMembers() {
      if (!authWorkspace) return;
      const list = document.getElementById('team-members-list');
      const pendingSection = document.getElementById('pending-invites-section');
      const pendingList = document.getElementById('pending-invites-list');
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/members`);
        if (!r.ok) { list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Error cargando equipo.</p>'; return; }
        const data = await r.json();
        const me = authUser?.id;
        const myMember = data.members?.find(m => m.id === me);
        _teamUserRole = myMember?.role || 'viewer';

        list.innerHTML = (data.members || []).map(m => {
          const isMe = m.id === me;
          const canEdit = _teamUserRole === 'owner' && !isMe && m.role !== 'owner';
          const roleLabel = { owner: 'Propietario', admin: 'Admin', viewer: 'Viewer' }[m.role] || m.role;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border2);">
            <div style="width:32px;height:32px;border-radius:50%;background:rgba(124,108,250,0.15);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--accent2);flex-shrink:0;">
              ${esc((m.name||m.email||'?')[0].toUpperCase())}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.name || m.email)}</div>
              <div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.email)}</div>
            </div>
            ${canEdit
              ? `<select onchange="changeMemberRole('${m.id}',this.value)"
                  style="background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:4px 8px;font-size:12px;cursor:pointer;">
                  <option value="admin"${m.role==='admin'?' selected':''}>Admin</option>
                  <option value="viewer"${m.role==='viewer'?' selected':''}>Viewer</option>
                </select>
                <button onclick="removeMember('${m.id}','${escAttr(m.name||m.email)}')"
                  style="background:none;border:none;color:var(--red);cursor:pointer;padding:4px;font-size:16px;line-height:1;" title="Eliminar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`
              : `<span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:99px;background:rgba(124,108,250,0.12);color:var(--accent2);">${roleLabel}</span>`
            }
          </div>`;
        }).join('');

        const pending = data.pendingInvitations || [];
        if (pending.length > 0) {
          pendingSection.style.display = 'block';
          pendingList.innerHTML = pending.map(inv =>
            `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border2);">
              <div style="flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(inv.email)}</div>
              <span style="font-size:11px;color:var(--muted);flex-shrink:0;">${esc(inv.role)}</span>
              <span style="font-size:11px;background:rgba(251,191,36,0.12);color:var(--amber);padding:2px 8px;border-radius:99px;flex-shrink:0;">Pendiente</span>
              ${_teamUserRole === 'owner' || _teamUserRole === 'admin'
                ? `<button onclick="cancelInvitation('${inv.id}','${escAttr(inv.email)}')" title="Cancelar invitación"
                    style="background:none;border:none;color:var(--red);cursor:pointer;padding:4px;font-size:16px;line-height:1;flex-shrink:0;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>`
                : ''}
            </div>`
          ).join('');
        } else {
          pendingSection.style.display = 'none';
        }
      } catch { list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Error de conexión.</p>'; }
    }

    async function changeMemberRole(userId, role) {
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/members/${userId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); loadTeamMembers(); return; }
        toast(`Rol actualizado a ${role}`);
      } catch { toast('Error de conexión', 'error'); loadTeamMembers(); }
    }

    async function removeMember(userId, name) {
      const ok = await confirmModal(`¿Eliminar miembro?`, `Se eliminará a ${name} del workspace. Podrás invitarle de nuevo.`, 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/members/${userId}`, { method: 'DELETE' });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error', 'error'); return; }
        toast(`${name} eliminado del workspace`);
        loadTeamMembers();
      } catch { toast('Error de conexión', 'error'); }
    }

    function openInviteModal() {
      document.getElementById('invite-email-input').value = '';
      document.getElementById('invite-role-select').value = 'viewer';
      const alert = document.getElementById('invite-modal-alert');
      alert.style.display = 'none';
      document.getElementById('invite-send-btn').disabled = false;
      openModal('invite-modal-overlay');
      setTimeout(() => document.getElementById('invite-email-input').focus(), 80);
    }
    async function sendInvite() {
      const email = document.getElementById('invite-email-input').value.trim();
      const role = document.getElementById('invite-role-select').value;
      const alertEl = document.getElementById('invite-modal-alert');
      const btn = document.getElementById('invite-send-btn');
      if (!email) { showInviteAlert('Introduce un email válido.', 'error'); return; }
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/invite`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role }),
        });
        const d = await r.json();
        if (!r.ok) { showInviteAlert(d.error || 'Error al enviar.', 'error'); return; }
        toast('Invitación enviada a ' + email);
        closeModal('invite-modal-overlay');
        loadTeamMembers();
      } catch { showInviteAlert('Error de conexión.', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Enviar invitación'; }
    }
    async function cancelInvitation(invitationId, email) {
      const ok = await confirmModal('¿Cancelar invitación?', `Se cancelará la invitación enviada a ${email}. Podrás invitarle de nuevo.`);
      if (!ok) return;
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}/invitations/${invitationId}`, { method: 'DELETE' });
        if (!r.ok) { const d = await r.json(); toast(d.error || 'Error al cancelar', 'error'); return; }
        toast('Invitación cancelada');
        loadTeamMembers();
      } catch { toast('Error de conexión', 'error'); }
    }

    function showInviteAlert(msg, type) {
      const el = document.getElementById('invite-modal-alert');
      el.textContent = msg;
      el.style.display = 'block';
      el.style.background = type === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(34,211,165,0.1)';
      el.style.border = type === 'error' ? '1px solid rgba(248,113,113,0.2)' : '1px solid rgba(34,211,165,0.2)';
      el.style.color = type === 'error' ? 'var(--red)' : 'var(--green)';
    }

    // ─── White-label logo helpers ─────────────────────────────────

    /**
     * Show/hide logo preview whenever the URL input changes.
     * Called via oninput on #cfg-logo-url.
     */
    function updateLogoPreview() {
      const url  = document.getElementById('cfg-logo-url').value.trim();
      const wrap = document.getElementById('logo-preview-wrap');
      const img  = document.getElementById('logo-preview-img');
      if (url) {
        img.src = url;
        img.onerror = () => { wrap.style.display = 'none'; };
        img.onload  = () => { wrap.style.display = 'block'; };
        wrap.style.display = 'block';
      } else {
        wrap.style.display = 'none';
      }
    }

    /**
     * Handle logo file upload (Pro+ only).
     * Converts the image to a data URL and stores it as the embedLogo setting.
     * For a production setup you'd upload to S3 and store the CDN URL instead —
     * this client-side approach works for logos up to ~2 MB.
     */
    async function handleLogoUpload(input) {
      const file = input.files[0];
      if (!file) return;

      // Validate size (2 MB max)
      if (file.size > 2 * 1024 * 1024) {
        toast('El logo no puede superar 2 MB', 'error');
        input.value = '';
        return;
      }

      const statusEl = document.getElementById('logo-upload-status');
      statusEl.textContent = 'Procesando…';
      statusEl.style.color = 'var(--muted)';

      try {
        // Convert to data URL so it can be stored in workspace settings
        // and served directly without a separate file hosting step.
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = e => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        // Set the URL field and trigger preview
        document.getElementById('cfg-logo-url').value = dataUrl;
        updateLogoPreview();

        statusEl.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:3px;"><polyline points="20 6 9 17 4 12"/></svg> Listo — guarda la configuración para aplicar';
        statusEl.style.color = 'var(--green)';
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
      } catch {
        statusEl.textContent = 'Error al procesar la imagen';
        statusEl.style.color = 'var(--red)';
      }
      input.value = ''; // reset so same file can be re-selected
    }

    /**
     * Show/hide the Pro badge and upload button based on workspace plan.
     * Called after loadSettings resolves the workspace data.
     */
    function applyWhiteLabelUI(plan) {
      const PRO_PLANS = new Set(['pro', 'enterprise']);
      const isPro = PRO_PLANS.has(plan);

      // Badge
      const badge = document.getElementById('logo-pro-badge');
      if (badge) badge.style.display = isPro ? 'inline-flex' : 'none';

      // Upload button (only Pro+)
      const uploadWrap = document.getElementById('logo-upload-wrap');
      if (uploadWrap) uploadWrap.style.display = isPro ? 'flex' : 'none';

      // Show preview if there's already a logo URL
      updateLogoPreview();
    }

    // ─── Patch restoreSession to show banner ─────────────────────
    const _origRestoreSession = restoreSession;
    restoreSession = async function() {
      await _origRestoreSession();
      showVerifyBanner();
    };

    // ════════════════════════════════════════════════════════════
    // ─── PLAYLISTS ───────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════
    let _allPlaylists = [];

    async function loadPlaylists() {
      const grid = document.getElementById('playlists-grid');
      if (!grid) return;
      // Playlists require a workspace — show helpful message if not available
      if (!authWorkspace) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg></div><h3>Workspace requerido</h3><p>Selecciona o crea un workspace para gestionar playlists.</p></div>`;
        return;
      }
      grid.innerHTML = Array.from({length:4}, () => `
        <div class="skeleton-card" style="border-radius:12px;overflow:hidden;animation:skeleton-pulse 1.15s ease-in-out infinite;" aria-hidden="true">
          <div style="padding:18px 18px 14px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
              <div class="skeleton-line" style="width:55%;height:14px;border-radius:6px;"></div>
              <div class="skeleton-line" style="width:18%;height:14px;border-radius:99px;"></div>
            </div>
            <div class="skeleton-line" style="width:80%;height:11px;border-radius:5px;margin-bottom:6px;"></div>
            <div class="skeleton-line" style="width:60%;height:11px;border-radius:5px;"></div>
          </div>
          <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;">
            <div class="skeleton-line" style="width:72px;height:30px;border-radius:7px;"></div>
            <div class="skeleton-line" style="width:56px;height:30px;border-radius:7px;"></div>
            <div class="skeleton-line" style="width:64px;height:30px;border-radius:7px;"></div>
          </div>
        </div>`).join('');
      try {
        const r = await apiFetch(`${BASE}/api/playlists`);
        if (!r.ok) throw new Error('failed');
        _allPlaylists = await r.json();
        const badge = document.getElementById('playlists-count-badge');
        if (badge) { badge.textContent = _allPlaylists.length; badge.style.display = _allPlaylists.length ? '' : 'none'; }
        // Show search bar only when there are playlists
        const searchBar = document.getElementById('pl-search-bar');
        if (searchBar) searchBar.style.display = _allPlaylists.length > 0 ? 'flex' : 'none';
        renderPlaylists();
      } catch {
        grid.innerHTML = '<p style="color:var(--red);font-size:13px;">Error cargando playlists.</p>';
      }
    }

    function renderPlaylists() {
      const grid = document.getElementById('playlists-grid');
      if (!grid) return;
      if (!_allPlaylists.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/><polygon points="17 15 22 18 17 21" fill="currentColor" stroke="none"/></svg></div><h3>Sin playlists</h3><p>Crea tu primera playlist para organizar y compartir tus videos.</p><button class="btn btn-primary btn-sm empty-state-cta" onclick="openCreatePlaylistModal()">Nueva playlist</button></div>`;
        return;
      }
      grid.innerHTML = _allPlaylists.map(pl => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;transition:transform .18s var(--ease-out),box-shadow .18s,border-color .14s;" onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 12px 40px rgba(0,0,0,.35)';this.style.borderColor='var(--border2)'" onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor='var(--border)'">
          <div style="padding:18px 18px 14px;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
              <div style="font-size:14px;font-weight:700;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(pl.title)}</div>
              <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;flex-shrink:0;${pl.visibility==='public'?'background:rgba(34,211,165,0.12);color:var(--green);border:1px solid rgba(34,211,165,0.2);':'background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2);'}">${pl.visibility==='public'?'PÚBLICA':'PRIVADA'}</span>
            </div>
            ${pl.description ? `<p style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(pl.description)}</p>` : ''}
            <div style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>
              ${pl.video_count || 0} video${(pl.video_count||0)!==1?'s':''}
            </div>
          </div>
          <div style="padding:12px 18px 16px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;">
            <button class="action-btn" style="font-size:12px;padding:6px 12px;" onclick="openPlaylistVideosModal('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Ver videos
            </button>
            <button class="action-btn copy-btn" style="font-size:12px;padding:6px 12px;" onclick="copyPlaylistLink('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
              Link
            </button>
            <button class="action-btn copy-btn" style="font-size:12px;padding:6px 12px;" onclick="copyPlaylistEmbed('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              Embed
            </button>
            <button class="action-btn" style="font-size:12px;padding:6px 12px;" onclick="openEditPlaylistModal('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Editar
            </button>
            <button class="action-btn del-btn" style="font-size:12px;padding:6px 12px;" onclick="deletePlaylist('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
              Eliminar
            </button>
          </div>
        </div>`).join('');
    }

    // ─── Playlist client-side filter/sort ────────────────────────
    function filterPlaylists() {
      const q = (document.getElementById('pl-search-input')?.value || '').trim().toLowerCase();
      const vis = document.getElementById('pl-filter-vis')?.value || 'all';
      const sort = document.getElementById('pl-sort-select')?.value || 'recent';
      const grid = document.getElementById('playlists-grid');
      if (!grid) return;

      let list = [..._allPlaylists];

      // Search by title or description
      if (q) list = list.filter(pl =>
        (pl.title || '').toLowerCase().includes(q) ||
        (pl.description || '').toLowerCase().includes(q)
      );

      // Visibility filter
      if (vis !== 'all') list = list.filter(pl => pl.visibility === vis);

      // Sort
      if (sort === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'es'));
      else if (sort === 'videos') list.sort((a, b) => (b.video_count || 0) - (a.video_count || 0));
      // 'recent' = default order from API (already sorted by created_at desc)

      // Update hint
      const hint = document.getElementById('pl-count-hint');
      if (hint) {
        const isFiltered = list.length !== _allPlaylists.length || !!q || vis !== 'all';
        hint.textContent = isFiltered ? `${list.length} de ${_allPlaylists.length}` : '';
      }

      if (!list.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><h3>Sin coincidencias</h3><p>Prueba otro texto de búsqueda o cambia los filtros.</p></div>`;
        return;
      }

      grid.innerHTML = list.map(pl => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;transition:transform .18s var(--ease-out),box-shadow .18s,border-color .14s;" onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 12px 40px rgba(0,0,0,.35)';this.style.borderColor='var(--border2)'" onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor='var(--border)'">
          <div style="padding:18px 18px 14px;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
              <div style="font-size:14px;font-weight:700;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(pl.title)}</div>
              <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;flex-shrink:0;${pl.visibility==='public'?'background:rgba(34,211,165,0.12);color:var(--green);border:1px solid rgba(34,211,165,0.2);':'background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2);'}">${pl.visibility==='public'?'PÚBLICA':'PRIVADA'}</span>
            </div>
            ${pl.description ? `<p style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(pl.description)}</p>` : ''}
            <div style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>
              ${pl.video_count || 0} video${(pl.video_count||0)!==1?'s':''}
            </div>
          </div>
          <div style="padding:12px 18px 16px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;">
            <button class="action-btn" style="font-size:12px;padding:6px 12px;" onclick="openPlaylistVideosModal('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Ver videos
            </button>
            <button class="action-btn copy-btn" style="font-size:12px;padding:6px 12px;" onclick="copyPlaylistLink('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
              Link
            </button>
            <button class="action-btn copy-btn" style="font-size:12px;padding:6px 12px;" onclick="copyPlaylistEmbed('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              Embed
            </button>
            <button class="action-btn" style="font-size:12px;padding:6px 12px;" onclick="openEditPlaylistModal('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Editar
            </button>
            <button class="action-btn del-btn" style="font-size:12px;padding:6px 12px;" onclick="deletePlaylist('${pl.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
              Eliminar
            </button>
          </div>
        </div>`).join('');
    }

    function openCreatePlaylistModal() {
      document.getElementById('pl-create-title').value = '';
      document.getElementById('pl-create-desc').value = '';
      document.getElementById('pl-create-vis').value = 'public';
      openModal('create-playlist-modal-overlay');
      setTimeout(() => document.getElementById('pl-create-title').focus(), 80);
    }

    async function submitCreatePlaylist() {
      const title = document.getElementById('pl-create-title').value.trim();
      if (!title) { document.getElementById('pl-create-title').focus(); return toast('El título es requerido', 'error'); }
      const desc = document.getElementById('pl-create-desc').value.trim();
      const vis = document.getElementById('pl-create-vis').value;
      try {
        const r = await apiFetch(`${BASE}/api/playlists`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description: desc, visibility: vis }),
        });
        if (!r.ok) { const d = await r.json(); return toast(d.error || 'Error', 'error'); }
        closeModal('create-playlist-modal-overlay');
        toast('Playlist creada');
        loadPlaylists();
      } catch { toast('Error de conexión', 'error'); }
    }

    let _editPlaylistId = null;
    function openEditPlaylistModal(id) { const _pl = _allPlaylists.find(x => x.id === id) || {}; const title = _pl.title || ''; const description = _pl.description || ''; const visibility = _pl.visibility || 'public';
      _editPlaylistId = id;
      document.getElementById('pl-edit-title').value = title;
      document.getElementById('pl-edit-desc').value = description;
      document.getElementById('pl-edit-vis').value = visibility || 'public';
      openModal('edit-playlist-modal-overlay');
      setTimeout(() => document.getElementById('pl-edit-title').focus(), 80);
    }

    async function submitEditPlaylist() {
      if (!_editPlaylistId) return;
      const title = document.getElementById('pl-edit-title').value.trim();
      if (!title) { document.getElementById('pl-edit-title').focus(); return toast('El título es requerido', 'error'); }
      const description = document.getElementById('pl-edit-desc').value.trim();
      const visibility = document.getElementById('pl-edit-vis').value;
      try {
        const r = await apiFetch(`${BASE}/api/playlists/${_editPlaylistId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, visibility }),
        });
        if (!r.ok) { const d = await r.json(); return toast(d.error || 'Error al guardar', 'error'); }
        closeModal('edit-playlist-modal-overlay');
        toast('Playlist actualizada');
        loadPlaylists();
      } catch { toast('Error de conexión', 'error'); }
    }

    async function deletePlaylist(id) { const title = (_allPlaylists?.find(x => x.id === id))?.title || 'esta playlist';
      const ok = await confirmModal('¿Eliminar playlist?', `Se eliminará "${title}". Los videos no se eliminarán.`, 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      try {
        const r = await apiFetch(`${BASE}/api/playlists/${id}`, { method: 'DELETE' });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          return toast(d.error || 'Error al eliminar la playlist', 'error');
        }
        toast('Playlist eliminada');
        loadPlaylists();
      } catch { toast('Error de conexión', 'error'); }
    }

    function copyPlaylistLink(id) {
      const url = `${BASE}/playlist/${id}`;
      navigator.clipboard.writeText(url).then(() => toast('Link de playlist copiado'));
    }

    function copyPlaylistEmbed(id) {
      const code = `<iframe src="${BASE}/embed/playlist/${id}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`;
      navigator.clipboard.writeText(code).then(() => toast('Código embed de playlist copiado'));
    }

    async function openPlaylistVideosModal(plId) { const plTitle = (_allPlaylists.find(x => x.id === plId))?.title || '';
      const overlay = document.createElement('div');
      overlay.dataset.svOverlay = '1';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
      overlay.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border2);border-radius:20px;width:100%;max-width:560px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.6);">
          <div style="padding:20px 24px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
            <h3 style="font-size:1.1rem;font-weight:700;">${esc(plTitle)}</h3>
            <button class="btn btn-ghost" onclick="this.closest('[data-sv-overlay]').remove()" style="padding:4px 10px;font-size:18px;line-height:1;border-radius:8px;flex-shrink:0;" aria-label="Cerrar">×</button>
          </div>
          <div style="padding:14px 24px 10px;border-bottom:1px solid var(--border);">
            <div style="display:flex;gap:8px;align-items:flex-start;">
              <div style="position:relative;flex:1;" id="pl-picker-wrap">
                <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted);" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" id="pl-picker-input" autocomplete="off" spellcheck="false"
                  placeholder="Buscar video…"
                  style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:8px 12px 8px 30px;font-size:13px;font-family:var(--sans);outline:none;">
                <div id="pl-picker-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.45);z-index:10;max-height:220px;overflow-y:auto;"></div>
                <input type="hidden" id="pl-add-video-sel" value="">
              </div>
              <button class="btn btn-primary" style="padding:8px 16px;font-size:13px;flex-shrink:0;" onclick="addVideoToPlaylist('${plId}',this)">Agregar</button>
            </div>
          </div>
          <div id="pl-videos-list" style="padding:16px 24px 24px;overflow-y:auto;flex:1;"></div>
        </div>`;
      document.body.appendChild(overlay);
      _reloadPlaylistVideos(plId, overlay);

      // Wire up the searchable picker after the modal is in the DOM
      const inp = overlay.querySelector('#pl-picker-input');
      const drop = overlay.querySelector('#pl-picker-dropdown');
      const hiddenSel = overlay.querySelector('#pl-add-video-sel');
      const readyVideos = allVideosCache.filter(v => v.status === 'ready');

      function renderPickerItems(q) {
        const filtered = q
          ? readyVideos.filter(v => v.title.toLowerCase().includes(q.toLowerCase()))
          : readyVideos;
        if (!filtered.length) {
          drop.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:var(--muted);">${q ? 'Sin resultados' : 'Sin videos disponibles'}</div>`;
        } else {
          drop.innerHTML = filtered.slice(0, 80).map(v => {
            const thumb = `/videos/${v.id}/thumb.jpg`;
            return `<div data-vid="${v.id}" style="display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px;" onmouseover="this.style.background='var(--surface3)'" onmouseout="this.style.background=''">
              <div style="width:40px;height:23px;background:var(--surface3);border-radius:4px;flex-shrink:0;overflow:hidden;">
                <img src="${thumb}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">
              </div>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(v.title)}</span>
            </div>`;
          }).join('');
        }
        drop.style.display = '';
      }

      inp.addEventListener('focus', () => { renderPickerItems(inp.value); });
      inp.addEventListener('input', () => { hiddenSel.value = ''; renderPickerItems(inp.value); });
      drop.addEventListener('click', e => {
        const item = e.target.closest('[data-vid]');
        if (!item) return;
        const vid = allVideosCache.find(v => v.id === item.dataset.vid);
        if (!vid) return;
        hiddenSel.value = vid.id;
        inp.value = vid.title;
        drop.style.display = 'none';
      });
      document.addEventListener('click', function closePickerOutside(e) {
        if (!overlay.contains(e.target)) { drop.style.display = 'none'; document.removeEventListener('click', closePickerOutside); }
        else if (!inp.contains(e.target) && !drop.contains(e.target)) drop.style.display = 'none';
      });
    }

    async function _reloadPlaylistVideos(plId, overlay) {
      const listEl = overlay.querySelector('#pl-videos-list');
      try {
        const r = await apiFetch(`${BASE}/api/playlists/${plId}/videos`);
        const videos = await r.json();
        if (!videos.length) {
          listEl.innerHTML = '<p style="font-size:13px;color:var(--muted);">Sin videos aún. Selecciona uno arriba para añadirlo.</p>';
        } else {
          listEl.innerHTML = videos.map(v => `
            <div data-vid="${esc(v.id)}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border2);margin-bottom:6px;">
              <div style="width:48px;height:27px;background:var(--surface3);border-radius:4px;flex-shrink:0;overflow:hidden;">
                <img src="/videos/${v.id}/thumb.jpg" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">
              </div>
              <div style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(v.title)}</div>
              <div style="display:flex;align-items:center;gap:4px;margin-right:4px;">
                <button onclick="reorderPlaylistVideo('${plId}', '${v.id}', ${v.position}, -1, this)" style="background:var(--surface3);border:1px solid var(--border2);border-radius:4px;color:var(--text);cursor:pointer;padding:2px 6px;font-size:10px;" title="Subir">▲</button>
                <span style="font-size:11px;color:var(--muted);width:24px;text-align:center;">#${v.position+1}</span>
                <button onclick="reorderPlaylistVideo('${plId}', '${v.id}', ${v.position}, 1, this)" style="background:var(--surface3);border:1px solid var(--border2);border-radius:4px;color:var(--text);cursor:pointer;padding:2px 6px;font-size:10px;" title="Bajar">▼</button>
              </div>
              <button onclick="removeFromPlaylist('${plId}','${v.id}',this)" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:18px;padding:2px 6px;line-height:1;flex-shrink:0;" title="Quitar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>`).join('');
        }
      } catch { listEl.innerHTML = '<p style="font-size:13px;color:var(--red);">Error cargando videos.</p>'; }
    }

    async function addVideoToPlaylist(plId, btn) {
      const sel = document.getElementById('pl-add-video-sel');
      const videoId = sel?.value;
      if (!videoId) return toast('Selecciona un video', 'error');
      const ogText = btn.textContent; btn.textContent = '…'; btn.disabled = true;
      try {
        const r = await apiFetch(`${BASE}/api/playlists/${plId}/videos`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_id: videoId }),
        });
        if (!r.ok) { const d = await r.json(); return toast(d.error || 'Error', 'error'); }
        toast('Video añadido a playlist');
        sel.value = '';
        const overlay = btn.closest('[data-sv-overlay]');
        if (overlay) _reloadPlaylistVideos(plId, overlay);
        loadPlaylists();
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.textContent = ogText; btn.disabled = false; }
    }

    async function removeFromPlaylist(plId, videoId, btn) {
      try {
        const item = btn.closest('[data-vid]');
        btn.disabled = true;
        const r = await apiFetch(`${BASE}/api/playlists/${plId}/videos/${videoId}`, { method: 'DELETE' });
        if (!r.ok) { btn.disabled = false; const d = await r.json().catch(() => ({})); return toast(d.error || 'Error al quitar video', 'error'); }
        item?.remove();
        toast('Video quitado de playlist');
        loadPlaylists();
      } catch { toast('Error de conexión', 'error'); btn.disabled = false; }
    }

    async function reorderPlaylistVideo(plId, videoId, currentPos, dir, btn) {
      const newPos = Math.max(0, currentPos + dir);
      if (newPos === currentPos) return;
      try {
        const r = await apiFetch(`${BASE}/api/playlists/${plId}/videos/${videoId}/position`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: newPos })
        });
        if (!r.ok) throw new Error('Error al reordenar');
        const overlay = btn.closest('[data-sv-overlay]');
        if (overlay) _reloadPlaylistVideos(plId, overlay);
      } catch(e) { toast('Error reordenando', 'error'); }
    }

    async function openAddToPlaylistModal(videoId) { const title = (allVideosCache.find(x => x.id === videoId))?.title || '';
      if (!_allPlaylists.length) {
        try {
          const r = await apiFetch(`${BASE}/api/playlists`);
          if (r.ok) _allPlaylists = await r.json();
        } catch {}
      }
      
      const overlay = document.createElement('div');
      overlay.dataset.svOverlay = '1';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.onclick = e => { if (e.target===overlay) overlay.remove() };

      const opts = _allPlaylists.map(pl => `<option value="${esc(pl.id)}">${esc(pl.title)}</option>`).join('');

      overlay.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;width:100%;max-width:400px;box-shadow:0 24px 80px rgba(0,0,0,.6);">
          <div style="padding:20px 24px 12px;display:flex;align-items:center;justify-content:space-between;">
            <h3 style="font-size:1.1rem;font-weight:700;">Añadir a Playlist</h3>
            <button class="btn btn-ghost" onclick="this.closest('[data-sv-overlay]').remove()" style="padding:4px 10px;font-size:18px;line-height:1;border-radius:8px;flex-shrink:0;" aria-label="Cerrar">×</button>
          </div>
          <div style="padding:0 24px 24px;">
            <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Agregando: <strong style="color:var(--text);">${esc(title)}</strong></p>
            ${!opts ? `<p style="font-size:13px;color:var(--amber);">No tienes playlists. Crea una en la sección de Playlists primero.</p>` : `
              <select id="pl-select-add" class="modal-input" style="margin-bottom:16px;">
                <option value="">— Selecciona una playlist —</option>
                ${opts}
              </select>
              <button class="btn btn-primary" id="pl-add-btn" style="width:100%;" onclick="doAddVideoToPlaylist('${videoId}', document.getElementById('pl-select-add').value, this.closest('[data-sv-overlay]'))">Añadir video</button>
            `}
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    
    async function doAddVideoToPlaylist(videoId, plId, overlay) {
      if (!plId) return toast('Selecciona una playlist', 'error');
      const btn = overlay.querySelector('.btn-primary');
      const ogText = btn.textContent; btn.textContent = 'Añadiendo...'; btn.disabled = true;
      try {
        const r = await apiFetch(`${BASE}/api/playlists/${plId}/videos`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_id: videoId })
        });
        if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Error al añadir'); }
        toast('Añadido a la playlist con éxito');
        overlay.remove();
        loadPlaylists(); // Refresh count
      } catch(e) {
        toast(e.message, 'error');
        btn.textContent = ogText; btn.disabled = false;
      }
    }

    // ════════════════════════════════════════════════════════════
    // ─── WATERMARK ──────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════
    function initWatermarkUI() {
      const cb = document.getElementById('cfg-watermark-enabled');
      const fields = document.getElementById('watermark-fields');
      if (!cb || !fields) return;
      const toggle = () => { fields.style.display = cb.checked ? 'flex' : 'none'; };
      cb.removeEventListener('change', toggle);
      cb.addEventListener('change', toggle);
      toggle();
    }

    async function loadWatermarkSettings() {
      if (!authWorkspace) return;
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`);
        if (!r.ok) return;
        const ws = await r.json();
        const s = ws.settings || {};
        const cb = document.getElementById('cfg-watermark-enabled');
        if (cb) cb.checked = !!s.watermark_enabled;
        const txt = document.getElementById('cfg-watermark-text');
        if (txt) txt.value = s.watermark_text || '';
        const pos = document.getElementById('cfg-watermark-position');
        if (pos) pos.value = s.watermark_position || 'bottom-right';
        const opac = document.getElementById('cfg-watermark-opacity');
        const opacVal = document.getElementById('watermark-opacity-val');
        const ov = Math.round((s.watermark_opacity || 0.5) * 100);
        if (opac) opac.value = ov;
        if (opacVal) opacVal.textContent = ov;
        initWatermarkUI();
        // Player security
        const abd = document.getElementById('cfg-adblock-detection');
        if (abd) abd.checked = !!s.adblock_detection;
        const dtb = document.getElementById('cfg-devtools-blocker');
        if (dtb) dtb.checked = !!s.devtools_blocker;
      } catch {}
    }

    function getWatermarkSettings() {
      return {
        watermark_enabled: document.getElementById('cfg-watermark-enabled')?.checked || false,
        watermark_text: document.getElementById('cfg-watermark-text')?.value?.trim() || '',
        watermark_position: document.getElementById('cfg-watermark-position')?.value || 'bottom-right',
        watermark_opacity: (parseInt(document.getElementById('cfg-watermark-opacity')?.value || '50') / 100),
      };
    }

    // ════════════════════════════════════════════════════════════
    // ─── WEBHOOKS ───────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════
    async function loadWebhooks() {
      const list = document.getElementById('webhooks-list');
      if (!list || !authWorkspace) return;
      list.innerHTML = '<div style="font-size:13px;color:var(--muted);">Cargando…</div>';
      try {
        const r = await apiFetch(`${BASE}/api/webhooks`);
        if (!r.ok) throw new Error('failed');
        const hooks = await r.json();
        if (!hooks.length) {
          list.innerHTML = '<p style="font-size:13px;color:var(--muted);">Sin webhooks configurados. Crea uno para recibir notificaciones.</p>';
          return;
        }
        list.innerHTML = hooks.map(h => `
          <div style="background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:14px 16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
              <code style="font-family:var(--mono);font-size:12px;color:var(--accent2);word-break:break-all;flex:1;">${esc(h.url)}</code>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;${h.enabled?'background:rgba(34,211,165,0.12);color:var(--green);border:1px solid rgba(34,211,165,0.2);':'background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2);'}">${h.enabled?'ACTIVO':'INACTIVO'}</span>
                <button onclick="toggleWebhook('${h.id}',${!h.enabled})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:2px 6px;font-family:var(--sans);" title="${h.enabled?'Desactivar':'Activar'}">${h.enabled?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>':'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'}</button>
                <button onclick="deleteWebhook('${h.id}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:2px 6px;line-height:1;" title="Eliminar"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${(h.events||[]).map(ev=>`<span style="font-size:10px;font-weight:700;font-family:var(--mono);padding:2px 8px;background:rgba(124,108,250,0.12);color:var(--accent2);border:1px solid rgba(124,108,250,0.2);border-radius:4px;">${esc(ev)}</span>`).join('')}
            </div>
          </div>`).join('');
      } catch {
        list.innerHTML = '<p style="font-size:13px;color:var(--red);">Error cargando webhooks.</p>';
      }
    }

    function openCreateWebhookModal() {
      document.getElementById('webhook-create-url').value = '';
      const hint = document.getElementById('webhook-url-hint');
      hint.className = 'wh-url-hint';
      hint.textContent = 'Esta URL recibirá notificaciones HTTP POST cuando ocurran eventos.';
      document.getElementById('webhook-create-btn').disabled = true;
      ['ready','failed','transcription','deleted','all'].forEach(k => {
        const el = document.getElementById('wh-ev-'+k);
        if (el) el.checked = k === 'ready' || k === 'failed';
        if (el && k !== 'all') {
          el.disabled = false;
          const card = el.closest('label');
          if (card) card.classList.remove('disabled');
        }
      });
      // Sync initial checked state for cards
      ['ready','failed','transcription','deleted'].forEach(k => {
        const cb = document.getElementById('wh-ev-'+k);
        const card = document.getElementById('wh-card-'+k);
        if (cb && card) card.classList.toggle('checked', cb.checked);
      });
      // Reset "all events" pill
      const allCb = document.getElementById('wh-ev-all');
      if (allCb) allCb.checked = false;
      const pill = document.getElementById('wh-all-pill');
      if (pill) pill.classList.remove('all-active');
      openModal('create-webhook-modal-overlay');
      setTimeout(() => document.getElementById('webhook-create-url').focus(), 80);
    }

    function validateWebhookUrl(input) {
      const url = input.value.trim();
      const hint = document.getElementById('webhook-url-hint');
      const btn = document.getElementById('webhook-create-btn');
      
      if (!url) {
        hint.className = 'wh-url-hint';
        hint.textContent = 'Esta URL recibirá notificaciones HTTP POST cuando ocurran eventos.';
        btn.disabled = true;
        input.style.borderColor = '';
        return;
      }
      
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('Invalid protocol');
        }
        hint.className = 'wh-url-hint ok';
        hint.textContent = 'URL válida';
        input.style.borderColor = 'var(--green)';
        btn.disabled = false;
      } catch (e) {
        hint.className = 'wh-url-hint error';
        hint.textContent = 'URL inválida. Usa formato: https://dominio.com/webhook';
        input.style.borderColor = 'var(--red)';
        btn.disabled = true;
      }
    }

    // Sync individual event checkbox with its card visual state
    function wh_syncCard(event) {
      if (!event || !event.target) return; // Guard against undefined
      const cb = event.target;
      if (!cb.id) return; // Guard against missing id
      const k = cb.id.replace('wh-ev-', '');
      const card = document.getElementById('wh-card-' + k);
      if (card) card.classList.toggle('checked', cb.checked);
    }

    function toggleAllWebhookEvents(cb) {
      ['ready','failed','transcription','deleted'].forEach(k => {
        const el = document.getElementById('wh-ev-'+k);
        if (el) {
          el.checked = false;
          el.disabled = cb.checked;
          const label = el.closest('label');
          if (label) label.classList.toggle('disabled', cb.checked);
        }
        // Sync card visual state
        const card = document.getElementById('wh-card-' + k);
        if (card) {
          card.classList.remove('checked');
          if (cb.checked) card.style.opacity = '0.5';
          else card.style.opacity = '';
        }
      });
      // Sync "all events" pill
      const pill = document.getElementById('wh-all-pill');
      if (pill) pill.classList.toggle('all-active', cb.checked);
    }

    async function submitCreateWebhook() {
      const url = document.getElementById('webhook-create-url').value.trim();
      const btn = document.getElementById('webhook-create-btn');
      
      if (!url) { 
        document.getElementById('webhook-create-url').focus(); 
        return toast('La URL es requerida', 'error'); 
      }
      
      // Validate URL
      try { 
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return toast('La URL debe usar protocolo HTTP o HTTPS', 'error');
        }
      } catch { 
        return toast('URL inválida', 'error'); 
      }
      
      // Get selected events
      const all = document.getElementById('wh-ev-all')?.checked;
      const events = all ? ['*'] : ['ready','failed','transcription','deleted']
        .filter(k => document.getElementById('wh-ev-'+k)?.checked)
        .map(k => ({'ready':'video.ready','failed':'video.failed','transcription':'transcription.complete','deleted':'video.deleted'})[k]);
      
      if (!events.length) {
        return toast('Selecciona al menos un evento', 'error');
      }
      
      // Disable button during request
      btn.disabled = true;
      const originalText = btn.innerHTML;
      btn.innerHTML = '<div style="width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;"></div> Creando...';
      
      try {
        const r = await apiFetch(`${BASE}/api/webhooks`, {
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, events }),
        });
        const d = await r.json();
        
        if (!r.ok) {
          btn.disabled = false;
          btn.innerHTML = originalText;
          return toast(d.error || 'Error creando webhook', 'error');
        }
        
        closeModal('create-webhook-modal-overlay');
        toast('Webhook creado correctamente', 'success');
        
        // Show secret if provided
        if (d.secret) {
          const m = document.createElement('div');
          m.className = 'modal-overlay';
          m.style.display = 'flex';
          m.innerHTML = `
            <div class="modal-card" style="max-width:520px;">
              <div class="modal-head">
                <h3><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:5px;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Secreto del Webhook</h3>
                <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" style="padding:4px 10px;font-size:18px;line-height:1;border-radius:8px;flex-shrink:0;" aria-label="Cerrar">×</button>
              </div>
              <div class="modal-body">
                <p style="color:var(--muted);font-size:13px;margin-bottom:14px;line-height:1.6;">
                  Guarda este secreto HMAC en un lugar seguro. Úsalo para verificar la firma de las notificaciones. 
                  <strong style="color:var(--red);">No podrás verlo de nuevo.</strong>
                </p>
                <div style="background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:14px;margin-bottom:14px;position:relative;">
                  <code style="font-family:var(--mono);font-size:12px;word-break:break-all;color:var(--text);display:block;line-height:1.6;">${esc(d.secret)}</code>
                </div>
              </div>
              <div class="modal-foot">
                <button class="btn btn-ghost" data-secret="${esc(d.secret)}" onclick="navigator.clipboard.writeText(this.dataset.secret).then(()=>toast('Secreto copiado al portapapeles','success'))">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                  </svg>
                  Copiar secreto
                </button>
                <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">Entendido</button>
              </div>
            </div>`;
          document.body.appendChild(m);
          setTimeout(() => m.style.opacity = '1', 10);
        }
        
        // Reload webhooks list
        loadWebhooks();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = originalText;
        toast('Error de conexión. Intenta de nuevo.', 'error');
      }
    }

    async function toggleWebhook(id, enabled) {
      await apiFetch(`${BASE}/api/webhooks/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      toast(enabled ? 'Webhook activado' : 'Webhook desactivado');
      loadWebhooks();
    }

    async function deleteWebhook(id) {
      const ok = await confirmModal('¿Eliminar webhook?', 'No se enviarán más notificaciones a este endpoint.', 'Eliminar', 'Cancelar', true);
      if (!ok) return;
      const r = await apiFetch(`${BASE}/api/webhooks/${id}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(d.error || 'Error al eliminar webhook', 'error'); }
      toast('Webhook eliminado');
      loadWebhooks();
    }

    // ════════════════════════════════════════════════════════════
    // ─── REFERIDOS ──────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════
    async function loadReferralInfo() {
      if (!authUser) return;
      // Show referral code from user profile
      const codeEl = document.getElementById('referral-code-display');
      // The referral code is generated from user ID — derive it client-side
      // (same logic as server: first 8 chars of UUID without dashes, uppercase)
      const code = authUser.referral_code || (authUser.id || '').replace(/-/g,'').slice(0,8).toUpperCase();
      if (codeEl) codeEl.textContent = code;

      // Load referral stats from auth/me
      try {
        const r = await apiFetch(`${BASE}/auth/me`);
        if (r.ok) {
          const d = await r.json();
          const refs = d.referrals || {};
          const total = document.getElementById('ref-total');
          const converted = document.getElementById('ref-converted');
          const pending = document.getElementById('ref-pending');
          if (total) total.textContent = refs.total ?? 0;
          if (converted) converted.textContent = refs.converted ?? 0;
          if (pending) pending.textContent = (refs.total - refs.converted) > 0 ? (refs.total - refs.converted) : 0;
        }
      } catch {}
    }

    function copyReferralCode() {
      const code = document.getElementById('referral-code-display')?.textContent;
      if (!code || code === '—') return toast('Código no disponible', 'error');
      navigator.clipboard.writeText(code).then(() => toast('Código copiado'));
    }

    function copyReferralLink() {
      const code = document.getElementById('referral-code-display')?.textContent;
      if (!code || code === '—') return toast('Código no disponible', 'error');
      const link = `${BASE}/login?ref=${code}`;
      navigator.clipboard.writeText(link).then(() => toast('Enlace de referido copiado'));
    }

    // ════════════════════════════════════════════════════════════
    // ─── PUBLISH_AT (DateTimePicker en Edit Modal) ──────────────
    // ════════════════════════════════════════════════════════════
    function injectPublishAtField() {
      // Inject a datetime-local field into the edit modal if not already there
      if (document.getElementById('edit-publish-at')) return;
      const body = document.querySelector('#edit-modal-overlay .modal-body');
      if (!body) return;
      const wrap = document.createElement('div');
      wrap.className = 'modal-input-group';
      wrap.id = 'edit-publish-at-group';
      wrap.innerHTML = `
        <label for="edit-publish-at" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Publicación programada</span>
          <button type="button" onclick="clearPublishAt()" style="font-size:11px;background:none;border:none;color:var(--muted);cursor:pointer;font-family:var(--sans);">Limpiar</button>
        </label>
        <input type="datetime-local" id="edit-publish-at" class="modal-input"
          style="color-scheme:dark;"
          title="Dejar vacío para publicar inmediatamente">
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">Si estableces una fecha futura, el video permanecerá en estado "Programado" hasta esa fecha.</div>`;
      // Insert before the foot
      body.appendChild(wrap);
    }

    function clearPublishAt() {
      const el = document.getElementById('edit-publish-at');
      if (el) el.value = '';
    }

    function copyShortLinkFromModal() {
      const urlEl = document.getElementById('edit-short-link-url');
      if (urlEl?.textContent) navigator.clipboard.writeText(urlEl.textContent).then(() => toast('Short link copiado'));
    }

    // openEditModal override — adds publish_at field + single handler
    openEditModal = async function(id) {
      const video = allVideosCache.find(v => v.id === id);
      if (!video) return;
      _editModalVideoId = id;
      // Short link info row
      const shortRow = document.getElementById('edit-short-link-row');
      const shortUrlEl = document.getElementById('edit-short-link-url');
      if (shortRow && shortUrlEl) {
        if (video.short_code) {
          shortUrlEl.textContent = `${BASE}/v/${video.short_code}`;
          shortRow.style.display = 'flex';
        } else {
          shortRow.style.display = 'none';
        }
      }
      document.getElementById('edit-video-title').value = video.title || '';
      document.getElementById('edit-video-desc').value = video.description || '';
      const visSelect = document.getElementById('edit-visibility');
      visSelect.value = video.visibility || 'public';
      onVisibilityChange();
      document.getElementById('edit-access-password').value = '';
      // Tags
      _editTags = Array.isArray(video.tags) ? [...video.tags] : [];
      renderEditTags();
      if (document.getElementById('tag-text-input')) document.getElementById('tag-text-input').value = '';
      // Expires at
      const expiresEl = document.getElementById('edit-expires-at');
      if (expiresEl) {
        if (video.expires_at && video.expires_at > 0) {
          const d = new Date(video.expires_at * 1000);
          const pad = n => String(n).padStart(2,'0');
          expiresEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } else {
          expiresEl.value = '';
        }
      }
      // Reset thumbnail file input and preview
      const thumbInput = document.getElementById('edit-thumb-file');
      if (thumbInput) thumbInput.value = '';
      const thumbPreview = document.getElementById('edit-thumb-preview');
      if (thumbPreview) { thumbPreview.style.display = 'none'; thumbPreview.src = ''; }
      // Skip intro / outro
      document.getElementById('edit-intro-start').value = video.intro_start > 0 ? video.intro_start : '';
      document.getElementById('edit-intro-end').value   = video.intro_end   > 0 ? video.intro_end   : '';
      document.getElementById('edit-outro-start').value = video.outro_start > 0 ? video.outro_start : '';
      document.getElementById('edit-outro-end').value   = video.outro_end   > 0 ? video.outro_end   : '';
      // TMDB
      const tmdbIdInput = document.getElementById('edit-tmdb-id');
      const tmdbTypeInput = document.getElementById('edit-tmdb-type');
      const tmdbPreviewDiv = document.getElementById('tmdb-edit-preview');
      if (tmdbIdInput) {
        tmdbIdInput.value = video.tmdb_id || '';
        tmdbIdInput.oninput = () => updateEditThumbUI(id);
      }
      if (tmdbTypeInput) tmdbTypeInput.value = video.tmdb_type || 'movie';
      if (tmdbPreviewDiv) tmdbPreviewDiv.style.display = 'none';
      // Thumbnail preview
      updateEditThumbUI(id);
      // Inject & populate publish_at field
      injectPublishAtField();
      const paEl = document.getElementById('edit-publish-at');
      if (paEl) {
        if (video.publish_at && video.publish_at > 0) {
          const d = new Date(video.publish_at * 1000);
          const pad = n => String(n).padStart(2,'0');
          paEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } else {
          paEl.value = '';
        }
      }
      // AI suggestions — always reset both panels first
      const aiPanel = document.getElementById('ai-suggestions-panel');
      const aiTitleEl = document.getElementById('ai-title-suggestion');
      const aiDescEl = document.getElementById('ai-desc-suggestion');
      let showAiPanel = false;
      if (video.ai_title && aiTitleEl) {
        aiTitleEl.style.display = 'block';
        document.getElementById('ai-title-text').textContent = video.ai_title;
        showAiPanel = true;
      } else if (aiTitleEl) {
        aiTitleEl.style.display = 'none';
      }
      if (video.ai_description && aiDescEl) {
        aiDescEl.style.display = 'block';
        document.getElementById('ai-desc-text').textContent = video.ai_description;
        showAiPanel = true;
      } else if (aiDescEl) {
        aiDescEl.style.display = 'none';
      }
      if (aiPanel) aiPanel.style.display = showAiPanel ? 'block' : 'none';
      // Single save handler — clone to remove any prior listeners
      const saveBtn = document.getElementById('edit-modal-save-btn');
      const newSaveBtn = saveBtn.cloneNode(true);
      saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
      newSaveBtn.addEventListener('click', async function() {
        const vis = document.getElementById('edit-visibility').value;
        const pw  = document.getElementById('edit-access-password').value;
        if (vis === 'password' && !pw && video.visibility !== 'password') {
          return toast('Debes ingresar una contraseña', 'error');
        }
        newSaveBtn.disabled = true;
        newSaveBtn.innerHTML = '<span class="spinner"></span> Guardando…';
        try {
          const body = {
            title: document.getElementById('edit-video-title').value.trim(),
            description: document.getElementById('edit-video-desc').value.trim(),
            visibility: vis,
          };
          if (pw) body.access_password = pw;
          const paVal = document.getElementById('edit-publish-at')?.value;
          body.publish_at = paVal ? Math.floor(new Date(paVal).getTime() / 1000) : null;
          const introStartVal = document.getElementById('edit-intro-start').value;
          const introVal      = document.getElementById('edit-intro-end').value;
          const outroVal      = document.getElementById('edit-outro-start').value;
          const outroEndVal   = document.getElementById('edit-outro-end').value;
          body.intro_start = introStartVal !== '' ? parseInt(introStartVal) : null;
          body.intro_end   = introVal      !== '' ? parseInt(introVal)      : null;
          body.outro_start = outroVal      !== '' ? parseInt(outroVal)      : null;
          body.outro_end   = outroEndVal   !== '' ? parseInt(outroEndVal)   : null;
          body.tmdb_id   = document.getElementById('edit-tmdb-id')?.value.trim() || null;
          body.tmdb_type = document.getElementById('edit-tmdb-type')?.value || 'movie';
          body.tags = _editTags;
          const expiresVal = document.getElementById('edit-expires-at')?.value;
          body.expires_at = expiresVal ? Math.floor(new Date(expiresVal).getTime() / 1000) : null;
          const r = await apiFetch(`/api/videos/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const thumbFile = document.getElementById('edit-thumb-file');
          if (thumbFile?.files.length) {
            const fd = new FormData();
            fd.append('thumbnail', thumbFile.files[0]);
            await apiFetch(`/api/videos/${id}/thumbnail`, { method: 'POST', body: fd });
          }
          if (r.ok) { toast('Video actualizado'); closeModal('edit-modal-overlay'); loadVideos(); }
          else { const d = await r.json().catch(()=>({})); toast(d.error || 'Error al actualizar', 'error'); }
        } catch { toast('Error de conexión', 'error'); }
        finally { newSaveBtn.disabled = false; newSaveBtn.textContent = 'Guardar cambios'; }
      });
      openModal('edit-modal-overlay');
    };

    // ─── TMDB preview in edit modal ──────────────────────────────
    previewTmdbEdit = async function() {
      const id = _editModalVideoId;
      const tmdbId = document.getElementById('edit-tmdb-id')?.value.trim();
      const tmdbType = document.getElementById('edit-tmdb-type')?.value || 'movie';
      if (!id || !tmdbId) return toast('Ingresa un ID de TMDB primero', 'error');
      const btn = document.getElementById('tmdb-preview-btn');
      const div = document.getElementById('tmdb-edit-preview');
      if (!btn || !div) return;
      btn.disabled = true;
      btn.textContent = 'Cargando…';
      try {
        if (!authWorkspace?.id) { return toast('No hay workspace activo', 'error'); }
        const r = await apiFetch(`/api/workspaces/${authWorkspace.id}/tmdb?tmdb_id=${encodeURIComponent(tmdbId)}&tmdb_type=${encodeURIComponent(tmdbType)}`);
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          const msg = d.error === 'no_tmdb_key' ? 'Configura primero tu token de TMDB en Configuración → General' :
                      'No se encontró el título en TMDB. Verifica el ID.';
          div.style.display = 'none';
          return toast(msg, 'error');
        }
        const data = await r.json();
        const cast = (data.credits?.cast || []).slice(0, 12);
        const director = (data.credits?.crew || []).find(c => c.job === 'Director');
        const title = data.title || data.name || '';
        const year = (data.release_date || data.first_air_date || '').slice(0, 4);
        div.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
            ${data.poster_path ? `<img src="https://image.tmdb.org/t/p/w92${data.poster_path}" alt="" style="width:46px;height:69px;border-radius:6px;object-fit:cover;flex-shrink:0;">` : ''}
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text);">${esc(title)}${year ? ` <span style="color:var(--muted);font-weight:400;font-size:12px;">(${year})</span>` : ''}</div>
              ${director ? `<div style="font-size:12px;color:var(--muted);margin-top:3px;">Dir. ${esc(director.name)}</div>` : ''}
            </div>
          </div>
          ${cast.length ? `<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;">Reparto principal</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:8px;">
            ${cast.map(p => `
              <div style="text-align:center;">
                <img src="${p.profile_path ? `https://image.tmdb.org/t/p/w92${p.profile_path}` : ''}" alt=""
                  style="width:52px;height:52px;border-radius:50%;object-fit:cover;background:var(--surface3);margin:0 auto 4px;display:block;"
                  onerror="this.style.background='var(--surface3)';this.src=''">
                <div style="font-size:10px;font-weight:600;color:var(--text);line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</div>
                <div style="font-size:9px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.character || '')}</div>
              </div>`).join('')}
          </div>` : '<div style="font-size:12px;color:var(--muted);">Sin información de reparto disponible.</div>'}
        `;
        div.style.display = 'block';
      } catch { toast('Error al conectar con TMDB', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Previsualizar reparto'; }
    }

    // ════════════════════════════════════════════════════════════
    // ─── STRIPE CHECKOUT / UPGRADE PLAN ─────────────────────────
    // ════════════════════════════════════════════════════════════
    async function loadUpgradePlans() {
      if (!authWorkspace) return;
      const card = document.getElementById('upgrade-plan-card');
      const grid = document.getElementById('upgrade-plans-grid');
      if (!card || !grid) return;
      try {
        const r = await apiFetch(`${BASE}/api/billing/status`);
        if (!r.ok) { card.style.display = 'none'; return; }
        const data = await r.json();
        const currentPlan = data.plan || 'starter';
        const plans = (data.availablePlans || []).filter(p => p.key !== currentPlan && p.key !== 'starter');
        if (!plans.length) { card.style.display = 'none'; return; }
        card.style.display = 'block';
        const planColors = { pro: 'rgba(124,108,250,0.15)', enterprise: 'rgba(34,211,165,0.12)' };
        const planBorders = { pro: 'rgba(124,108,250,0.3)', enterprise: 'rgba(34,211,165,0.25)' };
        grid.innerHTML = plans.map(p => `
          <div style="background:${planColors[p.key]||'var(--surface2)'};border:1px solid ${planBorders[p.key]||'var(--border2)'};border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:${p.key==='pro'?'var(--accent2)':'var(--green)'};">${esc(p.name)}</div>
            <div style="font-size:22px;font-weight:700;font-family:var(--mono);">${p.price > 0 ? '$'+p.price+'/mo' : 'Custom'}</div>
            <ul style="list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);">
              <li><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg> ${p.maxVideos < 0 ? 'Ilimitados' : p.maxVideos + ' videos'}</li>
              <li><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg> ${p.maxStorageGB} GB almacenamiento</li>
              <li><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg> ${p.maxBandwidthGB} GB/mes bandwidth</li>
            </ul>
            <button class="btn btn-primary" style="width:100%;padding:9px;font-size:13px;margin-top:4px;" onclick="startCheckout('${p.key}')">
              Actualizar a ${esc(p.name)}
            </button>
          </div>`).join('');
      } catch { card.style.display = 'none'; }
    }

    async function startCheckout(planKey) {
      if (!authWorkspace) return toast('Workspace requerido', 'error');
      try {
        const r = await apiFetch(`${BASE}/api/billing/checkout`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: planKey }),
        });
        const d = await r.json();
        if (!r.ok) {
          if (d.error?.includes('not configured') || d.error?.includes('Stripe not configured')) {
            return toast('Stripe no configurado — agrega STRIPE_SECRET_KEY en .env', 'error');
          }
          return toast(d.error || 'Error al iniciar pago', 'error');
        }
        if (d.checkoutUrl) window.location.href = d.checkoutUrl;
      } catch { toast('Error de conexión', 'error'); }
    }

    // Handle billing return params
    (() => {
      const p = new URLSearchParams(window.location.search);
      if (p.get('billing') === 'success') {
        toast('¡Plan actualizado exitosamente!');
        history.replaceState({}, '', '/dashboard');
      } else if (p.get('billing') === 'cancel') {
        toast('Pago cancelado.', 'error');
        history.replaceState({}, '', '/dashboard');
      }
    })();

    // ════════════════════════════════════════════════════════════
    // ─── FEATURE FLAGS — show/hide nav items dynamically ────────
    // ════════════════════════════════════════════════════════════
    // ─── Global features cache ────────────────────────────────────
    let _cachedFeatures = {};

    async function applyFeatureFlags() {
      try {
        // Enviar token + workspace para obtener features efectivos del plan del usuario
        const headers = {};
        if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
        if (authWorkspace?.id) headers['X-Workspace-Id'] = authWorkspace.id;
        const r = await fetch(`${BASE}/api/settings`, { headers });
        if (!r.ok) return;
        const d = await r.json();
        const f = d.features || {};
        _cachedFeatures = f; // Cache for dynamic checks
        if (d.supportEmail) window._svSupportEmail = d.supportEmail;
        if (d.siteName) {
          window._svSiteName = d.siteName;
          document.title = d.siteName + ' — Dashboard';
          document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = d.siteName; });
          document.querySelectorAll('[data-brand-name-version]').forEach(el => { el.textContent = d.siteName + ' v1.0'; });
        }
        // CNAME target + description host
        const _host = location.hostname;
        const _dnsVal = document.getElementById('dns-value-field');
        if (_dnsVal) _dnsVal.textContent = _host;
        document.querySelectorAll('[data-brand-host]').forEach(el => { el.textContent = _host; });

        const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };
        const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

        // ── Playlists ────────────────────────────────────────────────────────
        if (f.playlistsEnabled === false) {
          hide('nav-playlists');
          if (typeof currentSection !== 'undefined' && currentSection === 'playlists') goSection(null, 'videos');
        } else show('nav-playlists');

        // ── Analytics ────────────────────────────────────────────────────────
        // analyticsEnabled puede ser: false | 'basic' | 'full' | true
        if (f.analyticsEnabled === false) {
          hide('nav-analytics');
          if (typeof currentSection !== 'undefined' && currentSection === 'analytics') goSection(null, 'videos');
        } else {
          show('nav-analytics');
          // Mostrar badge del tier de analytics en el nav
          const navAnalytics = document.getElementById('nav-analytics');
          if (navAnalytics) {
            let existingBadge = navAnalytics.querySelector('.feature-tier-badge');
            if (!existingBadge) {
              existingBadge = document.createElement('span');
              existingBadge.className = 'feature-tier-badge';
              existingBadge.style.cssText = 'font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;margin-left:auto;flex-shrink:0;';
              navAnalytics.appendChild(existingBadge);
            }
            if (f.analyticsEnabled === 'basic') {
              existingBadge.textContent = 'BASIC';
              existingBadge.style.background = 'rgba(251,191,36,0.15)';
              existingBadge.style.color = 'var(--amber)';
            } else {
              existingBadge.textContent = 'FULL';
              existingBadge.style.background = 'rgba(34,211,165,0.15)';
              existingBadge.style.color = 'var(--green)';
            }
          }
        }

        // ── Folders ──────────────────────────────────────────────────────────
        const folderBtn = document.querySelector('.folder-add-btn');
        const folderFilter = document.getElementById('library-filter-folder');
        if (f.foldersEnabled === false) {
          if (folderBtn) folderBtn.style.display = 'none';
          if (folderFilter) folderFilter.style.display = 'none';
        } else {
          if (folderBtn) folderBtn.style.display = '';
        }

        // ── Bulk operations ──────────────────────────────────────────────────
        if (f.bulkOperationsEnabled === false) {
          hide('bulk-bar');
          document.querySelectorAll('.vcard-check,.vt-row-check,#vt-select-all').forEach(el => el.style.display = 'none');
        }

        // ── Settings cards ───────────────────────────────────────────────────
        if (f.webhooksEnabled === false) hide('webhooks-card'); else show('webhooks-card');
        if (f.watermarkEnabled === false) hide('watermark-card'); else show('watermark-card');
        if (f.apiKeysEnabled === false) hide('apikeys-card'); else show('apikeys-card');
        if (f.referralEnabled === false) hide('referidos-card'); else show('referidos-card');

        // ── Transcriptions ───────────────────────────────────────────────────
        if (f.transcriptionsEnabled === false) {
          hide('transcription-panel');
          hide('openai-settings-card');
        } else {
          show('transcription-panel');
          show('openai-settings-card');
        }

        // ── Subtitle tracks / Multi-audio (Upload modal tabs) ────────────────
        const subTracksTab = document.getElementById('track-tab-subtitle');
        const audioTracksTab = document.getElementById('track-tab-audio');
        if (subTracksTab) subTracksTab.style.display = f.subtitleTracksEnabled === false ? 'none' : '';
        if (audioTracksTab) audioTracksTab.style.display = f.multiAudioEnabled === false ? 'none' : '';

        // ── Embed tier ───────────────────────────────────────────────────────
        // embedEnabled puede ser: false | 'branded' | 'unbranded' | 'custom'
        // branded     = embed disponible pero con logo de plataforma visible
        // unbranded   = embed sin logo/marca de plataforma (plan Pro)
        // custom      = embed totalmente personalizable con logo propio (Enterprise)
        // false       = embed deshabilitado (plan sin embed)
        const embedCard = document.getElementById('embed-code-card');
        const embedTierBadge = document.getElementById('embed-tier-badge');
        const embedTierInfo = document.getElementById('embed-tier-info');
        const embedCustomFields = document.getElementById('embed-custom-fields');

        const embedVal = f.embedEnabled;
        if (embedVal === false) {
          // Sin acceso a embed
          if (embedCard) {
            const lockHtml = `<div id="embed-locked-msg" style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center;gap:12px;background:rgba(124,108,250,0.05);border:1px dashed rgba(124,108,250,0.2);border-radius:10px;">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <div style="font-size:14px;font-weight:700;color:var(--text);">Embed no disponible en tu plan</div>
              <div style="font-size:12px;color:var(--muted);max-width:320px;">Actualiza a un plan superior para poder embeber videos en tu sitio web.</div>
              <button class="btn btn-primary" style="margin-top:4px;font-size:12px;padding:8px 16px;" onclick="goSection(null,'settings');setTimeout(()=>switchSettingsTab('billing'),200);">Ver planes</button>
            </div>`;
            // Ocultar el contenido normal y mostrar mensaje
            const normalContent = embedCard.querySelector('#embed-normal-content');
            if (normalContent) normalContent.style.display = 'none';
            if (!embedCard.querySelector('#embed-locked-msg')) {
              const div = document.createElement('div');
              div.innerHTML = lockHtml;
              embedCard.appendChild(div.firstElementChild);
            }
          }
        } else {
          // Embed disponible — remover lock si existía y mostrar contenido normal
          if (embedCard) {
            const lockMsg = embedCard.querySelector('#embed-locked-msg');
            if (lockMsg) lockMsg.remove();
            const normalContent = embedCard.querySelector('#embed-normal-content');
            if (normalContent) normalContent.style.display = '';
          }
          // Normalizar embedVal: true se trata como 'custom' si plan es enterprise
          const effectiveEmbed = (embedVal === true) ? 'custom' : (embedVal || 'branded');
          if (embedTierBadge) {
            const tierLabels = {
              'branded':   { text: 'BRANDED', bg: 'rgba(124,108,250,0.15)', color: 'var(--accent2)' },
              'unbranded': { text: 'UNBRANDED', bg: 'rgba(34,211,165,0.12)', color: 'var(--green)' },
              'custom':    { text: 'CUSTOM', bg: 'rgba(251,191,36,0.12)', color: 'var(--amber)' },
            };
            const tl = tierLabels[effectiveEmbed] || tierLabels['branded'];
            embedTierBadge.textContent = tl.text;
            embedTierBadge.style.background = tl.bg;
            embedTierBadge.style.color = tl.color;
            embedTierBadge.style.display = 'inline-block';
          }
          if (embedTierInfo) {
            const infoMessages = {
              'branded':   `Tu plan incluye embed <b>Branded</b>: el player mostrará el logo de ${window._svSiteName||'StreamVault'}. Actualiza a Pro para remover la marca.`,
              'unbranded': `Tu plan incluye embed <b>Unbranded</b>: el player se muestra sin marca de ${window._svSiteName||'StreamVault'}.`,
              'custom':    'Tu plan incluye embed <b>Custom</b>: puedes personalizar completamente el player con tu propio logo, colores y dominio.',
            };
            embedTierInfo.innerHTML = infoMessages[embedVal] || '';
            embedTierInfo.style.display = 'block';
          }
          // Campos de personalización: solo disponibles en 'custom' (Enterprise)
          if (embedCustomFields) {
            embedCustomFields.style.display = (effectiveEmbed === 'custom') ? '' : 'none';
          }
          // Logo URL: disponible en unbranded y custom, oculto en branded
          const logoGroup = document.getElementById('embed-logo-group');
          if (logoGroup) {
            logoGroup.style.display = (effectiveEmbed === 'branded') ? 'none' : '';
          }
          // Player name: solo en custom
          const playerNameGroup = document.getElementById('embed-player-name-group');
          if (playerNameGroup) {
            playerNameGroup.style.display = (effectiveEmbed === 'custom') ? '' : 'none';
          }
        }

        // ── Ads configuration ────────────────────────────────────────────────
        // ads-card se muestra si el feature adsEnabled está activo para el plan.
        // ADS solo disponible en Pro (unbranded) y Enterprise (custom).
        // Plan Starter (branded) NO tiene acceso a configuración de anuncios.
        const adsCard = document.getElementById('ads-card');
        if (adsCard) {
          const adsEnabled = f.adsEnabled;
          // Mostrar ads si adsEnabled no está explícitamente en false
          const showAds = (adsEnabled !== false);
          adsCard.style.display = showAds ? '' : 'none';

          // ── Badge de estado del plan en el card de Ads ──────────────────────
          const adsPlanBadge = document.getElementById('ads-plan-badge');
          if (adsPlanBadge && showAds) {
            const hasAdsConfig = !!(authWorkspace?.settings?.ads?.type);
            if (hasAdsConfig) {
              const typeLabels = { vast: 'VAST', banner: 'BANNER', popup: 'POPUP', all: 'TODOS' };
              const adsType = authWorkspace.settings.ads.type || 'vast';
              adsPlanBadge.textContent = typeLabels[adsType] || adsType.toUpperCase();
              adsPlanBadge.style.background = 'rgba(34,211,165,0.12)';
              adsPlanBadge.style.color = 'var(--green, #22d3a5)';
              adsPlanBadge.style.display = 'inline-block';
            } else {
              adsPlanBadge.textContent = 'SIN CONFIGURAR';
              adsPlanBadge.style.background = 'rgba(255,255,255,0.07)';
              adsPlanBadge.style.color = 'var(--muted, rgba(255,255,255,0.4))';
              adsPlanBadge.style.display = 'inline-block';
            }
          } else if (adsPlanBadge) {
            adsPlanBadge.style.display = 'none';
          }
        }

        // ── Custom Domain ────────────────────────────────────────────────────
        const customDomainSection = document.getElementById('custom-domain-section');
        if (customDomainSection) {
          customDomainSection.style.display = f.customDomainEnabled ? '' : 'none';
        }

        // ── Multi-workspace ──────────────────────────────────────────────────
        // Re-render workspace switcher to show/hide "Crear workspace" button
        updateAuthBar();

        // ── Invitations ──────────────────────────────────────────────────────
        const teamTabBtn = document.querySelector('.stab-btn[data-tab="equipo"]');
        if (f.invitationsEnabled === false) {
          if (teamTabBtn) teamTabBtn.style.display = 'none';
          if (_activeStab === 'equipo') switchSettingsTab('perfil');
          const teamCard = document.getElementById('team-card');
          if (teamCard) {
            const invBtn = teamCard.querySelector('button[onclick*="openInviteModal"]');
            if (invBtn) invBtn.style.display = 'none';
          }
        } else {
          if (teamTabBtn) teamTabBtn.style.display = '';
        }

        // ── Re-render video cards ────────────────────────────────────────────
        // Los botones en los más-menú (download, tracks, embed, folders, playlists)
        // se controlan inline via _cachedFeatures en el template. Forzar re-render
        // si el cache de videos ya está disponible para aplicar los cambios.
        if (typeof applyLibraryFilters === 'function' && allVideosCache?.length > 0) {
          applyLibraryFilters();
        }

      } catch (err) {
        console.error('[applyFeatureFlags] Error:', err);
      }
    }

    // ─── Admin email endpoint (for admin panel) ─────────────────

    // ════════════════════════════════════════════════════════════
    // ─── Single unified loadSettings (replaces all patches) ─────
    loadSettings = async function() {
      if (!authToken || !authWorkspace) {
        document.getElementById('settings-login-required').style.display = 'block';
        document.getElementById('settings-form').style.display = 'none';
        return;
      }
      document.getElementById('settings-login-required').style.display = 'none';
      document.getElementById('settings-form').style.display = 'block';
      
      // Restaurar la pestaña guardada o usar 'general' por defecto
      const savedTab = sessionStorage.getItem('sv_settings_tab') || 'perfil';
      const validTabs = ['perfil', 'general', 'acceso', 'api', 'billing', 'equipo', 'cuenta'];
      _activeStab = validTabs.includes(savedTab) ? savedTab : 'perfil';
      
      switchSettingsTab(_activeStab);
      // Declarar ws fuera del try para que sea accesible en loadAdsConfiguration
      let ws = null;
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`);
        if (!r.ok) return;
        ws = await r.json();
        // Sincronizar authWorkspace.settings con datos frescos del servidor
        // (authWorkspace viene de auth/me y puede tener settings desactualizados)
        if (ws.settings) authWorkspace.settings = ws.settings;
        const s = ws.settings || {};
        document.getElementById('cfg-player-name').value = s.embedPlayerName || '';
        document.getElementById('cfg-logo-url').value = s.embedLogo || '';
        const color = s.embedColor || '#7c6cfa';
        document.getElementById('cfg-color-picker').value = color;
        document.getElementById('cfg-color-hex').value = color;
        document.getElementById('cfg-domains').value = (s.embedAllowedDomains || []).join('\n');
        // TMDB
        const tmdbEl = document.getElementById('cfg-tmdb-key');
        if (tmdbEl) { tmdbEl.value = ''; tmdbEl.placeholder = s.tmdbApiKey === '__set__' ? 'Configurada — escribe para cambiar' : 'eyJhbGciOiJIUzI1NiJ9...'; }
        // OpenAI API Key
        const openaiEl = document.getElementById('cfg-openai-key');
        if (openaiEl) { openaiEl.value = ''; openaiEl.placeholder = s.openaiApiKey === '__set__' ? 'Configurada — escribe para cambiar' : 'sk-...'; }
        // Watermark
        const cb = document.getElementById('cfg-watermark-enabled');
        if (cb) cb.checked = !!s.watermark_enabled;
        const txt = document.getElementById('cfg-watermark-text');
        if (txt) txt.value = s.watermark_text || '';
        const pos = document.getElementById('cfg-watermark-position');
        if (pos) pos.value = s.watermark_position || 'bottom-right';
        const opac = document.getElementById('cfg-watermark-opacity');
        const opacVal = document.getElementById('watermark-opacity-val');
        const ov = Math.round((s.watermark_opacity || 0.5) * 100);
        if (opac) opac.value = ov;
        if (opacVal) opacVal.textContent = ov;
        initWatermarkUI();
        // Access & Security toggles
        const dl = document.getElementById('cfg-downloads-enabled');
        if (dl) dl.checked = s.downloadsEnabled !== false;
        const ch2 = document.getElementById('cfg-channel-enabled');
        if (ch2) ch2.checked = s.channelEnabled !== false;
        const em = document.getElementById('cfg-embed-enabled');
        if (em) em.checked = s.embedEnabled !== false;
        const pp = document.getElementById('cfg-playlists-public');
        if (pp) pp.checked = s.playlistsPublic !== false;
        const hp = document.getElementById('cfg-hotlink-protection');
        if (hp) hp.checked = !!s.hotlinkProtection;
        const rtk = document.getElementById('cfg-require-tokens');
        if (rtk) rtk.checked = !!s.requireTokensAlways;
        // Player security
        const abd = document.getElementById('cfg-adblock-detection');
        if (abd) abd.checked = !!s.adblock_detection;
        const dtb = document.getElementById('cfg-devtools-blocker');
        if (dtb) dtb.checked = !!s.devtools_blocker;
      } catch {}
      // Embed video selector
      try {
        const r = await apiFetch(`${BASE}/api/videos?limit=200`);
        const json = await r.json();
        const videos = json.videos || (Array.isArray(json) ? json : []);
        const sel = document.getElementById('embed-video-select');
        sel.innerHTML = '<option value="">— Selecciona un video —</option>' +
          videos.filter(v => v.status === 'ready').map(v =>
            `<option value="${esc(v.id)}">${esc(v.title)}</option>`
          ).join('');
      } catch {}
      // Secondary loads (parallel)
      await Promise.allSettled([
        loadApiKeys(),
        loadTeamMembers(),
        loadPlanUsage(),
        loadWebhooks(),
        loadReferralInfo(),
        loadUpgradePlans(),
      ]);
      applyWhiteLabelUI(authWorkspace?.plan || 'starter');
      loadProfileData();
      // Cargar configuración de ADS desde ws.settings (necesario en el loadSettings unificado)
      if (ws) loadAdsConfiguration(ws.settings);
      if (ws) loadCustomDomainConfiguration(ws);
    };

    // ─── Single unified saveSettings ─────────────────────────────
    saveSettings = async function() {
      if (!authToken || !authWorkspace) return toast('Inicia sesión primero', 'error');
      const color = document.getElementById('cfg-color-hex').value.trim() || document.getElementById('cfg-color-picker').value;
      const domainsRaw = document.getElementById('cfg-domains').value.trim();
      const domains = domainsRaw ? domainsRaw.split('\n').map(d => d.trim()).filter(Boolean) : [];
      const settings = {
        embedPlayerName: document.getElementById('cfg-player-name').value.trim(),
        embedLogo: document.getElementById('cfg-logo-url').value.trim(),
        embedColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#7c6cfa',
        embedAllowedDomains: domains,
        // API keys: only send if user typed a new value — empty = preserve existing in DB
        ...(document.getElementById('cfg-tmdb-key')?.value.trim()   ? { tmdbApiKey:  document.getElementById('cfg-tmdb-key').value.trim()  } : {}),
        ...(document.getElementById('cfg-openai-key')?.value.trim() ? { openaiApiKey: document.getElementById('cfg-openai-key').value.trim() } : {}),
        ...getWatermarkSettings(),
        // Access & Security
        downloadsEnabled: document.getElementById('cfg-downloads-enabled')?.checked ?? true,
        channelEnabled: document.getElementById('cfg-channel-enabled')?.checked ?? true,
        embedEnabled: document.getElementById('cfg-embed-enabled')?.checked ?? true,
        playlistsPublic: document.getElementById('cfg-playlists-public')?.checked ?? true,
        hotlinkProtection: document.getElementById('cfg-hotlink-protection')?.checked || false,
        requireTokensAlways: document.getElementById('cfg-require-tokens')?.checked || false,
        // Player security
        adblock_detection: document.getElementById('cfg-adblock-detection')?.checked || false,
        devtools_blocker: document.getElementById('cfg-devtools-blocker')?.checked || false,
      };
      try {
        const r = await apiFetch(`${BASE}/api/workspaces/${authWorkspace.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        });
        if (!r.ok) return toast('Error al guardar', 'error');
        const el = document.getElementById('save-status');
        el.classList.add('visible'); setTimeout(() => el.classList.remove('visible'), 2500);
        toast('Configuración guardada');
      } catch { toast('Error de conexión', 'error'); }
    };

    // ════════════════════════════════════════════════════════════
    // ─── GDPR / Account Deletion ─────────────────────────────────
    // ════════════════════════════════════════════════════════════
    function handleGdprExport(e) {
      e.preventDefault();
      const note = document.getElementById('gdpr-export-note');
      // Trigger download via fetch + blob so we can show a note
      apiFetch(`${BASE}/auth/me/export`)
        .then(async r => {
          if (!r.ok) { toast('Error al exportar datos', 'error'); return; }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const _slug=(window._svSiteName||'StreamVault').toLowerCase().replace(/\s+/g,'-');
          a.href = url; a.download = `${_slug}-datos.json`;
          a.click(); URL.revokeObjectURL(url);
          if (note) { note.style.display = 'inline'; setTimeout(() => { note.style.display = 'none'; }, 3000); }
        })
        .catch(() => toast('Error de conexión', 'error'));
    }
    function openDeleteAccountModal() {
      document.getElementById('delete-account-pw').value = '';
      document.getElementById('delete-account-error').textContent = '';
      document.getElementById('delete-account-modal-overlay').classList.add('visible');
    }
    async function submitDeleteAccount() {
      const pw = document.getElementById('delete-account-pw').value;
      const errEl = document.getElementById('delete-account-error');
      const btn = document.getElementById('delete-account-btn');
      if (!pw) { errEl.textContent = 'Ingresa tu contraseña'; return; }
      errEl.textContent = '';
      btn.disabled = true; btn.textContent = 'Eliminando…';
      try {
        const r = await apiFetch(`${BASE}/auth/me`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { errEl.textContent = d.error || 'Contraseña incorrecta'; return; }
        // Wipe local session and redirect
        localStorage.clear(); sessionStorage.clear();
        location.href = '/?deleted=1';
      } catch { errEl.textContent = 'Error de conexión'; }
      finally { btn.disabled = false; btn.textContent = 'Eliminar para siempre'; }
    }

    // ─── Security score widget ────────────────────────────────────
    function loadSecurityWidget() {
      const emailVerified = !!(authUser && authUser.email_verified);
      const twoFaOn = !!(authUser && authUser.twoFactorEnabled);
      let score = 30; // always logged in
      if (emailVerified) score += 30;
      if (twoFaOn) score += 40;
      const bar = document.getElementById('sec-score-bar');
      const label = document.getElementById('sec-score-label');
      const hint = document.getElementById('sec-score-hint');
      if (!bar) return;
      const color = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)';
      bar.style.width = score + '%';
      bar.style.background = color;
      label.textContent = score + '/100';
      label.style.color = color;
      const missing = [];
      if (!emailVerified) missing.push('verifica tu email');
      if (!twoFaOn) missing.push('activa 2FA');
      hint.textContent = missing.length ? 'Mejora: ' + missing.join(' · ') : 'Cuenta protegida';
      hint.style.color = missing.length ? 'var(--muted)' : 'var(--green)';
    }

    // ─── Security section ─────────────────────────────────────────
    let _sec2faEnabled = false;
    let _secBackupCodes = [];
    let _secSessions = [];
    let _secLoaded = false;

    async function loadSecuritySection() {
      if (_secLoaded) return;
      try {
        const [statusRes, sessRes] = await Promise.all([
          apiFetch(`${BASE}/auth/2fa/status`),
          apiFetch(`${BASE}/auth/sessions`),
        ]);
        const emailVerified = !!(authUser && authUser.email_verified);
        if (statusRes.ok) {
          const s = await statusRes.json();
          _sec2faEnabled = s.twoFactorEnabled;
          secUpdateTwofaUI();
          if (_sec2faEnabled) secLoadBackupCodes();
        }
        if (sessRes.ok) {
          const s = await sessRes.json();
          _secSessions = s.sessions || [];
          secRenderSessions();
        }
        secRenderScore(emailVerified);
        document.getElementById('sec-loading').style.display = 'none';
        document.getElementById('sec-content').style.display = 'block';
        _secLoaded = true;
      } catch { toast('Error cargando seguridad', 'error'); }
    }

    function secRenderScore(emailVerified) {
      const checks = [
        { label: '2FA activado', ok: _sec2faEnabled, points: 40 },
        { label: 'Email verificado', ok: emailVerified, points: 30 },
        { label: 'Sesiones controladas', ok: _secSessions.length <= 3, points: 20, warn: _secSessions.length > 5 },
        { label: 'Sesión activa', ok: true, points: 10 },
      ];
      let score = 0;
      checks.forEach(c => { if (c.ok) score += c.points; });
      const ringColor = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)';
      const numEl = document.getElementById('sec-score-num');
      numEl.textContent = score;
      numEl.style.color = ringColor;
      const arc = document.getElementById('sec-arc');
      arc.style.strokeDashoffset = 226 - (score / 100) * 226;
      arc.style.stroke = ringColor;
      document.getElementById('sec-score-checks').innerHTML = checks.map(c => {
        const cls = c.ok ? 'ok' : (c.warn ? 'warn' : 'bad');
        return `<div class="sec-score-check"><div class="sec-chk-icon ${cls}">${c.ok ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg>' : (c.warn ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>')}</div><span style="color:var(--text2)">${c.label}</span><span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--muted)">+${c.points}pts</span></div>`;
      }).join('');
    }

    function secUpdateTwofaUI() {
      const badge = document.getElementById('sec-twofa-badge');
      if (_sec2faEnabled) {
        badge.className = 'sec-badge green'; badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg> Activo';
        document.getElementById('sec-twofa-off').style.display = 'none';
        document.getElementById('sec-twofa-setup').style.display = 'none';
        document.getElementById('sec-twofa-on').style.display = 'block';
        document.getElementById('nav-2fa-badge').style.display = '';
      } else {
        badge.className = 'sec-badge red'; badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Inactivo';
        document.getElementById('sec-twofa-off').style.display = 'block';
        document.getElementById('sec-twofa-setup').style.display = 'none';
        document.getElementById('sec-twofa-on').style.display = 'none';
        document.getElementById('nav-2fa-badge').style.display = 'none';
      }
    }

    async function secStartEnable2FA() {
      document.getElementById('sec-twofa-off').style.display = 'none';
      document.getElementById('sec-twofa-setup').style.display = 'block';
      document.getElementById('sec-qr-secret').textContent = '';
      document.getElementById('sec-qr-error').style.display = 'none';
      document.getElementById('sec-setup-step1').style.display = 'block';
      document.getElementById('sec-setup-step2').style.display = 'none';
      const step1 = document.getElementById('sec-step-1-ind');
      const step2 = document.getElementById('sec-step-2-ind');
      step1.classList.add('active');
      step1.classList.remove('done');
      step1.querySelector('.sec-step-circle').innerHTML = '1';
      step2.classList.remove('active', 'done');
      document.getElementById('sec-qr-img').innerHTML = '<div class="sec-shimmer" style="width:180px;height:180px;margin:0 auto;border-radius:8px"></div>';
      try {
        const r = await apiFetch(`${BASE}/auth/2fa/enable`, { method: 'POST' });
        const data = await r.json();
        if (!r.ok) {
          toast(data.error || 'Error generando 2FA', 'error');
          document.getElementById('sec-qr-img').innerHTML = '';
          document.getElementById('sec-qr-error').style.display = 'block';
          return;
        }
        document.getElementById('sec-qr-img').innerHTML = `<img src="${esc(data.qrCode)}" alt="QR Code" width="180">`;
        document.getElementById('sec-qr-secret').textContent = data.secret;
      } catch {
        toast('Error de conexión', 'error');
        document.getElementById('sec-qr-img').innerHTML = '';
        document.getElementById('sec-qr-error').style.display = 'block';
      }
    }

    function secCancelSetup() {
      document.getElementById('sec-twofa-setup').style.display = 'none';
      document.getElementById('sec-setup-err').style.display = 'none';
      document.getElementById('sec-otp').value = '';
      secUpdateTwofaUI();
    }

    // Navegar entre pasos del setup 2FA
    function secGoStep2() {
      document.getElementById('sec-setup-step1').style.display = 'none';
      document.getElementById('sec-setup-step2').style.display = 'block';
      const step1 = document.getElementById('sec-step-1-ind');
      const step2 = document.getElementById('sec-step-2-ind');
      step1.classList.remove('active');
      step1.classList.add('done');
      step1.querySelector('.sec-step-circle').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg>';
      step2.classList.add('active');
      setTimeout(() => document.getElementById('sec-otp')?.focus(), 100);
    }

    function secGoStep1() {
      document.getElementById('sec-setup-step2').style.display = 'none';
      document.getElementById('sec-setup-step1').style.display = 'block';
      const step1 = document.getElementById('sec-step-1-ind');
      const step2 = document.getElementById('sec-step-2-ind');
      step1.classList.add('active');
      step1.classList.remove('done');
      step1.querySelector('.sec-step-circle').innerHTML = '1';
      step2.classList.remove('active', 'done');
    }

    async function secVerifyAndActivate() {
      const code = document.getElementById('sec-otp').value.trim();
      const errEl = document.getElementById('sec-setup-err');
      errEl.style.display = 'none';
      if (!/^\d{6}$/.test(code)) { errEl.textContent = 'Ingresa 6 dígitos'; errEl.style.display = 'flex'; return; }
      const btn = document.getElementById('sec-otp-btn');
      const spin = document.getElementById('sec-otp-spin');
      btn.disabled = true; spin.style.display = 'inline-block';
      try {
        const r = await apiFetch(`${BASE}/auth/2fa/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }) });
        const data = await r.json();
        if (!r.ok) {
          errEl.textContent = data.error || 'Código inválido'; errEl.style.display = 'flex';
          const inp = document.getElementById('sec-otp');
          inp.classList.add('invalid'); inp.value = ''; inp.focus();
          setTimeout(() => inp.classList.remove('invalid'), 1000);
          return;
        }
        _sec2faEnabled = true;
        _secBackupCodes = data.backupCodes || [];
        secUpdateTwofaUI();
        document.getElementById('sec-codes-remaining').textContent = _secBackupCodes.length;
        secRenderBackupGrid(_secBackupCodes);
        document.getElementById('sec-backup-panel').style.display = 'block';
        loadSecurityWidget();
        toast('2FA activado. Guarda tus códigos de respaldo.', 'success');
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; spin.style.display = 'none'; }
    }

    async function secLoadBackupCodes() {
      try {
        const r = await apiFetch(`${BASE}/auth/2fa/backup-codes`);
        if (r.ok) {
          const d = await r.json();
          _secBackupCodes = d.backupCodes || [];
          document.getElementById('sec-codes-remaining').textContent = _secBackupCodes.length;
          secRenderBackupGrid(_secBackupCodes);
        }
      } catch {}
    }

    function secRenderBackupGrid(codes) {
      document.getElementById('sec-backup-grid').innerHTML = codes.length
        ? codes.map(c => `<div class="sec-backup-item">${esc(c)}</div>`).join('')
        : '<p style="font-size:13px;color:var(--muted);grid-column:1/-1">Sin códigos. Regenera nuevos.</p>';
    }

    function secToggleBackupPanel() {
      const p = document.getElementById('sec-backup-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    }

    function secCopyBackupCodes() {
      if (!_secBackupCodes.length) return toast('Sin códigos disponibles', 'warning');
      navigator.clipboard.writeText(_secBackupCodes.join('\n')).then(() => toast('Códigos copiados', 'success')).catch(() => toast('No se pudo copiar', 'error'));
    }

    function secDownloadBackupCodes() {
      if (!_secBackupCodes.length) return toast('Sin códigos disponibles', 'warning');
      const content = `${window._svSiteName || 'StreamVault'} — Códigos de Respaldo 2FA\nGenerado: ${new Date().toLocaleString()}\n\n${_secBackupCodes.join('\n')}\n\nCada código solo puede usarse una vez.`;
      const _s=(window._svSiteName||'StreamVault').toLowerCase().replace(/\s+/g,'-');
      const a = document.createElement('a'); a.href = 'data:text/plain,' + encodeURIComponent(content); a.download = `${_s}-backup-codes.txt`; a.click();
    }

    async function secRegenCodes() {
      if (!await confirmModal('¿Regenerar códigos de respaldo?', 'Los códigos actuales quedarán inválidos y deberás guardar los nuevos.', 'Regenerar', 'Cancelar', true)) return;
      try {
        const r = await apiFetch(`${BASE}/auth/2fa/backup-codes/regenerate`, { method: 'POST' });
        const d = await r.json();
        if (!r.ok) return toast(d.error || 'Error', 'error');
        _secBackupCodes = d.backupCodes;
        document.getElementById('sec-codes-remaining').textContent = _secBackupCodes.length;
        secRenderBackupGrid(_secBackupCodes);
        document.getElementById('sec-backup-panel').style.display = 'block';
        toast('Códigos regenerados. ¡Guárdalos ahora!', 'success');
      } catch { toast('Error de conexión', 'error'); }
    }

    function secStartDisable() {
      document.getElementById('sec-disable-pw').value = '';
      document.getElementById('sec-disable-err').style.display = 'none';
      openModal('sec-disable-modal');
      setTimeout(() => document.getElementById('sec-disable-pw').focus(), 100);
    }

    function secCloseDisableModal() {
      closeModal('sec-disable-modal');
    }

    async function secConfirmDisable() {
      const password = document.getElementById('sec-disable-pw').value;
      const errEl = document.getElementById('sec-disable-err');
      errEl.style.display = 'none';
      if (!password) { errEl.textContent = 'Ingresa tu contraseña'; errEl.style.display = 'flex'; return; }
      const btn = document.getElementById('sec-btn-confirm-disable');
      const spin = document.getElementById('sec-disable-spin');
      btn.disabled = true; spin.style.display = 'inline-block';
      try {
        const r = await apiFetch(`${BASE}/auth/2fa/disable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
        const d = await r.json();
        if (!r.ok) { errEl.textContent = d.error || 'Error'; errEl.style.display = 'flex'; return; }
        _sec2faEnabled = false;
        secCloseDisableModal();
        secUpdateTwofaUI();
        loadSecurityWidget();
        toast('2FA desactivado', 'warning');
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; spin.style.display = 'none'; }
    }

    function secRenderSessions() {
      const list = document.getElementById('sec-sessions-list');
      if (!_secSessions.length) { list.innerHTML = '<p style="font-size:13px;color:var(--muted)">No hay sesiones activas.</p>'; return; }
      list.innerHTML = _secSessions.map((s, i) => {
        const created = new Date(s.created_at * 1000).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
        const expires = new Date(s.expires_at * 1000).toLocaleDateString('es', { dateStyle: 'medium' });
        return `<div class="sec-session-item">
          <div class="sec-session-info">
            <div class="sec-session-date">Sesión ${created} ${i === 0 ? '<span class="sec-session-curr">Esta sesión</span>' : ''}</div>
            <div class="sec-session-meta">Expira ${expires}</div>
          </div>
          ${i !== 0 ? `<button class="btn btn-danger" style="padding:6px 12px;font-size:12px" onclick="secRevokeSession('${escAttr(s.id)}',this)">Cerrar</button>` : ''}
        </div>`;
      }).join('');
    }

    async function secRevokeSession(id, btn) {
      btn.disabled = true;
      try {
        const r = await apiFetch(`${BASE}/auth/sessions/${id}`, { method: 'DELETE' });
        if (!r.ok) return toast('Error cerrando sesión', 'error');
        _secSessions = _secSessions.filter(s => s.id !== id);
        secRenderSessions();
        toast('Sesión cerrada', 'success');
      } catch { toast('Error de conexión', 'error'); btn.disabled = false; }
    }

    async function secRevokeAll() {
      if (!await confirmModal('¿Cerrar todas las sesiones?', 'Tendrás que iniciar sesión de nuevo en todos los dispositivos.', 'Cerrar sesiones', 'Cancelar', true)) return;
      try {
        const r = await apiFetch(`${BASE}/auth/sessions`, { method: 'DELETE' });
        if (!r.ok) return toast('Error', 'error');
        toast('Todas las sesiones cerradas. Iniciando sesión de nuevo…', 'warning');
        setTimeout(() => { localStorage.clear(); window.location.href = '/login'; }, 2500);
      } catch { toast('Error de conexión', 'error'); }
    }

    function secCheckPwStrength(input) {
      const v = input.value;
      const [b1, b2, b3] = ['sec-pwb1','sec-pwb2','sec-pwb3'].map(id => document.getElementById(id));
      const hint = document.getElementById('sec-pw-hint');
      if (!v) { [b1,b2,b3].forEach(b => b.style.background = 'var(--border2)'); hint.textContent = ''; return; }
      let s = 0;
      if (v.length >= 8) s++;
      if (v.length >= 12) s++;
      if (/[A-Z]/.test(v) && /[0-9]/.test(v)) s++;
      if (/[^A-Za-z0-9]/.test(v)) s = Math.min(3, s + 1);
      const col = ['var(--red)','var(--amber)','var(--green)'][Math.min(s-1, 2)] || 'var(--border2)';
      b1.style.background = s >= 1 ? col : 'var(--border2)';
      b2.style.background = s >= 2 ? col : 'var(--border2)';
      b3.style.background = s >= 3 ? col : 'var(--border2)';
      hint.style.color = col;
      hint.textContent = v.length < 8 ? `Mínimo 8 caracteres (${v.length}/8)` : ['Débil','Aceptable','Fuerte'][Math.min(s-1,2)];
      secCheckPwConfirm(document.getElementById('sec-pw-confirm'));
    }

    function secCheckPwConfirm(input) {
      const hint = document.getElementById('sec-pw-confirm-hint');
      const newPw = document.getElementById('sec-pw-new').value;
      if (!input.value) { hint.textContent = ''; input.style.borderColor = ''; return; }
      const match = input.value === newPw;
      hint.style.color = match ? 'var(--green)' : 'var(--red)';
      hint.textContent = match ? 'Las contraseñas coinciden' : 'Las contraseñas no coinciden';
      input.style.borderColor = match ? 'var(--green)' : 'var(--red)';
    }

    async function secChangePassword() {
      const current = document.getElementById('sec-pw-current').value;
      const newPw = document.getElementById('sec-pw-new').value;
      const confirm = document.getElementById('sec-pw-confirm').value;
      if (!current || !newPw || !confirm) return toast('Completa todos los campos', 'warning');
      if (newPw.length < 8) return toast('Mínimo 8 caracteres', 'warning');
      if (newPw !== confirm) return toast('Las contraseñas no coinciden', 'error');
      const btn = document.getElementById('sec-btn-change-pw');
      const spin = document.getElementById('sec-spin-pw');
      btn.disabled = true; spin.style.display = 'inline-block';
      try {
        const r = await apiFetch(`${BASE}/auth/change-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: current, newPassword: newPw }) });
        const d = await r.json();
        if (!r.ok) return toast(d.error || 'Error cambiando contraseña', 'error');
        ['sec-pw-current','sec-pw-new','sec-pw-confirm'].forEach(id => document.getElementById(id).value = '');
        ['sec-pwb1','sec-pwb2','sec-pwb3'].forEach(id => document.getElementById(id).style.background = 'var(--border2)');
        document.getElementById('sec-pw-hint').textContent = '';
        document.getElementById('sec-pw-confirm-hint').textContent = '';
        toast('Contraseña actualizada correctamente', 'success');
      } catch { toast('Error de conexión', 'error'); }
      finally { btn.disabled = false; spin.style.display = 'none'; }
    }

    function secOtpInput(input, btnId) {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      const valid = input.value.length === 6;
      const btn = document.getElementById(btnId);
      if (btn) btn.disabled = !valid;
      input.classList.toggle('valid', valid);
      input.classList.remove('invalid');
      if (valid) btn?.focus();
    }

    const _SEC_EYE_OPEN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const _SEC_EYE_SHUT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22"/></svg>`;
    function secTogglePw(id, btn) {
      const inp = document.getElementById(id);
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.innerHTML = show ? _SEC_EYE_SHUT : _SEC_EYE_OPEN;
    }

    // ─── Onboarding wizard ────────────────────────────────────────
    async function onboardingResendVerification(btn) {
      if (!authUser?.email) return;
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const r = await apiFetch('/auth/request-verification', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authUser.email }),
        });
        btn.textContent = r.ok ? '¡Enviado!' : 'Error, intenta de nuevo';
        setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 3000);
      } catch {
        btn.disabled = false; btn.textContent = orig;
      }
    }

    function onboardingKey() { return authUser ? `sv_onboarding_${authUser.id}` : null; }

    function initOnboarding() {
      const key = onboardingKey();
      if (!key || localStorage.getItem(key)) return;
      // Don't show if user has already uploaded videos (not a new user)
      if (authUser && authUser.created_at && (Date.now() / 1000 - authUser.created_at) > 86400 * 3) return;
      renderOnboarding();
      document.getElementById('onboarding-overlay').style.display = 'flex';
    }

    function renderOnboarding() {
      const emailVerified = !!(authUser && authUser.email_verified);
      const twoFaOn = !!(authUser && authUser.twoFactorEnabled);
      const hasVideos = allVideosCache && allVideosCache.length > 0;
      
      const steps = [
        { done: true,          icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>', label: 'Cuenta creada', sub: `¡Bienvenido a ${window._svSiteName || 'StreamVault'}!` },
        { done: emailVerified, icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>', label: 'Verifica tu email', sub: emailVerified ? 'Email verificado' : 'Revisa tu bandeja de entrada', action: emailVerified ? null : { text: 'Reenviar email', fn: 'onboardingResendVerification(this)' } },
        { done: twoFaOn,       icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>', label: 'Activa la autenticación 2FA', sub: twoFaOn ? '2FA activo' : 'Protege tu cuenta', action: twoFaOn ? null : { text: 'Ir a Seguridad', fn: "goSection(event,'security');closeOnboarding()" } },
        { done: hasVideos,     icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>', label: 'Sube tu primer video', sub: hasVideos ? 'Primer video subido' : 'Empieza a compartir contenido', action: hasVideos ? null : { text: 'Subir video', fn: "goSection(event,'upload');closeOnboarding()" } },
      ];
      
      const pct = Math.round(steps.filter(s => s.done).length / steps.length * 100);
      document.getElementById('onboarding-progress-bar').style.width = pct + '%';
      document.getElementById('onboarding-progress-label').textContent = pct + '% completado';
      document.getElementById('onboarding-steps').innerHTML = steps.map((s, i) => `
        <div style="display:flex;align-items:flex-start;gap:14px;padding:18px 20px;${i < steps.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="width:44px;height:44px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .2s;${s.done ? 'background:rgba(34,211,165,0.15);color:var(--green);border:2px solid rgba(34,211,165,0.5);box-shadow:0 0 0 4px rgba(34,211,165,0.08);' : 'background:var(--surface3);color:var(--muted);border:2px solid var(--border2);'}">${s.done ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : s.icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:${s.done ? '700' : '600'};line-height:1.4;color:${s.done ? 'var(--muted)' : 'var(--text)'};${s.done ? 'text-decoration:line-through;' : ''}">${s.label}</div>
            <div style="font-size:13px;color:${s.done ? 'var(--green)' : 'var(--muted)'};margin-top:5px;line-height:1.5;font-weight:${s.done ? '600' : '400'};">${s.sub}</div>
            ${!s.done && s.action ? (s.action.href ? `<a href="${s.action.href}" style="display:inline-block;margin-top:12px;font-size:13px;color:var(--accent2);text-decoration:none;font-weight:600;">${s.action.text} →</a>` : `<button type="button" onclick="${s.action.fn}" style="margin-top:12px;padding:8px 18px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-size:13px;cursor:pointer;font-weight:600;font-family:var(--sans);transition:all .18s;box-shadow:0 2px 8px rgba(124,108,250,0.25);" onmouseover="this.style.background='var(--accent2)';this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 12px rgba(124,108,250,0.35)'" onmouseout="this.style.background='var(--accent)';this.style.transform='';this.style.boxShadow='0 2px 8px rgba(124,108,250,0.25)'">${s.action.text}</button>`) : ''}
          </div>
        </div>`).join('');
      
      // Actualizar indicador en el dashboard si hay tareas pendientes
      updateOnboardingIndicator(steps);
    }

    function closeOnboarding() {
      const key = onboardingKey();
      if (key) localStorage.setItem(key, '1');
      const el = document.getElementById('onboarding-overlay');
      if (el) { el.style.opacity = '0'; setTimeout(() => { el.style.display = 'none'; el.style.opacity = '1'; }, 280); }
      // Ocultar indicador del dashboard
      const indicator = document.getElementById('onboarding-indicator');
      if (indicator) indicator.style.display = 'none';
    }
    
    function updateOnboardingIndicator(steps) {
      const pendingCount = steps.filter(s => !s.done).length;
      let indicator = document.getElementById('onboarding-indicator');
      
      if (pendingCount > 0 && !localStorage.getItem(onboardingKey())) {
        if (!indicator) {
          // Crear el indicador si no existe
          const statsWrap = document.getElementById('videos-stats-wrap');
          if (statsWrap) {
            indicator = document.createElement('div');
            indicator.id = 'onboarding-indicator';
            indicator.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(124,108,250,0.1);border:1px solid rgba(124,108,250,0.3);border-radius:10px;margin-bottom:16px;cursor:pointer;transition:all .2s;';
            indicator.innerHTML = `
              <div style="width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 2s ease-in-out infinite;"></div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:var(--text);">Completa tu configuración</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">${pendingCount} ${pendingCount === 1 ? 'tarea pendiente' : 'tareas pendientes'}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
            `;
            indicator.onmouseover = () => indicator.style.background = 'rgba(124,108,250,0.15)';
            indicator.onmouseout = () => indicator.style.background = 'rgba(124,108,250,0.1)';
            indicator.onclick = () => {
              renderOnboarding();
              document.getElementById('onboarding-overlay').style.display = 'flex';
            };
            statsWrap.insertAdjacentElement('beforebegin', indicator);
            
            // Agregar animación de pulso si no existe
            if (!document.getElementById('onboarding-pulse-style')) {
              const style = document.createElement('style');
              style.id = 'onboarding-pulse-style';
              style.textContent = '@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }';
              document.head.appendChild(style);
            }
          }
        } else {
          indicator.style.display = 'flex';
          const countText = indicator.querySelector('div > div:last-child');
          if (countText) countText.textContent = `${pendingCount} ${pendingCount === 1 ? 'tarea pendiente' : 'tareas pendientes'}`;
        }
      } else if (indicator) {
        indicator.style.display = 'none';
      }
    }

    // ─── Multi-Gateway Support ────────────────────────────────────
    async function loadAvailableGateways() {
      const sel = document.getElementById('upgrade-gateway-select');
      const info = document.getElementById('upgrade-gateway-info');
      if (!sel) return;
      
      try {
        const r = await apiFetch(`${BASE}/api/billing/gateways`);
        if (!r.ok) throw new Error('Error al cargar gateways');
        const gateways = await r.json();
        
        const activeGateways = gateways.filter(g => g.enabled);
        if (activeGateways.length === 0) {
          sel.innerHTML = '<option value="">No hay métodos de pago disponibles</option>';
          if (info) {
            info.style.display = 'block';
            info.innerHTML = '<span style="color:var(--red);">⚠️ No hay métodos de pago configurados. Contacta al administrador.</span>';
          }
          return;
        }
        
        sel.innerHTML = activeGateways.map(g => {
          const labels = {
            stripe:   'Stripe (Tarjeta de crédito/débito)',
            paypal:   'PayPal',
            binance:  'Binance Pay (Crypto)',
            dlocalgo: 'dLocal Go (LATAM — Tarjetas y Transferencias)',
          };
          const defaultBadge = g.is_default ? ' — Recomendado' : '';
          return `<option value="${g.gateway}"${g.is_default ? ' selected' : ''}>${labels[g.gateway] || g.gateway}${defaultBadge}</option>`;
        }).join('');
        
        // Mostrar info del gateway seleccionado
        const selectedGateway = sel.value;
        const gateway = activeGateways.find(g => g.gateway === selectedGateway);
        if (gateway && info) {
          info.style.display = 'block';
          const descriptions = {
            stripe:   'Pago seguro con tarjeta de crédito o débito mediante Stripe.',
            paypal:   'Paga con tu cuenta de PayPal o tarjeta a través de PayPal.',
            binance:  'Paga con criptomonedas a través de Binance Pay.',
            dlocalgo: 'Paga con tarjeta, transferencia bancaria o voucher vía dLocal Go (LATAM).'
          };
          info.innerHTML = descriptions[gateway.gateway] || 'Método de pago disponible.';
        }
      } catch (e) {
        console.error('Error loading gateways:', e);
        sel.innerHTML = '<option value="stripe">Stripe (Por defecto)</option>';
        if (info) {
          info.style.display = 'block';
          info.innerHTML = '<span style="color:var(--amber);">⚠️ Error al cargar métodos de pago. Se usará Stripe por defecto.</span>';
        }
      }
    }

    function updateUpgradePlanDetails() {
      const planSel = document.getElementById('upgrade-plan-select');
      const gatewaySel = document.getElementById('upgrade-gateway-select');
      const featuresList = document.getElementById('upgrade-features-list');
      const totalPrice = document.getElementById('upgrade-total-price');
      const gatewayInfo = document.getElementById('upgrade-gateway-info');
      
      if (!planSel) return;
      
      const plan = planSel.value;
      const planDetails = {
        pro: {
          price: '$59/mes',
          features: [
            '200 videos',
            '500 GB de almacenamiento',
            '1 TB de ancho de banda/mes',
            'Transcripciones automáticas con IA',
            'Analytics avanzados',
            'Hasta 3 workspaces',
            '5 miembros por workspace',
            'Soporte prioritario'
          ]
        },
        enterprise: {
          price: 'Contactar',
          features: [
            'Videos ilimitados',
            'Almacenamiento ilimitado',
            'Ancho de banda ilimitado',
            'Workspaces ilimitados',
            'Miembros ilimitados',
            'SLA garantizado',
            'Soporte dedicado 24/7',
            'Onboarding personalizado'
          ]
        }
      };
      
      const details = planDetails[plan] || planDetails.pro;
      if (featuresList) featuresList.innerHTML = details.features.map(f => `<li>${esc(f)}</li>`).join('');
      if (totalPrice) totalPrice.textContent = details.price;
      
      // Actualizar info del gateway si está seleccionado
      if (gatewaySel && gatewayInfo && gatewaySel.value) {
        const gateway = gatewaySel.value;
        const descriptions = {
          stripe: 'Pago seguro con tarjeta de crédito o débito mediante Stripe.',
          paypal: 'Paga con tu cuenta de PayPal o tarjeta a través de PayPal.',
          binance: 'Paga con criptomonedas a través de Binance Pay.'
        };
        gatewayInfo.style.display = 'block';
        gatewayInfo.innerHTML = descriptions[gateway] || 'Método de pago disponible.';
      }
    }

    async function proceedToCheckout() {
      const planSel = document.getElementById('upgrade-plan-select');
      const gatewaySel = document.getElementById('upgrade-gateway-select');
      const btn = document.getElementById('upgrade-confirm-btn');
      
      if (!planSel || !gatewaySel) return;
      
      const plan = planSel.value;
      const gateway = gatewaySel.value;
      
      if (!gateway) {
        toast('Selecciona un método de pago', 'error');
        return;
      }
      
      if (plan === 'enterprise') {
        toast('Para el plan Enterprise, contacta a nuestro equipo de ventas', 'info');
        const salesEmail = window._svSupportEmail || '';
        window.open(`mailto:${salesEmail}?subject=Consulta%20Plan%20Enterprise`, '_blank');
        return;
      }
      
      const ogText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Redirigiendo...';
      
      try {
        const r = await apiFetch(`${BASE}/api/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plan,
            gateway,
            successUrl: `${window.location.origin}/dashboard?upgrade=success`,
            cancelUrl: `${window.location.origin}/dashboard?upgrade=cancel`
          })
        });
        
        if (!r.ok) {
          const err = await r.json();
          throw new Error(err.error || 'Error al crear sesión de pago');
        }
        
        const data = await r.json();
        
        if (data.checkoutUrl) {
          // Redirigir al checkout del gateway
          window.location.href = data.checkoutUrl;
        } else {
          throw new Error('No se recibió URL de checkout');
        }
      } catch (e) {
        console.error('Checkout error:', e);
        toast(e.message || 'Error al procesar el pago', 'error');
        btn.disabled = false;
        btn.textContent = ogText;
      }
    }

    // Cargar gateways al abrir el modal de upgrade
    window.openUpgradeModal = function() {
      openModal('upgrade-modal-overlay');
      loadAvailableGateways();
      updateUpgradePlanDetails();
    };

    // ─── Init ─────────────────────────────────────────────────────
    let globalStatsInterval = null;
    
    function startStatsMonitor() {
      if (globalStatsInterval) return; // Ya activo
      globalStatsInterval = setInterval(() => {
        const statsWrap = document.getElementById('videos-stats-wrap');
        if (statsWrap && statsWrap.style.display !== 'none') {
          loadStats();
        }
      }, 10000);
    }
    
    function stopStatsMonitor() {
      if (globalStatsInterval) {
        clearInterval(globalStatsInterval);
        globalStatsInterval = null;
      }
    }
    
    window.addEventListener('popstate', handlePopState);
    
    function cleanupDashboard() {
      // Remover event listeners
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleEscapeKey);
      window.removeEventListener('popstate', handlePopState);
      
      // Limpiar todos los timers
      stopPolling();
      stopAnalyticsAutoRefresh();
      stopStatsMonitor();
      
      if (_activeImports && _activeImports.size > 0) {
        _activeImports.forEach(t => {
          if (t) clearTimeout(t);
        });
        _activeImports.clear();
      }
      
      // Destruir charts
      if (retentionChart) { retentionChart.destroy(); retentionChart = null; }
      if (dailyChart) { dailyChart.destroy(); dailyChart = null; }
      if (deviceChart) { deviceChart.destroy(); deviceChart = null; }
    }
    
    // Exponer cleanup globalmente para testing/debugging
    window.dashboardCleanup = cleanupDashboard;

    // ── Exponer funciones de ads al scope global para los onclick del HTML ──
    window.saveAdsSettings    = saveAdsSettings;
    window.clearAdsSettings   = clearAdsSettings;
    window.onAdsTypeChange    = onAdsTypeChange;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // ─── TAGS / ETIQUETAS ────────────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════════════════

    function renderEditTags() {
      const wrap = document.getElementById('tag-chips');
      if (!wrap) return;
      wrap.innerHTML = _editTags.map(t =>
        `<span class="tag-chip">${esc(t)}<button type="button" class="tag-chip-x" onclick="removeEditTag('${esc(t)}')" title="Quitar">&times;</button></span>`
      ).join('');
    }

    function removeEditTag(tag) {
      _editTags = _editTags.filter(t => t !== tag);
      renderEditTags();
    }

    function addEditTag(raw) {
      const tag = raw.trim().toLowerCase().replace(/[,;]+/g, '');
      if (!tag || tag.length > 50) return;
      if (_editTags.includes(tag)) return;
      if (_editTags.length >= 20) { toast('Máximo 20 etiquetas', 'error'); return; }
      _editTags.push(tag);
      renderEditTags();
    }

    function handleTagKeydown(e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = e.target.value;
        addEditTag(v);
        e.target.value = '';
      } else if (e.key === 'Backspace' && !e.target.value && _editTags.length) {
        _editTags.pop();
        renderEditTags();
      }
    }

    function handleTagInput(el) {
      if (el.value.endsWith(',')) {
        addEditTag(el.value.slice(0, -1));
        el.value = '';
      }
    }

    // Update tag filter select from loaded videos
    function refreshTagFilter() {
      const sel = document.getElementById('library-filter-tag');
      if (!sel) return;
      const allTags = new Set();
      (allVideosCache || []).forEach(v => (v.tags || []).forEach(t => allTags.add(t)));
      if (allTags.size === 0) { sel.style.display = 'none'; return; }
      sel.style.display = '';
      const current = sel.value;
      sel.innerHTML = '<option value="">Todas las etiquetas</option>' +
        [...allTags].sort().map(t => `<option value="${esc(t)}"${t===current?' selected':''}>${esc(t)}</option>`).join('');
    }

    // ════════════════════════════════════════════════════════════════════════════════
    // ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════════════════

    let _notifs = [];
    let _notifPanelOpen = false;
    let _notifPollTimer = null;

    async function loadNotifications() {
      if (!authToken) return;
      try {
        const r = await apiFetch('/api/notifications');
        if (!r.ok) return;
        _notifs = await r.json();
        renderNotifBadge();
        if (_notifPanelOpen) renderNotifPanel();
      } catch {}
    }

    function renderNotifBadge() {
      const badge = document.getElementById('notif-badge');
      const unread = _notifs.filter(n => !n.read_at).length;
      if (badge) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.style.display = unread ? 'flex' : 'none';
      }
    }

    function renderNotifPanel() {
      const list = document.getElementById('notif-list');
      if (!list) return;
      if (!_notifs.length) {
        list.innerHTML = '<div style="text-align:center;padding:28px;color:var(--muted);font-size:13px;">Sin notificaciones</div>';
        return;
      }
      const icons = {
        success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
        error:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
        info:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
      };
      list.innerHTML = _notifs.slice(0, 30).map(n => {
        const iconKind = n.kind === 'success' ? 'success' : n.kind === 'error' ? 'error' : 'info';
        const icon = icons[iconKind] || icons.info;
        const clickAction = n.link ? `onclick="markNotifRead('${n.id}');window.location='${n.link}';"` : `onclick="markNotifRead('${n.id}')"`;
        return `<div class="notif-item${!n.read_at ? ' unread' : ''}" ${clickAction}>
          <div class="notif-icon ${iconKind}">${icon}</div>
          <div style="flex:1;min-width:0;">
            <div class="notif-title">${esc(n.title)}</div>
            ${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ''}
            <div class="notif-time">${timeAgo(n.created_at)}</div>
          </div>
        </div>`;
      }).join('');
    }

    function toggleNotifPanel() {
      _notifPanelOpen = !_notifPanelOpen;
      const panel = document.getElementById('notif-panel');
      if (panel) {
        panel.style.display = _notifPanelOpen ? 'flex' : 'none';
        panel.style.flexDirection = 'column';
      }
      if (_notifPanelOpen) {
        renderNotifPanel();
        // Close when clicking outside
        setTimeout(() => {
          document.addEventListener('click', _closeNotifOnOutside, { once: true });
        }, 10);
      }
    }

    function _closeNotifOnOutside(e) {
      const wrap = document.getElementById('notif-bell-wrap');
      if (wrap && !wrap.contains(e.target)) {
        _notifPanelOpen = false;
        const panel = document.getElementById('notif-panel');
        if (panel) panel.style.display = 'none';
      } else if (_notifPanelOpen) {
        document.addEventListener('click', _closeNotifOnOutside, { once: true });
      }
    }

    async function markNotifRead(id) {
      const n = _notifs.find(x => x.id === id);
      if (n && !n.read_at) {
        n.read_at = Math.floor(Date.now() / 1000);
        renderNotifBadge();
        renderNotifPanel();
        apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' }).catch(() => {});
      }
    }

    async function markAllNotifsRead() {
      _notifs.forEach(n => { if (!n.read_at) n.read_at = Math.floor(Date.now() / 1000); });
      renderNotifBadge();
      renderNotifPanel();
      apiFetch('/api/notifications/read-all', { method: 'PATCH' }).catch(() => {});
    }

    function startNotifPolling() {
      if (_notifPollTimer) return;
      loadNotifications();
      _notifPollTimer = setInterval(loadNotifications, 60_000);
    }

    // ════════════════════════════════════════════════════════════════════════════════
    // NOTA: La lógica de mostrar/ocultar features según el plan está en
    //    applyFeatureFlags(). No duplicar aquí.
    // ════════════════════════════════════════════════════════════════════════════════

    restoreSession().then(async () => {
      await applyFeatureFlags();
      // Pre-render plan badge from already-fetched workspace data to avoid a flash
      if (authWorkspace?.plan) {
        const planName = authWorkspace.plan.toUpperCase();
        const planColors = { STARTER: 'rgba(124,108,250,0.15)', PRO: 'rgba(34,211,165,0.15)', ENTERPRISE: 'rgba(251,191,36,0.15)' };
        const planText   = { STARTER: 'var(--accent2)', PRO: 'var(--green)', ENTERPRISE: 'var(--amber)' };
        ['plan-badge', 'sidebar-plan-badge'].forEach(id => {
          const el = document.getElementById(id);
          if (!el) return;
          el.textContent = planName;
          el.style.background = planColors[planName] || planColors.STARTER;
          el.style.color = planText[planName] || planText.STARTER;
        });
      }
      setLibView(_libView);
      const limitSel = document.getElementById('library-limit');
      if (limitSel) limitSel.value = String(_pageLimit);
      showSection(routeFromPath(), { skipUrl: true });
      if (routeFromPath() !== 'videos') loadVideos();
      loadSecurityWidget();
      loadPlanUsage();
      initOnboarding();
      startNotifPolling();
      const bellWrap = document.getElementById('notif-bell-wrap');
      if (bellWrap) bellWrap.style.display = '';
      document.body.classList.add('ready');
    });
  
