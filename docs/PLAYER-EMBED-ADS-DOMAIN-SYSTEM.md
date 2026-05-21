# Sistema de Player Embed, ADS y Dominio Personalizado

## 📋 Resumen del Sistema

Este documento explica cómo funciona el sistema de características del player embed según el plan del usuario, específicamente para:
- **Player Embed Tiers** (branded, unbranded, custom)
- **Configuración de ADS** (VAST, Banner, Popup)
- **Dominio Personalizado** para embed

---

## 🎯 Jerarquía de Tiers del Player Embed

### Plan Starter → `embedEnabled: 'branded'`
- ✅ Embed disponible
- ⚠️ **Con marca de StreamVault** visible en el player
- ❌ NO puede personalizar logo
- ❌ NO puede configurar nombre del player
- ❌ NO tiene acceso a configuración de ADS
- ❌ NO tiene acceso a dominio personalizado

### Plan Pro → `embedEnabled: 'unbranded'`
- ✅ Embed disponible
- ✅ **Sin marca de StreamVault**
- ✅ Puede configurar logo propio
- ❌ NO puede configurar nombre del player
- ✅ **PUEDE configurar ADS** (VAST, Banner, Popup)
- ❌ NO tiene acceso a dominio personalizado

### Plan Enterprise → `embedEnabled: 'custom'`
- ✅ Embed disponible
- ✅ Sin marca de StreamVault
- ✅ Puede configurar logo propio
- ✅ **Puede configurar nombre del player**
- ✅ Puede configurar ADS (VAST, Banner, Popup)
- ✅ **Puede configurar dominio personalizado**

---

## 🔧 Lógica en el Dashboard (`applyFeatureFlags()`)

### 1. Configuración del Player Embed (líneas 5378-5445)

```javascript
const embedVal = f.embedEnabled; // 'branded' | 'unbranded' | 'custom' | false

if (embedVal === false) {
  // Mostrar mensaje de plan bloqueado
  // Ocultar todo el contenido de embed
} else {
  // Mostrar badge del tier (BRANDED | UNBRANDED | CUSTOM)
  
  // Campos de personalización completa: solo en 'custom'
  embedCustomFields.style.display = (embedVal === 'custom') ? '' : 'none';
  
  // Logo URL: disponible en 'unbranded' y 'custom', oculto en 'branded'
  logoGroup.style.display = (embedVal === 'branded') ? 'none' : '';
  
  // Player name: solo en 'custom'
  playerNameGroup.style.display = (embedVal === 'custom') ? '' : 'none';
}
```

### 2. Configuración de ADS (líneas 5447-5467)

```javascript
const adsCard = document.getElementById('ads-card');
const adsEnabled = f.adsEnabled;
let showAds;

if (adsEnabled === false) {
  // Explícitamente desactivado para este plan
  showAds = false;
} else if (adsEnabled === true || adsEnabled === 'full') {
  // Explícitamente activado para este plan
  showAds = true;
} else {
  // Sin definir: mostrar solo en Pro (unbranded) y Enterprise (custom)
  // Plan Starter (branded) NO tiene acceso a ADS
  showAds = (embedVal === 'unbranded' || embedVal === 'custom');
}

adsCard.style.display = showAds ? '' : 'none';
```

**Resultado:**
- Starter (branded) → `ads-card` oculto
- Pro (unbranded) → `ads-card` visible
- Enterprise (custom) → `ads-card` visible

### 3. Dominio Personalizado (líneas 5469-5474)

```javascript
const customDomainSection = document.getElementById('custom-domain-section');
customDomainSection.style.display = (embedVal === 'custom') ? 'block' : 'none';
```

**Resultado:**
- Solo visible en Enterprise (custom)

---

## 📊 Tipos de Anuncios Disponibles

### VAST (Video Ads Serving Template)
- **Posiciones**: preroll, midroll, postroll
- **Configuración**:
  - URL del tag VAST
  - Posición del anuncio
  - Tiempo de midroll (si aplica)

### Banner HTML
- **Posiciones**: top, bottom, overlay
- **Configuración**:
  - Código HTML del banner
  - Posición en el player
  - Delay (segundos)
  - Duración (segundos, 0 = permanente)

### Popup Overlay
- **Configuración**:
  - URL de destino
  - Delay inicial (segundos)
  - Frecuencia (cada X videos)

### All (Combinado)
- Permite configurar los 3 tipos simultáneamente

---

## 🔐 Dominio Personalizado (Solo Enterprise)

### Requisitos DNS

Para usar dominio personalizado, el usuario debe:

1. **Crear registro CNAME**:
```
videos.tu-dominio.com → embed.streamvault.com
```

2. **Guardar el dominio** en configuración

3. **Verificar DNS** con el botón "Verificar dominio"

### Campos de la UI

```html
<div id="custom-domain-section" style="display:none">
  <!-- Solo visible en Enterprise -->
  <input id="cfg-custom-domain" />
  <button onclick="saveCustomDomain()">Guardar</button>
  <button onclick="verifyCustomDomain()">Verificar</button>
  <div id="custom-domain-status">
    <!-- Muestra estado de verificación -->
  </div>
</div>
```

---

## ✅ Verificación del Sistema

### Checklist para Starter (branded)

- [x] Embed card visible con badge "BRANDED"
- [x] Logo URL oculto
- [x] Player name oculto
- [x] ADS card completamente oculto
- [x] Custom domain section oculto
- [x] Mensaje en embed: "el player mostrará el logo de StreamVault"

