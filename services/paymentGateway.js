/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Payment Gateway Abstraction Layer
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Capa unificada para manejar múltiples proveedores de pago:
 * - Stripe (tarjetas crédito/débito - global)
 * - PayPal (tarjetas, PayPal balance, PSE - LATAM friendly)
 * - Binance Pay (criptomonedas USDT/BTC - automated recurring)
 * 
 * Cada proveedor implementa la misma interfaz:
 * - createCheckoutSession()
 * - createPortalSession() 
 * - processWebhook()
 * - cancelSubscription()
 */

const stripeService = require('./stripe');
const paypalService = require('./paypal');
const binanceService = require('./binance');
const dlocalgoService = require('./dlocalgo');
const gwCreds = require('./gatewayCredentials');
const logger = require('./logger').child({ module: 'paymentGateway' });
const db = require('../db');

/**
 * Obtiene el servicio correcto según el proveedor
 */
function getProviderService(provider) {
  switch (provider) {
    case 'stripe':    return stripeService;
    case 'paypal':    return paypalService;
    case 'binance':   return binanceService;
    case 'dlocalgo':  return dlocalgoService;
    default:
      throw new Error(`Unknown payment provider: ${provider}`);
  }
}

/**
 * Crea una sesión de checkout para iniciar una suscripción
 * 
 * @param {string} workspaceId - ID del workspace
 * @param {string} planKey - Plan a adquirir (starter/pro/enterprise)
 * @param {string} provider - Proveedor de pago (stripe/paypal/binance)
 * @param {string} successUrl - URL de retorno exitoso
 * @param {string} cancelUrl - URL de retorno cancelado
 * @returns {Promise<{checkoutUrl: string, sessionId: string}>}
 */
async function createCheckoutSession(workspaceId, planKey, provider = 'stripe', successUrl, cancelUrl) {
  logger.info({ workspaceId, planKey, provider }, 'Creating checkout session');
  
  const service = getProviderService(provider);
  
  if (!service || !service.createCheckoutSession) {
    throw new Error(`Provider ${provider} not configured or not available`);
  }

  const session = await service.createCheckoutSession(
    workspaceId,
    planKey,
    successUrl,
    cancelUrl
  );

  return session;
}

/**
 * Crea una sesión del portal de gestión de facturación
 * (solo Stripe y PayPal tienen portales nativos, Binance usa custom UI)
 * 
 * @param {string} workspaceId - ID del workspace
 * @param {string} returnUrl - URL de retorno
 * @returns {Promise<{portalUrl: string}>}
 */
async function createPortalSession(workspaceId, returnUrl) {
  // Detectar el proveedor actual del workspace
  const result = await db.query(
    `SELECT payment_provider FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  const workspace = result.rows[0];

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const provider = workspace.payment_provider || 'stripe';
  logger.info({ workspaceId, provider }, 'Creating billing portal session');

  const service = getProviderService(provider);

  if (!service.createBillingPortalSession) {
    throw new Error(`Provider ${provider} does not support billing portal`);
  }

  return await service.createBillingPortalSession(workspaceId, returnUrl);
}

/**
 * Procesa un webhook event del proveedor correspondiente
 * 
 * @param {string} provider - Proveedor del webhook
 * @param {object} event - Evento del webhook
 * @param {object} rawBody - Body crudo (para verificación de firma)
 * @param {object} headers - Headers HTTP (para verificación)
 */
async function processWebhook(provider, event, rawBody, headers) {
  logger.info({ provider, eventType: event.type || event.event_type }, 'Processing webhook');

  const service = getProviderService(provider);

  if (!service.processWebhookEvent) {
    throw new Error(`Provider ${provider} does not support webhooks`);
  }

  await service.processWebhookEvent(event, rawBody, headers);
}

/**
 * Cancela una suscripción activa
 * 
 * @param {string} workspaceId - ID del workspace
 * @returns {Promise<void>}
 */
async function cancelSubscription(workspaceId) {
  const workspace = await db.prepare(
    `SELECT payment_provider, payment_subscription_id FROM workspaces WHERE id = ?`
  ).get(workspaceId);

  if (!workspace || !workspace.payment_subscription_id) {
    throw new Error('No active subscription found');
  }

  const provider = workspace.payment_provider || 'stripe';
  logger.info({ workspaceId, provider }, 'Cancelling subscription');

  const service = getProviderService(provider);

  if (!service.cancelSubscription) {
    throw new Error(`Provider ${provider} does not support subscription cancellation`);
  }

  await service.cancelSubscription(workspace.payment_subscription_id);
}

/**
 * Obtiene información del estado de pago del workspace
 * 
 * @param {string} workspaceId
 * @returns {Promise<object>} Estado del pago
 */
async function getPaymentStatus(workspaceId) {
  const workspace = await db.prepare(`
    SELECT 
      plan,
      payment_provider,
      payment_customer_id,
      payment_subscription_id,
      payment_metadata,
      suspended
    FROM workspaces 
    WHERE id = ?
  `).get(workspaceId);

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  return {
    provider: workspace.payment_provider || 'stripe',
    hasActiveSubscription: !!workspace.payment_subscription_id,
    plan: workspace.plan,
    suspended: !!workspace.suspended,
    metadata: workspace.payment_metadata ? JSON.parse(workspace.payment_metadata) : {},
  };
}

/**
 * Obtiene los proveedores habilitados desde system_config
 * 
 * @returns {Promise<object>} Configuración de gateways habilitados
 */
async function getEnabledGateways() {
  try {
    const row = await db.prepare(
      `SELECT value FROM system_config WHERE key = 'payment_gateways'`
    ).get();

    if (row?.value) {
      return JSON.parse(row.value);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not load payment gateways config');
  }

  // Defaults si no hay config en DB — check both env AND DB credentials
  let hasDlocal = false;
  let hasBinance = false;
  let hasPaypal = false;
  try {
    hasDlocal  = await gwCreds.isConfigured('dlocalgo');
    hasBinance = await gwCreds.isConfigured('binance');
    hasPaypal  = await gwCreds.isConfigured('paypal');
  } catch {
    hasDlocal  = !!(process.env.DLOCALGO_API_KEY && process.env.DLOCALGO_SECRET_KEY);
    hasBinance = !!(process.env.BINANCE_API_KEY  && process.env.BINANCE_SECRET_KEY);
    hasPaypal  = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  }
  return {
    stripe:   { enabled: false, default: false },
    paypal:   { enabled: hasPaypal, default: !hasDlocal && hasPaypal },
    dlocalgo: { enabled: hasDlocal,  default: hasDlocal  },
    binance:  { enabled: hasBinance, default: !hasDlocal && !hasPaypal && hasBinance },
  };
}

/**
 * Guarda la configuración de gateways habilitados
 * 
 * @param {object} config - Configuración de gateways
 */
async function setEnabledGateways(config) {
  await db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES ('payment_gateways', ?, FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
    ON CONFLICT(key) DO UPDATE 
    SET value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at
  `).run(JSON.stringify(config));

  logger.info({ config }, 'Payment gateways configuration updated');
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  processWebhook,
  cancelSubscription,
  getPaymentStatus,
  getEnabledGateways,
  setEnabledGateways,
};
