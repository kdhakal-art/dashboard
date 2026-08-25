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

module.exports = {
  // Credentials per Jenkins site. Never sent to the browser.
  credentials: {
    aspen: credential('ASPEN_AUTH'),
    'aspen-plus': credential('ASPEN_PLUS_AUTH'),
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
