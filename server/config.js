'use strict';

require('dotenv').config();

function credential(name) {
  const v = process.env[name];
  if (!v || !v.includes(':')) {
    throw new Error(`${name} must be set as "username:api-token"`);
  }
  const [user, ...rest] = v.split(':');
  return { user, token: rest.join(':') };
}

function normalizeOracleConnectString(value) {
  if (!value) return value;

  const v = value.trim();
  const lower = v.toLowerCase();

  if (lower.startsWith('jdbc:oracle:thin:@')) {
    return v.slice('jdbc:oracle:thin:@'.length);
  }

  if (lower.startsWith('jdbc:oracle:thin:')) {
    return v.slice('jdbc:oracle:thin:'.length);
  }

  if (v.startsWith('@')) {
    return v.slice(1);
  }

  return v;
}

const oracleConnectString = normalizeOracleConnectString(
  process.env.DB_CONNECT_STRING ||
  process.env.ORACLE_CONNECT_STRING ||
  '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=XE)))'
);

module.exports = {
  // Credentials per Jenkins site. Never sent to the browser.
  credentials: {
    aspen: credential('ASPEN_AUTH'),
    'aspen-plus': credential('ASPEN_PLUS_AUTH'),
  },

  dbType: (process.env.DB_TYPE || 'oracle').toLowerCase(),
  oracle: {
    user: process.env.DB_USER || process.env.ORACLE_USER,
    password: process.env.DB_PASSWORD || process.env.ORACLE_PASSWORD,
    connectString: oracleConnectString,
    driverMode: (process.env.NODE_ORACLEDB_DRIVER_MODE || process.env.DB_DRIVER_MODE || 'thin').toLowerCase(),
    libDir: process.env.ORACLE_CLIENT_LIB_DIR || process.env.ORACLE_HOME,
    poolMin: Number(process.env.DB_POOL_MIN || 1),
    poolMax: Number(process.env.DB_POOL_MAX || 5),
    poolIncrement: Number(process.env.DB_POOL_INCREMENT || 1),
    stmtCacheSize: Number(process.env.DB_STMT_CACHE_SIZE || 50),
  },
  dbPath: process.env.DB_PATH || './dashboard.db',
  port: Number(process.env.PORT || 3001),

  // How often the collector refreshes build status.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60_000),
  // How often it checks whether the servers are reachable.
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS || 30_000),

  // Parallel Jenkins requests. Keep modest so a refresh doesn't spike the master.
  concurrency: Number(process.env.CONCURRENCY || 6),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 15_000),

  // Past builds retained per pipeline, used for averages and sparklines.
  historyDepth: Number(process.env.HISTORY_DEPTH || 25),

  // Data older than this is flagged stale in the UI.
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 180_000),

  /**
   * Jenkins here uses a self-signed certificate. Rather than disabling TLS
   * verification globally, point this at your CA bundle:
   *   NODE_EXTRA_CA_CERTS=/path/to/ca.pem
   * Set ALLOW_SELF_SIGNED=true only as a temporary local workaround.
   */
  allowSelfSigned: process.env.ALLOW_SELF_SIGNED === 'true',
};
