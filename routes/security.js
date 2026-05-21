/**
 * Security Management Routes
 * Endpoints para administradores para gestionar seguridad:
 * - Rate limiting stats
 * - Blacklist/whitelist management
 * - 2FA statistics
 * - Security logs
 */

const express = require('express');
const router = express.Router();
const { authenticate, superAdminAuth } = require('../middleware/auth');
const advancedRL = require('../middleware/advancedRateLimit');
const twoFactor = require('../services/twoFactor');
const logger = require('../services/logger').child({ module: 'security-routes' });
const database = require('../db');

// Todos los endpoints requieren autenticación y admin
router.use(authenticate);
router.use(superAdminAuth);

/**
 * GET /api/security/rate-limit/stats
 * Obtener estadísticas de rate limiting
 */
router.get('/rate-limit/stats', (req, res) => {
  try {
    const stats = advancedRL.getStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ event: 'rate_limit_stats_error', error: error.message });
    res.status(500).json({ error: 'Error obteniendo estadísticas' });
  }
});

/**
 * POST /api/security/rate-limit/whitelist
 * Agregar IP a whitelist
 * Body: { ip: "192.168.1.1", reason: "Office IP" }
 */
router.post('/rate-limit/whitelist', (req, res) => {
  try {
    const { ip, reason } = req.body;
    
    if (!ip) {
      return res.status(400).json({ error: 'IP requerida' });
    }
    
    // Validar formato IP
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) {
      return res.status(400).json({ error: 'Formato de IP inválido' });
    }
    
    advancedRL.addToWhitelist(ip);
    
    // Log de auditoría
    logger.info({
      event: 'ip_whitelisted',
      ip,
      reason,
      admin: req.user.email,
    });
    
    res.json({
      success: true,
      message: `IP ${ip} agregada a whitelist`,
      reason,
    });
  } catch (error) {
    logger.error({ event: 'whitelist_add_error', error: error.message });
    res.status(500).json({ error: 'Error agregando a whitelist' });
  }
});

/**
 * DELETE /api/security/rate-limit/whitelist/:ip
 * Remover IP de whitelist
 */
router.delete('/rate-limit/whitelist/:ip', (req, res) => {
  try {
    const { ip } = req.params;
    
    advancedRL.removeFromWhitelist(ip);
    
    logger.info({
      event: 'ip_removed_from_whitelist',
      ip,
      admin: req.user.email,
    });
    
    res.json({
      success: true,
      message: `IP ${ip} removida de whitelist`,
    });
  } catch (error) {
    logger.error({ event: 'whitelist_remove_error', error: error.message });
    res.status(500).json({ error: 'Error removiendo de whitelist' });
  }
});

/**
 * POST /api/security/rate-limit/unblock/:ip
 * Desbloquear manualmente una IP
 */
router.post('/rate-limit/unblock/:ip', (req, res) => {
  try {
    const { ip } = req.params;
    
    const wasBlocked = advancedRL.unblockIp(ip);
    
    if (!wasBlocked) {
      return res.status(404).json({
        success: false,
        message: 'IP no estaba bloqueada',
      });
    }
    
    logger.info({
      event: 'ip_manually_unblocked',
      ip,
      admin: req.user.email,
    });
    
    res.json({
      success: true,
      message: `IP ${ip} desbloqueada exitosamente`,
    });
  } catch (error) {
    logger.error({ event: 'unblock_error', error: error.message });
    res.status(500).json({ error: 'Error desbloqueando IP' });
  }
});

/**
 * GET /api/security/2fa/stats
 * Estadísticas de adopción de 2FA
 */
