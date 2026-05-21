# 🎯 Sistema Jerárquico de Features (Global → Plan)

## 📋 Descripción General

StreamVault implementa un **sistema jerárquico de permisos** en dos niveles que permite un control granular sobre qué funcionalidades están disponibles en el sistema y para cada plan de suscripción.

### Flujo de Validación

```
┌─────────────────────────────────────────────────────────────┐
│ Usuario intenta usar Feature X                              │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ ❶ ¿Feature X está habilitado GLOBALMENTE?                  │
│    (system_config.features.{featureName})                   │
└────────────┬─────────────────────────┬──────────────────────┘
             │ NO                      │ SÍ
             ▼                         ▼
        ❌ RECHAZAR            ┌──────────────────────────────┐
                               │ ❷ ¿Plan del workspace        │
                               │    incluye Feature X?        │
                               │ (plans.{plan}.features.{f})  │
                               └────┬──────────────────┬──────┘
                                    │ NO               │ SÍ
                                    ▼                  ▼
                               ❌ RECHAZAR        ✅ PERMITIR
```

---

## 🏗️ Arquitectura del Sistema

### Nivel 1: Configuración Global
**Clave en DB:** `system_config.features`

Controla qué funcionalidades están **activadas para toda la plataforma**. Si una feature está deshabilitada aquí, **ningún plan podrá usarla** sin importar su configuración individual.

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
  "tracksEnabled": true,
  "invitationsEnabled": true,
  "referralEnabled": true,
  "multiWorkspaceEnabled": true
}
```

### Nivel 2: Configuración por Plan
**Claves en DB:** `system_config.plans.{starter|pro|enterprise}`

Define qué funcionalidades están **disponibles para cada plan de suscripción**. Un plan solo puede usar features que estén habilitadas globalmente.

---

## 📊 Planes Configurados

### 🌱 Plan Starter
```json
{
  "name": "Starter",
  "price": 19,
  "maxVideos": 25,
  "maxStorageGB": 50,
  "features": {
    "folders": true,
    "playlists": true,
    "embed": "branded",
    "analytics": "basic",
    "subtitles": false,          // ❌ Sin subtítulos IA
    "apiKeys": false,             // ❌ Sin API Keys
    "webhooks": false,            // ❌ Sin webhooks
    "transcriptions": false,      // ❌ Sin transcripciones
    "watermark": false,           // ❌ Sin watermark
    "bulkOperations": false,      // ❌ Sin operaciones en lote
    "invitations": false,         // ❌ Sin invitaciones
    "multiWorkspace": false       // ❌ Solo 1 workspace
  }
}
```

### ⚡ Plan Pro
```json
{
  "name": "Pro",
  "price": 59,
  "highlighted": true,
  "badge": "Más popular",
  "maxVideos": 200,
  "maxStorageGB": 500,
  "features": {
    "folders": true,
    "playlists": true,
    "embed": "unbranded",         // ✅ Sin marca StreamVault
    "analytics": "full",          // ✅ Analytics completo
    "subtitles": true,            // ✅ Subtítulos IA
    "apiKeys": true,              // ✅ API Keys
    "webhooks": true,             // ✅ Webhooks HMAC
    "transcriptions": true,       // ✅ Transcripciones Whisper
    "watermark": true,            // ✅ Watermark personalizado
    "bulkOperations": true,       // ✅ Operaciones en lote
    "invitations": true,          // ✅ Invitar miembros
    "multiWorkspace": false,      // ❌ Solo 1 workspace
    "prioritySupport": true       // ✅ Soporte prioritario
  }
}
```

### 👑 Plan Enterprise
```json
{
  "name": "Enterprise",
  "price": 99,
  "maxVideos": -1,              // ∞ Sin límite
  "maxWorkspaces": 10,
  "maxMembers": 50,
  "features": {
    "embed": "custom",          // ✅ Embed completamente custom
    "analytics": "full",
    "multiWorkspace": true,     // ✅ Múltiples workspaces
    "customDomain": true,       // ✅ Dominio personalizado
    "prioritySupport": true,
    // ... todas las demás features en true
  }
}
```

---

## 🔧 Endpoints de API

### Gestión de Features Globales

#### `GET /api/admin/features`
Obtiene la configuración global de features.

```bash
curl -H "Authorization: Bearer TOKEN" \
     http://localhost:3000/api/admin/features
