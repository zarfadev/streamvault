// ─── URL params ────────────────────────────────────────────────
const params    = new URLSearchParams(location.search);
const videoId   = location.pathname.split('/embed/')[1]?.split('/')[0];
const BASE      = location.origin;
const autoplay  = params.has('autoplay');
const hideCtrl  = params.get('controls') === '0';
const startAt   = parseFloat(params.get('start') || '0') || 0;
const logoUrl   = params.get('logo');
const logoPosParam = params.get('logo_pos') || 'tr';
const accentHex = params.get('color');

// Apply custom accent color
if (accentHex) {
  const hex = accentHex.startsWith('#') ? accentHex : '#' + accentHex;
  const hx = hex.replace('#','');
  const r = parseInt(hx.slice(0,2),16), g = parseInt(hx.slice(2,4),16), b = parseInt(hx.slice(4,6),16);
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent2', hex);
  document.documentElement.style.setProperty('--ott-accent', hex);
  document.documentElement.style.setProperty('--ott-accent2', hex);
  document.documentElement.style.setProperty('--ott-scrub-fill', hex);
  document.documentElement.style.setProperty('--pv-accent', hex);
  document.documentElement.style.setProperty('--pv-scrub', hex);
  document.documentElement.style.setProperty('--pv-accent-rgb', `${r}, ${g}, ${b}`);
}

// ─── Logo helpers ─────────────────────────────────────────────
function applyLogoCorner(el, pos) {
  el.classList.remove('pos-tl', 'pos-tr', 'pos-bl', 'pos-br');
  if (['tl','tr','bl','br'].includes(pos)) el.classList.add('pos-' + pos);
}

// Apply logo from URL param
if (logoUrl) {
  const logoEl = document.getElementById('logo-overlay');
  logoEl.onerror = () => logoEl.classList.remove('visible');
  applyLogoCorner(logoEl, logoPosParam);
  logoEl.src = logoUrl;
  logoEl.classList.add('visible');
}

// Hide controls permanently
if (hideCtrl) {
  document.getElementById('player-wrap').classList.add('controls-hidden');
}

// ─── Safe postMessage helper ──────────────────────────────────
// Sends events only to the embedding page's origin.
// Uses document.referrer as the target origin when available,
// falling back to '*' only when the referrer is unknown (e.g. same-origin embeds).
// This prevents leaking playback state (position, videoId) to hostile pages.
function _pmSend(msg) {
  if (window === window.parent) return; // not in iframe
  try {
    let targetOrigin = '*';
    if (document.referrer) {
      try { targetOrigin = new URL(document.referrer).origin; } catch { targetOrigin = '*'; }
    }
    window.parent.postMessage(msg, targetOrigin);
  } catch {}
}

// ─── State ─────────────────────────────────────────────────────
let hls           = null;
let levels        = [];
let currentLevel  = -1;
let chapters      = [];
let hideUiTimer   = null;
let noTrack       = params.has('notrack');  // if ?notrack=1, skip view counting AND event tracking
let viewCounted   = noTrack;
let spriteMeta    = null;
let spriteImg     = null;
let _videoToken   = null;
let _tokenTimer   = null;
let _introEnd     = 0;
let _outroStart   = 0;

async function fetchVideoToken() {
  try {
    const unlockToken = sessionStorage.getItem(`sv_unlock_${videoId}`);
    const qs = unlockToken ? `?unlock=${unlockToken}` : '';
    const r = await fetch(`${BASE}/api/videos/${videoId}/token${qs}`);
    if (!r.ok) return;
    const data = await r.json();
    _videoToken = data.token;
    const renewIn = ((data.renewAfter || (data.ttl - 120)) * 1000);
    clearTimeout(_tokenTimer);
    _tokenTimer = setTimeout(fetchVideoToken, Math.max(30000, renewIn));
  } catch {}
}

function hlsXhrSetup(xhr, url) {
  if (_videoToken && (url.includes('/videos/') || url.includes('/api/videos/'))) {
    xhr.open('GET', url + (url.includes('?') ? '&' : '?') + 'token=' + _videoToken, true);
  }
}

const video    = document.getElementById('video');
const thumbVid = document.getElementById('thumb-video');
const wrap     = document.getElementById('player-wrap');
const timeCurrentEl = document.getElementById('time-current');
const timeRemainEl = document.getElementById('time-remain');

function getIdleHideMs() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 8000 : 2800;
  } catch {
    return 2800;
  }
}

function clearIdleUiTimer() {
  if (hideUiTimer) {
    clearTimeout(hideUiTimer);
    hideUiTimer = null;
  }
}

function scheduleIdleUiHide() {
  if (hideCtrl) return;
  clearIdleUiTimer();
  if (video.paused || video.ended) return;
  hideUiTimer = setTimeout(() => {
    hideUiTimer = null;
    wrap.classList.add('ui-idle');
    wrap.classList.remove('show-controls');
  }, getIdleHideMs());
}

function wakePlayerChrome() {
  if (hideCtrl) return;
  wrap.classList.remove('ui-idle');
  wrap.classList.add('show-controls');
  scheduleIdleUiHide();
}

function freezePlayerChromeVisible() {
  clearIdleUiTimer();
  wrap.classList.remove('ui-idle');
  wrap.classList.add('show-controls');
}

// ─── Analytics event tracking ─────────────────────────────────
const viewerId = (() => {
  const k = 'sv_viewer';
  let id = sessionStorage.getItem(k);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
  return id;
})();
let lastProgressPos = -15;
let lastEventMs = 0;

