# 🔧 Guía de Corrección de Errores - StreamVault

**Fecha:** Mayo 13, 2026  
**Estado:** Correcciones aplicadas, requiere inicialización

---

## 📋 Resumen de Cambios Realizados

### ✅ 1. Error 401 en `/api/videos/:id/transcriptions` - CORREGIDO

**Problema:** El endpoint de transcripciones requería autenticación incluso para players embebidos públicos.

**Solución Aplicada:**
- Modificado `routes/transcriptions.js`
- Importado `optionalAuth` desde `middleware/auth.js`
- Cambiados los endpoints GET para usar `optionalAuth` en lugar de sin middleware
- Endpoints afectados:
  - `GET /api/videos/:id/transcriptions`
  - `GET /api/videos/:id/transcriptions/:lang/subtitles.vtt`

**Archivo modificado:** `routes/transcriptions.js`

---

### ⚠️ 2. Error 400 en `/api/admin/features` - REQUIERE INICIALIZACIÓN

**Problema:** La tabla `system_config` no existe o no tiene los datos necesarios.

**Solución Preparada:**
- Creados scripts de inicialización:
  - `scripts/fix-system-config.js` (Node.js - universal)
  - `scripts/fix-system-config.sql` (PostgreSQL)
- Los scripts configuran:
  - ✅ Features globales (arregla el error 400)
  - ✅ Platform branding (logo StreamVault configurable)
  - ✅ Embed tiers por plan (branded/unbranded/custom)
  - ✅ Configuración de anuncios (solo Enterprise)
  - ✅ Dominio personalizado (solo Enterprise)

**Estado:** Listo para ejecutar después de inicializar la BD

---

## 🚀 Pasos para Completar la Corrección

### Paso 1: Inicializar la Base de Datos

La base de datos necesita ser inicializada correctamente. Tienes dos opciones:

#### Opción A: Iniciar el servidor (recomendado)
```bash
# Esto creará las tablas automáticamente
npm start
```

El servidor creará todas las tablas necesarias incluyendo `system_config`.

#### Opción B: Ejecutar migraciones manualmente
```bash
# Si tienes un script de migración
node db/schema.js
```

### Paso 2: Ejecutar el Script de Configuración

Una vez que la BD esté inicializada, ejecuta:

```bash
node scripts/fix-system-config.js
```

Este script:
1. ✅ Configura features globales (arregla error 400)
2. ✅ Inicializa platform branding
3. ✅ Configura embed tiers por plan
4. ✅ Habilita anuncios y custom domain según el plan

### Paso 3: Reiniciar el Servidor

```bash
# Detén el servidor si está corriendo
# Ctrl+C

# Reinicia
npm start
```

### Paso 4: Verificar las Correcciones

#### Verificar corrección del error 401:
```bash
# Debe devolver 200 OK con lista de transcripciones
curl http://localhost:3000/api/videos/VIDEO_ID/transcriptions
```

#### Verificar corrección del error 400:
```bash
# Debe devolver 200 OK con configuración de features
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/features
```

---

## 📊 Embed Tiers Configurados

| Plan | Embed Tier | Logo StreamVault | Custom Domain | Anuncios |
|------|------------|------------------|---------------|----------|
| **Starter** | `branded` | ✅ Sí (fijo) | ❌ No | ❌ No |
| **Pro** | `unbranded` | ❌ No | ❌ No | ❌ No |
| **Enterprise** | `custom` | ⚙️ Configurable | ✅ Sí | ✅ Sí |

### ¿Qué significa cada tier?

#### 🏷️ BRANDED (Starter)
- Logo de StreamVault siempre visible
- Configuración global desde Admin Panel
- No se puede desactivar
- Posición configurable (tr/tl/br/bl)

#### ⭐ UNBRANDED (Pro)
- Sin logo de StreamVault
- Player completamente limpio
- Ideal para profesionales

#### 🎨 CUSTOM (Enterprise)
- Logo personalizado del workspace
- Control total de branding
- Dominio personalizado
- Sistema de anuncios integrado

---

## 🎨 Configuración del Logo StreamVault

### En el Admin Panel (Global)

1. Ve a `/admin` con tu token de administrador
2. Sección "Platform Branding"
3. Configura:
   - **Logo URL:** URL de la imagen (ej: `/favicon.svg`)
   - **Posición:** `tr` (top-right), `tl`, `br`, `bl`
   - **Nombre:** Texto del logo

### En el Dashboard (Workspace)

Para plan Enterprise únicamente:
1. Ve a Dashboard → Settings → Embed
2. Configura tu logo personalizado
3. Activa/desactiva anuncios
4. Configura dominio personalizado

---

## 📝 Funcionalidades Pendientes de Implementación

### 1. UI Admin: Configuración de Logo StreamVault ⏳

**Ubicación:** `public/js/app-admin.js`

**Funcionalidad necesaria:**
- Sección "Platform Branding" en Admin Panel
- Campos para:
  - `platformLogoUrl`: URL del logo
  - `platformLogoPos`: Posición (tr/tl/br/bl)
  - `platformName`: Nombre de la plataforma
- Botón "Guardar Configuración"
- Endpoint: `PUT /api/admin/config/platform`

