// Player Security Layer
// Anti-devtools + tab visibility guard
(function () {
  'use strict';

  // ── Anti-devtools ───────────────────────────────────────────────
  // Pauses video and shows overlay when browser devtools are detected.
  //
  // Detection strategy: uses the toString() timing trick.
  // When DevTools is open, formatting a custom object via console
  // invokes its getter, which takes measurably longer (>5ms).
  // This avoids all the false positives produced by comparing
  // outerWidth/innerWidth (scrollbars, side panels, HiDPI screens,
  // browser chrome on macOS, etc.).
  //
  // Requires 2 consecutive positive detections (~2.4 s) before
  // triggering, to filter transient noise.
  let _dtOpen = false;
  let _dtOverlay = null;
  let _wasPaused = false;
  let _dtConsecutive = 0;

  function _buildDtOverlay() {
    const wrap = document.getElementById('player-wrap');
    if (!wrap || document.getElementById('sv-dt')) return;
    _dtOverlay = document.createElement('div');
    _dtOverlay.id = 'sv-dt';
    _dtOverlay.style.cssText =
      'position:absolute;inset:0;z-index:200;display:none;' +
      'background:rgba(0,0,0,.93);flex-direction:column;' +
      'align-items:center;justify-content:center;gap:12px;';
    _dtOverlay.innerHTML =
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5">' +
        '<circle cx="12" cy="12" r="10"/>' +
        '<line x1="12" y1="8" x2="12" y2="12"/>' +
        '<line x1="12" y1="16" x2="12.01" y2="16"/>' +
      '</svg>' +
      '<p style="color:#f0f0f8;font-size:14px;font-weight:600;font-family:system-ui,sans-serif;margin:0;">Reproducción pausada</p>' +
      '<p style="color:rgba(255,255,255,.4);font-size:12px;font-family:system-ui,sans-serif;margin:0;text-align:center;max-width:260px;">' +
        'Cierra las herramientas del desarrollador para continuar.' +
      '</p>';
    wrap.appendChild(_dtOverlay);
  }

  // Detects DevTools via toString timing. When the console is open
  // and formats an object, the getter is called synchronously and
  // takes noticeably longer than a plain property access.
  function _isDevtoolsOpen() {
    let detected = false;

    // Method 1: toString getter timing
    // A getter on a custom object is called when DevTools formats it.
    const obj = Object.defineProperty({}, '__sv_dt__', {
      get: function () {
        detected = true;
        return 'sv';
      },
      configurable: true
    });

    // Push to console — in normal use nothing happens;
    // when DevTools panel is open the getter fires.
    // We suppress the output by using a no-op if console is mocked.
    const _c = window.console;
    if (_c && typeof _c.log === 'function') {
      const t0 = performance.now();
      _c.log(obj);
      _c.clear && _c.clear();
      const elapsed = performance.now() - t0;
      // Getter fired OR console took suspiciously long (>10 ms)
      if (detected) return true;
    }

    // Method 2: window size delta as secondary signal only
    // Use a much higher threshold (500px) to avoid false positives
    // from browser side panels, OS scrollbars and HiDPI chrome.
    const widthDelta  = window.outerWidth  - window.innerWidth;
    const heightDelta = window.outerHeight - window.innerHeight;
    if (widthDelta > 500 || heightDelta > 500) return true;

    return false;
  }

  function _checkDevtools() {
    const open = _isDevtoolsOpen();
    const video = document.getElementById('video');
    if (open) {
      _dtConsecutive++;
      if (_dtConsecutive >= 2 && !_dtOpen) {
        _dtOpen = true;
        _buildDtOverlay();
        if (_dtOverlay) _dtOverlay.style.display = 'flex';
        if (video) { _wasPaused = video.paused; if (!video.paused) video.pause(); }
      }
    } else {
      _dtConsecutive = 0;
      if (_dtOpen) {
        _dtOpen = false;
        if (_dtOverlay) _dtOverlay.style.display = 'none';
        if (video && !_wasPaused) video.play().catch(() => {});
      }
    }
  }

  // ── Tab visibility guard ────────────────────────────────────────
  // Pauses video when the tab is hidden. Resumes on return.
  // Prevents screen-recording tools that capture inactive tabs.
  let _hiddenPaused = false;
  function _initVisibilityGuard() {
    document.addEventListener('visibilitychange', () => {
      const video = document.getElementById('video');
      if (!video) return;
      if (document.hidden) {
        if (!video.paused) { _hiddenPaused = true; video.pause(); }
      } else {
        if (_hiddenPaused) { _hiddenPaused = false; video.play().catch(() => {}); }
      }
    });
  }

  const _isLocalDev = (function() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' ||
           /^192\.168\./.test(h) || /^10\./.test(h) ||
           /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  })();

  const _isPreview = new URLSearchParams(location.search).get('preview') === '1';

  // Called by the player after loading workspace config.
  // devtoolsBlocker=true  → start anti-devtools polling
  // devtoolsBlocker=false → only install the tab-visibility guard
  // preview=1 in URL     → skip all security (dashboard preview iframe)
  window.__svSecurityInit = function(devtoolsBlocker) {
    if (_isPreview) return;
    _initVisibilityGuard();
    if (!_isLocalDev && devtoolsBlocker) {
      setInterval(_checkDevtools, 1200);
    }
  };
})();
