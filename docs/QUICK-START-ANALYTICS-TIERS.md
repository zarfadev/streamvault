# 🚀 Guía Rápida: Analytics Tiers (Basic vs Full)

## ⚡ Inicio Rápido

### 1️⃣ Configurar Planes (Administrador)

```bash
# Acceder al panel de administración
open http://localhost:3000/admin#plans
```

**Configurar cada plan:**

1. Ve a la pestaña del plan (Starter / Pro / Enterprise)
2. Busca el campo **"Analytics"** (selector desplegable)
3. Selecciona el nivel:
   - **`basic`** → Analytics básico (total plays, unique viewers, geographic)
   - **`full`** → Analytics completo (+ retention, heatmaps, CSV export)
4. Clic en **"💾 Guardar Plan"**

### 2️⃣ Verificar Implementación

```bash
# Ejecutar tests automáticos
export ADMIN_TOKEN=$(node scripts/gen-admin-token.js | grep "^TOKEN:" | cut -d' ' -f2)
export VIDEO_ID=<tu-video-id>
./scripts/test-analytics-tiers.sh
```

### 3️⃣ Uso en el Frontend

El sistema detecta automáticamente el tier del usuario:

```javascript
// GET /api/videos/:videoId/analytics
{
  "tier": "basic",  // o "full"
  "uniqueViewers": 150,
  "totalPlays": 300,
  // ... datos básicos siempre presentes
  
  // Solo con tier "full":
  "retention": [...],
  "heatmaps": {...},
  "deviceBreakdown": {...}
}
```

---

## 📊 Diferencias entre Tiers

### Basic Analytics (Incluido en Starter)
✅ Total de reproducciones  
✅ Viewers únicos  
✅ Distribución geográfica básica  
✅ Picos de tráfico  
✅ Origen de tráfico (embed/direct)  

### Full Analytics (Pro/Enterprise)
✅ **Todo lo de Basic, más:**  
✅ Curvas de retención detalladas  
✅ Heatmaps de interacción  
✅ Análisis de dispositivos  
✅ Métricas de engagement  
✅ **CSV Export** (botón de descarga)  

---

## 🔒 Validación de Permisos

El sistema valida automáticamente:

```javascript
// CSV Export - Solo Full Analytics
GET /api/videos/:videoId/analytics/export.csv

// Si el usuario tiene tier "basic":
❌ 403 Forbidden
{
  "error": "Full Analytics required",
  "code": "ANALYTICS_FULL_REQUIRED"
}
```

---

## 🛠️ Configuración Recomendada

### Plan Starter ($9/mes)
```
analytics: "basic"
```
→ Analytics suficientes para creadores pequeños

### Plan Pro ($29/mes)
```
analytics: "full"
```
→ Analytics profesionales con todas las métricas

### Plan Enterprise ($99/mes)
```
analytics: "full"
```
→ Analytics completos + soporte prioritario

---

## 📝 Ejemplos de Configuración

### Ejemplo 1: Configurar plan Pro con Full Analytics

```bash
curl -X PUT http://localhost:3000/api/admin/plans-config/pro \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "features": {
      "analytics": "full"
    }
  }'
```

### Ejemplo 2: Obtener analytics de un video

```bash
# Usuario Starter (basic)
curl http://localhost:3000/api/videos/abc123/analytics \
  -H "Authorization: Bearer $USER_TOKEN"

# Respuesta incluye tier: "basic" y datos filtrados
```

---

## 🐛 Troubleshooting

### Problema: El tier no cambia después de actualizar el plan

**Solución:**
```bash
# 1. Verificar que el plan se guardó correctamente
curl http://localhost:3000/api/plans | jq '.pro.features.analytics'

# 2. El usuario debe cerrar sesión y volver a iniciar
# (el tier se calcula en cada request basado en el plan actual)
```

### Problema: CSV export muestra 403 pero debería funcionar

**Solución:**
```bash
# 1. Verificar el plan del usuario
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/settings | jq '.features.analytics'

# 2. Si muestra "basic", actualizar el plan en /admin
# 3. Recargar la página del dashboard
```

---

## 📚 Documentación Completa

Para más detalles, consulta:
- [ANALYTICS-EMBED-TIERS.md](./ANALYTICS-EMBED-TIERS.md) - Documentación técnica completa
- [HIERARCHICAL-FEATURES-SYSTEM.md](./HIERARCHICAL-FEATURES-SYSTEM.md) - Sistema de features

---

## ✅ Checklist de Implementación

- [x] Feature `analytics` agregado a `PLAN_FEATURES` con options `['basic', 'full']`
- [x] UI en `/admin#plans` renderiza select correctamente
- [x] Endpoint `/api/videos/:id/analytics` incluye campo `tier` en respuesta
- [x] Datos avanzados filtrados según tier del usuario
- [x] CSV export bloqueado para tier "basic" (403)
- [x] Tests automatizados en `scripts/test-analytics-tiers.sh`
- [x] Documentación completa creada

**🎉 Sistema totalmente funcional y listo para producción**
