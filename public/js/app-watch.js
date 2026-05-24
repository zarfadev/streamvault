'use strict';
const BASE = location.origin;
const _vidMatch = location.pathname.match(/\/watch\/([^/?#]+)/);
const videoId = _vidMatch ? _vidMatch[1] : null;

// For API auth: only use access tokens (signed with jwtSecret).
// Refresh tokens are signed with a different secret and will be rejected by authenticate middleware.
const _accessToken = localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token')
                   || localStorage.getItem('sv_token');

// For nav display: also check refresh token in localStorage (always stored there for cross-tab detection,
// even when remember-me=OFF). Presence means user has an active session in another tab.
const _hasSession = !!(_accessToken
                   || localStorage.getItem('sv_refresh_token')
                   || sessionStorage.getItem('sv_refresh_token'));
if (_hasSession) document.getElementById('nav-dashboard').style.display = 'flex';
else document.getElementById('nav-login').style.display = 'flex';

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDur(s){ if(!s||isNaN(s))return''; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=Math.floor(s%60); return h>0?`${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`:`${m}:${String(sc).padStart(2,'0')}`; }
function fmtViews(n){ if(!n&&n!==0)return''; if(n>=1e6)return(n/1e6).toFixed(1)+'M vistas'; if(n>=1e3)return(n/1e3).toFixed(1)+'K vistas'; return n+' vista'+(n!==1?'s':''); }
function timeAgo(ts){ const d=Date.now()/1000-ts; if(d<60)return'ahora'; if(d<3600)return`hace ${Math.floor(d/60)}m`; if(d<86400)return`hace ${Math.floor(d/3600)}h`; if(d<2592000)return`hace ${Math.floor(d/86400)}d`; return`hace ${Math.floor(d/2592000)} mes${Math.floor(d/2592000)>1?'es':''}`; }

function toast(msg){
  const el=document.getElementById('share-toast');
  el.textContent=msg; el.style.opacity='1';
  clearTimeout(el._t); el._t=setTimeout(()=>el.style.opacity='0',2400);
}
function copy(text,msg){ navigator.clipboard.writeText(text).then(()=>toast(msg||'¡Copiado!')); }

let _descExpanded=false;
function toggleDesc(){
  _descExpanded=!_descExpanded;
  const el=document.getElementById('desc-text');
  const btn=document.getElementById('desc-btn');
  if(el) el.className='desc-text'+(_descExpanded?' expanded':'');
  if(btn) btn.textContent=_descExpanded?'Ver menos ▲':'Ver más ▼';
}

function showPasswordPrompt(){
  document.getElementById('skeleton')?.remove();
  document.getElementById('page').innerHTML=`
    <div class="sv-error-container">
      <div class="sv-error-card">
        <div class="sv-error-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        </div>
        <h2 class="sv-error-title">Contenido protegido</h2>
        <p class="sv-error-desc">Este video requiere una contraseña para ser visualizado. Por favor, ingrésala a continuación.</p>
        <div style="max-width:320px;margin:0 auto;">
          <input type="password" id="pw-input" placeholder="Contraseña de acceso"
            style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:12px;color:var(--text);padding:14px 16px;font-size:15px;font-family:var(--sans);outline:none;margin-bottom:12px;text-align:center;"
            onkeydown="if(event.key==='Enter')submitPassword()">
          <div id="pw-error" style="color:var(--red);font-size:13px;margin-bottom:12px;min-height:18px;font-weight:600;"></div>
          <button onclick="submitPassword()" class="btn btn-primary" style="width:100%;padding:14px;border-radius:12px;font-size:15px;">Desbloquear video</button>
        </div>
      </div>
    </div>`;
  setTimeout(()=>document.getElementById('pw-input')?.focus(),100);
}

async function submitPassword(){
  const pw=document.getElementById('pw-input')?.value;
  const errEl=document.getElementById('pw-error');
  if(!pw){errEl.textContent='Ingresa la contraseña';return;}
  errEl.textContent='';
  try{
    const r=await fetch(`${BASE}/api/videos/${videoId}/unlock`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    const d=await r.json();
    if(!r.ok){errEl.textContent=d.error||'Contraseña incorrecta';return;}
    sessionStorage.setItem(`sv_unlock_${videoId}`,d.token);
    init();
  }catch{errEl.textContent='Error de conexión';}
}

function renderError(type, title, desc) {
  let icon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>';
  if (type === 'private') icon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';
  if (type === 'dmca') icon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>';

  document.getElementById('page').innerHTML = `
    <div class="error-main-v2">
      <div class="error-card-v2" id="err-card">
        <div class="icon-box">${icon}</div>
        <h1 class="error-title-v2">${title}</h1>
        <p class="error-desc-v2">${desc}</p>
        <a href="/" class="btn-v2">Explorar ${window._svSiteName||'StreamVault'}</a>
      </div>
    </div>`;
  if (window.gsap) {
    gsap.from("#err-card", { y: 40, opacity: 0, duration: 1, ease: "power4.out" });
    gsap.from(".icon-box", { scale: 0.5, opacity: 0, duration: 0.8, delay: 0.2, ease: "back.out(1.7)" });
  }
}

async function init(){
  if(!videoId){
    renderError('404', 'Video no encontrado', 'El video que buscas no existe, ha sido desactivado o se ha movido permanentemente.');
    return;
  }
  try{
    const unlock=sessionStorage.getItem(`sv_unlock_${videoId}`);
    const qs=unlock?`?unlock=${unlock}`:'';
    const headers=_accessToken?{'Authorization':'Bearer '+_accessToken}:{};
    const r=await fetch(`${BASE}/api/videos/${videoId}${qs}`,{headers});
    if(!r.ok){
      const err=await r.json().catch(()=>({}));
      if(r.status===403&&err.error==='password_required'){showPasswordPrompt();return;}
      if(r.status===403&&err.error==='private'){
        renderError('private', 'Acceso Restringido', 'Este video ha sido configurado como privado por su propietario y no está disponible para el público.');
        return;
      }
      if(err.error==='dmca'){
        renderError('dmca', 'Contenido Retirado', 'Este video ya no está disponible debido a una reclamación de derechos de autor (DMCA).');
        return;
      }
      throw new Error('not found');
    }
    const v=await r.json();
    document.title=`${v.title} — ${window._svSiteName||'StreamVault'}`;

    // Load related videos — scoped to same workspace so cross-tenant content never leaks.
    // Uses ?workspace_id= query param (works for both authenticated and anonymous viewers).
    // The API only returns public+ready videos in this path regardless of the filter.
    let related=[];
    if(v.workspace_id){
      try{
        const rr=await fetch(`${BASE}/api/videos?limit=10&workspace_id=${encodeURIComponent(v.workspace_id)}`);
        if(rr.ok){
          const rd=await rr.json();
          related=(rd.videos||[]).filter(rv=>rv.id!==videoId&&rv.status==='ready'&&(rv.visibility==='public'||!rv.visibility)).slice(0,7);
        }
      }catch{}
    }

    const embedCode=`<iframe src="${BASE}/embed/${esc(videoId)}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen; picture-in-picture"></iframe>`;
    const playerUrl=`${BASE}/player/${esc(videoId)}`;
    const quals=Array.isArray(v.qualities)?v.qualities:[];
    const vis=v.visibility||'public';
    const visBadge=vis==='private'?`<span class="vis-badge vis-private">Privado</span>`:vis==='password'?`<span class="vis-badge vis-password">Con contraseña</span>`:'';

    document.getElementById('skeleton')?.remove();

    document.getElementById('page').innerHTML=`
      <div class="watch-grid">
        <!-- Left: player + info -->
        <div>
          <div class="player-shell">
            <div class="player-wrap">
              <iframe
                id="player-iframe"
                src="${BASE}/player/${esc(videoId)}"
                allow="autoplay; fullscreen; picture-in-picture; accelerometer; gyroscope"
                loading="eager"
                referrerpolicy="no-referrer-when-downgrade"
              ></iframe>
            </div>
          </div>

          <div class="video-info">
            <h1 class="video-title">${esc(v.title)}</h1>
            <div class="video-meta">
              ${v.views?`<span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${fmtViews(v.views)}</span>`:''}
              ${v.duration?`<span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${fmtDur(v.duration)}</span>`:''}
              ${v.created_at?`<span>${timeAgo(v.created_at)}</span>`:''}
              ${quals.map(q=>`<span class="quality-pill">${esc(q)}</span>`).join('')}
              ${visBadge}
            </div>

            <div class="action-row">
              ${v.downloadsEnabled!==false?`<a href="${BASE}/download/${esc(videoId)}" class="action-btn download" target="_blank" rel="noopener">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Descargar
              </a>`:''}
              <button class="action-btn" onclick="copy('${BASE}/watch/${esc(videoId)}','¡Link copiado!')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                Copiar link
              </button>
              ${v.embedEnabled!==false?`<button class="action-btn" onclick="copy('${esc(embedCode).replace(/'/g,"\\'")}','¡Código embed copiado!')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                Embed
              </button>`:''}
              <a href="${playerUrl}" class="action-btn" target="_blank" rel="noopener">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Solo player
              </a>
            </div>

            ${v.description?`
            <div class="desc-card">
              <div class="desc-label">Descripción</div>
              <div class="desc-text" id="desc-text">${esc(v.description)}</div>
              ${v.description.length>220?`<button class="desc-toggle" id="desc-btn" onclick="toggleDesc()">Ver más ▼</button>`:''}
            </div>`:''}
          </div>
        </div>

        <!-- Right: related -->
        <div class="sidebar">
          <div class="sidebar-label">Relacionados</div>
          <div class="related-list">
            ${related.length?related.map((rv,_ri)=>{
              const thumb=rv.thumbnailUrl||`${BASE}/videos/${rv.id}/thumb.jpg`;
              return `<a href="${BASE}/watch/${esc(rv.id)}" class="related-card">
                <div class="related-thumb">
                  <img src="${esc(thumb)}" alt="${esc(rv.title)}" loading="lazy" id="rthumb-${_ri}" onload="" onerror="this.style.display='none';var p=document.createElement('div');p.className='thumb-placeholder';p.innerHTML='<svg width=24 height=24 viewBox=&quot;0 0 24 24&quot; fill=none stroke=currentColor stroke-width=1.5><polygon points=&quot;5 3 19 12 5 21 5 3&quot;/></svg>';this.parentElement.appendChild(p);">
                  ${rv.duration?`<span class="related-dur">${fmtDur(rv.duration)}</span>`:''}
                </div>
                <div class="related-body">
                  <div class="related-title" title="${esc(rv.title)}">${esc(rv.title)}</div>
                  <div class="related-meta">${fmtViews(rv.views||0)}${rv.created_at?' · '+timeAgo(rv.created_at):''}</div>
                </div>
              </a>`;
            }).join(''):`<p class="related-empty">No hay más videos en este canal.</p>`}
          </div>

          <div class="player-link-card">
            <div class="player-link-label">URL del player</div>
            <div class="player-link-url">
              <span class="player-link-text">${playerUrl}</span>
              <button class="player-link-copy" onclick="copy('${playerUrl}','¡URL del player copiada!')">Copiar</button>
            </div>
          </div>
        </div>
      </div>`;

    // Fade-in del iframe cuando el player interior termina de cargar.
    const iframe = document.getElementById('player-iframe');
    if (iframe) {
      iframe.addEventListener('load', function onIframeLoad() {
        setTimeout(() => iframe.classList.add('loaded'), 100);
      });
      setTimeout(() => { if (iframe && !iframe.classList.contains('loaded')) iframe.classList.add('loaded'); }, 2000);
    }

  }catch(e){
    renderError('404', 'Video no encontrado', 'El video que buscas no existe, ha sido eliminado o la URL es incorrecta.');
  }
}

init();
