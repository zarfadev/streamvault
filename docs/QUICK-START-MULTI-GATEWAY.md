# 🚀 Quick Start - Multi-Gateway Payment System

Guía rápida para configurar **PayPal** y **Binance Pay** en StreamVault.

---

## ⚡ Instalación Rápida (5 minutos)

### 1. Instalar dependencias

```bash
npm install @paypal/checkout-server-sdk axios
```

### 2. Ejecutar migración de DB

```bash
psql -U postgres -d streamvault -f db/migrations/001_multi_gateway.sql
```

### 3. Configurar variables de entorno (.env)

```bash
# ═══════════════════════════════════════════════════════════
# PAYPAL CONFIGURATION
# ═══════════════════════════════════════════════════════════
PAYPAL_CLIENT_ID=tu_client_id_aqui
PAYPAL_CLIENT_SECRET=tu_secret_aqui
PAYPAL_MODE=sandbox
PAYPAL_WEBHOOK_ID=WH-xxxxx

# Plan IDs (crear en https://developer.paypal.com/)
PAYPAL_PLAN_STARTER=P-xxxxx
PAYPAL_PLAN_PRO=P-xxxxx
PAYPAL_PLAN_ENTERPRISE=P-xxxxx

# ═══════════════════════════════════════════════════════════
# BINANCE PAY CONFIGURATION
# ═══════════════════════════════════════════════════════════
BINANCE_API_KEY=tu_api_key
BINANCE_SECRET_KEY=tu_secret_key
BINANCE_MERCHANT_ID=tu_merchant_id
BINANCE_MODE=sandbox

# Precios en USDT
BINANCE_PRICE_STARTER=9.99
BINANCE_PRICE_PRO=29.99
BINANCE_PRICE_ENTERPRISE=99.99
```

### 4. Configurar Webhooks

**PayPal:**
- URL: `https://tu-dominio.com/api/billing/webhooks/paypal`
- Eventos: `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.*`

**Binance:**
- URL: `https://tu-dominio.com/api/billing/webhooks/binance`
- Eventos: `PAY_SUCCESS`, `PAY_FAIL`, `PAY_CLOSED`

### 5. Configurar Cron Jobs (solo Binance)

```bash
# PM2
pm2 start ecosystem.config.js

# O crontab
crontab -e
# Agregar:
0 0 * * * cd /path/to/streamvault && node -e "require('./services/binance').processRecurringPayments()"
0 1 * * * cd /path/to/streamvault && node -e "require('./services/binance').processExpiredSubscriptions()"
```

### 6. ¡Listo! 🎉

```bash
npm start
```

Ahora tienes 3 proveedores de pago funcionando:
- ✅ Stripe (tarjetas globales)
- ✅ PayPal (LATAM friendly)
- ✅ Binance Pay (crypto)

---

## 🧪 Testing Rápido

```bash
# Test PayPal
curl -X POST http://localhost:3000/api/billing/checkout \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"pro","provider":"paypal"}'

# Test Binance
curl -X POST http://localhost:3000/api/billing/checkout \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"pro","provider":"binance"}'
```

---

## 📚 Documentación Completa

Ver: [`MULTI-GATEWAY-SETUP.md`](./MULTI-GATEWAY-SETUP.md)

---

## ⚠️ Importante para Colombia

1. **PayPal** es ideal para Colombia (soporta PSE)
2. **Binance Pay** requiere cuenta verificada en Binance
3. **Stripe** no está disponible en Colombia (aún)

---

## 🆘 Problemas Comunes

**Error: "PayPal not configured"**
→ Verifica `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET` en .env

**Error: "Binance API error"**
→ Verifica que las credenciales sean correctas y el modo (sandbox/live)

**Webhook no funciona**
→ Usa ngrok para testing local: `ngrok http 3000`

---

✅ **¡Ya puedes aceptar pagos desde Colombia!** 🇨🇴
