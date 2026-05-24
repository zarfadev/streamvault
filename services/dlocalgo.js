/**
 * ═══════════════════════════════════════════════════════════════════════════
 * dLocal Go Payment Service
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Integración con dLocal Go para pagos recurrentes vía suscripciones.
 * Optimizado para mercados LATAM (Argentina, Brasil, Colombia, México, etc.)
 *
 * Auth:     Bearer <API_KEY>:<SECRET_KEY>
 * Webhooks: HMAC-SHA256 — Authorization: V2-HMAC-SHA256, Signature: <hex>
 *           Fórmula: HMAC('sha256', api_key + json_payload, secret_key)
 *
 * Flujo:
 *  1. Admin crea planes en el dashboard de dLocal Go → obtiene plan tokens
 *  2. Al hacer checkout, se redirige a checkout.dlocalgo.com/validate/subscription/{token}
 *  3. dLocal Go envía webhook POST a notification_url con { payment_id }
 *  4. Se consulta GET /v1/payments/{id} para verificar estado y activar plan
 *
 * Docs: https://docs.dlocalgo.com/integration-api
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const db = require('../db');
const cache = require('./cache');
const logger = require('./logger').child({ module: 'dlocalgo' });
const invoiceService = require('./invoices');
const emailService = require('./email');
const gwCreds = require('./gatewayCredentials');
const { awardReferralCredit, clearReferralCredit } = require('./referralCredit');

// ══════════════════════════════════════════════════════════════════════════
// Configuration (reads from DB first, then .env fallback)
// ══════════════════════════════════════════════════════════════════════════

// Cached config resolved from DB+env
let _resolvedConfig = null;
let _resolvedAt = 0;
const CONFIG_TTL = 15_000; // 15s cache

async function getDLocalConfigAsync() {
  if (_resolvedConfig && Date.now() - _resolvedAt < CONFIG_TTL) return _resolvedConfig;

  const creds = await gwCreds.getCredentials('dlocalgo');
  const apiKey = creds.DLOCALGO_API_KEY || process.env.DLOCALGO_API_KEY || '';
  const secretKey = creds.DLOCALGO_SECRET_KEY || process.env.DLOCALGO_SECRET_KEY || '';

  if (!apiKey || !secretKey) { _resolvedConfig = null; _resolvedAt = Date.now(); return null; }

  const mode = creds.DLOCALGO_MODE || process.env.DLOCALGO_MODE || 'sandbox';
  const isSandbox = mode !== 'production';

  _resolvedConfig = {
    apiKey,
    secretKey,
    isSandbox,
    mode,
    baseUrl: isSandbox ? 'https://api-sbx.dlocalgo.com' : 'https://api.dlocalgo.com',
    checkoutBase: isSandbox
      ? 'https://checkout-sbx.dlocalgo.com'
      : 'https://checkout.dlocalgo.com',
  };
  _resolvedAt = Date.now();
  return _resolvedConfig;
}

// Synchronous version for webhook verification (uses cached or env fallback)
function getDLocalConfig() {
  if (_resolvedConfig) return _resolvedConfig;
  // Fallback to env only
  const apiKey = process.env.DLOCALGO_API_KEY;
  const secretKey = process.env.DLOCALGO_SECRET_KEY;
  if (!apiKey || !secretKey) return null;

  const isSandbox = (process.env.DLOCALGO_MODE || 'sandbox') !== 'production';
  return {
    apiKey,
    secretKey,
    isSandbox,
    mode: process.env.DLOCALGO_MODE || 'sandbox',
    baseUrl: isSandbox ? 'https://api-sbx.dlocalgo.com' : 'https://api.dlocalgo.com',
    checkoutBase: isSandbox
      ? 'https://checkout-sbx.dlocalgo.com'
      : 'https://checkout.dlocalgo.com',
  };
}

// Plan token = el ID del plan creado en el dashboard de dLocal Go.
// El checkout de suscripción se genera como:
//   {checkoutBase}/validate/subscription/{token}?external_id={workspaceId}&email={email}
async function getPlanTokenAsync(planKey) {
  const creds = await gwCreds.getCredentials('dlocalgo');
  const tokens = {
    starter:    creds.DLOCALGO_PLAN_STARTER || process.env.DLOCALGO_PLAN_STARTER || '',
    pro:        creds.DLOCALGO_PLAN_PRO || process.env.DLOCALGO_PLAN_PRO || '',
    enterprise: creds.DLOCALGO_PLAN_ENTERPRISE || process.env.DLOCALGO_PLAN_ENTERPRISE || '',
  };
  return tokens[planKey] || null;
}

function getPlanToken(planKey) {
  const tokens = {
    starter:    process.env.DLOCALGO_PLAN_STARTER,
    pro:        process.env.DLOCALGO_PLAN_PRO,
    enterprise: process.env.DLOCALGO_PLAN_ENTERPRISE,
  };
  return tokens[planKey] || null;
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP Client
// ══════════════════════════════════════════════════════════════════════════

async function dlocalRequest(method, path, body = null) {
  const cfg = getDLocalConfig();
  if (!cfg) throw new Error('dLocal Go no configurado');

  const headers = {
    Authorization: `Bearer ${cfg.apiKey}:${cfg.secretKey}`,
    'Content-Type': 'application/json',
  };

  try {
    const response = await axios({
      method,
      url: `${cfg.baseUrl}${path}`,
      headers,
      data: body || undefined,
      validateStatus: null, // Manejamos errores manualmente
    });

    if (response.status >= 400) {
      const errMsg = response.data?.message || response.data?.error || `HTTP ${response.status}`;
      const code = response.data?.code || response.status;
      throw new Error(`dLocal Go API error [${code}]: ${errMsg}`);
    }

    return response.data;
  } catch (err) {
    if (err.response) {
      const errMsg = err.response.data?.message || err.response.data?.error || `HTTP ${err.response.status}`;
      throw new Error(`dLocal Go API error: ${errMsg}`);
    }
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Core Functions
// ══════════════════════════════════════════════════════════════════════════

/**
 * Genera la URL de checkout de suscripción de dLocal Go.
 * El token del plan debe haberse creado en el dashboard de dLocal Go
 * (Integrations > Subscription > Plans) y configurado en las env vars.
 */
