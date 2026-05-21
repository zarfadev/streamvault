/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Binance Pay Service - Automated Recurring Crypto Payments
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Implementación de Binance Pay con pagos recurrentes automáticos en crypto:
 * - Pagos en USDT, BUSD, BTC (stablecoins recomendadas)
 * - Sistema de renovación automática cada 30 días
 * - QR codes + deeplinks para pagar desde app Binance
 * - Webhooks para confirmación de pagos
 * - Notificaciones automáticas 3 días antes de vencimiento
 * 
 * Docs: https://developers.binance.com/docs/binance-pay/introduction
 */

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const logger = require('./logger').child({ module: 'binance' });
const cache = require('./cache');
const { sendCryptoRenewalPending } = require('./email');

// ══════════════════════════════════════════════════════════════════════════
// Binance Pay Configuration
// ══════════════════════════════════════════════════════════════════════════

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BINANCE_MERCHANT_ID = process.env.BINANCE_MERCHANT_ID;

const BINANCE_API_URL = process.env.BINANCE_MODE === 'live'
  ? 'https://bpay.binanceapi.com'
  : 'https://bpay-sandbox.binanceapi.com';

// Precios en USD (se convierten a USDT 1:1)
const PLAN_PRICES = {
  starter: parseFloat(process.env.BINANCE_PRICE_STARTER || '9.99'),
  pro: parseFloat(process.env.BINANCE_PRICE_PRO || '29.99'),
  enterprise: parseFloat(process.env.BINANCE_PRICE_ENTERPRISE || '99.99'),
};

// ══════════════════════════════════════════════════════════════════════════
// HMAC Signature for Binance API
// ══════════════════════════════════════════════════════════════════════════

