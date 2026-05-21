/**
 * Professional Logger (Pino)
 *
 * Outputs:
 *   • Development: pretty-printed colored output to stdout
 *   • Production:  JSON to stdout (for log aggregators like CloudWatch/Datadog)
 *                  + all ERROR-level logs written to logs/error.log
 *
 * Usage:
 *   const logger = require('./services/logger');
 *   logger.info('Server started');
 *   logger.error({ err }, 'Something failed');
 *   logger.warn({ workspaceId }, 'Workspace suspended');
 *
 * Child loggers (add context to every log line):
 *   const log = logger.child({ module: 'transcoder', videoId });
 *   log.info('Transcoding started');
 */

const fs   = require('fs');
const path = require('path');
const pino = require('pino');

// ── Ensure logs/ directory exists ────────────────────────────────────────────
const logsDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// ── Destinations ──────────────────────────────────────────────────────────────

// Error log file — append mode, errors only
const errorLogPath = path.join(logsDir, 'error.log');
const errorFileDest = pino.destination({
  dest:  errorLogPath,
  sync:  false,   // async writes — non-blocking
  mkdir: true,
});

// Combined log file — all levels
const combinedLogPath = path.join(logsDir, 'combined.log');
const combinedFileDest = pino.destination({
  dest:  combinedLogPath,
  sync:  false,
  mkdir: true,
});

// ── Multi-stream transport ────────────────────────────────────────────────────
// In development: pretty console + error file
// In production:  JSON console + error file + combined file

let transport;

if (isDev) {
  transport = pino.transport({
    targets: [
      {
        // Pretty console output for development
        target: 'pino-pretty',
        level:  'debug',
        options: {
          colorize:        true,
          translateTime:   'HH:MM:ss',
          ignore:          'pid,hostname',
          messageFormat:   '{msg}',
          singleLine:      false,
        },
      },
      {
        // Error file — errors only
        target:  'pino/file',
        level:   'error',
        options: { destination: errorLogPath, mkdir: true },
      },
    ],
  });
} else {
  transport = pino.transport({
    targets: [
      {
        // JSON to stdout — picked up by CloudWatch / Datadog / etc.
        target:  'pino/file',
        level:   'info',
        options: { destination: 1 }, // fd 1 = stdout
      },
      {
        // Error file — errors only
        target:  'pino/file',
        level:   'error',
        options: { destination: errorLogPath, mkdir: true },
      },
      {
        // Combined log — all levels
        target:  'pino/file',
        level:   'info',
        options: { destination: combinedLogPath, mkdir: true },
      },
    ],
  });
}

// ── Logger instance ───────────────────────────────────────────────────────────
const logger = pino(
  {
    level: isDev ? 'debug' : 'info',
    base: {
      pid:     process.pid,
      env:     process.env.NODE_ENV || 'development',
      service: 'streamvault',
    },
    // Serialize Error objects properly
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
    // Redact sensitive fields from logs
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.password_hash',
        '*.hls_key',
        '*.stripe_secret_key',
        '*.webhookSecret',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);

// ── Flush on process exit ─────────────────────────────────────────────────────
// Pino uses async writes — flush before exit to avoid losing last log lines.
process.on('exit', () => {
  try { logger.flush(); } catch {}
});

module.exports = logger;
