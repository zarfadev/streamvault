'use strict';
// ─── Constants ──────────────────────────────────────────────
// Supports /watch/:id, /view/:id, /player/:id and /embed/:id URL patterns
const _vidMatch = location.pathname.match(/\/(?:watch|view|player|player-view|embed)\/([^/?#]+)/);
const videoId = _vidMatch ? _vidMatch[1] : null;
const BASE    = location.origin;

// Standalone mode — /player/:id and /embed/:id fill the full viewport like an embed player
const _isStandalone = /^\/(?:player|embed)\//.test(location.pathname);
if (_isStandalone) document.getElementById('player-body').classList.add('player-standalone');

// Guard: redirect to home if no videoId in URL
if (!videoId) { location.href = '/'; }
const _svToken  = () => localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token') || localStorage.getItem('sv_token') || null;
const _authHdr  = () => { const t = _svToken(); return t ? { 'Authorization': 'Bearer ' + t } : {}; };

// ─── Video token (15-min signed, auto-renews) ────────────────
let _videoToken = null, _tokenTimer = null;
async function fetchVideoToken() {
  try {
    const unlock = sessionStorage.getItem(`sv_unlock_${videoId}`);
    const r = await fetch(`${BASE}/api/videos/${videoId}/token${unlock ? '?unlock='+encodeURIComponent(unlock) : ''}`);
    if (!r.ok) return;
    const d = await r.json();
    _videoToken = d.token;
    const renewIn = (d.renewAfter || (d.ttl - 120)) * 1000;
    clearTimeout(_tokenTimer);
    _tokenTimer = setTimeout(fetchVideoToken, Math.max(30000, renewIn));
  } catch {}
}

// ── CloudFront Signed Cookies stream session ─────────────────────────────────
// Called once before loading HLS from CDN. Sets signed cookies so CloudFront
// serves the video segments. The cookies are set via Set-Cookie (credentials:include)
// and also stored for hls.js xhrSetup to forward via withCredentials.
let _cfSessionActive = false;
let _cfSessionTimer = null;

async function fetchStreamSession() {
  try {
    const r = await fetch(`${BASE}/api/videos/${videoId}/stream-session`, {
      credentials: 'include', // receive and store Set-Cookie from the server
    });
    if (!r.ok) return;
    const d = await r.json();
    if (d.signed) {
      _cfSessionActive = true;
      // Renew session 30 min before expiry
      const renewIn = Math.max(60_000, (d.expiresAt - Math.floor(Date.now()/1000) - 1800) * 1000);
      clearTimeout(_cfSessionTimer);
      _cfSessionTimer = setTimeout(fetchStreamSession, renewIn);
    }
  } catch {}
}
function hlsXhrSetup(xhr, url) {
  if (_videoToken && (url.includes('/videos/') || url.includes('/api/videos/'))) {
    xhr.open('GET', url + (url.includes('?') ? '&' : '?') + 'token=' + _videoToken, true);
  }
  // When CloudFront Signed Cookies are active, send cookies with every CDN request
  // so .ts segments and sub-manifests are authorized by the edge (TrustedKeyGroups).
  if (_cfSessionActive) {
    xhr.withCredentials = true;
  }
}

// ─── State ──────────────────────────────────────────────────
let videoData = null, hls = null, levels = [], currentLevel = -1;
let _hlsSourceUrl = null; // URL real del m3u8 — necesaria para AirPlay (Apple TV no admite blob://)
let isAirPlayActive = false; // true mientras Apple TV está recibiendo el stream
let currentSpeed = 1, hideUiTimer = null, spriteMeta = null, spriteImg = null;
let audioTracks = [], currentAudioTrack = -1;
// Flag: HLS manifest parsed — quality button/settings gear only visible after this
let _manifestReady = false;
// Flag: video has enough data to show frames — quality badge only shows after canplay
let _videoCanPlay = false;
let settingsView = 'main'; // 'main'|'quality'|'audio'|'subtitles'|'speed'
let ccLang = null, subtitlesList = [];
let _progressTimer = null, lastProgressPos = -15, lastEventMs = 0;

// ─── DOM refs ────────────────────────────────────────────────
const wrap   = document.getElementById('player-wrap');
const video  = document.getElementById('video');
const thumbV = document.getElementById('thumb-video');
const tcEl   = document.getElementById('time-current');
const trEl   = document.getElementById('time-remain');

// ─── Idle chrome ─────────────────────────────────────────────
const idleMs = () => matchMedia('(prefers-reduced-motion:reduce)').matches ? 8000 : 2800;
function clearIdle() { clearTimeout(hideUiTimer); hideUiTimer = null; }
function scheduleIdle() {
  clearIdle();
  if (video.paused || video.ended) return;
  hideUiTimer = setTimeout(() => {
    wrap.classList.add('ui-idle');
    wrap.classList.remove('show-controls');
  }, idleMs());
}
function wakeChrome() {
  wrap.classList.remove('ui-idle');
  wrap.classList.add('show-controls');
  scheduleIdle();
}
function freezeChrome() {
  clearIdle();
  wrap.classList.remove('ui-idle');
  wrap.classList.add('show-controls');
}

// ─── Analytics ───────────────────────────────────────────────
const viewerId = (() => {
  const k = 'sv_viewer';
  let id = sessionStorage.getItem(k);
  if (!id) {
    // crypto.randomUUID() requires HTTPS — provide fallback for HTTP/local dev
    id = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    sessionStorage.setItem(k, id);
  }
  return id;
})();
function trackEvent(type, extra = {}) {
  if (!videoId) return;
  const now = Date.now();
  if (now - lastEventMs < 4500) return;
  lastEventMs = now;
  fetch(`${BASE}/api/videos/${videoId}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewer_id: viewerId, event_type: type, position: Math.floor(video.currentTime || 0), ...extra }),
  }).catch(() => {});
}

// ─── Utilities ───────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('sv-toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function showLoading(v) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !v);
  document.getElementById('player-wrap').classList.toggle('is-buffering', v);
}
function fmtTime(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function fmtRemain(cur, tot) { return !tot || isNaN(tot) ? '−0:00' : '−' + fmtTime(Math.max(0, tot - cur)); }
function applyLogoCorner(el, pos) {
  el.classList.remove('pos-tl','pos-tr','pos-bl','pos-br');
  if (['tl','tr','bl','br'].includes(pos)) el.classList.add('pos-' + pos);
}

// ─── Playback ────────────────────────────────────────────────
function updatePlayIcon(playing) {
  const href = playing ? '#sv-pause-fill' : '#sv-play-fill';
  document.getElementById('play-icon').setAttribute('href', href);
  document.getElementById('center-play-icon')?.setAttribute('href', href);
  wrap.classList.toggle('paused', !playing);
  const btn = document.getElementById('play-btn');
  if (btn) btn.dataset.tooltip = playing ? 'Pausar' : 'Reproducir';
}
function togglePlay() {
  if (_castSession) { _castIsPlaying() ? _castSendPause() : _castSendPlay(); freezeChrome(); return; }
  video.paused ? video.play() : video.pause(); freezeChrome();
}

function skip(secs, opts) {
  if (_castSession) {
    _castSendSeek(Math.max(0, Math.min(_castDuration(), _castCurrentTime() + secs)));
  } else {
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + secs));
  }
  if (opts?.showFeedback === true) showSkipFeedback(secs);
  wakeChrome();
}

function _syncVolFill(val) {
  const s = document.getElementById('vol-slider');
  if (s) s.style.setProperty('--vol-fill', (parseFloat(val) * 100).toFixed(1) + '%');
}
function setVolume(v) {
  const vol = parseFloat(v);
  video.volume = vol;
  video.muted  = vol === 0;
  localStorage.setItem('sv_volume', vol);
  // Sincroniza tanto el fill CSS como la posición nativa del thumb
  const s = document.getElementById('vol-slider');
  if (s) s.value = vol;
  _syncVolFill(vol);
  updateVolIcon();
  wakeChrome();
}
function toggleMute() {
  video.muted = !video.muted;
  const s = document.getElementById('vol-slider');
  s.value = video.muted ? 0 : video.volume;
  _syncVolFill(s.value);
  updateVolIcon();
  wakeChrome();
}
function loadPreferences() {
  const vol = parseFloat(localStorage.getItem('sv_volume') ?? '1');
  if (!isNaN(vol) && vol >= 0 && vol <= 1) {
    video.volume = vol;
    const s = document.getElementById('vol-slider');
    s.value = vol;
    _syncVolFill(vol);
  }
  const spd = parseFloat(localStorage.getItem('sv_playback_speed') ?? '1');
  if ([0.5, 0.75, 1, 1.25, 1.5, 2].includes(spd)) { currentSpeed = spd; video.playbackRate = spd; }
  updateVolIcon();
}
function updateVolIcon() {
  const muted = video.muted || video.volume === 0;
  const low   = !muted && video.volume < 0.4;
  document.querySelector('#vol-icon use')?.setAttribute('href', muted ? '#sv-volume-mute' : low ? '#sv-volume-low' : '#sv-volume');
}
// ─── iOS pseudo-fullscreen ─────────────────────────────────────
// On iOS Safari, document.requestFullscreen / webkitRequestFullscreen are
// not supported on the wrapper element — only video.webkitEnterFullscreen
// works, but that launches the native iOS player which hides all our HTML
// controls (custom subtitles, audio selector, quality badge, etc.).
//
// Instead, when both standard fullscreen APIs are unavailable we use CSS
// pseudo-fullscreen: fix the wrapper to cover the viewport and rotate to
// landscape.  Our custom controls remain fully interactive.
let _iosPseudoFs = false;
let _iosNativeFs  = false; // true while video.webkitEnterFullscreen is active
function _isIOSPseudoFs()  { return _iosPseudoFs; }
function _enterIOSPseudoFs() {
  _iosPseudoFs = true;
  wrap.classList.add('ios-pseudo-fs');
  document.body.classList.add('ios-pseudo-fs-active');
  updateFsIcon();
}
function _exitIOSPseudoFs() {
  _iosPseudoFs = false;
  wrap.classList.remove('ios-pseudo-fs');
  document.body.classList.remove('ios-pseudo-fs-active');
  try { screen.orientation?.unlock(); } catch {}
  updateFsIcon();
}

function isFullscreen() {
  return document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap || _iosPseudoFs || _iosNativeFs;
}
function updateFsIcon() {
  const fsBtn = wrap.querySelector('.fullscreen-btn');
  const u = document.querySelector('#fs-icon use');
  const active = isFullscreen();
  if (u) u.setAttribute('href', active ? '#sv-fs-exit' : '#sv-fs-enter');
  if (fsBtn) {
    fsBtn.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Pantalla completa');
    fsBtn.dataset.tooltip = active ? 'Salir de pantalla completa' : 'Pantalla completa';
  }
}
async function toggleFullscreen() {
  // iOS pseudo-fullscreen exit (last-resort fallback only)
  if (_iosPseudoFs) { _exitIOSPseudoFs(); wakeChrome(); return; }
  try {
    if (!isFullscreen()) {
      if (wrap.requestFullscreen) await wrap.requestFullscreen();
      else if (wrap.webkitRequestFullscreen) await wrap.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) {
        // iOS Safari: launch the native player via webkitEnterFullscreen.
        // webkitbeginfullscreen / webkitendfullscreen events handle subtitle/audio sync.
        video.webkitEnterFullscreen();
        return;
      } else {
        // Last resort: CSS pseudo-fullscreen (no native API at all)
        _enterIOSPseudoFs();
        wakeChrome();
        return;
      }
    } else {
      await (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  } catch {}
  wakeChrome();
}
function _handleFsChange() {
  updateFsIcon();
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    // Lock to landscape once fullscreen is confirmed active
    if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
  } else {
    try { screen.orientation?.unlock(); } catch {}
  }
}
document.addEventListener('fullscreenchange', _handleFsChange);
document.addEventListener('webkitfullscreenchange', _handleFsChange);
updateFsIcon();

// ─── iOS native fullscreen (webkitEnterFullscreen) ────────────
// Standard fullscreenchange does NOT fire for iOS native player.
// Instead, the <video> element fires webkitbeginfullscreen / webkitendfullscreen.
//
// webkitbeginfullscreen: activate native <track> so iOS shows subtitles in its HUD
// webkitendfullscreen:   disable native tracks + clear VTT overlay to avoid
//                        the double-subtitle bug (native track still 'showing'
//                        while our custom overlay is also rendering cues).
video.addEventListener('webkitbeginfullscreen', () => {
  _iosNativeFs = true;
  updateFsIcon();
  // ── Subtitles for iOS native player ──────────────────────────
  // The iOS player reads native <track> elements (mode='showing').
  // Our custom VTT overlay is HTML — invisible inside the iOS player.
  // Activate the track matching the user's selected language so
  // the iOS player can display it in its built-in subtitle HUD.
  if (ccLang && video.textTracks.length > 0) {
    let applied = false;
    for (let i = 0; i < video.textTracks.length; i++) {
      const match = video.textTracks[i].language === ccLang ||
                    video.textTracks[i].label === ccLang;
      video.textTracks[i].mode = (match && !applied) ? 'showing' : 'hidden';
      if (match) applied = true;
    }
  } else {
    // No subtitle selected — ensure all tracks are hidden in iOS player
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = 'hidden';
    }
  }

  // ── Audio for iOS native player ───────────────────────────────
  // Safari/iOS native player reads video.audioTracks directly.
  // Restore the user's saved audio preference so the iOS player
  // starts on the correct track.
  if (video.audioTracks && video.audioTracks.length > 1) {
    const savedLang = audioTracks[currentAudioTrack >= 0 ? currentAudioTrack : 0]?.lang || null;
    if (savedLang) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i].enabled = (video.audioTracks[i].language === savedLang ||
                                        video.audioTracks[i].label === savedLang);
      }
    }
  }

  // Hide our custom HTML overlay — it's not visible inside the iOS native player
  if (_subDisplay) _subDisplay.style.display = 'none';
});

video.addEventListener('webkitendfullscreen', () => {
  _iosNativeFs = false;
  updateFsIcon();
  // Step 1: immediately clear the custom overlay to avoid showing stale cues
  if (_subDisplay) _subDisplay.innerHTML = '';
  // Step 2: disable all native tracks — iOS may leave them in 'showing' after exit
  disableAllNativeTracks();
  // Step 3: restore overlay visibility
  if (_subDisplay) _subDisplay.style.display = '';
  // Step 4: give the browser a frame to process the track mode changes,
  // then restart the VTT loop. Without the delay the loop may render one
  // frame before disableAllNativeTracks() takes effect, causing a flash.
  if (ccKey && _vttCues.length > 0) {
    if (_vttTimer) { _vttTimer.cancel(); _vttTimer = null; }
    _vttLastRendered = ''; // force re-render on next tick
    setTimeout(() => {
      disableAllNativeTracks(); // double-ensure tracks are hidden
      _startVttLoop();
    }, 80);
  }
});

function togglePip() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else if (!video.disablePictureInPicture && document.pictureInPictureEnabled) {
    video.requestPictureInPicture().catch(() => {});
  }
}
function checkPip() {
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    document.getElementById('pip-btn').style.display = '';
  }
}

// ─── Skip feedback overlay (YouTube double-tap style) ────────
let _skipFbTimer = null;
function showSkipFeedback(secs) {
  const id  = secs < 0 ? 'skip-feedback-left' : 'skip-feedback-right';
  const el  = document.getElementById(id);
  if (!el) return;

  // Chevron arrows — point right for forward, left for backward
  const isForward = secs > 0;
  const arrow = isForward
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="skip-feedback-arrow"><polyline points="9 18 15 12 9 6"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="skip-feedback-arrow"><polyline points="15 18 9 12 15 6"/></svg>`;
  const label = `${Math.abs(secs)} segundos`;

  el.innerHTML = `
    <div class="skip-feedback-arrows">${arrow}${arrow}${arrow}</div>
    <span class="skip-feedback-label">${label}</span>`;

  el.classList.remove('hide');
  el.classList.add('show');
  clearTimeout(_skipFbTimer);
  _skipFbTimer = setTimeout(() => { el.classList.remove('show'); el.classList.add('hide'); }, 700);
}

// ─── Chromecast ──────────────────────────────────────────────
function _castAbsoluteUrl(relOrAbs) {
  if (!relOrAbs) return null;
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  return location.origin + (relOrAbs.startsWith('/') ? '' : '/') + relOrAbs;
}

let _castSession   = null;
let _castSyncTimer = null;

window.__onGCastApiAvailable = function(ok) {
  if (!ok) return;
  // The SDK sometimes calls this before cast.framework is fully ready.
  const t = setInterval(() => {
    if (typeof cast !== 'undefined' && cast.framework) { initCast(); clearInterval(t); }
  }, 500);
};

// Fallback: on HTTPS the SDK may not fire __onGCastApiAvailable in all environments.
// _tryCastInit is called with a short delay so cast_sender.js has time to load.
function _tryCastInit() {
  if (typeof cast !== 'undefined' && cast.framework) { initCast(); return; }
  // Cast SDK only works on HTTPS — hide button silently on plain HTTP.
  const btn = document.getElementById('cast-btn');
  if (btn) btn.style.display = 'none';
}

function initCast() {
  if (typeof cast === 'undefined' || !cast.framework) return;
  const ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy:        chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  // Track session lifecycle to pause/resume the local player in sync with the TV.
  ctx.addEventListener(
    cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
    _onCastSessionState
  );

  const btn = document.getElementById('cast-btn');
  if (!btn) return;
  btn.style.display = 'inline-flex';
  btn.onclick = _castConnect;
}

function _onCastSessionState(e) {
  const SS  = cast.framework.SessionState;
  const btn = document.getElementById('cast-btn');

  if (e.sessionState === SS.SESSION_STARTED || e.sessionState === SS.SESSION_RESUMED) {
    _castSession = cast.framework.CastContext.getInstance().getCurrentSession();
    btn?.classList.add('casting');
    if (!video.paused) video.pause();
    _startCastSync();

  } else if (e.sessionState === SS.SESSION_ENDED || e.sessionState === SS.SESSION_ENDED_WITH_ERROR) {
    // Seek local player to where the Chromecast left off
    if (_castSession) {
      try {
        const pos = _castSession.getMediaSession()?.getEstimatedTime?.();
        if (pos > 0 && isFinite(pos)) video.currentTime = pos;
      } catch {}
    }
    _castSession = null;
    btn?.classList.remove('casting');
    _stopCastSync();
    video.play().catch(() => {});
    toast('Transmisión finalizada — continuando aquí');
  }
}

function _castGetMs()       { return _castSession?.getMediaSession?.(); }
function _castCurrentTime() { return _castGetMs()?.getEstimatedTime?.() ?? 0; }
function _castDuration()    { return _castGetMs()?.media?.duration || video.duration || 0; }
function _castIsPlaying()   {
  const state = _castGetMs()?.playerState;
  return state === chrome.cast.media.PlayerState.PLAYING || state === chrome.cast.media.PlayerState.BUFFERING;
}
function _castSendSeek(time) {
  const ms = _castGetMs();
  if (!ms) return;
  const req = new chrome.cast.media.SeekRequest();
  req.currentTime = Math.max(0, time);
  ms.seek(req, () => {}, () => {});
}
function _castSendPlay() {
  const ms = _castGetMs();
  if (ms) ms.play(new chrome.cast.media.PlayRequest(), () => {}, () => {});
}
function _castSendPause() {
  const ms = _castGetMs();
  if (ms) ms.pause(new chrome.cast.media.PauseRequest(), () => {}, () => {});
}
// Switch audio and/or subtitle tracks on the receiver.
// Pass null for either arg to keep the current selection for that type.
function _castEditTracks(desiredAudioLang, desiredSubLang) {
  const ms = _castGetMs();
  if (!ms?.media?.tracks?.length) return;
  const tracks = ms.media.tracks;
  const activeIds = [];
  // Audio: keep active track if desiredAudioLang is null, else pick by language
  const castAudioTracks = tracks.filter(t => t.type === chrome.cast.media.TrackType.AUDIO);
  if (castAudioTracks.length) {
    const wanted = desiredAudioLang !== null
      ? (castAudioTracks.find(t => t.language === desiredAudioLang) || castAudioTracks[0])
      : (ms.activeTrackIds?.length
          ? castAudioTracks.find(t => ms.activeTrackIds.includes(t.trackId)) || castAudioTracks[0]
          : castAudioTracks[0]);
    if (wanted) activeIds.push(wanted.trackId);
  }
  // Subtitles: keep active track if desiredSubLang is null, else pick by language (undefined = off)
  const castSubTracks = tracks.filter(t => t.type === chrome.cast.media.TrackType.TEXT);
  if (castSubTracks.length && desiredSubLang !== null) {
    if (desiredSubLang !== undefined) {
      const wanted = castSubTracks.find(t => t.language === desiredSubLang);
      if (wanted) activeIds.push(wanted.trackId);
    }
    // else: desiredSubLang === undefined means turn subs off — don't push any TEXT track
  } else if (castSubTracks.length && desiredSubLang === null) {
    // Keep whatever sub was active
    const activeSub = castSubTracks.find(t => ms.activeTrackIds?.includes(t.trackId));
    if (activeSub) activeIds.push(activeSub.trackId);
  }
  const req = new chrome.cast.media.EditTracksInfoRequest(activeIds);
  ms.editTracksInfo(req, () => {}, e => console.warn('[cast] editTracks error', e));
}

function _startCastSync() {
  _stopCastSync();
  _castSyncTimer = setInterval(() => {
    if (!_castSession) { _stopCastSync(); return; }

    // Keep button styled
    document.getElementById('cast-btn')?.classList.add('casting');

    // Sync progress bar and time display with Chromecast position
    const pos = _castCurrentTime();
    const dur = _castDuration();
    if (dur > 0) {
      const pct = (pos / dur) * 100;
      document.getElementById('progress-fill').style.width = pct + '%';
      if (tcEl) tcEl.textContent = fmtTime(pos);
      if (trEl) trEl.textContent = '-' + fmtTime(dur - pos);
    }

    // Sync play/pause icon with Chromecast state
    updatePlayIcon(_castIsPlaying());
  }, 1000);
}

function _stopCastSync() {
  clearInterval(_castSyncTimer);
  _castSyncTimer = null;
}

function _castConnect() {
  if (typeof cast === 'undefined' || !cast.framework) {
    toast('SDK de Chromecast no disponible. Abre desde HTTPS.');
    return;
  }
  // Plain HTTP cannot load the Cast SDK — suggest Cloudflare tunnel for local testing.
  if (location.protocol !== 'https:') {
    toast('Chromecast requiere HTTPS. Usa un túnel Cloudflare o abre con tu IP local vía HTTPS.');
    return;
  }
  _doCastConnect();
}

function _doCastConnect() {
  const ctx = cast.framework.CastContext.getInstance();
  ctx.requestSession().then(() => {
    const s = ctx.getCurrentSession();
    if (!s) return;

    // cast-manifest rewrites all URLs to absolute (Cloudflare tunnel / reverse-proxy aware)
    // and embeds a signed cast_token so the TV can fetch segments and AES keys regardless
    // of whether hotlink protection or video-token enforcement is active.
    const castManifestUrl = `${location.origin}/api/videos/${videoId}/cast-manifest`;

    const mi = new chrome.cast.media.MediaInfo(castManifestUrl, 'application/vnd.apple.mpegurl');
    mi.streamType = chrome.cast.media.StreamType.BUFFERED;

    // HLS content type hint for the default media receiver
    mi.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat?.TS || 'ts';
    mi.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat?.MPEG2_TS || 'mpeg2_ts';

    const meta = new chrome.cast.media.GenericMediaMetadata();
    meta.title = videoData?.title || document.title;
    if (videoData?.thumbnailUrl) {
      const thumbAbs = _castAbsoluteUrl(videoData.thumbnailUrl);
      if (!/^\/\/(localhost|127\.)/.test(thumbAbs.replace(/^https?:/, ''))) {
        meta.images = [{ url: thumbAbs }];
      }
    }
    mi.metadata = meta;

    const req = new chrome.cast.media.LoadRequest(mi);
    req.currentTime = video.currentTime || 0;
    req.autoplay = true;
    s.loadMedia(req).then(() => {
      toast('Transmitiendo en TV');
      // Aplicar pistas de audio y subtítulo activas al receptor Chromecast.
      // Se lanza con delay de 900 ms para dar tiempo al receptor a inicializar su lista de pistas.
      const audioLang  = hls?.audioTracks?.[currentAudioTrack >= 0 ? currentAudioTrack : 0]?.lang || null;
      const subEntry   = ccKey ? subtitlesList.find(t => subKey(t) === ccKey) : null;
      const desiredSub = subEntry ? (subEntry.language || null) : undefined; // undefined = apagar subs
      if (audioLang !== null || ccKey !== null) {
        setTimeout(() => _castEditTracks(audioLang, desiredSub), 900);
      }
      // Listen for media status updates to catch playback errors on the receiver
      const ms = s.getMediaSession();
      if (ms) {
        ms.addUpdateListener((isAlive) => {
          if (!isAlive) {
            console.warn('[cast] Media session ended on receiver');
            return;
          }
          if (ms.playerState === chrome.cast.media.PlayerState.IDLE && ms.idleReason) {
            if (ms.idleReason === chrome.cast.media.IdleReason.ERROR) {
              console.error('[cast] Receiver reported playback error');
              toast('Error de reproducción en el TV — verifica la conexión');
            }
          }
        });
      }
    }).catch(e => {
      console.error('[cast] loadMedia error:', e);
      const desc = e?.description || e?.message || e?.code || 'desconocido';
      toast('Error al transmitir: ' + desc);
      // If the error is a CORS/network issue, provide a more helpful message
      if (String(desc).toLowerCase().includes('load') || String(desc).toLowerCase().includes('network')) {
        toast('Verifica que el servidor sea accesible desde la red del Chromecast');
      }
    });
  }).catch(e => {
    if (e?.code !== 'cancel') toast('No se pudo conectar al Chromecast');
  });
}

function checkAirPlay() {
  const btn = document.getElementById('airplay-btn');
  if (!btn) return;
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    // Safari: el evento notifica cuándo hay dispositivos AirPlay disponibles en la red
    video.addEventListener('webkitplaybacktargetavailabilitychanged', e => {
      btn.style.display = e.availability === 'available' ? 'inline-flex' : 'none';
    });
  } else if (video.webkitShowPlaybackTargetPicker) {
    // Safari desktop más antiguo o Safari en iOS: mostrar siempre si la API existe
    btn.style.display = 'inline-flex';
  }
}
function triggerAirPlay() {
  // Nota: con HLS.js el video usa MSE (blob://). Antes de abrir el picker,
  // no hacemos switch todavía — el switch ocurre via webkitcurrentplaybacktargetiswirelesschanged
  // cuando el usuario selecciona un dispositivo AirPlay.
  if (video.webkitShowPlaybackTargetPicker) {
    video.webkitShowPlaybackTargetPicker();
  }
}

// ─── Speed ───────────────────────────────────────────────────
function setSpeed(v) {
  currentSpeed = v;
  video.playbackRate = v;
  localStorage.setItem('sv_playback_speed', v);
  document.getElementById('settings-menu').classList.remove('open');
  updateSettingsBadge();
  wakeChrome();
}

// ─── Progress bar seek ───────────────────────────────────────
const progressTrack = document.getElementById('progress-track');
progressTrack.addEventListener('click', e => {
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (_castSession) { _castSendSeek(pct * _castDuration()); } else { video.currentTime = pct * (video.duration || 0); }
  wakeChrome();
});
let seeking = false;
progressTrack.addEventListener('mousedown', e => { seeking = true; doSeek(e); });
document.addEventListener('mousemove', e => { if (seeking) doSeek(e); });
document.addEventListener('mouseup',  () => { seeking = false; });
function doSeek(e) {
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (_castSession) { _castSendSeek(pct * _castDuration()); } else { video.currentTime = pct * (video.duration || 0); }
}

// ─── Thumbnail scrub preview ─────────────────────────────────
const thumbCanvas = document.getElementById('thumb-canvas');
const thumbCtx    = thumbCanvas.getContext('2d');
const thumbPrev   = document.getElementById('thumb-preview');
const thumbTime   = document.getElementById('thumb-time');
const thumbChEl   = document.getElementById('thumb-chapter');
const hoverInd    = document.getElementById('progress-hover-indicator');
let previewVis = false, scrubPend = false, scrubTarget = 0;

function positionPreview(pct, t) {
  const trackW = progressTrack.offsetWidth;
  thumbPrev.style.left = Math.max(84, Math.min(trackW - 84, pct * trackW)) + 'px';
  thumbTime.textContent = fmtTime(t);
  if (!previewVis) { thumbPrev.classList.add('visible'); previewVis = true; }
}
function hidePreview() { thumbPrev.classList.remove('visible'); previewVis = false; hoverInd.style.width = '0'; hoverInd.style.opacity = ''; }
function drawSprite(t) {
  if (!spriteMeta || !spriteImg?.complete) return false;
  const { interval, columns, thumbW, thumbH } = spriteMeta;
  const fi = Math.min(spriteMeta.totalFrames - 1, Math.floor(t / interval));
  thumbCtx.drawImage(spriteImg, (fi % columns) * thumbW, Math.floor(fi / columns) * thumbH, thumbW, thumbH, 0, 0, 240, 135);
  return true;
}
thumbV.addEventListener('seeked', () => {
  try { thumbCtx.drawImage(thumbV, 0, 0, 240, 135); } catch {}
  scrubPend = false;
  if (Math.abs(thumbV.currentTime - scrubTarget) > 0.5) { thumbV.currentTime = scrubTarget; scrubPend = true; }
});
function seekThumb(t) { scrubTarget = t; if (!scrubPend) { thumbV.currentTime = t; scrubPend = true; } }
function handlePreview(pct, t) {
  hoverInd.style.width = pct * 100 + '%';
  positionPreview(pct, t);
  if (!drawSprite(t)) seekThumb(t);
}
progressTrack.addEventListener('mousemove', e => {
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  handlePreview(pct, pct * (video.duration || 0));
});
progressTrack.addEventListener('mouseleave', hidePreview);
let touchScrub = false;
progressTrack.addEventListener('touchstart', e => { touchScrub = true; wakeChrome(); }, { passive: true });
progressTrack.addEventListener('touchmove',  e => {
  if (!touchScrub) return;
  const rect = progressTrack.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
  handlePreview(pct, pct * (video.duration || 0));
  // Visual feedback: move the fill to the scrub position so the user sees where they'll land.
  // (Actual seek fires on touchend — this is purely cosmetic.)
  document.getElementById('progress-fill').style.width = (pct * 100) + '%';
  hoverInd.style.opacity = '1'; // `:hover` CSS doesn't trigger on touch — show manually
}, { passive: true });
progressTrack.addEventListener('touchend', e => {
  if (!touchScrub) return;
  touchScrub = false;
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.changedTouches[0].clientX - rect.left) / rect.width));
  if (_castSession) { _castSendSeek(pct * _castDuration()); } else { video.currentTime = pct * (video.duration || 0); }
  hidePreview(); wakeChrome();
});
progressTrack.addEventListener('touchcancel', () => { touchScrub = false; hidePreview(); });

