/**
 * PM2 Ecosystem Config — Producción
 *
 * Instalación:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup        ← genera el comando para auto-start en boot
 *
 * Comandos útiles:
 *   pm2 status         - estado de todos los procesos
 *   pm2 logs           - logs en tiempo real
 *   pm2 monit          - monitor de CPU/RAM en terminal
 *   pm2 reload all     - zero-downtime reload del API (cluster)
 *   pm2 restart streamvault-worker - reiniciar el worker
 *
 * Escalar workers en el mismo servidor:
 *   WORKER_CONCURRENCY=4 pm2 restart streamvault-worker --update-env
 *
 * En servidor dedicado a workers (sin API):
 *   pm2 start ecosystem.config.js --only streamvault-worker
 */

const os = require('os');
const cpus = os.cpus().length;

module.exports = {
  apps: [

    // ── API Server ────────────────────────────────────────────────────────────
    // exec_mode: 'cluster' lanza 1 proceso por núcleo, todos comparten el
    // puerto 3000. PM2 hace round-robin de requests entre ellos.
    // Zero-downtime deploy: `pm2 reload streamvault-api`
    {
      name:        'streamvault-api',
      script:      './server.js',
      instances:   cpus,          // 1 instancia por núcleo — ajustar si el worker corre aquí
      exec_mode:   'cluster',
      autorestart: true,
      watch:       false,

      // Reiniciar instancia si supera este límite de RAM.
      // En cluster, cada instancia tiene su propio heap.
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        PORT:     3000,
      },

      error_file:      './logs/api-error.log',
      out_file:        './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,   // un solo archivo en lugar de api-out-0.log, api-out-1.log…

      min_uptime:    '10s',    // si muere antes de 10s = crash, no reintentar infinito
      max_restarts:  10,
      restart_delay: 2000,

      // zero-downtime: envía SIGINT y espera a que el servidor cierre conexiones activas
      kill_timeout:    8000,
      wait_ready:      true,
      listen_timeout:  15000,
    },

    // ── Worker (FFmpeg + Whisper) ──────────────────────────────────────────────
    // SIEMPRE en fork mode — el paralelismo lo gestiona Bull internamente
    // a través de WORKER_CONCURRENCY. No usar cluster aquí.
    //
    // Para un servidor dedicado a workers:
    //   WORKER_CONCURRENCY = nCPUs × 0.8  (dejar algo de margen al SO)
    //
    // Para servidor compartido con API (instancias = cpus arriba):
    //   WORKER_CONCURRENCY = max(1, Math.floor(cpus / 2) - 1)
    {
      name:        'streamvault-worker',
      script:      './worker.js',
      instances:   1,
      exec_mode:   'fork',
      autorestart: true,
      watch:       false,

      // FFmpeg puede usar 2-4 GB en videos 4K. Reiniciar si hay memory leak.
      max_memory_restart: '3G',

      env: {
        NODE_ENV:                  'production',
        WORKER_CONCURRENCY:        Math.max(1, Math.floor(cpus * 0.75)),
        TRANSCRIPTION_CONCURRENCY: 2,
      },

      error_file:      './logs/worker-error.log',
      out_file:        './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,

      min_uptime:    '10s',
      max_restarts:  10,
      restart_delay: 4000,

      // Dar tiempo al worker para terminar el job de FFmpeg en curso antes de matar
      kill_timeout: 65000,

      // Restart diario a las 4 AM para limpiar memoria acumulada
      cron_restart: '0 4 * * *',
    },

  ],
};