function trackEvent(type, extra = {}) {
  if (!videoId || noTrack) return;
  const now = Date.now();
  if (now - lastEventMs < 4500) return;
  lastEventMs = now;
  fetch(`${BASE}/api/videos/${videoId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      viewer_id: viewerId,
      event_type: type,
      position: Math.floor(video.currentTime || 0),
      ...extra,
    }),
  }).catch(() => {});
}

// ─── Utilities ─────────────────────────────────────────────────
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function fmtRemainLabel(current, total) {
  if (!total || isNaN(total)) return '\u22120:00';
  const r = Math.max(0, total - current);
  return '\u2212' + fmtTime(r);
}

function showLoading(v) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !v);
  document.getElementById('player-wrap').classList.toggle('is-buffering', v);
}

// ─── Playback ──────────────────────────────────────────────────
function togglePlay() {
  if (video.paused) video.play();
  else video.pause();
  freezePlayerChromeVisible();
}

function skip(secs, opts) {
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + secs));
  wakePlayerChrome();
}

function _syncVolFill(val) {
  const s = document.getElementById('vol-slider');
  if (s) s.style.setProperty('--vol-fill', (parseFloat(val) * 100).toFixed(1) + '%');
}
function setVolume(v) {
  video.volume = parseFloat(v);
  video.muted = +v === 0;
  localStorage.setItem('sv_volume', v);
  _syncVolFill(v);
  updateVolIcon();
  wakePlayerChrome();
}

function toggleMute() {
  video.muted = !video.muted;
  const s = document.getElementById('vol-slider');
  s.value = video.muted ? 0 : video.volume;
  _syncVolFill(s.value);
  updateVolIcon();
  wakePlayerChrome();
}

function updateVolIcon() {
  const muted = video.muted || video.volume === 0;
  const low   = !muted && video.volume < 0.4;
  const u = document.querySelector('#vol-icon use');
  if (u) u.setAttribute('href', muted ? '#sv-volume-mute' : (low ? '#sv-volume-low' : '#sv-volume'));
}

function isFullscreen() {
  return document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap;
}
function updateFsIcon() {
  const fsBtn = wrap.querySelector('.fullscreen-btn');
  const u = document.querySelector('#fs-icon use');
  if (!u) return;
  const active = isFullscreen();
  u.setAttribute('href', active ? '#sv-fs-exit' : '#sv-fs-enter');
  if (fsBtn) {
    fsBtn.setAttribute('aria-label', active ? 'Salir de pantalla completa' : 'Pantalla completa');
    fsBtn.dataset.tooltip = active ? 'Salir de pantalla completa' : 'Pantalla completa';
  }
}

async function toggleFullscreen() {
  try {
    if (!isFullscreen()) {
      if (wrap.requestFullscreen) await wrap.requestFullscreen();
      else if (wrap.webkitRequestFullscreen) await wrap.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }

      if (screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch(e) {}
      }
    } else {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
    }
  } catch (err) {}
  wakePlayerChrome();
}

document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);
updateFsIcon();

// ─── Chromecast & Smart TV ───────────────────────────────────
window.__onGCastApiAvailable = function(isAvailable) {
  if (isAvailable) initCast();
};

// Fallback: on HTTPS the SDK may not fire __onGCastApiAvailable in all environments.
function _tryCastInit() {
  if (typeof cast !== 'undefined' && cast.framework) { initCast(); return; }
  const btn = document.getElementById('cast-btn');
  if (btn) btn.style.display = 'none';
}

let _embedCastSession = null;

function initCast() {
  if (typeof cast === 'undefined' || !cast.framework) return;
  const ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy:        chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  ctx.addEventListener(
    cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
    _onEmbedCastSessionState
  );

  const castBtn = document.getElementById('cast-btn');
  if (castBtn) {
    castBtn.style.display = 'inline-flex';
    castBtn.onclick = _embedCastConnect;
  }
}

function _onEmbedCastSessionState(e) {
  const SS  = cast.framework.SessionState;
  const btn = document.getElementById('cast-btn');

  if (e.sessionState === SS.SESSION_STARTED || e.sessionState === SS.SESSION_RESUMED) {
    _embedCastSession = cast.framework.CastContext.getInstance().getCurrentSession();
    btn?.classList.add('casting');
    if (!video.paused) video.pause();

  } else if (e.sessionState === SS.SESSION_ENDED || e.sessionState === SS.SESSION_ENDED_WITH_ERROR) {
    if (_embedCastSession) {
      try {
        const pos = _embedCastSession.getMediaSession()?.getEstimatedTime?.();
        if (pos > 0 && isFinite(pos)) video.currentTime = pos;
      } catch {}
    }
    _embedCastSession = null;
    btn?.classList.remove('casting');
    video.play().catch(() => {});
  }
}

function _embedCastConnect() {
  if (typeof cast === 'undefined' || !cast.framework) return;
  if (location.protocol !== 'https:') return; // Cast SDK requires HTTPS
  const ctx = cast.framework.CastContext.getInstance();
  ctx.requestSession().then(() => {
    const session = ctx.getCurrentSession();
    if (!session) return;

    // cast-manifest rewrites all URLs to absolute and embeds a signed cast_token so
    // the TV can fetch segments and AES keys bypassing hotlink / token enforcement.
    const castManifestUrl = `${location.origin}/api/videos/${videoId}/cast-manifest`;
    const mediaInfo = new chrome.cast.media.MediaInfo(castManifestUrl, 'application/vnd.apple.mpegurl');
    mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;

    // HLS content type hint for the default media receiver
    mediaInfo.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat?.TS || 'ts';
    mediaInfo.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat?.MPEG2_TS || 'mpeg2_ts';

    if (typeof videoData !== 'undefined' && videoData) {
      const meta = new chrome.cast.media.GenericMediaMetadata();
      meta.title = videoData.title || '';
      if (videoData.thumbnailUrl) {
        const thumbUrl = /^https?:\/\//i.test(videoData.thumbnailUrl)
          ? videoData.thumbnailUrl
          : location.origin + videoData.thumbnailUrl;
        if (!/^\/\/(localhost|127\.)/.test(thumbUrl.replace(/^https?:/, ''))) {
          meta.images = [{ url: thumbUrl }];
        }
      }
      mediaInfo.metadata = meta;
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = video.currentTime || 0;
    request.autoplay = true;
    session.loadMedia(request).then(() => {
      if (typeof toast === 'function') toast('Transmitiendo en TV');
      // Listen for playback errors on the receiver
      const ms = session.getMediaSession();
      if (ms) {
        ms.addUpdateListener((isAlive) => {
          if (!isAlive) return;
          if (ms.playerState === chrome.cast.media.PlayerState.IDLE && ms.idleReason) {
            if (ms.idleReason === chrome.cast.media.IdleReason.ERROR) {
              console.error('[cast-embed] Receiver reported playback error');
              if (typeof toast === 'function') toast('Error de reproducción en el TV');
            }
          }
        });
      }
    }).catch(e => {
      console.error('[cast-embed] loadMedia error:', e);
      if (typeof toast === 'function') toast('Error al transmitir: ' + (e?.description || e?.code || 'desconocido'));
    });
  }).catch(() => {});
}

let keyThumbTimer = null;
function showKeySeekThumb(targetTime) {
  if (!spriteMeta || !spriteImg) return;
  const clamped = Math.max(0, Math.min(targetTime, video.duration));
  const pct = clamped / video.duration;
  positionPreview(pct, clamped);
  if (!drawSpriteFrame(clamped)) {
    if (!thumbSeekPending) { thumbVid.currentTime = clamped; thumbSeekPending = true; thumbTargetTime = clamped; }
  }
  clearTimeout(keyThumbTimer);
  keyThumbTimer = setTimeout(() => hidePreview(), 1500);
}

// Tracks whether AirPlay is currently projecting to a wireless device.
// Used to suppress the loading spinner (the local video emits `waiting`
// continuously while AirPlay is active, because data isn't buffered locally).
let isAirPlayActive = false;

function checkAirPlay() {
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    video.addEventListener('webkitplaybacktargetavailabilitychanged', e => {
      const btn = document.getElementById('airplay-btn');
      if (btn) btn.style.display = (e.availability === 'available') ? 'inline-flex' : 'none';
    });
  } else {
    // Fallback for some versions of Safari
    if (video.webkitShowPlaybackTargetPicker) {
       document.getElementById('airplay-btn').style.display = 'inline-flex';
    }
  }

  // Track AirPlay active state to suppress loading spinner while projecting
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
    isAirPlayActive = !!video.webkitCurrentPlaybackTargetIsWireless;
    if (isAirPlayActive) {
      // Hide loading overlay — video is playing on Apple TV, not locally
      showLoading(false);
    }
  });
}

function triggerAirPlay() {
  if (!video.webkitShowPlaybackTargetPicker) return;
  // If HLS.js is active (MSE), we must switch to a direct src URL first —
  // AirPlay cannot access blob: MSE URLs. Swap to native and re-invoke picker.
  if (hls) {
    const savedTime   = video.currentTime;
    const wasPlaying  = !video.paused;
    const m3u8Url     = video.dataset.m3u8 || '';
    hls.destroy();
    hls = null;
    if (m3u8Url) {
      video.src = m3u8Url;
      video.currentTime = savedTime;
      if (wasPlaying) video.play().catch(() => {});
    }
  }
  video.webkitShowPlaybackTargetPicker();
}

function updatePlayIcon(playing) {
  const href = playing ? '#sv-pause-fill' : '#sv-play-fill';
  document.getElementById('play-icon').setAttribute('href', href);
  const c = document.getElementById('center-play-icon');
  if (c) c.setAttribute('href', href);
  wrap.classList.toggle('paused', !playing);
}

// ─── Chapters helpers ──────────────────────────────────────────
function getChapterAtTime(t) {
  let active = null;
  for (const ch of chapters) {
    if (ch.start_time <= t) active = ch;
    else break;
  }
  return active;
}

function updateActiveChapter() {
  const cur = getChapterAtTime(video.currentTime);
  document.querySelectorAll('.chapter-label').forEach(el => {
    el.classList.toggle('current', el.dataset.id === cur?.id);
  });
}

// ─── Progress & chapter markers ───────────────────────────────
function renderChapterMarkers() {
  // Remove existing markers
  document.querySelectorAll('.chapter-marker').forEach(m => m.remove());
  const track = document.getElementById('progress-track');
  const dur = video.duration || 0;
  if (!dur) return;

  chapters.forEach(ch => {
    if (ch.start_time <= 0) return;
    const pct = (ch.start_time / dur) * 100;
    const marker = document.createElement('div');
    marker.className = 'chapter-marker';
    marker.style.left = pct + '%';
    track.appendChild(marker);
  });
}

function jumpToChapterTime(sec) {
  video.currentTime = sec;
  wakePlayerChrome();
}

function renderChapterBar() {
  const bar = document.getElementById('chapter-bar');
  if (!chapters.length) { bar.style.display = 'none'; return; }
  bar.innerHTML = chapters.map(ch => `
    <span class="chapter-label" data-id="${ch.id}" data-time="${ch.start_time}"
      onclick="jumpToChapterTime(${ch.start_time})"
      title="${esc(ch.title)}">${esc(ch.title)}</span>
  `).join('');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Thumbnail preview ──────────────────────────────────────────
const thumbPreview  = document.getElementById('thumb-preview');
const thumbCanvas   = document.getElementById('thumb-canvas');
const thumbTimeEl   = document.getElementById('thumb-time');
const thumbChapterEl = document.getElementById('thumb-chapter');
const thumbCtx      = thumbCanvas.getContext('2d');
const hoverInd      = document.getElementById('hover-indicator');
const progressTrack = document.getElementById('progress-track');
let previewVisible  = false;
let thumbSeekPending = false;
let thumbTargetTime  = 0;

function positionPreview(pct, t) {
  const tw   = progressTrack.offsetWidth;
  const left = Math.max(72, Math.min(tw - 72, pct * tw));
  thumbPreview.style.left = left + 'px';
  thumbTimeEl.textContent = fmtTime(t);

  const ch = getChapterAtTime(t);
  if (ch) {
    thumbChapterEl.textContent = ch.title;
    thumbChapterEl.classList.add('visible');
  } else {
    thumbChapterEl.classList.remove('visible');
  }

  if (!previewVisible) { thumbPreview.classList.add('visible'); previewVisible = true; }
}

function hidePreview() {
  thumbPreview.classList.remove('visible');
  previewVisible = false;
  hoverInd.style.width = '0';
}

function drawSpriteFrame(t) {
  if (!spriteMeta || !spriteImg?.complete) return false;
  const { interval, columns, thumbW, thumbH } = spriteMeta;
  const frameIdx = Math.min(spriteMeta.totalFrames - 1, Math.floor(t / interval));
  const col = frameIdx % columns;
  const row = Math.floor(frameIdx / columns);
  thumbCtx.drawImage(spriteImg, col * thumbW, row * thumbH, thumbW, thumbH, 0, 0, 144, 81);
  return true;
}

thumbVid.addEventListener('seeked', () => {
  try { thumbCtx.drawImage(thumbVid, 0, 0, 144, 81); } catch(_) {}
  thumbSeekPending = false;
  if (Math.abs(thumbVid.currentTime - thumbTargetTime) > 0.5) {
    thumbVid.currentTime = thumbTargetTime;
    thumbSeekPending = true;
  }
});

progressTrack.addEventListener('mousemove', e => {
  const rect = progressTrack.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const t    = pct * (video.duration || 0);
  handlePreviewMove(pct, t);
});

progressTrack.addEventListener('touchstart', e => {
  wakePlayerChrome();
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
  const t = pct * (video.duration || 0);
  handlePreviewMove(pct, t);
}, { passive: true });

progressTrack.addEventListener('touchmove', e => {
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
  const t = pct * (video.duration || 0);
  handlePreviewMove(pct, t);
}, { passive: true });

function handlePreviewMove(pct, t) {
  hoverInd.style.width = (pct * 100) + '%';
  positionPreview(pct, t);
  if (!drawSpriteFrame(t)) {
    if (!thumbSeekPending) { thumbVid.currentTime = t; thumbSeekPending = true; thumbTargetTime = t; }
  }
}

progressTrack.addEventListener('mouseleave', hidePreview);
progressTrack.addEventListener('touchend', hidePreview);

progressTrack.addEventListener('click', e => {
  wakePlayerChrome();
  const rect = progressTrack.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = pct * (video.duration || 0);
});

// Mouse drag seek
let mouseSeekActive = false;
progressTrack.addEventListener('mousedown', e => {
  mouseSeekActive = true;
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = pct * (video.duration || 0);
});
document.addEventListener('mousemove', e => {
  if (!mouseSeekActive) return;
  const rect = progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = pct * (video.duration || 0);
});
document.addEventListener('mouseup', () => { mouseSeekActive = false; });

// Touch drag seek
let touchScrubbing = false;
progressTrack.addEventListener('touchend', e => {
  if (!touchScrubbing) return;
  touchScrubbing = false;
  const rect = progressTrack.getBoundingClientRect();
  const touch = e.changedTouches[0];
  const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
  video.currentTime = pct * (video.duration || 0);
  hidePreview();
  wakePlayerChrome();
});
progressTrack.addEventListener('touchstart', e => {
  touchScrubbing = true;
}, { passive: true });
progressTrack.addEventListener('touchcancel', () => { touchScrubbing = false; hidePreview(); });

// ─── Video events ──────────────────────────────────────────────
video.addEventListener('play', () => {
  updatePlayIcon(true);
  if (!hideCtrl) {
    wrap.classList.remove('ui-idle');
    wrap.classList.add('show-controls');
    scheduleIdleUiHide();
  }
  if (!viewCounted && videoId) {
    viewCounted = true;
    fetch(`${BASE}/api/videos/${videoId}/views`, { method: 'POST' }).catch(() => {});
  }
  trackEvent('play');
  _pmSend({ type: 'sv:play', videoId, currentTime: video.currentTime });
});
video.addEventListener('pause', () => {
  updatePlayIcon(false);
  freezePlayerChromeVisible();
  if (!video.ended) {
    trackEvent('pause');
    if (video.currentTime > 5) saveProgress(Math.floor(video.currentTime));
  }
  _pmSend({ type: 'sv:pause', videoId, currentTime: video.currentTime });
});
video.addEventListener('ended', () => {
  freezePlayerChromeVisible();
  trackEvent('end');
  _pmSend({ type: 'sv:ended', videoId });
});
video.addEventListener('seeked',  () => { trackEvent('seek'); if (video.currentTime > 5) saveProgress(Math.floor(video.currentTime)); });
window.addEventListener('pagehide', () => { if (video.currentTime > 5) saveProgress(Math.floor(video.currentTime)); });
// Suppress loading overlay while AirPlay is projecting: the local buffer is
// intentionally empty — the video is playing on Apple TV, not locally.
video.addEventListener('waiting', () => { if (!isAirPlayActive) showLoading(true); });
video.addEventListener('canplay', () => showLoading(false));
video.addEventListener('loadedmetadata', () => {
  if (startAt > 0) video.currentTime = startAt;
  renderChapterMarkers();
});
let _pmLastTimeSent = -1;
video.addEventListener('timeupdate', () => {
  const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  timeCurrentEl.textContent = fmtTime(video.currentTime);
  timeRemainEl.textContent = fmtRemainLabel(video.currentTime, video.duration);
  updateActiveChapter();
  const pos = Math.floor(video.currentTime);
  if (pos > 5 && pos % 5 === 0) saveProgress(pos);
  if (pos - lastProgressPos >= 10) {
    lastProgressPos = pos;
    trackEvent('progress');
  }
  // Emit sv:timeupdate to parent once per second (not every animation frame)
  if (pos !== _pmLastTimeSent) {
    _pmLastTimeSent = pos;
    _pmSend({ type: 'sv:timeupdate', videoId, currentTime: video.currentTime, duration: video.duration || 0 });
  }
  // Skip intro button
  if (_introEnd > 0) {
    const btn = document.getElementById('skip-intro-btn');
    if (btn) btn.style.display = (pos < _introEnd && !video.paused) ? 'flex' : 'none';
  }
  // Credits badge
  if (_outroStart > 0 && video.duration) {
    const badge = document.getElementById('credits-badge');
    if (badge) badge.style.display = (pos >= _outroStart && pos < Math.floor(video.duration)) ? 'block' : 'none';
  }
});

function skipIntro() {
  if (!_introEnd) return;
  video.currentTime = _introEnd;
  const btn = document.getElementById('skip-intro-btn');
  if (btn) btn.style.display = 'none';
}

function saveProgress(pos) {
  if (!videoId) return;
  localStorage.setItem(`sv_pos_${videoId}`, pos);
  clearTimeout(saveProgress._timer);
  saveProgress._timer = setTimeout(() => {
    fetch(`${BASE}/api/videos/${videoId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: pos }),
    }).catch(() => {});
  }, 10000);
}

