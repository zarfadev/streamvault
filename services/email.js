/**
 * Email service using Nodemailer.
 * Falls back to console.log in development if SMTP is not configured.
 * All send functions swallow SMTP errors so callers never crash.
 */
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('./logger').child({ module: 'email' });

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function _platform() {
  try {
    const { getDynSection } = require('./dynamicConfig');
    const p = await getDynSection('platform', {});
    return {
      name: p.siteName || p.platformName || 'StreamVault',
      supportEmail: p.supportEmail || '',
    };
  } catch {
    return { name: 'StreamVault', supportEmail: '' };
  }
}

function _footer(platformName) {
  return `<hr style="border:none;border-top:1px solid #e8e8e8;margin:28px 0 20px;">
        <p style="color:#9a9a9a;font-size:12px;margin:0;line-height:1.5;">${escHtml(platformName)} — Video Streaming Platform</p>`;
}

// Envuelve el contenido en un shell de email completo con fondo blanco garantizado.
// Evita el problema de color:#1a1a2e invisible en clientes de correo en modo oscuro.
function _emailShell(platformName, innerHtml) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background:#f2f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:32px 16px;">
  <tr><td align="center">
    <!-- Header con branding -->
    <table width="540" cellpadding="0" cellspacing="0" role="presentation" style="max-width:540px;width:100%;margin-bottom:0;">
      <tr><td style="padding:0 0 16px 0;">
        <p style="margin:0;font-size:15px;font-weight:700;color:#7c6cfa;letter-spacing:-0.3px;">${escHtml(platformName)}</p>
      </td></tr>
    </table>
    <!-- Tarjeta principal -->
    <table width="540" cellpadding="0" cellspacing="0" role="presentation"
           style="max-width:540px;width:100%;background:#ffffff;border-radius:16px;
                  box-shadow:0 4px 24px rgba(0,0,0,0.08);overflow:hidden;">
      <tr><td style="padding:32px 36px 28px;">
        ${innerHtml}
      </td></tr>
    </table>
    <!-- Footer -->
    <table width="540" cellpadding="0" cellspacing="0" role="presentation" style="max-width:540px;width:100%;margin-top:16px;">
      <tr><td style="padding:0 4px;text-align:center;">
        <p style="margin:0;color:#b0b0b8;font-size:11px;line-height:1.6;">
          © ${new Date().getFullYear()} ${escHtml(platformName)}. Todos los derechos reservados.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// Heading estilizado (reemplaza el <h2> con color fijo)
function _h(text) {
  return `<p style="margin:0 0 14px;font-size:20px;font-weight:700;color:#18181b;line-height:1.3;">${text}</p>`;
}

// Texto de cuerpo
function _p(html, extra = '') {
  return `<p style="margin:0 0 14px;font-size:15px;color:#4b4b5a;line-height:1.65;${extra}">${html}</p>`;
}

// Botón CTA
function _btn(href, label, color = '#7c6cfa') {
  return `<a href="${escHtml(href)}"
     style="display:block;text-align:center;background:${color};color:#ffffff !important;
            text-decoration:none;padding:13px 28px;border-radius:10px;
            font-weight:700;font-size:15px;margin:22px 0;">${label}</a>`;
}

// Info box
function _box(html, style = 'background:#f8f8fb;border:1px solid #e8e8ee;') {
  return `<div style="${style}border-radius:10px;padding:16px 18px;margin:16px 0;font-size:14px;color:#4b4b5a;line-height:1.6;">${html}</div>`;
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (config.smtp.host && config.smtp.user) {
    transporter = nodemailer.createTransport({
      host:   config.smtp.host,
      port:   config.smtp.port,
      secure: config.smtp.port === 465,
      auth:   { user: config.smtp.user, pass: config.smtp.pass },
    });
    console.log('📧 Email: SMTP transporter configured');
    return transporter;
  }

  console.warn('📧 Email: No SMTP configured — emails will be logged to console');
  transporter = {
    sendMail: async (opts) => {
      console.log('─── EMAIL (dev mode) ───────────────────────');
      console.log(`To:      ${opts.to}`);
      console.log(`Subject: ${opts.subject}`);
      console.log(`Body:\n${opts.text || opts.html}`);
      console.log('────────────────────────────────────────────');
      return { messageId: 'dev-' + Date.now() };
    },
  };
  return transporter;
}

