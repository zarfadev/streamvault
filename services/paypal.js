/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PayPal Subscriptions Service
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Implementación completa de PayPal para pagos recurrentes automáticos:
 * - Suscripciones con renovación automática
 * - Webhooks para activación/cancelación/suspensión
 * - Billing Portal para gestión de suscripciones
 * - Soporte para tarjetas, PayPal balance, y PSE (Colombia)
 * 
 * Docs: https://developer.paypal.com/docs/subscriptions/
 */

const checkoutNodeJssdk = require('@paypal/checkout-server-sdk');
const config = require('../config');
const db = require('../db');
const cache = require('./cache');
const logger = require('./logger').child({ module: 'paypal' });
const gwCreds = require('./gatewayCredentials');
const { awardReferralCredit, clearReferralCredit } = require('./referralCredit');

// ══════════════════════════════════════════════════════════════════════════
// PayPal Client Configuration (reads from DB first, then .env fallback)
// ══════════════════════════════════════════════════════════════════════════

let _paypalClient = null;
let _paypalMode = null;
let _clientInitAt = 0;
const CLIENT_TTL = 60_000; // Reinitialize client every 60s to pick up credential changes

function getPayPalClient() {
  if (_paypalClient && Date.now() - _clientInitAt < CLIENT_TTL) return _paypalClient;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = process.env.PAYPAL_MODE || 'sandbox';

  if (!clientId || !clientSecret) {
    logger.warn('PayPal credentials not configured');
    return null;
  }

  const environment = mode === 'live'
    ? new checkoutNodeJssdk.core.LiveEnvironment(clientId, clientSecret)
    : new checkoutNodeJssdk.core.SandboxEnvironment(clientId, clientSecret);

  _paypalClient = new checkoutNodeJssdk.core.PayPalHttpClient(environment);
  _paypalMode = mode;
  _clientInitAt = Date.now();
  
  logger.info({ mode }, 'PayPal client initialized');
  return _paypalClient;
}

/**
 * Async version that checks DB credentials first
 */
async function getPayPalClientAsync() {
  const creds = await gwCreds.getCredentials('paypal');
  const clientId = creds.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID || '';
  const clientSecret = creds.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET || '';
  const mode = creds.PAYPAL_MODE || process.env.PAYPAL_MODE || 'sandbox';

  if (!clientId || !clientSecret) {
    return null;
  }

  // Reinitialize if credentials or mode changed
  if (_paypalClient && _paypalMode === mode && Date.now() - _clientInitAt < CLIENT_TTL) {
    return _paypalClient;
  }

  const environment = mode === 'live'
    ? new checkoutNodeJssdk.core.LiveEnvironment(clientId, clientSecret)
    : new checkoutNodeJssdk.core.SandboxEnvironment(clientId, clientSecret);

  _paypalClient = new checkoutNodeJssdk.core.PayPalHttpClient(environment);
  _paypalMode = mode;
  _clientInitAt = Date.now();

  logger.info({ mode }, 'PayPal client initialized (from DB credentials)');
  return _paypalClient;
}

/**
 * IDs de planes de PayPal (deben crearse en el dashboard de PayPal)
 * Estos IDs se obtienen al crear los "Products" y "Plans" en PayPal
 * Priority: DB credentials > process.env
 */
async function getPlanIdAsync(planKey) {
  const creds = await gwCreds.getCredentials('paypal');
  const planIds = {
    starter: creds.PAYPAL_PLAN_STARTER || process.env.PAYPAL_PLAN_STARTER || '',
    pro: creds.PAYPAL_PLAN_PRO || process.env.PAYPAL_PLAN_PRO || '',
    enterprise: creds.PAYPAL_PLAN_ENTERPRISE || process.env.PAYPAL_PLAN_ENTERPRISE || '',
  };
  return planIds[planKey] || null;
}

function getPlanId(planKey) {
  const planIds = {
    starter: process.env.PAYPAL_PLAN_STARTER,
    pro: process.env.PAYPAL_PLAN_PRO,
    enterprise: process.env.PAYPAL_PLAN_ENTERPRISE,
  };
  return planIds[planKey];
}

// ══════════════════════════════════════════════════════════════════════════
// Core Functions
// ══════════════════════════════════════════════════════════════════════════

/**
 * Crea una suscripción de PayPal y retorna la URL de aprobación
 */
