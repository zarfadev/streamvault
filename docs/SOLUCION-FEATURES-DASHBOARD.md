# Solución: Features de Dashboard según Plan

## 📋 Diagnóstico del Problema

Basándome en las capturas de pantalla proporcionadas, he identificado que el sistema de restricción de features según el plan **está implementado correctamente en el código JavaScript**, pero hay un **desajuste entre los IDs que busca el JavaScript y los que existen en el HTML**.

### 🔍 Análisis del Código

#### JavaScript (`app-dashboard.js`)
La función `applyFeatureFlags()` (líneas 5301-5475) maneja correctamente las restricciones:

```javascript
// ── Ads configuration (líneas 5445-5463)
const adsCard = document.getElementById('ads-card');
if (adsCard) {
  const adsEnabled = f.adsEnabled;
  let showAds;
  if (adsEnabled === false) {
    showAds = false;
  } else if (adsEnabled === true || adsEnabled === 'full') {
    showAds = true;
  } else {
    // Sin definir: mostrar si el plan tiene acceso a embed
    showAds = embedVal === 'branded' || embedVal === 'unbranded' || embedVal === 'custom';
  }
  adsCard.style.display = showAds ? '' : 'none';
}

// ── Custom Domain (líneas 5465-5470)
const customDomainSection = document.getElementById('custom-domain-section');
if (customDomainSection) {
  customDomainSection.style.display = (embedVal === 'custom') ? 'block' : 'none';
}
```

#### HTML (`public/dashboard/index.html`)
Los elementos tienen IDs diferentes o faltan por completo:

**✓ Existen:**
- `ads-card` (línea ~3200+)
- `custom-domain-card` (línea ~3300+) ⚠️ **Nota:** El JS busca `custom-domain-section`
- `embed-tier-badge`
- `embed-tier-info`
- `embed-normal-content`

**✗ No existen (buscados por JS):**
- `custom-domain-section` (el HTML usa `custom-domain-card`)
- `embed-custom-fields`
- `embed-logo-group`
- `embed-player-name-group`

## 🎯 Problema Identificado

El sistema de features **funciona correctamente** para:
- ✅ Navegación (Analytics, Playlists)
- ✅ Cards de configuración (Webhooks, Watermark, API Keys, Referrals)
- ✅ Transcripciones
- ✅ Operaciones bulk
- ✅ Folders
- ✅ Tarjeta de ADS

**Pero NO funciona correctamente para:**
- ❌ **Dominio Personalizado**: Busca `custom-domain-section` pero existe `custom-domain-card`
- ❌ **Campos personalizados de embed**: Busca `embed-custom-fields` que no existe
- ❌ **Logo group**: Busca `embed-logo-group` que no existe
- ❌ **Player name group**: Busca `embed-player-name-group` que no existe

## ✅ Solución Propuesta

### Opción 1: Corregir IDs en HTML (Recomendada)
Modificar `public/dashboard/index.html` para que los IDs coincidan con lo que busca el JavaScript.

### Opción 2: Corregir JavaScript
Modificar `app-dashboard.js` para buscar los IDs que existen en el HTML.

**Recomiendo la Opción 1** porque el código JavaScript está bien estructurado y sigue una convención clara.

## 🔧 Implementación de la Solución

### Cambios Necesarios en `public/dashboard/index.html`:

#### 1. Cambiar `custom-domain-card` → `custom-domain-section`
```html
<!-- ANTES -->
<div class="settings-card stab-hidden" id="custom-domain-card">

<!-- DESPUÉS -->
<div class="settings-card stab-hidden" id="custom-domain-section">
```

#### 2. Agregar wrapper `embed-custom-fields` para campos personalizables
Envolver los campos de personalización del embed (nombre del player, logo, color) en un div:

```html
<!-- DESPUÉS del embed-tier-info -->
<div id="embed-custom-fields">
  <!-- Campos de personalización aquí -->
</div>
```

#### 3. Agregar ID `embed-logo-group` al form-group del logo
```html
<div class="form-group" id="embed-logo-group" style="margin-bottom:14px;">
  <label for="cfg-logo-url">...</label>
  <!-- contenido del logo -->
</div>
```

#### 4. Agregar ID `embed-player-name-group` al form-group del nombre
```html
<div class="form-group" id="embed-player-name-group" style="margin-bottom:14px;">
  <label for="cfg-player-name">Nombre del player</label>
  <!-- contenido del nombre -->
</div>
```

## 📊 Comportamiento Esperado por Plan

### Plan Starter (Branded)
- ✅ Embed básico con marca StreamVault
- ❌ Sin configuración de ADS
- ❌ Sin dominio personalizado
- ❌ Sin personalización de logo/nombre

### Plan Pro (Unbranded)
- ✅ Embed sin marca StreamVault
- ✅ Configuración de ADS
- ✅ Logo personalizado
- ❌ Sin nombre de player personalizado
- ❌ Sin dominio personalizado

### Plan Enterprise (Custom)
- ✅ Embed completamente personalizable
- ✅ Configuración de ADS
- ✅ Logo personalizado
- ✅ Nombre de player personalizado
- ✅ **Dominio personalizado para embed**
- ✅ Color de acento personalizado

## 🔐 Lógica de Restricción

```javascript
// Embed tiers
embedEnabled: false     → Sin acceso a embed
embedEnabled: 'branded' → Starter: con marca StreamVault
embedEnabled: 'unbranded' → Pro: sin marca
embedEnabled: 'custom'  → Enterprise: totalmente personalizable

// ADS
adsEnabled: false → No disponible
adsEnabled: true  → Disponible (Pro+)

// Custom Domain
Solo disponible cuando embedEnabled === 'custom' (Enterprise)
```

## 📝 Notas Importantes

1. **La lógica del sistema es correcta** - Solo hay un problema de sincronización entre IDs
2. **No hay bugs en la función `applyFeatureFlags()`** - Funciona como debe
3. **El sistema jerárquico de features está bien implementado**
4. **Solo se necesitan ajustes en el HTML** para que coincida con el JavaScript

## 🚀 Próximos Pasos

1. Aplicar los cambios en `public/dashboard/index.html`
2. Verificar que los elementos se muestren/oculten correctamente según el plan
3. Probar con diferentes planes (Starter, Pro, Enterprise)
4. Verificar que la configuración de ADS solo aparezca en planes Pro+
5. Verificar que el dominio personalizado solo aparezca en Enterprise

---

**Fecha**: 13/05/2026
**Autor**: Análisis del sistema StreamVault
**Prioridad**: Media (funcionalidad parcial, no crítica)
