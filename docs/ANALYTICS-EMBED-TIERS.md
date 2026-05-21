# 📊 Sistema de Niveles: Analytics y Embed

## 🎯 Resumen

Este documento describe la implementación de niveles diferenciados para las funcionalidades de **Analytics** y **Embed**, permitiendo ofrecer experiencias distintas según el plan del usuario.

---

## 📈 Analytics: Basic vs Full

### **Basic Analytics** (`analytics: 'basic'`)
Métricas esenciales para usuarios en planes básicos:
- ✅ Vistas únicas (unique viewers)
- ✅ Reproducciones totales (total plays)
- ✅ Tasa de finalización (completion rate)
- ✅ Tiempo promedio de visualización (avg watch time)
- ✅ Porcentaje de visualización (avg watch time %)
- ❌ **NO incluye**: Curvas de retención, heatmaps, gráficos diarios, breakdown por dispositivo/navegador/país, exportación CSV

### **Full Analytics** (`analytics: 'full'` o `analytics: true`)
Métricas avanzadas para planes Pro y Enterprise:
- ✅ **Todo lo de Basic**, más:
- ✅ Curvas de retención (retention curves)
- ✅ Heatmaps de reproducciones (top segments)
- ✅ Puntos de abandono (drop-off points)
- ✅ Gráficos de reproducciones diarias (daily plays)
- ✅ Breakdown por dispositivo (desktop/mobile/tablet)
- ✅ Breakdown por navegador (Chrome/Firefox/Safari/etc)
- ✅ Breakdown por país (top 10 países)
- ✅ **Exportación CSV** con datos completos de eventos

### Implementación Técnica

#### **Backend: `routes/analytics.js`**
```javascript
// Al obtener analytics, se verifica el nivel
const analyticsLevel = req.featureValue || 'basic';
const isFullAnalytics = (analyticsLevel === true || analyticsLevel === 'full');

// La respuesta incluye un campo 'tier'
const result = {
  videoId: vid,
  duration,
  days,
  tier: isFullAnalytics ? 'full' : 'basic',
  // Métricas básicas siempre presentes
  uniqueViewers,
  totalPlays,
  completionRate,
  avgWatchTime,
  avgWatchTimePct,
};

// Métricas avanzadas solo si es Full
if (isFullAnalytics) {
  Object.assign(result, {
    eventCounts,
    retention,
    topSegments,
    dropOffs,
    dailyPlays,
    deviceBreakdown,
    browserBreakdown,
    countryBreakdown,
  });
}
```

#### **CSV Export Restringido**
```javascript
// GET /api/videos/:videoId/analytics/export.csv
// Solo disponible para Full Analytics
if (!isFullAnalytics) {
  return res.status(403).json({ 
    error: 'CSV export requiere plan con Analytics Completo', 
    code: 'ANALYTICS_FULL_REQUIRED',
    tier: 'basic'
  });
}
```

#### **Frontend: Mostrar UI según nivel**
```javascript
// En el dashboard de analytics
fetch(`/api/videos/${videoId}/analytics`)
  .then(r => r.json())
  .then(data => {
    if (data.tier === 'basic') {
      // Mostrar solo métricas básicas
      // Ocultar tabs de retención, heatmaps, geo
      // Mostrar badge "Actualiza a Pro para más métricas"
    } else {
      // Mostrar todas las métricas avanzadas
    }
  });
```

---

## 🎬 Embed: Branded, Unbranded, Custom

### **Branded** (`embed: 'branded'`)
Reproductor con marca "Powered by StreamVault":
- ✅ Watermark visible "Powered by StreamVault"
- ✅ Posición: bottom-right
- ✅ Opacidad: 0.4
- ❌ No personalizable

### **Unbranded** (`embed: 'unbranded'`)
Reproductor sin marca visible:
- ✅ Sin watermark obligatorio
- ✅ Logo del workspace (si está configurado)
- ✅ Colores personalizables del workspace
- ❌ No permite watermark personalizado por video