async function createCheckoutSession(workspaceId, planKey, successUrl, cancelUrl, discountUSD = 0) {
  // Use async config resolution (reads from DB credentials first)
  const cfg = await getDLocalConfigAsync();
  if (!cfg) {
    throw new Error('dLocal Go no configurado. Configura las credenciales en el panel de administración o en .env');
  }

  const planToken = await getPlanTokenAsync(planKey);
  if (!planToken) {
    throw new Error(
      `Plan de dLocal Go no configurado para: ${planKey}. ` +
      `Configura el token del plan ${planKey} en el panel de administración (Gateways → dLocal Go → Configurar).`
    );
  }

  const wsResult = await db.query(`SELECT w.*, u.email, u.name AS owner_name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = $1`, [workspaceId]);
  const workspace = wsResult.rows[0];
  if (!workspace) throw new Error('Workspace not found');

  // ── Referral credit: dLocal Go uses pre-configured plan tokens with fixed prices,
  // so we cannot change the checkout amount at runtime. The credit is stored in
  // referral_credit_usd on the workspace and will be applied by the admin or
  // automatically deducted from the next billing cycle via a note in metadata.
  if (discountUSD > 0) {
    logger.info({ workspaceId, planKey, discountUSD },
      'dLocal Go: referral credit stored as pending — cannot modify subscription price at checkout (platform limitation)');
  }

  // Construir URL de checkout con parámetros de rastreo
  const checkoutUrl = new URL(`${cfg.checkoutBase}/validate/subscription/${planToken}`);
  checkoutUrl.searchParams.set('external_id', workspaceId);
  if (workspace.email) checkoutUrl.searchParams.set('email', workspace.email);

  // Marcar workspace con provider pendiente para poder resolverlo en el webhook
  await db.query(
    `UPDATE workspaces
     SET payment_provider = 'dlocalgo',
         payment_metadata = $1,
         updated_at       = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
     WHERE id = $2`,
    [JSON.stringify({
      status: 'checkout_pending',
      plan: planKey,
      started_at: Math.floor(Date.now() / 1000),
      ...(discountUSD > 0 ? { pending_referral_credit_usd: discountUSD } : {}),
    }), workspaceId]
  );

  logger.info({ workspaceId, planKey, isSandbox: cfg.isSandbox }, 'dLocal Go subscription checkout created');

  return {
    checkoutUrl: checkoutUrl.toString(),
    sessionId: planToken,
  };
}