```

**Respuesta:**
```json
{
  "success": true,
  "features": {
    "foldersEnabled": true,
    "webhooksEnabled": true,
    "transcriptionsEnabled": true,
    ...
  }
}
```

#### `PUT /api/admin/features`
Actualiza features globales.

```bash
curl -X PUT \
     -H "Authorization: Bearer TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"transcriptionsEnabled": false, "webhooksEnabled": true}' \
     http://localhost:3000/api/admin/features
```

### Gestión de Plans

#### `GET /api/admin/plans-config`
Obtiene configuración de todos los planes.

```bash
curl -H "Authorization: Bearer TOKEN" \
     http://localhost:3000/api/admin/plans-config
```

#### `PUT /api/admin/plans-config/:planName`
Actualiza configuración de un plan específico.

```bash
curl -X PUT \
     -H "Authorization: Bearer TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Pro",
       "price": 49,
       "maxVideos": 250,
       "features": {
         "webhooks": true,
         "transcriptions": true,
         "analytics": "full"
       }
     }' \
     http://localhost:3000/api/admin/plans-config/pro
```

---

## 🎨 Interfaz de Administración

El Admin Panel incluye una interfaz visual para gestionar el sistema jerárquico:

### Panel de Features Globales
```
┌──────────────────────────────────────────────────┐
│ 🌐 Features Globales del Sistema                 │
├──────────────────────────────────────────────────┤
│ ☑ Carpetas                    [Habilitado]       │
│ ☑ Playlists                   [Habilitado]       │
│ ☑ Webhooks                    [Habilitado]       │
│ ☑ Transcripciones IA          [Habilitado]       │
│ ☑ Links de descarga           [Habilitado]       │
│ ☑ Watermark                   [Habilitado]       │
│ ☑ Analytics                   [Habilitado]       │
│ ☐ Bulk Operations             [Deshabilitado]    │
└──────────────────────────────────────────────────┘
```

### Panel de Planes
```
┌──────────────────────────────────────────────────┐
│ 📋 Configuración de Planes                       │
├──────────────────────────────────────────────────┤
│ ► Starter  ► Pro  ► Enterprise                   │
├──────────────────────────────────────────────────┤
│ Plan: Pro                      Precio: $59/mes   │
│                                                   │
│ Límites:                                          │
│   • Videos: 200                                   │
│   • Storage: 500 GB                               │
│   • Bandwidth: 1000 GB                            │
│                                                   │
│ Features:                                         │
│   ☑ Analytics completo                            │
│   ☑ Subtítulos IA                                 │
│   ☑ API Keys                                      │
│   ☑ Webhooks                                      │
│   ☐ Múltiples workspaces                          │
└──────────────────────────────────────────────────┘
```

---

## 🔒 Middleware de Validación

El middleware `checkFeature` en `/middleware/checkFeature.js` se encarga de validar el acceso a features:

```javascript
// Ejemplo de uso en rutas
router.post('/webhooks', 
  authenticate, 
  checkFeature('webhooks'), 
  async (req, res) => {
    // Solo llega aquí si:
    // 1. webhooksEnabled = true (global)
    // 2. Plan del workspace tiene webhooks: true
  }
);
```

### Lógica de Validación

```javascript
async function checkFeature(featureName) {
  // 1. Verificar feature global
  const globalFeatures = await getConfig('features', {});
  if (globalFeatures[featureName + 'Enabled'] === false) {
    return res.status(403).json({ 
      error: 'Feature deshabilitada globalmente' 
    });
  }

  // 2. Verificar feature en plan
  const workspace = await getWorkspace(workspaceId);
  const planConfig = await getConfig(`plans.${workspace.plan}`, {});
  const planFeatures = planConfig.features || {};
  
  if (planFeatures[featureName] !== true) {
    return res.status(403).json({ 
      error: 'Feature no disponible en tu plan',
      upgradeRequired: true 
    });
  }

  next(); // ✅ Permitir acceso
}
```

---

## 📚 Casos de Uso Comunes

### Caso 1: Deshabilitar feature globalmente

**Escenario:** Deshabilitar transcripciones mientras se resuelve un problema con Whisper.

```sql
UPDATE system_config 
SET value = jsonb_set(
  value::jsonb, 
  '{transcriptionsEnabled}', 
  'false'::jsonb
)::text,
updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE key = 'features';
```

**Resultado:** NINGÚN usuario podrá usar transcripciones, independientemente de su plan.

### Caso 2: Habilitar feature solo en plan Pro

**Escenario:** Añadir webhooks como feature exclusiva de Pro.

```sql
UPDATE system_config
SET value = jsonb_set(
  value::jsonb, 
  '{features,webhooks}', 
  'true'::jsonb
)::text,
updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE key = 'plans.pro';
```

**Resultado:** Solo usuarios en plan Pro podrán usar webhooks.

### Caso 3: Migrar feature de Pro a Starter

**Escenario:** Hacer que API Keys esté disponible también en Starter.

```sql
-- Habilitar en Starter
UPDATE system_config
SET value = jsonb_set(
  value::jsonb, 
  '{features,apiKeys}', 
  'true'::jsonb
)::text
WHERE key = 'plans.starter';
```

---

## ⚠️ Consideraciones Importantes

### 1. Jerarquía Estricta
```
Global OFF → Plan ON = ❌ Feature bloqueada
Global ON  → Plan OFF = ❌ Feature bloqueada
Global ON  → Plan ON = ✅ Feature permitida
```

### 2. Features con Valores Especiales

Algunas features no son booleanas:

```javascript
{
  "embed": "branded" | "unbranded" | "custom",
  "analytics": "basic" | "full"
}
```

### 3. Cache y Rendimiento

Las configuraciones se cachean en memoria para evitar consultas repetidas a la BD. El cache se invalida automáticamente al actualizar configuraciones.

### 4. Retrocompatibilidad

El sistema es completamente retrocompatible. Si no existe configuración de plan, se usan los valores por defecto del archivo `config.js`.

---

## 🧪 Testing

### Verificar configuración actual

```bash
# Features globales
psql -U streamvault -d streamvault \
  -c "SELECT key, value FROM system_config WHERE key = 'features';"

