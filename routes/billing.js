const express = require('express');
const router = express.Router();
const config = require('../config');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const rateLimit = require('../middleware/rateLimit');
const paymentGateway = require('../services/paymentGateway');
const stripeService = require('../services/stripe');
const paypalService = require('../services/paypal');
const binanceService = require('../services/binance');
const dlocalgoService = require('../services/dlocalgo');
const invoiceService = require('../services/invoices');
const cache = require('../services/cache');
const logger = require('../services/logger').child({ module: 'billing' });

function isSafeRedirectUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    // Restrict redirects to the configured app domain to prevent open-redirect abuse.
    // Users setting a custom successUrl via the API must use the same origin as APP_URL.
    if (config.appUrl) {
      const appHost = new URL(config.appUrl).hostname;
      if (parsed.hostname !== appHost) return false;
    }
    return true;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════
// GET /gateways — Lista de gateways habilitados para el cliente
// ══════════════════════════════════════════════════════════════════════════
router.get('/gateways', authenticate, async (req, res) => {
  try {
    const gateways = await paymentGateway.getEnabledGateways();
    const result = Object.entries(gateways).map(([key, cfg]) => ({
      gateway: key,
      enabled: !!cfg.enabled,
      is_default: !!cfg.default,
    })).filter(g => g.enabled);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'Error fetching gateways for client');
    res.json([{ gateway: 'stripe', enabled: true, is_default: true }]);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /invoices — Facturas/historial de pagos del workspace
// ══════════════════════════════════════════════════════════════════════════
router.get('/invoices', authenticate, resolveWorkspace, async (req, res) => {
  try {
    const ws = req.workspace;
    const invoices = await invoiceService.getWorkspaceInvoices(ws.id, 50);

    res.json({
      invoices,
      subscription: {
        plan: ws.plan,
        provider: ws.payment_provider || null,
        active: !!ws.payment_subscription_id,
        subscriptionId: ws.payment_subscription_id || null,
      }
    });
  } catch (err) {
    logger.error({ err }, 'Error fetching invoices');
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /invoices/:id/download — Descargar PDF de factura
// ══════════════════════════════════════════════════════════════════════════
router.get('/invoices/:id/download', authenticate, resolveWorkspace, async (req, res) => {
  try {
    const ws = req.workspace;
    const invoiceId = req.params.id;

    const result = await invoiceService.generateInvoicePdf(invoiceId, ws.id);

    if (!result) {
      return res.status(404).json({ error: 'Factura no encontrada o PDF no disponible' });
    }

    // Si hay una URL externa (Stripe hosted invoice), redirigir
    if (result.redirect) {
      return res.redirect(302, result.redirect);
    }

    // Enviar PDF
    const invResult = await db.query(
      `SELECT invoice_number FROM payment_invoices WHERE id = $1 AND workspace_id = $2`,
      [invoiceId, ws.id]
    );
    const invNum = invResult.rows[0]?.invoice_number || invoiceId;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="factura-${invNum}.pdf"`,
      'Cache-Control': 'private, no-cache',
    });
    res.send(result);
  } catch (err) {
    logger.error({ err }, 'Error generating invoice PDF');
    res.status(500).json({ error: 'Error al generar PDF de factura' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /subscription/cancel — Cancelar suscripción activa
// ══════════════════════════════════════════════════════════════════════════
router.post('/subscription/cancel', rateLimit(5, 3_600_000), authenticate, resolveWorkspace, requireRole('owner'), async (req, res) => {
  try {
    const ws = req.workspace;
    if (!ws.payment_subscription_id) {
      return res.status(400).json({ error: 'No hay suscripción activa para cancelar' });
    }

    await paymentGateway.cancelSubscription(ws.id);

    // Registrar evento de cancelación
    await invoiceService.recordSubscriptionEvent({
      workspaceId: ws.id,
      eventType: 'cancelled',
      fromPlan: ws.plan,
      toPlan: 'starter',
      provider: ws.payment_provider || 'stripe',
      subscriptionId: ws.payment_subscription_id,
      metadata: { cancelledAt: Math.floor(Date.now() / 1000), reason: 'user_request' },
    });

    res.json({
      ok: true,
      message: 'Suscripción cancelada. Mantendrás acceso hasta el fin del período de facturación actual.'
    });
  } catch (err) {
    logger.error({ err }, 'Cancel subscription error');
    res.status(500).json({ error: err.message || 'Error al cancelar suscripción' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /subscription — Estado detallado de la suscripción
// ══════════════════════════════════════════════════════════════════════════
router.get('/subscription', authenticate, resolveWorkspace, async (req, res) => {
  try {
    const ws = req.workspace;
    const planConfig = config.plans[ws.plan] || config.plans.starter;
    let metadata = {};
    try { metadata = ws.payment_metadata ? JSON.parse(ws.payment_metadata) : {}; } catch {}

    // Obtener historial de eventos recientes
    const eventsResult = await db.query(
      `SELECT event_type, from_plan, to_plan, created_at
       FROM subscription_events
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [ws.id]
    ).catch(() => ({ rows: [] }));

    res.json({
      plan: ws.plan,
      planName: planConfig.name || ws.plan,
      price: planConfig.price || 0,
      provider: ws.payment_provider || null,
      active: !!ws.payment_subscription_id,
      suspended: !!ws.suspended,
      subscriptionId: ws.payment_subscription_id || null,
      customerId: ws.payment_customer_id || null,
      currentPeriodEnd: metadata.current_period_end || null,
      cancelAtPeriodEnd: metadata.cancel_at_period_end || false,
      recentEvents: eventsResult.rows,
    });
  } catch (err) {
    logger.error({ err }, 'Subscription status error');
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /checkout — Iniciar sesión de pago
// ══════════════════════════════════════════════════════════════════════════
router.post('/checkout', rateLimit(10, 3_600_000), authenticate, resolveWorkspace, requireRole('owner'), async (req, res) => {
  try {
    const { plan } = req.body;
    // Support both 'provider' (legacy) and 'gateway' (new frontend)
    let { provider, gateway } = req.body;
    provider = provider || gateway;

    if (!plan || !config.plans[plan]) {
      return res.status(400).json({ error: 'Plan inválido. Opciones: starter, pro, enterprise' });
    }

    // ── Planes gratuitos: no requieren pasarela de pago ──────────────────────
    const planConfig = config.plans[plan];
    const planPrice = planConfig?.price ?? 0;

    if (planPrice === 0) {
      // Plan gratuito: aplicar directamente sin pasar por pasarela
      const planLimits = {
        maxVideos: planConfig.maxVideos,
        maxStorageBytes: planConfig.maxStorageGB * 1e9,
        maxBandwidthBytes: planConfig.maxBandwidthGB * 1e9,
      };

      await db.prepare(`
        UPDATE workspaces
        SET plan = ?,
            max_videos = ?,
            max_storage_bytes = ?,
            max_bandwidth_bytes = ?,
            suspended = 0,
            stripe_subscription_id = NULL,
            payment_provider = NULL,
            payment_subscription_id = NULL,
            payment_customer_id = NULL,
            payment_metadata = '{}',
            updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
        WHERE id = ?
      `).run(
        plan,
        planLimits.maxVideos,
        planLimits.maxStorageBytes,
        planLimits.maxBandwidthBytes,
        req.workspace.id
      );
      cache.invalidate(`sv:ws:${req.workspace.id}`).catch(() => {});

      // Registrar evento de cambio de plan gratuito
      await invoiceService.recordSubscriptionEvent({
        workspaceId: req.workspace.id,
        eventType: 'upgraded',
        fromPlan: req.workspace.plan,
        toPlan: plan,
        provider: 'free',
        subscriptionId: null,
        metadata: { 
          isFree: true, 
          price: 0,
          appliedAt: Math.floor(Date.now() / 1000) 
        },
      }).catch(() => {});

      logger.info({
        workspaceId: req.workspace.id,
        fromPlan: req.workspace.plan,
        toPlan: plan,
        price: 0,
      }, 'Free plan activated');

      return res.json({
        success: true,
        isFree: true,
        plan: plan,
        message: `Plan ${planConfig.name} activado exitosamente (gratuito)`,
        limits: planLimits,
      });
    }

    // ── Planes pagos: requieren pasarela ─────────────────────────────────────
    // Auto-select the default/first enabled gateway if none specified
    const gateways = await paymentGateway.getEnabledGateways();
    if (!provider) {
      // Find the default gateway first, then any enabled one
      const defaultGw = Object.entries(gateways).find(([, cfg]) => cfg.default && cfg.enabled);
      const anyEnabled = Object.entries(gateways).find(([, cfg]) => cfg.enabled);
      const selected = defaultGw || anyEnabled;
      if (!selected) {
        return res.status(400).json({ error: 'No hay pasarelas de pago habilitadas. Configura una en el panel de administración.' });
      }
      provider = selected[0];
      logger.info({ provider, plan }, 'Auto-selected payment gateway');
    }

    if (!['stripe', 'paypal', 'binance', 'dlocalgo'].includes(provider)) {
      return res.status(400).json({ error: 'Proveedor inválido. Opciones: stripe, paypal, binance, dlocalgo' });
    }

    if (!gateways[provider]?.enabled) {
      return res.status(400).json({ error: `El proveedor de pago "${provider}" no está habilitado` });
    }

    // No permitir comprar el mismo plan que ya tienen
    if (req.workspace.plan === plan && req.workspace.payment_subscription_id) {
      return res.status(400).json({ error: `Ya tienes el plan ${config.plans[plan].name} activo` });
    }

    const successUrl = isSafeRedirectUrl(req.body.successUrl)
      ? req.body.successUrl : `${config.appUrl}/dashboard?checkout=success`;
    const cancelUrl  = isSafeRedirectUrl(req.body.cancelUrl)
      ? req.body.cancelUrl  : `${config.appUrl}/dashboard?checkout=cancel`;

    // ── Referral credit: auto-apply pending USD credit to this checkout ──
    // The credit is set when the user clicks "Aplicar descuento" on the referrals section.
    // We pass it to the gateway which handles it as a discount (gateway-specific logic).
    const pendingCredit = Number(req.workspace.referral_credit_usd ?? 0);

    const session = await paymentGateway.createCheckoutSession(
      req.workspace.id,
      plan,
      provider,
      successUrl,
      cancelUrl,
      pendingCredit   // discountUSD — each gateway applies it in its own way
    );

    res.json({
      checkoutUrl: session.checkoutUrl || session.url,
      sessionId: session.sessionId || session.id,
      provider: provider,
      qrContent: session.qrContent,
      deeplink: session.deeplink,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    logger.error({ err }, 'Checkout error');
    if (err.message?.includes('not configured') || err.message?.includes('no configurado') || err.message?.includes('No configurado')) {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error al crear sesión de pago: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /portal — Portal de gestión de facturación
// ══════════════════════════════════════════════════════════════════════════
router.get('/portal', authenticate, resolveWorkspace, requireRole('owner'), async (req, res) => {
  try {
    const returnUrl = isSafeRedirectUrl(req.query.returnUrl)
      ? req.query.returnUrl
      : `${config.appUrl}/dashboard`;

    const result = await paymentGateway.createPortalSession(req.workspace.id, returnUrl);

    res.json({
      portalUrl: result.portalUrl || result.url,
      message: result.message,
      expiryDate: result.expiryDate,
      daysRemaining: result.daysRemaining,
    });
  } catch (err) {
    logger.error({ err }, 'Portal error');
    if (err.message?.includes('No') && err.message?.includes('subscription')) {
      return res.status(400).json({ error: 'No hay suscripción activa para gestionar' });
    }
    if (err.message?.includes('No Stripe customer')) {
      return res.status(400).json({ error: 'No se encontró una cuenta de Stripe asociada. Completa un pago primero.' });
    }
    res.status(500).json({ error: 'Error al acceder al portal de facturación' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// GET /status — Estado completo de facturación y límites
// ══════════════════════════════════════════════════════════════════════════
router.get('/status', authenticate, resolveWorkspace, async (req, res) => {
  try {
    const ws = req.workspace;
    const dynCfg = require('../services/dynamicConfig');

    // ── Merge plan data: DB (admin-configured) overrides config.js defaults ──
    // Admin panel saves to system_config via keys like 'plans.pro', 'plans.enterprise'.
    // config.js has static defaults. DB takes precedence so admin price changes work.
    async function getMergedPlan(key) {
      const staticPlan = config.plans[key] || {};
      const dbPlan = await dynCfg.getDynConfig(`plans.${key}`, null).catch(() => null);
      if (!dbPlan || typeof dbPlan !== 'object') return staticPlan;
      // DB plan may store features differently — normalize
      const dbFeatures = dbPlan.features || {};
      return {
        ...staticPlan,
        name:           dbPlan.name           || staticPlan.name,
        price:          dbPlan.price          ?? staticPlan.price,
        maxVideos:      dbPlan.maxVideos       ?? staticPlan.maxVideos,
        maxStorageGB:   dbPlan.maxStorageGB    ?? staticPlan.maxStorageGB,
        maxBandwidthGB: dbPlan.maxBandwidthGB  ?? staticPlan.maxBandwidthGB,
        embed:          dbFeatures.embed       || staticPlan.embed,
        analytics:      dbFeatures.analytics   || staticPlan.analytics,
        subtitles:      dbFeatures.subtitles   ?? staticPlan.subtitles,
        apiAccess:      dbFeatures.apiAccess   ?? staticPlan.apiAccess,
        customDomain:   dbFeatures.customDomain ?? false,
      };
    }

    const [planConfig, allMergedPlans] = await Promise.all([
      getMergedPlan(ws.plan).then(p => p || config.plans.starter),
      Promise.all(Object.keys(config.plans).map(async key => ({
        key,
        ...(await getMergedPlan(key)),
      }))),
    ]);

    let videoCount = { count: 0 };
    try {
      const videoCountResult = await db.prepare(
        `SELECT COUNT(*) as count FROM videos WHERE workspace_id = ?`
      ).get(ws.id);
      videoCount = videoCountResult || { count: 0 };
    } catch (e) {
      logger.warn({ err: e.message }, 'Video count query failed');
    }

    let paymentStatus = { hasActiveSubscription: false, provider: 'stripe', plan: ws.plan, suspended: false, metadata: {} };
    try {
      paymentStatus = await paymentGateway.getPaymentStatus(ws.id);
    } catch (e) {
      logger.warn({ err: e.message }, 'getPaymentStatus failed');
    }

    let enabledGateways = { stripe: { enabled: true, default: true } };
    try {
      enabledGateways = await paymentGateway.getEnabledGateways();
    } catch (e) {
      logger.warn({ err: e.message }, 'getEnabledGateways failed');
    }

    // Referral credit config: admin sets how many USD each credit is worth
    const referralCreditUSD = await dynCfg.getDynConfig('referrals.creditUSD', 10).catch(() => 10);

    let metadata = {};
    try { metadata = ws.payment_metadata ? JSON.parse(ws.payment_metadata) : {}; } catch {}

    res.json({
      plan: ws.plan,
      planName: planConfig.name,
      price: planConfig.price,
      hasSubscription: paymentStatus.hasActiveSubscription,
      paymentProvider: paymentStatus.provider,
      suspended: paymentStatus.suspended,
      cancelAtPeriodEnd: metadata.cancel_at_period_end || false,
      currentPeriodEnd: metadata.current_period_end || null,
      limits: {
        videos: { used: videoCount?.count || 0, max: ws.max_videos },
        storage: {
          usedBytes: ws.storage_used_bytes,
          maxBytes: ws.max_storage_bytes,
          usedGB: (ws.storage_used_bytes / 1e9).toFixed(2),
          maxGB: (ws.max_storage_bytes / 1e9).toFixed(0),
        },
        bandwidth: {
          usedBytes: ws.bandwidth_used_bytes,
          maxBytes: ws.max_bandwidth_bytes,
          usedGB: (ws.bandwidth_used_bytes / 1e9).toFixed(2),
          maxGB: (ws.max_bandwidth_bytes / 1e9).toFixed(0),
        },
      },
      features: {
        embed: planConfig.embed,
        analytics: planConfig.analytics,
        subtitles: planConfig.subtitles,
        apiAccess: planConfig.apiAccess,
        customDomain: planConfig.customDomain,
      },
      referralCreditUSD,
      availablePlans: allMergedPlans.map(p => ({
        key:            p.key,
        name:           p.name,
        price:          p.price,
        maxVideos:      p.maxVideos,
        maxStorageGB:   p.maxStorageGB,
        maxBandwidthGB: p.maxBandwidthGB,
        features: {
          embed:        p.embed,
          analytics:    p.analytics,
          subtitles:    p.subtitles,
          apiAccess:    p.apiAccess,
          customDomain: p.customDomain,
        },
      })),
      enabledGateways,
    });
  } catch (err) {
    logger.error({ err }, 'Billing status error');
    res.status(500).json({ error: 'Failed to fetch billing status' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Webhook Endpoints
// ══════════════════════════════════════════════════════════════════════════

// Stripe webhook — requiere raw body (configurado en server.js con express.raw)
router.post('/webhooks/stripe', async (req, res) => {
  const stripe = stripeService.getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  // [HIGH-14] STRIPE_WEBHOOK_SECRET es OBLIGATORIO. Si no está configurado,
  // rechazamos el webhook con 500 (fail-closed). No procesamos webhooks sin verificación.
  if (!config.stripe.webhookSecret) {
    logger.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook (fail-closed). Set STRIPE_WEBHOOK_SECRET in .env');
    return res.status(500).json({ error: 'Webhook secret not configured on server' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    logger.warn('Stripe webhook missing stripe-signature header — rejecting');
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
  } catch (err) {
    logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    await stripeService.processWebhookEvent(event);
  } catch (err) {
    logger.error({ err: err.message, eventType: event.type }, 'Stripe webhook processing error');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  res.json({ received: true });
});

// PayPal webhook
router.post('/webhooks/paypal', async (req, res) => {
  try {
    const isValid = await paypalService.verifyWebhookSignature(req.headers, req.body);

    if (!isValid) {
      logger.warn('PayPal webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    res.json({ received: true });

    const paypalEvent = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    Promise.resolve(paypalService.processWebhookEvent(paypalEvent)).catch(err =>
      logger.error({ err: err.message }, 'PayPal webhook processing error')
    );
  } catch (err) {
    logger.error({ err: err.message }, 'PayPal webhook error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// dLocal Go webhook
// dLocal Go envía: POST { payment_id } con header Authorization: V2-HMAC-SHA256, Signature: <hex>
router.post('/webhooks/dlocalgo', async (req, res) => {
  try {
    const cfg = dlocalgoService.getDLocalConfig();
    if (!cfg) {
      return res.status(503).json({ error: 'dLocal Go no configurado' });
    }

    const isValid = dlocalgoService.verifyWebhookSignature(req.headers, req.body);
    if (!isValid) {
      logger.warn('dLocal Go webhook: firma inválida — rechazando');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Responder 200 de inmediato para que dLocal Go no reintente
    res.json({ received: true });

    const event = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString())
      : req.body;

    Promise.resolve(dlocalgoService.processWebhookEvent(event)).catch(err =>
      logger.error({ err: err.message }, 'dLocal Go webhook processing error')
    );
  } catch (err) {
    logger.error({ err: err.message }, 'dLocal Go webhook error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Binance Pay webhook
router.post('/webhooks/binance', async (req, res) => {
  try {
    const isValid = binanceService.verifyWebhookSignature(req.headers, req.body);

    if (!isValid) {
      logger.warn('Binance Pay webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    res.json({ received: true });

    const binanceEvent = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    Promise.resolve(binanceService.processWebhookEvent(binanceEvent)).catch(err =>
      logger.error({ err: err.message }, 'Binance Pay webhook processing error')
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Binance Pay webhook error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Legacy webhook endpoint (backward compatibility)
router.post('/webhooks', (req, res, next) => {
  logger.info('Legacy /webhooks endpoint called — forwarding to /webhooks/stripe handler');
  // Reusar directamente el handler de Stripe en lugar de re-rutear
  const stripe = stripeService.getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  if (!config.stripe.webhookSecret) {
    logger.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook (fail-closed).');
    return res.status(500).json({ error: 'Webhook secret not configured on server' });
  }
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
  } catch (err) {
    logger.warn({ err: err.message }, 'Legacy webhook signature verification failed');
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
  res.json({ received: true });
  Promise.resolve(stripeService.processWebhookEvent(event)).catch(err =>
    logger.error({ err: err.message, eventType: event.type }, 'Legacy Stripe webhook processing error')
  );
});

// ══════════════════════════════════════════════════════════════════════════
// POST /referrals/redeem — Redeem all referral credits as a Stripe discount
//
// Each "credit" = a configurable USD amount (admin sets referrals.creditUSD,
// default $10). All accumulated credits are redeemed at once as a one-time
// invoice credit on the next Stripe billing cycle.
// This is profitable: if Pro=$10/mo and creditUSD=$2, referrer gets $2 off
// their next payment ($8 revenue vs $0) instead of a full free month.
// ══════════════════════════════════════════════════════════════════════════
router.post('/referrals/redeem', rateLimit(5, 3_600_000), authenticate, resolveWorkspace, requireRole('owner'), async (req, res) => {
  try {
    const ws = req.workspace;
    const dynCfg = require('../services/dynamicConfig');

    // Check that the current user is the workspace owner
    const ownerRow = await db.prepare(
      `SELECT free_months_remaining FROM workspaces WHERE id = ? AND owner_id = ?`
    ).get(ws.id, req.user.id);

    if (!ownerRow) {
      return res.status(403).json({ error: 'Solo el propietario puede canjear créditos' });
    }

    const creditCount = Number(ownerRow.free_months_remaining ?? 0);
    if (creditCount <= 0) {
      return res.status(400).json({ error: 'No tienes créditos de referidos disponibles' });
    }

    if (ws.plan === 'starter') {
      return res.status(400).json({ error: 'Necesitas un plan de pago activo para canjear créditos' });
    }

    // Credit value in USD per referral — set by admin in system_config (referrals.creditUSD)
    const creditUSD = await dynCfg.getDynConfig('referrals.creditUSD', 10).catch(() => 10);
    const totalCreditUSD = creditCount * Number(creditUSD);
    const totalCreditCents = Math.round(totalCreditUSD * 100);

    const now = Math.floor(Date.now() / 1000);

    // Store credit as a pending USD balance in the workspace —
    // it will be automatically applied on the next checkout (any gateway).
    // Add to any existing pending credit (don't overwrite if they already had some).
    await db.prepare(
      `UPDATE workspaces
       SET free_months_remaining = 0,
           referral_credit_usd   = COALESCE(referral_credit_usd, 0) + ?,
           updated_at            = ?
       WHERE id = ?`
    ).run(totalCreditUSD, now, ws.id);

    // For Stripe: ALSO apply a balance transaction immediately so existing subscribers
    // see the discount on their very next invoice without needing a new checkout.
    let stripeApplied = false;
    try {
      const customerId = ws.stripe_customer_id || ws.payment_customer_id;
      if (customerId && ws.payment_provider === 'stripe') {
        const stripe = stripeService.getStripe();
        if (stripe) {
          await stripe.customers.createBalanceTransaction(customerId, {
            amount: -totalCreditCents,
            currency: 'usd',
            description: `Crédito referido: ${creditCount} × $${creditUSD}`,
          });
          // Balance applied directly → no need to consume again at checkout for Stripe
          // Mark credit as already consumed for Stripe subscribers
          await db.prepare(
            `UPDATE workspaces SET referral_credit_usd = 0, updated_at = ? WHERE id = ?`
          ).run(now, ws.id);
          stripeApplied = true;
        }
      }
    } catch (stripeErr) {
      logger.warn({ err: stripeErr.message, wsId: ws.id },
        'Stripe balance transaction failed — credit kept as pending for next checkout');
    }

    // Invalidate workspace cache
    cache.invalidate(`sv:ws:${ws.id}`).catch(() => {});

    logger.info({ userId: req.user.id, wsId: ws.id, creditCount, totalCreditUSD, stripeApplied }, 'Referral credits redeemed');

    res.json({
      success: true,
      creditCount,
      totalCreditUSD,
      stripeApplied,
      message: stripeApplied
        ? `¡$${totalCreditUSD} aplicados! Se descontarán de tu próxima factura Stripe automáticamente.`
        : `¡$${totalCreditUSD} en crédito listos! Se aplicarán automáticamente en tu próximo pago.`,
      remainingCredits: 0,
    });
  } catch (err) {
    logger.error({ err }, 'Referral redeem error');
    res.status(500).json({ error: 'Error al canjear créditos' });
  }
});

module.exports = router;