/**
 * dLocal Go no tiene un portal de facturación nativo.
 * Devuelve información sobre el estado de la suscripción actual.
 */
async function createBillingPortalSession(workspaceId, returnUrl) {
  const wsResult = await db.query(
    `SELECT plan, payment_subscription_id, payment_metadata FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  const workspace = wsResult.rows[0];

  if (!workspace?.payment_subscription_id) {
    throw new Error('No hay suscripción activa de dLocal Go para este workspace');
  }

  let metadata = {};
  try { metadata = JSON.parse(workspace.payment_metadata || '{}'); } catch {}

  const planConfig = config.plans[workspace.plan];
  const periodEndTs = metadata.current_period_end;
  const expiryDate = periodEndTs
    ? new Date(periodEndTs * 1000).toLocaleDateString('es-ES')
    : null;
  const daysRemaining = periodEndTs
    ? Math.max(0, Math.ceil((periodEndTs * 1000 - Date.now()) / 86_400_000))
    : null;

  return {
    portalUrl: returnUrl || `${config.appUrl}/dashboard`,
    message:
      `Suscripción activa al plan ${planConfig?.name || workspace.plan}` +
      (expiryDate ? `. Próximo cobro: ${expiryDate}` : '') +
      '. Para cancelar usa el botón "Cancelar suscripción" en el dashboard.',
    expiryDate,
    daysRemaining,
  };
}

/**
 * Cancela la suscripción en dLocal Go vía DELETE.
 * subscriptionId tiene formato "planId:subscriptionId" cuando se almacena
 * en el webhook de suscripción activa.
 */
async function cancelSubscription(subscriptionId) {
  const cfg = getDLocalConfig();
  if (!cfg) throw new Error('dLocal Go no configurado');

  // El subscriptionId puede ser "planId:subId" o solo un payment_id de referencia
  const parts = typeof subscriptionId === 'string' ? subscriptionId.split(':') : [];
  if (parts.length === 2) {
    const [planId, subId] = parts;
    try {
      await dlocalRequest('DELETE', `/v1/subscription/plan/${planId}/subscription/${subId}`);
      logger.info({ planId, subId }, 'dLocal Go subscription cancelled');
    } catch (err) {
      // Si la cancelación API falla, igual marcamos localmente como cancelada
      logger.error({ err: err.message, subscriptionId }, 'dLocal Go API cancellation failed — continuing with local cancellation');
    }
  } else {
    logger.warn({ subscriptionId }, 'dLocal Go subscription ID no tiene formato planId:subId — omitiendo llamada API de cancelación');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Webhook Verification & Processing
// ══════════════════════════════════════════════════════════════════════════

/**
 * Verifica la firma HMAC-SHA256 del webhook de dLocal Go.
 *
 * Header entrante:
 *   Authorization: V2-HMAC-SHA256, Signature: <hex>
 *
 * Fórmula de verificación:
 *   expected = HMAC-SHA256(key=secret_key, msg=api_key + raw_payload)
 */
function verifyWebhookSignature(headers, body) {
  const cfg = getDLocalConfig();
  if (!cfg) {
    logger.error('dLocal Go no configurado — rechazando webhook');
    return false;
  }

  const authHeader = headers['authorization'] || '';
  const match = authHeader.match(/V2-HMAC-SHA256,\s*Signature:\s*([a-fA-F0-9]+)/i);

  if (!match) {
    if (process.env.NODE_ENV !== 'production' && process.env.DLOCALGO_SKIP_WEBHOOK_VERIFY === 'true') {
      logger.warn('⚠️  dLocal Go webhook verification OMITIDA (solo dev)');
      return true;
    }
    logger.warn({ authHeader: authHeader.slice(0, 80) }, 'dLocal Go webhook: header Authorization ausente o mal formado');
    return false;
  }

  const receivedSig = match[1].toLowerCase();
  const payload = Buffer.isBuffer(body)
    ? body.toString('utf8')
    : (typeof body === 'string' ? body : JSON.stringify(body));

  const expectedSig = crypto
    .createHmac('sha256', cfg.secretKey)
    .update(cfg.apiKey + payload)
    .digest('hex');

  // Comparación en tiempo constante para evitar timing attacks
  try {
    const received = Buffer.from(receivedSig, 'hex');
    const expected = Buffer.from(expectedSig, 'hex');
    if (received.length !== expected.length) {
      logger.warn('dLocal Go webhook: firma con longitud incorrecta');
      return false;
    }
    const valid = crypto.timingSafeEqual(received, expected);
    if (!valid) logger.warn('dLocal Go webhook: firma inválida — rechazando');
    return valid;
  } catch {
    logger.error('dLocal Go webhook: error al comparar firmas');
    return false;
  }
}

/**
 * Procesa eventos de webhook de dLocal Go.
 *
 * dLocal Go envía { payment_id } al notification_url configurado en el plan.
 * Debemos consultar GET /v1/payments/{id} para obtener el estado real.
 *
 * Estados posibles: PENDING | PAID | REJECTED | CANCELLED | EXPIRED
 */
async function processWebhookEvent(event) {
  const paymentId = event.payment_id || event.id;

  if (!paymentId) {
    logger.warn({ event }, 'dLocal Go webhook sin payment_id — ignorando');
    return;
  }

  logger.info({ paymentId }, 'Procesando webhook dLocal Go');

  // Consultar detalles del pago
  let payment;
  try {
    payment = await dlocalRequest('GET', `/v1/payments/${paymentId}`);
  } catch (err) {
    logger.error({ err: err.message, paymentId }, 'Error al consultar pago en dLocal Go');
    return;
  }

  const status = payment.status;
  // external_id = workspaceId que pasamos al crear el checkout
  const workspaceId = payment.external_id || payment.order_id;

  logger.info({ paymentId, status, workspaceId }, 'Detalles de pago dLocal Go obtenidos');

  if (!workspaceId) {
    logger.warn({ paymentId, payment }, 'dLocal Go webhook: no hay workspaceId en el pago (external_id vacío)');
    return;
  }

  switch (status) {

    // ── Pago exitoso → activar suscripción ─────────────────────────────
    case 'PAID': {
      const wsResult = await db.query(
        `SELECT plan, payment_metadata FROM workspaces WHERE id = $1`,
        [workspaceId]
      );
      const workspace = wsResult.rows[0];
      if (!workspace) {
        logger.error({ workspaceId }, 'dLocal Go PAID: workspace no encontrado');
        break;
      }

      // El plan está guardado en payment_metadata del checkout pendiente
      let planKey = null;
      try {
        const meta = JSON.parse(workspace.payment_metadata || '{}');
        planKey = meta.plan;
      } catch {}

      // Fallback: intentar inferir por monto
      if (!planKey) {
        planKey = getPlanKeyFromAmount(payment.amount);
      }

      if (!planKey) {
        logger.error({ paymentId, amount: payment.amount, currency: payment.currency }, 'dLocal Go PAID: no se puede determinar el plan');
        break;
      }

      const fromPlan = workspace.plan;
      await activateSubscription(workspaceId, planKey, paymentId);

      // ── REFERRAL CREDIT: award 1 free month to referrer on first purchase ──
      if (fromPlan === 'starter') {
        try {
          const ownerR = await db.query(`SELECT owner_id FROM workspaces WHERE id = $1`, [workspaceId]);
          const ownerId = ownerR.rows[0]?.owner_id;
          if (ownerId) {
            awardReferralCredit(ownerId).catch(err =>
              logger.error({ err: err.message }, 'awardReferralCredit (dLocal Go) failed')
            );
          }
        } catch (refErr) {
          logger.error({ err: refErr.message }, 'Failed to look up owner for referral credit (dLocal Go)');
        }
      }

      // Registrar factura
      await invoiceService.createInvoice({
        workspaceId,
        provider: 'dlocalgo',
        planKey,
        amount: payment.amount,
        currency: (payment.currency || 'USD').toUpperCase(),
        status: 'paid',
        providerInvoiceId: paymentId,
        invoiceUrl: null,
        periodStart: Math.floor(Date.now() / 1000),
        periodEnd: null,
      }).catch(e => logger.error({ err: e.message }, 'Error al crear factura dLocal Go'));

      // Email de confirmación
      const ownerResult = await db.query(
        `SELECT u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = $1`,
        [workspaceId]
      ).catch(() => ({ rows: [] }));
      const owner = ownerResult.rows[0];
      if (owner) {
        const planCfg = config.plans[planKey];
        emailService.sendPaymentConfirmation(owner.email, owner.name, {
          planName: planCfg?.name || planKey,
          amount: payment.amount?.toFixed(2),
          currency: (payment.currency || 'USD').toUpperCase(),
          invoiceNumber: paymentId,
          periodEnd: null,
        }).catch(e => logger.error({ err: e.message }, 'sendPaymentConfirmation error (dLocal Go)'));
      }
      break;
    }

    // ── Pago rechazado / cancelado / expirado → suspender ──────────────
    case 'REJECTED':
    case 'CANCELLED':
    case 'EXPIRED': {
      const wsResult = await db.query(
        `SELECT plan FROM workspaces WHERE id = $1`,
        [workspaceId]
      );
      const workspace = wsResult.rows[0];
      if (!workspace) break;

      logger.warn({ workspaceId, status, paymentId }, `dLocal Go pago ${status} — suspendiendo workspace`);
      await suspendWorkspace(workspaceId, `payment_${status.toLowerCase()}`);

      await invoiceService.createInvoice({
        workspaceId,
        provider: 'dlocalgo',
        planKey: workspace.plan,
        amount: payment.amount || 0,
        currency: (payment.currency || 'USD').toUpperCase(),
        status: 'failed',
        providerInvoiceId: paymentId,
        invoiceUrl: null,
        periodStart: Math.floor(Date.now() / 1000),
        periodEnd: null,
      }).catch(() => {});
      break;
    }

    case 'PENDING':
      logger.info({ paymentId, workspaceId }, 'dLocal Go pago PENDING — sin acción por ahora');
      break;

    default:
      logger.info({ paymentId, status }, 'dLocal Go estado de pago no manejado');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers internos
// ══════════════════════════════════════════════════════════════════════════

function getPlanKeyFromAmount(amount) {
  if (!amount) return null;
  for (const [key, plan] of Object.entries(config.plans)) {
    if (plan.price && Math.abs(plan.price - amount) < 0.5) {
      return key;
    }
  }
  return null;
}

async function activateSubscription(workspaceId, planKey, subscriptionId) {
  const plan = config.plans[planKey];
  if (!plan) {
    logger.error({ planKey }, 'Plan desconocido en dLocal Go activateSubscription');
    return;
  }

  await db.query(
    `UPDATE workspaces
     SET plan                    = $1,
         payment_provider        = 'dlocalgo',
         payment_subscription_id = $2,
         payment_customer_id     = $2,
         suspended               = 0,
         max_videos              = $3,
         max_storage_bytes       = $4,
         max_bandwidth_bytes     = $5,
         payment_metadata        = $6,
         updated_at              = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
     WHERE id = $7`,
    [
      planKey,
      subscriptionId,
      plan.maxVideos,
      plan.maxStorageGB * 1e9,
      plan.maxBandwidthGB * 1e9,
      JSON.stringify({ activated_at: Math.floor(Date.now() / 1000), payment_id: subscriptionId }),
      workspaceId,
    ]
  );
  // Clear pending referral credit now that payment is confirmed
  clearReferralCredit(workspaceId).catch(() => {});
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.info({ workspaceId, planKey }, 'Plan activado vía dLocal Go');
}

async function downgradeWorkspace(workspaceId) {
  const starter = config.plans.starter;
  await db.query(
    `UPDATE workspaces
     SET plan                    = 'starter',
         payment_subscription_id = NULL,
         payment_customer_id     = NULL,
         suspended               = 0,
         max_videos              = $1,
         max_storage_bytes       = $2,
         max_bandwidth_bytes     = $3,
         payment_metadata        = '{}',
         updated_at              = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
     WHERE id = $4`,
    [starter.maxVideos, starter.maxStorageGB * 1e9, starter.maxBandwidthGB * 1e9, workspaceId]
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});
  logger.info({ workspaceId }, 'Workspace bajado a starter (dLocal Go)');
}

async function suspendWorkspace(workspaceId, reason = 'unknown') {
  await db.query(
    `UPDATE workspaces
     SET suspended  = 1,
         updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
     WHERE id = $1`,
    [workspaceId]
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});
  logger.warn({ workspaceId, reason }, 'Workspace suspendido (dLocal Go)');
}

module.exports = {
  getDLocalConfig,
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
  verifyWebhookSignature,
  processWebhookEvent,
};