// ─── Idle / gesture events ───────────────────────────────────
wrap.addEventListener('mousemove', wakeChrome);
wrap.addEventListener('touchstart', wakeChrome, { passive: true });
wrap.addEventListener('touchmove',  wakeChrome, { passive: true });
// Double-tap seek deshabilitado — los botones de skip visibles lo reemplazan.
let lastTap = 0, _dtPaused = false;
wrap.addEventListener('touchstart', e => {
  if (e.target.closest('button, input, .settings-wrap, .cc-wrap, .player-progress-dock')) return;
  const now = Date.now();
  _dtPaused = video.paused;
  lastTap   = now;
}, { passive: false });
let _chromePlayClickTimer = null;
wrap.addEventListener('click', e => {
  if (e.target.closest('button, input, .settings-wrap, .cc-wrap, .player-progress-dock, .resume-card, .shortcuts-hud, .fast-seek-hud')) return;
  // Immediate toggle — no delay. Double-click will undo the second toggle.
  togglePlay();
});
wrap.addEventListener('dblclick', e => {
  if (e.target.closest('button, input, .settings-wrap, .cc-wrap, .shortcuts-hud')) return;
  // Double-click: first click paused, second click unpaused → back to original.
  // Just toggle fullscreen.
  toggleFullscreen();
});

// ─── Close menus on outside click ───────────────────────────
document.addEventListener('click', e => {
  const path = e.composedPath();
  const insideSettings  = path.some(n => n.classList?.contains('settings-wrap'));
  const insideQualityBtn = path.some(n => n.id === 'quality-indicator-btn');
  const insideCcBtn     = path.some(n => n.id === 'cc-btn' || n.id === 'cc-wrap');
  if (!insideSettings && !insideQualityBtn && !insideCcBtn) {
    document.getElementById('settings-menu')?.classList.remove('open');
  }
});