/**
 * Send an email with up to 3 automatic retries on transient SMTP errors.
 * Non-retryable errors (bad recipient, auth failure) fail immediately.
 * All errors are swallowed so callers never crash — but they are logged.
 */
async function _send(opts) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = [2000, 5000, 10000]; // 2s, 5s, 10s backoff

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await getTransporter().sendMail(opts);
      return true;
    } catch (err) {
      const isTransient = (
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.responseCode >= 500 ||       // SMTP 5xx server errors are retryable
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('timeout')
      );

      if (!isTransient || attempt === MAX_RETRIES) {
        logger.error({ err: err.message, to: opts.to, subject: opts.subject, attempt }, 'Email send failed permanently');
        return false;
      }

      logger.warn({ err: err.message, to: opts.to, attempt, nextRetryMs: RETRY_DELAY_MS[attempt - 1] }, `Email send failed (attempt ${attempt}/${MAX_RETRIES}) — retrying`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS[attempt - 1]));
    }
  }
  return false;
}

async function sendPasswordReset(email, resetToken) {
  const { name: pName } = await _platform();
  const resetUrl = `${config.appUrl}/auth/reset-password?token=${resetToken}`;
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Restablecer contraseña`,
    html: _emailShell(pName, `
      ${_h('Restablecer contraseña')}
      ${_p(`Recibimos una solicitud para restablecer tu contraseña en <strong>${escHtml(pName)}</strong>. Haz clic en el botón para crear una nueva:`)}
      ${_btn(resetUrl, 'Restablecer contraseña')}
      ${_p('Este enlace expira en <strong>1 hora</strong>. Si no solicitaste esto, ignora este email.', 'font-size:13px;color:#9a9a9a;')}
    `),
    text: `Restablecer contraseña de ${pName}\n\nVisita este enlace: ${resetUrl}\n\nEl enlace expira en 1 hora.`,
  });
}

async function sendWelcome(email, name) {
  const { name: pName } = await _platform();
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `¡Bienvenido a ${pName}!`,
    html: _emailShell(pName, `
      ${_h(`¡Bienvenido, ${escHtml(name)}!`)}
      ${_p(`Tu cuenta en <strong>${escHtml(pName)}</strong> está lista. Ya puedes subir videos, obtener streams HLS, y compartirlos con el mundo.`)}
      ${_btn(`${config.appUrl}/dashboard`, 'Ir al Dashboard')}
    `),
    text: `¡Bienvenido a ${pName}, ${name}!\n\nTu cuenta está lista: ${config.appUrl}/dashboard`,
  });
}

async function sendWorkspaceInvitation(email, inviterName, workspaceName, inviteToken) {
  const { name: pName } = await _platform();
  const acceptUrl = `${config.appUrl}/invite/${inviteToken}`;
  return await _send({
    from: config.smtp.from,
    to: email,
    subject: `${inviterName} te invitó a "${workspaceName}" en ${pName}`,
    html: _emailShell(pName, `
      ${_h('Invitación a workspace')}
      ${_p(`<strong>${escHtml(inviterName)}</strong> te ha invitado a unirte al workspace <strong>&ldquo;${escHtml(workspaceName)}&rdquo;</strong> en ${escHtml(pName)}.`)}
      ${_btn(acceptUrl, 'Aceptar invitación')}
      ${_p('Esta invitación expira en <strong>7 días</strong>.', 'font-size:13px;color:#9a9a9a;')}
    `),
    text: `${inviterName} te invitó al workspace "${workspaceName}" en ${pName}.\n\nAceptar: ${acceptUrl}`,
  });
}

async function sendEmailVerification(email, name, token) {
  const { name: pName } = await _platform();
  const verifyUrl = `${config.appUrl}/auth/verify-email?token=${token}`;
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Verifica tu correo electrónico`,
    html: _emailShell(pName, `
      ${_h('Verifica tu correo')}
      ${_p(`Hola <strong>${escHtml(name)}</strong>, bienvenido a ${escHtml(pName)}. Haz clic en el botón para verificar tu correo electrónico:`)}
      ${_btn(verifyUrl, 'Verificar correo')}
      ${_p('Este enlace expira en <strong>24 horas</strong>. Si no creaste una cuenta, ignora este email.', 'font-size:13px;color:#9a9a9a;')}
    `),
    text: `Verifica tu correo en ${pName}\n\nHola ${name},\n\nVisita este enlace: ${verifyUrl}\n\nEl enlace expira en 24 horas.`,
  });
}

