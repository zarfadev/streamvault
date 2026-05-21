# 🚀 Guía de Implementación - Sistema de Permisos por Features

## 📚 Referencia Rápida

### ¿Qué es este sistema?

Un sistema jerárquico que valida permisos en 3 niveles:

```
1. Configuración Global (Admin Panel)
   ↓ ON/OFF para TODO el sistema
   
2. Plan del Workspace (starter/pro/enterprise)
   ↓ Solo si Global=ON, el plan puede tenerlo
   
3. Usuario Final
   ↓ Ve solo lo que su plan permite
```

---

## 🔧 Uso en Backend (Rutas)

### Importar el Middleware

```javascript
const { checkFeature, hasFeature, getFeatureValue } = require('../middleware/checkFeature');
const requireWorkspace = require('../middleware/workspace');
const requireAuth = require('../middleware/auth');
```

### Aplicar en Rutas

```javascript
// ✅ Ejemplo 1: Proteger endpoint de webhooks
router.post('/api/webhooks', 
  requireAuth, 
  requireWorkspace,
  checkFeature('webhooks'),  // <-- Validación automática
  async (req, res) => {
    // Solo llega aquí si:
    // - Global webhooksEnabled = true
    // - Plan tiene webhooks = true
    
    // Tu lógica aquí...
    res.json({ ok: true });
  }
);

// ✅ Ejemplo 2: Proteger transcripciones
router.post('/api/transcriptions/:videoId', 
  requireAuth, 
  requireWorkspace,
  checkFeature('transcriptions'),
  async (req, res) => {
    // Lógica de transcripción...
  }
);

// ✅ Ejemplo 3: Proteger API Keys
router.get('/api/apikeys', 
  requireAuth, 
  requireWorkspace,
  checkFeature('apiKeys'),
  async (req, res) => {
    // Listar API keys...
  }
);

router.post('/api/apikeys', 
  requireAuth, 
  requireWorkspace,
  checkFeature('apiKeys'),
  async (req, res) => {
    // Crear API key...
  }
);

// ✅ Ejemplo 4: Audio/Subtítulos (tracks)
router.post('/api/videos/:videoId/tracks', 
  requireAuth, 
  requireWorkspace,
  checkFeature('tracks'),
  async (req, res) => {
    // Subir pista de audio o subtítulos...
  }
);
```

### Validación Condicional (dentro del handler)

Para lógica que depende de features pero no bloquea el endpoint:

```javascript
const { hasFeature, getFeatureValue } = require('../middleware/checkFeature');

router.get('/api/videos', requireAuth, requireWorkspace, async (req, res) => {
  const videos = await getVideos(req.workspace.id);
  
  // ✅ Agregar datos solo si el plan tiene analytics
  if (await hasFeature(req.workspace, 'analytics')) {
    const analytics = await getVideoAnalytics(videos);
    videos.forEach((v, i) => v.analytics = analytics[i]);
  }
  
  // ✅ Verificar nivel de analytics (basic vs full)
  const analyticsLevel = await getFeatureValue(req.workspace, 'analytics');
  if (analyticsLevel === 'full') {
    // Incluir métricas avanzadas...
  }
  
  res.json({ videos });
});
```

---

## 🎨 Uso en Frontend (UI)

### Obtener Features del Usuario

```javascript
// En app-dashboard.js, app-landing.js, etc.

// 1. Cargar settings que incluyen features
const r = await fetch('/api/settings');
const settings = await r.json();

// settings.features contiene solo los features habilitados
console.log(settings.features);
// { 
//   foldersEnabled: true, 
//   playlistsEnabled: true, 
//   webhooksEnabled: false,  // ← Plan starter no lo tiene
//   transcriptionsEnabled: true,
//   ...
// }
```

### Mostrar/Ocultar UI según Features