### **Custom** (`embed: 'custom'` o `embed: true`)
Control total del branding:
- ✅ Sin watermark obligatorio de plataforma
- ✅ Logo del workspace personalizable
- ✅ Colores personalizables
- ✅ **Watermark personalizado por video** (texto dinámico, posición, opacidad)
- ✅ Dominio personalizado para embeds

### Implementación Técnica

#### **Backend: Enviar embedLevel al player**

En `routes/videos.js`, en el endpoint que devuelve información del video para el player:

```javascript
// GET /api/videos/:id (o el endpoint que use el player)
const { getFeatureValue } = require('../middleware/checkFeature');

// Dentro del endpoint
const embedLevel = await getFeatureValue(workspace, 'embed');

res.json({
  video: {
    id: video.id,
    title: video.title,
    // ... otros campos
  },
  embedConfig: {
    level: embedLevel || 'branded', // 'branded', 'unbranded', 'custom'
    color: workspace.settings?.embedColor || '#7c6cfa',
    logo: workspace.settings?.embedLogo || '',
    // Watermark solo disponible en 'custom'
    watermarkEnabled: embedLevel === 'custom' && workspace.settings?.watermark_enabled,
    watermarkText: workspace.settings?.watermark_text || '',
    watermarkPosition: workspace.settings?.watermark_position || 'bottom-right',
    watermarkOpacity: workspace.settings?.watermark_opacity || 0.3,
  },
});
```

#### **Frontend: Player detecta nivel y aplica watermark**

En `public/js/app-player.js`:

```javascript
// Al cargar el video
async function initPlayer() {
  const response = await fetch(`/api/videos/${videoId}`);
  const data = await response.json();
  
  const embedConfig = data.embedConfig || {};
  const embedLevel = embedConfig.level || 'branded';
  
  // Aplicar watermark según nivel
  if (embedLevel === 'branded') {
    // Watermark obligatorio de plataforma
    createPlatformWatermark();
  } else if (embedLevel === 'unbranded') {
    // Sin watermark (solo logo del workspace si existe)
    if (embedConfig.logo) {
      applyWorkspaceLogo(embedConfig.logo);
    }
  } else if (embedLevel === 'custom') {
    // Watermark personalizado si está habilitado
    if (embedConfig.watermarkEnabled && embedConfig.watermarkText) {
      createCustomWatermark(
        embedConfig.watermarkText,
        embedConfig.watermarkPosition,
        embedConfig.watermarkOpacity
      );
    }
    if (embedConfig.logo) {
      applyWorkspaceLogo(embedConfig.logo);
    }
  }
}

function createPlatformWatermark() {
  const el = document.createElement('div');
  el.id = 'sv-platform-watermark';
  el.textContent = 'Powered by StreamVault';
  el.style.cssText = `
    position: absolute;
    bottom: 60px;
    right: 16px;
    font-size: 11px;
    color: rgba(255,255,255,0.4);
    font-family: 'DM Sans', sans-serif;
    pointer-events: none;
    z-index: 100;
    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  `;
  document.querySelector('.player-wrap').appendChild(el);
}

function createCustomWatermark(text, position, opacity) {
  // Código existente de watermark personalizado
  // Ya implementado en app-player.js y app-embed.js
}
```

---

## 🔧 Configuración en Admin Panel

### **Vista de Configuración de Plan**

En `public/admin/index.html` y `public/js/app-admin.js`:

```javascript
// Features con opciones múltiples
const ADVANCED_FEATURES = [
  { 
    key: 'analytics',
    label: 'Analytics',
    type: 'select',
    options: ['basic', 'full'],
    descriptions: {
      basic: 'Métricas básicas (vistas, tiempo de reproducción, tasa de finalización)',
      full: 'Métricas avanzadas (retention, heatmaps, geo, dispositivos, exportación CSV)'
    }
  },
  { 
    key: 'embed',
    label: 'Player Embed',
    type: 'select',
    options: ['branded', 'unbranded', 'custom'],
    descriptions: {
      branded: 'Con watermark "Powered by StreamVault"',
      unbranded: 'Sin watermark de plataforma, logo del workspace permitido',
      custom: 'Control total: watermark personalizado, dominio propio'
    }
  },
];

// En el formulario de configuración de plan
function renderFeatureConfig(planFeatures) {
  ADVANCED_FEATURES.forEach(ft => {
    const value = planFeatures[ft.key] || ft.options[0];
    const select = document.createElement('select');
    select.id = `plan-${ft.key}`;
    
    ft.options.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      option.selected = (value === opt);
      select.appendChild(option);
    });
    
    // Mostrar descripción de la opción seleccionada
    const desc = document.createElement('div');
    desc.className = 'feature-desc';
    desc.textContent = ft.descriptions[value];
    
    // ... agregar al DOM
  });
}
```