### Checklist para Pro (unbranded)

- [x] Embed card visible con badge "UNBRANDED"
- [x] Logo URL visible
- [x] Player name oculto
- [x] **ADS card visible y funcional**
- [x] Custom domain section oculto
- [x] Mensaje en embed: "el player se muestra sin marca de StreamVault"

### Checklist para Enterprise (custom)

- [x] Embed card visible con badge "CUSTOM"
- [x] Logo URL visible
- [x] **Player name visible**
- [x] **ADS card visible y funcional**
- [x] **Custom domain section visible**
- [x] Mensaje en embed: "puedes personalizar completamente el player"

---

## 🐛 Problemas Comunes

### Problema 1: ADS card visible en plan Starter

**Causa**: El feature `adsEnabled` no está configurado correctamente en la base de datos.

**Solución**: Verificar que el plan Starter tenga:
```sql
UPDATE workspace_features 
SET adsEnabled = false 
WHERE plan_name = 'Starter';
```

O que la lógica fallback funcione:
```javascript
showAds = (embedVal === 'unbranded' || embedVal === 'custom');
```

### Problema 2: Custom domain visible en Pro

**Causa**: El check del tier no funciona.

**Solución**: Verificar que:
```javascript
embedVal === 'custom' // Solo debe ser true en Enterprise
```

### Problema 3: Los cambios no se reflejan

**Causa**: Cache de features no actualizado.

**Solución**: Ejecutar:
```javascript
await applyFeatureFlags(); // Recargar features
```

---

## 🔄 Flujo de Actualización

```mermaid
graph TD
    A[Usuario entra a Settings] --> B[loadSettings()]
    B --> C[Cargar workspace settings]
    C --> D[applyFeatureFlags()]
    D --> E{Verificar embedEnabled}
    E -->|branded| F[Ocultar ADS y Custom Domain]
    E -->|unbranded| G[Mostrar ADS, ocultar Custom Domain]
    E -->|custom| H[Mostrar ADS y Custom Domain]
    F --> I[Actualizar UI]
    G --> I
    H --> I
```

---

## 📝 Configuración en la Base de Datos

### Tabla: `workspace_features`

```sql
-- Plan Starter
embedEnabled = 'branded'
adsEnabled = false  -- O NULL para usar lógica fallback

-- Plan Pro  
embedEnabled = 'unbranded'
adsEnabled = true

-- Plan Enterprise
embedEnabled = 'custom'
adsEnabled = true
```

### Tabla: `workspace_settings` (settings JSON)

```json
{
  // ADS configuration (solo si adsEnabled = true)
  "ads": {
    "type": "vast" | "banner" | "popup" | "all",
    "vast": {
      "url": "https://...",
      "position": "preroll" | "midroll" | "postroll",
      "midrollTime": 60
    },
    "banner": {
      "html": "<div>...</div>",
      "position": "top" | "bottom" | "overlay",
      "delay": 0,
      "duration": 0
    },
    "popup": {
      "url": "https://...",
      "delay": 10,
      "frequency": 1
    }
  },
  
  // Custom domain (solo si embedEnabled = 'custom')
  "customEmbedDomain": "videos.midominio.com",
  "customEmbedDomainVerified": true
}
```

---

## 🎨 UI Elements IDs

```javascript
// Embed configuration
'embed-code-card'           // Tarjeta principal
'embed-tier-badge'          // Badge del tier
'embed-tier-info'           // Mensaje informativo
'embed-custom-fields'       // Campos de personalización
'embed-logo-group'          // Input de logo URL
'embed-player-name-group'   // Input de nombre del player

// ADS configuration
'ads-card'                  // Tarjeta de ADS
'cfg-ads-type'              // Select de tipo de anuncio
'ads-vast-fields'           // Campos VAST
'ads-banner-fields'         // Campos Banner
'ads-popup-fields'          // Campos Popup

// Custom domain
'custom-domain-section'     // Sección completa
'cfg-custom-domain'         // Input de dominio
'verify-domain-btn'         // Botón verificar
'custom-domain-status'      // Estado de verificación
```

---

## 🚀 Testing

### Test Manual

1. **Crear 3 workspaces** con diferentes planes
2. **Login con cada workspace**
3. **Ir a Settings → General**
4. **Verificar visibilidad**:
   - Starter: NO ver ADS ni Custom Domain
   - Pro: VER ADS, NO ver Custom Domain
   - Enterprise: VER ADS Y Custom Domain

### Console Test

```javascript
// En el dashboard, ejecutar:
console.log('embedEnabled:', _cachedFeatures.embedEnabled);
console.log('adsEnabled:', _cachedFeatures.adsEnabled);
console.log('ADS card visible:', document.getElementById('ads-card').style.display !== 'none');
console.log('Custom domain visible:', document.getElementById('custom-domain-section').style.display !== 'none');
```

---

## 📚 Referencias

- **Documento principal**: `docs/EMBED-ADS-SYSTEM-MASTER.md`
- **Sistema de features**: `docs/HIERARCHICAL-FEATURES-SYSTEM.md`
- **Player features**: `docs/PLAYER-EMBED-FEATURES-BY-PLAN.md`
- **Dashboard JS**: `public/js/app-dashboard.js` (líneas 5303-5479)
