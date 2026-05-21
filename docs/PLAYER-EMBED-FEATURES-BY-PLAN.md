# 🎯 Sistema de Características del Player Embed por Plan

## 📋 Resumen

Este documento explica cómo funcionan las características del player embed, anuncios y dominio personalizado según el plan del usuario.

---

## 🎨 Tiers del Player Embed

### 1️⃣ **Starter (Branded)**
- **embedEnabled**: `'branded'`
- ✅ Embed básico disponible
- ⚠️ **Logo de StreamVault visible** en el player
- ❌ No puede personalizar logo
- ❌ No puede configurar nombre del player
- ❌ **Sin acceso a configuración de anuncios**
- ❌ Sin dominio personalizado

### 2️⃣ **Pro (Unbranded)**
- **embedEnabled**: `'unbranded'`
- ✅ Embed sin marca StreamVault
- ✅ Puede configurar logo personalizado
- ❌ No puede configurar nombre del player
- ✅ **Acceso completo a configuración de anuncios** (VAST, Banner HTML, Popup)
- ❌ Sin dominio personalizado

### 3️⃣ **Enterprise (Custom)**
- **embedEnabled**: `'custom'`
- ✅ Embed totalmente personalizable
- ✅ Puede configurar logo personalizado
- ✅ Puede configurar nombre del player
- ✅ **Acceso completo a configuración de anuncios** (VAST, Banner HTML, Popup)
- ✅ **Dominio personalizado para embeds**

---

## 📊 Tabla de Características por Plan

| Característica | Starter (Branded) | Pro (Unbranded) | Enterprise (Custom) |
|---|:---:|:---:|:---:|
| **Embed disponible** | ✅ | ✅ | ✅ |
| **Logo StreamVault** | ✅ Visible | ❌ Oculto | ❌ Oculto |
| **Logo personalizado** | ❌ | ✅ | ✅ |
| **Nombre del player** | ❌ | ❌ | ✅ |
| **Configuración de anuncios** | ❌ | ✅ | ✅ |
| **VAST (video ads)** | ❌ | ✅ | ✅ |
| **Banner HTML** | ❌ | ✅ | ✅ |
| **Popup overlay** | ❌ | ✅ | ✅ |
| **Dominio personalizado** | ❌ | ❌ | ✅ |

---

## 🔧 Lógica de Implementación

### En `applyFeatureFlags()` (líneas 5376-5475)

```javascript
const embedVal = f.embedEnabled; // 'branded' | 'unbranded' | 'custom' | false

// 1. Embed card visibility
if (embedVal === false) {
  // Mostrar mensaje de "Embed no disponible"
} else {
  // Mostrar badge según tier
  // Configurar campos según tier
}

// 2. Logo URL field
if (embedVal === 'branded') {
  // Ocultar campo de logo (no puede personalizar)
} else {
  // Mostrar campo de logo (unbranded y custom)
}

// 3. Player name field
if (embedVal === 'custom') {
  // Mostrar campo de nombre (solo Enterprise)
} else {
  // Ocultar campo
}

// 4. ADS configuration card
if (adsEnabled === false) {
  showAds = false; // Explícitamente desactivado
} else if (adsEnabled === true || adsEnabled === 'full') {
  showAds = true; // Explícitamente activado
} else {
  // Regla por defecto: ADS solo en Pro y Enterprise
  showAds = (embedVal === 'unbranded' || embedVal === 'custom');
}

// 5. Custom Domain section
if (embedVal === 'custom') {
  // Mostrar sección (solo Enterprise)
} else {
  // Ocultar sección
}
```

---

## 🚨 Problema Identificado y Solución

### ❌ **Problema Actual (líneas 5458-5461)**

```javascript
else {
  // Sin definir: mostrar si el plan tiene acceso a embed
  showAds = embedVal === 'branded' || embedVal === 'unbranded' || embedVal === 'custom';
}
```

Esta lógica **incluye incorrectamente** el plan Starter (branded) en el acceso a ADS.

### ✅ **Solución Correcta**

```javascript
else {
  // Sin definir: mostrar solo en Pro y Enterprise
  showAds = (embedVal === 'unbranded' || embedVal === 'custom');
}
```

---

## 📝 Configuración de Features en la Base de Datos

### Plan Starter (Branded)
```json
{
  "embedEnabled": "branded",
  "adsEnabled": false
}
```

### Plan Pro (Unbranded)
```json
{
  "embedEnabled": "unbranded",
  "adsEnabled": true
}
```

### Plan Enterprise (Custom)
```json
{
  "embedEnabled": "custom",
  "adsEnabled": "full",
  "customDomainEnabled": true
}
```

---

## 🎯 IDs de Elementos HTML

```html
<!-- Embed configuration card -->
<div id="embed-code-card">
  <div id="embed-normal-content">
    <!-- Badge del tier -->
    <span id="embed-tier-badge">BRANDED / UNBRANDED / CUSTOM</span>
    
    <!-- Información del tier -->
    <div id="embed-tier-info">Tu plan incluye...</div>
    
    <!-- Campos de personalización básicos -->
    <div id="embed-logo-group">
      <!-- Campo de logo URL (oculto en branded) -->
    </div>
    
    <!-- Campos avanzados (solo custom) -->
    <div id="embed-custom-fields">
      <div id="embed-player-name-group">
        <!-- Campo de nombre del player -->
      </div>
    </div>
  </div>
</div>

<!-- ADS configuration card -->
<div id="ads-card">
  <!-- Configuración de VAST, Banner, Popup -->
</div>

<!-- Custom domain section -->
<div id="custom-domain-section">
  <!-- Configuración de dominio personalizado -->
</div>
```

---

## 🔍 Verificación de Features

### Desde el Dashboard

1. **Iniciar sesión** en el dashboard
2. Ir a **Settings → General**
3. Verificar que aparezcan las siguientes cards según el plan:
   - **Embed Code** (todos los planes con embed)
   - **Anuncios en el Player** (solo Pro y Enterprise)
   - **Dominio Personalizado** (solo Enterprise)

### Desde la Consola del Navegador

```javascript
// Ver features del workspace actual
console.log(authWorkspace.features);

// Verificar tier de embed
console.log('Embed tier:', authWorkspace.features.embedEnabled);

// Verificar si ADS está disponible
console.log('ADS disponible:', authWorkspace.features.adsEnabled);
```

---

## 📚 Documentos Relacionados

- `EMBED-ADS-SYSTEM-MASTER.md` - Sistema completo de anuncios
- `HIERARCHICAL-FEATURES-SYSTEM.md` - Sistema jerárquico de características
- `SISTEMA-EMBED-COMPLETO-FINAL.md` - Documentación del sistema embed
- `ANALYTICS-EMBED-TIERS.md` - Tiers de analytics y embed

---

## ✅ Checklist de Verificación

- [ ] Plan Starter muestra badge "BRANDED"
- [ ] Plan Starter NO muestra card de ADS
- [ ] Plan Starter NO muestra campo de logo
- [ ] Plan Pro muestra badge "UNBRANDED"
- [ ] Plan Pro muestra card de ADS
- [ ] Plan Pro muestra campo de logo
- [ ] Plan Enterprise muestra badge "CUSTOM"
- [ ] Plan Enterprise muestra card de ADS
- [ ] Plan Enterprise muestra campo de logo
- [ ] Plan Enterprise muestra campo de nombre del player
- [ ] Plan Enterprise muestra sección de dominio personalizado

---

*Última actualización: 13/05/2026*
