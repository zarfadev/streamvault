# 📘 EXPLICACIÓN COMPLETA DEL SISTEMA EMBED

## 🎯 ¿Qué son los Embed Tiers?

Los **Embed Tiers** controlan cómo se ve el reproductor cuando alguien embede un video en su sitio web. Hay 3 niveles:

### 1. 🏷️ **BRANDED** (Plan Starter - $19/mes)
- **Logo StreamVault VISIBLE** en el reproductor
- El usuario NO puede quitar el logo
- NO puede usar dominio personalizado
- NO puede poner anuncios
- **Ejemplo**: Como YouTube que siempre muestra su logo

### 2. 🎨 **UNBRANDED** (Plan Pro - $59/mes)  
- **SIN logo de StreamVault**
- El usuario PUEDE poner SU PROPIO LOGO
- NO puede usar dominio personalizado
- NO puede poner anuncios
- **Ejemplo**: Como Vimeo Pro que no muestra su marca

### 3. 🚀 **CUSTOM** (Plan Enterprise - $99/mes)
- **Control Total**
- Puede poner su propio logo
- PUEDE usar **dominio personalizado** (videos.miempresa.com)
- PUEDE configurar **anuncios** (VAST, Banner, Popup)
- **Ejemplo**: Como Wistia Enterprise

---

## 🏗️ ARQUITECTURA ACTUAL

```
┌─────────────────────────────────────────────────────┐
│  ADMIN (system_config)                              │
│  • Configura logo de StreamVault                    │
│  • Configura nombre de plataforma                   │
│  • Configura posición del logo (tr/tl/br/bl)        │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│  PLAN (migration 005)                               │
│  • starter: embed="branded"                         │
│  • pro: embed="unbranded"                           │
│  • enterprise: embed="custom"                       │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│  WORKSPACE (settings JSON)                          │
│  • embedConfig.logoUrl (si unbranded/custom)        │
│  • embedConfig.color                                │
│  • ads.* (si custom + adsEnabled)                   │
│  • customDomain (si custom)                         │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│  PLAYER (app-player.js)                             │
│  • Recibe embedConfig vía GET /api/videos/:id       │
│  • Renderiza logo según tier                        │
│  • Aplica anuncios si están configurados            │
└─────────────────────────────────────────────────────┘
```

---

## 🔧 PROBLEMAS ACTUALES Y SOLUCIONES

### ❌ Error 1: `GET /api/videos/:id/transcriptions 401 Unauthorized`

**Causa**: El endpoint en `routes/transcriptions.js` línea 87 NO requiere autenticación pero el player intenta usar auth.

**Solución**: Hacer el endpoint público o usar `optionalAuth`.

### ❌ Error 2: `GET /api/admin/features 400 Bad Request`

**Causa**: El endpoint existe (línea 1445-1453 en routes/admin.js) pero `system_config` no tiene la key 'features' inicializada.

**Solución**: Ejecutar el script de inicialización o insertar manualmente.

---

## 📊 ESTADO ACTUAL DEL CÓDIGO

### ✅ YA IMPLEMENTADO

1. **Migration 007** (`db/migrations/007_embed_custom_domain_ads.sql`)
   - Columnas para custom domain verification
   - Documentación de estructura JSON en workspace.settings

2. **Routes Admin** (`routes/admin.js`)
   - GET/PUT `/api/admin/platform-config` (líneas 1395-1442)
   - GET/PUT `/api/admin/features` (líneas 1445-1469)

3. **Player** (`public/js/app-player.js`)
   - Sistema de anuncios completo
   - Renderizado de logo según embedConfig
   - Soporte para VAST, Banner, Popup

4. **Migration 005** (`db/migrations/005_hierarchical_features_system.sql`)
   - Configuración de planes con embed tiers
   - Features por plan

### ⚠️ IMPLEMENTADO PERO CON ERRORES

1. **Transcriptions endpoint**: Falta auth opcional
2. **Features initialization**: Falta en system_config

### ❌ FALTA IMPLEMENTAR

1. **UI Admin Panel**: Sección para configurar platform branding
2. **UI Dashboard**: Pestañas para embed settings / custom domain / ads
3. **Endpoints Custom Domain**:
   - POST `/api/workspaces/:id/custom-domain`
   - POST `/api/workspaces/:id/custom-domain/verify`
   - DELETE `/api/workspaces/:id/custom-domain`
4. **Verificación DNS**: Lógica para verificar TXT records
5. **Endpoints Workspace Settings**: GET/PUT para embedConfig y ads

---

## 📝 PLAN DE ACCIÓN

### Prioridad 1: ARREGLAR ERRORES
- [ ] Fix 401 en transcriptions
- [ ] Fix 400 en admin/features
- [ ] Inicializar system_config correctamente