function getSavedProgress() {
  if (!videoId) return 0;
  return parseInt(localStorage.getItem(`sv_pos_${videoId}`)) || 0;
}

function checkResume() {
  if (window._svAdPlaying) return false;
  const pos = getSavedProgress();
  if (pos > 10 && pos < (video.duration || Infinity) - 3 && Math.abs(pos - (video.currentTime || 0)) > 5) {
    video.pause();
    document.getElementById('resume-time-str').textContent = fmtTime(pos);
    document.getElementById('resume-overlay').classList.add('visible');
    return true;
  }
  return false;
}

function resumePlayback() {
  const pos = getSavedProgress();
  video.currentTime = pos;
  dismissResume();
  video.play().catch(() => {});
}

function startOver() {
  if (!videoId) return;
  localStorage.removeItem(`sv_pos_${videoId}`);
  video.currentTime = 0;
  dismissResume();
  video.play().catch(() => {});
}

function dismissResume() {
  document.getElementById('resume-overlay').classList.remove('visible');
}

video.addEventListener('progress', updateBuffer);
video.addEventListener('timeupdate', updateBuffer);

function updateBuffer() {
  if (!video.duration || !video.buffered.length) return;
  const end = video.buffered.end(video.buffered.length - 1);
  document.getElementById('progress-buffer').style.width = ((end / video.duration) * 100) + '%';
}
video.addEventListener('durationchange', renderChapterMarkers);

