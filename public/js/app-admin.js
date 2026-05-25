const BASE = location.origin;
let _token = localStorage.getItem('sv_access_token') || sessionStorage.getItem('sv_access_token') || localStorage.getItem('sv_token') || '';
let _user = null;
let _wsCache = [], _usrCache = [];
let _planTarget = null;
let _impTarget = null;
let _emailTarget = null;
let _growthChart = null, _plansChart = null;
let _audPage = 1;
let _prices = { starter: 19, pro: 59, enterprise: 99 };

function esc(str)     { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function escAttr(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
(async function init() {
  if (!_token) return rl();

  try {
    let r = await fetch(`${BASE}/auth/me`, { headers: { Authorization: 'Bearer ' + _token } });

    // Token expired — try silent refresh before redirecting to login
    if (r.status === 401) {
      const rt = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token') || localStorage.getItem('sv_refresh');
      if (rt) {
        try {
          const rr = await fetch(`${BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rt }),
          });
          if (rr.ok) {
            const rd = await rr.json();
            if (rd.accessToken) {
              const inSession = !localStorage.getItem('sv_access_token') && !!sessionStorage.getItem('sv_access_token');
              const store = inSession ? sessionStorage : localStorage;
              _token = rd.accessToken;
              store.setItem('sv_access_token', _token);
              if (rd.refreshToken) store.setItem('sv_refresh_token', rd.refreshToken);
              r = await fetch(`${BASE}/auth/me`, { headers: { Authorization: 'Bearer ' + _token } });
            }
          }
        } catch {}
      }
    }

    if (!r.ok) return rl();
    const d = await r.json();
    if (d.user?.platform_role !== 'super_admin') {
      alert('Acceso denegado: Se requiere rol de Super Admin');
      return window.location.href = '/dashboard';
    }
    _user = d.user;
    document.getElementById('profile-avatar').textContent = (_user.name||'A')[0].toUpperCase();
    document.getElementById('profile-name').textContent = _user.name || _user.email;
    document.getElementById('profile-email').textContent = _user.email || '—';
    document.getElementById('dd-name').textContent = _user.name || _user.email;
    document.getElementById('dd-email').textContent = _user.email || '—';
    document.body.classList.add('ready');
    startLiveStream();
    restoreSection();
  } catch { rl(); }
})();
function rl() { window.location.href = '/login?redirect=/admin'; }
function doLogout() {
  const rt = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token') || localStorage.getItem('sv_refresh');
  if (rt) fetch(`${BASE}/auth/logout`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({refreshToken:rt}) }).catch(()=>{});
  ['sv_access_token','sv_token','sv_refresh_token','sv_refresh'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
  window.location.href = '/login';
}
function hdr() { 
  return { 
    'Authorization': 'Bearer ' + _token, 
    'Content-Type': 'application/json'
  };
}
async function api(url, opts={}) {
  const r = await fetch(BASE+url, { ...opts, headers:hdr() });
  if (r.status===401) { rl(); throw new Error('401'); }
  if (r.status===403) { 
    alert('Acceso denegado: Se requiere rol de Super Admin');
    window.location.href = '/dashboard';
    throw new Error('403'); 
  }
  return r;
}
const SECTIONS = ['overview','workspaces','users','videos','billing','plans','gateways','referrals','ads','queue','storage','audit','live','config'];
function go(name, el) {
  SECTIONS.forEach(s => { const e=document.getElementById('s-'+s); if(e) e.style.display=s===name?'block':'none'; });
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  if (el) el.classList.add('active');
  else document.querySelector(`.nav-item[data-s="${name}"]`)?.classList.add('active');
  if (window.innerWidth<=900) closeNav();
  // Guardar la sección actual en el hash de la URL
  if (window.location.hash !== '#' + name) {
    window.location.hash = name;
  }
  ({overview:loadOverview,workspaces:loadWorkspaces,users:loadUsers,videos:loadAdminVideos,billing:loadBilling,plans:loadPlansConfig,gateways:loadGateways,referrals:loadReferrals,ads:loadAdsOverview,queue:loadQueue,storage:loadStorage,audit:()=>loadAudit(1),live:loadLive,config:loadConfig})[name]?.();
}
// Función para restaurar la sección desde el hash de la URL
function restoreSection() {
  const hash = window.location.hash.slice(1); // Remover el #
  const section = SECTIONS.includes(hash) ? hash : 'overview';
  go(section);
}
// Escuchar cambios en el hash para sincronizar con el botón atrás/adelante del navegador
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1);
  if (SECTIONS.includes(hash)) {
    go(hash);
  }
});
function _syncMenuBtn(isOpen) {
  const btn = document.getElementById('menu-toggle');
  if (!btn) return;
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  btn.setAttribute('aria-label', isOpen ? 'Cerrar navegación' : 'Abrir navegación');
}
function toggleNav() { const o = document.body.classList.toggle('nav-open'); _syncMenuBtn(o); }
function closeNav() { document.body.classList.remove('nav-open'); _syncMenuBtn(false); }
function toggleProfileMenu(e) { e.stopPropagation(); const d=document.getElementById('profile-dropdown'); d.classList.toggle('open'); document.getElementById('profile-trigger').setAttribute('aria-expanded',d.classList.contains('open')); }
document.addEventListener('click', ()=>{ document.getElementById('profile-dropdown')?.classList.remove('open'); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeNav(); });
/* ─── OVERVIEW ──────────────────────────────────────────────── */
async function loadOverview() {
  try {
    const [sR,gR,aR] = await Promise.all([api('/api/admin/stats'),api('/api/admin/growth'),api('/api/admin/activity')]);
    const [s,g,act] = await Promise.all([sR.json(),gR.json(),aR.json()]);
    document.getElementById('ov-videos').textContent = (s.total||0).toLocaleString('es');
    document.getElementById('ov-ready').textContent = `${(s.ready||0).toLocaleString('es')} listos`;
    document.getElementById('ov-users').textContent = (s.totalUsers||0).toLocaleString('es');
    document.getElementById('ov-new-users').textContent = `${(s.recentSignups||0)} esta semana`;
    document.getElementById('ov-workspaces').textContent = (s.totalWorkspaces||0).toLocaleString('es');
    document.getElementById('ov-new-ws').textContent = `${(s.recentVideos||0)} nuevos videos`;
    document.getElementById('ov-views').textContent = (s.totalViews||0).toLocaleString('es');
    const q = s.queue||{};
    const rOk = q.mode==='bull';
    document.getElementById('sys-redis').innerHTML = `<span class="dot ${rOk?'dot-green':'dot-red'}"></span><span style="color:${rOk?'var(--green)':'var(--red)'}">${rOk?'Bull OK':'Sin Redis'}</span>`;
    document.getElementById('sys-s3').innerHTML = `<span class="dot ${s.s3?.enabled?'dot-green':'dot-amber'}"></span><span style="color:${s.s3?.enabled?'var(--green)':'var(--amber)'}">${s.s3?.enabled?'Conectado':'No config'}</span>`;
    document.getElementById('sys-waiting').textContent = q.waiting??'—';
    document.getElementById('sys-active').textContent = q.active??'—';
    document.getElementById('sys-failed').textContent = q.failed??'—';
    document.getElementById('sys-storage').textContent = fmtBytes(s.totalStorage||0);
    // Worker status check
    try {
      const hR = await fetch(`${BASE}/api/health`);
      const h = await hR.json();
      const dbOk = h.checks?.database?.status==='ok';
      document.getElementById('sys-db').innerHTML = `<span class="dot ${dbOk?'dot-green':'dot-red'}"></span><span style="color:${dbOk?'var(--green)':'var(--red)'}">OK ${h.checks?.database?.latencyMs??''}ms</span>`;
      document.getElementById('sys-worker').innerHTML = `<span class="dot dot-amber"></span><span style="color:var(--amber);">Ver /status</span>`;
    } catch {}
    // Activity
    document.getElementById('ov-activity').innerHTML = act.map(a=>`
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);">
        <div style="width:30px;height:30px;border-radius:50%;background:rgba(124,108,250,.15);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--accent2);flex-shrink:0;">${a.type==='user_registered'?'U':'V'}</div>
        <div style="min-width:0;flex:1;"><div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.label||'—')}</div><div style="font-size:11px;color:var(--muted);">${a.type==='user_registered'?'Registro':'Video'} · ${timeAgo(a.ts)}</div></div>
      </div>`).join('') || '<span style="color:var(--muted);font-size:13px;">Sin actividad reciente</span>';
    // Growth chart
    if (_growthChart) _growthChart.destroy();
    const _cv = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const _ca = (hex, a) => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; };
    const _accent = _cv('--accent'); const _green = _cv('--green'); const _muted = _cv('--muted');
    _growthChart = new Chart(document.getElementById('growth-chart').getContext('2d'),{type:'line',data:{labels:g.map(x=>x.date),datasets:[{label:'Usuarios',data:g.map(x=>x.users),borderColor:_accent,backgroundColor:_ca(_accent,.08),borderWidth:2,pointRadius:2,fill:true,tension:.3},{label:'Videos',data:g.map(x=>x.videos),borderColor:_green,backgroundColor:_ca(_green,.06),borderWidth:2,pointRadius:2,fill:true,tension:.3}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{ticks:{color:_muted,font:{size:11}},grid:{color:'rgba(255,255,255,.05)'}},y:{ticks:{color:_muted,font:{size:11}},grid:{color:'rgba(255,255,255,.05)'}}},plugins:{legend:{labels:{color:_muted,font:{size:12}}}}}});
    // Plans breakdown (from workspaces)
    await loadPlansBrkdown();
    // Video status
    document.getElementById('video-status-breakdown').innerHTML = `
      ${statusBar('Listos',s.ready,s.total,'var(--green)')}
      ${statusBar('Procesando',s.processing,s.total,'var(--amber)')}
      ${statusBar('Error',s.error,s.total,'var(--red)')}`;
  } catch(e) { console.error(e); }
}
function statusBar(label,val,total,color){
  const pct = total>0?Math.round((val||0)/total*100):0;
  return `<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span>${label}</span><span style="font-family:var(--mono);color:${color};">${(val||0).toLocaleString('es')} (${pct}%)</span></div><div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%;background:${color};"></div></div></div>`;
}
async function loadPlansBrkdown() {
  try {
    const r = await api('/api/admin/workspaces?limit=100');
    const data = await r.json();
    // Handle both array and paginated response
    const ws = Array.isArray(data) ? data : (data.workspaces || []);
    const counts = { starter:0, pro:0, enterprise:0 };
    ws.forEach(w => { if(counts[w.plan]!==undefined) counts[w.plan]++; });
    const total = ws.length||1;
    if (_plansChart) _plansChart.destroy();
    const _pv = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const _pa = _pv('--accent'); const _pg = _pv('--green'); const _pamb = _pv('--amber');
    _plansChart = new Chart(document.getElementById('plans-chart').getContext('2d'),{type:'doughnut',data:{labels:['Starter','Pro','Enterprise'],datasets:[{data:[counts.starter,counts.pro,counts.enterprise],backgroundColor:[_pa,_pg,_pamb],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},cutout:'65%'}});
    document.getElementById('plans-legend').innerHTML = [['Starter',_pa,counts.starter],['Pro',_pg,counts.pro],['Enterprise',_pamb,counts.enterprise]].map(([l,c,n])=>`<span style="display:flex;align-items:center;gap:4px;"><span style="width:9px;height:9px;border-radius:50%;background:${c};display:inline-block;"></span><span style="color:var(--muted);">${l}</span><b>${n}</b></span>`).join('');
  } catch{}
}
/* ─── WORKSPACES ─────────────────────────────────────────────── */
async function loadWorkspaces(page = 1) {
  const r = await api(`/api/admin/workspaces?page=${page}&limit=100`);
  if (!r.ok) { toast('Error al cargar workspaces', 'error'); return; }
  const data = await r.json();
  // API returns { workspaces, total, page, limit } — handle both formats for compatibility
  _wsCache = Array.isArray(data) ? data : (data.workspaces || []);
  const total = data.total ?? _wsCache.length;
  document.getElementById('ws-count').textContent = total;
  renderWs();
}
function renderWs(){
  const q=(document.getElementById('ws-q')?.value||'').toLowerCase();
  const pf=document.getElementById('ws-plan-f')?.value||'';
  const sf=document.getElementById('ws-status-f')?.value||'';
  let list=_wsCache.filter(w=>(!q||w.name.toLowerCase().includes(q)||(w.owner_email||'').toLowerCase().includes(q)||(w.owner_name||'').toLowerCase().includes(q))&&(!pf||w.plan===pf)&&(!sf||(sf==='active'?!w.suspended:w.suspended)));
  document.getElementById('ws-tbody').innerHTML=list.map(w=>`
    <tr>
      <td><div style="font-weight:600;">${esc(w.name)}</div><div class="td-mono">${esc(w.slug)}</div></td>
      <td><span class="badge badge-${w.plan}">${w.plan}</span></td>
      <td><div style="font-size:13px;">${esc(w.owner_name||'—')}</div><div class="td-mono">${esc(w.owner_email||'—')}</div></td>
      <td class="td-mono">${w.video_count||0}</td>
      <td><div class="td-mono">${fmtBytes(w.storage_used||w.storage_used_bytes||0)}</div><div style="font-size:10px;color:var(--muted);">de ${fmtBytes(w.max_storage_bytes||0)}</div></td>
      <td class="td-mono">${fmtBytes(w.bandwidth_used_bytes||0)}</td>
      <td class="td-mono">${w.member_count||0}</td>
      <td><div style="display:flex;align-items:center;gap:6px;"><span class="dot ${w.suspended?'dot-red':'dot-green'}"></span><span style="font-size:12px;">${w.suspended?'Suspendido':'Activo'}</span></div></td>
      <td class="td-mono">${timeAgo(w.created_at)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="openWsDetail('${w.id}')" title="Ver detalles">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="openPlanModal('${w.id}')" title="Cambiar plan">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="openCustomLimitsModal(&quot;${w.id}&quot;)" title="Permisos personalizados">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="toggleSuspend(&quot;${w.id}&quot;,${w.suspended?1:0})" title="${w.suspended?'Reactivar':'Suspender'} workspace">
            ${w.suspended 
              ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
              : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteWs('${w.id}')" title="Eliminar workspace">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`).join('')||'<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:24px;">Sin resultados</td></tr>';
}
async function openWsDetail(id){
  const w=_wsCache.find(x=>x.id===id);
  if(!w) return;
  document.getElementById('ws-det-title').textContent = w.name;
  const storPct = w.max_storage_bytes>0?Math.min(100,Math.round((w.storage_used_bytes||0)/w.max_storage_bytes*100)):0;
  const bwPct = w.max_bandwidth_bytes>0?Math.min(100,Math.round((w.bandwidth_used_bytes||0)/w.max_bandwidth_bytes*100)):0;
  document.getElementById('ws-det-body').innerHTML = `
    <div class="grid2" style="margin-bottom:0;">
      <div>
        <div class="form-group"><label>ID</label><div class="code-block">${esc(w.id)}</div></div>
        <div class="form-group"><label>Slug</label><div class="code-block">${esc(w.slug)}</div></div>
        <div class="form-group"><label>Plan actual</label><span class="badge badge-${esc(w.plan)}" style="font-size:12px;">${esc(w.plan)}</span></div>
        <div class="form-group"><label>Estado</label><span style="font-size:13px;color:${w.suspended?'var(--red)':'var(--green)'};">${w.suspended?'Suspendido':'Activo'}</span></div>
        <div class="form-group"><label>Creado</label><span style="font-size:13px;">${new Date((w.created_at||0)*1000).toLocaleString('es')}</span></div>
      </div>
      <div>
        <div class="form-group"><label>Owner</label><div style="font-size:13px;">${esc(w.owner_name||'—')}<br><span class="td-mono">${esc(w.owner_email||'—')}</span></div></div>
        <div class="form-group"><label>Videos / Límite</label><span style="font-size:13px;">${w.video_count||0} / ${w.max_videos<0?'∞':w.max_videos}</span></div>
        <div class="form-group"><label>Storage usado</label>
          <div>${fmtBytes(w.storage_used_bytes||0)} de ${fmtBytes(w.max_storage_bytes||0)}</div>
          <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${storPct}%;background:${storPct>90?'var(--red)':storPct>70?'var(--amber)':'var(--accent)'}"></div></div>
        </div>
        <div class="form-group"><label>BW usado este mes</label>
          <div>${fmtBytes(w.bandwidth_used_bytes||0)} de ${fmtBytes(w.max_bandwidth_bytes||0)}</div>
          <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${bwPct}%;background:${bwPct>90?'var(--red)':bwPct>70?'var(--amber)':'var(--green)'}"></div></div>
        </div>
        <div class="form-group"><label>Miembros</label><span style="font-size:13px;">${w.member_count||0}</span></div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" onclick="closeModal('ws-detail-modal');openPlanModal('${w.id}')" title="Cambiar plan">Cambiar Plan</button>
      <button class="btn btn-ghost btn-sm" onclick="toggleSuspend('${w.id}',${w.suspended?1:0})" title="${w.suspended?'Reactivar':'Suspender'} workspace">${w.suspended?'Reactivar':'Suspender'}</button>
      <button class="btn btn-danger btn-sm" onclick="closeModal('ws-detail-modal');deleteWs('${w.id}')" title="Eliminar workspace">Eliminar Workspace</button>
    </div>`;
  openModal('ws-detail-modal');
}
function openPlanModal(id){ const ws=_wsCache.find(x=>x.id===id); if(!ws) return; _planTarget=id; document.getElementById('plan-ws-name').textContent=ws.name; document.getElementById('plan-select').value=ws.plan; openModal('plan-modal'); }
async function savePlanChange(){
  const plan=document.getElementById('plan-select').value;
  const r=await api(`/api/admin/workspaces/${_planTarget}`,{method:'PUT',body:JSON.stringify({plan})});
  if(r.ok){toast('Plan actualizado');closeModal('plan-modal');loadWorkspaces();}
  else{const d=await r.json().catch(()=>({}));toast(d.error||'Error al guardar','error');}
}
async function toggleSuspend(id,suspended){
  const r=await api(`/api/admin/workspaces/${id}`,{method:'PUT',body:JSON.stringify({suspended:!suspended})});
  if(r.ok){toast(suspended?'Workspace reactivado':'Workspace suspendido');loadWorkspaces();}
  else toast('Error','error');
}
async function deleteWs(id){
  const name=(_wsCache.find(x=>x.id===id)?.name)||id;
  if(!await confirmModal(`¿Eliminar workspace "${name}" y TODOS sus videos permanentemente? Esta acción NO se puede deshacer.`, 'Eliminar', 'Eliminar workspace', true)) return;
  const r=await api(`/api/admin/workspaces/${id}`,{method:'DELETE'});
  if(r.ok){toast('Workspace eliminado');loadWorkspaces();}
  else toast('Error','error');
}

/* ─── PERMISOS PERSONALIZADOS ───────────────────────────────── */
let _customLimitsTarget = null;

async function openCustomLimitsModal(id) {
  _customLimitsTarget = id;
  const w = _wsCache.find(x => x.id === id);
  if (!w) return toast('Workspace no encontrado', 'error');
  
  document.getElementById('cl-ws-name').textContent = w.name;
  document.getElementById('cl-ws-plan').textContent = w.plan;
  
  // Cargar límites personalizados actuales
  try {
    const r = await api(`/api/admin/workspaces/${id}/custom-limits`);
    const limits = r.ok ? await r.json() : {};
    
    // Llenar formulario con valores actuales o valores del plan
    document.getElementById('cl-max-videos').value = limits.max_videos ?? w.max_videos ?? '';
    document.getElementById('cl-max-storage').value = limits.max_storage_gb ?? (w.max_storage_bytes ? Math.round(w.max_storage_bytes / 1024 / 1024 / 1024) : '');
    document.getElementById('cl-max-bandwidth').value = limits.max_bandwidth_gb ?? (w.max_bandwidth_bytes ? Math.round(w.max_bandwidth_bytes / 1024 / 1024 / 1024) : '');
    document.getElementById('cl-max-filesize').value = limits.max_filesize_mb ?? 10240;
    document.getElementById('cl-max-members').value = limits.max_members ?? 1;
    
    // Mostrar nota sobre valores del plan
    const planLimits = getPlanLimits(w.plan);
    document.getElementById('cl-plan-info').innerHTML = `
      <div style="font-size:11px;color:var(--muted);line-height:1.5;">
        <strong>Límites del plan ${w.plan}:</strong><br>
        Videos: ${planLimits.maxVideos < 0 ? '∞' : planLimits.maxVideos} · 
        Storage: ${planLimits.maxStorageGB < 0 ? '∞' : planLimits.maxStorageGB + ' GB'} · 
        BW: ${planLimits.maxBandwidthGB < 0 ? '∞' : planLimits.maxBandwidthGB + ' GB'}
      </div>`;
    
    openModal('custom-limits-modal');
  } catch (e) {
    toast('Error al cargar límites: ' + e.message, 'error');
  }
}

function getPlanLimits(plan) {
  const defaults = {
    starter: { maxVideos: 25, maxStorageGB: 50, maxBandwidthGB: 100 },
    pro: { maxVideos: 200, maxStorageGB: 500, maxBandwidthGB: 1000 },
    enterprise: { maxVideos: -1, maxStorageGB: 2000, maxBandwidthGB: 5000 }
  };
  return defaults[plan] || defaults.starter;
}

async function saveCustomLimits() {
  if (!_customLimitsTarget) return;
  
  const btn = document.querySelector('#custom-limits-modal .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  
  try {
    const maxVideos = document.getElementById('cl-max-videos').value.trim();
    const maxStorage = document.getElementById('cl-max-storage').value.trim();
    const maxBandwidth = document.getElementById('cl-max-bandwidth').value.trim();
    const maxFilesize = document.getElementById('cl-max-filesize').value.trim();
    const maxMembers = document.getElementById('cl-max-members').value.trim();
    
    // Construir objeto solo con valores que no estén vacíos
    const customLimits = {};
    if (maxVideos !== '') customLimits.max_videos = parseInt(maxVideos) || 0;
    if (maxStorage !== '') customLimits.max_storage_gb = parseInt(maxStorage) || 0;
    if (maxBandwidth !== '') customLimits.max_bandwidth_gb = parseInt(maxBandwidth) || 0;
    if (maxFilesize !== '') customLimits.max_filesize_mb = parseInt(maxFilesize) || 10240;
    if (maxMembers !== '') customLimits.max_members = parseInt(maxMembers) || 1;
    
    const r = await api(`/api/admin/workspaces/${_customLimitsTarget}/custom-limits`, {
      method: 'PUT',
      body: JSON.stringify(customLimits)
    });
    
    if (r.ok) {
      toast('Permisos personalizados guardados');
      closeModal('custom-limits-modal');
      loadWorkspaces(); // Recargar para ver cambios
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Error al guardar', 'error');
    }
  } catch (e) {
    toast('Error de conexión', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}

async function resetCustomLimits() {
  if (!_customLimitsTarget) return;
  
  if (!await confirmModal('¿Restaurar los límites del plan por defecto? Los permisos personalizados se eliminarán.', 'Restaurar', 'Restaurar límites')) return;
  
  try {
    const r = await api(`/api/admin/workspaces/${_customLimitsTarget}/custom-limits`, {
      method: 'DELETE'
    });
    
    if (r.ok) {
      toast('Límites restaurados al plan por defecto');
      closeModal('custom-limits-modal');
      loadWorkspaces();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Error al restaurar', 'error');
    }
  } catch (e) {
    toast('Error de conexión', 'error');
  }
}
/* ─── USERS ──────────────────────────────────────────────────── */
async function loadUsers(){
  const r=await api('/api/admin/users');
  if (!r.ok) { toast('Error al cargar usuarios', 'error'); return; }
  const data=await r.json();
  _usrCache=Array.isArray(data)?data:(data.users||[]);
  document.getElementById('usr-count').textContent=_usrCache.length;
  renderUsers();
  loadLockouts();
}
async function loadLockouts() {
  const body = document.getElementById('lockouts-body');
  if (!body) return;
  try {
    const r = await api('/api/admin/2fa-lockouts');
    const d = await r.json();
    const locked = d.lockedUsers || [];
    if (!locked.length) {
      body.innerHTML = '<span style="color:var(--green);">Sin bloqueos 2FA activos.</span>';
      return;
    }
    body.innerHTML = `<table class="data-table" style="margin-top:0;"><thead><tr><th>Usuario ID</th><th>Intentos fallidos</th><th>Bloqueo restante</th><th></th></tr></thead><tbody>${
      locked.map(l => `<tr>
        <td class="td-mono" style="font-size:12px;">${l.userId}</td>
        <td style="color:var(--red);">${l.attempts}</td>
        <td style="font-size:12px;">${l.remainingMin != null ? l.remainingMin + ' min' : '—'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="unlockUser2FA('${l.userId}','${l.userId}')">Desbloquear</button></td>
      </tr>`).join('')
    }</tbody></table>`;
  } catch {
    body.innerHTML = '<span style="color:var(--muted);">Error al cargar lockouts.</span>';
  }
}
function renderUsers(){
  const q=(document.getElementById('usr-q')?.value||'').toLowerCase();
  const rf=document.getElementById('usr-role-f')?.value||'';
  const vf=document.getElementById('usr-ver-f')?.value||'';
  let list=_usrCache.filter(u=>(!q||u.email.toLowerCase().includes(q)||(u.name||'').toLowerCase().includes(q))&&(!rf||u.platform_role===rf)&&(!vf||(vf==='verified'?u.email_verified:!u.email_verified)));
  document.getElementById('usr-tbody').innerHTML=list.map(u=>{
    const role = u.platform_role || 'user';
    const badgeClass = role === 'super_admin' ? 'badge-admin' : (role === 'admin' ? 'badge-starter' : 'badge-user');
    return `
    <tr>
      <td style="font-weight:600;">${esc(u.name||'—')}</td>
      <td class="td-mono">${esc(u.email)}</td>
      <td><span class="badge ${badgeClass}">${role}</span></td>
      <td class="td-mono">${u.workspace_count||0} (${u.owned_workspaces||0} propios)</td>
      <td><div style="display:flex;align-items:center;gap:6px;"><span class="dot ${u.email_verified?'dot-green':'dot-amber'}"></span><span style="font-size:12px;">${u.email_verified?'Verificado':'Pendiente'}</span></div></td>
      <td style="text-align:center;">${u.two_factor_enabled ? '<span style="color:var(--green);font-size:12px;font-weight:600;">ON</span>' : '<span style="color:var(--muted);font-size:12px;">—</span>'}</td>
      <td class="td-mono">${u.referral_code||'—'}</td>
      <td class="td-mono">${timeAgo(u.created_at)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="openUsrDetail('${u.id}')" title="Ver detalles">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="openImpModal('${u.id}','${escAttr(u.name||u.email)}','${escAttr(u.email)}')" title="Impersonar usuario">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="openEmailModal('${u.id}','${escAttr(u.name||u.email)}','${escAttr(u.email)}')" title="Enviar email">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          </button>
          <button class="btn btn-sm" style="background:rgba(124,108,250,.12);color:var(--accent2);border:1px solid rgba(124,108,250,.25);" onclick="openRoleModal('${u.id}','${escAttr(u.name||u.email)}','${escAttr(u.email)}','${u.platform_role||'user'}')" title="Cambiar rol de plataforma">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}','${escAttr(u.email)}')" title="Eliminar usuario">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('')||'<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px;">Sin usuarios</td></tr>';
}
function openUsrDetail(id){
  const u=_usrCache.find(x=>x.id===id);
  if(!u) return;
  document.getElementById('usr-det-title').textContent=u.name||u.email;
  document.getElementById('usr-det-body').innerHTML=`
    <div class="grid2" style="margin-bottom:0;">
      <div>
        <div class="form-group"><label>ID</label><div class="code-block">${esc(u.id)}</div></div>
        <div class="form-group"><label>Email</label><div class="code-block">${esc(u.email)}</div></div>
        <div class="form-group"><label>Nombre</label><span style="font-size:13px;">${esc(u.name||'—')}</span></div>
        <div class="form-group"><label>Rol</label><span class="badge ${u.platform_role==='super_admin'?'badge-admin':'badge-user'}">${esc(u.platform_role||'user')}</span></div>
        <div class="form-group"><label>Código de referido</label><div class="code-block">${esc(u.referral_code||'—')}</div></div>
      </div>
      <div>
        <div class="form-group"><label>Email verificado</label><span style="color:${u.email_verified?'var(--green)':'var(--amber)'};">${u.email_verified?'OK Verificado':'PENDIENTE'}</span></div>
        <div class="form-group"><label>Workspaces</label><span style="font-size:13px;">${u.workspace_count||0} (${u.owned_workspaces||0} propios)</span></div>
        <div class="form-group"><label>Registrado</label><span style="font-size:13px;">${new Date((u.created_at||0)*1000).toLocaleString('es')}</span></div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" onclick="closeModal('usr-detail-modal');openImpModal('${u.id}','${escAttr(u.name||u.email)}','${escAttr(u.email)}')" title="Impersonar usuario">Impersonar</button>
      <button class="btn btn-ghost btn-sm" onclick="closeModal('usr-detail-modal');openEmailModal('${u.id}','${escAttr(u.name||u.email)}','${escAttr(u.email)}')" title="Enviar email">Enviar email</button>
      ${u.two_factor_enabled ? `<button class="btn btn-ghost btn-sm" onclick="closeModal('usr-detail-modal');reset2FA('${u.id}','${escAttr(u.email)}')" title="Desactivar 2FA">Resetear 2FA</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="closeModal('usr-detail-modal');deleteUser('${u.id}','${escAttr(u.email)}')" title="Eliminar usuario">Eliminar usuario</button>
    </div>`;
  openModal('usr-detail-modal');
}
function openImpModal(id,name,email){ _impTarget={id,name,email}; document.getElementById('imp-name').textContent=name; document.getElementById('imp-email').textContent=email; openModal('imp-modal'); }
async function doImpersonate() {
  const btn = document.querySelector('#imp-modal .btn-primary');
  btn.disabled = true; btn.textContent = 'Generando sesión...';
  try {
    const r = await api(`/api/admin/impersonate/${_impTarget.id}`, { method: 'POST' });
    if (r.ok) {
      const d = await r.json();
      // Guardar tokens de admin para restaurar al salir
      // Buscar en ambos storages — el admin pudo haber entrado sin "recordar sesión"
      const _adminAccess  = localStorage.getItem('sv_access_token')  || sessionStorage.getItem('sv_access_token')  || '';
      const _adminRefresh = localStorage.getItem('sv_refresh_token') || sessionStorage.getItem('sv_refresh_token') || '';
      localStorage.setItem('sv_imp_admin_access',  _adminAccess);
      localStorage.setItem('sv_imp_admin_refresh', _adminRefresh);
      // Metadata del usuario impersonado (para el banner)
      localStorage.setItem('sv_imp_email', _impTarget.email);
      localStorage.setItem('sv_imp_name',  _impTarget.name || _impTarget.email);
      // Activar tokens del usuario — borrar sesión anterior de ambos storages
      ['sv_access_token','sv_refresh_token','sv_token','sv_refresh'].forEach(k => {
        localStorage.removeItem(k); sessionStorage.removeItem(k);
      });
      localStorage.setItem('sv_access_token',  d.accessToken);
      localStorage.setItem('sv_refresh_token', d.refreshToken);
      // Navegar al dashboard (mismo tab — el banner persiste al refrescar)
      window.location.href = '/dashboard';
    } else {
      toast('Error al impersonar', 'error');
      btn.disabled = false; btn.textContent = 'Entrar como usuario';
    }
  } catch (e) {
    toast('Error de red', 'error');
    btn.disabled = false; btn.textContent = 'Entrar como usuario';
  }
}
function openEmailModal(id,name,email){ _emailTarget={id,name,email}; document.getElementById('email-to-name').textContent=name; document.getElementById('email-to').textContent=email; document.getElementById('email-subject').value=''; document.getElementById('email-body').value=''; openModal('email-modal'); }
async function sendUserEmail(){
  const subject = document.getElementById('email-subject').value.trim();
  const body    = document.getElementById('email-body').value.trim();
  if (!subject || !body) return toast('Completa asunto y mensaje', 'error');
  if (!_emailTarget?.id) return toast('No hay usuario seleccionado', 'error');
  const sendBtn = document.querySelector('#email-modal .modal-foot .btn-primary');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Enviando…'; }
  try {
    const r = await api('/api/admin/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: _emailTarget.id, subject, message: body }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      toast(`Email enviado a ${_emailTarget.email}`);
      closeModal('email-modal');
    } else {
      toast(d.error || 'Error al enviar email', 'error');
    }
  } catch {
    toast('Error de conexión', 'error');
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Enviar'; }
  }
}
async function deleteUser(id,email){
  if(!await confirmModal(`¿Eliminar usuario ${email} y todas sus membresías?`, 'Eliminar', 'Eliminar usuario', true)) return;
  const r=await api(`/api/admin/users/${id}`,{method:'DELETE'});
  if(r.ok){toast('Usuario eliminado');loadUsers();}
  else toast('Error','error');
}
async function reset2FA(id, email) {
  if (!await confirmModal(`¿Desactivar el 2FA de ${email}? El usuario podrá configurarlo de nuevo la próxima vez que inicie sesión.`, 'Desactivar 2FA', 'Resetear 2FA', true)) return;
  const r = await api(`/api/admin/users/${id}/2fa`, { method: 'DELETE' });
  if (r.ok) { toast('2FA desactivado correctamente'); loadUsers(); }
  else { const d = await r.json().catch(()=>({})); toast(d.error || 'Error al resetear 2FA', 'error'); }
}
async function unlockUser2FA(userId, email) {
  const r = await api(`/api/admin/2fa-lockouts/${userId}`, { method: 'DELETE' });
  if (r.ok) { toast(`Bloqueo 2FA eliminado para ${email}`); loadUsers(); }
  else toast('Error al desbloquear', 'error');
}
/* ─── VIDEOS ─────────────────────────────────────────────────── */
let _selectedVideos = new Set();
let _videosCache = [];

async function loadAdminVideos(){
  const r=await api('/api/admin/videos');
  if (!r.ok) { toast('Error al cargar videos', 'error'); return; }
  _videosCache = await r.json();
  _selectedVideos.clear();
  document.getElementById('select-all-videos').checked = false;
  updateBulkBar();
  renderVideos();
}

function renderVideos() {
  const vids = _videosCache;
  const ss=s=>s==='ready'?'background:rgba(34,211,165,.12);color:var(--green);':s==='error'?'background:rgba(248,113,113,.12);color:var(--red);':'background:rgba(251,191,36,.12);color:var(--amber);';
  const visIcon = v => v === 'public' ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>' : v === 'private' ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>' : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';
  
  document.getElementById('vid-tbody').innerHTML=vids.map(v=>`
    <tr>
      <td style="text-align:center;"><input type="checkbox" class="video-checkbox" data-video-id="${v.id}" onchange="toggleVideo('${v.id}',this.checked)" ${_selectedVideos.has(v.id)?'checked':''}></td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;" title="${esc(v.title)}">${esc(v.title)}</td>
      <td><span class="code-block" style="font-size:11px;padding:3px 7px;cursor:pointer;" onclick="copyToClipboard('${v.short_code||v.id}','Short code copiado')" title="Click para copiar">${v.short_code||v.id.slice(0,8)}</span></td>
      <td class="td-mono">${v.workspace_name ? esc(v.workspace_name) : v.workspace_id ? '<span style="opacity:.5;font-style:italic;">Eliminado</span>' : '<span style="opacity:.5;font-style:italic;">Invitado</span>'}</td>
      <td class="td-mono">${esc(v.owner_email||'—')}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
          <span class="badge" style="border-radius:5px;${ss(v.status)}">${v.status}</span>
          ${v.dmca_suspended ? '<span class="badge badge-danger" style="border-radius:5px;display:inline-flex;align-items:center;gap:3px;" title="Contenido suspendido por DMCA"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> DMCA</span>' : ''}
        </div>
      </td>
      <td class="td-mono">${(()=>{try{return JSON.parse(v.qualities||'[]').join(', ');}catch{return '—';}})()}</td>
      <td class="td-mono">${(v.views||0).toLocaleString('es')}</td>
      <td>
        <span class="td-mono size-popover" data-size="${v.file_size||v.size||0}" style="cursor:help;border-bottom:1px dashed var(--border2);" title="Click para detalles">${fmtBytes(v.file_size||v.size||0)}</span>
      </td>
      <td class="td-mono" title="${new Date((v.created_at||0)*1000).toLocaleString('es')}">${timeAgo(v.created_at)}</td>
      <td>
        <div style="display:flex;gap:4px;">
          <a class="btn btn-ghost btn-sm" href="/watch/${v.id}" target="_blank" rel="noopener" title="Ver video">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </a>
          <button class="btn btn-ghost btn-sm" onclick="openEditVideoModal('${v.id}')" title="Editar video">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteVideo('${v.id}','${escAttr(v.title)}')" title="Eliminar video">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`).join('')||'<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px;">Sin videos</td></tr>';
  
  document.querySelectorAll('.size-popover').forEach(el => {
    // Clonar el elemento para remover todos los event listeners
    const newEl = el.cloneNode(true);
    el.replaceWith(newEl);
    
    // Ahora agregar el listener al elemento limpio
    newEl.addEventListener('click', function() {
      const bytes = parseInt(this.dataset.size);
      const details = `
        <div style="font-size:12px;line-height:1.6;">
          <div style="margin-bottom:8px;"><strong>Tamaño detallado:</strong></div>
          <div>Bytes: ${bytes.toLocaleString('es')}</div>
          <div>KB: ${(bytes/1024).toFixed(2)}</div>
          <div>MB: ${(bytes/1024/1024).toFixed(2)}</div>
          <div>GB: ${(bytes/1024/1024/1024).toFixed(4)}</div>
        </div>
      `;
      showPopover(this, details);
    });
  });
}

function toggleAllVideos(checked) {
  _selectedVideos.clear();
  if (checked) {
    _videosCache.forEach(v => _selectedVideos.add(v.id));
  }
  document.querySelectorAll('.video-checkbox').forEach(cb => cb.checked = checked);
  updateBulkBar();
}

function toggleVideo(id, checked) {
  if (checked) {
    _selectedVideos.add(id);
  } else {
    _selectedVideos.delete(id);
    document.getElementById('select-all-videos').checked = false;
  }
  updateBulkBar();
}

function updateBulkBar() {
  const count = _selectedVideos.size;
  const bar = document.getElementById('bulk-bar');
  const countEl = document.getElementById('bulk-count');
  
  if (count > 0) {
    bar.style.display = 'flex';
    countEl.textContent = `${count} seleccionado${count>1?'s':''}`;
  } else {
    bar.style.display = 'none';
  }
}

async function bulkDeleteVideos() {
  if (_selectedVideos.size === 0) return toast('No hay videos seleccionados', 'error');
  if (!await confirmModal(`¿Eliminar ${_selectedVideos.size} video(s)? Esta acción no se puede deshacer.`, 'Eliminar', 'Eliminar videos', true)) return;
  
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Eliminando...';
  
  try {
    const r = await api('/api/admin/videos/bulk', {
      method: 'DELETE',
      body: JSON.stringify({ video_ids: Array.from(_selectedVideos) })
    });
    
    if (r.ok) {
      const d = await r.json();
      toast(`OK - ${d.deleted || _selectedVideos.size} videos eliminados`);
      _selectedVideos.clear();
      loadAdminVideos();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Error al eliminar', 'error');
    }
  } catch {
    toast('Error de conexión', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> Eliminar seleccionados';
  }
}

async function bulkChangeVisibility() {
  if (_selectedVideos.size === 0) return toast('No hay videos seleccionados', 'error');
  const visibility = document.getElementById('bulk-visibility').value;
  if (!visibility) return toast('Selecciona una visibilidad', 'error');
  const password = document.getElementById('bulk-password')?.value.trim() || '';
  if (visibility === 'password' && !password) return toast('Debes ingresar una contraseña', 'error');

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Aplicando...';

  const body = { video_ids: Array.from(_selectedVideos), visibility };
  if (visibility === 'password' && password) body.password = password;

  try {
    const r = await api('/api/admin/videos/bulk/visibility', {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    
    if (r.ok) {
      const d = await r.json();
      toast(`OK - Visibilidad cambiada en ${d.updated || _selectedVideos.size} videos`);
      _selectedVideos.clear();
      loadAdminVideos();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Error al cambiar visibilidad', 'error');
    }
  } catch {
    toast('Error de conexión', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aplicar';
  }
}

function clearBulkSelection() {
  _selectedVideos.clear();
  document.getElementById('select-all-videos').checked = false;
  document.querySelectorAll('.video-checkbox').forEach(cb => cb.checked = false);
  document.getElementById('bulk-visibility').value = '';
  updateBulkBar();
}

function showPopover(element, content) {
  // Remover popover existente
  const existing = document.querySelector('.custom-popover');
  if (existing) existing.remove();
  
  const popover = document.createElement('div');
  popover.className = 'custom-popover';
  popover.innerHTML = content;
  document.body.appendChild(popover);
  
  const rect = element.getBoundingClientRect();
  popover.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  popover.style.left = (rect.left + window.scrollX - popover.offsetWidth/2 + rect.width/2) + 'px';
  
  setTimeout(() => popover.classList.add('visible'), 10);
  
  const closePopover = (e) => {
    if (!popover.contains(e.target) && e.target !== element) {
      popover.classList.remove('visible');
      setTimeout(() => popover.remove(), 200);
      document.removeEventListener('click', closePopover);
    }
  };
  setTimeout(() => document.addEventListener('click', closePopover), 100);
}

function copyToClipboard(text, message) {
  navigator.clipboard.writeText(text).then(() => {
    toast(message || 'Copiado al portapapeles');
  }).catch(() => {
    toast('Error al copiar', 'error');
  });
}

let _editVideoId = null;

async function openEditVideoModal(videoId) {
  _editVideoId = videoId;
  const v = _videosCache.find(x => x.id === videoId);
  if (!v) return toast('Video no encontrado', 'error');

  // Rellenar formulario
  document.getElementById('ev-title').value = v.title || '';
  document.getElementById('ev-visibility').value = v.visibility || 'public';
  document.getElementById('ev-dmca').checked = !!v.dmca_suspended;
  document.getElementById('ev-dmca-reason').value = v.dmca_reason || '';
  document.getElementById('ev-dmca-reason-wrap').style.display = v.dmca_suspended ? 'block' : 'none';
  document.getElementById('ev-video-id').textContent = videoId;

  // Mostrar estado DMCA si está suspendido
  const dmcaWarn = document.getElementById('ev-dmca-warn');
  dmcaWarn.style.display = v.dmca_suspended ? 'block' : 'none';

  openModal('edit-video-modal');
  setTimeout(() => document.getElementById('ev-title').focus(), 100);
}

async function saveEditVideo() {
  if (!_editVideoId) return;
  const btn = document.querySelector('#edit-video-modal .btn-primary');
  btn.disabled = true; btn.textContent = 'Guardando…';

  const title      = document.getElementById('ev-title').value.trim();
  const visibility = document.getElementById('ev-visibility').value;
  const password   = document.getElementById('ev-password').value.trim();
  const dmca       = document.getElementById('ev-dmca').checked;
  const dmcaReason = document.getElementById('ev-dmca-reason').value.trim();

  if (!title) {
    btn.disabled = false; btn.textContent = 'Guardar';
    return toast('El título no puede estar vacío', 'error');
  }
  if (visibility === 'password' && !password) {
    // Allow empty to keep existing password — only warn if it's a new video being set to password
    const v = _videosCache.find(x => x.id === _editVideoId);
    if (!v?.visibility || v.visibility !== 'password') {
      btn.disabled = false; btn.textContent = 'Guardar';
      return toast('Debes ingresar una contraseña', 'error');
    }
  }

  try {
    const body = { title, visibility, dmca_suspended: dmca, dmca_reason: dmca ? dmcaReason : null };
    if (visibility === 'password' && password) body.password = password;

    const r = await api(`/api/admin/videos/${_editVideoId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast(d.error || 'Error al guardar', 'error');

    // Actualizar cache local
    const idx = _videosCache.findIndex(v => v.id === _editVideoId);
    if (idx !== -1) {
      _videosCache[idx].title = title;
      _videosCache[idx].visibility = visibility;
      _videosCache[idx].dmca_suspended = !!dmca;
      _videosCache[idx].dmca_reason = dmca ? dmcaReason : null;
    }

    toast(dmca ? 'Video suspendido por DMCA' : 'Video actualizado', dmca ? 'warning' : 'success');
    closeModal('edit-video-modal');
    renderVideos();
  } catch {
    toast('Error de conexión', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

async function deleteVideo(id,title){
  if(!await confirmModal(`¿Eliminar video "${title}"?`, 'Eliminar', 'Eliminar video', true)) return;
  const r=await api(`/api/admin/videos/${id}`,{method:'DELETE'});
  if(r.ok){toast('Video eliminado');loadAdminVideos();}
  else toast('Error','error');
}
/* ─── BILLING ────────────────────────────────────────────────── */
async function loadBilling(){
  if(!_wsCache.length) {
    const r = await api('/api/admin/workspaces');
    if (!r.ok) { toast('Error al cargar datos de billing', 'error'); return; }
    const d = await r.json();
    // API returns { workspaces, total, ... } or plain array — handle both
    _wsCache = Array.isArray(d) ? d : (d.workspaces || []);
  }
  const counts={starter:0,pro:0,enterprise:0};
  _wsCache.forEach(w=>{if(counts[w.plan]!==undefined) counts[w.plan]++;});
  const total=_wsCache.length||1;
  document.getElementById('bil-starter').textContent=counts.starter;
  document.getElementById('bil-starter-pct').textContent=`${Math.round(counts.starter/total*100)}% del total`;
  document.getElementById('bil-pro').textContent=counts.pro;
  document.getElementById('bil-pro-pct').textContent=`${Math.round(counts.pro/total*100)}% del total`;
  document.getElementById('bil-enterprise').textContent=counts.enterprise;
  document.getElementById('bil-enterprise-pct').textContent=`${Math.round(counts.enterprise/total*100)}% del total`;
  recalcMrr();
  // Plan limits table
  document.getElementById('plan-limits-table').innerHTML=`
    <table style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead><tr style="border-bottom:1px solid var(--border);">${['Plan','Videos','Storage','BW/mes','Miembros'].map(h=>`<th style="padding:6px 8px;text-align:left;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.8px;font-size:10px;">${h}</th>`).join('')}</tr></thead>
      <tbody>
        <tr style="border-bottom:1px solid var(--border);"><td style="padding:8px;"><span class="badge badge-starter">Starter</span></td><td style="padding:8px;" class="td-mono">25</td><td style="padding:8px;" class="td-mono">50 GB</td><td style="padding:8px;" class="td-mono">100 GB</td><td style="padding:8px;" class="td-mono">—</td></tr>
        <tr style="border-bottom:1px solid var(--border);"><td style="padding:8px;"><span class="badge badge-pro">Pro</span></td><td style="padding:8px;" class="td-mono">200</td><td style="padding:8px;" class="td-mono">500 GB</td><td style="padding:8px;" class="td-mono">1 TB</td><td style="padding:8px;" class="td-mono">—</td></tr>
        <tr><td style="padding:8px;"><span class="badge badge-enterprise">Enterprise</span></td><td style="padding:8px;" class="td-mono"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/></svg></td><td style="padding:8px;" class="td-mono">2 TB</td><td style="padding:8px;" class="td-mono">5 TB</td><td style="padding:8px;" class="td-mono">—</td></tr>
      </tbody>
    </table>`;
  // Paid workspaces
  const paid=_wsCache.filter(w=>w.plan==='pro'||w.plan==='enterprise').sort((a,b)=>a.plan==='enterprise'?-1:1);
  document.getElementById('paid-ws-tbody').innerHTML=paid.map(w=>`
    <tr>
      <td><div style="font-weight:600;">${esc(w.name)}</div><div class="td-mono">${esc(w.slug)}</div></td>
      <td><span class="badge badge-${w.plan}">${w.plan}</span></td>
      <td><div style="font-size:13px;">${esc(w.owner_name||'—')}</div><div class="td-mono">${esc(w.owner_email||'—')}</div></td>
      <td class="td-mono">${w.video_count||0}</td>
      <td class="td-mono">${fmtBytes(w.storage_used_bytes||0)}</td>
      <td class="td-mono">${timeAgo(w.created_at)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openPlanModal('${w.id}')">Plan</button></td>
    </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:16px;">Sin workspaces de pago</td></tr>';
}
function recalcMrr(){
  const ps=parseInt(document.getElementById('price-starter')?.value||'19');
  const pp=parseInt(document.getElementById('price-pro')?.value||'59');
  const pe=parseInt(document.getElementById('price-enterprise')?.value||'99');
  const ss=parseInt(document.getElementById('bil-starter')?.textContent||'0');
  const sp=parseInt(document.getElementById('bil-pro')?.textContent||'0');
  const se=parseInt(document.getElementById('bil-enterprise')?.textContent||'0');
  const mrr=ss*ps+sp*pp+se*pe;
  document.getElementById('bil-mrr').textContent='$'+mrr.toLocaleString('en-US');
}
/* ─── QUEUE ──────────────────────────────────────────────────── */
async function loadQueue(){
  const r=await api('/api/admin/queue');
  if (!r.ok) { toast('Error al cargar estado del queue', 'error'); return; }
  const q=await r.json();
  document.getElementById('queue-status-rows').innerHTML=`
    <div class="status-row"><span>Modo</span><span class="td-mono">${q.mode||'—'}</span></div>
    <div class="status-row"><span>En espera</span><span style="color:var(--accent2);font-weight:700;font-family:var(--mono);">${q.waiting??'—'}</span></div>
    <div class="status-row"><span>Activos</span><span style="color:var(--green);font-weight:700;font-family:var(--mono);">${q.active??'—'}</span></div>
    <div class="status-row"><span>Completados (total)</span><span style="font-family:var(--mono);color:var(--muted);">${q.completed??'—'}</span></div>
    <div class="status-row"><span>Fallados (total)</span><span style="color:var(--red);font-weight:700;font-family:var(--mono);">${q.failed??'—'}</span></div>`;
  document.getElementById('wk-conc').textContent=q.workerConcurrency||'2';
  document.getElementById('wk-tx-conc').textContent=q.transcriptionConcurrency||'4';
  document.getElementById('wk-openai').innerHTML=`<span style="color:var(--muted);">Configurar por workspace (Ajustes → General)</span>`;
  const fj=q.failed_jobs||[];
  document.getElementById('failed-list').innerHTML=fj.length?fj.map(j=>`
    <div style="background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <span style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${esc(j.title||j.videoId||'Job')}</span>
        <button class="btn btn-ghost btn-sm" onclick="retryJob('${j.id}')">Reintentar</button>
      </div>
      <div style="font-size:11px;color:var(--red);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(j.error||'Error')}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:4px;">Video: ${esc(j.videoId||'—')} · ${timeAgo((j.failedAt||0)/1000)} · ${j.attempts||0} intento(s)</div>
    </div>`).join(''):'<div class="success-box">OK - No hay jobs fallados</div>';
}
async function retryJob(id){ const r=await api(`/api/admin/queue/retry/${id}`,{method:'POST'}); if(r.ok){toast('Job reencolado');loadQueue();}else toast('Error','error'); }
async function cleanQueue(){ if(!await confirmModal('¿Limpiar jobs completados y fallados?', 'Limpiar', 'Limpiar cola', true)) return; const r=await api('/api/admin/queue/clean',{method:'DELETE'}); if(r.ok){toast('Cola limpiada');loadQueue();}else toast('Error','error'); }
/* ─── STORAGE ────────────────────────────────────────────────── */
async function loadStorage(){
  if(!_wsCache.length){
    const r=await api('/api/admin/workspaces');
    if (!r.ok) { toast('Error al cargar datos de storage', 'error'); return; }
    const d=await r.json();
    _wsCache=Array.isArray(d)?d:(d.workspaces||[]);
  }
  const total=_wsCache.reduce((s,w)=>s+(Number(w.storage_used_bytes)||0),0);
  const bySize=[..._wsCache].sort((a,b)=>(b.storage_used_bytes||0)-(a.storage_used_bytes||0)).slice(0,20);
  const maxSt=bySize[0]?.storage_used_bytes||1;
  document.getElementById('storage-totals').innerHTML=`
    <div class="status-row"><span>Total almacenado (todos los workspaces)</span><span style="font-family:var(--mono);font-weight:700;">${fmtBytes(total)}</span></div>
    <div class="status-row"><span>Workspaces con storage > 80%</span><span style="font-family:var(--mono);color:var(--red);">${_wsCache.filter(w=>w.max_storage_bytes>0&&(w.storage_used_bytes||0)/w.max_storage_bytes>0.8).length}</span></div>
    <div class="status-row"><span>Total workspaces</span><span class="td-mono">${_wsCache.length}</span></div>`;
  // S3 status
  try{
    const r=await api('/api/admin/s3/test');
    const d=await r.json();
    document.getElementById('s3-status-detail').innerHTML=d.ok?`
      <div class="success-box">OK - S3 conectado correctamente</div>
      <div class="status-row"><span>Bucket</span><span class="td-mono">${esc(d.bucket||'—')}</span></div>
      <div class="status-row"><span>Region</span><span class="td-mono">${esc(d.region||'—')}</span></div>`:`<div class="warn-box">S3 no disponible: ${esc(d.error||'error')}</div>`;
  }catch{document.getElementById('s3-status-detail').innerHTML='<div class="warn-box">S3 no configurado — usando almacenamiento local</div>';}
  document.getElementById('storage-tbody').innerHTML=bySize.map(w=>{
    const used=w.storage_used_bytes||0;
    const max=w.max_storage_bytes||0;
    const pct=max>0?Math.min(100,Math.round(used/max*100)):0;
    return `<tr>
      <td><div style="font-weight:600;">${esc(w.name)}</div><div class="td-mono">${esc(w.owner_email||'—')}</div></td>
      <td><span class="badge badge-${w.plan}">${w.plan}</span></td>
      <td class="td-mono">${w.video_count||0}</td>
      <td class="td-mono">${fmtBytes(used)}</td>
      <td class="td-mono">${max>0?fmtBytes(max):'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/></svg>'}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="progress-bar-wrap" style="flex:1;"><div class="progress-bar-fill" style="width:${pct}%;background:${pct>90?'var(--red)':pct>70?'var(--amber)':'var(--accent)'}"></div></div>
          <span style="font-size:12px;font-family:var(--mono);min-width:32px;text-align:right;color:${pct>90?'var(--red)':pct>70?'var(--amber)':'var(--muted)'};">${pct}%</span>
        </div>
      </td>
    </tr>`;}).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">Sin datos</td></tr>';
}
async function testS3(){ const btn=document.getElementById('s3-test-btn'); if(btn){btn.textContent='Probando…';btn.disabled=true;} try{ const r=await api('/api/admin/s3/test'); const d=await r.json(); if(d.ok) toast('S3 conectado OK'); else toast('S3 error: '+(d.error||'fallo'),'error'); }catch{ toast('Error','error'); } if(btn){btn.textContent='Test S3';btn.disabled=false;} }
async function pruneS3(){
  if(!await confirmModal('¿Estás seguro de ejecutar la limpieza de S3? Esto buscará carpetas en AWS S3 que no existan en la base de datos y las eliminará para ahorrar costos. Esta acción NO se puede deshacer.', 'Limpiar S3', 'Limpieza de S3', true)) return;
  const btn = document.getElementById('s3-prune-btn');
  const ogText = btn.textContent;
  btn.textContent = 'Limpiando... (puede tardar)'; btn.disabled = true;
  try {
    const r = await api('/api/admin/s3/prune', { method: 'POST' });
    const d = await r.json();
    if(r.ok && d.ok) {
      toast(`Limpieza completada: ${d.deleted} carpetas huérfanas eliminadas.`);
      if(d.errors && d.errors.length) console.warn("Errores en limpieza:", d.errors);
    } else {
      toast('Error al limpiar S3: ' + (d.error||'fallo'), 'error');
    }
  } catch(e) {
    toast('Error de red', 'error');
  } finally {
    btn.textContent = ogText; btn.disabled = false;
  }
}
/* ─── AUDIT LOG ──────────────────────────────────────────────── */
async function loadAudit(page=_audPage){
  _audPage=page;
  const actor=(document.getElementById('aud-actor')?.value||'').trim();
  const action=(document.getElementById('aud-action')?.value||'').trim();
  const params=new URLSearchParams({page,limit:50});
  if(actor) params.set('actor',actor);
  if(action) params.set('action',action);
  const r=await api(`/api/admin/audit-log?${params}`);
  if (!r.ok) { toast('Error al cargar audit log', 'error'); return; }
  const d=await r.json();
  const logs=d.logs||[];
  document.getElementById('aud-tbody').innerHTML=logs.map(l=>{
    let meta='—';
    try{ const m=JSON.parse(l.metadata||'{}'); meta=Object.entries(m).slice(0,2).map(([k,v])=>`${k}:${JSON.stringify(v)}`).join(', ')||'—'; }catch{}
    return `<tr>
      <td class="td-mono">${new Date((l.created_at||0)*1000).toLocaleString('es')}</td>
      <td><div style="font-size:12px;font-weight:600;">${esc(l.actor_email||'Sistema')}</div><div class="td-mono">${esc(l.actor_id?.slice(0,8)||'')}</div></td>
      <td><span class="badge badge-user" style="border-radius:5px;">${esc(l.action)}</span></td>
      <td class="td-mono">${esc(l.target_type||'—')}</td>
      <td class="td-mono">${esc(l.target_id?.slice(0,12)||'—')}</td>
      <td class="td-mono">${esc(l.ip||'—')}</td>
      <td style="font-size:11px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(meta)}">${esc(meta)}</td>
    </tr>`;}).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">Sin registros</td></tr>';
  const pag=d.pagination||{};
  document.getElementById('aud-pag').innerHTML=pag.pages>1?`
    <button class="btn btn-ghost btn-sm" onclick="loadAudit(${page-1})" ${page<=1?'disabled style="opacity:.4;"':''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Anterior</button>
    <span style="font-size:13px;color:var(--muted);">Página <b style="color:var(--text);">${page}</b> de <b style="color:var(--text);">${pag.pages}</b></span>
    <button class="btn btn-ghost btn-sm" onclick="loadAudit(${page+1})" ${page>=pag.pages?'disabled style="opacity:.4;"':''}>Siguiente <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>`:'';
}
/* ─── CONFIG ─────────────────────────────────────────────────── */
async function loadConfig(){
  const savedTab = sessionStorage.getItem('sv_admin_config_tab') || 'transcoding';
  if (['transcoding','platform','security','features','referrals','integrations'].includes(savedTab)) {
    switchCfgTab(savedTab, true);
  }
  
  // Ahora cargar datos del servidor
  const r=await api('/api/admin/config');
  if (!r.ok) { toast('Error al cargar configuración', 'error'); return; }
  const cfg=await r.json();
  const allQ=['360p','480p','720p','1080p','1440p','4k'];
  const enabled=cfg.transcoding?.qualities||['360p','480p','720p','1080p'];
  document.getElementById('quality-checkboxes').innerHTML=allQ.map(q=>`
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;user-select:none;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:7px 12px;">
      <input type="checkbox" id="q-${q}" value="${q}" ${enabled.includes(q)?'checked':''} style="accent-color:var(--accent);">${q}
    </label>`).join('');
  const siteName = cfg.platform?.siteName || 'StreamVault';
  document.getElementById('cfg-name').value = siteName;
  document.getElementById('cfg-support').value=cfg.platform?.supportEmail||'';
  document.title = siteName + ' — Super Admin';
  const footerEl = document.getElementById('admin-sidebar-footer');
  if (footerEl) footerEl.textContent = siteName + ' Admin v1.0';
  document.getElementById('cfg-url').value=cfg.platform?.appUrl||location.origin;
  document.getElementById('cfg-reg').value=cfg.platform?.allowRegistration!==false?'true':'false';
  document.getElementById('cfg-retention').value=cfg.platform?.analyticsRetentionDays||90;
  // Platform branding — logo del player
  const pLogoUrl = cfg.platform?.platformLogoUrl||'';
  const pLogoEl = document.getElementById('cfg-platform-logo');
  if (pLogoEl) pLogoEl.value = pLogoUrl;
  const pLogoPosEl = document.getElementById('cfg-platform-logo-pos');
  if (pLogoPosEl) pLogoPosEl.value = cfg.platform?.platformLogoPos||'tr';
  previewPlatformLogo();
  document.getElementById('cfg-jwt').value=cfg.security?.jwtExpiryHours||24;
  document.getElementById('cfg-refresh').value=cfg.security?.refreshExpiryDays||30;
  document.getElementById('cfg-bcrypt').value=cfg.security?.bcryptRounds||12;
  // Integrations
  document.getElementById('int-aws-region').textContent=cfg.s3?.region||'—';
  document.getElementById('int-s3-bucket').textContent=cfg.s3?.bucket||'—';
  document.getElementById('int-cdn').textContent=cfg.s3?.cdnBaseUrl||'—';
  document.getElementById('int-s3-status').innerHTML=cfg.s3?.bucket?'<span style="color:var(--green);">Configurado</span>':'<span style="color:var(--muted);">No configurado</span>';
  document.getElementById('int-openai').innerHTML=cfg.openaiConfigured?'<span style="color:var(--green);">Configurado OK</span>':'<span style="color:var(--muted);">No configurado</span>';
  document.getElementById('int-bedrock').textContent=cfg.bedrock?.modelId||'claude-haiku-4-5-20251001';
  document.getElementById('int-bedrock-region').textContent=cfg.bedrock?.region||cfg.s3?.region||'—';
  document.getElementById('int-stripe').innerHTML=cfg.stripeConfigured?'<span style="color:var(--green);">Configurado OK</span>':'<span style="color:var(--muted);">No configurado</span>';
  document.getElementById('int-stripe-wh').innerHTML='<span style="color:var(--muted);">Ver STRIPE_WEBHOOK_SECRET en .env</span>';
  document.getElementById('int-stripe-prices').innerHTML='<span style="color:var(--muted);">Ver STRIPE_PRICE_* en .env</span>';
  document.getElementById('int-smtp-host').textContent=cfg.smtp?.host||'—';
  document.getElementById('int-smtp-user').textContent=cfg.smtp?.user||'—';
  document.getElementById('int-smtp-from').textContent=cfg.smtp?.from||'—';
  document.getElementById('sec-tokens').textContent=cfg.security?.requireVideoTokens?'Sí (global)':'No (por workspace)';
  // Referrals config
  const ref = cfg.referrals || {};
  const refCreditEl = document.getElementById('ref-credit-usd');
  if (refCreditEl) refCreditEl.value = ref.creditUSD ?? 10;
  const refMaxEl = document.getElementById('ref-max-credits');
  if (refMaxEl) refMaxEl.value = ref.maxCreditsPerUser ?? 0;
  const refMinPlanEl = document.getElementById('ref-min-plan');
  if (refMinPlanEl) refMinPlanEl.value = ref.minPlanToRedeem || 'pro';
  const refEnabledEl = document.getElementById('ref-enabled');
  if (refEnabledEl) refEnabledEl.value = ref.enabled !== false ? 'true' : 'false';
  updateReferralProfitability();
  // Ya se aplicó el tab al inicio — no necesitamos hacerlo de nuevo aquí
}
async function saveTranscoding(){ const allQ=['360p','480p','720p','1080p','1440p','4k']; const qualities=allQ.filter(q=>document.getElementById('q-'+q)?.checked); if(!qualities.length) return toast('Selecciona al menos una','error'); const r=await api('/api/admin/config',{method:'PUT',body:JSON.stringify({section:'transcoding',data:{qualities}})}); if(r.ok) toast('Calidades guardadas — re-transcodifica videos existentes si quieres aplicarlas'); else toast('Error','error'); }

async function bulkRetranscode() {
  if (!confirm('¿Re-encolar todos los videos para transcodificar con las nuevas calidades? Solo videos con archivo fuente disponible serán procesados (máx. 200 a la vez).')) return;
  const resultEl = document.getElementById('bulk-retranscode-result');
  if (resultEl) resultEl.textContent = 'Enviando...';
  try {
    const r = await api('/api/admin/retranscode-bulk', { method: 'POST', body: JSON.stringify({}) });
    const d = await r.json();
    if (r.ok) {
      if (resultEl) resultEl.textContent = `✓ ${d.queued} videos en cola, ${d.skipped} sin fuente disponible.`;
      toast(`${d.queued} videos encolados para re-transcodificación`);
    } else {
      if (resultEl) resultEl.textContent = `Error: ${d.error}`;
      toast('Error al encolar', 'error');
    }
  } catch (e) {
    if (resultEl) resultEl.textContent = 'Error de conexión';
    toast('Error de conexión', 'error');
  }
}

function updateReferralProfitability() {
  const creditUSD = parseFloat(document.getElementById('ref-credit-usd')?.value) || 10;
  const el = document.getElementById('ref-profitability');
  if (!el) return;
  const proPlan  = 10;
  const entPlan  = 30;
  const refPct   = ((creditUSD / proPlan) * 100).toFixed(0);
  const refPctE  = ((creditUSD / entPlan) * 100).toFixed(0);
  el.innerHTML = `
    <div style="display:grid;gap:8px;">
      <div style="padding:10px 12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border2);">
        <div style="font-weight:600;margin-bottom:4px;">Plan Pro ($${proPlan}/mes)</div>
        <div>Descuento referente: <strong>$${creditUSD}</strong> = ${refPct}% de una mensualidad</div>
        <div style="color:var(--green);">Ingreso neto por conversión: <strong>$${(proPlan - creditUSD).toFixed(2)}</strong></div>
      </div>
      <div style="padding:10px 12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border2);">
        <div style="font-weight:600;margin-bottom:4px;">Plan Enterprise ($${entPlan}/mes)</div>
        <div>Descuento referente: <strong>$${creditUSD}</strong> = ${refPctE}% de una mensualidad</div>
        <div style="color:var(--green);">Ingreso neto por conversión: <strong>$${(entPlan - creditUSD).toFixed(2)}</strong></div>
      </div>
    </div>`;
}

async function saveReferralConfig() {
  const creditUSD     = parseFloat(document.getElementById('ref-credit-usd')?.value) || 10;
  const maxCredits    = parseInt(document.getElementById('ref-max-credits')?.value) || 0;
  const minPlan       = document.getElementById('ref-min-plan')?.value || 'pro';
  const enabled       = document.getElementById('ref-enabled')?.value !== 'false';
  const r = await api('/api/admin/config', { method: 'PUT', body: JSON.stringify({
    section: 'referrals',
    data: { enabled, creditUSD, maxCreditsPerUser: maxCredits, minPlanToRedeem: minPlan }
  })});
  if (r.ok) {
    toast('Configuración de referidos guardada');
    updateReferralProfitability();
  } else {
    toast('Error al guardar', 'error');
  }
}

// ── Branding del player — Preview del logo ───────────────────
function previewPlatformLogo() {
  const url = document.getElementById('cfg-platform-logo')?.value?.trim() || '';
  const img = document.getElementById('cfg-platform-logo-preview');
  const placeholder = document.getElementById('cfg-platform-logo-placeholder');
  if (!img || !placeholder) return;
  if (url) {
    img.src = url;
    img.style.display = 'block';
    placeholder.style.display = 'none';
    img.onerror = () => { img.style.display = 'none'; placeholder.style.display = 'block'; placeholder.textContent = 'URL de imagen inválida'; };
  } else {
    img.style.display = 'none';
    placeholder.style.display = 'block';
    placeholder.textContent = 'Sin logo configurado';
  }
}

function clearPlatformLogo() {
  const el = document.getElementById('cfg-platform-logo');
  if (el) el.value = '';
  previewPlatformLogo();
}

async function savePlatform(){
  const data = {
    siteName: document.getElementById('cfg-name').value.trim(),
    supportEmail: document.getElementById('cfg-support').value.trim(),
    appUrl: document.getElementById('cfg-url').value.trim(),
    allowRegistration: document.getElementById('cfg-reg').value === 'true',
    analyticsRetentionDays: parseInt(document.getElementById('cfg-retention').value) || 90,
    // Branding del player
    platformLogoUrl: document.getElementById('cfg-platform-logo')?.value?.trim() || '',
    platformLogoPos: document.getElementById('cfg-platform-logo-pos')?.value || 'tr',
    platformName: document.getElementById('cfg-name').value.trim() || '',
  };
  const r = await api('/api/admin/config', { method: 'PUT', body: JSON.stringify({ section: 'platform', data }) });
  if (r.ok) toast('Plataforma y branding guardados');
  else toast('Error al guardar', 'error');
}
async function saveSecurity(){ const data={jwtExpiryHours:parseInt(document.getElementById('cfg-jwt').value)||24,refreshExpiryDays:parseInt(document.getElementById('cfg-refresh').value)||30,bcryptRounds:parseInt(document.getElementById('cfg-bcrypt').value)||12}; const r=await api('/api/admin/config',{method:'PUT',body:JSON.stringify({section:'security',data})}); if(r.ok) toast('Guardado'); else toast('Error','error'); }
function switchCfgTab(tab, immediate = false){
  const updateDOM = () => {
    ['transcoding','platform','security','features','referrals','integrations'].forEach(t=>{
      document.getElementById('cfg-'+t).style.display=t===tab?'block':'none';
      document.getElementById('cfg-tab-'+t).classList.toggle('active',t===tab);
    });
  };

  // Ejecutar inmediatamente o en el siguiente frame para evitar parpadeo
  if (immediate) {
    updateDOM();
  } else {
    requestAnimationFrame(updateDOM);
  }

  // Guardar la sub-pestaña en sessionStorage (síncrono, fuera de RAF)
  sessionStorage.setItem('sv_admin_config_tab', tab);
  if (tab==='features') loadFeaturesTab();
}
const FEATURE_DEFS = [
  { key:'foldersEnabled',         label:'Carpetas', desc:'Organización de videos en carpetas' },
  { key:'playlistsEnabled',       label:'Playlists', desc:'Playlists y embed de playlist' },
  { key:'webhooksEnabled',        label:'Webhooks', desc:'Webhooks con firma HMAC' },
  { key:'transcriptionsEnabled',  label:'Transcripciones', desc:'Subtítulos automáticos con Whisper' },
  { key:'downloadLinksEnabled',   label:'Links de descarga', desc:'Links firmados temporales' },
  { key:'watermarkEnabled',       label:'Watermark', desc:'Marca de agua CSS en el player' },
  { key:'analyticsEnabled',       label:'Analytics', desc:'Métricas de reproducción y geografía' },
  { key:'bulkOperationsEnabled',  label:'Bulk operations', desc:'Operaciones masivas sobre videos' },
  { key:'apiKeysEnabled',         label:'API Keys', desc:'Gestión de API keys del workspace' },
  { key:'tracksEnabled',          label:'Audio/Subtítulos', desc:'Gestión de pistas de audio y subtítulos' },
  { key:'invitationsEnabled',     label:'Invitaciones', desc:'Invitar miembros al workspace' },
  { key:'referralEnabled',        label:'Referidos', desc:'Programa de referidos con código' },
  { key:'adsEnabled',             label:'Sistema de Anuncios', desc:'VAST, Banner y Popup ads', type:'boolean' },
  { key:'adblockDetection',       label:'Detección de AdBlock', desc:'Mostrar aviso cuando el usuario usa AdBlocker', type:'boolean' },
  { key:'embedEnabled',           label:'Branding del Player', desc:'branded, unbranded o custom', type:'select', options:[
    {value:'branded', label:'Branded (con logo de plataforma)'},
    {value:'unbranded', label:'Unbranded (sin logo plataforma)'},
    {value:'custom', label:'Custom (dominio personalizado)'}
  ]},
  { key:'customDomainEnabled',    label:'Dominio personalizado embed', desc:'Player embebido desde dominio propio (solo Enterprise)' },
  { key:'multiWorkspaceEnabled',  label:'Multi-workspace', desc:'Crear múltiples workspaces por cuenta' },
];
// Estado de features jerárquicos
let _globalFeaturesState = {};
let _planFeaturesState = { starter: {}, pro: {}, enterprise: {} };
let _currentPlanTab = 'starter';

// Cargar features globales
async function loadFeaturesTab() {
  await loadGlobalFeatures();
  await loadPlanFeatures('starter');
  await loadPlanFeatures('pro');
  await loadPlanFeatures('enterprise');
}

// Cargar features globales desde el backend
async function loadGlobalFeatures() {
  try {
    const r = await api('/api/admin/features');
    const data = await r.json();
    
    _globalFeaturesState = data.features || data || {};
    
    // Renderizar toggles globales
    document.getElementById('global-features-toggles').innerHTML = FEATURE_DEFS.map(f => {
      const enabled = _globalFeaturesState[f.key] !== false;
      return `<label style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;cursor:pointer;user-select:none;gap:12px;">
        <div style="flex:1;">
          <div style="font-weight:600;font-size:13px;">${f.label}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">${f.desc}</div>
        </div>
        <input type="checkbox" id="global-${f.key}" style="width:20px;height:20px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;" ${enabled?'checked':''}>
      </label>`;
    }).join('');
  } catch (err) {
    console.error('Error loading global features:', err);
    toast('Error al cargar features globales', 'error');
  }
}

// Guardar features globales
async function saveGlobalFeatures() {
  try {
    const features = {};
    FEATURE_DEFS.forEach(f => {
      const checkbox = document.getElementById(`global-${f.key}`);
      features[f.key] = checkbox ? checkbox.checked : true;
    });
    
    const r = await api('/api/admin/features', {
      method: 'PUT',
      body: JSON.stringify(features)
    });
    
    if (r.ok) {
      toast('Features globales guardados correctamente');
      await loadGlobalFeatures();
    } else {
      const err = await r.json();
      toast(`Error: ${err.error || 'No se pudieron guardar los features'}`, 'error');
    }
  } catch (err) {
    console.error('Error saving global features:', err);
    toast('Error al guardar features globales', 'error');
  }
}

// Cargar features de un plan específico
async function loadPlanFeatures(planName) {
  try {
    const r = await api(`/api/admin/plans-config/${planName}`);
    const data = await r.json();
    
    _planFeaturesState[planName] = data.features || {};
    
    // Si es el plan actual, renderizar
    if (_currentPlanTab === planName) {
      renderPlanFeatures(planName);
    }
  } catch (err) {
    console.error(`Error loading features for plan ${planName}:`, err);
    toast(`Error al cargar features del plan ${planName}`, 'error');
  }
}

// Renderizar features de un plan
function renderPlanFeatures(planName) {
  const container = document.getElementById(`plan-${planName}-features`);
  if (!container) return;
  
  const planFeatures = _planFeaturesState[planName] || {};
  
  container.innerHTML = FEATURE_DEFS.map(f => {
    const value = planFeatures[f.key];
    const globalDisabled = _globalFeaturesState[f.key] === false;
    
    // Si es tipo SELECT (embedEnabled)
    if (f.type === 'select' && f.options) {
      const currentValue = value || f.options[0].value;
      return `<label class="feature-toggle-card" data-feature="${f.key}">
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <div style="font-weight:600;font-size:13px;">${f.label}</div>
          </div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;">${f.desc}</div>
        </div>
        <select id="plan-${planName}-${f.key}" style="background:var(--surface);border:1px solid var(--border2);border-radius:7px;color:var(--text);padding:7px 12px;font-size:12px;font-family:var(--sans);min-width:180px;">
          ${f.options.map(opt => `<option value="${opt.value}" ${currentValue===opt.value?'selected':''}>${opt.label}</option>`).join('')}
        </select>
      </label>`;
    }
    
    // Si es checkbox (boolean) - comportamiento normal
    let checked = value === true || value === 'full' || value === 'custom';
    
    return `<label class="feature-toggle-card ${globalDisabled ? 'feature-disabled' : ''} ${checked ? 'feature-active' : ''}" data-feature="${f.key}">
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <div style="font-weight:600;font-size:13px;color:${globalDisabled ? 'var(--muted)' : 'var(--text)'};">${f.label}</div>
          ${globalDisabled ? '<span style="font-size:9px;background:rgba(248,113,113,.15);color:var(--red);padding:2px 6px;border-radius:4px;font-weight:700;letter-spacing:.5px;">BLOQUEADO</span>' : ''}
        </div>
        <div style="font-size:11px;color:var(--muted);line-height:1.5;">${f.desc}</div>
        ${globalDisabled ? '<div style="font-size:10px;color:var(--red);margin-top:6px;display:flex;align-items:center;gap:4px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Activar primero en Configuración → Features</div>' : ''}
      </div>
      <div class="feature-toggle-switch">
        <input type="checkbox" id="plan-${planName}-${f.key}" ${checked?'checked':''} ${globalDisabled?'disabled':''}>
        <span class="feature-toggle-slider"></span>
      </div>
    </label>`;
  }).join('');
}

// Guardar features de un plan
async function savePlanFeatures(planName) {
  try {
    const features = {};
    FEATURE_DEFS.forEach(f => {
      const el = document.getElementById(`plan-${planName}-${f.key}`);
      if (!el || el.disabled) return;
      
      // Si es SELECT, guardar el valor seleccionado
      if (f.type === 'select') {
        features[f.key] = el.value;
      } else {
        // Si es checkbox, guardar checked
        features[f.key] = el.checked;
      }
    });
    
    const r = await api(`/api/admin/plans-config/${planName}`, {
      method: 'PUT',
      body: JSON.stringify({ features })
    });
    
    if (r.ok) {
      toast(`Features del plan ${planName} guardados correctamente`);
      await loadPlanFeatures(planName);
    } else {
      const err = await r.json();
      toast(`Error: ${err.error || 'No se pudieron guardar los features'}`, 'error');
    }
  } catch (err) {
    console.error(`Error saving features for plan ${planName}:`, err);
    toast(`Error al guardar features del plan ${planName}`, 'error');
  }
}

// Cambiar entre tabs de planes en features
function switchPlanFeaturesTab(planName) {
  ['starter', 'pro', 'enterprise'].forEach(p => {
    const tab = document.getElementById(`plan-feat-tab-${p}`);
    const content = document.getElementById(`plan-features-${p}`);
    if (tab && content) {
      if (p === planName) {
        tab.classList.add('active');
        content.style.display = 'block';
      } else {
        tab.classList.remove('active');
        content.style.display = 'none';
      }
    }
  });
  _currentPlanTab = planName;
  renderPlanFeatures(planName);
}

// Mantener compatibilidad con código antiguo
async function saveFeatures() {
  await saveGlobalFeatures();
}
async function testSettings() {
  const r = await fetch(`${BASE}/api/settings`);
  const d = await r.json();
  toast(`/api/settings: siteName="${d.siteName}", allowReg=${d.allowRegistration}, features=${Object.keys(d.features||{}).length} keys`);
}
/* ─── ROLE MANAGEMENT ────────────────────────────────────────── */
let _roleTarget = null;

function roleBadgeClass(role) {
  if (role === 'super_admin') return 'badge-admin';
  if (role === 'admin') return 'badge-pro';
  return 'badge-user';
}

function openRoleModal(id, name, email, currentRole) {
  _roleTarget = { id, name, email, currentRole };
  document.getElementById('role-user-name').textContent = name;
  document.getElementById('role-user-email').textContent = email;
  const badge = document.getElementById('role-current-badge');
  badge.textContent = currentRole;
  badge.className = `badge ${roleBadgeClass(currentRole)}`;
  const sel = document.getElementById('role-new-select');
  sel.value = currentRole;
  document.getElementById('role-reason').value = '';
  document.getElementById('role-error').style.display = 'none';
  document.getElementById('role-warn-superadmin').style.display = 'none';
  document.getElementById('role-warn-downgrade').style.display = 'none';
  // Update warnings on select change
  sel.onchange = () => updateRoleWarnings(currentRole, sel.value);
  openModal('role-modal');
  setTimeout(() => document.getElementById('role-new-select').focus(), 100);
}

function updateRoleWarnings(current, next) {
  const warnSuper = document.getElementById('role-warn-superadmin');
  const warnDown  = document.getElementById('role-warn-downgrade');
  warnSuper.style.display = next === 'super_admin' && current !== 'super_admin' ? 'block' : 'none';
  warnDown.style.display  = (current === 'super_admin' || current === 'admin') && next === 'user' ? 'block' : 'none';
}

async function confirmRoleChange() {
  if (!_roleTarget) return;
  const newRole = document.getElementById('role-new-select').value;
  const reason  = document.getElementById('role-reason').value.trim();
  const errEl   = document.getElementById('role-error');
  errEl.style.display = 'none';

  if (newRole === _roleTarget.currentRole) {
    errEl.textContent = 'El rol seleccionado es el mismo que el actual.';
    errEl.style.display = 'block';
    return;
  }

  const btn  = document.getElementById('btn-confirm-role');
  const text = document.getElementById('role-btn-text');
  btn.disabled = true;
  text.textContent = 'Cambiando...';

  try {
    const r = await api(`/api/admin/users/${_roleTarget.id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role: newRole, reason }),
    });
    const d = await r.json().catch(() => ({}));

    if (!r.ok) {
      errEl.textContent = d.error || 'Error al cambiar rol';
      errEl.style.display = 'block';
      return;
    }

    // Actualizar cache local para reflejar el cambio sin recargar
    const userIdx = _usrCache.findIndex(u => u.id === _roleTarget.id);
    if (userIdx !== -1) {
      _usrCache[userIdx].platform_role = newRole;
    }

    closeModal('role-modal');
    renderUsers();
    toast(`OK - Rol de ${_roleTarget.name || _roleTarget.email} cambiado a "${newRole}"`);

  } catch {
    errEl.textContent = 'Error de conexión';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    text.textContent = 'Cambiar Rol';
  }
}

/* ─── LIVE SSE METRICS ───────────────────────────────────────── */
let _liveEs = null;        // EventSource instance
let _liveConnected = false;
let _liveEventCount = 0;

async function loadLive() {
  if (!_liveConnected) startLiveStream();
  // Immediately fetch a snapshot so values populate without waiting for the SSE ticker
  try {
    const r = await api('/api/admin/metrics/snapshot');
    if (r.ok) { const d = await r.json(); updateLiveMetrics(d); }
  } catch {}
}

function setLiveStatus(connected) {
  _liveConnected = connected;
  const badge  = document.getElementById('live-status-badge');
  const navDot = document.getElementById('nav-live-dot');
  const btn    = document.getElementById('live-toggle-btn');

  // navDot siempre existe — se actualiza desde cualquier sección
  if (navDot) {
    navDot.style.background  = connected ? 'var(--green)' : 'var(--muted)';
    navDot.style.boxShadow   = connected ? '0 0 6px var(--green)' : 'none';
  }

  // badge y btn solo existen cuando el usuario está en la sección Live
  if (connected) {
    if (badge) {
      badge.style.background  = 'rgba(34,211,165,.12)';
      badge.style.borderColor = 'rgba(34,211,165,.3)';
      badge.style.color       = 'var(--green)';
      badge.innerHTML = `<span id="live-dot" style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:livePulse 1.5s infinite;"></span> LIVE`;
    }
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Desconectar`;

    if (!document.getElementById('live-pulse-style')) {
      const s = document.createElement('style');
      s.id = 'live-pulse-style';
      s.textContent = '@keyframes livePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}';
      document.head.appendChild(s);
    }
  } else {
    if (badge) {
      badge.style.background  = 'rgba(100,100,100,.15)';
      badge.style.borderColor = 'rgba(100,100,100,.3)';
      badge.style.color       = 'var(--muted)';
      badge.innerHTML = '<span id="live-dot" style="width:6px;height:6px;border-radius:50%;background:var(--muted);display:inline-block;"></span> DESCONECTADO';
    }
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg> Conectar`;
  }
}

async function startLiveStream() {
  if (_liveEs) { _liveEs.close(); _liveEs = null; }

  // Obtener token SSE de corta duración (2 min, one-time use) — no exponemos el JWT de sesión en la URL
  let sseToken;
  try {
    const r = await api('/api/admin/metrics/sse-token', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    sseToken = data.token;
    if (!sseToken) throw new Error('token vacío');
  } catch (err) {
    addLiveLog(`ERROR: No se pudo obtener el token SSE — ${err.message}`);
    return;
  }

  const url = `${BASE}/api/admin/metrics/stream?token=${encodeURIComponent(sseToken)}`;
  const es = new EventSource(url);
  _liveEs = es;

  es.onopen = () => {
    setLiveStatus(true);
    addLiveLog('OK - Conexión SSE establecida');
  };

  es.addEventListener('metrics', (e) => {
    try {
      const data = JSON.parse(e.data);
      updateLiveMetrics(data);
      _liveEventCount++;
      const now = new Date().toLocaleTimeString('es-CO');
      document.getElementById('live-last-update').textContent = `Actualizado: ${now}`;
      addLiveLog(`[${now}] metrics — videos:${data.videos?.total??'?'} users:${data.users?.total??'?'} queue:${data.queue?.waiting??'?'} mem:${data.system?.memUsedMB??'?'}MB`);
    } catch {}
  });

  es.addEventListener('upload_change', (e) => {
    try {
      const d = JSON.parse(e.data);
      document.getElementById('live-uploads').textContent = d.activeUploads ?? '0';
      addLiveLog(`Upload change: ${d.activeUploads} activos`);
    } catch {}
  });

  es.onerror = () => {
    setLiveStatus(false);
    addLiveLog('AVISO: Conexión perdida. Reconectando…');
    _liveEs = null;
    // Auto-reconexión del browser (EventSource hace retry automático)
  };
}

function stopLiveStream() {
  if (_liveEs) { _liveEs.close(); _liveEs = null; }
  setLiveStatus(false);
  addLiveLog('Stream desconectado manualmente');
}

function toggleLiveStream() {
  if (_liveConnected || _liveEs) {
    stopLiveStream();
  } else {
    startLiveStream();
  }
}

function updateLiveMetrics(d) {
  const v = d.videos || {};
  const u = d.users || {};
  const q = d.queue || {};
  const s = d.system || {};

  // Stats grid
  if (document.getElementById('live-videos')) {
    document.getElementById('live-videos').textContent    = (v.total||0).toLocaleString('es');
    document.getElementById('live-videos-sub').textContent = `${(v.ready||0).toLocaleString('es')} listos · ${v.processing||0} procesando`;
    document.getElementById('live-users').textContent      = (u.total||0).toLocaleString('es');
    document.getElementById('live-queue-waiting').textContent = q.waiting ?? '0';
    document.getElementById('live-queue-sub').textContent  = `${q.active||0} activos`;
    document.getElementById('live-uploads').textContent    = s.activeUploads ?? '0';
  }

  // System card
  document.getElementById('live-uptime').textContent    = s.uptime || '—';
  document.getElementById('live-mem-used').textContent  = s.memUsedMB ? `${s.memUsedMB} MB` : '—';
  document.getElementById('live-mem-total').textContent = s.memTotalMB ? `${s.memTotalMB} MB` : '—';
  document.getElementById('live-rss').textContent       = s.rss ? `${s.rss} MB` : '—';

  // Memory bar
  if (s.memUsedMB && s.memTotalMB) {
    const memPct = Math.min(100, Math.round(s.memUsedMB / s.memTotalMB * 100));
    const memBar = document.getElementById('live-mem-bar');
    if (memBar) {
      memBar.style.width = `${memPct}%`;
      memBar.style.background = memPct > 85 ? 'var(--red)' : memPct > 65 ? '#fbbf24' : 'var(--accent)';
    }
    const memPctEl = document.getElementById('live-mem-pct');
    if (memPctEl) memPctEl.textContent = `${s.memUsedMB} / ${s.memTotalMB} MB · ${memPct}%`;
  }
  document.getElementById('live-sse-conns').textContent = s.activeConnections ?? '—';
  document.getElementById('live-timestamp').textContent = s.timestamp ? new Date(s.timestamp).toLocaleTimeString('es-CO') : '—';

  // Queue card
  document.getElementById('live-q-waiting').textContent   = q.waiting ?? '—';
  document.getElementById('live-q-active').textContent    = q.active ?? '—';
  document.getElementById('live-q-failed').textContent    = q.failed ?? '—';
  document.getElementById('live-q-completed').textContent = q.completed ?? '—';
  document.getElementById('live-q-mode').textContent      = q.mode || '—';

  // Queue utilization bar
  const maxCapacity = 20; // Estimado
  const used = (q.waiting||0) + (q.active||0);
  const pct = Math.min(100, Math.round(used / maxCapacity * 100));
  const bar = document.getElementById('live-queue-bar');
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--accent)';
  }
  const pctEl = document.getElementById('live-queue-pct');
  if (pctEl) pctEl.textContent = used > 0 ? `${used} jobs en sistema (${pct}% capacidad estimada)` : 'Cola vacía';
}

function addLiveLog(msg) {
  const log = document.getElementById('live-log');
  const empty = document.getElementById('live-log-empty');
  if (!log) return;
  if (empty) empty.style.display = 'none';
  const line = document.createElement('div');
  line.textContent = msg;
  if (/^ERROR/i.test(msg)) {
    line.style.color = 'var(--red)';
  } else if (/^AVISO/i.test(msg)) {
    line.style.color = '#fbbf24';
  } else if (/^OK\b/.test(msg)) {
    line.style.color = 'var(--green)';
  } else if (/upload/i.test(msg)) {
    line.style.color = '#60a5fa';
  } else if (/\bmetrics\b/.test(msg)) {
    line.style.color = 'var(--text)';
  }
  log.appendChild(line);
  while (log.childElementCount > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// Auto-desconectar cuando se sale de la sección
window.addEventListener('beforeunload', () => { if (_liveEs) _liveEs.close(); });

/* ─── MODAL & TOAST ──────────────────────────────────────────── */
function openModal(id){ document.getElementById(id).classList.add('visible'); }
function closeModal(id){ document.getElementById(id).classList.remove('visible'); }
function toast(msg, type = 'success', duration) {
  const typeMap = { success: 'success', error: 'error', warn: 'warning', warning: 'warning', info: 'info' };
  const svType = typeMap[type] || 'success';
  if (typeof window.svToast === 'function') {
    window.svToast(msg, svType, duration);
  } else {
    // Fallback al toast del theme si svToast no está disponible aún
    const el = document.getElementById('toast');
    if (el) { el.textContent = msg; el.className = `toast ${type} show`; clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3200); }
  }
}
function confirmModal(msg, okLabel = 'Confirmar', title = 'Confirmar acción', danger = false) {
  return new Promise(resolve => {
    const overlay = document.getElementById('admin-confirm-modal');
    document.getElementById('admin-confirm-title').textContent = title;
    document.getElementById('admin-confirm-msg').textContent = msg;
    const okBtn = document.getElementById('admin-confirm-ok');
    const cancelBtn = document.getElementById('admin-confirm-cancel');
    const xBtn = document.getElementById('admin-confirm-x');
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    overlay.classList.add('visible');
    const close = (val) => {
      overlay.classList.remove('visible');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      xBtn.removeEventListener('click', onCancel);
      resolve(val);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    xBtn.addEventListener('click', onCancel);
  });
}
/* ─── PLANES & LÍMITES ───────────────────────────────────────── */

// Definición de features editables por plan
const PLAN_FEATURES = [
  { key: 'folders',         label: 'Carpetas',                      type: 'bool', globalKey: 'foldersEnabled' },
  { key: 'playlists',       label: 'Playlists',                     type: 'bool', globalKey: 'playlistsEnabled' },
  { key: 'webhooks',        label: 'Webhooks (HMAC)',               type: 'bool', globalKey: 'webhooksEnabled' },
  { key: 'transcriptions',  label: 'Transcripciones IA',            type: 'bool', globalKey: 'transcriptionsEnabled' },
  { key: 'downloadLinks',   label: 'Links de descarga',             type: 'bool', globalKey: 'downloadLinksEnabled' },
  { key: 'watermark',       label: 'Watermark',                     type: 'bool', globalKey: 'watermarkEnabled' },
  { key: 'analytics',       label: 'Analytics',                     type: 'select', options: ['basic','full'], globalKey: 'analyticsEnabled' },
  { key: 'bulkOperations',  label: 'Operaciones masivas',           type: 'bool', globalKey: 'bulkOperationsEnabled' },
  { key: 'apiKeys',         label: 'API Keys',                      type: 'bool', globalKey: 'apiKeysEnabled' },
  { key: 'tracks',          label: 'Audio/Subtítulos (pistas)',     type: 'bool', globalKey: 'tracksEnabled' },
  { key: 'invitations',     label: 'Invitar miembros',              type: 'bool', globalKey: 'invitationsEnabled' },
  { key: 'referrals',       label: 'Programa de referidos',         type: 'bool', globalKey: 'referralEnabled' },
  { key: 'embed',           label: 'Player embed',                  type: 'select', options: ['branded','unbranded','custom'] },
  { key: 'ads',             label: 'Sistema de Anuncios',           type: 'bool' },
  { key: 'subtitleTracks',  label: 'Pistas de Subtítulos IA',       type: 'bool' },
  { key: 'multiAudio',      label: 'Múltiples pistas de audio',     type: 'bool' },
  { key: 'multiWorkspace',  label: 'Múltiples espacios de trabajo', type: 'bool' },
  { key: 'customDomain',   label: 'Dominio personalizado embed',   type: 'bool' },
];

let _plansData = null; // Datos cargados de /api/plans

function switchPlanTab(tab) {
  // Tabs disponibles: starter, pro, enterprise, guest
  ['starter','pro','enterprise','guest'].forEach(t => {
    const sec = document.getElementById(`plan-section-${t}`);
    const btn = document.getElementById(`plan-tab-${t}`);
    if (sec) sec.style.display = t === tab ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  
  // Actualizar preview cuando se selecciona guest
  if (tab === 'guest') updateGuestPreview();
}

async function loadPlansConfig() {
  try {
    // Cargar planes desde la API pública (incluye guest config)
    const r = await fetch('/api/plans');
    if (!r.ok) throw new Error('fetch failed');
    const plans = await r.json();
    _plansData = plans;

    // Llenar formulario de cada plan
    fillPlanForm('s', plans.starter || {});
    fillPlanForm('p', plans.pro     || {});
    fillPlanForm('e', plans.enterprise || {});

    // Llenar formulario guest
    const g = plans.guest || {};
    const enabledEl = document.getElementById('guest-enabled');
    const filesizeEl = document.getElementById('guest-filesize');
    const expiryEl  = document.getElementById('guest-expiry');
    const maxvEl    = document.getElementById('guest-maxvideos');
    if (enabledEl)  enabledEl.value  = (g.enabled !== false) ? 'true' : 'false';
    if (filesizeEl) filesizeEl.value = g.maxFileSizeMB ?? 2048;
    if (expiryEl)   expiryEl.value   = g.expiryHours    ?? 24;
    if (maxvEl)     maxvEl.value     = g.maxVideos       ?? 3;

    // Stats guest (intentar cargar desde admin stats)
    loadGuestStats();
    updateGuestPreview();
    // No mostrar toast en carga automática — solo en actualización manual
  } catch (e) {
    toast('Error al cargar planes: ' + e.message, 'error');
  }
}

function fillPlanForm(prefix, plan) {
  const f = plan.features || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; };

  set(`plan-${prefix}-name`,       plan.name        ?? '');
  set(`plan-${prefix}-price`,      plan.price       ?? 0);
  set(`plan-${prefix}-desc`,       plan.description ?? '');
  set(`plan-${prefix}-badge`,      plan.badge       ?? '');
  set(`plan-${prefix}-videos`,     plan.maxVideos   ?? '');
  set(`plan-${prefix}-storage`,    plan.maxStorageGB   ?? '');
  set(`plan-${prefix}-bw`,         plan.maxBandwidthGB ?? '');
  set(`plan-${prefix}-filesize`,   plan.maxFileSizeMB  ?? '');
  set(`plan-${prefix}-workspaces`, plan.maxWorkspaces  ?? 1);
  set(`plan-${prefix}-members`,    plan.maxMembers     ?? 1);

  // Renderizar checkboxes/selects de features
  const container = document.getElementById(`plan-${prefix}-features`);
  if (!container) return;
  container.innerHTML = PLAN_FEATURES.map(ft => {
    if (ft.type === 'bool') {
      // Checkbox para features booleanos (true/false)
      const val = f[ft.key] ?? false;
      return `<label style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:11px 14px;cursor:pointer;user-select:none;gap:10px;">
        <div>
          <div style="font-size:13px;font-weight:600;">${ft.label}</div>
        </div>
        <input type="checkbox" data-feat="${ft.key}" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;" ${val ? 'checked' : ''}>
      </label>`;
    } else {
      // Select para features con opciones múltiples (analytics: basic/full, embed: branded/unbranded/custom)
      const cur = f[ft.key] ?? ft.options[0];
      return `<label style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;padding:11px 14px;gap:10px;">
        <div style="font-size:13px;font-weight:600;">${ft.label}</div>
        <select data-feat="${ft.key}" style="background:var(--surface);border:1px solid var(--border2);border-radius:7px;color:var(--text);padding:5px 10px;font-size:12px;font-family:var(--sans);">
          ${ft.options.map(o => `<option value="${o}" ${cur===o?'selected':''}>${o}</option>`).join('')}
        </select>
      </label>`;
    }
  }).join('');
}

function readPlanForm(prefix) {
  const g = (id) => document.getElementById(id)?.value?.trim() ?? '';
  const n = (id, def = 0) => { const v = parseInt(document.getElementById(id)?.value ?? ''); return isNaN(v) ? def : v; };

  // Read features from container
  const container = document.getElementById(`plan-${prefix}-features`);
  const features = {};
  if (container) {
    container.querySelectorAll('[data-feat]').forEach(el => {
      const key = el.dataset.feat;
      features[key] = el.type === 'checkbox' ? el.checked : el.value;
    });
  }

  return {
    name:           g(`plan-${prefix}-name`)  || undefined,
    description:    g(`plan-${prefix}-desc`)  || '',
    price:          n(`plan-${prefix}-price`, 0),
    badge:          g(`plan-${prefix}-badge`) || null,
    maxVideos:      n(`plan-${prefix}-videos`, -1),
    maxStorageGB:   n(`plan-${prefix}-storage`, -1),
    maxBandwidthGB: n(`plan-${prefix}-bw`, -1),
    maxFileSizeMB:  n(`plan-${prefix}-filesize`, 10240),
    maxWorkspaces:  n(`plan-${prefix}-workspaces`, 1),
    maxMembers:     n(`plan-${prefix}-members`, 1),
    features,
  };
}

async function savePlansConfig() {
  const btn = document.querySelector('#s-plans .page-title-row .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    const plans = {
      starter:    readPlanForm('s'),
      pro:        readPlanForm('p'),
      enterprise: readPlanForm('e'),
    };

    const guestEnabled  = document.getElementById('guest-enabled')?.value === 'true';
    const guestFilesize = parseInt(document.getElementById('guest-filesize')?.value || '2048');
    const guestExpiry   = parseInt(document.getElementById('guest-expiry')?.value   || '24');
    const guestMaxV     = parseInt(document.getElementById('guest-maxvideos')?.value || '3');

    const guestConfig = {
      enabled:      guestEnabled,
      maxFileSizeMB: isNaN(guestFilesize) ? 2048 : guestFilesize,
      expiryHours:  isNaN(guestExpiry)   ? 24   : guestExpiry,
      maxVideos:    isNaN(guestMaxV)     ? 3    : guestMaxV,
    };

    // Guardar planes
    const r1 = await api('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({ section: 'plans', data: plans }),
    });

    // Guardar config guest
    const r2 = await api('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({ section: 'guest_config', data: guestConfig }),
    });

    if (r1.ok && r2.ok) {
      toast('Planes y configuración guest guardados');
      updateGuestPreview();
    } else {
      const d1 = r1.ok ? {} : await r1.json().catch(() => ({}));
      const d2 = r2.ok ? {} : await r2.json().catch(() => ({}));
      toast((d1.error || d2.error || 'Error al guardar'), 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar todo'; }
  }
}

function updateGuestPreview() {
  const mb   = parseInt(document.getElementById('guest-filesize')?.value) || 2048;
  const h    = parseInt(document.getElementById('guest-expiry')?.value)   || 24;
  const maxv = parseInt(document.getElementById('guest-maxvideos')?.value) || 3;

  const sizeLabel  = mb >= 1024 ? `${(mb/1024).toFixed(mb%1024===0?0:1)} GB` : `${mb} MB`;
  const expiryLabel = h >= 24 ? `${h/24} día${h/24!==1?'s':''}` : `${h} hora${h!==1?'s':''}`;

  const sEl = document.getElementById('g-prev-size');
  const eEl = document.getElementById('g-prev-expiry');
  const vEl = document.getElementById('g-prev-videos');
  if (sEl) sEl.textContent = sizeLabel;
  if (eEl) eEl.textContent = expiryLabel;
  if (vEl) vEl.textContent = maxv > 0 ? `${maxv} video${maxv!==1?'s':''}` : 'Ilimitados';
}

async function loadGuestStats() {
  try {
    // Videos guest pendientes (sin workspace asignado)
    const r = await api('/api/admin/stats');
    if (r.ok) {
      const s = await r.json();
      const pendingEl = document.getElementById('guest-stat-pending');
      if (pendingEl) pendingEl.textContent = s.guestVideos ?? '—';
    }
  } catch { /* silencioso */ }
  // Valores placeholder para los otros stats
  const expEl = document.getElementById('guest-stat-expired');
  const clEl  = document.getElementById('guest-stat-claimed');
  if (expEl) expEl.textContent = '—';
  if (clEl)  clEl.textContent  = '—';
}

// Actualizar preview en tiempo real cuando se cambian los inputs guest
document.addEventListener('DOMContentLoaded', () => {
  ['guest-filesize','guest-expiry','guest-maxvideos'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateGuestPreview);
  });
});

/* ─── PAYMENT GATEWAYS ──────────────────────────────────────── */
// Module-level gateway config state (avoids reading .checked from spans)
let _gwConfig = {};
let _gwStatus = {};

// SVG icons for credential checklist rows
const _gwCheckOk  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
const _gwCheckErr = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function _gwCredRow(ok, label) {
  return `<div class="gw-cred-row">
    <div class="gw-cred-icon ${ok ? 'gw-cred-ok' : 'gw-cred-err'}">${ok ? _gwCheckOk : _gwCheckErr}</div>
    <span class="label">${label}</span>
  </div>`;
}

async function loadGateways() {
  try {
    const [configR, statusR] = await Promise.all([
      api('/api/admin/payment-gateways'),
      api('/api/admin/payment-gateways/status')
    ]);

    const { gateways } = await configR.json();
    const { status } = await statusR.json();
    _gwConfig = gateways || {};
    _gwStatus = status || {};

    const providers = ['stripe', 'paypal', 'binance', 'dlocalgo'];
    const activeCount = providers.filter(p => _gwConfig[p]?.enabled).length;
    const defaultGw = providers.find(p => _gwConfig[p]?.default) || '—';

    // Stat cards
    const activeEl = document.getElementById('gw-active');
    if (activeEl) activeEl.textContent = activeCount;
    const totalSubEl = document.getElementById('gw-total-sub');
    if (totalSubEl) totalSubEl.textContent = `de ${providers.length} disponibles`;
    const defaultEl = document.getElementById('gw-default');
    if (defaultEl) defaultEl.textContent = defaultGw === '—' ? '—' : defaultGw.charAt(0).toUpperCase() + defaultGw.slice(1);

    // Per-gateway card update
    providers.forEach(p => {
      const enabled   = _gwConfig[p]?.enabled  ?? false;
      const isDefault = _gwConfig[p]?.default   ?? false;
      const pStatus   = status[p] || {};

      // Toggle checkbox
      const toggle = document.getElementById(`gw-${p}-toggle`);
      if (toggle) toggle.checked = enabled;

      // "Principal" pill
      const pill = document.getElementById(`gw-${p}-default-pill`);
      if (pill) pill.style.display = isDefault ? '' : 'none';

      // Status label
      const label = document.getElementById(`gw-${p}-status-label`);
      if (label) label.textContent = enabled ? 'Activo' : 'Inactivo';

      // Card classes
      const card = document.getElementById(`gw-${p}-card`);
      if (card) {
        card.classList.toggle('gw-active', enabled);
        card.classList.toggle('gw-default-card', isDefault);
      }

      // "Set default" button — hide if already default or disabled
      const setDefBtn = document.getElementById(`gw-${p}-set-default`);
      if (setDefBtn) setDefBtn.style.display = (isDefault || !enabled) ? 'none' : '';

      // Credential checklist
      updateGatewayStatus(p, pStatus);
    });

    // Webhook table
    renderGatewayWebhooks(providers, status);

  } catch(e) {
    toast('Error al cargar gateways: ' + e.message, 'error');
  }
}

function renderGatewayWebhooks(providers, status) {
  const tbody = document.getElementById('gw-webhooks-tbody');
  if (!tbody) return;
  // 'live' = Stripe/PayPal/Binance, 'production' = dLocal Go
  const modeLabel = m => (m === 'live' || m === 'production')
    ? `<span class="gw-mode-badge gw-mode-live">Live / Prod</span>`
    : `<span class="gw-mode-badge gw-mode-sandbox">Sandbox</span>`;
  const rows = providers.map(p => {
    const s = status[p] || {};
    const name = p.charAt(0).toUpperCase() + p.slice(1);
    // dLocal Go: webhook uses API key + secret (no separate webhook secret needed)
    const webhookOk = s.hasWebhookSecret || s.hasWebhookId || (p === 'dlocalgo' && s.configured);
    const pricesOk  = s.hasPriceIds || s.hasPlanIds || s.hasPrices;
    return `<tr>
      <td style="font-weight:600;">${name}</td>
      <td>${s.configured
        ? `<span style="color:${webhookOk ? 'var(--green)' : '#fbbf24'};font-size:12px;">${webhookOk ? '✓ Configurado' : '⚠ Sin secret'}</span>`
        : `<span style="color:var(--muted);font-size:12px;">—</span>`}</td>
      <td>${s.configured
        ? `<span style="color:${pricesOk ? 'var(--green)' : '#fbbf24'};font-size:12px;">${pricesOk ? '✓ OK' : '⚠ Faltan IDs'}</span>`
        : `<span style="color:var(--muted);font-size:12px;">—</span>`}</td>
      <td>${s.configured && s.mode ? modeLabel(s.mode) : '<span style="color:var(--muted);font-size:12px;">—</span>'}</td>
      <td>${s.configured
        ? `<span style="color:var(--green);font-size:12px;">Conectado</span>`
        : `<span style="color:var(--muted);font-size:12px;">No configurado</span>`}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="editGateway('${p}')">Configurar</button></td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

function updateGatewayStatus(provider, status) {
  const credsEl = document.getElementById(`gw-${provider}-creds`);
  if (!credsEl) return;

  const checksets = {
    stripe: [
      { ok: status.configured,      label: 'API Key' },
      { ok: status.hasWebhookSecret, label: 'Webhook Secret' },
      { ok: status.hasPriceIds,      label: 'Price IDs' },
    ],
    paypal: [
      { ok: status.configured,    label: 'Client ID / Secret' },
      { ok: status.hasWebhookId,  label: 'Webhook ID' },
      { ok: status.hasPlanIds,    label: 'Plan IDs' },
    ],
    binance: [
      { ok: status.configured, label: 'API Key / Secret' },
      { ok: status.hasPrices,  label: 'Precios configurados' },
    ],
    dlocalgo: [
      { ok: status.configured,  label: 'API Key / Secret Key' },
      { ok: status.hasPlanIds,  label: 'Plan tokens (Starter / Pro / Enterprise)' },
    ],
  };

  const checks = checksets[provider] || [];
  credsEl.innerHTML = checks.map(c => _gwCredRow(c.ok, c.label)).join('');

  // Append mode badge for gateways that have one
  // dLocal Go uses 'production', Stripe/PayPal/Binance use 'live'
  if (status.mode && (provider === 'paypal' || provider === 'binance' || provider === 'dlocalgo')) {
    const isLive = status.mode === 'live' || status.mode === 'production';
    const modeCls = isLive ? 'gw-mode-live' : 'gw-mode-sandbox';
    const modeLabel = isLive ? (status.mode === 'production' ? 'Production' : 'Live') : 'Sandbox';
    credsEl.insertAdjacentHTML('beforeend',
      `<span class="gw-mode-badge ${modeCls}" style="margin-top:6px;">${modeLabel}</span>`);
  }
}

async function saveGateways() {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    const providers = ['stripe', 'paypal', 'binance', 'dlocalgo'];
    if (!providers.some(p => _gwConfig[p]?.enabled)) {
      toast('Al menos un gateway debe estar habilitado', 'error');
      return;
    }
    const r = await api('/api/admin/payment-gateways', {
      method: 'PUT',
      body: JSON.stringify(_gwConfig)
    });
    if (r.ok) {
      toast('Configuración de gateways guardada');
      loadGateways();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Error al guardar', 'error');
    }
  } catch(e) {
    toast('Error de conexión', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar configuración'; }
  }
}

async function toggleGateway(provider, checked) {
  const next = checked;

  // At least one gateway must stay enabled
  const providers = ['stripe', 'paypal', 'binance', 'dlocalgo'];
  const wouldHaveNone = providers.every(p => (p === provider ? !next : !_gwConfig[p]?.enabled));
  if (wouldHaveNone) {
    // Revert the checkbox visually
    const toggle = document.getElementById(`gw-${provider}-toggle`);
    if (toggle) toggle.checked = !next;
    toast('Al menos un gateway debe estar habilitado', 'error');
    return;
  }

  _gwConfig[provider] = { ..._gwConfig[provider], enabled: next };
  await saveGatewaysQuiet();
  toast(`Gateway ${provider} ${next ? 'activado' : 'desactivado'}`);
  loadGateways();
}

async function setDefaultGateway(provider) {
  if (!_gwConfig[provider]?.enabled) {
    toast('Primero activa este gateway', 'error');
    return;
  }

  // Clear default on all, set on selected
  ['stripe', 'paypal', 'binance', 'dlocalgo'].forEach(p => {
    _gwConfig[p] = { ..._gwConfig[p], default: p === provider };
  });

  try {
    const r = await api('/api/admin/payment-gateways', {
      method: 'PUT',
      body: JSON.stringify(_gwConfig)
    });
    if (r.ok) {
      toast(`${provider.charAt(0).toUpperCase() + provider.slice(1)} establecido como gateway principal`);
      loadGateways();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Error al establecer gateway principal', 'error');
    }
  } catch {
    toast('Error de conexión', 'error');
  }
}

function editGateway(provider) {
  // Each var has a `statusKey` that maps to a boolean in _gwStatus[provider]
  const configs = {
    stripe: {
      title: 'Stripe',
      vars: [
        { name: 'STRIPE_SECRET_KEY',       hint: 'Empieza con sk_live_ o sk_test_',          statusKey: 'configured' },
        { name: 'STRIPE_WEBHOOK_SECRET',   hint: 'whsec_… desde Stripe Dashboard › Webhooks', statusKey: 'hasWebhookSecret' },
        { name: 'STRIPE_PRICE_STARTER',    hint: 'price_… plan Starter mensual',              statusKey: 'hasPriceIds' },
        { name: 'STRIPE_PRICE_PRO',        hint: 'price_… plan Pro mensual',                  statusKey: 'hasPriceIds' },
        { name: 'STRIPE_PRICE_ENTERPRISE', hint: 'price_… plan Enterprise mensual',           statusKey: 'hasPriceIds' },
      ],
    },
    paypal: {
      title: 'PayPal',
      vars: [
        { name: 'PAYPAL_CLIENT_ID',       hint: 'App Client ID desde developer.paypal.com',  statusKey: 'configured' },
        { name: 'PAYPAL_CLIENT_SECRET',   hint: 'App Client Secret',                          statusKey: 'configured' },
        { name: 'PAYPAL_WEBHOOK_ID',      hint: 'ID del webhook en PayPal Developer',         statusKey: 'hasWebhookId' },
        { name: 'PAYPAL_PLAN_STARTER',    hint: 'P-… plan de suscripción Starter',            statusKey: 'hasPlanIds' },
        { name: 'PAYPAL_PLAN_PRO',        hint: 'P-… plan de suscripción Pro',                statusKey: 'hasPlanIds' },
        { name: 'PAYPAL_PLAN_ENTERPRISE', hint: 'P-… plan de suscripción Enterprise',         statusKey: 'hasPlanIds' },
        { name: 'PAYPAL_MODE',            hint: 'sandbox o live  (default: sandbox)',          statusKey: 'configured' },
      ],
    },
    binance: {
      title: 'Binance Pay',
      vars: [
        { name: 'BINANCE_API_KEY',          hint: 'API key del portal Binance Pay',           statusKey: 'configured' },
        { name: 'BINANCE_SECRET_KEY',       hint: 'API secret correspondiente',               statusKey: 'configured' },
        { name: 'BINANCE_MERCHANT_ID',      hint: 'Merchant ID de tu cuenta',                 statusKey: 'configured' },
        { name: 'BINANCE_PRICE_STARTER',    hint: 'Precio en USD plan Starter',               statusKey: 'hasPrices' },
        { name: 'BINANCE_PRICE_PRO',        hint: 'Precio en USD plan Pro',                   statusKey: 'hasPrices' },
        { name: 'BINANCE_PRICE_ENTERPRISE', hint: 'Precio en USD plan Enterprise',            statusKey: 'hasPrices' },
        { name: 'BINANCE_MODE',             hint: 'sandbox o live  (default: sandbox)',        statusKey: 'configured' },
      ],
    },
    dlocalgo: {
      title: 'dLocal Go',
      vars: [
        { name: 'DLOCALGO_API_KEY',            hint: 'Dashboard → Integrations → API Integration',        statusKey: 'configured' },
        { name: 'DLOCALGO_SECRET_KEY',         hint: 'Secret key correspondiente al API key',              statusKey: 'configured' },
        { name: 'DLOCALGO_PLAN_STARTER',       hint: 'Token del plan Starter (Dashboard → Subscriptions)', statusKey: 'hasPlanIds' },
        { name: 'DLOCALGO_PLAN_PRO',           hint: 'Token del plan Pro',                                 statusKey: 'hasPlanIds' },
        { name: 'DLOCALGO_PLAN_ENTERPRISE',    hint: 'Token del plan Enterprise',                          statusKey: 'hasPlanIds' },
        { name: 'DLOCALGO_MODE',               hint: 'sandbox o production  (default: sandbox)',            statusKey: 'configured' },
      ],
    },
  };

  const cfg = configs[provider];
  if (!cfg) return toast('Gateway no reconocido', 'error');

  const pStatus = _gwStatus[provider] || {};

  const titleEl = document.getElementById('gw-config-modal-title');
  if (titleEl) titleEl.textContent = `Configurar ${cfg.title}`;

  const listEl = document.getElementById('gw-config-env-list');
  if (listEl) {
    // Load existing masked credentials to show current state
    api(`/api/admin/payment-gateways/credentials/${provider}`).then(r => r.json()).then(data => {
      const maskedCreds = data.credentials || {};
      const rows = cfg.vars.map(v => {
        const ok = !!pStatus[v.statusKey];
        const currentVal = maskedCreds[v.name] || '';
        const isMode = v.name.endsWith('_MODE');
        if (isMode) {
          // Mode field: render as toggle between sandbox/production or sandbox/live
          const modeOptions = v.name === 'DLOCALGO_MODE'
            ? [{val:'sandbox',label:'Sandbox'},{val:'production',label:'Production'}]
            : [{val:'sandbox',label:'Sandbox'},{val:'live',label:'Live'}];
          const currentMode = currentVal ? currentVal.replace(/[^a-z]/g,'') : '';
          return `<div class="gw-env-row" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="gw-env-status ${ok ? 'ok' : 'missing'}"></span>
              <span class="gw-env-name" style="font-weight:600;font-size:12px;">${esc(v.name)}</span>
              ${currentMode ? `<span style="font-size:10px;color:var(--muted);">(${esc(currentMode)})</span>` : ''}
            </div>
            <select id="gw-cred-${v.name}" style="font-size:12px;padding:6px 10px;width:100%;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);">
              <option value="">-- Sin cambios --</option>
              ${modeOptions.map(o => `<option value="${o.val}">${o.label}</option>`).join('')}
            </select>
          </div>`;
        }
        return `<div class="gw-env-row" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="gw-env-status ${ok ? 'ok' : 'missing'}"></span>
            <span class="gw-env-name" style="font-weight:600;font-size:12px;">${esc(v.name)}</span>
            ${currentVal ? `<span style="font-size:10px;color:var(--muted);">(${esc(currentVal)})</span>` : ''}
          </div>
          <input type="text" id="gw-cred-${v.name}" class="input" 
            placeholder="${esc(v.hint)}" 
            style="font-size:12px;padding:6px 10px;width:100%;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);"
            autocomplete="off" spellcheck="false">
        </div>`;
      });
      listEl.innerHTML = rows.join('') + `
        <div style="margin-top:16px;display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="saveGatewayCredentials('${provider}')">Guardar credenciales</button>
          <span id="gw-save-status" style="font-size:12px;color:var(--muted);align-self:center;"></span>
        </div>
        <p style="font-size:11px;color:var(--muted);margin-top:8px;">
          Los cambios tienen efecto inmediato. Deja en blanco los campos que ya estan configurados via .env para mantener ese valor.
        </p>`;
    }).catch(() => {
      // Fallback: show editable form without masked values
      const rows = cfg.vars.map(v => {
        const ok = !!pStatus[v.statusKey];
        const isMode = v.name.endsWith('_MODE');
        if (isMode) {
          const modeOptions = v.name === 'DLOCALGO_MODE'
            ? [{val:'sandbox',label:'Sandbox'},{val:'production',label:'Production'}]
            : [{val:'sandbox',label:'Sandbox'},{val:'live',label:'Live'}];
          return `<div class="gw-env-row" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="gw-env-status ${ok ? 'ok' : 'missing'}"></span>
              <span class="gw-env-name" style="font-weight:600;font-size:12px;">${esc(v.name)}</span>
            </div>
            <select id="gw-cred-${v.name}" style="font-size:12px;padding:6px 10px;width:100%;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);">
              <option value="">-- Sin cambios --</option>
              ${modeOptions.map(o => `<option value="${o.val}">${o.label}</option>`).join('')}
            </select>
          </div>`;
        }
        return `<div class="gw-env-row" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="gw-env-status ${ok ? 'ok' : 'missing'}"></span>
            <span class="gw-env-name" style="font-weight:600;font-size:12px;">${esc(v.name)}</span>
          </div>
          <input type="text" id="gw-cred-${v.name}" class="input" 
            placeholder="${esc(v.hint)}" 
            style="font-size:12px;padding:6px 10px;width:100%;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;color:var(--text);"
            autocomplete="off" spellcheck="false">
        </div>`;
      });
      listEl.innerHTML = rows.join('') + `
        <div style="margin-top:16px;">
          <button class="btn btn-primary btn-sm" onclick="saveGatewayCredentials('${provider}')">Guardar credenciales</button>
        </div>`;
    });
  }

  // Summary count
  const countEl = document.getElementById('gw-config-count');
  if (countEl) {
    const configured = cfg.vars.filter(v => !!pStatus[v.statusKey]).length;
    const total = cfg.vars.length;
    countEl.textContent = `${configured} / ${total}`;
    countEl.style.color = configured === total ? 'var(--green)' : configured > 0 ? '#fbbf24' : 'var(--red)';
  }

  openModal('gw-config-modal');
}

/**
 * Save gateway credentials from the modal form inputs to the DB via admin API.
 * Only non-empty fields are saved (empty = keep using .env value).
 */
async function saveGatewayCredentials(provider) {
  const configs = {
    stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_ENTERPRISE'],
    paypal: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'PAYPAL_PLAN_STARTER', 'PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_ENTERPRISE', 'PAYPAL_MODE'],
    binance: ['BINANCE_API_KEY', 'BINANCE_SECRET_KEY', 'BINANCE_MERCHANT_ID', 'BINANCE_PRICE_STARTER', 'BINANCE_PRICE_PRO', 'BINANCE_PRICE_ENTERPRISE', 'BINANCE_MODE'],
    dlocalgo: ['DLOCALGO_API_KEY', 'DLOCALGO_SECRET_KEY', 'DLOCALGO_PLAN_STARTER', 'DLOCALGO_PLAN_PRO', 'DLOCALGO_PLAN_ENTERPRISE', 'DLOCALGO_MODE'],
  };

  const keys = configs[provider];
  if (!keys) return toast('Provider no reconocido', 'error');

  const credentials = {};
  let hasAny = false;
  for (const key of keys) {
    const el = document.getElementById(`gw-cred-${key}`);
    const val = el ? el.value.trim() : '';
    if (val) {
      credentials[key] = val;
      hasAny = true;
    }
  }

  if (!hasAny) {
    toast('Ingresa al menos una credencial para guardar', 'error');
    return;
  }

  const statusEl = document.getElementById('gw-save-status');
  if (statusEl) statusEl.textContent = 'Guardando...';

  try {
    const r = await api('/api/admin/payment-gateways/credentials', {
      method: 'PUT',
      body: JSON.stringify({ provider, credentials })
    });
    const data = await r.json();
    if (r.ok && data.success) {
      toast(`Credenciales de ${provider} guardadas. Efecto inmediato.`);
      if (statusEl) { statusEl.textContent = 'Guardado'; statusEl.style.color = 'var(--green)'; }
      // Clear inputs after save
      for (const key of keys) {
        const el = document.getElementById(`gw-cred-${key}`);
        if (el) el.value = '';
      }
      // Reload gateways status
      setTimeout(() => loadGateways(), 500);
    } else {
      toast(data.error || 'Error al guardar', 'error');
      if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'var(--red)'; }
    }
  } catch (e) {
    toast('Error de conexión: ' + e.message, 'error');
    if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'var(--red)'; }
  }
}

async function saveGatewaysQuiet() {
  try {
    await api('/api/admin/payment-gateways', {
      method: 'PUT',
      body: JSON.stringify(_gwConfig)
    });
  } catch(e) {
    console.error('Error saving gateways:', e);
  }
}

/* ─── ADS OVERVIEW ───────────────────────────────────────────── */
/* ── PLATFORM ADS ──────────────────────────────────────────────── */
async function loadPlatformAdsConfig() {
  try {
    const r = await api('/api/admin/platform-ads');
    if (!r.ok) return;
    const cfg = await r.json();

    // Toggle principal
    const toggle = document.getElementById('pads-enabled');
    if (toggle) toggle.checked = !!cfg.enabled;

    // Planes
    const plans = cfg.applyToPlans || ['starter'];
    ['starter', 'pro', 'enterprise'].forEach(p => {
      const el = document.getElementById(`pads-plan-${p}`);
      if (el) el.checked = plans.includes(p);
    });

    // Tipo y campos
    const ad = cfg.ad || {};
    const type = ad.type || 'vast';
    const typeEl = document.getElementById('pads-type');
    if (typeEl) typeEl.value = type;

    // VAST
    const vu = document.getElementById('pads-vast-url');
    if (vu) vu.value = ad.vastUrl || ad.vast?.url || '';
    const vp = document.getElementById('pads-vast-pos');
    if (vp) vp.value = ad.vastPosition || ad.vast?.position || 'preroll';
    const vm = document.getElementById('pads-vast-midroll');
    if (vm) vm.value = ad.vastMidrollAt || ad.vast?.midrollTime || 60;

    // Banner
    const bh = document.getElementById('pads-banner-html');
    if (bh) bh.value = ad.bannerHtml || ad.banner?.html || '';
    const bp = document.getElementById('pads-banner-pos');
    if (bp) bp.value = ad.bannerPosition || ad.banner?.position || 'bottom';
    const bd = document.getElementById('pads-banner-delay');
    if (bd) bd.value = ad.bannerDelay ?? ad.banner?.delay ?? 0;

    // Popup
    const pu = document.getElementById('pads-popup-url');
    if (pu) pu.value = ad.popupUrl || ad.popup?.url || '';
    const pd = document.getElementById('pads-popup-delay');
    if (pd) pd.value = ad.popupDelay ?? ad.popup?.delay ?? 10;
    const pf = document.getElementById('pads-popup-freq');
    if (pf) pf.value = ad.popupFrequency ?? ad.popup?.frequency ?? 1;

    renderPlatformAdsFields();
  } catch (e) {
    console.warn('loadPlatformAdsConfig error', e);
  }
}

function onPlatformAdsToggle(checkbox) {
  // Auto-guarda el toggle inmediatamente para feedback rápido
  savePlatformAds({ silent: true });
}

function renderPlatformAdsFields() {
  const type = document.getElementById('pads-type')?.value || 'vast';
  ['vast', 'banner', 'popup'].forEach(t => {
    const el = document.getElementById(`pads-fields-${t}`);
    if (el) el.style.display = t === type ? 'block' : 'none';
  });
  // Mostrar/ocultar campo de tiempo midroll
  const pos = document.getElementById('pads-vast-pos');
  const mw = document.getElementById('pads-midroll-wrap');
  if (pos && mw) mw.style.display = pos.value === 'midroll' ? 'block' : 'none';
}

async function savePlatformAds({ silent = false } = {}) {
  try {
    const enabled = document.getElementById('pads-enabled')?.checked || false;
    const applyToPlans = ['starter', 'pro', 'enterprise'].filter(p => document.getElementById(`pads-plan-${p}`)?.checked);
    const type = document.getElementById('pads-type')?.value || 'vast';

    let ad = { type };
    if (type === 'vast') {
      ad.vastUrl      = document.getElementById('pads-vast-url')?.value?.trim() || null;
      ad.vastPosition = document.getElementById('pads-vast-pos')?.value || 'preroll';
      ad.vastMidrollAt = parseInt(document.getElementById('pads-vast-midroll')?.value || '60', 10);
    } else if (type === 'banner') {
      ad.bannerHtml     = document.getElementById('pads-banner-html')?.value?.trim() || null;
      ad.bannerPosition = document.getElementById('pads-banner-pos')?.value || 'bottom';
      ad.bannerDelay    = parseInt(document.getElementById('pads-banner-delay')?.value || '0', 10);
    } else if (type === 'popup') {
      ad.popupUrl       = document.getElementById('pads-popup-url')?.value?.trim() || null;
      ad.popupDelay     = parseInt(document.getElementById('pads-popup-delay')?.value || '10', 10);
      ad.popupFrequency = parseInt(document.getElementById('pads-popup-freq')?.value || '1', 10);
    }

    const r = await api('/api/admin/platform-ads', {
      method: 'PUT',
      body: JSON.stringify({ enabled, applyToPlans, ad }),
    });

    if (r.ok) {
      if (!silent) toast(enabled ? '✅ Platform Ads activados' : 'Platform Ads guardados');
    } else {
      toast('Error al guardar Platform Ads', 'error');
    }
  } catch (e) {
    toast('Error de conexión', 'error');
  }
}

/* ─────────────────────────────────────────────────────────────── */
async function loadAdsOverview() {
  // Cargar config de platform ads en paralelo
  loadPlatformAdsConfig();

  try {
    const [featR, wsR] = await Promise.all([
      api('/api/admin/features'),
      api('/api/admin/workspaces?limit=200'),
    ]);
    const features = featR.ok ? await featR.json() : {};
    const wsData = wsR.ok ? await wsR.json() : {};

    // Global toggle
    const toggle = document.getElementById('ads-global-enabled');
    if (toggle) toggle.checked = features.adsEnabled !== false;

    // Filter workspaces that have ads configured in their settings
    const allWs = wsData.workspaces || [];
    const withAds = allWs.filter(w => {
      try {
        const s = typeof w.settings === 'string' ? JSON.parse(w.settings) : (w.settings || {});
        return s.ads && s.ads.type;
      } catch { return false; }
    });

    const body = document.getElementById('ads-ws-body');
    if (!withAds.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty-state">Ningún workspace tiene anuncios configurados</td></tr>';
      return;
    }

    const typeLabels = { vast: 'VAST', banner: 'Banner', popup: 'Popup', all: 'Todos' };
    body.innerHTML = withAds.map(w => {
      const s = typeof w.settings === 'string' ? JSON.parse(w.settings) : (w.settings || {});
      const ads = s.ads || {};
      const typeLabel = typeLabels[ads.type] || ads.type || '—';
      const detail = ads.vast?.url ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">VAST: ${esc(ads.vast.url.substring(0,50))}…</div>`
        : ads.banner ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">Banner ${esc(ads.banner.position)}</div>`
        : ads.popup ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">Popup: ${esc(ads.popup.url.substring(0,40))}…</div>`
        : '';
      return `<tr>
        <td><div style="font-weight:600;">${esc(w.name||'—')}</div><div style="font-size:11px;color:var(--muted);">${esc(w.slug||'')}</div></td>
        <td><span class="badge">${w.plan||'free'}</span></td>
        <td><span style="color:var(--accent2);font-weight:600;font-size:12px;">${esc(typeLabel)}</span></td>
        <td>${detail}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    toast('Error al cargar anuncios', 'error');
  }
}

async function saveAdsGlobalToggle(checkbox) {
  const enabled = checkbox.checked;
  try {
    const featR = await api('/api/admin/features');
    const features = featR.ok ? await featR.json() : {};
    const r = await api('/api/admin/features', {
      method: 'PUT',
      body: JSON.stringify({ ...features, adsEnabled: enabled }),
    });
    if (r.ok) toast(enabled ? 'Anuncios activados globalmente' : 'Anuncios desactivados globalmente');
    else { toast('Error al guardar', 'error'); checkbox.checked = !enabled; }
  } catch { toast('Error de conexión', 'error'); checkbox.checked = !enabled; }
}

/* ─── REFERRALS ──────────────────────────────────────────────── */
let refPage = 1;
async function loadReferrals(page = 1) {
  refPage = page;
  try {
    const r = await api(`/api/admin/referrals?page=${page}`);
    if (!r.ok) { toast('Error al cargar referidos', 'error'); return; }
    const d = await r.json();

    // Stats
    document.getElementById('ref-total').textContent = (d.totals.total || 0).toLocaleString('es');
    document.getElementById('ref-credited').textContent = (d.totals.credited || 0).toLocaleString('es');
    document.getElementById('ref-unique').textContent = (d.totals.unique_referrers || 0).toLocaleString('es');
    document.getElementById('ref-paid').textContent = (d.totals.paid_signups || 0).toLocaleString('es');

    // Top referrers
    const topBody = document.getElementById('ref-top-body');
    if (!d.top_referrers || d.top_referrers.length === 0) {
      topBody.innerHTML = '<tr><td colspan="4" class="empty-state">Sin referidos aún</td></tr>';
    } else {
      topBody.innerHTML = d.top_referrers.map(u => `
        <tr>
          <td><div style="font-weight:600;">${esc(u.name || '—')}</div><div style="font-size:11px;color:var(--muted);">${esc(u.email)}</div></td>
          <td><span class="td-mono" style="font-size:12px;">${u.referral_code || '—'}</span></td>
          <td style="text-align:center;">${u.total_referrals}</td>
          <td style="text-align:center;color:var(--green);">${u.credited_referrals}</td>
        </tr>`).join('');
    }

    // Log
    const logBody = document.getElementById('ref-log-body');
    if (!d.referrals || d.referrals.length === 0) {
      logBody.innerHTML = '<tr><td colspan="5" class="empty-state">Sin registros</td></tr>';
    } else {
      logBody.innerHTML = d.referrals.map(r => `
        <tr>
          <td style="font-size:12px;color:var(--muted);">${new Date(r.created_at * 1000).toLocaleDateString('es')}</td>
          <td>
            <div style="font-size:13px;">${esc(r.referrer_name || '—')}</div>
            <div style="font-size:11px;color:var(--muted);">${esc(r.referrer_email)}</div>
          </td>
          <td>
            <div style="font-size:13px;">${esc(r.referred_name || '—')}</div>
            <div style="font-size:11px;color:var(--muted);">${esc(r.referred_email)}</div>
          </td>
          <td><span class="td-mono" style="font-size:12px;">${r.plan_at_signup || 'free'}</span></td>
          <td style="text-align:center;">${r.credited_at ? '<span style="color:var(--green);">✓</span>' : '<span style="color:var(--muted);">—</span>'}</td>
        </tr>`).join('');
    }

    // Pagination
    document.getElementById('ref-prev-btn').style.display = page > 1 ? '' : 'none';
    document.getElementById('ref-next-btn').style.display = d.has_more ? '' : 'none';
  } catch (e) {
    toast('Error de conexión', 'error');
  }
}

/* ─── UTILS ──────────────────────────────────────────────────── */
function timeAgo(ts){ if(!ts) return '—'; const d=Date.now()/1000-ts; if(d<60) return 'ahora'; if(d<3600) return `hace ${Math.floor(d/60)}m`; if(d<86400) return `hace ${Math.floor(d/3600)}h`; return `hace ${Math.floor(d/86400)}d`; }
function fmtBytes(b){ b=Number(b)||0; if(b<=0) return '0 B'; const u=['B','KB','MB','GB','TB']; const i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),u.length-1); return (b/Math.pow(1024,i)).toFixed(1)+' '+u[i]; }