// ─── Settings menu ───────────────────────────────────────────
const _chev_r = `<svg class="settings-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
const _chev_l = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><polyline points="15 18 9 12 15 6"/></svg>`;
const _chk    = `<svg class="settings-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

function toggleSettingsMenu(event) {
  if (event) event.stopPropagation(); // Evita que el listener global cierre el menú
  const menu = document.getElementById('settings-menu');
  const alreadyOpenOnMain = menu.classList.contains('open') && settingsView === 'main';
  if (alreadyOpenOnMain) {
    menu.classList.remove('open');
    return;
  }
  // Si está abierto en otra sección O cerrado, abrirlo en main
  if (hls) { audioTracks = hls.audioTracks || []; currentAudioTrack = hls.audioTrack ?? -1; }
  settingsView = 'main';
  renderSettingsMenu();
  menu.classList.add('open');
  wakeChrome();
}
function showSettingsSection(view) { settingsView = view; renderSettingsMenu(); }

// Abre el menú de subtítulos directamente desde el botón CC en la toolbar
function openSubtitlesMenu(event) {
  if (event) event.stopPropagation(); // Evita que el listener global cierre el menú
  const menu = document.getElementById('settings-menu');
  const alreadyOpen = menu.classList.contains('open') && settingsView === 'subtitles';
  if (alreadyOpen) {
    menu.classList.remove('open');
    return;
  }
  if (hls) { audioTracks = hls.audioTracks || []; currentAudioTrack = hls.audioTrack ?? -1; }
  settingsView = 'subtitles';
  renderSettingsMenu();
  menu.classList.add('open');
  wakeChrome();
}

// Abre el menú de calidad directamente desde el badge de calidad en la toolbar
function openQualityMenu(event) {
  if (event) event.stopPropagation(); // Evita que el listener global cierre el menú
  const menu = document.getElementById('settings-menu');
  const alreadyOpenOnQuality = menu.classList.contains('open') && settingsView === 'quality';
  if (alreadyOpenOnQuality) {
    menu.classList.remove('open');
    return;
  }
  if (hls) { audioTracks = hls.audioTracks || []; currentAudioTrack = hls.audioTrack ?? -1; }
  settingsView = 'quality';
  renderSettingsMenu();
  menu.classList.add('open');
  wakeChrome();
}

function _heightToQualityLabel(h) {
  if (!h) return null;
  if (h >= 2160) return { text: '4K',  cls: 'q-4k'  };
  if (h >= 1440) return { text: '2K',  cls: 'q-2k'  };
  if (h >= 1080) return { text: 'FHD', cls: 'q-fhd' };
  if (h >= 720)  return { text: 'HD',  cls: 'q-hd'  };
  return             { text: 'SD',  cls: 'q-sd'  };
}

function updateQualityIndicator(levelIdx) {
  const btn   = document.getElementById('quality-indicator-btn');
  const label = document.getElementById('quality-indicator-label');
  if (!btn || !label) return;

  // Determina la altura real del nivel activo
  const activeIdx = levelIdx !== undefined ? levelIdx : (currentLevel === -1 ? (hls ? hls.currentLevel : -1) : currentLevel);
  const h = levels[activeIdx]?.height;
  const q = _heightToQualityLabel(h);

  // Ocultar si no hay calidad válida, o si el video aún no tiene frames listos
  if (!q || !levels.length || !_videoCanPlay) {
    btn.style.display = 'none';
    return;
  }

  // Setear contenido ANTES de hacer visible para evitar flash de caja vacía
  label.textContent = q.text;
  btn.className = 'ctrl-btn quality-indicator-btn ' + q.cls;
  btn.style.display = 'inline-flex';
}

function updateSettingsBadge() {
  const badge = document.getElementById('settings-badge');
  // Solo mostrar el badge del engranaje cuando la velocidad es distinta a 1×
  if (!badge) return;
  if (currentSpeed !== 1) {
    badge.textContent = currentSpeed + '×';
    badge.className = 'settings-badge show speed-text';
  } else {
    badge.textContent = '';
    badge.className = 'settings-badge';
  }
  // Siempre sincronizar el indicador de calidad
  updateQualityIndicator();
}

function renderSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  if (!menu) return;

  if (settingsView === 'quality') {
    const opts = [{ label: 'AUTO', level: -1 }];
    levels.forEach((l, i) => {
      let label = l.height ? `${l.height}p` : `Nivel ${i}`;
      if (l.height >= 2160) label = '4K Ultra HD';
      else if (l.height >= 1080) label = '1080p FHD';
      else if (l.height >= 720)  label = '720p HD';
      opts.push({ label, level: i });
    });
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Calidad</button>` +
      `<div class="settings-divider"></div>` +
      opts.map(o => `<div class="settings-opt${o.level === currentLevel ? ' active' : ''}" onclick="setQuality(${o.level})">${_chk}${o.label}</div>`).join('');
    return;
  }

  if (settingsView === 'audio') {
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Audio</button>` +
      `<div class="settings-divider"></div>` +
      audioTracks.map((t, i) => {
        const label  = t.name || (t.lang ? t.lang.toUpperCase() : `Pista ${i + 1}`);
        const active = i === currentAudioTrack || (currentAudioTrack === -1 && i === 0);
        return `<div class="settings-opt${active ? ' active' : ''}" onclick="setAudioTrack(${i})">${_chk}${label}</div>`;
      }).join('');
    return;
  }

  if (settingsView === 'subtitles') {
    const trackRows = [{ key: null, label: 'Desactivado' }, ...subtitlesList.map(t => ({ key: subKey(t), label: t.label || t.language.toUpperCase() }))]
      .map(o => `<div class="settings-opt${ccKey === o.key ? ' active' : ''}" onclick="setCcByKey(${o.key === null ? 'null' : "'" + o.key + "'"})">${_chk}${o.label}</div>`)
      .join('');
    const customizeRow = subtitlesList.length > 0
      ? `<div class="settings-divider"></div>
         <div class="settings-row" onclick="showSettingsSection('subtitle-style')">
           <span class="settings-row-label">Personalizar subtítulos</span>
           ${_chev_r}
         </div>`
      : '';
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Subtítulos</button>` +
      `<div class="settings-divider"></div>` +
      trackRows + customizeRow;
    return;
  }

  if (settingsView === 'subtitle-style') {
    const _szl = { small:'Peq', normal:'Med', large:'Gde', xlarge:'XL' };
    const offset = subPrefs.syncOffset || 0;
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('subtitles')">${_chev_l} Personalizar</button>` +
      `<div class="settings-divider"></div>` +
      `<div class="cc-setting-row">
        <span class="cc-setting-label">Tamaño</span>
        <div class="cc-setting-opts" data-cols="4">
          ${['small','normal','large','xlarge'].map(s => `<button class="cc-style-btn${subPrefs.size===s?' active':''}" onclick="setSubPref('size','${s}')">${_szl[s]}</button>`).join('')}
        </div>
      </div>` +
      `<div class="cc-setting-row">
        <span class="cc-setting-label">Color</span>
        <div class="cc-setting-opts" data-cols="3">
          <button class="cc-style-btn${subPrefs.color==='white'?' active':''}" onclick="setSubPref('color','white')"><span class="cc-color-dot" style="background:#fff"></span>Blanco</button>
          <button class="cc-style-btn${subPrefs.color==='yellow'?' active':''}" onclick="setSubPref('color','yellow')"><span class="cc-color-dot" style="background:#ff0"></span>Amarillo</button>
          <button class="cc-style-btn${subPrefs.color==='cyan'?' active':''}" onclick="setSubPref('color','cyan')"><span class="cc-color-dot" style="background:#0ff"></span>Cyan</button>
        </div>
      </div>` +
      `<div class="cc-setting-row" style="align-items:center;">
        <span class="cc-setting-label">Fondo</span>
        <input class="cc-range" type="range" min="0" max="1" step="0.05"
          value="${subPrefs.bg}" oninput="setSubPref('bg',parseFloat(this.value))"
          style="flex:1;min-width:60px;">
        <span class="cc-range-val">${Math.round(subPrefs.bg * 100)}%</span>
      </div>` +
      ``;
    return;
  }

  if (settingsView === 'speed') {
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Velocidad</button>` +
      `<div class="settings-divider"></div>` +
      [0.5, 0.75, 1, 1.25, 1.5, 2].map(v =>
        `<div class="settings-opt${currentSpeed === v ? ' active' : ''}" onclick="setSpeed(${v})">${_chk}${v === 1 ? 'Normal' : v + '×'}</div>`
      ).join('');
    return;
  }

  // Main view
  const qualLabel  = currentLevel === -1 ? 'AUTO' : (levels[currentLevel]?.height ? levels[currentLevel].height + 'p' : `L${currentLevel}`);
  const speedLabel = currentSpeed === 1 ? 'Normal' : currentSpeed + '×';
  let html = '';
  if (hls && levels.length) {
    html += `<div class="settings-row" onclick="showSettingsSection('quality')">
      <span class="settings-row-label">Calidad</span>
      <span class="settings-row-value">${qualLabel}</span>${_chev_r}
    </div>`;
  }
  if (audioTracks.length > 0) {
    const idx   = currentAudioTrack === -1 ? 0 : currentAudioTrack;
    const albl  = audioTracks[idx]?.name || audioTracks[idx]?.lang?.toUpperCase() || 'Auto';
    html += `<div class="settings-row" onclick="showSettingsSection('audio')">
      <span class="settings-row-label">Audio</span>
      <span class="settings-row-value">${albl}</span>${_chev_r}
    </div>`;
  }
  {
    const slbl = subtitlesList.length === 0 ? 'Sin subtítulos'
      : ccKey ? (subtitlesList.find(t => subKey(t) === ccKey)?.label || ccKey.split('|')[1] || ccKey) : 'Desactivado';
    const rowStyle = subtitlesList.length === 0 ? ' style="opacity:0.45;pointer-events:none;"' : '';
    html += `<div class="settings-row"${rowStyle} onclick="showSettingsSection('subtitles')">
      <span class="settings-row-label">Subtítulos</span>
      <span class="settings-row-value">${slbl}</span>${subtitlesList.length > 0 ? _chev_r : ''}
    </div>`;
  }
  html += `<div class="settings-row" onclick="showSettingsSection('speed')">
    <span class="settings-row-label">Velocidad</span>
    <span class="settings-row-value">${speedLabel}</span>${_chev_r}
  </div>`;
  menu.innerHTML = html;
  updateSettingsBadge();
}

function setQuality(level) {
  if (!hls) return;
  hls.currentLevel = level; currentLevel = level;
  document.getElementById('settings-menu').classList.remove('open');
  updateSettingsBadge();
  trackEvent('quality_change', { quality: level === -1 ? 'AUTO' : (levels[level]?.height ? levels[level].height + 'p' : `L${level}`) });
  wakeChrome();
}
function setAudioTrack(index) {
  currentAudioTrack = index;
  if (hls) {
    // HLS.js path (Chrome, Firefox, Edge)
    hls.audioTrack = index;
    const lang = hls.audioTracks?.[index]?.lang || hls.audioTracks?.[index]?.name || null;
    if (lang) localStorage.setItem(`sv_audio_${videoId}`, lang);
    else localStorage.removeItem(`sv_audio_${videoId}`);
    if (_castSession) _castEditTracks(lang, null);
  } else if (video.audioTracks && video.audioTracks.length > index) {
    // Native HLS path (Safari / iOS) — toggle via HTMLMediaElement.audioTracks
    const lang = audioTracks[index]?.lang || audioTracks[index]?.name || null;
    for (let i = 0; i < video.audioTracks.length; i++) {
      video.audioTracks[i].enabled = (i === index);
    }
    if (lang) localStorage.setItem(`sv_audio_${videoId}`, lang);
    else localStorage.removeItem(`sv_audio_${videoId}`);
  }
  document.getElementById('settings-menu').classList.remove('open');
  renderSettingsMenu();
}

// ─── CC / Subtítulos ─────────────────────────────────────────
// subKey uniquely identifies a track even when two share the same language.
function subKey(t) { return t ? (t.language + '|' + (t.label || t.language)) : null; }

// Unique key of the currently active subtitle track (null = off)
let ccKey = null;

// Force all native text tracks to hidden to prevent browser from rendering them
function disableAllNativeTracks() {
  for (let i = 0; i < video.textTracks.length; i++) {
    const track = video.textTracks[i];
    if (track.mode !== 'disabled') track.mode = 'hidden';
  }
}

// Quick toggle on CC button: on → off, off → restore last or pick first
function toggleCcQuick() {
  if (!subtitlesList.length) return;
  if (ccKey !== null) {
    setCcByKey(null);
  } else {
    const saved = localStorage.getItem(`sv_cc_${videoId}`);
    const entry = (saved && saved !== 'null')
      ? (subtitlesList.find(t => subKey(t) === saved) || subtitlesList[0])
      : subtitlesList[0];
    if (entry) setCcByKey(subKey(entry));
  }
}

// ─── WebVTT parser + renderer (para pistas de transcripción IA) ──────────────
// Las pistas de IA requieren auth headers — el <track> nativo no puede enviarlos.
// Fetching manual con auth + parser WebVTT completo + loop de sincronización preciso.

let _vttCues  = []; // [{start:number, end:number, lines:string[]}]
let _vttTimer = null;
let _vttLastRendered = ''; // evitar re-renders innecesarios

/**
 * Parsea texto WebVTT y retorna array de cues normalizados.
 * Cumple con W3C WebVTT spec: https://www.w3.org/TR/webvtt1/
 */
function _parseVtt(rawText) {
  const cues = [];
  // Normalizar line endings
  const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Verificar header WEBVTT
  if (!text.startsWith('WEBVTT')) {
    console.warn('[vtt] Missing WEBVTT header');
  }

  // Separar bloques por líneas en blanco (≥1 línea vacía)
  const blocks = text.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // Saltar bloque WEBVTT header, NOTE, STYLE, REGION
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE') ||
        lines[0].startsWith('STYLE') || lines[0].startsWith('REGION')) continue;

    // Encontrar línea de timestamp (puede estar precedida por un cue ID)
    let tsLineIdx = lines.findIndex(l => l.includes('-->'));
    if (tsLineIdx === -1) continue;

    // Parsear timestamps — formato: HH:MM:SS.mmm --> HH:MM:SS.mmm [settings]
    const tsLine = lines[tsLineIdx];
    // Separar en start --> end usando regex para manejar espacios variables
    const tsMatch = tsLine.match(
      /^([\d:\.]+)\s+-->\s+([\d:\.]+)(?:\s+.+)?$/
    );
    if (!tsMatch) continue;

    const start = _vttTs(tsMatch[1]);
    const end   = _vttTs(tsMatch[2]);
    if (isNaN(start) || isNaN(end) || end <= start) continue;

    // Texto del cue: todo lo que viene después del timestamp
    const rawLines = lines.slice(tsLineIdx + 1);
    if (!rawLines.length) continue;

    // Limpiar etiquetas WebVTT de voz (<v Speaker>), formato (<b>, <i>, <u>),
    // ruby, timestamp tags (<00:01.000>), etc. — solo dejar texto plano
    const cleanLines = rawLines
      .map(l => l
        .replace(/<\d+:\d+[\d:.]*>/g, '')    // timestamp tags
        .replace(/<\/?(v|lang|ruby|rt|c)\b[^>]*>/g, '')  // voice/ruby/class
        .replace(/<\/?[biusc][^>]*>/g, '')   // bold/italic/underline/strike/code
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, '\u00a0')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .trim()
      )
      .filter(Boolean);

    if (!cleanLines.length) continue;

    cues.push({ start, end, lines: cleanLines });
  }

  // Ordenar por tiempo de inicio (por si el VTT está desordenado)
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/**
 * Convierte timestamp WebVTT a segundos con precisión de milisegundos.
 * Soporta HH:MM:SS.mmm, MM:SS.mmm, HH:MM:SS,mmm (SRT style), etc.
 */
function _vttTs(ts) {
  // Normalizar separador decimal (, → .)
  ts = ts.replace(',', '.');
  const parts = ts.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (isNaN(m) || isNaN(s)) return NaN;
    return m * 60 + s;
  }
  const s = parseFloat(ts);
  return isNaN(s) ? NaN : s;
}

/**
 * Arranca el loop de sincronización de subtítulos.
 * Usa requestAnimationFrame para mayor precisión que setInterval.
 * Renderiza solo cuando cambia el contenido activo.
 * NOTA: no llama a _stopVttLoop() para no borrar _vttCues ya cargados.
 */
function _startVttLoop() {
  // Solo cancela el RAF anterior, NO borra _vttCues
  if (_vttTimer) { _vttTimer.cancel(); _vttTimer = null; }
  _vttLastRendered = '';
  let rafId = null;

  function tick() {
    if (!_subDisplay || !_vttCues.length) { rafId = requestAnimationFrame(tick); return; }
    const t = video.currentTime;
    const active = _vttCues.filter(c => t >= c.start && t < c.end);

    // Construir key del contenido actual para evitar re-renders
    const key = active.map(c => c.lines.join('|')).join('§');
    if (key !== _vttLastRendered) {
      _vttLastRendered = key;
      _subDisplay.innerHTML = '';
      for (const c of active) {
        for (const line of c.lines) {
          const span = document.createElement('span');
          span.className = 'sv-sub-line';
          span.textContent = line;
          _subDisplay.appendChild(span);
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);
  // Guardar referencia para poder cancelar
  _vttTimer = { cancel: () => { if (rafId) cancelAnimationFrame(rafId); rafId = null; } };
}

function _stopVttLoop() {
  if (_vttTimer) { _vttTimer.cancel(); _vttTimer = null; }
  _vttLastRendered = '';
  _vttCues = [];
  if (_subDisplay) _subDisplay.innerHTML = '';
}

// Primary subtitle selector — key is a subKey string or null
function setCcByKey(key) {
  const entry = key === null ? null : subtitlesList.find(t => subKey(t) === key);
  ccKey  = key;
  ccLang = entry?.language || null;

  document.getElementById('cc-btn')?.classList.toggle('active', key !== null);

  // Stop any VTT loop from previous track
  _stopVttLoop();
  _vttCues = [];

  // Detach native track listener
  if (_activeTextTrack) {
    _activeTextTrack.removeEventListener('cuechange', _onCueChange);
    _activeTextTrack.mode = 'hidden';
    _activeTextTrack = null;
  }
  if (_subDisplay) _subDisplay.innerHTML = '';
  disableAllNativeTracks();

  localStorage.setItem(`sv_cc_${videoId}`, key === null ? 'null' : key);

  if (_castSession) {
    // undefined = turn off, language string = activate that track
    _castEditTracks(null, entry ? (entry.language || undefined) : undefined);
  }

  if (!entry) { renderSettingsMenu(); wakeChrome(); return; }

  // Always fetch VTT via our server proxy and use the custom overlay renderer.
  // This avoids <track> element CORS restrictions entirely — the browser blocks
  // cross-origin <track> loading even when HLS.js is configured with subtitleDisplay:false,
  // because HLS.js still adds <track> elements for subtitle streams in the m3u8.
  // The tracks API now returns same-origin proxy URLs (/api/videos/:id/tracks/serve/:file)
  // so fetch() works without CORS headers on the CDN side.
  const token = _svToken();
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  fetch(entry.src, { headers })
    .then(r => {
      if (!r.ok) throw new Error('VTT fetch failed: ' + r.status);
      return r.text();
    })
    .then(vttText => {
      _vttCues = _parseVtt(vttText);
      _startVttLoop();
      document.getElementById('cc-btn')?.classList.add('active');
    })
    .catch(err => {
      console.warn('[subtitles] Failed to load VTT:', err);
      toast('No se pudieron cargar los subtítulos');
    });

  renderSettingsMenu();
  wakeChrome();
}

// ─── Custom subtitle overlay renderer ────────────────────────
const _subDisplay = document.getElementById('sv-subtitle-display');
let _activeTextTrack = null;

function _onCueChange() {
  if (!_subDisplay) return;
  if (!_activeTextTrack || _activeTextTrack.mode === 'disabled') { _subDisplay.innerHTML = ''; return; }
  const cues = _activeTextTrack.activeCues;
  if (!cues || cues.length === 0) { _subDisplay.innerHTML = ''; return; }
  const lines = [];
  for (let i = 0; i < cues.length; i++) {
    let text = '';
    if (typeof cues[i].getCueAsHTML === 'function') {
      const frag = cues[i].getCueAsHTML();
      const tmp  = document.createElement('span');
      tmp.appendChild(frag);
      text = tmp.innerHTML.replace(/<\/?[^>]+(>|$)/g, '').trim();
    } else {
      text = (cues[i].text || '').trim();
    }
    text = text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
    if (text) lines.push(text);
  }
  // SECURITY: Use textContent per span — never inject subtitle text via innerHTML.
  // Subtitle cue text from VTT files must be treated as untrusted user content.
  _subDisplay.innerHTML = '';
  for (const l of lines) {
    const span = document.createElement('span');
    span.className = 'sv-sub-line';
    span.textContent = l; // Safe: textContent never interprets HTML
    _subDisplay.appendChild(span);
  }
}

// ─── Mapa de códigos ISO 639-1 → nombre completo en español ──
const _LANG_NAMES = {
  af:'Afrikáans', sq:'Albanés', am:'Amhárico', ar:'Árabe', hy:'Armenio',
  az:'Azerbaiyano', eu:'Euskera', be:'Bielorruso', bn:'Bengalí', bs:'Bosnio',
  bg:'Búlgaro', ca:'Catalán', ceb:'Cebuano', zh:'Chino', co:'Corso',
  hr:'Croata', cs:'Checo', da:'Danés', nl:'Neerlandés', en:'Inglés',
  eo:'Esperanto', et:'Estonio', fi:'Finlandés', fr:'Francés', fy:'Frisón',
  gl:'Gallego', ka:'Georgiano', de:'Alemán', el:'Griego', gu:'Gujarati',
  ht:'Haitiano', ha:'Hausa', haw:'Hawaiano', he:'Hebreo', hi:'Hindi',
  hmn:'Hmong', hu:'Húngaro', is:'Islandés', ig:'Igbo', id:'Indonesio',
  ga:'Irlandés', it:'Italiano', ja:'Japonés', jw:'Javanés', kn:'Canarés',
  kk:'Kazajo', km:'Jemer', rw:'Kinyarwanda', ko:'Coreano', ku:'Kurdo',
  ky:'Kirguís', lo:'Lao', la:'Latín', lv:'Letón', lt:'Lituano',
  lb:'Luxemburgués', mk:'Macedonio', mg:'Malgache', ms:'Malayo',
  ml:'Malayalam', mt:'Maltés', mi:'Maorí', mr:'Maratí', mn:'Mongol',
  my:'Birmano', ne:'Nepalés', no:'Noruego', ny:'Chichewa', or:'Oriya',
  ps:'Pastún', fa:'Persa', pl:'Polaco', pt:'Portugués', pa:'Punyabí',
  ro:'Rumano', ru:'Ruso', sm:'Samoano', gd:'Gaélico escocés', sr:'Serbio',
  st:'Sesoto', sn:'Shona', sd:'Sindhi', si:'Cingalés', sk:'Eslovaco',
  sl:'Esloveno', so:'Somalí', es:'Español', su:'Sundanés', sw:'Suajili',
  sv:'Sueco', tl:'Filipino', tg:'Tayiko', ta:'Tamil', tt:'Tártaro',
  te:'Telugu', th:'Tailandés', tr:'Turco', tk:'Turcomano', uk:'Ucraniano',
  ur:'Urdu', ug:'Uigur', uz:'Uzbeko', vi:'Vietnamita', cy:'Galés',
  xh:'Xhosa', yi:'Yídish', yo:'Yoruba', zu:'Zulú',
};

function _langName(code) {
  return _LANG_NAMES[code?.toLowerCase()] || code?.toUpperCase() || code;
}

async function loadSubtitles() {
  try {
    const [txRes, trRes] = await Promise.allSettled([
      fetch(`${BASE}/api/videos/${videoId}/transcriptions`, { headers: _authHdr() }),
      fetch(`${BASE}/api/videos/${videoId}/tracks`, { headers: _authHdr() }),
    ]);
    const offset = subPrefs.syncOffset || 0;
    const txList = txRes.status === 'fulfilled' && txRes.value.ok
      ? (await txRes.value.json()).filter(t => t.status === 'ready').map(t => ({
          language: t.language, label: _langName(t.language) + ' (IA)',
          src: `${BASE}/api/videos/${videoId}/transcriptions/${t.language}/subtitles.vtt${offset !== 0 ? '?offset=' + offset : ''}`,
        }))
      : [];
    const uploaded = trRes.status === 'fulfilled' && trRes.value.ok
      ? (await trRes.value.json()).filter(t => t.kind === 'subtitle' && t.url).map(t => ({
          language: t.language, label: t.label || t.language.toUpperCase(),
          src: t.url,
          isDefault: !!t.default_track,
        }))
      : [];
    subtitlesList = [...txList, ...uploaded];

    // Inject <track> elements for Safari native HLS
    // NOTE: Never set el.default = true, as it causes browser to auto-activate native rendering,
    // which duplicates subtitles with our custom overlay. We handle defaults manually via setCcByKey below.
    for (const tr of uploaded) {
      const already = [...video.textTracks].some(t => t.language === tr.language && t.label === tr.label);
      if (!already) {
        const el = document.createElement('track');
        el.kind = 'subtitles'; el.srclang = tr.language; el.label = tr.label; el.src = tr.src;
        // el.default = true; ← REMOVED: causes native rendering + duplicate subtitles
        video.appendChild(el);
        // Set to 'hidden' (not 'disabled') so iOS native player shows the CC button
        // and lists all available tracks in its subtitle picker, even when none
        // is currently active. 'disabled' hides tracks from the iOS picker entirely.
        requestAnimationFrame(() => { el.track.mode = 'hidden'; });
      }
    }

    // Show CC button when tracks are available
    const ccWrap = document.getElementById('cc-wrap');
    if (ccWrap) ccWrap.classList.toggle('has-tracks', subtitlesList.length > 0);
    renderSettingsMenu();

    // Restore last choice or activate default track
    const saved = localStorage.getItem(`sv_cc_${videoId}`);
    if (saved !== null && saved !== 'null') {
      const entry = subtitlesList.find(t => subKey(t) === saved || t.language === saved);
      if (entry) setCcByKey(subKey(entry));
    } else if (saved === null) {
      const def = uploaded.find(t => t.isDefault);
      if (def) setCcByKey(subKey(def));
    }
  } catch (e) { console.warn('[player] loadSubtitles:', e); }
}

// ─── Subtitle style preferences ──────────────────────────────
const SUB_DEF = { size: 'normal', color: 'white', bg: 0.75, syncOffset: 0 };
let subPrefs = { ...SUB_DEF };
function loadSubPrefs() {
  try { subPrefs = { ...SUB_DEF, ...JSON.parse(localStorage.getItem('sv_sub_prefs') || '{}') }; } catch {}
}
function saveSubPrefs() { localStorage.setItem('sv_sub_prefs', JSON.stringify(subPrefs)); }
function setSubPref(key, value) {
  subPrefs[key] = value;
  saveSubPrefs();
  applySubStyle();
  renderSettingsMenu();
}
function adjustSubSync(delta) {
  subPrefs.syncOffset = Math.max(-10, Math.min(10, (subPrefs.syncOffset || 0) + delta));
  saveSubPrefs();
  renderSettingsMenu();
  // Recargar subtítulos si hay uno activo
  if (ccKey) {
    const currentKey = ccKey;
    setCcByKey(null);
    setTimeout(() => setCcByKey(currentKey), 100);
    toast(`Sincronización: ${subPrefs.syncOffset > 0 ? '+' : ''}${subPrefs.syncOffset.toFixed(1)}s`);
  }
}
function applySubStyle() {
  document.getElementById('sv-sub-style')?.remove();
  const sizes  = { small:'14px', normal:'18px', large:'24px', xlarge:'32px' };
  const colors = { white:'#fff', yellow:'#ff0', cyan:'#0ff' };
  const fs   = sizes[subPrefs.size]  || '18px';
  const col  = colors[subPrefs.color] || '#fff';
  const bg   = Math.max(0, Math.min(1, subPrefs.bg));
  const style = document.createElement('style');
  style.id = 'sv-sub-style';
  // background applied to .sv-sub-line pills only (NOT the container) to avoid double-background.
  // video::cue uses transparent background since our custom display handles rendering.
  style.textContent =
    `video::cue{font-size:${fs};color:${col};background-color:transparent;font-family:var(--pv-sans,'DM Sans',sans-serif);font-weight:600;line-height:1.4;}` +
    `#sv-subtitle-display{font-size:${fs};color:${col};}` +
    `#sv-subtitle-display .sv-sub-line{background:rgba(0,0,0,${bg});}`;
  document.head.appendChild(style);
}