// ─── OTT chrome idle hide ───────────────────────────────────────
wrap.addEventListener('mousemove', () => { wakePlayerChrome(); });
wrap.addEventListener('touchstart', () => { wakePlayerChrome(); }, { passive: true });
wrap.addEventListener('touchmove', () => { wakePlayerChrome(); }, { passive: true });

// Double-tap skip (mobile)
let lastTap = 0;
wrap.addEventListener('touchstart', e => {
  if (e.target.closest('button, input, .settings-wrap, .cc-wrap')) return;
  const now = Date.now();
  const timesince = now - lastTap;
  if (timesince < 300 && timesince > 0) {
    const rect = wrap.getBoundingClientRect();
    const touchX = e.touches[0].clientX - rect.left;
    if (touchX < rect.width / 2) skip(-10);
    else skip(10);
    e.preventDefault();
  }
  lastTap = now;
}, { passive: false });

let _embedPlayClickTimer = null;
wrap.addEventListener('click', e => {
  if (e.target.closest('button, input, .settings-wrap, .cc-wrap, .player-progress-dock, .resume-card, .fast-seek-hud')) return;
  togglePlay();
});

wrap.addEventListener('dblclick', e => {
  if (e.target.closest('button, input, .settings-wrap, .cc-wrap')) return;
  toggleFullscreen();
});

// ─── Speed menu ─────────────────────────────────────────────────
let currentSpeed = 1;

// ─── Settings menu (YouTube drill-down) ──────────────────────────
let settingsView = 'main'; // 'main' | 'quality' | 'speed' | 'audio'
let audioTracks  = [];
let currentAudioTrack = -1;

function toggleSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  const opening = !menu.classList.contains('open');
  if (opening) { settingsView = 'main'; renderSettingsMenu(); }
  menu.classList.toggle('open');
  wakePlayerChrome();
}

function showSettingsSection(view) {
  settingsView = view;
  renderSettingsMenu();
}

function updateSettingsBadge() {
  const badge = document.getElementById('settings-badge');
  if (!badge) return;
  if (currentSpeed !== 1) {
    badge.textContent = currentSpeed + '×';
    badge.className = 'settings-badge show speed-text';
  } else if (currentLevel !== -1) {
    badge.textContent = '';
    badge.className = 'settings-badge show';
  } else {
    badge.textContent = '';
    badge.className = 'settings-badge';
  }
}

