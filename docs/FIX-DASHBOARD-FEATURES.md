# 🔧 Corrección: Sistema de Features del Dashboard

## 📋 Problema Identificado

El dashboard tiene **dos sistemas de features incompatibles** que causan que la configuración de anuncios y dominio personalizado no funcione correctamente.

### ❌ Código Problemático

```javascript
// Línea 6230-6278 en app-dashboard.js
// Esta función usa nombres incorrectos de features
async function() {
  const features = await checkPlanFeatures(); // ¿De dónde viene esto?
  
  // ❌ Usa nombres que NO existen en el sistema
  features.player_ads       // Debería ser: adsEnabled
  features.remove_branding  // Debería ser: embedEnabled === 'unbranded'
  features.custom_domain    // Debería ser: embedEnabled === 'custom'
}
```

### ✅ Código Correcto

```javascript
// Línea 5215 en app-dashboard.js
async function applyFeatureFlags() {
  const f = d.features || {};
  
  // ✅ Usa nombres correctos del sistema
  f.embedEnabled      // 'branded' | 'unbranded' | 'custom' | false
  f.analyticsEnabled  // false | 'basic' | 'full'
  f.adsEnabled        // boolean
}
```

## 🎯 Solución

### 1. Eliminar código duplicado (líneas 6230-6278)

Esta función no hace nada útil y usa nomenclatura incorrecta.

### 2. Expandir applyFeatureFlags() para incluir ADS

Agregar la lógica de ADS y dominio personalizado en la función principal.

### 3. Nomenclatura Correcta de Features

Según la documentación del sistema:

| Feature UI | Nombre en Sistema | Valores Posibles |
|------------|-------------------|------------------|
| Player Embed | `embedEnabled` | `false`, `'branded'`, `'unbranded'`, `'custom'` |
| Analytics | `analyticsEnabled` | `false`, `'basic'`, `'full'` |
| Anuncios | `adsEnabled` | `boolean` |
| Dominio Custom | parte de `embedEnabled === 'custom'` | N/A |
| Logo Custom | disponible si `embedEnabled !== 'branded'` | N/A |

## 📝 Implementación

### Paso 1: Eliminar función duplicada

Remover líneas 6230-6278 que contienen la función con nomenclatura incorrecta.

### Paso 2: Expandir applyFeatureFlags()

Agregar después de la línea 5357 (antes del cierre del bloque else de embedEnabled):

```javascript
// ── Ads configuration ────────────────────────────────────────────────
// adsEnabled controla si el workspace puede configurar anuncios
const adsSection = document.getElementById('ads-config-section');
if (adsSection) {
  // Los anuncios solo están disponibles si:
  // 1. La feature está habilitada globalmente (adsEnabled = true)
  // 2. Y el plan lo permite
  if (f.adsEnabled === true) {
    adsSection.style.display = 'block';
  } else {
    adsSection.style.display = 'none';
  }
}

// ── Custom Domain ────────────────────────────────────────────────────
// Solo disponible en tier 'custom' (Enterprise)
const customDomainSection = document.getElementById('custom-domain-section');
if (customDomainSection) {
  customDomainSection.style.display = (embedVal === 'custom') ? 'block' : 'none';
}
```

### Paso 3: Actualizar configuración de planes

Asegurarse de que los planes tengan la feature `adsEnabled` configurada:

```sql
-- Actualizar system_config para incluir adsEnabled
UPDATE system_config 
SET config = json_set(config, '$.features.adsEnabled', json('true'))
WHERE key = 'features';

-- Configurar adsEnabled por plan
-- Starter: NO tiene anuncios
-- Pro: SÍ tiene anuncios
-- Enterprise: SÍ tiene anuncios

-- Para actualizar un plan específico via admin panel
```

## 🧪 Testing

### Verificar que funciona:

1. **Plan Starter (Branded)**:
   - ✅ Debe ver embed con logo de StreamVault
   - ❌ NO debe ver sección de ADS
   - ❌ NO debe ver sección de dominio personalizado
   - ❌ NO debe ver campo de logo personalizado

2. **Plan Pro (Unbranded)**:
   - ✅ Debe ver embed sin logo de StreamVault
   - ✅ Debe ver campo de logo personalizado
   - ✅ Debe ver sección de ADS (si adsEnabled = true)
   - ❌ NO debe ver sección de dominio personalizado

3. **Plan Enterprise (Custom)**:
   - ✅ Debe ver todos los campos de personalización
   - ✅ Debe ver campo de logo personalizado
   - ✅ Debe ver campo de nombre del player
   - ✅ Debe ver sección de ADS
   - ✅ Debe ver sección de dominio personalizado

## 📚 Referencias

- Sistema de Features: `/docs/HIERARCHICAL-FEATURES-SYSTEM.md`
- Sistema de Embed: `/docs/EMBED-ADS-SYSTEM-MASTER.md`
- Sistema de Analytics: `/docs/ANALYTICS-EMBED-TIERS.md`
