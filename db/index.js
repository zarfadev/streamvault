/**
 * PostgreSQL database adapter.
 * Exposes the same prepare().get/.all/.run interface as better-sqlite3
 * so route files only need `await` added — query syntax unchanged.
 *
 * Requires DATABASE_URL env variable.
 */
const { Pool } = require('pg');
const logger = require('../services/logger').child({ module: 'db' });

// DB_POOL_MAX controls connections PER PROCESS.
// In PM2 cluster mode: total = DB_POOL_MAX × instances.
// Rule of thumb: keep total < (postgres max_connections - 5 reserved).
// Neon/Supabase free: 100 limit → with 4 API instances use DB_POOL_MAX=10
// Default 10 is safe for single-server; raise to 20+ on dedicated DB.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                    parseInt(process.env.DB_POOL_MAX             || '10',    10),
  idleTimeoutMillis:      parseInt(process.env.DB_IDLE_TIMEOUT_MS      || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS  || '5000',  10),
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'Unexpected pool error');
});

// Convert ? positional placeholders to $1, $2, … (PostgreSQL style)
// Skips ? inside string literals (e.g. LIKE '%?%') to avoid corruption.
// Uses a proper escape-aware state machine to handle \' and '' inside strings.
function pgify(sql) {
  let i = 0;
  let inStr = false;
  let strChar = '';
  let out = '';
  for (let ci = 0; ci < sql.length; ci++) {
    const ch = sql[ci];
    // Count consecutive backslashes before this char to determine if escaped
    if (!inStr) {
      if (ch === "'" || ch === '"') { inStr = true; strChar = ch; out += ch; continue; }
      if (ch === '?') { out += `$${++i}`; continue; }
      out += ch;
    } else {
      // Inside string: handle escape sequences
      if (ch === '\\') {
        // Backslash escape: consume next char as literal
        out += ch;
        if (ci + 1 < sql.length) { out += sql[++ci]; }
        continue;
      }
      if (ch === strChar) {
        // Could be end of string or escaped quote (doubled)
        if (sql[ci + 1] === strChar) {
          // Doubled quote inside string — not end of string
          out += ch + strChar;
          ci++;
        } else {
          inStr = false;
          out += ch;
        }
        continue;
      }
      out += ch;
    }
  }
  return out;
}

// Flatten one level so callers can pass either (a, b) or ([a, b])
function flat(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

class Statement {
  constructor(sql) {
    this.sql = pgify(sql);
  }

  async get(...args) {
    const { rows } = await pool.query(this.sql, flat(args));
    return rows[0] ?? null;
  }

  async all(...args) {
    const { rows } = await pool.query(this.sql, flat(args));
    return rows;
  }

  async run(...args) {
    const result = await pool.query(this.sql, flat(args));
    return { changes: result.rowCount };
  }
}

const db = {
  prepare: (sql) => new Statement(sql),

  // Raw query helper for cases that don't fit the statement pattern
  query: (sql, params = []) => pool.query(pgify(sql), params),

  // Expose pool for transactions
  pool,

  // Health check
  ping: async () => {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return Number(rows[0]?.ok) === 1;
  },

  init: async () => {
    const { createSchema } = require('./schema');
    await createSchema(pool);
    return db;
  },
};

module.exports = db;
