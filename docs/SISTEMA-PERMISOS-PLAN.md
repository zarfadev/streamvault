# 🔐 Sistema de Permisos por Plan - StreamVault

## 📋 Funcionalidades Reales de StreamVault

### ✅ Features Implementadas y Funcionales

| Feature | Nombre Global | Descripción | Dónde está |
|---------|---------------|-------------|------------|
| **Carpetas** | `foldersEnabled` | Organización de videos en carpetas | ✅ Implementado |
| **Playlists** | `playlistsEnabled` | Playlists y embed de playlist | ✅ Implementado |
| **Webhooks** | `webhooksEnabled` | Webhooks con firma HMAC | ✅ Implementado |
| **Transcripciones** | `transcriptionsEnabled` | Subtítulos automáticos con Whisper | ✅ Implementado |
| **Links de descarga** | `downloadLinksEnabled` | Links firmados temporales | ✅ Implementado |
| **Watermark** | `watermarkEnabled` | Marca de agua CSS en el player | ✅ Implementado |
| **Analytics** | `analyticsEnabled` | Métricas de reproducción y geografía | ✅ Implementado |
| **Operaciones masivas** | `bulkOperationsEnabled` | Operaciones masivas sobre videos | ✅ Implementado |
| **API Keys** | `apiKeysEnabled` | Gestión de API keys del workspace | ✅ Implementado |
| **Referidos** | `referralEnabled` | Programa de referidos con código | ✅ Implementado |
| **Audio/Subtítulos** | `tracksEnabled` | Gestión de pistas de audio y subtítulos | ✅ Implementado |
| **Invitaciones** | `invitationsEnabled` | Invitar miembros al workspace | ✅ Implementado |
| **Múltiples Workspaces** | `multiWorkspaceEnabled` | Crear varios workspaces | ✅ Implementado |

### ❌ Features que NO Existen (a eliminar)

| Feature | Estado |
|---------|--------|
| `customDomain` | ❌ NO implementado - **ELIMINAR** |
| `prioritySupport` | ❌ NO implementado - **ELIMINAR** |

## 🏗️ Arquitectura del Sistema de Permisos

### Jerarquía de Validación

```
┌─────────────────────────────────────────────────┐
│  1. Configuración Global (Admin)                │
│     ↓ ON/OFF para TODO el sistema               │
├─────────────────────────────────────────────────┤
│  2. Permisos por Plan (starter/pro/enterprise)  │
│     ↓ Solo si Global=ON, el plan puede tenerlo  │
├─────────────────────────────────────────────────┤
│  3. Usuario final                               │
│     ↓ Ve solo lo que su plan permite            │
└─────────────────────────────────────────────────┘
```

### Lógica de Validación

```javascript
function canUseFeature(user, feature) {
  // 1. Verificar si está habilitado globalmente
  if (!global.features[feature]) return false;
  
  // 2. Verificar si el plan del usuario lo incluye
  if (!user.plan.features[feature]) return false;
  
  // 3. Feature disponible
  return true;
}
```

## 🎯 Estructura de Datos

### system_config.features (Global)
```json
{
  "foldersEnabled": true,
  "playlistsEnabled": true,
  "webhooksEnabled": true,
  "transcriptionsEnabled": true,
  "downloadLinksEnabled": true,
  "watermarkEnabled": true,
  "analyticsEnabled": true,
  "bulkOperationsEnabled": true,
  "apiKeysEnabled": true,
  "referralEnabled": true,
  "tracksEnabled": true,
  "invitationsEnabled": true,
  "multiWorkspaceEnabled": true
}
```

### system_config.plans.starter (Plan Starter)
```json
{
  "name": "Starter",
  "price": 0,
  "features": {
    "folders": false,
    "playlists": true,
    "webhooks": false,
    "transcriptions": false,
    "downloadLinks": false,
    "watermark": true,
    "analytics": "basic",
    "bulkOperations": false,
    "apiKeys": false,
    "referrals": false,
    "tracks": false,
    "invitations": false,
    "multiWorkspace": false,
    "embed": "branded"
  }
}
```

### system_config.plans.pro (Plan Pro)
```json
{
  "name": "Pro",
  "price": 15,
  "features": {
    "folders": true,
    "playlists": true,
    "webhooks": true,
    "transcriptions": true,
    "downloadLinks": true,
    "watermark": true,
    "analytics": "full",
    "bulkOperations": true,
    "apiKeys": true,
    "referrals": true,
    "tracks": true,
    "invitations": true,
    "multiWorkspace": true,
    "embed": "unbranded"
  }
}
```

### system_config.plans.enterprise (Plan Enterprise)
```json
{
  "name": "Enterprise",
  "price": 99,
  "features": {
    "folders": true,
    "playlists": true,
    "webhooks": true,
    "transcriptions": true,
    "downloadLinks": true,
    "watermark": true,
    "analytics": "full",
    "bulkOperations": true,
    "apiKeys": true,
    "referrals": true,
    "tracks": true,
    "invitations": true,
    "multiWorkspace": true,
    "embed": "custom"
  }
}
```

## 📝 Mapeo de Nombres

Para mantener consistencia:

| Nombre UI | Global (system_config.features) | Plan (plan.features) | Backend Check |
|-----------|----------------------------------|----------------------|---------------|
| Carpetas | `foldersEnabled` | `folders` | `foldersEnabled && plan.features.folders` |
| Playlists | `playlistsEnabled` | `playlists` | `playlistsEnabled && plan.features.playlists` |
| Webhooks | `webhooksEnabled` | `webhooks` | `webhooksEnabled && plan.features.webhooks` |
| Transcripciones | `transcriptionsEnabled` | `transcriptions` | `transcriptionsEnabled && plan.features.transcriptions` |
| Links descarga | `downloadLinksEnabled` | `downloadLinks` | `downloadLinksEnabled && plan.features.downloadLinks` |
| Watermark | `watermarkEnabled` | `watermark` | `watermarkEnabled && plan.features.watermark` |
| Analytics | `analyticsEnabled` | `analytics` | `analyticsEnabled && plan.features.analytics` |
| Bulk ops | `bulkOperationsEnabled` | `bulkOperations` | `bulkOperationsEnabled && plan.features.bulkOperations` |
| API Keys | `apiKeysEnabled` | `apiKeys` | `apiKeysEnabled && plan.features.apiKeys` |
| Referidos | `referralEnabled` | `referrals` | `referralEnabled && plan.features.referrals` |
| Audio/Subs | `tracksEnabled` | `tracks` | `tracksEnabled && plan.features.tracks` |
| Invitaciones | `invitationsEnabled` | `invitations` | `invitationsEnabled && plan.features.invitations` |
| Multi WS | `multiWorkspaceEnabled` | `multiWorkspace` | `multiWorkspaceEnabled && plan.features.multiWorkspace` |

## 🎨 UI del Admin Panel

### Pestaña "Features Globales"
```
┌──────────────────────────────────────────────────┐
│ Features del Sistema                             │
│                                                   │
│ ☑ Carpetas                                       │
│   Organización de videos en carpetas             │
│                                                   │
│ ☑ Playlists                                      │
│   Playlists y embed de playlist                  │
│                                                   │
│ ☑ Webhooks                                       │
│   Webhooks con firma HMAC                        │
│                                                   │
│ ...                                              │
│                                                   │
│ [Guardar Configuración Global]                   │
└──────────────────────────────────────────────────┘
```

### Pestaña "Planes" → Plan Starter
```
┌──────────────────────────────────────────────────┐
│ Plan Starter                                     │
│                                                   │
│ Límites:                                         │
│ • Videos: 50                                     │
│ • Almacenamiento: 10 GB                          │
│ • Ancho de banda: 50 GB                          │
│                                                   │
│ Features (solo si Global=ON):                    │
│ ☐ Carpetas          (Global: ON)                 │
│ ☑ Playlists         (Global: ON)                 │
│ ☐ Webhooks          (Global: ON)                 │
│ ☐ Transcripciones   (Global: OFF) ← Deshabilitado│
│ ☐ Links descarga    (Global: ON)                 │
│ ...                                              │
│                                                   │
│ [Guardar Plan Starter]                           │
└──────────────────────────────────────────────────┘
```

## 🔒 Validación en Backend

### middleware/checkFeature.js
```javascript
async function checkFeature(featureName) {
  return async (req, res, next) => {
    // 1. Verificar si feature está habilitado globalmente
    const globalEnabled = await getDynConfig(
      `features.${featureName}Enabled`, 
      true
    );
    
    if (!globalEnabled) {
      return res.status(403).json({ 
        error: 'Esta funcionalidad está deshabilitada en el sistema' 
      });
    }
    
    // 2. Verificar si el plan del usuario lo incluye
    const workspace = req.workspace;
    const plan = await getPlanConfig(workspace.plan);
    
    const planFeatureKey = featureNameToPlanKey(featureName);
    const planEnabled = plan.features[planFeatureKey];
    
    if (!planEnabled) {
      return res.status(403).json({ 
        error: 'Tu plan no incluye esta funcionalidad. Actualiza para acceder.' 
      });
    }
    
    next();
  };
}

// Uso en rutas
router.post('/api/webhooks', 
  requireAuth, 
  checkFeature('webhooks'), 
  async (req, res) => { ... }
);
```

## 📊 Casos de Uso

### Caso 1: Admin desactiva Transcripciones globalmente
```
1. Admin → Configuración → Features → ☐ Transcripciones → Guardar
2. Resultado: NINGÚN usuario puede usar transcripciones
3. En planes, la opción aparece deshabilitada visualmente
```

### Caso 2: Plan Starter no tiene Webhooks
```
1. Usuario con plan Starter intenta crear webhook
2. Backend verifica:
   - Global: webhooksEnabled = true ✅
   - Plan: webhooks = false ❌
3. Resultado: Error 403 "Tu plan no incluye esta funcionalidad"
```

### Caso 3: Upgrade de Starter a Pro
```
1. Usuario actualiza plan de Starter → Pro
2. Se desbloquean automáticamente:
   - Carpetas
   - Webhooks
   - Transcripciones
   - API Keys
   - Bulk Operations
   - etc.
3. Si alguno está Global=OFF, sigue sin verse
```

## 🚀 Plan de Implementación

1. ✅ Actualizar `FEATURE_DEFS` (eliminar customDomain, prioritySupport)
2. ✅ Actualizar `PLAN_FEATURES` con nombres consistentes
3. ✅ Crear middleware `checkFeature`
4. ✅ Actualizar UI del admin para mostrar jerarquía
5. ✅ Migrar datos existentes
6. ✅ Actualizar validaciones en rutas
7. ✅ Documentar para desarrolladores

---

Este sistema garantiza control total y consistencia en toda la aplicación.