```javascript
// ✅ Ejemplo: Mostrar botón de webhooks solo si está habilitado
if (settings.features.webhooksEnabled) {
  document.getElementById('webhooks-btn').style.display = 'block';
} else {
  document.getElementById('webhooks-btn').style.display = 'none';
}

// ✅ Ejemplo: Mostrar sección de audio/subtítulos
if (settings.features.tracksEnabled) {
  document.getElementById('tracks-section').style.display = 'block';
}

// ✅ Ejemplo: Deshabilitar transcripciones con mensaje
const transcribeBtn = document.getElementById('transcribe-btn');
if (!settings.features.transcriptionsEnabled) {
  transcribeBtn.disabled = true;
  transcribeBtn.title = 'Tu plan no incluye transcripciones. Actualiza para acceder.';
  transcribeBtn.style.opacity = '0.5';
}
```

### Respuesta a Errores 403

```javascript
// Manejo de errores cuando el usuario intenta usar un feature no disponible

try {
  const r = await fetch('/api/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: '...' })
  });
  
  if (r.status === 403) {
    const error = await r.json();
    
    if (error.code === 'FEATURE_NOT_IN_PLAN') {
      // Mostrar modal de upgrade
      showUpgradeModal(error.currentPlan, 'webhooks');
    } else if (error.code === 'FEATURE_DISABLED_GLOBALLY') {
      toast('Esta funcionalidad está temporalmente deshabilitada', 'warning');
    }
  }
} catch (e) {
  toast('Error de conexión', 'error');
}
```

---

## 📝 Mapeo de Nombres

| Nombre UI | Global Key | Plan Key | Middleware |
|-----------|------------|----------|------------|
| Carpetas | `foldersEnabled` | `folders` | `checkFeature('folders')` |
| Playlists | `playlistsEnabled` | `playlists` | `checkFeature('playlists')` |
| Webhooks | `webhooksEnabled` | `webhooks` | `checkFeature('webhooks')` |
| Transcripciones | `transcriptionsEnabled` | `transcriptions` | `checkFeature('transcriptions')` |
| Links descarga | `downloadLinksEnabled` | `downloadLinks` | `checkFeature('downloadLinks')` |
| Watermark | `watermarkEnabled` | `watermark` | `checkFeature('watermark')` |
| Analytics | `analyticsEnabled` | `analytics` | `checkFeature('analytics')` |
| Bulk ops | `bulkOperationsEnabled` | `bulkOperations` | `checkFeature('bulkOperations')` |
| API Keys | `apiKeysEnabled` | `apiKeys` | `checkFeature('apiKeys')` |
| Audio/Subs | `tracksEnabled` | `tracks` | `checkFeature('tracks')` |
| Invitaciones | `invitationsEnabled` | `invitations` | `checkFeature('invitations')` |
| Referidos | `referralEnabled` | `referrals` | `checkFeature('referrals')` |

---

## ✅ Checklist de Implementación

Cuando agregues una nueva funcionalidad que debe estar controlada por planes:

### 1. Agregar a Definiciones (Admin Panel)

En `public/js/app-admin.js`:

```javascript
// Agregar a FEATURE_DEFS (features globales)
const FEATURE_DEFS = [
  // ... existentes
  { key: 'miNuevoFeatureEnabled', label: 'Mi Feature', desc: 'Descripción' },
];

// Agregar a PLAN_FEATURES (features por plan)
const PLAN_FEATURES = [
  // ... existentes
  { key: 'miNuevoFeature', label: 'Mi Feature', type: 'bool', globalKey: 'miNuevoFeatureEnabled' },
];
```

### 2. Actualizar Mapeo

En `middleware/checkFeature.js`:

```javascript
const FEATURE_NAME_MAP = {
  // ... existentes
  'miNuevoFeature': 'miNuevoFeatureEnabled',
};
```

### 3. Proteger Rutas

En tus archivos de rutas:

```javascript
const { checkFeature } = require('../middleware/checkFeature');

router.post('/api/mi-feature', 
  requireAuth, 
  requireWorkspace,
  checkFeature('miNuevoFeature'),
  async (req, res) => {
    // Tu lógica aquí
  }
);
```

### 4. Actualizar Frontend

En tu componente JS:

```javascript
// Verificar disponibilidad
const r = await fetch('/api/settings');
const settings = await r.json();

if (settings.features.miNuevoFeatureEnabled) {
  // Mostrar UI del feature
}
```

---

## 🎛️ Configuración de Planes (Admin)

### Acceder a la Configuración

1. Login como super_admin
2. Admin Panel → Planes
3. Selecciona el plan (Starter/Pro/Enterprise)

### Habilitar/Deshabilitar Features

```
┌────────────────────────────────────────┐
│ Plan Pro                               │
│                                        │
│ Features:                              │
│ ☑ Carpetas          (Global: ON)      │
│ ☑ Playlists         (Global: ON)      │
│ ☑ Webhooks          (Global: ON)      │
│ ☐ Transcripciones   (Global: OFF) ←   │
│ ☑ Links descarga    (Global: ON)      │
│ ...                                    │
│                                        │
│ [Guardar Plan Pro]                     │
└────────────────────────────────────────┘
```

**Nota:** Si `Global: OFF`, el checkbox del plan se deshabilita visualmente.

---

## 🔍 Debugging

### Ver Configuración Actual

```javascript
// En el navegador (consola de desarrollo)
fetch('/api/settings').then(r => r.json()).then(console.log);

// Resultado:
{
  siteName: "StreamVault",
  features: {
    foldersEnabled: true,
    playlistsEnabled: true,
    webhooksEnabled: false,  // ← Plan no lo tiene
    // ...
  }
}
```

### Ver Errores de Validación

Cuando una petición falla con 403:

```javascript
{
  "error": "Tu plan starter no incluye la funcionalidad \"webhooks\". Actualiza tu plan para acceder.",
  "code": "FEATURE_NOT_IN_PLAN",
  "requiredUpgrade": true,
  "currentPlan": "starter"
}
```

Códigos de error:
- `FEATURE_DISABLED_GLOBALLY` → Admin deshabilitó el feature
- `FEATURE_NOT_IN_PLAN` → Plan del usuario no lo incluye
- `WORKSPACE_REQUIRED` → Falta workspace en la petición
- `PERMISSION_CHECK_ERROR` → Error del sistema

---

## 🚨 Casos Especiales

### Analytics (basic vs full)

```javascript
// Analytics puede tener valores: 'basic' o 'full'
router.get('/api/analytics', requireAuth, requireWorkspace, async (req, res) => {
  const level = await getFeatureValue(req.workspace, 'analytics');
  
  if (level === 'full') {
    // Devolver analytics completos
    return res.json({ data: fullAnalytics });
  } else if (level === 'basic') {
    // Devolver analytics básicos
    return res.json({ data: basicAnalytics });
  } else {
    return res.status(403).json({ error: 'Analytics no disponible' });
  }
});
```

### Embed (branded, unbranded, custom)

```javascript
const embedType = await getFeatureValue(req.workspace, 'embed');

if (embedType === 'unbranded') {
  // Quitar marca de agua
} else if (embedType === 'custom') {
  // Permitir personalización completa
}
```

---

## 📚 Recursos Adicionales

- **Documentación completa:** `docs/SISTEMA-PERMISOS-PLAN.md`
- **Código del middleware:** `middleware/checkFeature.js`
- **Admin panel features:** `public/js/app-admin.js` (líneas 1022+)
- **Configuración dinámica:** `services/dynamicConfig.js`

---

## 💡 Tips

1. **Siempre aplica el middleware en el orden correcto:**
   ```javascript
   requireAuth → requireWorkspace → checkFeature → tu handler
   ```

2. **Para features opcionales, usa `hasFeature()` dentro del handler en vez del middleware**

3. **Actualiza el frontend para ocultar botones/opciones no disponibles**

4. **Muestra mensajes claros de "Actualiza tu plan" cuando corresponda**

5. **Tests:** Prueba con diferentes planes para validar el comportamiento

---

**¿Preguntas?** Revisa `docs/SISTEMA-PERMISOS-PLAN.md` para más detalles.