const _chev_r = `<svg class="settings-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
const _chev_l = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><polyline points="15 18 9 12 15 6"/></svg>`;
const _check  = `<svg class="settings-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

function renderSettingsMenu() {
  const menu = document.getElementById('settings-menu');

  if (settingsView === 'quality') {
    const opts = [{ label: 'AUTO', level: -1 }];
    levels.forEach((l, i) => {
      let label = l.height ? `${l.height}p` : `L${i}`;
      if      (l.height >= 2160) label = '4K Ultra HD';
      else if (l.height >= 1080) label = '1080p FHD';
      else if (l.height >= 720)  label = '720p HD';
      opts.push({ label, level: i });
    });
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Calidad</button>` +
      `<div class="settings-divider"></div>` +
      opts.map(o =>
        `<div class="settings-opt${o.level === currentLevel ? ' active' : ''}" onclick="setQuality(${o.level})">${_check}${o.label}</div>`
      ).join('');
    return;
  }

  if (settingsView === 'audio') {
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Audio</button>` +
      `<div class="settings-divider"></div>` +
      audioTracks.map((t, i) => {
        const label = t.name || (t.lang ? t.lang.toUpperCase() : `Pista ${i + 1}`);
        const active = i === currentAudioTrack || (currentAudioTrack === -1 && i === 0);
        return `<div class="settings-opt${active ? ' active' : ''}" onclick="setAudioTrack(${i})">${_check}${label}</div>`;
      }).join('');
    return;
  }

  if (settingsView === 'speed') {
    const speeds = [
      { v: 0.5,  label: '0.5×' },
      { v: 0.75, label: '0.75×' },
      { v: 1,    label: 'Normal' },
      { v: 1.25, label: '1.25×' },
      { v: 1.5,  label: '1.5×' },
      { v: 2,    label: '2×' },
    ];
    menu.innerHTML =
      `<button class="settings-back" onclick="showSettingsSection('main')">${_chev_l} Velocidad</button>` +
      `<div class="settings-divider"></div>` +
      speeds.map(s =>
        `<div class="settings-opt${currentSpeed === s.v ? ' active' : ''}" onclick="setSpeed(${s.v})">${_check}${s.label}</div>`
      ).join('');
    return;
  }

  if (settingsView === 'subtitles') {
    const trackRows = [{ key: null, label: 'Desactivado' }, ...subtitlesList.map(t => ({ key: subKey(t), label: t.label || t.language.toUpperCase() }))]
      .map(o => `<div class="settings-opt${ccKey === o.key ? ' active' : ''}" onclick="setCcByKey(${o.key === null ? 'null' : "'" + o.key + "'"})">${_check}${o.label}</div>`)
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
      </div>`;
    return;
  }

  // Main view
  const qualLabel  = currentLevel === -1 ? 'AUTO' : (levels[currentLevel]?.height ? `${levels[currentLevel].height}p` : `L${currentLevel}`);
  const speedLabel = currentSpeed === 1 ? 'Normal' : `${currentSpeed}×`;
  let html = '';
  if (hls && levels.length) {
    html += `<div class="settings-row" onclick="showSettingsSection('quality')">
      <span class="settings-row-label">Calidad</span>
      <span class="settings-row-value">${qualLabel}</span>${_chev_r}
    </div>`;
  }
  if (hls && audioTracks.length > 0) {
    const idx = currentAudioTrack === -1 ? 0 : currentAudioTrack;
    const audioLabel = audioTracks[idx]?.name || (audioTracks[idx]?.lang?.toUpperCase()) || 'Auto';
    html += `<div class="settings-row" onclick="showSettingsSection('audio')">
      <span class="settings-row-label">Audio</span>
      <span class="settings-row-value">${audioLabel}</span>${_chev_r}
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

function setAudioTrack(index) {
  if (!hls) return;
  hls.audioTrack = index;
  currentAudioTrack = index;
  document.getElementById('settings-menu').classList.remove('open');
  renderSettingsMenu();
}

function setSpeed(v) {
  currentSpeed = v;
  video.playbackRate = v;
  localStorage.setItem('sv_playback_speed', v);
  document.getElementById('settings-menu').classList.remove('open');
  updateSettingsBadge();
  wakePlayerChrome();
}

function setQuality(level) {
  if (!hls) return;
  hls.currentLevel = level;
  currentLevel = level;
  document.getElementById('settings-menu').classList.remove('open');
  updateSettingsBadge();
  trackEvent('quality_change', { quality: level === -1 ? 'AUTO' : (levels[level]?.height ? `${levels[level].height}p` : `L${level}`) });
  wakePlayerChrome();
}

document.addEventListener('click', e => {
  // Use composedPath() — e.target may be detached when innerHTML was replaced by a menu transition
  const path = e.composedPath();
  if (!path.some(el => el.classList?.contains('settings-wrap'))) document.getElementById('settings-menu')?.classList.remove('open');
});

// ─── Fast Seek System (Prime Video style) ────────────────────
const _fsRates = [2, 4, 6];
let _fsDir      = 0;
let _fsLevel    = 0;
let _fsActive   = false;
let _fsPrevRate = 1;
let _fsPrevMuted = false;
let _fsWasPaused = false;
let _fsEscTimer = null;
let _fsRwdInterval = null;

function fastSeekStart(dir) {
  if (_fsActive && _fsDir === dir) return;
  fastSeekStop();
  _fsDir      = dir;
  _fsLevel    = 0;
  _fsActive   = true;
  _fsPrevRate = video.playbackRate;
  _fsPrevMuted = video.muted;
  _fsWasPaused = video.paused;

  const hud   = document.getElementById('fast-seek-hud');
  const pill  = document.getElementById('fast-seek-pill');
  const icon  = document.getElementById('fast-seek-icon');
  const speedEl = document.getElementById('fast-seek-speed');

  hud.setAttribute('data-dir', dir > 0 ? 'fwd' : 'back');

  if (dir > 0) {
    icon.innerHTML = '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>';
  } else {
    icon.innerHTML = '<polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/>';
  }

  speedEl.textContent = '×' + _fsRates[0];
  hud.classList.add('active');
  pill.classList.remove('bump');

  if (dir > 0) {
    if (_fsWasPaused) video.play().catch(() => {});
    video.playbackRate = _fsRates[0];
  } else {
    video.muted = true;
    _fsRwdInterval = setInterval(() => {
      const jump = _fsRates[_fsLevel] * 0.1;
      video.currentTime = Math.max(0, video.currentTime - jump);
      if (video.currentTime <= 0) fastSeekStop();
    }, 100);
  }

  function scheduleEscalation() {
    _fsEscTimer = setTimeout(() => {
      if (!_fsActive) return;
      if (_fsLevel < _fsRates.length - 1) {
        _fsLevel++;
        speedEl.textContent = '×' + _fsRates[_fsLevel];
        pill.classList.remove('bump');
        void pill.offsetWidth;
        pill.classList.add('bump');
        if (dir > 0) video.playbackRate = _fsRates[_fsLevel];
        scheduleEscalation();
      }
    }, 2000);
  }
  scheduleEscalation();
  wakePlayerChrome();
}

function fastSeekStop() {
  if (!_fsActive) return;
  _fsActive = false;
  const dir = _fsDir;
  _fsDir    = 0;
  clearTimeout(_fsEscTimer);
  _fsEscTimer = null;
  if (_fsRwdInterval) { clearInterval(_fsRwdInterval); _fsRwdInterval = null; }
  const hud = document.getElementById('fast-seek-hud');
  if (hud) hud.classList.remove('active');
  video.playbackRate = _fsPrevRate;
  video.muted = _fsPrevMuted;
  if (_fsWasPaused && dir > 0) video.pause();
  wakePlayerChrome();
}

// ─── Keyboard shortcuts ─────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (hideCtrl) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    const dir = e.code === 'ArrowRight' ? 1 : -1;
    if (e.repeat) {
      if (!_fsActive) fastSeekStart(dir);
    } else {
      skip(dir * 10);
      showKeySeekThumb(video.currentTime);
    }
    return;
  }

  switch (e.code) {
    case 'Space':      e.preventDefault(); togglePlay(); break;
    case 'ArrowUp':    e.preventDefault(); setVolume(Math.min(1, video.volume + 0.1)); break;
    case 'ArrowDown':  e.preventDefault(); setVolume(Math.max(0, video.volume - 0.1)); break;
    case 'KeyJ':       e.preventDefault(); skip(-10); break;
    case 'KeyL':       e.preventDefault(); skip(10); break;
    case 'KeyC':       e.preventDefault(); toggleCcQuick(); break;
    case 'Comma':      e.preventDefault(); { const s=[0.5,0.75,1,1.25,1.5,2]; const i=s.indexOf(currentSpeed); if(i>0) setSpeed(s[i-1]); } break;
    case 'Period':     e.preventDefault(); { const s=[0.5,0.75,1,1.25,1.5,2]; const i=s.indexOf(currentSpeed); if(i<s.length-1) setSpeed(s[i+1]); } break;
    case 'KeyF':       toggleFullscreen(); break;
    case 'KeyM':       toggleMute(); break;
    case 'Home':       e.preventDefault(); video.currentTime = 0; break;
    case 'End':        e.preventDefault(); if (video.duration) video.currentTime = video.duration; break;
  }
  if (!video.paused && !e.repeat) wakePlayerChrome();
});

// Stop fast seek when arrow key is released
document.addEventListener('keyup', e => {
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    if (_fsActive) fastSeekStop();
  }
});

// ─── HLS init ──────────────────────────────────────────────────
// Safari (desktop + iOS) tiene soporte nativo HLS y es el único navegador con
// AirPlay/webkitShowPlaybackTargetPicker. HLS.js usa MSE (blob: URL) que las
// Apple TV/AirPlay no pueden acceder, causando loading infinito al proyectar.
// Solución: en Safari siempre usamos src nativa; HLS.js solo en Chrome/Firefox.
function isSafariBrowser() {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
}

function initHls(m3u8Url) {
  const preferNative = isSafariBrowser() && video.canPlayType('application/vnd.apple.mpegurl');
  if (!preferNative && Hls.isSupported()) {
    hls = new Hls({
      enableWorker:            true,
      lowLatencyMode:          false,

      // ── Aggressive initial buffering ──────────────────────
      // With 4s segments, 30s buffer = ~7-8 segments pre-loaded.
      maxBufferLength:         30,
      maxMaxBufferLength:      60,
      maxBufferSize:           60 * 1000 * 1000, // 60 MB
      maxBufferHole:           0.3,
      backBufferLength:        90,

      // ── ABR tuning ────────────────────────────────────────
      startLevel:              -1,   // ABR auto-picks best quality
      abrEwmaDefaultEstimate:  1_000_000,  // seed at 1 Mbps
      abrEwmaFastLive:         3,
      abrEwmaSlowLive:         9,
      abrEwmaFastVoD:          3,
      abrEwmaSlowVoD:          9,
      abrBandWidthFactor:      0.80,
      abrBandWidthUpFactor:    0.70,
      highBufferWatchdogPeriod: 2,
      nudgeMaxRetry:           5,

      xhrSetup: hlsXhrSetup,
    });

    hls.loadSource(m3u8Url);
    hls.attachMedia(video);

    if (!spriteMeta) {
      const thumbHls = new Hls({ maxBufferLength: 5 });
      thumbHls.loadSource(m3u8Url);
      thumbHls.attachMedia(thumbVid);
      thumbHls.on(Hls.Events.MANIFEST_PARSED, () => { thumbHls.currentLevel = 0; });
    }

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      levels = hls.levels;
      audioTracks = hls.audioTracks;
      currentAudioTrack = hls.audioTrack;
      updateSettingsBadge();
      if (autoplay) video.play().catch(() => {});
    });

    // ── Live ABR badge: show the quality ABR actually chose ───
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      if (currentLevel === -1) {
        const activeH = levels[data.level]?.height;
        const badge = document.getElementById('settings-badge');
        if (badge && activeH) {
          badge.textContent = activeH + 'p';
          badge.className = 'settings-badge show';
        }
      }
      if (settingsView === 'quality') renderSettingsMenu();
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      audioTracks = hls.audioTracks;
      currentAudioTrack = hls.audioTrack;
      renderSettingsMenu();
    });

    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
      currentAudioTrack = data.id;
      renderSettingsMenu();
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showErr('Error de reproducción');
      }
    });

  } else if (preferNative || video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / iOS native HLS — compatible con AirPlay y webkitShowPlaybackTargetPicker
    video.src = m3u8Url;
    if (!spriteMeta) thumbVid.src = m3u8Url;
    video.addEventListener('loadedmetadata', () => {
      if (autoplay) video.play().catch(() => {});
    }, { once: true });
  } else {
    showErr('HLS no es compatible con este navegador');
  }
}

// ─── Error ─────────────────────────────────────────────────────
function showErr(msg) {
  document.getElementById('error-state').classList.add('visible');
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('processing-state').classList.remove('visible');
}

// ─── Password access ──────────────────────────────────────────
function showPasswordOverlay() {
  document.getElementById('password-overlay').style.display = 'flex';
  document.getElementById('processing-state').classList.remove('visible');
  document.getElementById('error-state').classList.remove('visible');
  setTimeout(() => document.getElementById('pw-input')?.focus(), 50);
}

async function submitPassword() {
  const pw = document.getElementById('pw-input').value;
  const errEl = document.getElementById('pw-error');
  const btn = document.getElementById('pw-submit-btn');
  if (!pw) { errEl.textContent = 'Ingresa una contraseña'; return; }
  errEl.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch(`${BASE}/api/videos/${videoId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.error || 'Contraseña incorrecta'; return; }
    sessionStorage.setItem(`sv_unlock_${videoId}`, d.token);
    document.getElementById('password-overlay').style.display = 'none';
    init();
  } catch { errEl.textContent = 'Error de conexión'; }
  finally { btn.disabled = false; }
}

