const config = require('../config');
const db = require('../db');
const cache = require('./cache');
const logger = require('./logger').child({ module: 'stripe' });
const invoiceService = require('./invoices');
const emailService = require('./email');
const { awardReferralCredit } = require('./referralCredit');

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!config.stripe.secretKey || config.stripe.secretKey.startsWith('sk_test_...')) {
    return null;
  }
  _stripe = require('stripe')(config.stripe.secretKey);
  return _stripe;
}

async function createCustomer(email, name, workspaceId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { workspaceId },
  });

  await db.query(
    `UPDATE workspaces SET payment_provider = 'stripe', payment_customer_id = $1, stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, workspaceId]
  );

  return customer;
}

async function createCheckoutSession(workspaceId, planKey, successUrl, cancelUrl) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  const priceId = config.stripe.prices[planKey];
  if (!priceId) throw new Error(`Invalid plan: ${planKey}. Asegúrate de configurar STRIPE_PRICE_${planKey.toUpperCase()} en .env`);

  const wsResult = await db.query(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
  const workspace = wsResult.rows[0];
  if (!workspace) throw new Error('Workspace not found');

  let customerId = workspace.stripe_customer_id || workspace.payment_customer_id;
  if (!customerId) {
    const ownerResult = await db.query(`SELECT email, name FROM users WHERE id = $1`, [workspace.owner_id]);
    const owner = ownerResult.rows[0];
    const customer = await createCustomer(owner.email, owner.name, workspaceId);
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl || `${config.appUrl}/dashboard?checkout=success`,
    cancel_url: cancelUrl || `${config.appUrl}/dashboard?checkout=cancel`,
    metadata: { workspaceId, plan: planKey },
    subscription_data: {
      metadata: { workspaceId, plan: planKey },
    },
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
  });

  return session;
}

async function createBillingPortalSession(workspaceId, returnUrl) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  const wsResult = await db.query(
    `SELECT stripe_customer_id, payment_customer_id FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  const workspace = wsResult.rows[0];
  const customerId = workspace?.stripe_customer_id || workspace?.payment_customer_id;
  if (!customerId) {
    throw new Error('No Stripe customer associated with this workspace. Complete a checkout first.');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || `${config.appUrl}/dashboard`,
  });

  return session;
}

