# Permisos Personalizados y Planes Gratuitos

## 📋 Resumen

Esta guía documenta dos nuevas funcionalidades implementadas en StreamVault:

1. **Permisos personalizados por workspace** - Permite ajustar límites específicos para workspaces individuales
2. **Planes gratuitos (precio = 0)** - Workspaces con planes de costo $0 no requieren pasarela de pago

---

## 🎯 Permisos Personalizados para Workspaces

### Descripción

Los administradores pueden ahora aplicar límites personalizados a workspaces específicos que sobrescriben los límites del plan base. Esto es útil para:

- Clientes corporativos con necesidades especiales
- Acuerdos personalizados
- Promociones temporales
- Testing y desarrollo

### Uso desde la API

#### Aplicar límites personalizados

```bash
PUT /api/admin/workspaces/:workspaceId
Authorization: Bearer <super_admin_token>
Content-Type: application/json

{
  "custom_limits": {
    "maxVideos": 500,
    "maxStorageGB": 1000,
    "maxBandwidthGB": 2000
  }
}
```

#### Remover límites personalizados (volver a defaults del plan)

```bash
PUT /api/admin/workspaces/:workspaceId
Authorization: Bearer <super_admin_token>
Content-Type: application/json

{
  "custom_limits": null
}
```

### Ejemplo de uso

```javascript
// Dar 500 videos a un workspace específico
await fetch('/api/admin/workspaces/abc-123', {
  method: 'PUT',
  headers: {
    'Authorization': 'Bearer ' + adminToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    custom_limits: {
      maxVideos: 500,
      maxStorageGB: 1000,
      maxBandwidthGB: 2000
    }
  })
});
```

### Validaciones

- `maxVideos`: -1 (ilimitado) o 0-100,000
- `maxStorageGB`: 0-100,000 GB
- `maxBandwidthGB`: 0-100,000 GB

### Almacenamiento

Los límites personalizados se almacenan en:
- **Columna**: `workspaces.custom_limits` (JSON)
- **Formato**: `{"maxVideos": 500, "maxStorageGB": 1000, "maxBandwidthGB": 2000}`

Cuando se aplican límites personalizados, también se actualizan las columnas `max_videos`, `max_storage_bytes`, y `max_bandwidth_bytes` para mantener compatibilidad.

---

## 💰 Planes Gratuitos (Precio = 0)

### Descripción

Los planes con `price: 0` en la configuración se activan **inmediatamente sin requerir pasarela de pago**. Esto permite:

- Plan Starter gratuito
- Períodos de prueba sin tarjeta
- Planes promocionales
- Desarrollo y testing

### Configuración

#### En config.js:

```javascript
plans: {
  starter: {
    name: 'Starter',
    price: 0,  // ← Plan gratuito (sin pasarela)
    maxVideos: 25,
    maxStorageGB: 50,
    maxBandwidthGB: 100,
    // ...
  },
  pro: {
    name: 'Pro',
    price: 59,  // ← Plan pago (requiere pasarela)
    // ...
  }
}
```

#### O dinámicamente desde Admin Panel:

```bash
PUT /api/admin/config
Content-Type: application/json

{
  "section": "plans",
  "data": {
    "starter": {
      "price": 0,
      "maxVideos": 25,
      "maxStorageGB": 50,
      "maxBandwidthGB": 100
    }
  }
}
```

### Flujo de activación

#### Plan gratuito (price = 0):

```
Usuario → POST /api/billing/checkout { plan: "starter" }
         ↓
    ¿Precio = 0?
         ↓ Sí
    Aplicar plan inmediatamente
         ↓
    Respuesta: { success: true, isFree: true, plan: "starter" }
```

#### Plan pago (price > 0):

```
Usuario → POST /api/billing/checkout { plan: "pro", provider: "stripe" }
         ↓
    ¿Precio > 0?
         ↓ Sí
    Crear sesión de pago con Stripe/PayPal/Binance
         ↓
    Respuesta: { checkoutUrl: "https://checkout.stripe.com/...", sessionId: "..." }
```

### Ejemplo de activación de plan gratuito

```bash
curl -X POST https://streamvault.com/api/billing/checkout \
  -H "Authorization: Bearer <user_token>" \
  -H "Content-Type: application/json" \
  -H "X-Workspace-ID: <workspace_id>" \
  -d '{
    "plan": "starter"
  }'

# Respuesta inmediata (sin redirección a pasarela):
{
  "success": true,
  "isFree": true,
  "plan": "starter",
  "message": "Plan Starter activado exitosamente (gratuito)",
  "limits": {
    "maxVideos": 25,
    "maxStorageBytes": 53687091200,
    "maxBandwidthBytes": 107374182400
  }
}
```

