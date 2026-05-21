# 💳 Multi-Gateway Payment System - Guía Completa de Configuración

StreamVault ahora soporta **3 proveedores de pago**:
- **Stripe** - Tarjetas globalmente (Visa, Mastercard, Amex)
- **PayPal** - PayPal + tarjetas + PSE (Colombia)
- **Binance Pay** - Criptomonedas (USDT, BTC, BUSD)

---

## 📋 Tabla de Contenidos

1. [Instalación de Dependencias](#1-instalación-de-dependencias)
2. [Migración de Base de Datos](#2-migración-de-base-de-datos)
3. [Configuración de Stripe](#3-configuración-de-stripe)
4. [Configuración de PayPal](#4-configuración-de-paypal)
5. [Configuración de Binance Pay](#5-configuración-de-binance-pay)
6. [Webhooks](#6-configuración-de-webhooks)
7. [Cron Jobs (Binance)](#7-cron-jobs-para-binance-pay)
8. [Testing](#8-testing)
9. [Producción](#9-deployment-en-producción)

---

## 1. Instalación de Dependencias

```bash
npm install @paypal/checkout-server-sdk axios
```

Las nuevas dependencias son:
- `@paypal/checkout-server-sdk` - SDK oficial de PayPal
- `axios` - HTTP client para Binance Pay API (ya podría estar instalado)

---

## 2. Migración de Base de Datos

### Ejecutar migración SQL

```bash
# PostgreSQL
psql -U postgres -d streamvault -f db/migrations/001_multi_gateway.sql

# O desde psql shell
\i db/migrations/001_multi_gateway.sql
```

### Verificar cambios

```sql
-- Ver nuevas columnas
\d workspaces

-- Debe mostrar:
-- payment_provider (TEXT)
-- payment_customer_id (TEXT)
-- payment_subscription_id (TEXT)
-- payment_metadata (TEXT)
```

### Rollback (si es necesario)

```sql
-- Restaurar backup
SELECT * FROM workspaces_stripe_backup;

-- O eliminar columnas nuevas
ALTER TABLE workspaces DROP COLUMN payment_provider;
ALTER TABLE workspaces DROP COLUMN payment_customer_id;
ALTER TABLE workspaces DROP COLUMN payment_subscription_id;
ALTER TABLE workspaces DROP COLUMN payment_metadata;
```

---

## 3. Configuración de Stripe

### 3.1. Variables de Entorno (.env)

```bash
# Stripe (ya existentes)
STRIPE_SECRET_KEY=sk_test_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx

# Prices (IDs de los planes)
STRIPE_PRICE_STARTER=price_xxxxx
STRIPE_PRICE_PRO=price_xxxxx
STRIPE_PRICE_ENTERPRISE=price_xxxxx
```

### 3.2. Webhook URL

```
https://tu-dominio.com/api/billing/webhooks/stripe
```

**Eventos a subscribir:**
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
- `invoice.paid`

---

## 4. Configuración de PayPal

### 4.1. Crear Cuenta de Desarrollador

1. Ve a: https://developer.paypal.com/
2. Crea una app en el Dashboard
3. Obtén `Client ID` y `Client Secret`

### 4.2. Crear Productos y Planes

En el dashboard de PayPal:

**Producto: StreamVault Starter**
```
Name: StreamVault Starter Plan
Type: Digital goods
Category: Software
```

**Plan de Suscripción:**
```
Billing cycle: Monthly
Price: $9.99 USD
Setup fee: $0
```

Copia el **Plan ID**: `P-xxxxxxxxxx`

Repite para Pro ($29.99) y Enterprise ($99.99).

### 4.3. Variables de Entorno

```bash
# PayPal Configuration
PAYPAL_CLIENT_ID=AXxxxxxxxxxxxxx
PAYPAL_CLIENT_SECRET=ECxxxxxxxxxxxxx
PAYPAL_MODE=sandbox  # cambiar a 'live' en producción
PAYPAL_WEBHOOK_ID=WH-xxxxxxxxxxxxx

# Plan IDs (obtener del dashboard de PayPal)
PAYPAL_PLAN_STARTER=P-xxxxx
PAYPAL_PLAN_PRO=P-xxxxx
PAYPAL_PLAN_ENTERPRISE=P-xxxxx
```

### 4.4. Webhook URL

```
https://tu-dominio.com/api/billing/webhooks/paypal
```

**Eventos a subscribir:**
- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
- `PAYMENT.SALE.COMPLETED`
- `PAYMENT.SALE.DENIED`
- `PAYMENT.SALE.REFUNDED`

### 4.5. Configurar Webhook en PayPal

```bash
# Ir a: https://developer.paypal.com/dashboard/webhooks
# Click "Add Webhook"
# URL: https://tu-dominio.com/api/billing/webhooks/paypal
# Event types: Seleccionar los eventos de arriba
# Copiar el Webhook ID → PAYPAL_WEBHOOK_ID
```

---

## 5. Configuración de Binance Pay

### 5.1. Crear Cuenta Merchant

1. Ve a: https://merchant.binance.com/
2. Completa KYC verification
3. Crea una aplicación en "API Management"
4. Obtén: `API Key`, `Secret Key`, `Merchant ID`

### 5.2. Variables de Entorno

```bash
# Binance Pay Configuration
BINANCE_API_KEY=xxxxxxxxxxxxxxxxx
BINANCE_SECRET_KEY=xxxxxxxxxxxxxxxxx
BINANCE_MERCHANT_ID=xxxxxxxxxxxxx
BINANCE_MODE=sandbox  # 'live' para producción

# Precios en USD (equivalente en USDT)
BINANCE_PRICE_STARTER=9.99
BINANCE_PRICE_PRO=29.99
BINANCE_PRICE_ENTERPRISE=99.99
```

### 5.3. Webhook URL

```
https://tu-dominio.com/api/billing/webhooks/binance
```

**Eventos a subscribir:**
- `PAY_SUCCESS`
- `PAY_FAIL`
- `PAY_CLOSED`

### 5.4. Configurar Webhook en Binance

```bash
# Dashboard Binance Merchant → Settings → Webhooks
# URL: https://tu-dominio.com/api/billing/webhooks/binance
# Events: PAY_SUCCESS, PAY_FAIL, PAY_CLOSED
```

---

## 6. Configuración de Webhooks

### 6.1. Validación de Firmas

Todos los webhooks verifican firmas HMAC:
- ✅ **Stripe**: Usa `stripe-signature` header
- ✅ **PayPal**: Usa headers propios (implementar en producción)
- ✅ **Binance**: Usa `binancepay-signature` header

### 6.2. Testing Local con ngrok

```bash
# Instalar ngrok
npm install -g ngrok

# Exponer puerto local
ngrok http 3000

# Copiar URL pública
https://xxxx-xxx-xxx-xxx.ngrok.io

# Configurar webhooks con esta URL
https://xxxx-xxx-xxx-xxx.ngrok.io/api/billing/webhooks/stripe
https://xxxx-xxx-xxx-xxx.ngrok.io/api/billing/webhooks/paypal
https://xxxx-xxx-xxx-xxx.ngrok.io/api/billing/webhooks/binance
```

### 6.3. Testing de Webhooks

**Stripe CLI:**
```bash
stripe listen --forward-to localhost:3000/api/billing/webhooks/stripe
stripe trigger checkout.session.completed
```

**PayPal Sandbox:**
```bash
# Usar PayPal Sandbox Webhook Simulator
# https://developer.paypal.com/dashboard/webhooks
```

**Binance Testnet:**
```bash
# Usar Binance Pay Sandbox
# https://testnet.binance.vision/
```

---

## 7. Cron Jobs para Binance Pay

Binance Pay requiere **cron jobs** para renovaciones automáticas.

### 7.1. Crear Cron Jobs

**Opción A: PM2 Ecosystem (Recomendado)**

Agregar a `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    // ... apps existentes
    {
      name: 'binance-recurring',
      script: 'node',
      args: '-e "require(\'./services/binance\').processRecurringPayments()"',
      cron_restart: '0 0 * * *', // Diario a medianoche
      autorestart: false,
      watch: false,
    },
    {
      name: 'binance-expiry',
      script: 'node',
      args: '-e "require(\'./services/binance\').processExpiredSubscriptions()"',
      cron_restart: '0 1 * * *', // Diario a la 1 AM
      autorestart: false,
      watch: false,
    }
  ]
};
```

**Opción B: Crontab del Sistema**

```bash
crontab -e

# Agregar:
0 0 * * * cd /path/to/streamvault && node -e "require('./services/binance').processRecurringPayments()"
0 1 * * * cd /path/to/streamvault && node -e "require('./services/binance').processExpiredSubscriptions()"
```

### 7.2. ¿Qué hacen estos cron jobs?

**`processRecurringPayments()`** (diario):
- Verifica suscripciones que expiran en 3 días
- Crea orden de renovación automática
- Envía QR code al usuario por email
- Usuario paga desde app Binance

**`processExpiredSubscriptions()`** (diario):
- Busca suscripciones vencidas
- Suspende workspaces sin pago
- Permite reactivación al pagar

---

## 8. Testing

### 8.1. Instalar Dependencias

```bash
npm install
```

### 8.2. Ejecutar Migración

```bash
psql -U postgres -d streamvault -f db/migrations/001_multi_gateway.sql
```

### 8.3. Iniciar Servidor

```bash
npm start
```

### 8.4. Probar Checkout

**Stripe:**
```bash
curl -X POST http://localhost:3000/api/billing/checkout \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plan": "pro",
    "provider": "stripe"
  }'
```

**PayPal:**
```bash
curl -X POST http://localhost:3000/api/billing/checkout \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plan": "pro",
    "provider": "paypal"
  }'
```

**Binance:**
```bash
curl -X POST http://localhost:3000/api/billing/checkout \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plan": "pro",
    "provider": "binance"
  }'
```

### 8.5. Verificar Status

```bash
curl http://localhost:3000/api/billing/status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Debe retornar:
```json
{
  "enabledGateways": {
    "stripe": { "enabled": true, "default": true },
    "paypal": { "enabled": true, "default": false },
    "binance": { "enabled": true, "default": false }
  }
}
```

---

## 9. Deployment en Producción

### 9.1. Variables de Entorno Producción

```bash
# Stripe LIVE
STRIPE_SECRET_KEY=sk_live_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx

# PayPal LIVE
PAYPAL_MODE=live
PAYPAL_CLIENT_ID=AXxxxxx  # LIVE credentials
PAYPAL_CLIENT_SECRET=ECxxxxx

# Binance Pay LIVE
BINANCE_MODE=live
BINANCE_API_KEY=xxxxx  # LIVE credentials
BINANCE_SECRET_KEY=xxxxx
```

### 9.2. Webhooks en Producción

Actualizar URLs de webhooks:

```
Stripe:  https://streamvault.com/api/billing/webhooks/stripe
PayPal:  https://streamvault.com/api/billing/webhooks/paypal
Binance: https://streamvault.com/api/billing/webhooks/binance
```

### 9.3. Habilitar Gateways en Panel Admin

1. Login como Super Admin
2. Ir a `/admin`
3. Sección "Payment Gateways"
4. Habilitar proveedores deseados
5. Seleccionar proveedor por defecto

---

## 10. Troubleshooting

### Error: "PayPal not configured"

```bash
# Verificar variables
echo $PAYPAL_CLIENT_ID
echo $PAYPAL_CLIENT_SECRET

# Deben tener valores
```

### Error: "Binance API error"

```bash
# Verificar firmas HMAC
# Ver logs en services/binance.js

# Test signature generation
node -e "
  const crypto = require('crypto');
  const secret = process.env.BINANCE_SECRET_KEY;
  const payload = Date.now() + '\n' + 'test-nonce' + '\n' + '{}' + '\n';
  console.log(crypto.createHmac('sha512', secret).update(payload).digest('hex').toUpperCase());
"
```

### Webhook no recibido

```bash
# Verificar firewall
# Verificar logs
tail -f logs/combined.log | grep webhook

# Test manual
curl -X POST http://localhost:3000/api/billing/webhooks/paypal \
  -H "Content-Type: application/json" \
  -d '{"event_type":"BILLING.SUBSCRIPTION.ACTIVATED"}'
```

---

## 11. Resumen de URLs

| Proveedor | Checkout Endpoint | Webhook Endpoint |
|-----------|------------------|------------------|
| **Stripe** | `POST /api/billing/checkout` | `POST /api/billing/webhooks/stripe` |
| **PayPal** | `POST /api/billing/checkout` | `POST /api/billing/webhooks/paypal` |
| **Binance** | `POST /api/billing/checkout` | `POST /api/billing/webhooks/binance` |

---

## 12. Soporte

Para problemas o preguntas:
- Stripe: https://stripe.com/docs
- PayPal: https://developer.paypal.com/docs
- Binance: https://developers.binance.com/docs/binance-pay

---

✅ **¡Sistema multi-gateway listo!** Ahora puedes aceptar pagos de Colombia y todo el mundo. 🌎