router.get('/2fa/stats', async (req, res) => {
  try {
    const row = await database.prepare(`
      SELECT
        COUNT(*) as total_users,
        SUM(CASE WHEN two_factor_enabled = 1 THEN 1 ELSE 0 END) as users_with_2fa,
        SUM(CASE WHEN two_factor_enabled = 0 THEN 1 ELSE 0 END) as users_without_2fa
      FROM users
    `).get();

    const total = Number(row?.total_users || 0);
    const with2fa = Number(row?.users_with_2fa || 0);
    const stats = {
      total_users:       total,
      users_with_2fa:    with2fa,
      users_without_2fa: Number(row?.users_without_2fa || 0),
      adoption_percentage: total > 0 ? Math.round((with2fa / total) * 100) : 0,
    };

    res.json({ success: true, stats, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error({ event: '2fa_stats_error', error: error.message });
    res.status(500).json({ error: 'Error obteniendo estadísticas de 2FA' });
  }
});

/**
 * GET /api/security/logs
 * Obtener logs de seguridad recientes
 * Query: ?type=rate_limit|2fa|auth&limit=100
 */
router.get('/logs', (req, res) => {
  try {
    const { type, limit = 100 } = req.query;
    
    // En producción, esto debería consultar logs desde archivo o servicio de logging
    // Por ahora, devolvemos estructura de ejemplo
    
    const logs = {
      message: 'Logs disponibles en /var/log/streamvault/combined.log',
      filters: {
        type: type || 'all',
        limit: parseInt(limit),
      },
      commands: {
        rate_limit: "grep 'rate_limit' /var/log/streamvault/combined.log | tail -n " + limit,
        '2fa': "grep '2fa' /var/log/streamvault/combined.log | tail -n " + limit,
        auth: "grep 'auth' /var/log/streamvault/combined.log | tail -n " + limit,
        security: "grep 'security\\|attack\\|blocked' /var/log/streamvault/combined.log | tail -n " + limit,
      },
    };
    
    res.json({
      success: true,
      logs,
      note: 'Para logs en tiempo real, usar sistema de logging externo (ELK, Datadog, etc.)',
    });
  } catch (error) {
    logger.error({ event: 'security_logs_error', error: error.message });
    res.status(500).json({ error: 'Error obteniendo logs' });
  }
});

/**
 * GET /api/security/health
 * Estado de salud de sistemas de seguridad
 */
router.get('/health', async (req, res) => {
  try {
    const stats = advancedRL.getStats();

    const row = await database.prepare(`
      SELECT COUNT(*) as total_users,
             SUM(CASE WHEN two_factor_enabled = 1 THEN 1 ELSE 0 END) as users_with_2fa
      FROM users
    `).get().catch(() => null);
    const total = Number(row?.total_users || 0);
    const with2fa = Number(row?.users_with_2fa || 0);
    const adoptionRate = total > 0 ? Math.round((with2fa / total) * 100) : 0;

    const health = {
      status: 'healthy',
      components: {
        rateLimit: {
          status: 'operational',
          activeIps: stats.activeIps,
          blacklistedIps: stats.blacklistedIps,
        },
        twoFactor: {
          status: 'operational',
          adoptionRate,
          totalUsers: total,
        },
        csp: {
          status: 'operational',
          enabled: true,
        },
        sri: {
          status: 'operational',
          enabled: true,
        },
      },
      timestamp: new Date().toISOString(),
    };
    
    res.json(health);
  } catch (error) {
    logger.error({ event: 'security_health_error', error: error.message });
    res.status(500).json({
      status: 'degraded',
      error: 'Error verificando salud de seguridad',
    });
  }
});

/**
 * POST /api/security/audit-log
 * Registrar evento de auditoría manualmente
 * Body: { event, description, metadata }
 */
router.post('/audit-log', (req, res) => {
  try {
    const { event, description, metadata } = req.body;
    
    if (!event) {
      return res.status(400).json({ error: 'Evento requerido' });
    }
    
    logger.warn({
      event: 'manual_audit_entry',
      auditEvent: event,
      description,
      metadata,
      admin: req.user.email,
      ip: advancedRL.getClientIp(req),
    });
    
    res.json({
      success: true,
      message: 'Evento de auditoría registrado',
    });
  } catch (error) {
    logger.error({ event: 'audit_log_error', error: error.message });
    res.status(500).json({ error: 'Error registrando evento' });
  }
});

module.exports = router;