async function createCheckoutSession(workspaceId, planKey, successUrl, cancelUrl, discountUSD = 0) {
  const client = await getPayPalClientAsync();
  if (!client) {
    throw new Error('PayPal no configurado. Configura las credenciales en el panel de administración (Gateways → PayPal → Configurar).');
  }

  const planId = await getPlanIdAsync(planKey);
  if (!planId) {
    throw new Error(`Plan de PayPal no configurado para: ${planKey}. Configura el Plan ID en el panel de administración.`);
  }

  const workspace = await db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId);
  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const owner = await db.prepare(`SELECT email, name FROM users WHERE id = ?`).get(workspace.owner_id);

  // ── Referral credit: if discount >= plan price, delay start_time by 30 days ──
  // PayPal subscriptions don't support arbitrary price overrides at checkout.
  // The closest mechanism: set start_time in the future so the first billing
  // cycle is free. This works when credit covers at least one full month.
  // If credit < planPrice, the credit is stored in DB; admin can apply manually
  // or it will be used on the next gateway that supports partial discounts.
  const planPrice = config.plans[planKey]?.price || 0;
  let startTime = null;
  if (discountUSD >= planPrice && planPrice > 0) {
    // Give 1 free month by delaying the first charge 30 days
    const d = new Date();
    d.setDate(d.getDate() + 30);
    startTime = d.toISOString();
    logger.info({ workspaceId, planKey, discountUSD }, 'PayPal: referral credit grants 1 free month via start_time delay');
  } else if (discountUSD > 0) {
    logger.info({ workspaceId, planKey, discountUSD, planPrice },
      'PayPal: partial credit not applicable at checkout — will remain as DB pending credit');
  }

  // Crear suscripción en PayPal
  const subscriptionBody = {
    plan_id: planId,
    subscriber: {
      name: {
        given_name: owner.name || 'User',
        surname: workspace.name,
      },
      email_address: owner.email,
    },
    application_context: {
      brand_name: (await require('./dynamicConfig').getDynConfig('platform.siteName', 'StreamVault').catch(() => 'StreamVault')),
      locale: 'es-CO', // Colombia locale
      shipping_preference: 'NO_SHIPPING',
      user_action: 'SUBSCRIBE_NOW',
      return_url: successUrl || `${config.appUrl}/dashboard?billing=success`,
      cancel_url: cancelUrl || `${config.appUrl}/dashboard?billing=cancel`,
    },
    custom_id: workspaceId, // Para identificar en webhooks
  };
  if (startTime) subscriptionBody.start_time = startTime;

  const request = {
    path: '/v1/billing/subscriptions',
    verb: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: subscriptionBody,
  };

  try {
    const response = await client.execute(request);
    const subscription = response.result;

    // Guardar subscription_id temporalmente
    await db.prepare(`
      UPDATE workspaces
      SET payment_provider = 'paypal',
          payment_subscription_id = ?,
          payment_metadata = ?,
          updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
      WHERE id = ?
    `).run(
      subscription.id,
      JSON.stringify({ status: 'approval_pending' }),
      workspaceId
    );

    // Encontrar el link de aprobación
    const approvalLink = subscription.links?.find(link => link.rel === 'approve');

    logger.info({ workspaceId, subscriptionId: subscription.id }, 'PayPal subscription created');

    return {
      checkoutUrl: approvalLink?.href,
      sessionId: subscription.id,
    };
  } catch (err) {
    logger.error({ err: err.message, workspaceId }, 'PayPal subscription creation failed');
    throw new Error(`PayPal error: ${err.message}`);
  }
}

/**
 * No hay "billing portal" nativo en PayPal como en Stripe,
 * pero podemos redirigir al usuario a su página de suscripciones de PayPal
 */
async function createBillingPortalSession(workspaceId, returnUrl) {
  const workspace = await db.prepare(`
    SELECT payment_subscription_id FROM workspaces WHERE id = ?
  `).get(workspaceId);

  if (!workspace?.payment_subscription_id) {
    throw new Error('No PayPal subscription found for this workspace');
  }

  // PayPal no tiene portal directo, redirigimos a la gestión de suscripciones
  const portalUrl = process.env.PAYPAL_MODE === 'live'
    ? 'https://www.paypal.com/myaccount/autopay/'
    : 'https://www.sandbox.paypal.com/myaccount/autopay/';

  return {
    portalUrl: portalUrl,
    message: 'Serás redirigido a PayPal para gestionar tu suscripción',
  };
}

/**
 * Cancela una suscripción de PayPal
 */