// ─── Native audio track sync helper (iOS HLS) ────────────────
// Called at loadedmetadata AND on addtrack events because iOS
// sometimes exposes audio tracks after the initial metadata event.
function _syncNativeAudioTracks() {
  if (!video.audioTracks || video.audioTracks.length < 2) return;
  audioTracks = [];
  for (let i = 0; i < video.audioTracks.length; i++) {
    const t = video.audioTracks[i];
    audioTracks.push({ name: t.label || t.language || ('Pista ' + (i + 1)), lang: t.language || '' });
    if (t.enabled) currentAudioTrack = i;
  }
  if (currentAudioTrack < 0) currentAudioTrack = 0;
  // Restore saved audio preference
  const savedLang = localStorage.getItem('sv_audio_' + videoId);
  if (savedLang) {
    for (let i = 0; i < video.audioTracks.length; i++) {
      if (video.audioTracks[i].language === savedLang || video.audioTracks[i].label === savedLang) {
        video.audioTracks[i].enabled = true;
        currentAudioTrack = i;
      } else {
        video.audioTracks[i].enabled = (i === 0 && currentAudioTrack !== i) ? false : video.audioTracks[i].enabled;
      }
    }
  }
  // Show settings gear if we now have audio tracks
  const sbtn = document.getElementById('settings-btn');
  if (sbtn && sbtn.style.display === 'none') sbtn.style.display = '';
}

// ─── HLS init ────────────────────────────────────────────────
function initHls(m3u8Url) {
  _hlsSourceUrl = m3u8Url; // guardar para AirPlay (necesita URL real, no blob://)

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true, lowLatencyMode: false,
      maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 60e6, maxBufferHole: 0.3,
      backBufferLength: 90, startLevel: -1, abrEwmaDefaultEstimate: 1e6,
      abrEwmaFastVoD: 3, abrEwmaSlowVoD: 9, abrBandWidthFactor: 0.8, abrBandWidthUpFactor: 0.7,
      highBufferWatchdogPeriod: 2, nudgeMaxRetry: 5,
      // Subtitles are managed entirely by the player (loadSubtitles / setCcByKey).
      // Disabling HLS.js subtitle display prevents it from injecting <track> elements
      // with relative URIs from the m3u8 that the browser resolves against the page
      // URL instead of the manifest URL, causing 404s.
      subtitleDisplay: false,
      xhrSetup: hlsXhrSetup,
    });
    hls.loadSource(m3u8Url);
    hls.attachMedia(video);

    // ── AirPlay + HLS.js: Apple TV no puede recibir blob:// de MSE ──────────
    // Cuando AirPlay conecta, cambiamos a native src (URL real del m3u8).
    // Cuando AirPlay desconecta, reenganchamos HLS.js para tener ABR, calidades, etc.
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', function _onAirPlayChange() {
      isAirPlayActive = !!video.webkitCurrentPlaybackTargetIsWireless;
      if (isAirPlayActive) {
        // AirPlay conectado → switch a native HLS para que Apple TV pueda reproducir
        const pos    = video.currentTime;
        const paused = video.paused;
        // Guardar pista de audio e idioma de subtítulo activos antes de desconectar HLS.js
        const savedAudioLang = hls?.audioTracks?.[currentAudioTrack >= 0 ? currentAudioTrack : 0]?.lang || null;
        const savedCcLang    = ccLang;

        hls.stopLoad();
        hls.detachMedia();
        video.src = _hlsSourceUrl;
        video.load();
        video.currentTime = pos;
        if (!paused) video.play().catch(() => {});

        // Tras cargar el manifest nativo, restaurar audio y activar subtítulo para Apple TV.
        // El overlay HTML sigue corriendo en paralelo (se ve en la pantalla local).
        // La pista nativa con mode='showing' es lo que Safari envía al Apple TV.
        video.addEventListener('loadedmetadata', function _applyAirPlayTracks() {
          // ── Pista de audio ─────────────────────────────────────
          if (savedAudioLang && video.audioTracks?.length > 1) {
            for (let i = 0; i < video.audioTracks.length; i++) {
              video.audioTracks[i].enabled = (video.audioTracks[i].language === savedAudioLang);
            }
          }
          // ── Subtítulos para Apple TV ───────────────────────────
          // Activar la primera pista que coincida con el idioma seleccionado;
          // ocultar el resto para evitar duplicados.
          let ccApplied = false;
          for (let i = 0; i < video.textTracks.length; i++) {
            const isMatch = savedCcLang && video.textTracks[i].language === savedCcLang;
            if (isMatch && !ccApplied) {
              video.textTracks[i].mode = 'showing'; // Apple TV recibe esta pista
              ccApplied = true;
            } else {
              video.textTracks[i].mode = 'hidden';
            }
          }
        }, { once: true });

      } else {
        // AirPlay desconectado → re-enganchar HLS.js
        const pos = video.currentTime;
        // Volver al modo overlay: deshabilitar pistas nativas para evitar doble render
        disableAllNativeTracks();
        video.src = '';
        hls.attachMedia(video);
        hls.loadSource(_hlsSourceUrl);
        hls.once(Hls.Events.MANIFEST_PARSED, () => {
          video.currentTime = pos;
          video.play().catch(() => {});
          // Restaurar la pista de audio que el usuario tenía seleccionada en HLS.js
          if (currentAudioTrack >= 0 && currentAudioTrack < (hls.audioTracks?.length || 0)) {
            hls.audioTrack = currentAudioTrack;
          }
        });
      }
    }, { once: false });

    // Thumb seek video (lowest quality for previews)
    if (!spriteMeta) {
      const th = new Hls({ maxBufferLength: 5 });
      th.loadSource(m3u8Url);
      th.attachMedia(thumbV);
      th.on(Hls.Events.MANIFEST_PARSED, () => { th.currentLevel = 0; });
    }

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      levels = hls.levels;
      audioTracks = hls.audioTracks;
      currentAudioTrack = hls.audioTrack;

      // Restore saved audio track preference (matched by language, not index)
      if (audioTracks.length > 1) {
        const savedLang = localStorage.getItem(`sv_audio_${videoId}`);
        if (savedLang) {
          const savedIdx = audioTracks.findIndex(t => (t.lang || t.name) === savedLang);
          if (savedIdx >= 0 && savedIdx !== currentAudioTrack) {
            hls.audioTrack = savedIdx;
            currentAudioTrack = savedIdx;
          }
        }
      }

      _manifestReady = true; // HLS ready — now safe to show quality button and settings gear
      // Show settings gear only after HLS manifest is ready (has actual menu content)
      const sbtn = document.getElementById('settings-btn');
      if (sbtn) sbtn.style.display = '';
      updateSettingsBadge();
      renderSettingsMenu();
      const t0 = parseFloat(new URLSearchParams(location.search).get('t') || '0');
      if (t0 > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t0; }, { once: true });
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
      // Actualizar el indicador de calidad en la toolbar (Prime Video style)
      updateQualityIndicator(d.level);
      if (settingsView === 'quality') renderSettingsMenu();
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { audioTracks = hls.audioTracks; currentAudioTrack = hls.audioTrack; renderSettingsMenu(); });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, d) => { currentAudioTrack = d.id; });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showError('Error reproduciendo el video');
      }
    });

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // ── Native HLS (Safari / iOS) ──────────────────────────────
    // HLS.js is NOT used here — the browser plays HLS natively.
    // We still load subtitles via our custom overlay (VTT loop),
    // and expose audio tracks from the native HTMLMediaElement API.

    // ── Block HLS-manifest subtitle TextTracks ──────────────────
    // If the manifest has #EXT-X-MEDIA:TYPE=SUBTITLES entries (legacy videos),
    // iOS Safari adds them to video.textTracks automatically. Those entries point
    // to raw .vtt files (not valid HLS segment playlists), so iOS native player
    // can't render them. Worse, they appear as duplicate, broken entries in the
    // iOS native player's subtitle picker alongside our working <track> elements.
    // Fix: any TextTrack NOT from one of our DOM <track> elements is immediately
    // disabled so it never reaches the iOS picker. Our <track> elements (added by
    // loadSubtitles() below) remain in 'hidden' mode and work correctly.
    video.textTracks.addEventListener('addtrack', evt => {
      const isOurs = [...video.querySelectorAll('track')].some(el => el.track === evt.track);
      if (!isOurs) evt.track.mode = 'disabled';
    });
    // Disable any textTracks that may already be present at this point
    for (let i = 0; i < video.textTracks.length; i++) {
      const isOurs = [...video.querySelectorAll('track')].some(el => el.track === video.textTracks[i]);
      if (!isOurs) video.textTracks[i].mode = 'disabled';
    }

    // When signed cookies are active, tell Safari to send credentials cross-origin
    if (_cfSessionActive) video.crossOrigin = 'use-credentials';
    video.src = m3u8Url;
    if (!spriteMeta) thumbV.src = m3u8Url;

    video.addEventListener('loadedmetadata', () => {
      const t0 = parseFloat(new URLSearchParams(location.search).get('t') || '0');
      if (t0 > 0) video.currentTime = t0;

      // ── Show settings gear ──────────────────────────────────
      const sbtn = document.getElementById('settings-btn');
      if (sbtn) sbtn.style.display = '';

      // ── Native audio tracks (iOS exposes video.audioTracks) ─
      // HLS audio tracks may be available at loadedmetadata or may
      // arrive later via addtrack events — handle both cases.
      _syncNativeAudioTracks();

      _manifestReady = true;
      updateSettingsBadge();
      renderSettingsMenu();
      video.play().catch(() => {});
    });

    // Listen for audio tracks added after loadedmetadata (common on iOS HLS)
    if (video.audioTracks) {
      video.audioTracks.addEventListener('addtrack', () => {
        _syncNativeAudioTracks();
        renderSettingsMenu();
      });
      video.audioTracks.addEventListener('removetrack', () => {
        _syncNativeAudioTracks();
        renderSettingsMenu();
      });
    }

    // NOTE: loadSubtitles() is called in init() after initHls() returns,
    // so we do NOT call it here — avoids a double-call on iOS Safari.
  } else {
    showError('Tu navegador no soporta reproducción HLS');
  }
}