async function sendTranscodeComplete(email, videoTitle, watchUrl) {
  const { name: pName } = await _platform();
  const fullUrl = watchUrl.startsWith('http') ? watchUrl : `${config.appUrl}${watchUrl}`;
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Tu video "${videoTitle}" está listo`,
    html: _emailShell(pName, `
      ${_h('Tu video está listo ✓')}
      ${_p(`El video <strong>&ldquo;${escHtml(videoTitle)}&rdquo;</strong> terminó de procesarse y ya está disponible.`)}
      ${_btn(fullUrl, 'Ver video', '#22d3a5')}
    `),
    text: `Tu video "${videoTitle}" está listo en ${pName}.\n\nVerlo: ${fullUrl}`,
  });
}

async function sendTranscodeError(email, videoTitle) {
  const { name: pName } = await _platform();
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Error procesando "${videoTitle}"`,
    html: _emailShell(pName, `
      ${_h('Error en procesamiento')}
      ${_p(`Hubo un problema al procesar el video <strong>&ldquo;${escHtml(videoTitle)}&rdquo;</strong>. Por favor sube el archivo nuevamente o contacta soporte.`)}
      ${_btn(`${config.appUrl}/dashboard`, 'Ir al Dashboard')}
    `),
    text: `Error procesando "${videoTitle}" en ${pName}. Por favor intenta de nuevo.`,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Payment & Subscription Emails
// ══════════════════════════════════════════════════════════════════════════

async function sendPaymentConfirmation(email, name, opts = {}) {
  const { name: pName, supportEmail } = await _platform();
  const { planName = 'Pro', amount = '0.00', currency = 'USD', invoiceNumber = '', periodEnd = null } = opts;
  const fmtDate = (ts) => ts
    ? new Date(ts * 1000).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const periodEndDate = fmtDate(periodEnd);

  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Pago confirmado · ${invoiceNumber || planName}`,
    html: _emailShell(pName, `
      <div style="text-align:center;margin-bottom:20px;">
        <div style="width:52px;height:52px;border-radius:50%;background:#e8fdf6;border:2px solid #22d3a5;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22d3a5" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        ${_h('¡Pago confirmado!')}
      </div>
      ${_p(`Hola <strong>${escHtml(name)}</strong>, tu suscripción al plan <strong>${escHtml(planName)}</strong> ha sido activada exitosamente. Gracias por confiar en ${escHtml(pName)}.`)}
      ${_box(`<table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#888;padding:5px 0;">Plan</td><td style="text-align:right;font-weight:700;color:#18181b;">${escHtml(planName)}</td></tr>
        <tr><td style="color:#888;padding:5px 0;">Importe</td><td style="text-align:right;font-weight:700;color:#18181b;">${escHtml(currency)} $${escHtml(amount)}</td></tr>
        ${invoiceNumber ? `<tr><td style="color:#888;padding:5px 0;">Factura</td><td style="text-align:right;font-family:monospace;color:#7c6cfa;">${escHtml(invoiceNumber)}</td></tr>` : ''}
        ${periodEndDate ? `<tr><td style="color:#888;padding:5px 0;">Próxima renovación</td><td style="text-align:right;color:#18181b;">${escHtml(periodEndDate)}</td></tr>` : ''}
      </table>`)}
      ${_btn(`${config.appUrl}/dashboard?tab=billing`, 'Ver mi factura en el Dashboard')}
      ${supportEmail ? _p(`Si tienes dudas responde a este correo o escríbenos a <a href="mailto:${escHtml(supportEmail)}" style="color:#7c6cfa;">${escHtml(supportEmail)}</a>`, 'font-size:13px;color:#9a9a9a;') : ''}
    `),
    text: `¡Pago confirmado, ${name}!\n\nPlan: ${planName}\nImporte: ${currency} $${amount}${invoiceNumber ? '\nFactura: ' + invoiceNumber : ''}\n\nGracias por usar ${pName}.\n${config.appUrl}/dashboard`,
  });
}

async function sendPaymentFailed(email, name, opts = {}) {
  const { name: pName, supportEmail } = await _platform();
  const { planName = 'Pro', attemptCount = 1 } = opts;
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `⚠️ ${pName} — Problema con tu pago`,
    html: _emailShell(pName, `
      <div style="text-align:center;margin-bottom:20px;">
        <div style="width:52px;height:52px;border-radius:50%;background:#fef2f2;border:2px solid #f87171;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        ${_h('Pago fallido')}
      </div>
      ${_p(`Hola <strong>${escHtml(name)}</strong>, no pudimos procesar el pago de tu suscripción <strong>${escHtml(planName)}</strong>.${attemptCount > 1 ? ` Este es el intento #${Number(attemptCount)}.` : ''} Tu workspace ha sido <strong>suspendido temporalmente</strong>.`)}
      ${_box(`<p style="margin:0 0 8px;font-weight:700;color:#c53030;font-size:14px;">¿Qué debes hacer?</p>
        <ul style="margin:0;padding-left:18px;line-height:1.8;font-size:14px;color:#4b4b5a;">
          <li>Verifica que tu tarjeta/método de pago sea válido</li>
          <li>Asegúrate de tener saldo disponible</li>
          <li>Actualiza tu método de pago en el portal de facturación</li>
        </ul>`, 'background:#fef2f2;border:1px solid #fecaca;')}
      ${_btn(`${config.appUrl}/dashboard?tab=billing`, 'Actualizar método de pago', '#ef4444')}
      ${supportEmail ? _p(`Soporte: <a href="mailto:${escHtml(supportEmail)}" style="color:#7c6cfa;">${escHtml(supportEmail)}</a>`, 'font-size:13px;color:#9a9a9a;') : ''}
    `),
    text: `⚠️ Pago fallido, ${name}.\n\nNo pudimos cobrar tu suscripción ${planName}. Tu workspace está suspendido.\n\nActualiza tu método de pago: ${config.appUrl}/dashboard`,
  });
}

async function sendSubscriptionCancelled(email, name, opts = {}) {
  const { name: pName } = await _platform();
  const { planName = 'Pro', accessUntil = null } = opts;
  const fmtDate = (ts) => ts
    ? new Date(ts * 1000).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const accessUntilDate = fmtDate(accessUntil);

  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Suscripción cancelada`,
    html: _emailShell(pName, `
      ${_h('Suscripción cancelada')}
      ${_p(`Hola <strong>${escHtml(name)}</strong>, tu suscripción al plan <strong>${escHtml(planName)}</strong> ha sido cancelada.${accessUntilDate ? ` Seguirás teniendo acceso hasta el <strong>${escHtml(accessUntilDate)}</strong>.` : ''}`)}
      ${_box('Cuando expire tu período, tu cuenta pasará al plan gratuito (Starter). Tus videos y datos se conservarán.')}
      ${_p('¿Cambiaste de opinión? Puedes reactivar tu suscripción en cualquier momento.', 'font-size:14px;')}
      ${_btn(`${config.appUrl}/dashboard?tab=billing`, 'Reactivar suscripción')}
    `),
    text: `Suscripción cancelada, ${name}.\n\nTu suscripción ${planName} fue cancelada.${accessUntilDate ? ' Acceso hasta: ' + accessUntilDate : ''}\n\nPuedes reactivarla en: ${config.appUrl}/dashboard`,
  });
}

async function sendSubscriptionActivated(email, name, planName = 'Pro') {
  const { name: pName } = await _platform();
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `🎉 ${pName} — ¡Plan ${planName} activado!`,
    html: _emailShell(pName, `
      <div style="text-align:center;margin-bottom:16px;font-size:40px;">🎉</div>
      ${_h(`¡Tu plan ${escHtml(planName)} está activo!`)}
      ${_p(`Hola <strong>${escHtml(name)}</strong>, ¡bienvenido al plan <strong>${escHtml(planName)}</strong>! Tu workspace está completamente desbloqueado.`)}
      ${_box(`<p style="margin:0 0 8px;font-weight:700;color:#18181b;font-size:14px;">Ahora tienes acceso a:</p>
        <ul style="margin:0;padding-left:18px;line-height:1.9;font-size:14px;color:#4b4b5a;">
          <li>Videos y almacenamiento ampliado</li>
          <li>Analytics avanzados con heatmaps</li>
          <li>Transcripciones automáticas con IA</li>
          <li>Player sin marca con tu branding</li>
          <li>API Keys para integraciones</li>
          <li>Soporte prioritario</li>
        </ul>`, 'background:#f5f3ff;border:1px solid #ddd6fe;')}
      ${_btn(`${config.appUrl}/dashboard`, 'Ir a mi Dashboard')}
    `),
    text: `¡Plan ${planName} activado, ${name}!\n\nTu workspace tiene acceso completo a todas las funciones.\n\nIr al Dashboard: ${config.appUrl}/dashboard`,
  });
}

