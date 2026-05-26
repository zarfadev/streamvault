/**
 * Middleware centralizado para manejo de errores.
 * 
 * FIX HIGH-08: Fuga de información en errores
 * - En producción: mensajes genéricos sin stack traces
 * - En desarrollo: información completa para debugging
 * - Todos los errores logueados con contexto completo
 */

const logger = require('../services/logger').child({ module: 'error-handler' });
const config = require('../config');

/**
 * Middleware de error global para Express.
 * Debe ser el último middleware registrado en server.js
 */
function errorHandler(err, req, res, next) {
  // "Request aborted" fires when a client disconnects mid-upload (e.g. during
  // a server restart or the user cancelling).  It is not a server error — log
  // at warn level so it doesn't appear as a 500 in production dashboards.
  if (err.message === 'Request aborted' || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
    logger.warn({ url: req.url, method: req.method }, 'Client disconnected mid-request (ignored)');
    if (!res.headersSent) res.status(499).end(); // 499 = client closed request
    return;
  }

  // Log completo del error (siempre, incluso en producción)
  logger.error({
    err: {
      message: err.message,
      stack: err.stack,
      code: err.code,
      name: err.name,
    },
    req: {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userId: req.user?.id,
      workspaceId: req.workspace?.id,
    },
  }, 'Unhandled error in request');

  // Determinar código de estado HTTP
  const statusCode = err.statusCode || err.status || 500;

  // En producción: respuesta genérica sin detalles
  if (config.nodeEnv === 'production' || !config.isDev) {
    return res.status(statusCode).json({
      error: statusCode === 404 ? 'Not found' : 'Internal server error',
      // ID de request para soporte técnico (opcional)
      requestId: req.id || undefined,
    });
  }

  // En desarrollo: información detallada
  res.status(statusCode).json({
    error: err.message || 'Internal server error',
    stack: err.stack,
    code: err.code,
    ...(err.errors && { errors: err.errors }), // Para errores de validación
  });
}

/**
 * Wrapper para handlers async que automáticamente captura errores
 * y los pasa al middleware de error.
 * 
 * Uso:
 *   router.get('/path', asyncHandler(async (req, res) => {
 *     const data = await someAsyncOperation();
 *     res.json(data);
 *   }));
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Middleware para rutas no encontradas (404)
 */
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

module.exports = { errorHandler, asyncHandler, notFoundHandler };