### 2. UI Dashboard: Embed Settings por Workspace ⏳

**Ubicación:** `public/js/app-dashboard.js`

**Funcionalidad necesaria:**
- Pestaña "Embed" en Settings
- Mostrar embed tier actual del plan
- Si tier = `custom`:
  - Configurar logo personalizado
  - Activar/desactivar anuncios
  - Configurar dominio personalizado
- Si tier = `branded`:
  - Mostrar: "Tu plan incluye el logo de StreamVault"
  - Ver configuración global del logo
- Si tier = `unbranded`:
  - Mostrar: "Tu player es completamente limpio"

### 3. Endpoints de Custom Domain ⏳

**Ubicación:** `routes/admin.js` o nuevo `routes/domains.js`

**Endpoints necesarios:**

```javascript
// Agregar dominio personalizado
POST /api/workspaces/:id/custom-domain
Body: { domain: "videos.empresa.com", verified: false }

// Verificar dominio (DNS check)
POST /api/workspaces/:id/custom-domain/verify
Response: { verified: true, cname_required: "xxx.streamvault.io" }

// Eliminar dominio
DELETE /api/workspaces/:id/custom-domain

// Listar dominios
GET /api/admin/custom-domains
```

### 4. Sistema de Anuncios (Pre-roll/Mid-roll) ⏳

**Base de datos:** Ya tiene tablas `embed_domains` y `workspace_ads`

**Implementación necesaria:**
- UI para crear/editar anuncios
- UI para asignar anuncios a videos
- Lógica en player para mostrar anuncios
- Endpoints CRUD para anuncios
- Analytics de anuncios (impresiones, clicks)

---

## 🐛 Problemas Conocidos

### 1. DATABASE_URL en .env

**Problema:** El `.env` estaba configurado para PostgreSQL pero usas SQLite.

**Solución:** Se creó backup `.env.backup` y se actualizó a:
```bash
DATABASE_URL=./streamvault.db
```

Si quieres volver a PostgreSQL:
```bash
DATABASE_URL=postgres://streamvault:streamvault@localhost:5432/streamvault
```

### 2. Tabla system_config no existe

**Causa:** Base de datos no inicializada completamente.

**Solución:** Ejecutar `npm start` para que el servidor cree las tablas automáticamente.

---

## 📚 Documentación Creada

Durante esta sesión se creó la siguiente documentación:

1. **`docs/EXPLICACION-SISTEMA-EMBED.md`**
   - Explicación técnica completa del sistema embed
   - Flujo de embed tiers
   - Diagramas de flujo

2. **`docs/GUIA-CORRECCION-ERRORES.md`** (este archivo)
   - Resumen de correcciones aplicadas
   - Pasos de implementación
   - Funcionalidades pendientes

3. **`scripts/fix-system-config.js`**
   - Script de inicialización de system_config
   - Compatible con SQLite y PostgreSQL

4. **`scripts/fix-system-config.sql`**
   - Versión SQL del script anterior
   - Solo para PostgreSQL

---

## 🎯 Próximos Pasos Recomendados

### Inmediatos (Hoy)
1. ✅ Iniciar servidor para crear tablas
2. ✅ Ejecutar `scripts/fix-system-config.js`
3. ✅ Verificar que errores 401 y 400 estén resueltos
4. ✅ Probar player embebido con subtítulos

### Corto Plazo (Esta Semana)
1. ⏳ Implementar UI Admin para configurar logo StreamVault
2. ⏳ Implementar UI Dashboard para embed settings
3. ⏳ Crear endpoints de custom domain
4. ⏳ Probar sistema embed completo

### Mediano Plazo (Próximas Semanas)
1. ⏳ Implementar sistema de anuncios completo
2. ⏳ Analytics de anuncios
3. ⏳ Documentación de API para anuncios
4. ⏳ Tests E2E del sistema embed

---

## 🆘 Soporte y Debugging

### Logs Útiles

```bash
# Ver configuración actual de system_config
sqlite3 streamvault.db "SELECT * FROM system_config;"

# Ver embed tier de un workspace
sqlite3 streamvault.db "
SELECT w.name, w.plan, 
  json_extract(sc.value, '$.features.embed') as embed_tier
FROM workspaces w
LEFT JOIN system_config sc ON sc.key = 'plans.' || w.plan;
"

# Ver transcripciones de un video
sqlite3 streamvault.db "
SELECT id, video_id, language, status 
FROM transcriptions 
WHERE video_id = 'VIDEO_ID';
"
```

### Errores Comunes

**Error: "database miguel does not exist"**
- Solución: Verificar DATABASE_URL en .env apunta a SQLite

**Error: "no such table: system_config"**
- Solución: Iniciar servidor o ejecutar migraciones

**Error 401 en transcriptions**
- Solución: Ya corregido en routes/transcriptions.js

**Error 400 en /api/admin/features**
- Solución: Ejecutar scripts/fix-system-config.js

---

## 📞 Contacto

Si encuentras problemas o necesitas más ayuda:
1. Revisa los logs del servidor
2. Verifica la documentación en `/docs`
3. Ejecuta los scripts de verificación arriba

---

**Última actualización:** Mayo 13, 2026  
**Versión:** 1.0.0