// ─── Subtitles / CC ───────────────────────────────────────────
let ccLang       = null;
let ccKey        = null;
let subtitlesList = [];
let _activeTextTrack = null;
const _subDisplay = document.getElementById('sv-subtitle-display');

// Subtitle style preferences
let subPrefs = { size: 'normal', color: 'white', bg: 0.78 };
(function loadSubPrefsFromStorage() {
  try {
    const s = localStorage.getItem('sv_sub_prefs');
    if (s) subPrefs = { ...subPrefs, ...JSON.parse(s) };
  } catch {}
})();

function applySubStyle() {
  if (!_subDisplay) return;
  const sizeMap = { small: '14px', normal: '18px', large: '22px', xlarge: '28px' };
  const colorMap = { white: '#fff', yellow: '#ffff00', cyan: '#00ffff' };
  _subDisplay.style.fontSize = sizeMap[subPrefs.size] || '18px';
  _subDisplay.style.color    = colorMap[subPrefs.color] || '#fff';
  const bg = Math.max(0, Math.min(1, subPrefs.bg));
  document.querySelectorAll('#sv-subtitle-display .sv-sub-line').forEach(el => {
    el.style.background = `rgba(0,0,0,${bg})`;
  });
}

function setSubPref(key, val) {
  subPrefs[key] = val;
  try { localStorage.setItem('sv_sub_prefs', JSON.stringify(subPrefs)); } catch {}
  applySubStyle();
  renderSettingsMenu();
}

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
      const tmp = document.createElement('span');
      tmp.appendChild(frag);
      text = tmp.innerHTML.replace(/<\/?[^>]+(>|$)/g, '').trim();
    } else {
      text = (cues[i].text || '').trim();
    }
    text = text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
    if (text) lines.push(text);
  }
  const colorMap = { white: '#fff', yellow: '#ffff00', cyan: '#00ffff' };
  const bg = Math.max(0, Math.min(1, subPrefs.bg));
  _subDisplay.innerHTML = lines.map(l => {
    const safe = l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<span class="sv-sub-line" style="background:rgba(0,0,0,${bg});color:${colorMap[subPrefs.color]||'#fff'}">${safe}</span>`;
  }).join('');
}

function subKey(t) { return t ? (t.language + '|' + (t.label || t.language)) : null; }

// Quick CC toggle: turn current track on/off
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

// Primary subtitle selector — key is subKey string or null
function setCcByKey(key) {
  const entry = key === null ? null : subtitlesList.find(t => subKey(t) === key);
  ccKey  = key;
  ccLang = entry?.language || null;

  document.getElementById('cc-btn')?.classList.toggle('active', key !== null);

  // Detach listener but keep mode='hidden' — 'disabled' would unload VTT cues in Chrome
  // which breaks instant re-enable (browser must re-download the file).
  if (_activeTextTrack) {
    _activeTextTrack.removeEventListener('cuechange', _onCueChange);
    _activeTextTrack.mode = 'hidden';
    _activeTextTrack = null;
  }
  if (_subDisplay) _subDisplay.innerHTML = '';

  localStorage.setItem(`sv_cc_${videoId}`, key === null ? 'null' : key);

  if (!entry) { renderSettingsMenu(); wakePlayerChrome(); return; }

  const absUrl = new URL(entry.src, location.href).href;
  let trackEl = null;
  for (const el of video.querySelectorAll('track')) {
    if (el.src === absUrl) { trackEl = el; break; }
  }
  if (!trackEl) {
    trackEl = document.getElementById('subtitle-track');
    if (trackEl) { trackEl.src = entry.src; trackEl.srclang = ccLang || 'und'; }
  }

  function activate() {
    const found = trackEl?.track;
    if (!found) return;
    found.mode = 'hidden';
    _activeTextTrack = found;
    found.addEventListener('cuechange', _onCueChange);
    _onCueChange();
  }

  if (trackEl && trackEl.readyState >= 2) {
    activate(); // cues already in memory — instant
  } else {
    const t = trackEl?.track;
    if (t && t.mode === 'disabled') t.mode = 'hidden';
    if (trackEl) trackEl.addEventListener('load', activate, { once: true });
  }

  renderSettingsMenu();
  wakePlayerChrome();
}

async function loadSubtitles() {
  try {
    const [txRes, tracksRes] = await Promise.allSettled([
      fetch(`${BASE}/api/videos/${videoId}/transcriptions`),
      fetch(`${BASE}/api/videos/${videoId}/tracks`),
    ]);
    const txList = txRes.status === 'fulfilled' && txRes.value.ok
      ? (await txRes.value.json()).filter(t => t.status === 'ready').map(t => ({
          language: t.language, label: t.language.toUpperCase() + ' (IA)',
          src: `${BASE}/api/videos/${videoId}/transcriptions/${t.language}/subtitles.vtt`,
        }))
      : [];
    const uploadedList = tracksRes.status === 'fulfilled' && tracksRes.value.ok
      ? (await tracksRes.value.json())
          .filter(t => t.kind === 'subtitle' && t.url)
          .map(t => ({
            language: t.language,
            label: t.label || t.language.toUpperCase(),
            src: t.url,
            isDefault: !!t.default_track,
          }))
      : [];
    subtitlesList = [...txList, ...uploadedList];

    // Show CC button and update settings when tracks available
    document.getElementById('cc-wrap')?.classList.toggle('has-tracks', subtitlesList.length > 0);
    renderSettingsMenu();

    // Restore saved CC preference or activate default
    const savedCc = localStorage.getItem(`sv_cc_${videoId}`);
    if (savedCc !== null && savedCc !== 'null') {
      const entry = subtitlesList.find(t => subKey(t) === savedCc || t.language === savedCc);
      if (entry) setCcByKey(subKey(entry));
    } else if (savedCc === null) {
      const def = subtitlesList.find(t => t.isDefault);
      if (def) setCcByKey(subKey(def));
    }
  } catch {}
}

// ─── Init ──────────────────────────────────────────────────────
async function init() {
  if (!videoId) return showErr('Video no encontrado');
  try {
    const unlockToken = sessionStorage.getItem(`sv_unlock_${videoId}`);
    const qs = new URLSearchParams();
    if (unlockToken) qs.set('unlock', unlockToken);
    const qStr = qs.toString() ? '?' + qs.toString() : '';
    const [videoRes, chaptersRes] = await Promise.all([
      fetch(`${BASE}/api/videos/${videoId}${qStr}`),
      fetch(`${BASE}/api/videos/${videoId}/chapters`)
    ]);

    if (!videoRes.ok) {
      const err = await videoRes.json().catch(() => ({}));
      if (videoRes.status === 403 && err.error === 'password_required') return showPasswordOverlay();
      if (videoRes.status === 403 && err.error === 'private') return showErr('Este video es privado');
      if (videoRes.status === 410 || err.error === 'expired') return showErr('Este video ha expirado y ya no está disponible.');
      return showErr('Video no encontrado');
    }
    const videoData = await videoRes.json();

    // Load chapters
    if (chaptersRes.ok) {
      chapters = await chaptersRes.json();
      renderChapterBar();
    }

    // Apply workspace embed config (URL params take priority)
    const cfg = videoData.embedConfig || {};
    if (!accentHex && cfg.color) {
      document.documentElement.style.setProperty('--pv-accent', cfg.color);
      document.documentElement.style.setProperty('--pv-scrub', cfg.color);
      document.documentElement.style.setProperty('--accent', cfg.color);
      document.documentElement.style.setProperty('--ott-accent', cfg.color);
      
      const hex = cfg.color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      document.documentElement.style.setProperty('--pv-accent-rgb', `${r}, ${g}, ${b}`);
    }
    if (!logoUrl && cfg.logoUrl) {
      const logoEl = document.getElementById('logo-overlay');
      logoEl.onerror = () => logoEl.classList.remove('visible');
      applyLogoCorner(logoEl, cfg.logoPos || logoPosParam);
      logoEl.src = cfg.logoUrl;
      logoEl.classList.add('visible');
    }
    if (cfg.playerName) {
      document.title = cfg.playerName;
    }

    // F2.6: Watermark overlay (CSS-only, no re-encoding)
    if (cfg.watermarkEnabled && cfg.watermarkText) {
      let wText = cfg.watermarkText
        .replace('{date}', new Date().toLocaleDateString());
      // Note: {viewer_ip} is resolved server-side; leave as placeholder if not replaced
      const posMap = {
        'top-left':     'top:12px;left:12px;',
        'top-right':    'top:12px;right:12px;',
        'bottom-left':  'bottom:40px;left:12px;',
        'bottom-right': 'bottom:40px;right:12px;',
        'center':       'top:50%;left:50%;transform:translate(-50%,-50%);',
      };
      const posStyle = posMap[cfg.watermarkPosition] || posMap['bottom-right'];
      const opacity = Math.max(0.1, Math.min(0.9, cfg.watermarkOpacity || 0.3));
      const wEl = document.createElement('div');
      wEl.id = 'sv-watermark';
      wEl.textContent = wText;
      wEl.style.cssText = `position:absolute;${posStyle}z-index:10;pointer-events:none;color:#fff;font-size:13px;font-weight:600;font-family:system-ui,sans-serif;opacity:${opacity};text-shadow:0 1px 3px rgba(0,0,0,.7);user-select:none;`;
      document.getElementById('player-wrap')?.appendChild(wEl);
    }

    // ── Sistema de anuncios ────────────────────────────────────────
    if (cfg.ads && cfg.ads.enabled) {
      _initAds(cfg.ads);
    }

    const onMeta = () => {
      checkResume();
      video.removeEventListener('loadedmetadata', onMeta);
    };
    if (video.readyState >= 1) onMeta();
    else video.addEventListener('loadedmetadata', onMeta);

    _introEnd   = Number(videoData.intro_end)   || 0;
    _outroStart = Number(videoData.outro_start) || 0;

    const topTitle = document.getElementById('top-title-el');
    if (topTitle && videoData.title) topTitle.textContent = videoData.title;
    if (videoData.title) {
      document.title = cfg.playerName
        ? `${videoData.title} — ${cfg.playerName}`
        : videoData.title;
    }

    const hasQualities = Array.isArray(videoData.qualities) && videoData.qualities.length > 0;
    const isReady = videoData.status === 'ready';
    const isPartial = videoData.status === 'transcoding' && hasQualities;

    if (isReady || isPartial) {
      document.getElementById('processing-state').classList.remove('visible');

      // Show/update a subtle banner while some qualities are still transcoding
      if (isPartial) {
        const quals = videoData.qualities.join(', ');
        let banner = document.getElementById('partial-banner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'partial-banner';
          banner.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:20;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);padding:6px 12px;display:flex;align-items:center;gap:8px;font-size:11px;font-family:system-ui,sans-serif;color:#fff;pointer-events:none;';
          document.getElementById('player-wrap')?.appendChild(banner);
        }
        banner.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>Procesando… disponible en <strong>${quals}</strong></span>`;
        setTimeout(init, 5000);
      } else {
        document.getElementById('partial-banner')?.remove();
      }

      if (!hls) {
        // First time — full initialization; never re-init while already playing
        if (videoData.spriteMeta) {
          try {
            const metaRes = await fetch(videoData.spriteMeta);
            if (metaRes.ok) {
              spriteMeta = await metaRes.json();
              spriteImg  = new Image();
              spriteImg.src = videoData.spriteUrl;
            }
          } catch (_) {}
        }
        await fetchVideoToken();
        // Store m3u8Url in dataset so triggerAirPlay() can access it for HLS.js→native swap
        video.dataset.m3u8 = videoData.m3u8Url;
        initHls(videoData.m3u8Url);
        loadSubtitles();
      }

    } else if (['queued', 'transcoding'].includes(videoData.status)) {
      document.getElementById('processing-state').classList.add('visible');
      setTimeout(init, 5000);
    } else if (videoData.status === 'error') {
      showErr('Error de transcodificación');
    }
  } catch (_) {
    showErr('No se pudo conectar al servidor');
  }
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
  if ([0.5, 0.75, 1, 1.25, 1.5, 2].includes(spd)) setSpeed(spd);
  updateVolIcon();
}

function retryInit() {
  document.getElementById('error-state').classList.remove('visible');
  init();
}

// Prevent clicks inside menus from bubbling to the document close-handler.
document.getElementById('settings-menu').addEventListener('click', e => e.stopPropagation());

// ─── Sistema de anuncios (embed) ──────────────────────────────
// Mismo motor que app-player.js, copiado aquí para el embed standalone.

let _adsInited = false;
let _adsMidrollFired = false;
let _adsBannerEl = null;
let _adsPopupEl  = null;

function _initAds(adsCfg) {
  if (_adsInited || !adsCfg?.enabled) return;
  _adsInited = true;
  const type = adsCfg.type || 'vast';

  if ((type === 'vast' || type === 'all') && adsCfg.vastUrl) _initVastAd(adsCfg);

  if ((type === 'banner' || type === 'all') && adsCfg.bannerHtml) {
    const delay = Math.max(0, parseInt(adsCfg.bannerDelay) || 0);
    setTimeout(() => _showBanner(adsCfg), delay * 1000);
  }

  if ((type === 'popup' || type === 'all') && adsCfg.popupUrl) {
    const freq  = Math.max(1, parseInt(adsCfg.popupFrequency) || 1);
    const key   = `sv_popup_count_${videoId}`;
    const count = parseInt(localStorage.getItem(key) || '0') + 1;
    localStorage.setItem(key, count);
    if (count % freq === 0) {
      const delay = Math.max(0, parseInt(adsCfg.popupDelay) || 0);
      setTimeout(() => _showPopup(adsCfg), delay * 1000);
    }
  }

  if ((type === 'vast' || type === 'all') && adsCfg.vastUrl && adsCfg.vastPosition === 'midroll' && adsCfg.vastMidrollAt > 0) {
    video.addEventListener('timeupdate', function _midrollCheck() {
      if (_adsMidrollFired) { video.removeEventListener('timeupdate', _midrollCheck); return; }
      if (video.currentTime >= adsCfg.vastMidrollAt) {
        _adsMidrollFired = true;
        video.removeEventListener('timeupdate', _midrollCheck);
        video.pause();
        _showVastFallback(adsCfg.vastUrl, adsCfg);
      }
    });
  }

  if ((type === 'vast' || type === 'all') && adsCfg.vastUrl && adsCfg.vastPosition === 'postroll') {
    video.addEventListener('ended', () => _showVastFallback(adsCfg.vastUrl, adsCfg), { once: true });
  }
}

function _initVastAd(adsCfg) {
  if (adsCfg.vastPosition !== 'preroll' && adsCfg.vastPosition !== undefined) return;
  if (typeof google !== 'undefined' && google.ima) {
    try { google.ima.settings.setDisableCustomPlaybackForIOS10Plus(true); } catch {}
    return;
  }
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
    function finish() {
      if (done) return; done = true;
      clearInterval(skipTick);
      px(tE);
      adC.remove();
      _show();
      if (!checkResume()) video.play().catch(() => {});
    }
    adv.addEventListener('ended', finish);
    adv.addEventListener('error', finish);
  }).catch(() => { adC.remove(); _show(); video.play().catch(() => {}); });
}

/**
 * Prefix CSS selectors with a scope class (handles @media/@supports recursively).
 * @keyframes / @font-face / @import are passed through unchanged.
 */
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

/**
 * Parse banner HTML, scope <style> tags to a unique class, sanitize, return element.
 * CSS written inside the banner only applies within it — no bleed to the player page.
 */
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
  // Base positioning — no background/padding yet (may be overridden below)
  banner.style.cssText = `position:absolute;${pos === 'top' ? 'top:0' : 'bottom:52px'};left:0;right:0;z-index:30;`;

  const dismiss = () => { banner.remove(); _adsBannerEl = null; };

  // Build scoped + sanitized DOM element from banner HTML
  const scopedEl = _buildScopedBanner(adsCfg.bannerHtml, adsCfg.creativeId || null);

  // Does the banner HTML include its own close button?
  const hasCustomClose = !!scopedEl.querySelector('.sv-close-btn, [data-sv-close]');

  if (hasCustomClose) {
    // ── Custom banner with its own design ──────────────────────────────────
    // No extra wrapper styles — let the banner HTML control everything.
    // Wire up any .sv-close-btn / [data-sv-close] via delegation (onclick was sanitized away).
    scopedEl.addEventListener('click', e => {
      if (e.target.closest('.sv-close-btn, [data-sv-close]')) dismiss();
    });
    banner.appendChild(scopedEl);
  } else {
    // ── Simple banner — use default system layout ──────────────────────────
    banner.style.cssText += 'background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:space-between;padding:8px 12px;gap:10px;';
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;font-size:13px;color:#fff;overflow:hidden;';
    content.appendChild(scopedEl);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,.6);font-size:18px;cursor:pointer;padding:0 4px;flex-shrink:0;';
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
  popup.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:60;background:#1a1a2e;border:1px solid rgba(255,255,255,.15);border-radius:12px;overflow:hidden;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.8);';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'position:absolute;top:8px;right:10px;background:rgba(0,0,0,.5);border:none;color:#fff;font-size:18px;cursor:pointer;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;z-index:2;';
  closeBtn.onclick = () => { popup.remove(); _adsPopupEl = null; };
  const iframe = document.createElement('iframe');
  iframe.src = adsCfg.popupUrl;
  iframe.style.cssText = 'width:100%;height:200px;border:none;display:block;';
  iframe.sandbox = 'allow-scripts allow-same-origin allow-popups';
  popup.appendChild(closeBtn); popup.appendChild(iframe);
  document.getElementById('player-inner')?.appendChild(popup);
  _adsPopupEl = popup;
  video.pause();
}

loadPreferences();
applySubStyle();
updateFsIcon();
checkAirPlay();
setTimeout(_tryCastInit, 1500);
init();