async function sendBackupCodeUsedAlert(email, name, remainingCodes) {
  const { name: pName } = await _platform();
  const urgency = remainingCodes <= 2 ? '🚨 URGENTE' : '⚠️ Alerta';
  const urgencyColor = remainingCodes <= 2 ? '#e74c3c' : '#f39c12';

  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${urgency} — Código de respaldo 2FA utilizado en ${pName}`,
    html: _emailShell(pName, `
      ${_h(`${urgency}: Código de respaldo utilizado`)}
      ${_p(`Hola <strong>${escHtml(name)}</strong>, se utilizó un <strong>código de respaldo</strong> para acceder a tu cuenta de ${escHtml(pName)}. Si no fuiste tú, cambia tu contraseña inmediatamente.`)}
      ${_box(`<p style="margin:0 0 6px;font-weight:700;color:#18181b;">Códigos restantes: ${Number(remainingCodes)} de 8</p>
        ${remainingCodes <= 2 ? '<p style="margin:0;font-size:13px;color:#dc2626;">⚠️ Te quedan muy pocos códigos. Regenera nuevos desde tu panel de seguridad.</p>' : ''}`,
        `background:#fffbeb;border:1px solid #fde68a;border-left:4px solid ${urgencyColor};`)}
      ${_p('<strong>¿Qué hacer?</strong><br><ul style="margin:6px 0 0;padding-left:18px;line-height:1.8;"><li>Si fuiste tú: considera regenerar nuevos códigos de respaldo</li><li>Si NO fuiste tú: cambia tu contraseña y regenera los códigos inmediatamente</li></ul>', 'font-size:14px;')}
      ${_btn(`${config.appUrl}/dashboard#security`, 'Ir a Seguridad')}
      ${_p(`Este email se envió porque se usó un código de respaldo 2FA.<br>Hora: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`, 'font-size:12px;color:#9a9a9a;')}
    `),
    text: `${urgency}: Se usó un código de respaldo 2FA en tu cuenta de ${pName}.\n\nCódigos restantes: ${remainingCodes}/8\n\nSi no fuiste tú, cambia tu contraseña inmediatamente.\n\nIr a seguridad: ${config.appUrl}/dashboard#security`,
  });
}