// ─── Video events ────────────────────────────────────────────
// Mostrar quality badge solo cuando el video tiene frames listos (no durante buffering inicial)
video.addEventListener('canplay', () => {
  if (!_videoCanPlay) {
    _videoCanPlay = true;
    updateQualityIndicator();
  }
});

let viewCounted = false;
video.addEventListener('play', () => {
  updatePlayIcon(true);
  wakeChrome();
  if (!viewCounted && videoId) {
    viewCounted = true;
    // Skip request if we already counted a view for this video in the last 30s (avoids 429)
    const ssKey = `sv_view_${videoId}`;
    const last = parseInt(sessionStorage.getItem(ssKey) || '0', 10);
    if (Date.now() - last < 30_000) { trackEvent('play'); return; }
    sessionStorage.setItem(ssKey, Date.now());
    fetch(`/api/videos/${videoId}/views`, { method: 'POST' }).catch(() => {});
  }
  trackEvent('play');
});
video.addEventListener('pause', () => { updatePlayIcon(false); freezeChrome(); if (!video.ended) { trackEvent('pause'); if (video.currentTime > 5) saveProgress(Math.floor(video.currentTime)); } });
video.addEventListener('ended', () => {
  freezeChrome();
  trackEvent('end');
  // FIX HIGH-11: PostMessage con targetOrigin específico
  // Solo enviar mensaje si estamos en iframe Y el parent es del mismo origen O dominio permitido
  try {
    if (window !== window.parent) window.parent.postMessage({ type: 'sv:ended', videoId }, '*');
  } catch {}
});
video.addEventListener('seeked', () => { trackEvent('seek'); if (video.currentTime > 5) saveProgress(Math.floor(video.currentTime)); });
window.addEventListener('pagehide', () => { if (video.currentTime > 5) saveProgress(Math.floor(video.currentTime)); });
video.addEventListener('waiting', () => { if (!isAirPlayActive) showLoading(true); });
video.addEventListener('canplay',  () => showLoading(false));
video.addEventListener('loadedmetadata', () => {
  _updateDurationDisplay();
  checkPip();
});
video.addEventListener('durationchange', _updateDurationDisplay);

function _updateDurationDisplay() {
  const d = video.duration;
  if (!d || isNaN(d) || d <= 0) return;
  // Update time-remain so it shows total duration before playback starts
  trEl.textContent = fmtRemain(video.currentTime, d);
  // Update meta-duration badge below the player
  const dur = document.getElementById('meta-duration');
  if (dur) {
    const span = dur.querySelector('span:last-child');
    if (span) span.textContent = fmtTime(d);
    dur.style.display = 'flex';
  }
}
video.addEventListener('ratechange', () => { currentSpeed = video.playbackRate; updateSettingsBadge(); });
video.addEventListener('progress',   () => updateBuffer());
video.addEventListener('timeupdate', () => {
  const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  tcEl.textContent = fmtTime(video.currentTime);
  trEl.textContent = fmtRemain(video.currentTime, video.duration);
  updateBuffer();
  const pos = Math.floor(video.currentTime);
  if (pos > 5 && pos % 5 === 0) saveProgress(pos);
  if (pos - lastProgressPos >= 10) { lastProgressPos = pos; trackEvent('progress'); }
  // Skip intro — show button between intro_start and intro_end
  if (_introEnd > 0) {
    const introFrom = _introStart > 0 ? _introStart : 0;
    const show = pos >= introFrom && pos < _introEnd && !video.paused;
    const btn = document.getElementById('skip-intro-btn');
    if (btn) btn.style.display = show ? 'flex' : 'none';
  }
  // Credits badge — show between outro_start and outro_end (or video end)
  if (_outroStart > 0) {
    const outroTo = (_outroEnd > 0 && video.duration) ? Math.min(_outroEnd, Math.floor(video.duration)) : Math.floor(video.duration || 99999);
    const show = pos >= _outroStart && pos < outroTo;
    const badge = document.getElementById('credits-badge');
    if (badge) badge.style.display = show ? 'flex' : 'none';
    if (show) prefetchTmdbCredits(); // empieza a cargar datos en background al mostrar el badge
  }
});

function updateBuffer() {
  if (!video.duration || !video.buffered.length) return;
  document.getElementById('progress-buffer').style.width = (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + '%';
}

// ─── TMDB Credits panel ──────────────────────────────────────
let _tmdbLoaded = false;
let _tmdbData   = null; // cache — se llena en background antes de que el usuario abra el panel

async function prefetchTmdbCredits() {
  if (_tmdbData || _tmdbLoaded || !videoId) return;
  try {
    const r = await fetch(`${BASE}/api/videos/${videoId}/credits`);
    if (r.ok) _tmdbData = await r.json();
  } catch {}
}

function openCreditsPanel() {
  const panel   = document.getElementById('tmdb-credits-panel');
  const overlay = document.getElementById('tmdb-overlay');
  if (!panel) return;
  panel.classList.add('open');
  if (overlay) overlay.classList.add('active');
  if (!_tmdbLoaded) loadTmdbCredits();
}

function closeCreditsPanel() {
  const panel   = document.getElementById('tmdb-credits-panel');
  const overlay = document.getElementById('tmdb-overlay');
  if (panel)   panel.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
}

async function loadTmdbCredits() {
  if (!videoId) return;
  _tmdbLoaded = true;
  const body = document.getElementById('tmdb-panel-body');
  if (!body) return;

  // Si ya tenemos datos en cache, renderizar sin skeleton ni fetch
  if (_tmdbData) { renderTmdbCredits(_tmdbData, body); return; }

  // Skeleton mientras se espera el fetch
  body.innerHTML = `<div class="tmdb-cast-list">${Array.from({length:7}).map(()=>`
    <div class="tmdb-cast-row" style="pointer-events:none;">
      <div class="tmdb-skeleton" style="width:50px;height:50px;border-radius:50%;flex-shrink:0;"></div>
      <div style="flex:1;">
        <div class="tmdb-skeleton" style="height:12px;width:70%;margin-bottom:6px;border-radius:3px;"></div>
        <div class="tmdb-skeleton" style="height:10px;width:50%;border-radius:3px;"></div>
      </div>
    </div>`).join('')}</div>`;

  try {
    const r = await fetch(`${BASE}/api/videos/${videoId}/credits`);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const msg = d.error === 'no_tmdb_key' ? 'El workspace no tiene configurado un token de TMDB.'
                : d.error === 'no_tmdb_id'  ? 'Este video no tiene ID de TMDB asignado.'
                : 'No se encontró información en TMDB para este video.';
      body.innerHTML = `<div style="color:rgba(255,255,255,0.38);font-size:13px;text-align:center;padding:48px 20px;line-height:1.6;">${msg}</div>`;
      return;
    }

    _tmdbData = await r.json();
    renderTmdbCredits(_tmdbData, body);
  } catch {
    body.innerHTML = '<div style="color:rgba(255,255,255,0.38);font-size:13px;text-align:center;padding:48px 20px;">Error al cargar la información.</div>';
  }
}

function renderTmdbCredits(data, body) {
  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const title  = data.title || data.name || '';
  const year   = (data.release_date || data.first_air_date || '').slice(0, 4);
  const rating = data.vote_average ? (Math.round(data.vote_average * 10) / 10).toFixed(1) : '';
  const genres = (data.genres || []).slice(0, 3);
  const cast   = (data.credits?.cast || []).slice(0, 15);
  const crew   = data.credits?.crew || [];

  const director   = crew.find(c => c.job === 'Director');
  const screenplay = crew.find(c => c.job === 'Screenplay' || c.job === 'Story');
  const producer   = crew.find(c => c.job === 'Executive Producer' || c.job === 'Producer');

  // ── Header: backdrop o fallback ──────────────────────────
  const backdropEl = document.getElementById('tmdb-panel-backdrop');
  const fallbackEl = document.getElementById('tmdb-panel-header-fallback');

  if (data.backdrop_path && backdropEl) {
    document.getElementById('tmdb-backdrop-img').src = `https://image.tmdb.org/t/p/w780${data.backdrop_path}`;
    const posterEl = document.getElementById('tmdb-backdrop-poster');
    if (data.poster_path) posterEl.src = `https://image.tmdb.org/t/p/w185${data.poster_path}`;
    else posterEl.style.display = 'none';
    document.getElementById('tmdb-panel-title').textContent = title;
    const metaEl = document.getElementById('tmdb-panel-meta');
    metaEl.innerHTML = [
      year   ? `<span class="tmdb-meta-year">${esc(year)}</span>` : '',
      rating ? `<span class="tmdb-meta-dot">·</span><span class="tmdb-rating"><span class="tmdb-rating-star"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" style="vertical-align:middle;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span><span class="tmdb-rating-val">${esc(rating)}</span></span>` : '',
    ].filter(Boolean).join('');
    backdropEl.style.display = '';
    if (fallbackEl) fallbackEl.style.display = 'none';
  } else {
    if (backdropEl) backdropEl.style.display = 'none';
    if (fallbackEl) {
      fallbackEl.style.display = '';
      const fb = document.getElementById('tmdb-panel-title-fb');
      const fm = document.getElementById('tmdb-panel-meta-fb');
      if (fb) fb.textContent = title;
      if (fm) fm.textContent = [year, rating ? rating : ''].filter(Boolean).join(' · ');
    }
  }

  // ── Géneros ──────────────────────────────────────────────
  const genreHtml = genres.length
    ? `<div class="tmdb-genre-list">${genres.map(g=>`<span class="tmdb-genre-chip">${esc(g.name)}</span>`).join('')}</div>`
    : '';

  // ── Sinopsis ─────────────────────────────────────────────
  const overviewHtml = data.overview ? `<p class="tmdb-overview">${esc(data.overview)}</p>` : '';

  // ── Equipo ───────────────────────────────────────────────
  const crewItems = [
    director   && { role: 'Dirección',  name: director.name },
    screenplay && { role: 'Guión',      name: screenplay.name },
    producer   && { role: 'Producción', name: producer.name },
  ].filter(Boolean);
  const crewHtml = crewItems.length
    ? `<div class="tmdb-section-label">Equipo</div><div class="tmdb-crew-row">${crewItems.map(c=>`
        <div class="tmdb-crew-chip">
          <div class="tmdb-crew-role">${esc(c.role)}</div>
          <div class="tmdb-crew-name">${esc(c.name)}</div>
        </div>`).join('')}</div>`
    : '';

  // ── Cast (lista vertical estilo Prime Video) ──────────────
  const avatarSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7"/></svg>';
  const castRows = cast.map(p => `
    <div class="tmdb-cast-row">
      <div class="tmdb-cast-avatar-wrap">
        <div class="tmdb-cast-avatar-bg">${avatarSvg}</div>
        ${p.profile_path ? `<img src="https://image.tmdb.org/t/p/w185${p.profile_path}" class="tmdb-cast-avatar" alt="${esc(p.name)}" loading="lazy" onerror="this.remove()">` : ''}
      </div>
      <div class="tmdb-cast-details">
        <div class="tmdb-cast-actor">${esc(p.name)}</div>
        ${p.character ? `<div class="tmdb-cast-character">${esc(p.character)}</div>` : ''}
      </div>
    </div>`).join('');

  const castHtml = cast.length
    ? `<div class="tmdb-section-label">Reparto</div><div class="tmdb-cast-list">${castRows}</div>`
    : `<div style="color:rgba(255,255,255,0.3);font-size:12px;text-align:center;padding:20px 0;">Sin información de reparto.</div>`;

  body.innerHTML = genreHtml + overviewHtml + crewHtml + castHtml;
}

// ─── Skip intro state ────────────────────────────────────────
let _introStart = 0, _introEnd = 0, _outroStart = 0, _outroEnd = 0;
function skipIntro() {
  if (!_introEnd) return;
  video.currentTime = _introEnd;
  document.getElementById('skip-intro-btn').style.display = 'none';
}

