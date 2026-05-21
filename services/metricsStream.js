/**
 * Metrics Stream Service — Server-Sent Events (SSE)
 *
 * Gestiona las conexiones SSE activas y hace broadcast de métricas en tiempo real
 * a todos los clientes conectados (admin panel).
 *
 * Métricas que se transmiten cada N segundos:
 *  - activeConnections: número de conexiones SSE activas (proxies de usuarios online)
 *  - queueStats: jobs en cola / activos / fallados
 *  - uploadStats: uploads activos en este instante
 *  - dbStats: conteos rápidos de videos/usuarios
 *  - systemStats: uptime, memoria usada, timestamp
 */

const logger = require('./logger').child({ module: 'metricsStream' });

// Map: connectionId → { res, userId, connectedAt }
const connections = new Map();
let _connectionIdCounter = 0;

// Uptime raíz del proceso
const processStartTime = Date.now();

// Contador de uploads activos (actualizado externamente por routes/upload.js)
let _activeUploads = 0;

/**
 * Agrega una nueva conexión SSE
 * @param {import('express').Response} res
 * @param {string} userId
 * @returns {number} connectionId
 */
function addConnection(res, userId) {
  const id = ++_connectionIdCounter;
  connections.set(id, { res, userId, connectedAt: Date.now() });

  logger.debug({ event: 'sse_connected', connectionId: id, userId, total: connections.size });

  // Remover cuando el cliente cierra la conexión
  res.on('close', () => {
    connections.delete(id);
    logger.debug({ event: 'sse_disconnected', connectionId: id, userId, total: connections.size });
  });

  return id;
}

/**
 * Envía un evento SSE a todas las conexiones activas
 * @param {string} eventName
 * @param {Object} data
 */
function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let dead = [];

  for (const [id, conn] of connections) {
    try {
      conn.res.write(payload);
    } catch {
      dead.push(id);
    }
  }

  // Limpiar conexiones muertas
  dead.forEach(id => connections.delete(id));
}

/**
 * Incrementa el contador de uploads activos
 */
function incrementActiveUploads() {
  _activeUploads++;
  broadcast('upload_change', { activeUploads: _activeUploads });
}

/**
 * Decrementa el contador de uploads activos
 */
function decrementActiveUploads() {
  _activeUploads = Math.max(0, _activeUploads - 1);
  broadcast('upload_change', { activeUploads: _activeUploads });
}

/**
 * Obtiene estadísticas del sistema
 */
function getSystemStats() {
  const mem = process.memoryUsage();
  const uptimeMs = Date.now() - processStartTime;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const uptimeStr = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  return {
    uptime: uptimeStr,
    uptimeMs,
    memUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    memTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    rss: Math.round(mem.rss / 1024 / 1024),
    activeConnections: connections.size,
    activeUploads: _activeUploads,
    timestamp: Date.now(),
  };
}

/**
 * Recopila todas las métricas y hace broadcast
 * @param {import('better-sqlite3').Database|Object} db
 */
async function collectAndBroadcast(db) {
  if (connections.size === 0) {
    logger.debug({ event: 'collect_skipped', reason: 'no_connections' });
    return;
  }

  logger.debug({ event: 'collecting_metrics', connections: connections.size });

  try {
    // ── DB stats (queries rápidas) ─────────────────────────────
    const [videoStats, userCount, wsCount, recentVideos] = await Promise.all([
      db.prepare(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'ready') as ready,
          COUNT(*) FILTER (WHERE status IN ('queued','transcoding')) as processing,
          COUNT(*) FILTER (WHERE status = 'error') as error,
          COALESCE(SUM(views), 0) as total_views,
          COALESCE(SUM(size), 0) as total_storage
        FROM videos
      `).get(),
      db.prepare(`SELECT COUNT(*) as c FROM users`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM workspaces`).get(),
      db.prepare(`
        SELECT COUNT(*) as c FROM videos 
        WHERE created_at >= FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT - 3600
      `).get(),
    ]);

    // ── Queue stats ────────────────────────────────────────────
    let queueStats = { waiting: 0, active: 0, failed: 0, completed: 0, mode: 'fallback' };
    try {
      const { getQueueStats } = require('./queue');
      queueStats = await getQueueStats();
    } catch {}

    // ── System stats ───────────────────────────────────────────
    const systemStats = getSystemStats();

    // ── Broadcast ─────────────────────────────────────────────
    const metricsData = {
      videos: {
        total:         Number(videoStats?.total)        || 0,
        ready:         Number(videoStats?.ready)        || 0,
        processing:    Number(videoStats?.processing)   || 0,
        error:         Number(videoStats?.error)        || 0,
        totalViews:    Number(videoStats?.total_views)  || 0,
        totalStorageBytes: Number(videoStats?.total_storage) || 0,
        recentHour:    Number(recentVideos?.c)          || 0,
      },
      users: {
        total: Number(userCount?.c) || 0,
      },
      workspaces: {
        total: Number(wsCount?.c) || 0,
      },
      queue: queueStats,
      system: systemStats,
    };
    
    logger.debug({ 
      event: 'metrics_collected', 
      videos: metricsData.videos.total,
      users: metricsData.users.total,
      connections: connections.size
    });
    
    broadcast('metrics', metricsData);
    
    logger.debug({ event: 'metrics_broadcast_complete', connections: connections.size });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'SSE metrics collection error');
  }
}

/**
 * Inicia el ticker de métricas
 * @param {Object} db - instancia de DB
 * @param {number} intervalMs - intervalo en ms (default: 5000)
 */
function startMetricsTicker(db, intervalMs = 5000) {
  logger.info({ intervalMs }, 'SSE metrics ticker started');

  const interval = setInterval(() => {
    collectAndBroadcast(db).catch(() => {});
  }, intervalMs);

  // No bloquear el proceso al cerrar
  if (interval.unref) interval.unref();

  return interval;
}

module.exports = {
  addConnection,
  broadcast,
  incrementActiveUploads,
  decrementActiveUploads,
  getSystemStats,
  collectAndBroadcast,
  startMetricsTicker,
  getConnectionCount: () => connections.size,
};