async function sendCryptoRenewalPending(email, name, opts = {}) {
  const { name: pName, supportEmail } = await _platform();
  const { planName = 'Pro', amount = '0.00', qrUrl = '', payUrl = '', expiresAt = null } = opts;
  const fmtDate = (ts) => ts
    ? new Date(ts).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const expiresDate = fmtDate(expiresAt);

  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Renovación de suscripción ${planName} pendiente`,
    html: _emailShell(pName, `
      ${_h('Renovación pendiente de pago')}
      ${_p(`Hola <strong>${escHtml(name)}</strong>, tu suscripción <strong>${escHtml(planName)}</strong> está próxima a vencer. Realiza el pago para mantener acceso ininterrumpido.`)}
      ${_box(`<div style="text-align:center;">
        <div style="font-size:12px;color:#888;margin-bottom:6px;">Importe a pagar</div>
        <div style="font-size:26px;font-weight:800;color:#18181b;">$${escHtml(amount)} USDT</div>
        <div style="font-size:12px;color:#888;margin-top:4px;">Plan ${escHtml(planName)}</div>
        ${expiresDate ? `<div style="margin-top:10px;padding:6px 12px;background:#fef9c3;border-radius:6px;font-size:13px;color:#854d0e;display:inline-block;">Expira: ${escHtml(expiresDate)}</div>` : ''}
      </div>`)}
      ${qrUrl ? `<div style="text-align:center;margin:16px 0;"><img src="${escHtml(qrUrl)}" alt="QR Binance Pay" style="width:160px;height:160px;border-radius:10px;border:2px solid #e8e8ee;"><div style="font-size:12px;color:#888;margin-top:6px;">Escanea con la app Binance</div></div>` : ''}
      ${payUrl ? `<a href="${escHtml(payUrl)}" style="display:block;text-align:center;background:#f0b90b;color:#1a1a2e !important;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:15px;margin:16px 0;">Pagar con Binance Pay</a>` : ''}
      ${_btn(`${config.appUrl}/dashboard?tab=billing`, 'Ver estado en el Dashboard')}
      ${_p(`Si no deseas renovar, ignora este email. Tu workspace se suspenderá al vencer.${supportEmail ? `<br>Soporte: <a href="mailto:${escHtml(supportEmail)}" style="color:#7c6cfa;">${escHtml(supportEmail)}</a>` : ''}`, 'font-size:13px;color:#9a9a9a;')}
    `),
    text: `Renovación pendiente — ${planName}\n\nHola ${name},\n\nTu suscripción ${planName} necesita renovación.\nImporte: $${amount} USDT\n${expiresDate ? 'Expira: ' + expiresDate + '\n' : ''}${payUrl ? '\nPagar con Binance: ' + payUrl : ''}\n\nDashboard: ${config.appUrl}/dashboard`,
  });
}

/**
 * sendCustomEmail — admin → user plain-text/HTML email.
 * Used by the admin panel "Send email to user" feature.
 */
async function sendCustomEmail(to, subject, body) {
  const platform = await _platform();
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
      <tr><td style="background:#1a1a2e;padding:24px 32px;">
        <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">${escHtml(platform.name)}</p>
      </td></tr>
      <tr><td style="padding:32px;">
        <div style="font-size:15px;line-height:1.7;color:#333;white-space:pre-wrap;">${escHtml(body)}</div>
        ${_footer(platform.name)}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return sendRaw({ to, subject, html, text: body });
}

/**
 * sendRaw — envia un email con contenido arbitrario (HTML/texto).
 * Util para formularios de contacto, reportes y otras notificaciones ad-hoc.
 */
async function sendRaw({ to, from, replyTo, subject, html, text }) {
  const platform = await _platform();
  const fromAddr = from || (config.smtp?.from ? config.smtp.from : `"${platform.name}" <${config.smtp?.user || 'noreply@example.com'}>`);
  return _send({
    from:    fromAddr,
    to,
    replyTo: replyTo || undefined,
    subject,
    html:    html || undefined,
    text:    text || undefined,
  });
}

module.exports = {
  sendRaw,
  sendCustomEmail,
  sendPasswordReset,
  sendWelcome,
  sendWorkspaceInvitation,
  sendEmailVerification,
  sendTranscodeComplete,
  sendTranscodeError,
  sendBackupCodeUsedAlert,
  // Payment & Subscription
  sendPaymentConfirmation,
  sendPaymentFailed,
  sendSubscriptionCancelled,
  sendSubscriptionActivated,
  sendCryptoRenewalPending,
};