async function processWebhookEvent(event) {
  // ── Idempotency guard ─────────────────────────────────────────────────────
  // Stripe retries webhooks on network errors or non-2xx responses.
  // Without this check, the same event (e.g. checkout.session.completed) could
  // activate a plan twice, creating duplicate invoices and wrong plan states.
  // We use the webhook_deliveries table (already exists) keyed on event.id.
  if (event?.id) {
    try {
      const existing = await db.query(
        `SELECT id FROM webhook_deliveries WHERE event = $1 AND payload::jsonb->>'stripe_event_id' = $2 LIMIT 1`,
        ['stripe_idempotency', event.id]
      ).catch(() => null); // gracefully ignore if column doesn't exist yet

      if (existing?.rows?.length > 0) {
        logger.info({ eventId: event.id, eventType: event.type }, 'Stripe webhook already processed — skipping (idempotent)');
        return; // Already handled — do not process again
      }

      // Record this event BEFORE processing to prevent race conditions
      // (two concurrent retries both pass the check simultaneously).
      await db.query(
        `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, created_at)
         VALUES ($1, 'stripe-system', 'stripe_idempotency', $2::text, 200, FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT)
         ON CONFLICT DO NOTHING`,
        [require('uuid').v4 ? require('uuid').v4() : event.id + '_' + Date.now(), JSON.stringify({ stripe_event_id: event.id, type: event.type })]
      ).catch(() => {}); // Non-fatal: if insert fails, processing continues
    } catch {}
  }

  switch (event.type) {

    // ── Successful checkout → activate plan ──────────────────────────────────
    case 'checkout.session.completed': {
      const session     = event.data.object;
      const workspaceId = session.metadata?.workspaceId;
      const planKey     = session.metadata?.plan;
      if (workspaceId && planKey) {
        try {
          const ws = await db.query(`SELECT plan, owner_id FROM workspaces WHERE id = $1`, [workspaceId]);
          const fromPlan = ws.rows[0]?.plan || 'starter';
          await activateSubscription(workspaceId, planKey, session.subscription);
          await invoiceService.recordSubscriptionEvent({
            workspaceId,
            eventType: fromPlan === 'starter' ? 'activated' : 'upgraded',
            fromPlan,
            toPlan: planKey,
            provider: 'stripe',
            subscriptionId: session.subscription,
          });
          
          // ── REFERRAL CREDIT: award 1 free month to referrer on first purchase ──
          const ownerId = ws.rows[0]?.owner_id;
          if (ownerId && fromPlan === 'starter') {
            awardReferralCredit(ownerId).catch(err =>
              logger.error({ err: err.message }, 'awardReferralCredit (Stripe) failed')
            );
          }
          
          // Enviar email de activación
          if (ownerId) {
            const userRes = await db.query(`SELECT email, name FROM users WHERE id = $1`, [ownerId]);
            const user = userRes.rows[0];
            if (user) {
              const planConfig = config.plans[planKey];
              emailService.sendSubscriptionActivated(user.email, user.name, planConfig?.name || planKey)
                .catch(e => logger.error({ err: e.message }, 'sendSubscriptionActivated error'));
            }
          }
        } catch (err) {
          logger.error({ err: err.message }, 'checkout.session.completed error');
        }
      }
      break;
    }

    // ── Subscription changed (upgrade / downgrade / status change) ───────────
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      try {
        const wsResult = await db.query(
          `SELECT id, plan FROM workspaces WHERE stripe_subscription_id = $1`,
          [subscription.id]
        );
        const workspace = wsResult.rows[0];
        if (!workspace) break;

        if (subscription.status === 'active') {
          const priceId = subscription.items?.data?.[0]?.price?.id;
          const planKey = Object.entries(config.stripe.prices)
            .find(([, v]) => v === priceId)?.[0];
          if (planKey && planKey !== workspace.plan) {
            const fromPlan = workspace.plan;
            await activateSubscription(workspace.id, planKey, subscription.id);
            await invoiceService.recordSubscriptionEvent({
              workspaceId: workspace.id,
              eventType: planKey > fromPlan ? 'upgraded' : 'downgraded',
              fromPlan,
              toPlan: planKey,
              provider: 'stripe',
              subscriptionId: subscription.id,
            });
          }
        } else if (['past_due', 'unpaid'].includes(subscription.status)) {
          logger.warn({ workspaceId: workspace.id, status: subscription.status }, 'Subscription past due — suspending workspace');
          await suspendWorkspace(workspace.id, subscription.status);
          await invoiceService.recordSubscriptionEvent({
            workspaceId: workspace.id,
            eventType: 'suspended',
            fromPlan: workspace.plan,
            provider: 'stripe',
            subscriptionId: subscription.id,
            metadata: { reason: subscription.status },
          });
        } else if (subscription.cancel_at_period_end) {
          // Marcar en metadata que se cancelará al final del período
          const periodEnd = subscription.current_period_end;
          await db.query(
            `UPDATE workspaces SET payment_metadata = $1, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = $2`,
            [JSON.stringify({ cancel_at_period_end: true, current_period_end: periodEnd }), workspace.id]
          );
        }
      } catch (err) {
        logger.error({ err: err.message }, 'subscription.updated error');
      }
      break;
    }

    // ── Subscription cancelled → downgrade to starter ────────────────────────
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      try {
        const wsResult = await db.query(
          `SELECT id, plan, owner_id FROM workspaces WHERE stripe_subscription_id = $1`,
          [subscription.id]
        );
        const workspace = wsResult.rows[0];
        if (!workspace) break;
        logger.info({ workspaceId: workspace.id }, 'Subscription deleted — downgrading to starter');
        const fromPlan = workspace.plan;
        const fromPlanConfig = config.plans[fromPlan];
        await downgradeWorkspace(workspace.id);
        await invoiceService.recordSubscriptionEvent({
          workspaceId: workspace.id,
          eventType: 'cancelled',
          fromPlan,
          toPlan: 'starter',
          provider: 'stripe',
          subscriptionId: subscription.id,
        });
        // Enviar email de cancelación
        if (workspace.owner_id) {
          const userRes = await db.query(`SELECT email, name FROM users WHERE id = $1`, [workspace.owner_id]);
          const user = userRes.rows[0];
          if (user) {
            emailService.sendSubscriptionCancelled(user.email, user.name, {
              planName: fromPlanConfig?.name || fromPlan,
              accessUntil: subscription.current_period_end || null,
            }).catch(e => logger.error({ err: e.message }, 'sendSubscriptionCancelled error'));
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'subscription.deleted error');
      }
      break;
    }

    // ── Payment failed → suspend workspace + log ─────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      logger.error({ customer: invoice.customer, invoiceId: invoice.id, amountDue: invoice.amount_due, attemptCount: invoice.attempt_count }, 'Payment failed');
      try {
        const wsResult = await db.query(
          `SELECT w.id, w.plan, w.owner_id FROM workspaces w WHERE w.stripe_customer_id = $1`,
          [invoice.customer]
        );
        const workspace = wsResult.rows[0];
        if (!workspace) break;
        logger.warn({ workspaceId: workspace.id }, 'Suspending workspace due to payment failure');
        await suspendWorkspace(workspace.id, 'payment_failed');
        await invoiceService.recordSubscriptionEvent({
          workspaceId: workspace.id,
          eventType: 'payment_failed',
          fromPlan: workspace.plan,
          provider: 'stripe',
          metadata: { invoiceId: invoice.id, amount: invoice.amount_due, attemptCount: invoice.attempt_count },
        });
        // Registrar factura fallida
        if (invoice.id) {
          const amountDue = (invoice.amount_due || 0) / 100;
          const priceId = invoice.lines?.data?.[0]?.price?.id;
          const planKey = priceId
            ? Object.entries(config.stripe.prices).find(([, v]) => v === priceId)?.[0] || workspace.plan
            : workspace.plan;
          await invoiceService.createInvoice({
            workspaceId: workspace.id,
            provider: 'stripe',
            planKey,
            amount: amountDue,
            currency: (invoice.currency || 'usd').toUpperCase(),
            status: 'failed',
            providerInvoiceId: invoice.id,
            invoiceUrl: invoice.hosted_invoice_url,
            periodStart: invoice.period_start,
            periodEnd: invoice.period_end,
          }).catch(e => logger.error({ err: e.message }, 'Failed to create failed invoice record'));
        }
        // Enviar email de pago fallido
        if (workspace.owner_id) {
          const userRes = await db.query(`SELECT email, name FROM users WHERE id = $1`, [workspace.owner_id]);
          const user = userRes.rows[0];
          if (user) {
            const planConfig = config.plans[workspace.plan];
            emailService.sendPaymentFailed(user.email, user.name, {
              planName: planConfig?.name || workspace.plan,
              attemptCount: invoice.attempt_count || 1,
            }).catch(e => logger.error({ err: e.message }, 'sendPaymentFailed error'));
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'invoice.payment_failed error');
      }
      break;
    }

    // ── Invoice paid → crear factura + levantar suspensión ───────────────────
    case 'invoice.paid': {
      const invoice = event.data.object;
      try {
        const wsResult = await db.query(
          `SELECT id, plan, owner_id FROM workspaces WHERE stripe_customer_id = $1`,
          [invoice.customer]
        );
        const workspace = wsResult.rows[0];
        if (!workspace) break;

        // Levantar suspensión si estaba suspendido
        const wsCheck = await db.query(`SELECT suspended FROM workspaces WHERE id = $1`, [workspace.id]);
        if (wsCheck.rows[0]?.suspended) {
          await db.query(
            `UPDATE workspaces SET suspended = 0, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = $1`,
            [workspace.id]
          );
          cache.invalidate(`sv:ws:${workspace.id}`).catch(() => {});
          await invoiceService.recordSubscriptionEvent({
            workspaceId: workspace.id,
            eventType: 'restored',
            toPlan: workspace.plan,
            provider: 'stripe',
            metadata: { invoiceId: invoice.id },
          });
          logger.info({ workspaceId: workspace.id }, 'Workspace suspension lifted after successful payment');
        }

        // Guardar factura automáticamente y enviar email
        if (invoice.id && invoice.amount_paid > 0) {
          const amountPaid = invoice.amount_paid / 100;
          const priceId = invoice.lines?.data?.[0]?.price?.id;
          const planKey = priceId
            ? Object.entries(config.stripe.prices).find(([, v]) => v === priceId)?.[0] || workspace.plan
            : workspace.plan;
          const inv = await invoiceService.createInvoice({
            workspaceId: workspace.id,
            provider: 'stripe',
            planKey,
            amount: amountPaid,
            currency: (invoice.currency || 'usd').toUpperCase(),
            status: 'paid',
            providerInvoiceId: invoice.id,
            invoiceUrl: invoice.hosted_invoice_url,
            periodStart: invoice.period_start,
            periodEnd: invoice.period_end,
          });
          // Enviar email de confirmación de pago
          if (workspace.owner_id) {
            const userRes = await db.query(`SELECT email, name FROM users WHERE id = $1`, [workspace.owner_id]);
            const user = userRes.rows[0];
            if (user) {
              const planConfig = config.plans[planKey];
              emailService.sendPaymentConfirmation(user.email, user.name, {
                planName: planConfig?.name || planKey,
                amount: amountPaid.toFixed(2),
                currency: (invoice.currency || 'usd').toUpperCase(),
                invoiceNumber: inv?.invoiceNumber || '',
                periodEnd: invoice.period_end,
              }).catch(e => logger.error({ err: e.message }, 'sendPaymentConfirmation error'));
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, 'invoice.paid error');
      }
      break;
    }

    default:
      if (process.env.NODE_ENV !== 'production') {
        logger.info({ eventType: event.type }, 'Unhandled Stripe event');
      }
  }
}

async function activateSubscription(workspaceId, planKey, subscriptionId) {
  const plan = config.plans[planKey];
  if (!plan) {
    logger.error({ planKey }, 'Unknown plan key');
    return;
  }

  await db.query(
    `UPDATE workspaces
     SET plan                    = $1,
         payment_provider        = 'stripe',
         payment_subscription_id = $2,
         stripe_subscription_id  = $2,
         payment_metadata        = '{}',
         suspended               = 0,
         max_videos              = $3,
         max_storage_bytes       = $4,
         max_bandwidth_bytes     = $5,
         updated_at              = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
     WHERE id = $6`,
    [planKey, subscriptionId, plan.maxVideos, plan.maxStorageGB * 1e9, plan.maxBandwidthGB * 1e9, workspaceId]
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.info({ workspaceId, planKey }, 'Workspace plan activated');
}

async function downgradeWorkspace(workspaceId) {
  const starter = config.plans.starter;
  await db.query(
    `UPDATE workspaces
     SET plan                    = 'starter',
         stripe_subscription_id  = NULL,
         payment_subscription_id = NULL,
         payment_metadata        = '{}',
         suspended               = 0,
         max_videos              = $1,
         max_storage_bytes       = $2,
         max_bandwidth_bytes     = $3,
         updated_at              = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
     WHERE id = $4`,
    [starter.maxVideos, starter.maxStorageGB * 1e9, starter.maxBandwidthGB * 1e9, workspaceId]
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});

  logger.info({ workspaceId }, 'Workspace downgraded to starter');
}

async function suspendWorkspace(workspaceId, reason = 'unknown') {
  await db.query(
    `UPDATE workspaces SET suspended = 1, updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT WHERE id = $1`,
    [workspaceId]
  );
  cache.invalidate(`sv:ws:${workspaceId}`).catch(() => {});
  logger.warn({ workspaceId, reason }, 'Workspace suspended');
}

async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe not configured');

  // cancel_at_period_end=true: el acceso se mantiene hasta fin del período
  const subscription = await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  logger.info({ subscriptionId, cancelAt: subscription.cancel_at }, 'Stripe subscription set to cancel at period end');
  return subscription;
}

module.exports = {
  getStripe,
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  processWebhookEvent,
  cancelSubscription,
};