// ─── Watch progress ──────────────────────────────────────────
function saveProgress(pos) {
  if (!videoId) return;
  localStorage.setItem(`sv_pos_${videoId}`, pos);
  if (!_svToken()) return;
  clearTimeout(_progressTimer);
  _progressTimer = setTimeout(() => {
    fetch(`${BASE}/api/videos/${videoId}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ..._authHdr() },
      body: JSON.stringify({ position: pos }),
    }).catch(() => {});
  }, 10000);
}
async function getSavedProgress() {
  if (!videoId) return 0;
  if (_svToken()) {
    try {
      const r = await fetch(`${BASE}/api/videos/${videoId}/progress`, { headers: _authHdr() });
      if (r.ok) { const d = await r.json(); if (d.position > 0) { localStorage.setItem(`sv_pos_${videoId}`, d.position); return d.position; } }
    } catch {}
  }
  return parseInt(localStorage.getItem(`sv_pos_${videoId}`)) || 0;
}
async function checkResume() {
  if (window._svAdPlaying) return false;
  const pos = await getSavedProgress();
  if (pos > 10 && pos < (video.duration || Infinity) - 3 && Math.abs(pos - (video.currentTime || 0)) > 5) {
    video.pause();
    document.getElementById('resume-time-str').textContent = fmtTime(pos);
    document.getElementById('resume-overlay').classList.add('visible');
    return true;
  }
  return false;
}
async function resumePlayback() {
  video.currentTime = await getSavedProgress();
  document.getElementById('resume-overlay').classList.remove('visible');
  video.play().catch(() => {});
}
function startOver() {
  localStorage.removeItem(`sv_pos_${videoId}`);
  video.currentTime = 0;
  document.getElementById('resume-overlay').classList.remove('visible');
  video.play().catch(() => {});
  if (_svToken()) fetch(`${BASE}/api/videos/${videoId}/progress`, { method:'DELETE', headers: _authHdr() }).catch(() => {});
}

// Flush on tab close — token in query string because sendBeacon can't set headers
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && videoId && _svToken() && video.currentTime > 5) {
    clearTimeout(_progressTimer);
    const token = _svToken();
    navigator.sendBeacon(
      `${BASE}/api/videos/${videoId}/progress${token ? '?token=' + encodeURIComponent(token) : ''}`,
      new Blob([JSON.stringify({ position: video.currentTime })], { type: 'application/json' })
    );
  }
});

// ─── Keyboard shortcuts ──────────────────────────────────────
function toggleShortcuts() { document.getElementById('shortcuts-hud').classList.toggle('visible'); }
function closeShortcuts()  { document.getElementById('shortcuts-hud').classList.remove('visible'); }
let keyThumbTimer = null;
function showKeyThumb(t) {
  if (!spriteMeta || !spriteImg) return;
  const clamped = Math.max(0, Math.min(t, video.duration));
  positionPreview(clamped / video.duration, clamped);
  if (!drawSprite(clamped)) seekThumb(clamped);
  clearTimeout(keyThumbTimer);
  keyThumbTimer = setTimeout(hidePreview, 1500);
}

// ─── Fast Seek System (Prime Video TV style) ─────────────────
// Mantener presionado → escala de velocidad: ×1 → ×2 → ×3 → ×4 → ×6
// Avance:   usa video.playbackRate (el video se ve avanzando rápido)
// Retroceso: usa setInterval (los navegadores no soportan playbackRate negativo)
//
// Escalera de velocidades y tiempos de permanencia:
//   ×1  →  1.2 s  →  ×2
//   ×2  →  1.5 s  →  ×3
//   ×3  →  1.5 s  →  ×4
//   ×4  →  2.0 s  →  ×6   (máximo)
//
// Para retroceso, cada tick (100 ms) retrocede (rate × 0.3) segundos,
// lo que da una velocidad visual proporcional a la del avance.

const _fsRates   = [1, 2, 3, 4, 6];           // velocidades
const _fsHoldMs  = [1200, 1500, 1500, 2000];  // ms en cada nivel antes de subir
let _fsDir       = 0;      // 1=fwd, -1=back, 0=off
let _fsLevel     = 0;      // índice en _fsRates
let _fsActive    = false;
let _fsPrevRate  = 1;
let _fsPrevMuted = false;
let _fsWasPaused = false;
let _fsEscTimer  = null;
let _fsRwdInterval = null; // solo para retroceso

function _fsApplyRate() {
  const rate = _fsRates[_fsLevel];
  if (_fsDir > 0) {
    video.playbackRate = rate;
  }
  // Para retroceso el interval usa _fsLevel directamente → ya se actualiza
}

function _fsUpdateHud(pill, speedEl, bump) {
  const rate = _fsRates[_fsLevel];
  speedEl.textContent = '×' + rate;
  if (bump) {
    pill.classList.remove('bump');
    void pill.offsetWidth; // reflow para reiniciar animación
    pill.classList.add('bump');
  }
}

function fastSeekStart(dir) {
  if (_fsActive && _fsDir === dir) return;
  fastSeekStop();

  _fsDir       = dir;
  _fsLevel     = 0;
  _fsActive    = true;
  _fsPrevRate  = video.playbackRate;
  _fsPrevMuted = video.muted;
  _fsWasPaused = video.paused;

  const hud     = document.getElementById('fast-seek-hud');
  const pill    = document.getElementById('fast-seek-pill');
  const icon    = document.getElementById('fast-seek-icon');
  const speedEl = document.getElementById('fast-seek-speed');

  hud.setAttribute('data-dir', dir > 0 ? 'fwd' : 'back');
  icon.innerHTML = dir > 0
    ? '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>'
    : '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>';

  _fsUpdateHud(pill, speedEl, false);
  hud.classList.add('active');

  if (dir > 0) {
    // Avance: aplica playbackRate=1 primero (se ve normal pero ya sabe que "está en modo fast")
    if (_fsWasPaused) video.play().catch(() => {});
    _fsApplyRate();
  } else {
    // Retroceso: bucle que retrocede proporcionalmente a la velocidad actual
    video.muted = true;
    _fsRwdInterval = setInterval(() => {
      if (!_fsActive) return;
      const rate = _fsRates[_fsLevel];
      // Retrocede más cuanto mayor sea el nivel: ~3× la velocidad real
      const jump = rate * 0.3;
      video.currentTime = Math.max(0, video.currentTime - jump);
      if (video.currentTime <= 0) fastSeekStop();
    }, 100);
  }

  // Escalación automática: sube de nivel tras el tiempo definido para cada nivel
  function scheduleEscalation() {
    if (_fsLevel >= _fsRates.length - 1) return; // ya en máximo
    _fsEscTimer = setTimeout(() => {
      if (!_fsActive) return;
      _fsLevel++;
      _fsApplyRate();
      _fsUpdateHud(pill, speedEl, true);
      scheduleEscalation();
    }, _fsHoldMs[_fsLevel - 1] ?? 2000);
  }
  // Espera el primer nivel antes de empezar a escalar
  _fsEscTimer = setTimeout(() => {
    if (!_fsActive) return;
    _fsLevel = 1;
    _fsApplyRate();
    _fsUpdateHud(pill, speedEl, true);
    scheduleEscalation();
  }, _fsHoldMs[0]);

  wakeChrome();
}

function fastSeekStop() {
  if (!_fsActive) return;
  _fsActive = false;
  const dir = _fsDir;
  _fsDir    = 0;

  clearTimeout(_fsEscTimer);
  _fsEscTimer = null;

  if (_fsRwdInterval) {
    clearInterval(_fsRwdInterval);
    _fsRwdInterval = null;
  }

  const hud = document.getElementById('fast-seek-hud');
  if (hud) hud.classList.remove('active');

  // Restaurar estado anterior
  video.playbackRate = _fsPrevRate;
  video.muted = _fsPrevMuted;
  if (_fsWasPaused && dir > 0) video.pause();

  wakeChrome();
}

// ─── Keyboard handler ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === '?')      { toggleShortcuts(); return; }
  if (e.code === 'Escape') {
    if (_iosPseudoFs) { _exitIOSPseudoFs(); return; }
    document.getElementById('settings-menu').classList.remove('open');
    closeShortcuts(); closeCreditsPanel(); return;
  }

  // Arrow keys: first press = skip 10s, repeat (hold) = fast seek
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    const dir = e.code === 'ArrowRight' ? 1 : -1;
    if (e.repeat) {
      // OS key repeat firing → user is holding the key
      if (!_fsActive) fastSeekStart(dir);
    } else {
      // First press — immediate 10s skip
      skip(dir * 10);
      showKeyThumb(video.currentTime);
    }
    return;
  }

  switch (e.code) {
    case 'Space':           e.preventDefault(); togglePlay(); break;
    case 'ArrowUp':         e.preventDefault(); setVolume(Math.min(1, video.volume + 0.1)); break;
    case 'ArrowDown':       e.preventDefault(); setVolume(Math.max(0, video.volume - 0.1)); break;
    case 'KeyJ':            e.preventDefault(); skip(-10); showKeyThumb(video.currentTime - 10); break;
    case 'KeyL':            e.preventDefault(); skip(10);  showKeyThumb(video.currentTime + 10); break;
    case 'KeyC':            e.preventDefault(); toggleCcQuick(); break;
    case 'Comma':           e.preventDefault(); { const s=[0.5,0.75,1,1.25,1.5,2]; const i=s.indexOf(currentSpeed); if(i>0) setSpeed(s[i-1]); } break;
    case 'Period':          e.preventDefault(); { const s=[0.5,0.75,1,1.25,1.5,2]; const i=s.indexOf(currentSpeed); if(i<s.length-1) setSpeed(s[i+1]); } break;
    case 'KeyF':            toggleFullscreen(); break;
    case 'KeyM':            toggleMute(); break;
    case 'KeyP':            togglePip(); break;
    case 'Home':            e.preventDefault(); video.currentTime = 0; break;
    case 'End':             e.preventDefault(); video.currentTime = video.duration; break;
    // ── Media keys del sistema (teclas Fn de laptop, teclados multimedia) ──
    case 'AudioVolumeUp':   e.preventDefault(); setVolume(Math.min(1, video.volume + 0.1)); break;
    case 'AudioVolumeDown': e.preventDefault(); setVolume(Math.max(0, video.volume - 0.1)); break;
    case 'AudioVolumeMute': e.preventDefault(); toggleMute(); break;
    case 'MediaPlayPause':  e.preventDefault(); togglePlay(); break;
    case 'MediaTrackNext':  e.preventDefault(); skip(30); break;
    case 'MediaTrackPrevious': e.preventDefault(); skip(-30); break;
  }
  if (!video.paused && !e.repeat) wakeChrome();
});

// Stop fast seek when arrow key is released
document.addEventListener('keyup', e => {
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    if (_fsActive) fastSeekStop();
  }
});

document.getElementById('shortcuts-hud').addEventListener('click', e => { if (e.target === e.currentTarget) closeShortcuts(); });

// ─── Share / Download ────────────────────────────────────────
function copyM3u8()  { navigator.clipboard.writeText(`${BASE}/videos/${videoId}/master.m3u8`).then(() => toast('Enlace .m3u8 copiado')); }
function copyWatch() { navigator.clipboard.writeText(`${BASE}/watch/${videoId}`).then(() => toast('Enlace copiado')); }


// ─── Error / password ────────────────────────────────────────
function showError(msg) {
  document.getElementById('error-state').classList.add('visible');
  document.getElementById('error-msg').textContent = msg || 'No se pudo cargar el video';
  document.getElementById('processing-state').classList.remove('visible');
  document.getElementById('loading-overlay').classList.add('hidden');
}
function retryInit() { document.getElementById('error-state').classList.remove('visible'); init(); }
function showPasswordModal() {
  document.getElementById('password-overlay').style.display = 'flex';
  document.getElementById('processing-state').classList.remove('visible');
  document.getElementById('error-state').classList.remove('visible');
  setTimeout(() => document.getElementById('pw-input')?.focus(), 50);
}

async function submitPassword() {
  const pw = document.getElementById('pw-input').value;
  const errEl = document.getElementById('pw-error');
  if (!pw) { errEl.textContent = 'Ingresa una contraseña'; return; }
  errEl.textContent = '';
  const btn = document.getElementById('pw-submit-btn');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/videos/${videoId}/unlock`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.error || 'Contraseña incorrecta'; return; }
    sessionStorage.setItem(`sv_unlock_${videoId}`, d.token);
    document.getElementById('password-overlay').style.display = 'none';
    init();
  } catch { errEl.textContent = 'Error de conexión'; }
  finally { btn.disabled = false; }
}

// ─── Chapters ────────────────────────────────────────────────
let _chapters = [];
function renderChapterMarkers() {
  document.querySelectorAll('.sv-chapter-marker').forEach(m => m.remove());
  const dur = video.duration || 0;
  if (!dur || !_chapters.length) return;
  _chapters.forEach(ch => {
    if (ch.start_time <= 0) return;
    const m = document.createElement('div');
    m.className = 'sv-chapter-marker';
    m.title = ch.title;
    m.style.left = (ch.start_time / dur * 100) + '%';
    progressTrack.appendChild(m);
  });
}
async function loadChapters() {
  try {
    const r = await fetch(`${BASE}/api/videos/${videoId}/chapters`);
    if (!r.ok) return;
    _chapters = await r.json();
    if (video.duration) renderChapterMarkers();
    else { video.addEventListener('loadedmetadata', renderChapterMarkers, { once: true }); video.addEventListener('durationchange', renderChapterMarkers); }
  } catch {}
}
// Patch positionPreview to show chapter name
const _origPositionPreview = positionPreview;
positionPreview = function(pct, t) {
  _origPositionPreview(pct, t);
  if (thumbChEl && _chapters.length) {
    let active = null;
    for (const ch of _chapters) { if (ch.start_time <= t) active = ch; else break; }
    thumbChEl.textContent = active?.title || '';
    thumbChEl.style.display = active ? 'block' : 'none';
  }
};

// ─── Media Session API ───────────────────────────────────────
// Integra el player con el SO:
// - Lock screen de macOS / iOS muestra título y controles
// - Auriculares Bluetooth responden a play/pause/skip
// - Touch Bar de MacBook muestra controles de media
// - Android/iOS muestran notificación con controles mientras reproduce
function _initMediaSession(data) {
  if (!('mediaSession' in navigator)) return;

  // Metadata del video (título + artwork si existe thumbnail)
  const artwork = [];
  if (data.thumbnailUrl) {
    artwork.push({ src: data.thumbnailUrl, sizes: '512x512', type: 'image/jpeg' });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  data.title  || window._svSiteName || '',
    artist: data.channelName || '',
    artwork,
  });

  // Handlers de acción del OS
  navigator.mediaSession.setActionHandler('play',  () => { video.play().catch(() => {}); });
  navigator.mediaSession.setActionHandler('pause', () => { video.pause(); });
  navigator.mediaSession.setActionHandler('seekbackward',  (d) => { skip(-(d?.seekOffset ?? 10)); });
  navigator.mediaSession.setActionHandler('seekforward',   (d) => { skip(+(d?.seekOffset ?? 10)); });
  navigator.mediaSession.setActionHandler('seekto', (d) => {
    if (d?.seekTime !== undefined) video.currentTime = d.seekTime;
  });
  // Stop: pausa y oculta notificación
  navigator.mediaSession.setActionHandler('stop', () => {
    video.pause();
    video.currentTime = 0;
  });

  // Sincroniza el estado de posición para que la barra del OS sea precisa
  function _updatePositionState() {
    if (!video.duration || isNaN(video.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration:     video.duration,
        playbackRate: video.playbackRate,
        position:     Math.min(video.currentTime, video.duration),
      });
    } catch {}
  }
  video.addEventListener('timeupdate',    _updatePositionState);
  video.addEventListener('durationchange', _updatePositionState);
  video.addEventListener('ratechange',    _updatePositionState);
}