function generateSignature(timestamp, nonce, body) {
  if (!BINANCE_SECRET_KEY) {
    throw new Error('BINANCE_SECRET_KEY not configured');
  }

  const payload = timestamp + '\n' + nonce + '\n' + body + '\n';
  return crypto
    .createHmac('sha512', BINANCE_SECRET_KEY)
    .update(payload)
    .digest('hex')
    .toUpperCase();
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Realiza una petición a la API de Binance Pay
 */
async function binanceRequest(endpoint, body) {
  if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
    throw new Error('Binance Pay not configured. Set BINANCE_API_KEY and BINANCE_SECRET_KEY');
  }

  const timestamp = Date.now().toString();
  const nonce = generateNonce();
  const bodyString = JSON.stringify(body);
  const signature = generateSignature(timestamp, nonce, bodyString);

  try {
    const response = await axios.post(`${BINANCE_API_URL}${endpoint}`, body, {
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': timestamp,
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': BINANCE_API_KEY,
        'BinancePay-Signature': signature,
      },
    });

    if (response.data.status !== 'SUCCESS') {
      throw new Error(`Binance API error: ${response.data.errorMessage || 'Unknown error'}`);
    }

    return response.data.data;
  } catch (err) {
    logger.error({ err: err.message, endpoint }, 'Binance API request failed');
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Core Functions
// ══════════════════════════════════════════════════════════════════════════

/**
 * Crea una orden de pago de Binance Pay (30 días de suscripción)
 */
async function createCheckoutSession(workspaceId, planKey, successUrl, cancelUrl) {
  const price = PLAN_PRICES[planKey];
  if (!price) {
    throw new Error(`Invalid plan: ${planKey}`);
  }

  const workspace = await db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId);
  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const owner = await db.prepare(`SELECT email, name FROM users WHERE id = ?`).get(workspace.owner_id);

  // Crear merchant order ID único
  const merchantTradeNo = `SV-${workspaceId}-${Date.now()}`;

  // Crear orden en Binance Pay
  const orderData = await binanceRequest('/binancepay/openapi/v2/order', {
    env: {
      terminalType: 'WEB',
    },
    merchantTradeNo: merchantTradeNo,
    orderAmount: price,
    currency: 'USDT', // Stablecoin para evitar volatilidad
    goods: {
      goodsType: '02', // Virtual goods
      goodsCategory: 'Z000', // Software services
      referenceGoodsId: planKey,
      goodsName: `${await require('./dynamicConfig').getDynConfig('platform.siteName','StreamVault').catch(()=>'StreamVault')} ${planKey.charAt(0).toUpperCase() + planKey.slice(1)} Plan - 30 días`,
      goodsDetail: `Suscripción mensual al plan ${planKey}`,
    },
    buyer: {
      referenceBuyerId: workspace.owner_id,
      buyerEmail: owner.email,
      buyerName: {
        firstName: owner.name || 'User',
        lastName: workspace.name,
      },
    },
    returnUrl: successUrl || `${config.appUrl}/dashboard?billing=success`,
    cancelUrl: cancelUrl || `${config.appUrl}/dashboard?billing=cancel`,
  });

  // Guardar orden en DB
  const expiryDate = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 días
  
  await db.prepare(`
    UPDATE workspaces
    SET payment_provider = 'binance',
        payment_subscription_id = ?,
        payment_metadata = ?,
        updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(
    merchantTradeNo,
    JSON.stringify({
      orderId: orderData.prepayId,
      plan: planKey,
      expiryDate: expiryDate,
      status: 'pending',
    }),
    workspaceId
  );

  logger.info({ workspaceId, orderId: orderData.prepayId, planKey }, 'Binance Pay order created');

  // Retornar URLs de pago
  return {
    checkoutUrl: orderData.universalUrl || orderData.qrcodeLink, // Web URL
    qrContent: orderData.qrContent, // QR code para escanear
    deeplink: orderData.deeplink, // Deeplink para app Binance
    sessionId: merchantTradeNo,
    expiresAt: new Date(orderData.expireTime || Date.now() + 30 * 60 * 1000), // 30 min default
  };
}

/**
 * Binance Pay no tiene billing portal, pero retornamos info de la suscripción
 */
async function createBillingPortalSession(workspaceId, returnUrl) {
  const workspace = await db.prepare(`
    SELECT payment_metadata FROM workspaces WHERE id = ?
  `).get(workspaceId);

  if (!workspace?.payment_metadata) {
    throw new Error('No Binance Pay subscription found');
  }

  const metadata = JSON.parse(workspace.payment_metadata);
  const expiryDate = new Date(metadata.expiryDate);
  const daysRemaining = Math.ceil((expiryDate - Date.now()) / (1000 * 60 * 60 * 24));

  return {
    portalUrl: null, // No hay portal nativo
    message: `Tu suscripción crypto expira en ${daysRemaining} días. Recibirás un nuevo QR para renovar.`,
    expiryDate: expiryDate,
    daysRemaining: daysRemaining,
  };
}

/**
 * Cancela la renovación automática (marca como "no renovar")
 */
async function cancelSubscription(merchantTradeNo) {
  const workspace = await db.prepare(`
    SELECT id, payment_metadata FROM workspaces 
    WHERE payment_subscription_id = ?
  `).get(merchantTradeNo);

  if (!workspace) {
    throw new Error('Subscription not found');
  }

  const metadata = JSON.parse(workspace.payment_metadata || '{}');
  metadata.autoRenew = false;
  metadata.status = 'cancelled';

  await db.prepare(`
    UPDATE workspaces
    SET payment_metadata = ?,
        updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(JSON.stringify(metadata), workspace.id);

  logger.info({ workspaceId: workspace.id }, 'Binance Pay subscription cancelled (no auto-renew)');
}

// ══════════════════════════════════════════════════════════════════════════
// Recurring Payments System (Automated Renewal)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Cron job: Verifica suscripciones que expiran en 3 días y crea nueva orden
 * Ejecutar diariamente: node -e "require('./services/binance').processRecurringPayments()"
 */
async function processRecurringPayments() {
  logger.info('Processing Binance Pay recurring payments');

  const threeDaysFromNow = Date.now() + (3 * 24 * 60 * 60 * 1000);

  // Buscar workspaces con suscripción Binance próxima a expirar
  const workspaces = await db.prepare(`
    SELECT id, plan, owner_id, payment_metadata
    FROM workspaces
    WHERE payment_provider = 'binance'
      AND payment_subscription_id IS NOT NULL
      AND suspended = 0
  `).all();

  for (const workspace of workspaces) {
    try {
      const metadata = JSON.parse(workspace.payment_metadata || '{}');
      
      // Skip si está cancelado o ya procesado
      if (metadata.autoRenew === false || metadata.renewalProcessed) {
        continue;
      }

      const expiryDate = metadata.expiryDate;
      
      // Si expira en menos de 3 días, crear nueva orden
      if (expiryDate && expiryDate <= threeDaysFromNow) {
        await createRenewalOrder(workspace);
      }
    } catch (err) {
      logger.error({ err: err.message, workspaceId: workspace.id }, 'Recurring payment processing failed');
    }
  }
}

/**
 * Crea una orden de renovación automática
 */
async function createRenewalOrder(workspace) {
  const planKey = workspace.plan;
  const price = PLAN_PRICES[planKey];

  if (!price) {
    logger.error({ workspaceId: workspace.id, plan: planKey }, 'Invalid plan for renewal');
    return;
  }

  const owner = await db.prepare(`SELECT email, name FROM users WHERE id = ?`).get(workspace.owner_id);
  const merchantTradeNo = `SV-RENEWAL-${workspace.id}-${Date.now()}`;

  try {
    const orderData = await binanceRequest('/binancepay/openapi/v2/order', {
      env: { terminalType: 'WEB' },
      merchantTradeNo: merchantTradeNo,
      orderAmount: price,
      currency: 'USDT',
      goods: {
        goodsType: '02',
        goodsCategory: 'Z000',
        referenceGoodsId: planKey,
        goodsName: `${await require('./dynamicConfig').getDynConfig('platform.siteName','StreamVault').catch(()=>'StreamVault')} ${planKey} - Renovación Automática`,
        goodsDetail: `Renovación de suscripción mensual`,
      },
      buyer: {
        referenceBuyerId: workspace.owner_id,
        buyerEmail: owner.email,
      },
      returnUrl: `${config.appUrl}/dashboard?renewal=success`,
      cancelUrl: `${config.appUrl}/dashboard?renewal=cancel`,
    });

    // Actualizar metadata con orden de renovación
    const metadata = JSON.parse(workspace.payment_metadata || '{}');
    metadata.renewalOrderId = orderData.prepayId;
    metadata.renewalTradeNo = merchantTradeNo;
    metadata.renewalQrCode = orderData.qrContent;
    metadata.renewalUrl = orderData.universalUrl;
    metadata.renewalProcessed = true;

    await db.prepare(`
      UPDATE workspaces
      SET payment_metadata = ?,
          updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ?
    `).run(JSON.stringify(metadata), workspace.id);

    logger.info({ workspaceId: workspace.id, renewalOrderId: orderData.prepayId }, 'Renewal order created');

    sendCryptoRenewalPending(owner.email, owner.name || 'Usuario', {
      planName: planKey.charAt(0).toUpperCase() + planKey.slice(1),
      amount:   String(price),
      qrUrl:    orderData.qrContent,
      payUrl:   orderData.universalUrl,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h to complete payment
    }).catch(err => logger.warn({ err: err.message }, 'Failed to send renewal email'));

  } catch (err) {
    logger.error({ err: err.message, workspaceId: workspace.id }, 'Failed to create renewal order');
  }
}

/**
 * Cron job: Suspende workspaces cuya suscripción expiró sin renovar
 * Ejecutar diariamente: node -e "require('./services/binance').processExpiredSubscriptions()"
 */
async function processExpiredSubscriptions() {
  logger.info('Checking for expired Binance Pay subscriptions');

  const now = Date.now();

  const workspaces = await db.prepare(`
    SELECT id, payment_metadata
    FROM workspaces
    WHERE payment_provider = 'binance'
      AND payment_subscription_id IS NOT NULL
      AND suspended = 0
  `).all();

  for (const workspace of workspaces) {
    try {
      const metadata = JSON.parse(workspace.payment_metadata || '{}');
      const expiryDate = metadata.expiryDate;

      if (expiryDate && expiryDate < now) {
        logger.warn({ workspaceId: workspace.id }, 'Subscription expired - suspending workspace');
        await suspendWorkspace(workspace.id, 'subscription_expired');
      }
    } catch (err) {
      logger.error({ err: err.message, workspaceId: workspace.id }, 'Expiry check failed');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Webhook Processing
// ══════════════════════════════════════════════════════════════════════════

/**
 * Verifica la firma del webhook de Binance Pay
 */
function verifyWebhookSignature(headers, body) {
  const signature = headers['binancepay-signature'];
  const timestamp = headers['binancepay-timestamp'];
  const nonce = headers['binancepay-nonce'];

  if (!signature || !timestamp || !nonce) {
    logger.warn('Missing webhook signature headers');
    return false;
  }

  const bodyString = Buffer.isBuffer(body) ? body.toString() : (typeof body === 'string' ? body : JSON.stringify(body));
  const expectedSignature = generateSignature(timestamp, nonce, bodyString);

  // [CRIT-03] Usar timingSafeEqual para prevenir timing attacks
  try {
    const sigBuffer      = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) {
      logger.warn('Binance webhook signature length mismatch');
      return false;
    }
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    logger.warn('Binance webhook signature comparison failed');
    return false;
  }
}

/**
 * Procesa webhooks de Binance Pay
 */
async function processWebhookEvent(event) {
  const bizType = event.bizType;
  const data = event.data;

  logger.info({ bizType, orderId: data?.orderId }, 'Processing Binance Pay webhook');

  switch (bizType) {

    // ── Pago completado exitosamente ───────────────────────────────────
    case 'PAY_SUCCESS': {
      const merchantTradeNo = data.merchantTradeNo;
      const workspace = await db.prepare(
        `SELECT id, plan, payment_metadata FROM workspaces 
         WHERE payment_subscription_id = ? OR payment_metadata LIKE ?`
      ).get(merchantTradeNo, `%${merchantTradeNo}%`);

      if (!workspace) {
        logger.error({ merchantTradeNo }, 'Workspace not found for payment');
        break;
      }

      const metadata = JSON.parse(workspace.payment_metadata || '{}');
      
      // Si es renovación, extender 30 días más
      if (merchantTradeNo.includes('RENEWAL')) {
        const newExpiryDate = Date.now() + (30 * 24 * 60 * 60 * 1000);
        metadata.expiryDate = newExpiryDate;
        metadata.lastPaymentDate = Date.now();
        metadata.renewalProcessed = false; // Reset para próxima renovación
        metadata.status = 'active';

        await db.prepare(`
          UPDATE workspaces
          SET suspended = 0,
              payment_metadata = ?,
              updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
          WHERE id = ?
        `).run(JSON.stringify(metadata), workspace.id);
        cache.invalidate(`sv:ws:${workspace.id}`).catch(() => {});

        logger.info({ workspaceId: workspace.id }, 'Subscription renewed for 30 more days');
      } else {
        // Primer pago - activar plan
        await activateSubscription(workspace.id, workspace.plan, merchantTradeNo);
      }
      break;
    }

    // ── Pago falló o fue rechazado ─────────────────────────────────────
    case 'PAY_FAIL':
    case 'PAY_CLOSED': {
      const merchantTradeNo = data.merchantTradeNo;
      logger.warn({ merchantTradeNo }, 'Payment failed or closed');
      // No suspender inmediatamente, dar oportunidad de reintentar
      break;
    }

    default:
      logger.debug({ bizType }, 'Unhandled Binance Pay webhook');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════════════════

async function activateSubscription(workspaceId, planKey, merchantTradeNo) {
  const plan = config.plans[planKey];
  if (!plan) {
    logger.error({ planKey }, 'Unknown plan key');
    return;
  }

  const expiryDate = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 días

  await db.prepare(`
    UPDATE workspaces
    SET plan                   = ?,
        payment_provider       = 'binance',
        payment_subscription_id = ?,
        payment_metadata       = ?,
        suspended              = 0,
        max_videos             = ?,
        max_storage_bytes      = ?,
        max_bandwidth_bytes    = ?,
        updated_at             = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(
    planKey,
    merchantTradeNo,
    JSON.stringify({
      expiryDate: expiryDate,
      activatedAt: Date.now(),
      status: 'active',
      autoRenew: true,
    }),
    plan.maxVideos,
    plan.maxStorageGB * 1e9,
    plan.maxBandwidthGB * 1e9,
    workspaceId
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.info({ workspaceId, planKey, expiryDate: new Date(expiryDate) }, 'Workspace activated via Binance Pay');
}

async function suspendWorkspace(workspaceId, reason = 'unknown') {
  await db.prepare(`
    UPDATE workspaces
    SET suspended  = 1,
        updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(workspaceId);
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.warn({ workspaceId, reason }, 'Workspace suspended (Binance Pay)');
}

module.exports = {
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
  processWebhookEvent,
  verifyWebhookSignature,
  processRecurringPayments,
  processExpiredSubscriptions,
};
