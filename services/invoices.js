/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Invoice Service
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Gestiona el ciclo de vida de las facturas:
 * - Creación automática al recibir webhooks de pago
 * - Generación de número de factura único
 * - Registro de eventos de suscripción para auditoría
 * - Generación de PDF básico con pdfkit (si disponible)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const logger = require('./logger').child({ module: 'invoices' });
const config = require('../config');
const { getDynConfig } = require('./dynamicConfig');

// ── Número de factura ────────────────────────────────────────────────────
/**
 * Genera un número de factura único con formato SV-YYYYMM-NNNN
 */
async function generateInvoiceNumber() {
  const now = new Date();
  const prefix = `SV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Contar facturas del mes actual
  const startOfMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const result = await db.query(
    `SELECT COUNT(*) as cnt FROM payment_invoices WHERE created_at >= $1`,
    [startOfMonth]
  );
  const seq = (parseInt(result.rows[0]?.cnt || '0', 10) + 1).toString().padStart(4, '0');
  return `${prefix}-${seq}`;
}

// ── Crear factura ────────────────────────────────────────────────────────
/**
 * Crea un registro de factura en la base de datos
 *
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.provider         stripe | paypal | binance
 * @param {string} opts.planKey          starter | pro | enterprise
 * @param {number} opts.amount           Monto en USD
 * @param {string} [opts.currency]       Default: USD
 * @param {string} [opts.status]         paid | pending | failed
 * @param {string} [opts.providerInvoiceId]  ID de Stripe/PayPal
 * @param {string} [opts.invoiceUrl]     URL externa (Stripe hosted)
 * @param {number} [opts.periodStart]    Unix timestamp inicio período
 * @param {number} [opts.periodEnd]      Unix timestamp fin período
 * @param {string} [opts.description]
 * @returns {Promise<object>} factura creada
 */
async function createInvoice(opts) {
  const {
    workspaceId,
    provider = 'stripe',
    planKey = 'starter',
    amount = 0,
    currency = 'USD',
    status = 'paid',
    providerInvoiceId = null,
    invoiceUrl = null,
    periodStart = null,
    periodEnd = null,
    description = null,
  } = opts;

  // Verificar si ya existe factura para este providerInvoiceId (idempotencia)
  if (providerInvoiceId) {
    const existing = await db.query(
      `SELECT id FROM payment_invoices WHERE provider_invoice_id = $1`,
      [providerInvoiceId]
    );
    if (existing.rows.length > 0) {
      logger.info({ providerInvoiceId }, 'Invoice already exists, skipping duplicate');
      return existing.rows[0];
    }
  }

  const planConfig = config.plans[planKey] || config.plans.starter;
  const invoiceNumber = await generateInvoiceNumber();
  const now = Math.floor(Date.now() / 1000);
  const id = uuidv4();

  const _invPlat = await getDynConfig('platform.siteName', 'StreamVault').catch(() => 'StreamVault');
  const desc = description ||
    `Suscripción ${planConfig.name} — ${_invPlat} (${new Date().toLocaleDateString('es-CO', { month: 'long', year: 'numeric' })})`;

  await db.query(
    `INSERT INTO payment_invoices
       (id, workspace_id, invoice_number, amount, currency, status, provider, plan,
        description, period_start, period_end, invoice_url, provider_invoice_id, created_at, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      workspaceId,
      invoiceNumber,
      amount,
      currency,
      status,
      provider,
      planKey,
      desc,
      periodStart,
      periodEnd,
      invoiceUrl,
      providerInvoiceId,
      now,
      status === 'paid' ? now : null,
    ]
  );

  logger.info({ id, workspaceId, invoiceNumber, amount, provider, planKey }, 'Invoice created');
  return { id, invoiceNumber, amount, currency, status };
}

// ── Registrar evento de suscripción ─────────────────────────────────────
/**
 * Registra un evento de suscripción para auditoría
 *
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.eventType    activated | cancelled | upgraded | downgraded | suspended | restored | payment_failed
 * @param {string} [opts.fromPlan]
 * @param {string} [opts.toPlan]
 * @param {string} [opts.provider]
 * @param {string} [opts.subscriptionId]
 * @param {object} [opts.metadata]
 */
async function recordSubscriptionEvent(opts) {
  const {
    workspaceId,
    eventType,
    fromPlan = null,
    toPlan = null,
    provider = null,
    subscriptionId = null,
    metadata = {},
  } = opts;

  try {
    const now = Math.floor(Date.now() / 1000);
    await db.query(
      `INSERT INTO subscription_events
         (id, workspace_id, event_type, from_plan, to_plan, provider, subscription_id, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv4(), workspaceId, eventType, fromPlan, toPlan, provider, subscriptionId, JSON.stringify(metadata), now]
    );
    logger.info({ workspaceId, eventType, fromPlan, toPlan }, 'Subscription event recorded');
  } catch (err) {
    // No fatal — registro de auditoría no debe bloquear flujo principal
    logger.error({ err: err.message, workspaceId, eventType }, 'Failed to record subscription event');
  }
}

// ── Obtener facturas del workspace ───────────────────────────────────────
async function getWorkspaceInvoices(workspaceId, limit = 50) {
  const result = await db.query(
    `SELECT id, invoice_number, amount, currency, status, provider, plan,
            description, created_at, paid_at, period_start, period_end,
            invoice_url, invoice_pdf_url
     FROM payment_invoices
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit]
  );
  return result.rows;
}

// ── Generar PDF de factura ───────────────────────────────────────────────
/**
 * Genera un buffer PDF para la factura dada.
 * Si pdfkit no está instalado, retorna null y el sistema usa la URL externa.
 *
 * @param {string} invoiceId
 * @param {string} workspaceId  (para verificar pertenencia)
 * @returns {Promise<Buffer|null>}
 */