### Frontend: Detección de planes gratuitos

```javascript
// En el frontend, detectar si un plan es gratuito
const planConfig = await fetch('/api/plans').then(r => r.json());

if (planConfig.starter.price === 0) {
  // Mostrar botón "Activar Gratis" en lugar de "Contratar"
  button.textContent = 'Activar Gratis';
  button.onclick = async () => {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-ID': workspaceId },
      body: JSON.stringify({ plan: 'starter' })
    });
    const data = await res.json();
    if (data.success && data.isFree) {
      alert('¡Plan gratuito activado!');
      location.reload();
    }
  };
}
```

### Sin facturación

Los planes gratuitos:
- ❌ No crean `payment_subscription_id`
- ❌ No crean `payment_customer_id`
- ❌ No generan facturas
- ❌ No requieren webhook de pasarela
- ✅ Se registran en `subscription_events` con `provider: 'free'`
- ✅ Mantienen audit trail completo

---

## 🗄️ Migración de Base de Datos

### Ejecutar migración

```bash
# La migración se ejecuta automáticamente al iniciar el servidor
# O manualmente:
npm run migrate
```

### SQL de migración

```sql
-- Migration 003: Custom workspace permissions and free plan support
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS custom_limits TEXT DEFAULT NULL;

COMMENT ON COLUMN workspaces.custom_limits IS 'JSON object with custom overrides for workspace limits. NULL means use plan defaults.';

CREATE INDEX IF NOT EXISTS idx_workspaces_custom_limits 
  ON workspaces(custom_limits) 
  WHERE custom_limits IS NOT NULL;
```

---

## 🔍 Casos de uso

### Caso 1: Cliente corporativo con necesidades especiales

```javascript
// Cliente "Acme Corp" necesita 1000 videos en plan Pro
await fetch('/api/admin/workspaces/acme-corp-workspace-id', {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    custom_limits: {
      maxVideos: 1000,        // En lugar de 200 del plan Pro
      maxStorageGB: 2000,     // En lugar de 500 del plan Pro
      maxBandwidthGB: 5000    // En lugar de 1000 del plan Pro
    }
  })
});
```

### Caso 2: Promoción temporal

```javascript
// Dar 3 meses de almacenamiento extra durante promoción
await fetch('/api/admin/workspaces/promo-user-workspace-id', {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    custom_limits: {
      maxStorageGB: 750  // Plan Pro normalmente tiene 500 GB
    }
  })
});

// Después de 3 meses, remover límites custom:
await fetch('/api/admin/workspaces/promo-user-workspace-id', {
  method: 'PUT',
  headers: { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    custom_limits: null  // Vuelve a límites del plan
  })
});
```

### Caso 3: Plan Starter gratuito para todos

```javascript
// En config.js o Admin Panel, configurar:
{
  plans: {
    starter: {
      name: 'Starter',
      price: 0,  // ← GRATIS
      maxVideos: 25,
      maxStorageGB: 50,
      maxBandwidthGB: 100
    }
  }
}

// Los usuarios pueden activar Starter sin tarjeta:
POST /api/billing/checkout { "plan": "starter" }
// → Activación inmediata, sin redirección a Stripe
```

---

## 📊 Auditoría

Todos los cambios se registran en `audit_log`:

```sql
SELECT * FROM audit_log 
WHERE action IN ('workspace.custom_limits_changed', 'workspace.plan_changed')
ORDER BY created_at DESC;
```

Eventos de planes gratuitos:

```sql
SELECT * FROM subscription_events 
WHERE provider = 'free'
ORDER BY created_at DESC;
```

---

## ⚠️ Consideraciones

### Permisos personalizados
- Solo Super Admins pueden modificar `custom_limits`
- Los límites custom se mantienen incluso si cambia el plan
- Para remover, enviar `custom_limits: null`

### Planes gratuitos
- Verificar siempre `price === 0` en el código frontend/backend
- No intentar crear sesión de pago si es gratuito
- Los planes gratuitos no tienen fecha de expiración
- Se puede cambiar un plan de gratuito a pago actualizando la configuración

---

## 🚀 Próximos pasos

1. ✅ Migración ejecutada automáticamente
2. ✅ Backend actualizado (routes/admin.js, routes/billing.js)
3. 🔄 Actualizar frontend admin panel para UI de custom limits (opcional)
4. 🔄 Actualizar landing page para detectar planes gratuitos (opcional)

---

## 📞 Soporte

Para dudas o problemas:
- Revisar logs: `services/logger`
- Verificar audit trail: `SELECT * FROM audit_log WHERE action LIKE '%workspace%' OR action LIKE '%plan%'`
- Consultar esta documentación

---

**Última actualización**: 2026-01-05  
**Versión**: 1.0.0
