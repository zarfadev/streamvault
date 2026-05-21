# 🎯 Sistema Maestro: Embed Tiers, Branding, Dominios y Anuncios

**Versión:** 1.0  
**Fecha:** Mayo 2026  
**Estado:** ✅ Errores críticos arreglados, consolidación en progreso

---

## 📋 ÍNDICE

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [Arquitectura del Sistema](#arquitectura-del-sistema)
3. [Embed Tiers](#embed-tiers)
4. [Sistema de Branding](#sistema-de-branding)
5. [Dominios Personalizados](#dominios-personalizados)
6. [Sistema de Anuncios](#sistema-de-anuncios)
7. [Base de Datos](#base-de-datos)
8. [APIs y Endpoints](#apis-y-endpoints)
9. [Frontend (UI)](#frontend-ui)
10. [Guía de Implementación](#guía-de-implementación)

---

## 🎯 RESUMEN EJECUTIVO

### Estado Actual
- ✅ **Error 401 transcripciones:** ARREGLADO (auth headers en player)
- ✅ **Error 400 admin features:** ARREGLADO (system_config inicializado)
- ⚠️ **Código duplicado:** Existe código de ads en múltiples lugares
- 🔄 **Consolidación pendiente:** Unificar en `workspace.settings`

### Objetivos del Sistema

1. **Embed Tiers**: 3 niveles controlados por features del plan
2. **Branding**: Logo de plataforma vs workspace según tier
3. **Dominios**: Custom domain solo para tier `custom`
4. **Anuncios**: Sistema completo VAST/Banner/Popup por plan

---

## 🏗️ ARQUITECTURA DEL SISTEMA

### Jerarquía de Control

```
ADMIN (system_config)
  ↓
PLAN (plan_features)
  ↓
WORKSPACE (workspaces table)
  ↓
EMBED CONFIG (runtime)
```

### Flujo de Configuración

```
1. Admin configura platform branding en system_config
2. Plan define qué features están disponibles
3. Workspace configura su branding/ads en workspace.settings
4. Runtime combina todo y envía embedConfig al player
```

---

## 🎨 EMBED TIERS

### Definición de Tiers

| Tier | Plan | Logo | Dominio | Ads |
|------|------|------|---------|-----|
| **branded** | Starter | ✅ Plataforma | ❌ No | ❌ No |
| **unbranded** | Professional | ✅ Workspace | ❌ No | ❌ No |
| **custom** | Enterprise | ✅ Workspace | ✅ Sí | ✅ Opcional |

### Configuración en Planes

```sql
-- En plan_features tabla
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
  ('starter', 'embed_tier', true, '{"tier": "branded"}'),
  ('professional', 'embed_tier', true, '{"tier": "unbranded"}'),
  ('enterprise', 'embed_tier', true, '{"tier": "custom"}');
```

### Lógica de Determinación

```javascript
// routes/videos.js - Función getEmbedConfig()
function determineEmbedTier(workspace) {
  const features = workspace.plan_features || {};
  const embedFeature = features.embed_tier;
  
  if (!embedFeature || !embedFeature.enabled) {
    return 'branded'; // Default fallback
  }
  
  return embedFeature.config?.tier || 'branded';
}
```

---

## 🎨 SISTEMA DE BRANDING

### Branding de Plataforma (Admin)

**Ubicación:** `system_config` tabla, key: `platform`

```json
{
  "siteName": "StreamVault",
  "allowRegistration": true,
  "platformLogoUrl": "/favicon.svg",
  "platformLogoPos": "tr",
  "platformName": "StreamVault"
}
```

**UI Admin:** `/admin` → Sección "Platform Branding"

### Branding de Workspace (Usuario)

**Ubicación:** `workspaces.settings` JSON field

```json
{
  "embedConfig": {
    "logoUrl": "https://cdn.example.com/logo.png",
    "logoPos": "tr",
    "color": "#7c6cfa",
    "playerName": "Mi Plataforma"
  }
}
```

**UI Dashboard:** `/dashboard` → Settings → Embed Player

### Lógica de Logo en Player

```javascript
// En routes/videos.js - getEmbedConfig()
if (embedTier === 'branded') {
  // Mostrar logo de la plataforma
  embedConfig.platformLogoUrl = platformConfig.platformLogoUrl;
  embedConfig.platformLogoPos = platformConfig.platformLogoPos;
  embedConfig.platformName = platformConfig.platformName;
} else {
  // Mostrar logo del workspace (unbranded/custom)
  if (workspace.settings?.embedConfig?.logoUrl) {
    embedConfig.logoUrl = workspace.settings.embedConfig.logoUrl;
    embedConfig.logoPos = workspace.settings.embedConfig.logoPos || 'tr';
  }
}
```

---

## 🌐 DOMINIOS PERSONALIZADOS

### Restricción por Tier

- ❌ **branded:** No disponible
- ❌ **unbranded:** No disponible  
- ✅ **custom:** Disponible

### Configuración

**Ubicación:** `workspaces.settings.customDomain`

```json
{
  "customDomain": {
    "domain": "videos.miempresa.com",
    "verified": true,
    "verificationToken": "sv_abc123...",
    "verifiedAt": 1234567890
  }
}
```

### Proceso de Verificación

1. Usuario ingresa dominio en dashboard
2. Sistema genera token único
3. Usuario crea registro DNS TXT: `_streamvault-verify.videos.miempresa.com` → `sv_abc123...`
4. Sistema verifica DNS y marca `verified: true`
5. Usuario configura CNAME: `videos.miempresa.com` → `app.streamvault.io`

### Endpoints

```
POST   /api/workspaces/:id/custom-domain     - Configurar dominio
POST   /api/workspaces/:id/custom-domain/verify - Verificar DNS
DELETE /api/workspaces/:id/custom-domain     - Eliminar dominio
```

---

## 📢 SISTEMA DE ANUNCIOS

### Control por Plan

**Ubicación:** `plan_features` tabla

```sql
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
  ('starter', 'ads', false, NULL),
  ('professional', 'ads', false, NULL),
  ('enterprise', 'ads', true, '{
    "types": ["vast", "banner", "popup"],
    "positions": ["preroll", "midroll", "postroll"]
  }');
```

### Configuración de Workspace

**Ubicación:** `workspaces.settings.ads`

```json
{
  "ads": {
    "enabled": true,
    "type": "vast",
    "vastUrl": "https://ads.example.com/vast.xml",
    "vastPosition": "preroll",
    "vastMidrollAt": 60,
    "bannerHtml": "<a href='...'>Anuncio</a>",
    "bannerPosition": "bottom",
    "bannerDelay": 5,
    "bannerDuration": 0,
    "popupUrl": "https://ads.example.com/popup.html",
    "popupDelay": 10,
    "popupFrequency": 1
  }
}
```

### Tipos de Anuncios

#### 1. VAST (Video Ads)

```javascript
{
  type: 'vast',
  vastUrl: 'https://ads.provider.com/vast.xml',
  vastPosition: 'preroll' | 'midroll' | 'postroll',
  vastMidrollAt: 60 // segundos (solo para midroll)
}
```

#### 2. Banner HTML

```javascript
{
  type: 'banner',
  bannerHtml: '<a href="...">Tu anuncio</a>',
  bannerPosition: 'top' | 'bottom',
  bannerDelay: 5,      // segundos antes de mostrar
  bannerDuration: 0    // 0 = siempre visible, N = ocultar tras N seg
}
```

#### 3. Popup Overlay

```javascript
{
  type: 'popup',
  popupUrl: 'https://ads.example.com/popup.html',
  popupDelay: 10,        // segundos antes de mostrar
  popupFrequency: 1      // 1 = cada reproducción, N = cada N veces
}
```

### Implementación en Player

**Archivo:** `public/js/app-player.js`

```javascript
// Sistema de anuncios ya implementado:
function _initAds(adsCfg) {
  if (!adsCfg?.enabled) return;
  
  const type = adsCfg.type || 'vast';
  
  if (type === 'vast' || type === 'all') {
    _initVastAd(adsCfg);
  }
  if (type === 'banner' || type === 'all') {
    _showBanner(adsCfg);
  }
  if (type === 'popup' || type === 'all') {
    _showPopup(adsCfg);
  }
}
```

---

## 💾 BASE DE DATOS

### Tabla `system_config`

```sql
CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,  -- JSON
  updated_at BIGINT NOT NULL
);

-- Datos iniciales
INSERT INTO system_config (key, value) VALUES
  ('platform', '{"siteName":"StreamVault","platformLogoUrl":"/favicon.svg",...}'),
  ('features', '{"foldersEnabled":true,"playlistsEnabled":true,...}');
```

### Tabla `workspaces`

```sql
-- Campo settings (JSON)
{
  "embedConfig": {
    "logoUrl": "...",
    "logoPos": "tr",
    "color": "#7c6cfa",
    "playerName": "..."
  },
  "ads": {
    "enabled": true,
    "type": "vast",
    ...
  },
  "customDomain": {
    "domain": "videos.example.com",
    "verified": true,
    ...
  },
  "watermark": {
    "enabled": true,
    "text": "© {date}",
    "position": "bottom-right",
    "opacity": 0.3
  }
}
```

### Tabla `plan_features`

```sql
CREATE TABLE plan_features (
  id SERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  config JSONB,
  UNIQUE(plan_id, feature_key)
);
```

---

## 🔌 APIS Y ENDPOINTS

### Videos API (Embed Config)

```
GET /api/videos/:id
```

**Response incluye:**
```json
{
  "id": "123",
  "title": "Mi Video",
  "m3u8Url": "...",
  "embedConfig": {
    "embedTier": "branded|unbranded|custom",
    "color": "#7c6cfa",
    "playerName": "StreamVault",
    "platformLogoUrl": "/favicon.svg",  // Si branded
    "logoUrl": "...",                   // Si unbranded/custom
    "logoPos": "tr",
    "ads": {
      "enabled": true,
      "type": "vast",
      ...
    },
    "watermarkEnabled": true,
    "watermarkText": "© 2026",
    ...
  }
}
```

### Admin API

```
GET    /api/admin/platform-config
PUT    /api/admin/platform-config
GET    /api/admin/features
PUT    /api/admin/features
```

### Workspace Settings API

```
GET    /api/workspaces/:id/settings
PUT    /api/workspaces/:id/settings
POST   /api/workspaces/:id/custom-domain
POST   /api/workspaces/:id/custom-domain/verify
DELETE /api/workspaces/:id/custom-domain
```

---

## 🎨 FRONTEND (UI)

### Panel Admin (`/admin`)

**Archivo:** `public/admin/index.html`, `public/js/app-admin.js`

#### Sección: Platform Branding

```html
<div class="admin-section">
  <h2>Platform Branding</h2>
  <div class="form-group">
    <label>Logo URL</label>
    <input type="url" id="platformLogoUrl" value="/favicon.svg">
  </div>
  <div class="form-group">
    <label>Logo Position</label>
    <select id="platformLogoPos">
      <option value="tl">Top Left</option>
      <option value="tr">Top Right</option>
      <option value="bl">Bottom Left</option>
      <option value="br">Bottom Right</option>
    </select>
  </div>
  <div class="form-group">
    <label>Platform Name</label>
    <input type="text" id="platformName" value="StreamVault">
  </div>
  <button onclick="savePlatformBranding()">Save Platform Branding</button>
</div>
```

### Dashboard Usuario (`/dashboard`)

**Archivo:** `public/dashboard/index.html`, `public/js/app-dashboard.js`

#### Pestaña: Embed Player Settings

```html
<div class="settings-section" id="embed-settings">
  <h3>🎨 Embed Player Branding</h3>
  
  <!-- Tier Badge -->
  <div class="tier-badge" id="embed-tier-badge">
    Your plan: <strong id="tier-label">Branded</strong>
  </div>
  
  <!-- Logo Upload (solo si unbranded/custom) -->
  <div class="form-group" id="logo-upload-section" style="display:none;">
    <label>Logo URL</label>
    <input type="url" id="embed-logo-url" placeholder="https://cdn.example.com/logo.png">
    <small>Max 200KB, transparent PNG recommended</small>
  </div>
  
  <!-- Color Picker -->
  <div class="form-group">
    <label>Accent Color</label>
    <input type="color" id="embed-color" value="#7c6cfa">
  </div>
  
  <!-- Player Name -->
  <div class="form-group">
    <label>Player Name</label>
    <input type="text" id="embed-player-name" placeholder="My Platform">
  </div>
</div>

<div class="settings-section" id="custom-domain-settings" style="display:none;">
  <h3>🌐 Custom Domain</h3>
  <div class="alert info">
    Available on Enterprise plan
  </div>
  
  <div class="form-group">
    <label>Domain</label>
    <input type="text" id="custom-domain" placeholder="videos.example.com">
  </div>
  
  <div id="dns-instructions" style="display:none;">
    <h4>DNS Configuration</h4>
    <p>Add the following DNS records:</p>
    <code>TXT _streamvault-verify.videos.example.com → <span id="verify-token"></span></code>
    <code>CNAME videos.example.com → app.streamvault.io</code>
  </div>
  
  <button onclick="configureDomain()">Configure Domain</button>
  <button onclick="verifyDomain()">Verify DNS</button>
</div>

<div class="settings-section" id="ads-settings" style="display:none;">
  <h3>📢 Advertising</h3>
  <div class="alert info">
    Available on Enterprise plan
  </div>
  
  <div class="form-group">
    <label>
      <input type="checkbox" id="ads-enabled">
      Enable Ads
    </label>
  </div>
  
  <div id="ads-config" style="display:none;">
    <div class="form-group">
      <label>Ad Type</label>
      <select id="ad-type">
        <option value="vast">Video (VAST)</option>
        <option value="banner">Banner HTML</option>
        <option value="popup">Popup Overlay</option>
        <option value="all">All Types</option>
      </select>
    </div>
    
    <!-- VAST Config -->
    <div id="vast-config">
      <div class="form-group">
        <label>VAST URL</label>
        <input type="url" id="vast-url" placeholder="https://ads.provider.com/vast.xml">
      </div>
      <div class="form-group">
        <label>Position</label>
        <select id="vast-position">
          <option value="preroll">Pre-roll (before video)</option>
          <option value="midroll">Mid-roll (during video)</option>
          <option value="postroll">Post-roll (after video)</option>
        </select>
      </div>
      <div class="form-group" id="midroll-time-group" style="display:none;">
        <label>Mid-roll at (seconds)</label>
        <input type="number" id="vast-midroll-at" value="60" min="10">
      </div>
    </div>
    
    <!-- Banner Config -->
    <div id="banner-config" style="display:none;">
      <div class="form-group">
        <label>Banner HTML</label>
        <textarea id="banner-html" rows="3" placeholder="<a href='...'>Your ad</a>"></textarea>
        <small>⚠️ Only use trusted HTML. No scripts allowed.</small>
      </div>
      <div class="form-group">
        <label>Position</label>
        <select id="banner-position">
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>
    </div>
    
    <!-- Popup Config -->
    <div id="popup-config" style="display:none;">
      <div class="form-group">
        <label>Popup URL</label>
        <input type="url" id="popup-url" placeholder="https://ads.example.com/popup.html">
      </div>
      <div class="form-group">
        <label>Show after (seconds)</label>
        <input type="number" id="popup-delay" value="10" min="0">
      </div>
    </div>
  </div>
  
  <button onclick="saveAdsConfig()">Save Ads Configuration</button>
</div>
```

---

## 🚀 GUÍA DE IMPLEMENTACIÓN

### Paso 1: Inicializar System Config

```bash
node scripts/init-system-config-fixed.js
```

### Paso 2: Configurar Planes

```sql
-- Insertar features de embed tiers
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
  ('starter', 'embed_tier', true, '{"tier": "branded"}'),
  ('professional', 'embed_tier', true, '{"tier": "unbranded"}'),
  ('enterprise', 'embed_tier', true, '{"tier": "custom"}');

-- Insertar features de ads
INSERT INTO plan_features (plan_id, feature_key, enabled, config) VALUES
  ('enterprise', 'ads', true, '{
    "types": ["vast", "banner", "popup"],
    "positions": ["preroll", "midroll", "postroll"]
  }');
```

### Paso 3: Actualizar Frontend

1. **Admin Panel:** Implementar sección Platform Branding
2. **Dashboard:** Implementar pestañas Embed/Domain/Ads según tier
3. **Player:** Ya implementado en `app-player.js`

### Paso 4: Crear Endpoints

**Pendientes:**
- `PUT /api/admin/platform-config`
- `POST /api/workspaces/:id/custom-domain`
- `POST /api/workspaces/:id/custom-domain/verify`

### Paso 5: Testing

```bash
# Verificar config
psql streamvault -c "SELECT * FROM system_config;"

# Verificar tiers
psql streamvault -c "SELECT plan_id, feature_key, config FROM plan_features WHERE feature_key = 'embed_tier';"

# Test video con embed config
curl http://localhost:3000/api/videos/VIDEO_ID
```

---

## 📝 CHECKLIST DE IMPLEMENTACIÓN

### ✅ Completado

- [x] Fix error 401 transcripciones
- [x] Fix error 400 admin features
- [x] Sistema de anuncios en player
- [x] Lógica de embed tiers en routes/videos.js
- [x] Documentación base de datos

### 🔄 En Progreso

- [ ] Limpiar código duplicado de ads
- [ ] Consolidar config en workspace.settings
- [ ] UI admin para platform branding
- [ ] UI dashboard para embed settings

### 📋 Pendiente

- [ ] Endpoints custom domain
- [ ] Verificación DNS
- [ ] UI dashboard para custom domain
- [ ] UI dashboard para ads config
- [ ] Tests end-to-end
- [ ] Documentación de usuario final

---

## 🐛 TROUBLESHOOTING

### Error: "database 'miguel' does not exist"

**Solución:** Script no carga `.env`. Usar `init-system-config-fixed.js` que incluye `require('dotenv').config()`.

### Error 401 en transcripciones

**Solución:** Player debe enviar auth header en todos los fetch de transcriptions y tracks:
```javascript
fetch(url, { headers: _authHdr() })
```

### Logo no aparece

**Verificar:**
1. Tier del plan: `SELECT config FROM plan_features WHERE feature_key = 'embed_tier'`
2. Config workspace: `SELECT settings FROM workspaces WHERE id = X`
3. Console del navegador para errores de CORS/404

---

## 📞 SOPORTE

Para dudas o problemas:
1. Revisar este documento primero
2. Verificar logs del servidor
3. Verificar base de datos con queries de este documento
4. Contactar al equipo de desarrollo

---

**Última actualización:** Mayo 13, 2026  
**Autor:** StreamVault Development Team