---

## 📋 Configuración por Plan (Recomendado)

### **Starter / Free**
```json
{
  "analytics": "basic",
  "embed": "branded"
}
```

### **Pro**
```json
{
  "analytics": "full",
  "embed": "unbranded"
}
```

### **Enterprise**
```json
{
  "analytics": "full",
  "embed": "custom"
}
```

---

## 🧪 Testing

### **Probar Analytics Levels**

```bash
# Como usuario con Basic Analytics
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.streamvault.com/api/videos/VIDEO_ID/analytics"

# Respuesta incluirá:
{
  "tier": "basic",
  "uniqueViewers": 150,
  "totalPlays": 200,
  "completionRate": 75.5,
  "avgWatchTime": 180,
  "avgWatchTimePct": 60.0
  // NO incluye: retention, topSegments, deviceBreakdown, etc.
}

# Intentar exportar CSV con Basic Analytics
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.streamvault.com/api/videos/VIDEO_ID/analytics/export.csv"

# Respuesta:
{
  "error": "CSV export requiere plan con Analytics Completo",
  "code": "ANALYTICS_FULL_REQUIRED",
  "tier": "basic"
}
```

### **Probar Embed Levels**

```bash
# Verificar nivel de embed en la respuesta del video
curl "https://api.streamvault.com/api/videos/VIDEO_ID"

{
  "video": { ... },
  "embedConfig": {
    "level": "branded",  // o "unbranded" o "custom"
    "color": "#7c6cfa",
    "logo": "",
    "watermarkEnabled": false
  }
}
```

---

## 🚀 Migración de Datos Existentes

Los planes existentes que tienen `analytics: true` o `embed: true` seguirán funcionando:

```javascript
// En middleware/checkFeature.js
const isFullAnalytics = (analyticsLevel === true || analyticsLevel === 'full');
const isCustomEmbed = (embedLevel === true || embedLevel === 'custom');
```

**Compatibilidad:**
- `analytics: true` → Tratado como `'full'`
- `analytics: false` → Tratado como deshabilitado
- `analytics: 'basic'` → Nivel básico
- `analytics: 'full'` → Nivel completo

Lo mismo aplica para `embed`.

---

## 📝 Notas Adicionales

### **Caché de Analytics**
- Las respuestas de analytics se cachean por 5 minutos
- El campo `tier` se incluye en el cache, por lo que cambiar el plan de un usuario requiere esperar la expiración del cache o invalidarlo manualmente

### **Watermark Forense**
- El watermark forense (invisible, anti-piratería) es independiente del nivel de embed
- Siempre está activo en `player-security.js` para todos los niveles
- Solo el watermark **visible** depende del nivel de embed

### **Actualización de Plan**
Cuando un usuario actualiza su plan:
1. El backend actualiza `workspace.plan`
2. El middleware `checkFeature` resuelve los nuevos valores de `analytics` y `embed`
3. La próxima llamada a analytics devuelve el nuevo `tier`
4. El player al recargar aplica el nuevo `embedConfig.level`

---

## 🔗 Archivos Modificados

- ✅ `routes/analytics.js` - Filtrado de datos según tier
- ✅ `middleware/checkFeature.js` - Ya soporta valores string como 'basic'/'full'
- 📝 `routes/videos.js` - Necesita enviar `embedConfig.level` al player
- 📝 `public/js/app-player.js` - Necesita aplicar watermark según nivel
- 📝 `public/js/app-admin.js` - UI para configurar niveles
- 📝 `public/admin/index.html` - Formularios actualizados

---

**Versión:** 1.0  
**Fecha:** Diciembre 2026  
**Autor:** StreamVault Team
