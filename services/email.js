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
  return `<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="color:#aaa;font-size:12px;">${escHtml(platformName)} — Video Streaming Platform</p>`;
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">Restablecer contraseña</h2>
        <p style="color:#555;line-height:1.6;">
          Recibimos una solicitud para restablecer tu contraseña en ${escHtml(pName)}.
          Haz clic en el botón para crear una nueva:
        </p>
        <a href="${escHtml(resetUrl)}"
           style="display:inline-block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Restablecer contraseña
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px;">
          Este enlace expira en 1 hora. Si no solicitaste esto, ignora este email.
        </p>
        ${_footer(pName)}
      </div>
    `,
    text: `Restablecer contraseña de ${pName}\n\nVisita este enlace: ${resetUrl}\n\nEl enlace expira en 1 hora.`,
  });
}

async function sendWelcome(email, name) {
  const { name: pName } = await _platform();
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `¡Bienvenido a ${pName}!`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">¡Bienvenido, ${escHtml(name)}!</h2>
        <p style="color:#555;line-height:1.6;">
          Tu cuenta en ${escHtml(pName)} está lista. Ya puedes subir videos,
          obtener streams HLS, y compartirlos con el mundo.
        </p>
        <a href="${escHtml(config.appUrl)}/dashboard"
           style="display:inline-block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Ir al Dashboard
        </a>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">Invitación a workspace</h2>
        <p style="color:#555;line-height:1.6;">
          <strong>${escHtml(inviterName)}</strong> te ha invitado a unirte al workspace
          <strong>&ldquo;${escHtml(workspaceName)}&rdquo;</strong> en ${escHtml(pName)}.
        </p>
        <a href="${escHtml(acceptUrl)}"
           style="display:inline-block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Aceptar invitación
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px;">Esta invitación expira en 7 días.</p>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">Verifica tu correo</h2>
        <p style="color:#555;line-height:1.6;">
          Hola <strong>${escHtml(name)}</strong>, bienvenido a ${escHtml(pName)}.<br>
          Haz clic en el botón para verificar tu correo electrónico:
        </p>
        <a href="${escHtml(verifyUrl)}"
           style="display:inline-block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Verificar correo
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px;">
          Este enlace expira en 24 horas. Si no creaste una cuenta, ignora este email.
        </p>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">Tu video está listo</h2>
        <p style="color:#555;line-height:1.6;">
          El video <strong>&ldquo;${escHtml(videoTitle)}&rdquo;</strong> terminó de procesarse y ya está disponible.
        </p>
        <a href="${escHtml(fullUrl)}"
           style="display:inline-block;background:#22d3a5;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Ver video
        </a>
        ${_footer(pName)}
      </div>
    `,
    text: `Tu video "${videoTitle}" está listo en ${pName}.\n\nVerlo: ${fullUrl}`,
  });
}