// ─── Init ────────────────────────────────────────────────────
async function init() {
  if (!videoId) return showError('Video no encontrado');
  try {
    const unlock = sessionStorage.getItem(`sv_unlock_${videoId}`);
    const qs = new URLSearchParams();
    if (unlock) qs.set('unlock', unlock);
    const qStr = qs.toString() ? '?' + qs.toString() : '';
    const r = await fetch(`/api/videos/${videoId}${qStr}`, { headers: _authHdr() });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (r.status === 403 && err.error === 'password_required') return showPasswordModal();
      if (r.status === 403 && err.error === 'private') return showError('Este video es privado');
      if (r.status === 410 || err.error === 'expired') return showError('Este video ha expirado y ya no está disponible.');
      return showError('Video no encontrado');
    }
    videoData   = await r.json();
    
    // Verificar si el video está suspendido por DMCA
    if (videoData.dmca_suspended) {
      return showError(
        videoData.dmca_reason 
          ? `Este contenido ha sido suspendido por una reclamación DMCA.\n\nMotivo: ${videoData.dmca_reason}` 
          : 'Este contenido ha sido suspendido por una reclamación de derechos de autor (DMCA) y no está disponible para reproducción.'
      );
    }
    
    _introStart = Number(videoData.intro_start) || 0;
    _introEnd   = Number(videoData.intro_end)   || 0;
    _outroStart = Number(videoData.outro_start) || 0;
    _outroEnd   = Number(videoData.outro_end)   || 0;
    _tmdbLoaded = false;
    _tmdbData   = null; // reset cache para este video

    document.title = videoData.title + ' — ' + (videoData.platformName || window._svSiteName || 'StreamVault');
    const topTitle = document.getElementById('top-title-el');
    if (topTitle) topTitle.textContent = videoData.title;
    document.getElementById('video-title-el').textContent = videoData.title;
    const chRow = document.getElementById('video-channel-row');
    if (chRow) { if (videoData.channelName) { chRow.textContent = videoData.channelName; chRow.style.display = 'block'; } else { chRow.style.display = 'none'; } }
    document.getElementById('meta-views').innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      ${Number(videoData.views || 0).toLocaleString('es')} vistas`;
    document.getElementById('meta-qualities').innerHTML = (videoData.qualities || [])
      .map(q => { const s = String(q||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); return `<span style="background:rgba(124,108,250,0.1);color:var(--pv-accent,#7c6cfa);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;font-family:var(--pv-sans);">${s}</span>`; }).join('');
    document.getElementById('video-info').style.display = 'flex';

    // Apply workspace embed config
    const cfg = videoData.embedConfig || {};
    if (cfg.color) {
      document.documentElement.style.setProperty('--pv-accent', cfg.color);
      document.documentElement.style.setProperty('--pv-scrub',  cfg.color);
      const hex = cfg.color.replace('#','');
      const r = parseInt(hex.slice(0,2),16);
      const g = parseInt(hex.slice(2,4),16);
      const b = parseInt(hex.slice(4,6),16);
      document.documentElement.style.setProperty('--pv-accent-rgb', `${r}, ${g}, ${b}`);
      // Calcular luminancia relativa (WCAG) para elegir texto negro o blanco
      // sobre fondos con el color de acento (ej. botón "Continuar viendo")
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      document.documentElement.style.setProperty('--pv-accent-text', luminance > 0.55 ? '#111' : '#fff');
    }
    if (cfg.playerName) document.title = videoData.title + ' — ' + cfg.playerName;

    // ── Logo handling según embed tier ───────────────────────────
    // branded: muestra el logo de la plataforma (el que el admin configure)
    // unbranded/custom: muestra el logo del workspace (si lo configuró el usuario)
    const logoEl = document.getElementById('logo-overlay');
    if (cfg.platformLogoUrl && cfg.embedTier === 'branded') {
      // Logo de la plataforma — plan branded (starter)
      logoEl.onerror = () => logoEl.classList.remove('visible');
      applyLogoCorner(logoEl, cfg.platformLogoPos || 'tr');
      logoEl.src = cfg.platformLogoUrl;
      logoEl.classList.add('visible');
      logoEl.title = cfg.platformName || 'StreamVault';
    } else if (cfg.logoUrl && cfg.embedTier !== 'branded') {
      // Logo del workspace — plan unbranded/custom
      logoEl.onerror = () => logoEl.classList.remove('visible');
      applyLogoCorner(logoEl, cfg.logoPos || 'tr');
      logoEl.src = cfg.logoUrl;
      logoEl.classList.add('visible');
    }

    // ── Watermark overlay (CSS-only, no re-encoding) ──────────────
    if (cfg.watermarkEnabled && cfg.watermarkText) {
      let wText = cfg.watermarkText
        .replace('{date}', new Date().toLocaleDateString());
      const posMap = {
        'top-left':     'top:12px;left:12px;',
        'top-right':    'top:12px;right:12px;',
        'bottom-left':  'bottom:48px;left:12px;',
        'bottom-right': 'bottom:48px;right:12px;',
        'center':       'top:50%;left:50%;transform:translate(-50%,-50%);',
      };
      const posStyle = posMap[cfg.watermarkPosition] || posMap['bottom-right'];
      const opacity  = Math.max(0.05, Math.min(0.95, cfg.watermarkOpacity || 0.3));
      const wEl = document.createElement('div');
      wEl.id = 'sv-watermark';
      wEl.textContent = wText;
      wEl.style.cssText = `position:absolute;${posStyle}z-index:10;pointer-events:none;color:#fff;font-size:13px;font-weight:600;font-family:var(--pv-sans,'DM Sans',sans-serif);opacity:${opacity};text-shadow:0 1px 3px rgba(0,0,0,.75);user-select:none;white-space:nowrap;`;
      document.getElementById('player-inner')?.appendChild(wEl);
    }

    // ── Detección de AdBlockers ────────────────────────────────────
    if (cfg.adblockDetection) {
      _detectAdBlock(cfg.ads && cfg.ads.enabled);
    }

    // ── Bloqueo de DevTools ────────────────────────────────────────
    const _isPreviewFrame = new URLSearchParams(location.search).get('preview') === '1';
    if (!_isPreviewFrame) {
      if (typeof window.__svSecurityInit === 'function') {
        window.__svSecurityInit(!!cfg.devtoolsBlocker);
      }
      if (cfg.devtoolsBlocker) {
        _initDevToolsBlocker();
      }
    }

    // ── Sistema de anuncios ────────────────────────────────────────
    if (cfg.ads && cfg.ads.enabled) {
      _initAds(cfg.ads);
    }

    // Resume check after metadata
    const onMeta = async () => { await checkResume(); video.removeEventListener('loadedmetadata', onMeta); };
    video.readyState >= 1 ? onMeta() : video.addEventListener('loadedmetadata', onMeta);

    // Quitar player-loading una vez que tenemos los datos del video.
    // Esto permite que los controles aparezcan con su transición CSS normal
    // en lugar del flash que ocurría con la clase "paused" desde el inicio.
    wrap.classList.remove('player-loading');
    // Marcar como pausado ahora que el player está listo (estado correcto inicial)
    wrap.classList.add('paused');

    const isProcessing = ['queued', 'transcoding'].includes(videoData.status);
    const hasQualities = Array.isArray(videoData.qualities) && videoData.qualities.length > 0;

    if (videoData.status === 'ready' || (isProcessing && hasQualities)) {
      document.getElementById('processing-state').classList.remove('visible');

      if (!hls) {
        // First time — full initialization
        if (videoData.spriteMeta) {
          try {
            const mr = await fetch(videoData.spriteMeta);
            if (mr.ok) { spriteMeta = await mr.json(); spriteImg = new Image(); spriteImg.src = videoData.spriteUrl; }
          } catch {}
        }
        await fetchStreamSession(); // Get CF signed cookies before loading CDN content
        await fetchVideoToken();
        initHls(videoData.m3u8Url);
        loadSubtitles();
        loadChapters();
        _initMediaSession(videoData);
      }
      // Still transcoding — poll to keep the qualities badge current; never re-init HLS
      if (isProcessing) setTimeout(init, 10000);
    } else if (isProcessing) {
      document.getElementById('processing-state').classList.add('visible');
      setTimeout(init, 5000);
    } else if (videoData.status === 'error') {
      showError('El video falló durante la transcodificación');
    }
  } catch { showError('Error conectando con el servidor'); }
}

// ─── Detección de AdBlockers ─────────────────────────────────
// Técnica: intenta cargar un recurso con nombre típico de anuncio.
// Si falla (bloqueado por AdBlock) → muestra overlay de aviso.
// hasAds: si el workspace tiene anuncios configurados, el mensaje es
//         más fuerte ("necesitamos anuncios para seguir"). Si no tiene
//         anuncios configurados, solo informa de manera suave.
let _adblockChecked = false;

function _detectAdBlock(hasAds) {
  if (_adblockChecked) return;
  _adblockChecked = true;

  // Detección SOLO via fetch — no usamos elementos señuelo con clases de anuncios
  // porque los browsers modernos y filtros del sistema los bloquean por CSS
  // incluso sin extensión instalada, causando falsos positivos.
  // El fetch a un recurso conocido de Google Ads es el método más fiable.
  fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', {
    method: 'HEAD',
    mode: 'no-cors',
    cache: 'no-store',
  }).then(() => {
    // Cargó correctamente — no hay adblock activo
  }).catch(() => {
    // Falló — adblock bloqueó el recurso
    _showAdBlockOverlay(hasAds);
  });
}

function _showAdBlockOverlay(hasAds) {
  // No mostrar si ya hay un overlay de otro tipo visible
  if (document.getElementById('sv-adblock-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'sv-adblock-overlay';
  overlay.style.cssText = `
    position:absolute;inset:0;z-index:100;
    background:rgba(10,10,20,0.96);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:24px;text-align:center;
    backdrop-filter:blur(4px);
  `;

  const icon = hasAds
    ? `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.5" style="margin-bottom:14px;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`
    : `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#facc15" stroke-width="1.5" style="margin-bottom:14px;flex-shrink:0;"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

  const title = hasAds
    ? 'Bloqueador de anuncios detectado'
    : 'Bloqueador de anuncios detectado';

  const msg = hasAds
    ? 'Este contenido se financia con publicidad. Por favor, desactiva tu bloqueador de anuncios para ver el video.'
    : 'Hemos detectado un bloqueador de anuncios activo. Para una mejor experiencia, considera desactivarlo en este sitio.';

  const btnText = hasAds ? 'Ya lo desactivé — verificar' : 'Continuar de todas formas';
  const btnStyle = hasAds
    ? 'background:#7c6cfa;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;'
    : 'background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:10px 22px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;';

  overlay.innerHTML = `
    ${icon}
    <div style="font-size:18px;font-weight:700;color:#fff;margin-bottom:10px;">${title}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.6);max-width:320px;line-height:1.6;margin-bottom:20px;">${msg}</div>
    <button id="sv-adblock-dismiss" style="${btnStyle}">${btnText}</button>
    ${hasAds ? '' : ''}
  `;

  document.getElementById('player-inner')?.appendChild(overlay);

  document.getElementById('sv-adblock-dismiss')?.addEventListener('click', () => {
    if (hasAds) {
      // Re-verificar si el adblock sigue activo — misma técnica fetch, sin elementos señuelo
      // que causan falsos positivos con filtros del sistema/browser.
      const btn = document.getElementById('sv-adblock-dismiss');
      if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
      fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
      }).then(() => {
        // Desactivado correctamente
        overlay.remove();
        video.play().catch(() => {});
      }).catch(() => {
        // Sigue activo — actualizar mensaje
        const msgEl = overlay.querySelector('div[style*="color:rgba"]');
        if (msgEl) msgEl.textContent = 'El bloqueador de anuncios sigue activo. Por favor desactívalo completamente y recarga la página.';
        if (btn) { btn.disabled = false; btn.textContent = 'Recargar página'; btn.onclick = () => location.reload(); }
      });
    } else {
      overlay.remove();
      if (!video.paused) return;
      video.play().catch(() => {});
    }
  });
}

// ─── Bloqueo de DevTools ──────────────────────────────────────
let _devToolsOverlayShown = false;

function _initDevToolsBlocker() {
  function _showDevToolsOverlay() {
    if (_devToolsOverlayShown) return;
    if (document.getElementById('sv-devtools-overlay')) return;
    _devToolsOverlayShown = true;

    try { video.pause(); } catch {}

    const overlay = document.createElement('div');
    overlay.id = 'sv-devtools-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;
      background:rgba(10,10,20,0.97);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:24px;text-align:center;
      backdrop-filter:blur(8px);
    `;
    overlay.innerHTML = `
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.4" style="margin-bottom:16px;flex-shrink:0;">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
      </svg>
      <div style="font-size:19px;font-weight:700;color:#fff;margin-bottom:10px;">Acceso restringido</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.55);max-width:300px;line-height:1.65;margin-bottom:22px;">
        Las herramientas de desarrollador están deshabilitadas en este reproductor.
        Ciérralas para continuar viendo el video.
      </div>
      <button id="sv-devtools-dismiss" style="background:#7c6cfa;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">
        Continuar
      </button>
    `;
    document.body.appendChild(overlay);

    document.getElementById('sv-devtools-dismiss')?.addEventListener('click', () => {
      overlay.remove();
      _devToolsOverlayShown = false;
    });
  }

  // Keyboard shortcuts (F12, Ctrl+Shift+I/J/C, Cmd+Option+I)
  document.addEventListener('keydown', e => {
    if (
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase())) ||
      (e.metaKey && e.altKey && e.key.toUpperCase() === 'I')
    ) {
      e.preventDefault();
      _showDevToolsOverlay();
    }
  }, true);

  // Right-click on the player only (not the whole page)
  const playerWrap = document.getElementById('player-wrap') || document.getElementById('player-inner');
  if (playerWrap) {
    playerWrap.addEventListener('contextmenu', e => {
      e.preventDefault();
      _showDevToolsOverlay();
    });
  }
}

// ─── Sistema de Anuncios ─────────────────────────────────────
// Soporta: VAST (pre-roll/mid-roll/post-roll), Banner HTML, Popup overlay
// El admin habilita por plan; el workspace configura su proveedor de ads.
//
// Configuración (cfg.ads desde el servidor):
// {
//   enabled: true,
//   type: 'vast' | 'banner' | 'popup' | 'all',
//   vastUrl: 'https://...vast.xml',
//   vastPosition: 'preroll' | 'midroll' | 'postroll',
//   vastMidrollAt: 60,       // segundos para mid-roll
//   bannerHtml: '<a>...</a>',
//   bannerPosition: 'top' | 'bottom',
//   bannerDelay: 5,          // segundos antes de mostrar banner
//   bannerDuration: 0,       // 0=siempre visible, N=ocultar tras N seg
//   popupUrl: 'https://...',
//   popupDelay: 10,          // segundos antes del popup
//   popupFrequency: 1,       // 1=cada reproducción, N=cada N veces
// }

let _adsInited = false;
let _adsMidrollFired = false;
let _adsBannerEl = null;
let _adsPopupEl = null;

function _initAds(adsCfg) {
  if (_adsInited || !adsCfg?.enabled) return;
  _adsInited = true;

  const type = adsCfg.type || 'vast';

  // ── VAST (Google IMA SDK o fallback nativo) ─────────────────
  if ((type === 'vast' || type === 'all') && adsCfg.vastUrl) {
    _initVastAd(adsCfg);
  }

  // ── Banner HTML ─────────────────────────────────────────────
  if ((type === 'banner' || type === 'all') && adsCfg.bannerHtml) {
    const delay = Math.max(0, parseInt(adsCfg.bannerDelay) || 0);
    setTimeout(() => _showBanner(adsCfg), delay * 1000);
  }

  // ── Popup overlay ───────────────────────────────────────────
  if ((type === 'popup' || type === 'all') && adsCfg.popupUrl) {
    // Respetar frecuencia (cada N reproducciones)
    const freq = Math.max(1, parseInt(adsCfg.popupFrequency) || 1);
    const key = `sv_popup_count_${videoId}`;
    const count = parseInt(localStorage.getItem(key) || '0') + 1;
    localStorage.setItem(key, count);
    if (count % freq === 0) {
      const delay = Math.max(0, parseInt(adsCfg.popupDelay) || 0);
      setTimeout(() => _showPopup(adsCfg), delay * 1000);
    }
  }

  // ── Mid-roll: escuchar timeupdate ────────────────────────────
  if ((type === 'vast' || type === 'all') && adsCfg.vastUrl && adsCfg.vastPosition === 'midroll' && adsCfg.vastMidrollAt > 0) {
    video.addEventListener('timeupdate', function _midrollCheck() {
      if (_adsMidrollFired) { video.removeEventListener('timeupdate', _midrollCheck); return; }
      if (video.currentTime >= adsCfg.vastMidrollAt) {
        _adsMidrollFired = true;
        video.removeEventListener('timeupdate', _midrollCheck);
        _playVastMidroll(adsCfg);
      }
    });
  }

  // ── Post-roll: al finalizar el video ────────────────────────
  if ((type === 'vast' || type === 'all') && adsCfg.vastUrl && adsCfg.vastPosition === 'postroll') {
    video.addEventListener('ended', () => _playVastPostroll(adsCfg), { once: true });
  }
}

function _initVastAd(adsCfg) {
  // Pre-roll: pausar video, mostrar ad, luego reproducir
  if (adsCfg.vastPosition !== 'preroll' && adsCfg.vastPosition !== undefined) return;

  // Si Google IMA SDK está cargado, usarlo (mejor compatibilidad)
  if (typeof google !== 'undefined' && google.ima) {
    _playImaAd(adsCfg.vastUrl, () => { video.play().catch(() => {}); });
    return;
  }

  // Fallback: iframe simple para VAST básico
  _showVastFallback(adsCfg.vastUrl, adsCfg);
}