# Plan Pro
psql -U streamvault -d streamvault \
  -c "SELECT key, value FROM system_config WHERE key = 'plans.pro';"
```

### Probar endpoint

```bash
# Como usuario en plan Starter intentando usar webhooks (debería fallar)
curl -X POST \
     -H "Authorization: Bearer STARTER_USER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://example.com/webhook"}' \
     http://localhost:3000/api/webhooks

# Respuesta esperada:
# {
#   "error": "Feature no disponible en tu plan",
#   "upgradeRequired": true
# }
```

---

## 📖 Referencias

- **Migración:** `db/migrations/005_hierarchical_features_system.sql`
- **Endpoints:** `routes/admin.js` (líneas 1184-1367)
- **Middleware:** `middleware/checkFeature.js`
- **Servicio:** `services/dynamicConfig.js`
- **Documentación relacionada:**
  - `docs/SISTEMA-PERMISOS-PLAN.md`
  - `docs/CUSTOM-PERMISSIONS-FREE-PLANS.md`
  - `docs/GUIA-IMPLEMENTACION-FEATURES.md`

---

## 🚀 Roadmap Futuro

- [ ] UI visual en Admin Panel para gestionar features
- [ ] Logs de auditoría para cambios de configuración
- [ ] Webhooks cuando se cambian features
- [ ] Notificaciones a usuarios cuando se habilita/deshabilita feature
- [ ] A/B testing de features por workspace
- [ ] Feature flags temporales (time-limited)

---

**Última actualización:** 2026-05-11  
**Versión:** 1.0.0  
**Autor:** StreamVault Team