async function sendTranscodeError(email, videoTitle) {
  const { name: pName } = await _platform();
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `${pName} — Error procesando "${videoTitle}"`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">Error en procesamiento</h2>
        <p style="color:#555;line-height:1.6;">
          Hubo un problema al procesar el video <strong>&ldquo;${escHtml(videoTitle)}&rdquo;</strong>.
          Por favor sube el archivo nuevamente o contacta soporte.
        </p>
        <a href="${escHtml(config.appUrl)}/dashboard"
           style="display:inline-block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Ir al Dashboard
        </a>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="width:56px;height:56px;border-radius:50%;background:rgba(34,211,165,0.12);border:2px solid #22d3a5;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22d3a5" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h2 style="color:#1a1a2e;margin:0;">¡Pago confirmado!</h2>
        </div>
        <p style="color:#555;line-height:1.6;">Hola <strong>${escHtml(name)}</strong>,</p>
        <p style="color:#555;line-height:1.6;">
          Tu suscripción al plan <strong>${escHtml(planName)}</strong> ha sido activada exitosamente.
          Gracias por confiar en ${escHtml(pName)}.
        </p>
        <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #e5e5e5;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="color:#888;padding:5px 0;">Plan</td><td style="text-align:right;font-weight:600;color:#1a1a2e;">${escHtml(planName)}</td></tr>
            <tr><td style="color:#888;padding:5px 0;">Importe</td><td style="text-align:right;font-weight:600;color:#1a1a2e;">${escHtml(currency)} $${escHtml(amount)}</td></tr>
            ${invoiceNumber ? `<tr><td style="color:#888;padding:5px 0;">Factura</td><td style="text-align:right;font-family:monospace;color:#7c6cfa;">${escHtml(invoiceNumber)}</td></tr>` : ''}
            ${periodEndDate ? `<tr><td style="color:#888;padding:5px 0;">Próxima renovación</td><td style="text-align:right;color:#1a1a2e;">${escHtml(periodEndDate)}</td></tr>` : ''}
          </table>
        </div>
        <a href="${escHtml(config.appUrl)}/dashboard?tab=billing"
           style="display:block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:13px 28px;border-radius:9px;font-weight:600;margin:24px 0;text-align:center;">
          Ver mi factura en el Dashboard
        </a>
        <p style="color:#888;font-size:13px;line-height:1.6;">
          Si tienes dudas sobre tu factura, responde a este correo o escríbenos a
          <a href="mailto:${escHtml(supportEmail)}" style="color:#7c6cfa;">${escHtml(supportEmail)}</a>
        </p>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="width:56px;height:56px;border-radius:50%;background:rgba(248,113,113,0.1);border:2px solid #f87171;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <h2 style="color:#e53e3e;margin:0;">Pago fallido</h2>
        </div>
        <p style="color:#555;line-height:1.6;">Hola <strong>${escHtml(name)}</strong>,</p>
        <p style="color:#555;line-height:1.6;">
          No pudimos procesar el pago de tu suscripción <strong>${escHtml(planName)}</strong>.
          ${attemptCount > 1 ? `Este es el intento #${Number(attemptCount)}.` : ''}
          Tu workspace ha sido <strong>suspendido temporalmente</strong> hasta que se resuelva el problema.
        </p>
        <div style="background:#fff5f5;border-radius:10px;padding:18px;margin:20px 0;border:1px solid #fed7d7;">
          <p style="margin:0;color:#c53030;font-weight:600;font-size:14px;">¿Qué debes hacer?</p>
          <ul style="color:#555;line-height:1.8;font-size:14px;margin:10px 0 0;padding-left:20px;">
            <li>Verifica que tu tarjeta/método de pago sea válido</li>
            <li>Asegúrate de tener saldo disponible</li>
            <li>Actualiza tu método de pago en el portal de facturación</li>
          </ul>
        </div>
        <a href="${escHtml(config.appUrl)}/dashboard?tab=billing"
           style="display:block;background:#f87171;color:white;text-decoration:none;
                  padding:13px 28px;border-radius:9px;font-weight:600;margin:24px 0;text-align:center;">
          Actualizar método de pago
        </a>
        <p style="color:#888;font-size:13px;line-height:1.6;">
          Si necesitas ayuda, contáctanos en
          <a href="mailto:${escHtml(supportEmail)}" style="color:#7c6cfa;">${escHtml(supportEmail)}</a>
        </p>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <h2 style="color:#1a1a2e;">Suscripción cancelada</h2>
        <p style="color:#555;line-height:1.6;">Hola <strong>${escHtml(name)}</strong>,</p>
        <p style="color:#555;line-height:1.6;">
          Tu suscripción al plan <strong>${escHtml(planName)}</strong> ha sido cancelada exitosamente.
          ${accessUntilDate ? `Seguirás teniendo acceso hasta el <strong>${escHtml(accessUntilDate)}</strong>.` : ''}
        </p>
        <div style="background:#f8f9fa;border-radius:10px;padding:18px;margin:20px 0;border:1px solid #e5e5e5;">
          <p style="margin:0;color:#555;font-size:14px;line-height:1.6;">
            Cuando expire tu período, tu cuenta pasará al plan gratuito (Starter).
            Tus videos y datos se conservarán.
          </p>
        </div>
        <p style="color:#555;line-height:1.6;font-size:14px;">
          ¿Cambiaste de opinión? Puedes reactivar tu suscripción en cualquier momento.
        </p>
        <a href="${escHtml(config.appUrl)}/dashboard?tab=billing"
           style="display:block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:13px 28px;border-radius:9px;font-weight:600;margin:24px 0;text-align:center;">
          Reactivar suscripción
        </a>
        ${_footer(pName)}
      </div>
    `,
    text: `Suscripción cancelada, ${name}.\n\nTu suscripción ${planName} fue cancelada.${accessUntilDate ? ' Acceso hasta: ' + accessUntilDate : ''}\n\nPuedes reactivarla en: ${config.appUrl}/dashboard`,
  });
}

async function sendSubscriptionActivated(email, name, planName = 'Pro') {
  const { name: pName } = await _platform();
  await _send({
    from: config.smtp.from,
    to: email,
    subject: `🎉 ${pName} — ¡Plan ${planName} activado!`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="font-size:48px;margin-bottom:12px;">🎉</div>
          <h2 style="color:#1a1a2e;margin:0;">¡Tu plan ${escHtml(planName)} está activo!</h2>
        </div>
        <p style="color:#555;line-height:1.6;">Hola <strong>${escHtml(name)}</strong>,</p>
        <p style="color:#555;line-height:1.6;">
          ¡Bienvenido al plan <strong>${escHtml(planName)}</strong>! Tu workspace está completamente desbloqueado
          y tienes acceso a todas las funciones premium.
        </p>
        <div style="background:linear-gradient(135deg,rgba(124,108,250,0.08),rgba(34,211,165,0.06));border-radius:12px;padding:20px;margin:20px 0;border:1px solid rgba(124,108,250,0.2);">
          <p style="margin:0 0 10px;color:#1a1a2e;font-weight:700;font-size:15px;">Ahora tienes acceso a:</p>
          <ul style="color:#555;line-height:1.9;font-size:14px;margin:0;padding-left:20px;">
            <li>Videos y almacenamiento ampliado</li>
            <li>Analytics avanzados con heatmaps</li>
            <li>Transcripciones automáticas con IA</li>
            <li>Player sin marca con tu branding</li>
            <li>API Keys para integraciones</li>
            <li>Soporte prioritario</li>
          </ul>
        </div>
        <a href="${escHtml(config.appUrl)}/dashboard"
           style="display:block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:13px 28px;border-radius:9px;font-weight:600;margin:24px 0;text-align:center;">
          Ir a mi Dashboard
        </a>
        ${_footer(pName)}
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:${urgencyColor};">${urgency}: Código de respaldo utilizado</h2>
        <p style="color:#555;line-height:1.6;">
          Hola <strong>${escHtml(name)}</strong>,<br><br>
          Se utilizó un <strong>código de respaldo</strong> para acceder a tu cuenta de ${escHtml(pName)}.
          Si no fuiste tú, cambia tu contraseña inmediatamente.
        </p>
        <div style="background:#f8f9fa;border-left:4px solid ${urgencyColor};padding:16px;margin:20px 0;border-radius:4px;">
          <p style="margin:0;color:#333;font-weight:600;">Códigos restantes: ${Number(remainingCodes)} de 8</p>
          ${remainingCodes <= 2 ? '<p style="margin:8px 0 0;color:#e74c3c;font-size:13px;">⚠️ Te quedan muy pocos códigos. Regenera nuevos códigos desde tu panel de seguridad.</p>' : ''}
        </div>
        <p style="color:#555;line-height:1.6;font-size:14px;">
          <strong>¿Qué hacer?</strong>
        </p>
        <ul style="color:#555;line-height:1.8;font-size:14px;">
          <li>Si fuiste tú: considera regenerar nuevos códigos de respaldo</li>
          <li>Si NO fuiste tú: cambia tu contraseña y regenera los códigos inmediatamente</li>
        </ul>
        <a href="${escHtml(config.appUrl)}/dashboard#security"
           style="display:inline-block;background:#7c6cfa;color:white;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;margin:20px 0;">
          Ir a Seguridad
        </a>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="color:#aaa;font-size:12px;">
          Este email se envió porque se usó un código de respaldo 2FA en tu cuenta.<br>
          Hora: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}<br>
          ${escHtml(pName)} — Video Streaming Platform
        </p>
      </div>
    `,
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
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="width:56px;height:56px;border-radius:50%;background:rgba(124,108,250,0.12);border:2px solid #7c6cfa;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#7c6cfa" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <h2 style="color:#1a1a2e;margin:0;">Renovación pendiente de pago</h2>
        </div>
        <p style="color:#555;line-height:1.6;">Hola <strong>${escHtml(name)}</strong>,</p>
        <p style="color:#555;line-height:1.6;">
          Tu suscripción <strong>${escHtml(planName)}</strong> está próxima a vencer.
          Hemos generado una orden de renovación automática. Para mantener acceso ininterrumpido, realiza el pago con Binance Pay.
        </p>
        <div style="background:#f8f9fa;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #e5e5e5;text-align:center;">
          <div style="font-size:13px;color:#888;margin-bottom:8px;">Importe a pagar</div>
          <div style="font-size:28px;font-weight:700;color:#1a1a2e;">$${escHtml(amount)} USDT</div>
          <div style="font-size:12px;color:#888;margin-top:6px;">Plan ${escHtml(planName)}</div>
          ${expiresDate ? `<div style="margin-top:12px;padding:8px 12px;background:#fff3cd;border-radius:6px;font-size:13px;color:#856404;">Expira: ${escHtml(expiresDate)}</div>` : ''}
        </div>
        ${qrUrl ? `<div style="text-align:center;margin:20px 0;"><img src="${escHtml(qrUrl)}" alt="QR Binance Pay" style="width:180px;height:180px;border-radius:10px;border:2px solid #e5e5e5;"><div style="font-size:12px;color:#888;margin-top:8px;">Escanea con la app Binance</div></div>` : ''}
        ${payUrl ? `<a href="${escHtml(payUrl)}" style="display:block;background:#f0b90b;color:#1a1a2e;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;margin:20px 0;text-align:center;">Pagar con Binance Pay</a>` : ''}
        <a href="${escHtml(config.appUrl)}/dashboard?tab=billing" style="display:block;background:#7c6cfa;color:white;text-decoration:none;padding:12px 28px;border-radius:9px;font-weight:600;margin:12px 0;text-align:center;">Ver estado en el Dashboard</a>
        <p style="color:#888;font-size:13px;line-height:1.6;">
          Si no deseas renovar, puedes ignorar este email. Tu workspace se suspenderá al vencer el período actual.<br>
          Soporte: <a href="mailto:${escHtml(supportEmail)}" style="color:#7c6cfa;">${escHtml(supportEmail)}</a>
        </p>
        ${_footer(pName)}
      </div>
    `,
    text: `Renovación pendiente — ${planName}\n\nHola ${name},\n\nTu suscripción ${planName} necesita renovación.\nImporte: $${amount} USDT\n${expiresDate ? 'Expira: ' + expiresDate + '\n' : ''}${payUrl ? '\nPagar con Binance: ' + payUrl : ''}\n\nDashboard: ${config.appUrl}/dashboard`,
  });
}

module.exports = {
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