async function _fetchVastXml(url, depth) {
  if (depth > 3) return null;
  const r = await fetch('/api/vast-proxy?url=' + encodeURIComponent(url));
  if (!r.ok) return null;
  const xml = await r.text();
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const adTagUri = doc.querySelector('AdTagURI');
  if (adTagUri) { const u = adTagUri.textContent?.trim(); return u ? _fetchVastXml(u, depth + 1) : null; }
  const wrapper = doc.querySelector('VASTAdTagURI');
  if (wrapper)  { const u = wrapper.textContent?.trim();  return u ? _fetchVastXml(u, depth + 1) : null; }
  return doc;
}
function _parseDuration(s) {
  if (!s) return 0;
  const p = s.trim().split(':');
  if (p.length === 3) return +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2]);
  if (p.length === 2) return +p[0] * 60 + parseFloat(p[1]);
  return parseFloat(s) || 0;
}
function _fmtAdTime(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ─── SVG icon constants shared by the ad player ──────────────────────────────
const _AD_ICO_VOL_OFF = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
const _AD_ICO_VOL_ON  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
const _AD_ICO_SKIP    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>`;
const _AD_ICO_INFO    = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

function _injectAdStyles() {
  if (document.getElementById('sv-ad-css')) return;
  const s = document.createElement('style');
  s.id = 'sv-ad-css';
  s.textContent = `
    @keyframes _svAdFadeIn { from { opacity:0 } to { opacity:1 } }
    #sv-ad-container { animation: _svAdFadeIn .22s ease forwards; }
    .sv-adbtn { transition: opacity .15s, transform .12s, background .15s; outline: none; }
    .sv-adbtn:hover  { opacity: .78; }
    .sv-adbtn:active { transform: scale(.93); }
    #sv-ad-skip-btn:hover { background: rgba(255,255,255,.22) !important; }
  `;
  document.head.appendChild(s);
}

function _showVastFallback(vastUrl, adsCfg) {
  const wrap = document.getElementById('player-inner');
  if (!wrap) { video.play().catch(() => {}); return; }

  // Grab all overlays that must be suppressed during the ad
  const ctrlOverlay  = document.getElementById('controls-overlay');
  const progDock     = document.getElementById('player-progress-dock');
  const resumeOvl    = document.getElementById('resume-overlay');
  const skipIntroBtn = document.getElementById('skip-intro-btn');
  const creditsBadge = document.getElementById('credits-badge');
  const tmdbPanel    = document.getElementById('tmdb-credits-panel');
  const _onVideoPlay = () => { if (window._svAdPlaying) video.pause(); };

  const _hide = () => {
    window._svAdPlaying = true;
    if (ctrlOverlay)  ctrlOverlay.style.visibility  = 'hidden';
    if (progDock)     progDock.style.visibility     = 'hidden';
    if (resumeOvl)    resumeOvl.classList.remove('visible');
    if (skipIntroBtn) skipIntroBtn.style.display    = 'none';
    if (creditsBadge) creditsBadge.style.display    = 'none';
    if (tmdbPanel)    tmdbPanel.style.display       = 'none';
    video.addEventListener('play', _onVideoPlay);
  };
  const _show = () => {
    window._svAdPlaying = false;
    video.removeEventListener('play', _onVideoPlay);
    if (ctrlOverlay) ctrlOverlay.style.visibility = '';
    if (progDock)    progDock.style.visibility    = '';
    if (tmdbPanel)   tmdbPanel.style.display      = '';
    // skip-intro and credits-badge are driven by timeupdate — restored automatically
    // resume dialog is re-evaluated by checkResume() in the finish handler
  };
  _hide();
  video.pause();
  _injectAdStyles();

  const adC = document.createElement('div');
  adC.id = 'sv-ad-container';
  adC.style.cssText = 'position:absolute;inset:0;z-index:50;background:#000;user-select:none;';
  wrap.appendChild(adC);

  _fetchVastXml(vastUrl, 0).then(doc => {
    if (!doc) { adC.remove(); _show(); video.play().catch(() => {}); return; }

    // Best quality MP4 MediaFile
    const mf = [...doc.querySelectorAll('MediaFile')]
      .filter(m => /mp4|video/i.test(m.getAttribute('type') || ''))
      .sort((a, b) => (+b.getAttribute('width') || 0) - (+a.getAttribute('width') || 0))[0]
      || doc.querySelector('MediaFile');
    const mediaUrl = mf?.textContent?.trim();
    if (!mediaUrl) { adC.remove(); _show(); video.play().catch(() => {}); return; }

    // Parse VAST metadata
    const adDur    = _parseDuration(doc.querySelector('Duration')?.textContent);
    const clickUrl = doc.querySelector('ClickThrough')?.textContent?.trim();
    const impUrls  = [...doc.querySelectorAll('Impression')].map(e => e.textContent?.trim()).filter(Boolean);
    const linear   = doc.querySelector('Linear');
    const skipAttr = linear?.getAttribute('skipoffset');
    let skipSec = 5;
    if (skipAttr) skipSec = skipAttr.endsWith('%') ? (parseFloat(skipAttr) / 100) * (adDur || 30) : _parseDuration(skipAttr);
    skipSec = Math.max(1, Math.round(skipSec));

    const trk = ev => [...doc.querySelectorAll(`Tracking[event="${ev}"]`)].map(e => e.textContent?.trim()).filter(Boolean);
    const tS = trk('start'), tQ1 = trk('firstQuartile'), tQ2 = trk('midpoint'), tQ3 = trk('thirdQuartile'), tE = trk('complete');
    const px = urls => urls.forEach(u => { try { new Image().src = u; } catch {} });
    px(impUrls);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--pv-accent').trim() || '#7c6cfa';

    adC.innerHTML = `
      <video id="sv-adv" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;" playsinline></video>
      <div id="sv-ad-hit" style="position:absolute;inset:0;z-index:1;${clickUrl ? 'cursor:pointer;' : ''}"></div>

      <!-- Bottom gradient + controls -->
      <div style="position:absolute;bottom:0;left:0;right:0;z-index:2;background:linear-gradient(transparent 0%,rgba(0,0,0,.84) 100%);">
        <div id="sv-ad-track" style="position:relative;width:100%;height:3px;background:rgba(255,255,255,.18);overflow:visible;cursor:default;">
          <div id="sv-ad-fill" style="position:absolute;top:0;left:0;height:100%;width:0%;background:${accent};transition:width .12s linear;"></div>
        </div>
        <div style="display:flex;align-items:center;height:40px;padding:0 12px;gap:6px;">
          <div id="sv-ad-time" style="color:rgba(255,255,255,.92);font-size:12px;font-family:system-ui,sans-serif;font-weight:600;white-space:nowrap;min-width:90px;">Anuncio</div>
          <div style="flex:1;"></div>
          <div id="sv-ad-skip" style="min-width:108px;display:flex;align-items:center;justify-content:flex-end;"></div>
        </div>
      </div>`;

    const adv    = adC.querySelector('#sv-adv');
    const fill   = adC.querySelector('#sv-ad-fill');
    const timeEl = adC.querySelector('#sv-ad-time');
    const skipEl = adC.querySelector('#sv-ad-skip');
    const hitEl  = adC.querySelector('#sv-ad-hit');

    adv.src    = mediaUrl;
    adv.volume = video.volume || 1;
    adv.muted  = false;
    adv.play().catch(() => { adC.remove(); _show(); video.play().catch(() => {}); });

    if (clickUrl) hitEl.addEventListener('click', () => window.open(clickUrl, '_blank', 'noopener,noreferrer'));

    // Skip countdown → skip button
    let cd = skipSec;
    const _renderSkip = () => {
      skipEl.innerHTML = `<span style="color:rgba(255,255,255,.48);font-size:11px;font-family:system-ui,sans-serif;">Saltar en ${cd}s</span>`;
    };
    _renderSkip();
    const skipTick = setInterval(() => {
      cd--;
      if (cd <= 0) {
        clearInterval(skipTick);
        const btn = document.createElement('button');
        btn.id = 'sv-ad-skip-btn';
        btn.className = 'sv-adbtn';
        btn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.28);color:#fff;border-radius:4px;padding:5px 11px;font-size:11px;font-family:system-ui,sans-serif;cursor:pointer;font-weight:600;letter-spacing:.2px;';
        btn.innerHTML = _AD_ICO_SKIP + '&thinsp;Saltar anuncio';
        btn.addEventListener('click', finish);
        skipEl.innerHTML = '';
        skipEl.appendChild(btn);
      } else {
        _renderSkip();
      }
    }, 1000);

    // Timeupdate — progress bar + dot + time label + VAST tracking
    let fired = {};
    adv.addEventListener('timeupdate', () => {
      const ct  = adv.currentTime;
      const dur = adv.duration || adDur || 1;
      const pct = Math.min(100, (ct / dur) * 100);
      fill.style.width = pct + '%';
      const rem = Math.max(0, Math.ceil(dur - ct));
      timeEl.textContent = rem > 0 ? 'Anuncio · ' + _fmtAdTime(rem) : 'Anuncio';
      const r = ct / dur;
      if (!fired.s  && ct > 0)   { fired.s  = 1; px(tS);  }
      if (!fired.q1 && r >= .25) { fired.q1 = 1; px(tQ1); }
      if (!fired.q2 && r >= .50) { fired.q2 = 1; px(tQ2); }
      if (!fired.q3 && r >= .75) { fired.q3 = 1; px(tQ3); }
    });

    let done = false;
    async function finish() {
      if (done) return; done = true;
      clearInterval(skipTick);
      px(tE);
      adC.remove();
      _show();
      const resumed = await checkResume();
      if (!resumed) video.play().catch(() => {});
    }
    adv.addEventListener('ended', finish);
    adv.addEventListener('error', finish);
  }).catch(() => { adC.remove(); _show(); video.play().catch(() => {}); });
}

function _playVastMidroll(adsCfg) {
  video.pause();
  _showVastFallback(adsCfg.vastUrl, adsCfg);
}
function _playVastPostroll(adsCfg) {
  _showVastFallback(adsCfg.vastUrl, adsCfg);
}
function _playImaAd(vastUrl, onComplete) {
  // Placeholder para Google IMA SDK (requiere carga externa)
  // Para habilitar: cargar https://imasdk.googleapis.com/js/sdkloader/ima3.js en el HTML
  // y configurar adDisplayContainer + adsLoader aquí.
  onComplete && onComplete();
}

/** Prefix CSS selectors with a scope class (handles @media/@supports recursively). */
function _prefixCssRules(css, prefix) {
  let out = '', i = 0;
  while (i < css.length) {
    const ob = css.indexOf('{', i);
    if (ob === -1) { out += css.slice(i); break; }
    const seg = css.slice(i, ob).trimStart();
    if (/^@(keyframes|font-face|import|charset|namespace)/i.test(seg)) {
      out += css.slice(i, ob + 1);
      i = ob + 1;
      let d = 1, j = i;
      while (j < css.length && d) { if(css[j]==='{')d++;else if(css[j]==='}')d--; j++; }
      out += css.slice(i, j); i = j;
    } else if (/^@/i.test(seg)) {
      out += seg + '{';
      i = ob + 1;
      let d = 1, j = i;
      while (j < css.length && d) { if(css[j]==='{')d++;else if(css[j]==='}')d--; j++; }
      out += _prefixCssRules(css.slice(i, j - 1), prefix) + '}';
      i = j;
    } else {
      const scoped = seg.split(',').map(s => {
        s = s.trim();
        if (!s || s === ':root' || s === 'html' || s === 'body') return prefix;
        if (/^(html|body)\s+/.test(s)) return prefix + ' ' + s.replace(/^(html|body)\s+/, '');
        return prefix + ' ' + s;
      }).join(', ');
      out += scoped + '{';
      i = ob + 1;
      let d = 1, j = i;
      while (j < css.length && d) { if(css[j]==='{')d++;else if(css[j]==='}')d--; j++; }
      out += css.slice(i, j); i = j;
    }
  }
  return out;
}

/** Parse, scope CSS and sanitize banner HTML. Returns a wrapped DOM element. */
function _buildScopedBanner(rawHtml, scopeId) {
  const cls = 'sv-ab-' + (scopeId || Math.random().toString(36).slice(2, 9));
  try {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    doc.querySelectorAll('style').forEach(s => {
      s.textContent = _prefixCssRules(s.textContent, '.' + cls);
    });
    doc.querySelectorAll('script,iframe,object,embed,form,meta,link').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(node => {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name) || (attr.name === 'href' && /^javascript:/i.test(attr.value.trim()))) {
          node.removeAttribute(attr.name);
        }
      }
    });
    const wrap = document.createElement('div');
    wrap.className = cls;
    for (const child of doc.body.childNodes) wrap.appendChild(document.importNode(child, true));
    return wrap;
  } catch (_) {
    const div = document.createElement('div');
    div.textContent = rawHtml;
    return div;
  }
}

function _showBanner(adsCfg) {
  if (_adsBannerEl) return;
  const pos    = adsCfg.bannerPosition || 'bottom';
  const banner = document.createElement('div');
  banner.id    = 'sv-ad-banner';
  // overflow:hidden + max-height evita que el contenido HTML del banner se salga del player en mobile.
  // box-sizing:border-box garantiza que padding no expanda el ancho más allá de left:0;right:0.
  banner.style.cssText = [
    'position:absolute',
    pos === 'top' ? 'top:0' : 'bottom:52px',
    'left:0',
    'right:0',
    'z-index:30',
    'overflow:hidden',
    'max-height:120px',
    'box-sizing:border-box',
    'width:100%',
  ].join(';') + ';';

  const dismiss = () => { banner.remove(); _adsBannerEl = null; };

  // Build scoped + sanitized DOM element
  const scopedEl = _buildScopedBanner(adsCfg.bannerHtml, adsCfg.creativeId || null);
  // Asegurar que el contenido escoped tampoco desborde
  scopedEl.style.cssText = (scopedEl.style.cssText || '') + ';max-width:100%;overflow:hidden;box-sizing:border-box;';

  // Detect close button: explicit class/attr OR aria-label Cerrar/Close
  const CLOSE_SEL = '.sv-close-btn, [data-sv-close], button[aria-label*="errar" i], button[aria-label*="lose" i]';
  const hasCustomClose = !!scopedEl.querySelector(CLOSE_SEL);

  if (hasCustomClose) {
    scopedEl.addEventListener('click', e => {
      if (e.target.closest(CLOSE_SEL)) dismiss();
    });
    banner.appendChild(scopedEl);
  } else {
    banner.style.cssText += 'background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:space-between;padding:8px 12px;gap:10px;';
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;font-size:13px;color:#fff;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
    content.appendChild(scopedEl);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,.6);font-size:20px;line-height:1;cursor:pointer;padding:0 4px;flex-shrink:0;';
    closeBtn.onclick = dismiss;
    banner.appendChild(content);
    banner.appendChild(closeBtn);
  }

  document.getElementById('player-inner')?.appendChild(banner);
  _adsBannerEl = banner;
  const dur = parseInt(adsCfg.bannerDuration) || 0;
  if (dur > 0) setTimeout(dismiss, dur * 1000);
}

function _showPopup(adsCfg) {
  if (_adsPopupEl) return;
  const popup = document.createElement('div');
  popup.id = 'sv-ad-popup';
  popup.style.cssText = `
    position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    z-index:60;background:#1a1a2e;border:1px solid rgba(255,255,255,.15);
    border-radius:12px;overflow:hidden;max-width:480px;width:90%;
    box-shadow:0 20px 60px rgba(0,0,0,.8);
  `;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = `
    position:absolute;top:8px;right:10px;background:rgba(0,0,0,.5);
    border:none;color:#fff;font-size:18px;cursor:pointer;
    border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;z-index:2;
  `;
  closeBtn.onclick = () => { popup.remove(); _adsPopupEl = null; };

  const iframe = document.createElement('iframe');
  iframe.src = adsCfg.popupUrl;
  iframe.style.cssText = 'width:100%;height:200px;border:none;display:block;';
  iframe.sandbox = 'allow-scripts allow-same-origin allow-popups';

  popup.appendChild(closeBtn);
  popup.appendChild(iframe);
  document.getElementById('player-inner')?.appendChild(popup);
  _adsPopupEl = popup;
  video.pause();

  // Auto-cerrar tras 30s
  setTimeout(() => { if (_adsPopupEl) { popup.remove(); _adsPopupEl = null; } }, 30000);
}

// Prevent menu click bubbling
document.getElementById('settings-menu').addEventListener('click', e => e.stopPropagation());

// ?notopbar=1 — for dashboard preview modal (hides internal title bar)
if (new URLSearchParams(location.search).get('notopbar') === '1') {
  document.getElementById('controls-top-bar').style.display = 'none';
  document.getElementById('video-info').style.display = 'none';
}

// ─── Volume slider hover (desktop only) ─────────────────────
// Chrome ignora la transición CSS de width en <input type="range">.
// Lo controlamos con JS: mouseenter/mouseleave sobre .volume-wrap
// añaden/quitan la clase vol-open que hace display:block + opacity:1.
// En touch .volume-wrap está oculto completamente por CSS.
(function _initVolHover() {
  const wrap = document.querySelector('.volume-wrap');
  const slider = document.getElementById('vol-slider');
  if (!wrap || !slider) return;
  // Solo en dispositivos con mouse real
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  // Estado inicial: slider oculto
  slider.style.display = 'none';
  slider.style.opacity = '0';
  slider.style.marginLeft = '0';
  slider.style.transition = 'opacity 0.18s ease, margin 0.18s ease';

  wrap.addEventListener('mouseenter', () => {
    slider.style.display = 'block';
    // Forzar reflow para que la transición de opacity funcione
    void slider.offsetWidth;
    slider.style.opacity = '1';
    slider.style.marginLeft = '6px';
  });
  wrap.addEventListener('mouseleave', () => {
    slider.style.opacity = '0';
    slider.style.marginLeft = '0';
    // Ocultar después de que termine la transición
    setTimeout(() => {
      if (parseFloat(slider.style.opacity) === 0) slider.style.display = 'none';
    }, 200);
  });
})();

// ─── Boot ────────────────────────────────────────────────────
loadPreferences();
loadSubPrefs();
applySubStyle();
updateFsIcon();
checkAirPlay();
// Intentar inicializar Chromecast — si el SDK ya cargó (HTTPS) lo activa,
// si no (HTTP/localhost) muestra el botón con aviso informativo.
// Se lanza con delay para dar tiempo al script de cast_sender.js a cargarse.
setTimeout(_tryCastInit, 1500);
init();