async function generateInvoicePdf(invoiceId, workspaceId) {
  // Cargar la factura
  const result = await db.query(
    `SELECT pi.*, w.name as workspace_name, u.email as owner_email, u.name as owner_name
     FROM payment_invoices pi
     JOIN workspaces w ON w.id = pi.workspace_id
     JOIN users u ON u.id = w.owner_id
     WHERE pi.id = $1 AND pi.workspace_id = $2`,
    [invoiceId, workspaceId]
  );

  if (!result.rows.length) return null;
  const inv = result.rows[0];

  // Si existe URL externa, no necesitamos generar PDF
  if (inv.invoice_url) {
    return { redirect: inv.invoice_url };
  }

  // Intentar usar pdfkit
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    logger.warn('pdfkit not installed — cannot generate PDF. Run: npm install pdfkit');
    return null;
  }

  const platformName   = await getDynConfig('platform.siteName', 'StreamVault');
  const supportEmail   = await getDynConfig('platform.supportEmail', config.smtp.from || config.smtp.user || '');
  const rawAppUrl      = await getDynConfig('platform.appUrl', config.appUrl || '');
  const platformDomain = rawAppUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const fmtDate = (ts) => ts
      ? new Date(ts * 1000).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—';
    const fmtMoney = (n, cur = 'USD') => `${cur} ${parseFloat(n).toFixed(2)}`;

    const accentColor = '#7c6cfa';
    const darkColor = '#0a0a0f';
    const mutedColor = '#666677';

    // ── Encabezado ──
    doc.rect(0, 0, doc.page.width, 90).fill(darkColor);
    doc.fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(22)
      .text(platformName, 50, 28);
    doc.fillColor(accentColor)
      .font('Helvetica')
      .fontSize(10)
      .text(platformDomain, 50, 54);
    doc.fillColor('#aaaacc')
      .fontSize(11)
      .text('FACTURA / RECEIPT', 390, 36, { align: 'right', width: 160 });
    doc.fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(inv.invoice_number, 390, 52, { align: 'right', width: 160 });

    // ── Datos factura ──
    doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(12).text('Detalles de factura', 50, 115);
    doc.moveTo(50, 132).lineTo(545, 132).strokeColor('#e5e5f0').stroke();

    const infoY = 142;
    doc.font('Helvetica').fontSize(10).fillColor(mutedColor);
    doc.text('Fecha:', 50, infoY);
    doc.text('Estado:', 50, infoY + 18);
    doc.text('Proveedor:', 50, infoY + 36);
    doc.text('Plan:', 50, infoY + 54);

    doc.fillColor(darkColor);
    doc.text(fmtDate(inv.paid_at || inv.created_at), 160, infoY);
    doc.fillColor(inv.status === 'paid' ? '#22d3a5' : '#f87171');
    doc.text(inv.status === 'paid' ? 'PAGADO' : inv.status.toUpperCase(), 160, infoY + 18);
    doc.fillColor(darkColor);
    doc.text((inv.provider || 'stripe').charAt(0).toUpperCase() + (inv.provider || 'stripe').slice(1), 160, infoY + 36);
    doc.text((config.plans[inv.plan]?.name || inv.plan), 160, infoY + 54);

    if (inv.period_start && inv.period_end) {
      doc.fillColor(mutedColor).text('Período:', 50, infoY + 72);
      doc.fillColor(darkColor).text(`${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}`, 160, infoY + 72);
    }

    // ── Datos cliente ──
    doc.font('Helvetica-Bold').fontSize(12).fillColor(darkColor).text('Facturado a', 320, 115);
    doc.moveTo(320, 132).lineTo(545, 132).strokeColor('#e5e5f0').stroke();
    doc.font('Helvetica').fontSize(10).fillColor(darkColor);
    doc.text(inv.owner_name || inv.owner_email, 320, infoY);
    doc.fillColor(mutedColor).text(inv.owner_email, 320, infoY + 16);
    doc.text(inv.workspace_name, 320, infoY + 32);

    // ── Tabla de ítems ──
    const tableY = 280;
    doc.rect(50, tableY, 495, 36).fill('#f5f5fd');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkColor);
    doc.text('Descripción', 62, tableY + 12);
    doc.text('Importe', 450, tableY + 12, { align: 'right', width: 83 });

    doc.font('Helvetica').fontSize(10).fillColor(darkColor);
    doc.text(inv.description || `Suscripción ${config.plans[inv.plan]?.name || inv.plan}`, 62, tableY + 52);
    doc.text(fmtMoney(inv.amount, inv.currency), 450, tableY + 52, { align: 'right', width: 83 });

    doc.moveTo(50, tableY + 76).lineTo(545, tableY + 76).strokeColor('#e5e5f0').stroke();

    // ── Total ──
    doc.rect(380, tableY + 84, 165, 40).fill(accentColor);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
    doc.text('TOTAL', 395, tableY + 96);
    doc.text(fmtMoney(inv.amount, inv.currency), 450, tableY + 96, { align: 'right', width: 83 });

    // ── Pie ──
    doc.fillColor(mutedColor).font('Helvetica').fontSize(9)
      .text(`Esta factura fue generada automáticamente por ${platformName}. Para soporte: ${supportEmail}`,
        50, doc.page.height - 60, { align: 'center', width: 495 });

    doc.end();
  });
}

module.exports = {
  createInvoice,
  recordSubscriptionEvent,
  getWorkspaceInvoices,
  generateInvoicePdf,
};