async function cancelSubscription(subscriptionId) {
  const client = getPayPalClient();
  if (!client) {
    throw new Error('PayPal not configured');
  }

  const request = {
    path: `/v1/billing/subscriptions/${subscriptionId}/cancel`,
    verb: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      reason: `User requested cancellation via ${await require('./dynamicConfig').getDynConfig('platform.siteName', 'Platform').catch(() => 'Platform')}`,
    },
  };

  try {
    await client.execute(request);
    logger.info({ subscriptionId }, 'PayPal subscription cancelled');
  } catch (err) {
    logger.error({ err: err.message, subscriptionId }, 'PayPal cancellation failed');
    throw new Error(`PayPal cancellation failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Webhook Processing
// ══════════════════════════════════════════════════════════════════════════

/**
 * Verifica la firma del webhook de PayPal usando la API oficial de PayPal.
 * [CRIT-02] Implementación real — fail-closed: rechaza si no se puede verificar.
 * Docs: https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
 */
async function verifyWebhookSignature(headers, body) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    // En producción es obligatorio. En dev se puede omitir con PAYPAL_SKIP_WEBHOOK_VERIFY=true
    if (process.env.NODE_ENV === 'production') {
      logger.error('PAYPAL_WEBHOOK_ID not configured — rejecting webhook (fail-closed)');
      return false;
    }
    if (process.env.PAYPAL_SKIP_WEBHOOK_VERIFY === 'true') {
      logger.warn('⚠️  PayPal webhook verification SKIPPED (dev mode only)');
      return true;
    }
    logger.warn('PAYPAL_WEBHOOK_ID not set — rejecting webhook. Set PAYPAL_SKIP_WEBHOOK_VERIFY=true in dev to skip.');
    return false;
  }

  // Extraer headers de verificación requeridos por PayPal
  const authAlgo       = headers['paypal-auth-algo'];
  const certUrl        = headers['paypal-cert-url'];
  const transmissionId = headers['paypal-transmission-id'];
  const transmissionSig= headers['paypal-transmission-sig'];
  const transmissionTime = headers['paypal-transmission-time'];

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    logger.warn({ headers: Object.keys(headers) }, 'PayPal webhook missing required signature headers — rejecting');
    return false;
  }

  // Validar que certUrl sea un dominio oficial de PayPal (previene SSRF)
  try {
    const { URL } = require('url');
    const parsed = new URL(certUrl);
    const PAYPAL_CERT_DOMAINS = ['api.paypal.com', 'api.sandbox.paypal.com'];
    if (!PAYPAL_CERT_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      logger.error({ certUrl }, 'PayPal webhook certUrl is not from a trusted PayPal domain — SSRF attempt?');
      return false;
    }
  } catch {
    logger.error({ certUrl }, 'PayPal webhook certUrl is invalid');
    return false;
  }

  try {
    const client = getPayPalClient();
    if (!client) {
      logger.error('PayPal client not initialized — cannot verify webhook signature');
      return false;
    }

    // Llamada a la API de PayPal para verificar la firma
    const bodyString = Buffer.isBuffer(body) ? body.toString() : (typeof body === 'string' ? body : JSON.stringify(body));
    const parsedBody = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : (typeof body === 'string' ? JSON.parse(body) : body);
    const verifyRequest = {
      path: '/v1/notifications/verify-webhook-signature',
      verb: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: parsedBody,
      },
    };

    const response = await client.execute(verifyRequest);
    const verificationStatus = response.result?.verification_status;

    if (verificationStatus !== 'SUCCESS') {
      logger.warn({ verificationStatus }, 'PayPal webhook signature verification returned non-SUCCESS');
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'PayPal webhook signature verification threw error — rejecting (fail-closed)');
    return false;
  }
}

/**
 * Procesa eventos de webhook de PayPal
 */
async function processWebhookEvent(event) {
  const eventType = event.event_type;
  const resource = event.resource;

  logger.info({ eventType, resourceId: resource?.id }, 'Processing PayPal webhook');

  switch (eventType) {
    
    // ── Suscripción activada (usuario completó el pago) ─────────────────
    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const subscriptionId = resource.id;
      const customId = resource.custom_id; // nuestro workspaceId
      
      if (!customId) {
        logger.error({ subscriptionId }, 'No workspace ID in webhook');
        break;
      }

      // Determinar el plan por el plan_id de PayPal
      const planId = resource.plan_id;
      const planKey = getPlanKeyFromPayPalPlanId(planId);

      if (planKey) {
        // Obtener info del workspace antes de activar
        const ws = await db.prepare(`SELECT plan, owner_id FROM workspaces WHERE id = ?`).get(customId);
        const fromPlan = ws?.plan || 'starter';
        
        await activateSubscription(customId, planKey, subscriptionId);
        
        // ── REFERRAL CREDIT: award 1 free month to referrer on first purchase ──
        if (ws?.owner_id && fromPlan === 'starter') {
          awardReferralCredit(ws.owner_id).catch(err =>
            logger.error({ err: err.message }, 'awardReferralCredit (PayPal) failed')
          );
        }
      }
      break;
    }

    // ── Suscripción cancelada ───────────────────────────────────────────
    case 'BILLING.SUBSCRIPTION.CANCELLED': {
      const subscriptionId = resource.id;
      const workspace = await db.prepare(
        `SELECT id FROM workspaces WHERE payment_subscription_id = ?`
      ).get(subscriptionId);

      if (workspace) {
        logger.info({ workspaceId: workspace.id }, 'Subscription cancelled — downgrading');
        await downgradeWorkspace(workspace.id);
      }
      break;
    }

    // ── Suscripción suspendida (pago falló) ─────────────────────────────
    case 'BILLING.SUBSCRIPTION.SUSPENDED': {
      const subscriptionId = resource.id;
      const workspace = await db.prepare(
        `SELECT id FROM workspaces WHERE payment_subscription_id = ?`
      ).get(subscriptionId);

      if (workspace) {
        logger.warn({ workspaceId: workspace.id }, 'Subscription suspended — payment failed');
        await suspendWorkspace(workspace.id, 'payment_failed');
      }
      break;
    }

    // ── Pago completado (renovación mensual) ────────────────────────────
    case 'PAYMENT.SALE.COMPLETED': {
      const subscriptionId = resource.billing_agreement_id;
      if (subscriptionId) {
        const workspace = await db.prepare(
          `SELECT id FROM workspaces WHERE payment_subscription_id = ?`
        ).get(subscriptionId);

        if (workspace) {
          // Levantar suspensión si estaba suspendido
          await db.prepare(`
            UPDATE workspaces
            SET suspended = 0,
                updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
            WHERE id = ?
          `).run(workspace.id);
          cache.invalidate(`sv:ws:${workspace.id}`).catch(() => {});

          logger.info({ workspaceId: workspace.id }, 'Payment completed — subscription renewed');
        }
      }
      break;
    }

    // ── Pago fallido ────────────────────────────────────────────────────
    case 'PAYMENT.SALE.DENIED':
    case 'PAYMENT.SALE.REFUNDED': {
      const subscriptionId = resource.billing_agreement_id;
      if (subscriptionId) {
        const workspace = await db.prepare(
          `SELECT id FROM workspaces WHERE payment_subscription_id = ?`
        ).get(subscriptionId);

        if (workspace) {
          logger.warn({ workspaceId: workspace.id }, 'Payment failed — suspending workspace');
          await suspendWorkspace(workspace.id, 'payment_failed');
        }
      }
      break;
    }

    default:
      logger.debug({ eventType }, 'Unhandled PayPal event');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════════════════

function getPlanKeyFromPayPalPlanId(paypalPlanId) {
  const planIds = {
    [process.env.PAYPAL_PLAN_STARTER]: 'starter',
    [process.env.PAYPAL_PLAN_PRO]: 'pro',
    [process.env.PAYPAL_PLAN_ENTERPRISE]: 'enterprise',
  };

  return planIds[paypalPlanId] || null;
}

async function activateSubscription(workspaceId, planKey, subscriptionId) {
  const plan = config.plans[planKey];
  if (!plan) {
    logger.error({ planKey }, 'Unknown plan key');
    return;
  }

  await db.prepare(`
    UPDATE workspaces
    SET plan                   = ?,
        payment_provider       = 'paypal',
        payment_subscription_id = ?,
        suspended              = 0,
        max_videos             = ?,
        max_storage_bytes      = ?,
        max_bandwidth_bytes    = ?,
        updated_at             = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(
    planKey,
    subscriptionId,
    plan.maxVideos,
    plan.maxStorageGB * 1e9,
    plan.maxBandwidthGB * 1e9,
    workspaceId
  );
  // Clear pending referral credit now that payment is confirmed
  clearReferralCredit(workspaceId).catch(() => {});
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.info({ workspaceId, planKey }, 'Workspace plan activated via PayPal');
}

async function downgradeWorkspace(workspaceId) {
  const starter = config.plans.starter;
  await db.prepare(`
    UPDATE workspaces
    SET plan                   = 'starter',
        payment_subscription_id = NULL,
        suspended              = 0,
        max_videos             = ?,
        max_storage_bytes      = ?,
        max_bandwidth_bytes    = ?,
        updated_at             = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(
    starter.maxVideos,
    starter.maxStorageGB * 1e9,
    starter.maxBandwidthGB * 1e9,
    workspaceId
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.info({ workspaceId }, 'Workspace downgraded to starter (PayPal)');
}

async function suspendWorkspace(workspaceId, reason = 'unknown') {
  await db.prepare(`
    UPDATE workspaces
    SET suspended  = 1,
        updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
    WHERE id = ?
  `).run(workspaceId);
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.warn({ workspaceId, reason }, 'Workspace suspended (PayPal)');
}

module.exports = {
  getPayPalClient,
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
  processWebhookEvent,
  verifyWebhookSignature,
};