### Prioridad 2: COMPLETAR BACKEND
- [ ] Endpoints custom domain
- [ ] Endpoints workspace settings (embed/ads)
- [ ] Lógica verificación DNS

### Prioridad 3: UI ADMIN
- [ ] Sección Platform Branding
- [ ] Upload logo StreamVault
- [ ] Configurar posición y nombre

### Prioridad 4: UI DASHBOARD
- [ ] Tab Embed Settings (mostrar según tier)
- [ ] Tab Custom Domain (solo Enterprise)
- [ ] Tab Ads Configuration (solo Enterprise)

### Prioridad 5: TESTING
- [ ] Probar embed branded
- [ ] Probar embed unbranded
- [ ] Probar embed custom con dominio
- [ ] Probar anuncios VAST/Banner/Popup

---

## 🎓 CÓMO FUNCIONA EL SISTEMA DE ANUNCIOS

El usuario configura anuncios en el dashboard, se guardan en `workspace.settings.ads`:

```json
{
  "ads": {
    "enabled": true,
    "type": "vast",  // o "banner", "popup", "all"
    
    // VAST (Video Ads)
    "vastUrl": "https://ads.provider.com/vast.xml",
    "vastPosition": "preroll",  // o "midroll", "postroll"
    "vastMidrollAt": 60,  // segundos (solo midroll)
    
    // Banner HTML
    "bannerHtml": "<a href='...'>Tu anuncio</a>",
    "bannerPosition": "top",  // o "bottom"
    "bannerDelay": 5,  // segundos antes de mostrar
    "bannerDuration": 10,  // 0 = siempre visible
    
    // Popup Overlay
    "popupUrl": "https://ads.example.com/popup",
    "popupDelay": 10,  // segundos antes de mostrar
    "popupFrequency": 1  // 1 = cada vez, 2 = cada 2 veces
  }
}
```

El player (`app-player.js`) recibe esto en `embedConfig.ads` y:
1. **VAST**: Usa IMA SDK de Google para reproducir video ads
2. **Banner**: Crea overlay HTML encima del player
3. **Popup**: Muestra modal después de X segundos

---

## 🔐 SISTEMA DE DOMINIO PERSONALIZADO

### Proceso de Configuración:

1. **Usuario entra a Dashboard** → Settings → Custom Domain
2. **Ingresa dominio**: `videos.miempresa.com`
3. **Sistema genera token**: `sv_abc123def456...`
4. **Instrucciones DNS**:
   ```
   TXT  _streamvault-verify.videos.miempresa.com  →  sv_abc123def456...
   CNAME videos.miempresa.com  →  app.streamvault.io
   ```
5. **Usuario configura DNS**
6. **Click en "Verify"** → Sistema verifica TXT record
7. **Si OK**: `verified: true`, puede usar el dominio
8. **Embeds**: `https://videos.miempresa.com/embed/VIDEO_ID`

### Verificación DNS (pendiente implementar):

```javascript
const dns = require('dns').promises;

async function verifyCustomDomain(domain, token) {
  try {
    const txtRecords = await dns.resolveTxt(`_streamvault-verify.${domain}`);
    const found = txtRecords.flat().some(record => record === token);
    return { verified: found, error: null };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}
```

---

## 💡 PREGUNTAS FRECUENTES

### ¿Por qué hay código duplicado?

**R**: El sistema evolucionó y quedaron múltiples implementaciones. Hay que consolidar todo en `workspace.settings`.

### ¿Dónde se guarda el logo de StreamVault?

**R**: En `system_config` con key `platform`:
```json
{
  "platformLogoUrl": "/favicon.svg",
  "platformLogoPos": "tr",
  "platformName": "StreamVault"
}
```

### ¿Cómo sabe el player qué logo mostrar?

**R**: El endpoint `GET /api/videos/:id` devuelve `embedConfig` que incluye:
- Si `embedTier === 'branded'` → `platformLogoUrl` (logo StreamVault)
- Si `embedTier === 'unbranded' o 'custom'` → `logoUrl` (logo del workspace)

### ¿Los anuncios funcionan en cualquier plan?

**R**: NO. Solo plan Enterprise (tier `custom`) puede habilitar anuncios. El middleware `checkFeature` valida esto.

---

## 🚀 SIGUIENTES PASOS

1. **Arreglar errores actuales** (401, 400)
2. **Completar endpoints faltantes** (custom domain, workspace settings)
3. **Implementar UI admin** (platform branding)
4. **Implementar UI dashboard** (embed/domain/ads settings)
5. **Testing completo** (cada tier, anuncios, dominio)
6. **Documentación usuario final** (cómo configurar cada cosa)

---

**Fecha:** Mayo 13, 2026  
**Versión:** 1.0  
**Estado:** 🟡 Funcional con errores menores
