'use strict';

const Database = require('better-sqlite3');
const { dbPath, historyDepth } = require('./config');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL'); // readers never block on the collector's writes

db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_status (
    product       TEXT    NOT NULL,
    env           TEXT    NOT NULL,
    job_url       TEXT,
    build_number  INTEGER,
    started_at    INTEGER,
    duration_ms   INTEGER,
    result        TEXT,
    building      INTEGER NOT NULL DEFAULT 0,
    tests_total   INTEGER,
    tests_failed  INTEGER,
    cause         TEXT,
    error         TEXT,
    fetched_at    INTEGER NOT NULL,
    PRIMARY KEY (product, env)
  );

  CREATE TABLE IF NOT EXISTS build_history (
    product       TEXT    NOT NULL,
    env           TEXT    NOT NULL,
    build_number  INTEGER NOT NULL,
    started_at    INTEGER,
    duration_ms   INTEGER,
    result        TEXT,
    PRIMARY KEY (product, env, build_number)
  );

  CREATE TABLE IF NOT EXISTS server_health (
    id               TEXT PRIMARY KEY,
    name             TEXT,
    url              TEXT,
    status           TEXT,
    http_code        INTEGER,
    response_time_ms INTEGER,
    message          TEXT,
    checked_at       INTEGER
  );

  CREATE TABLE IF NOT EXISTS collector_runs (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_started_at INTEGER,
    last_success_at INTEGER,
    ok_count        INTEGER,
    fail_count      INTEGER
  );
`);

const S = {
  upsertStatus: db.prepare(`
    INSERT INTO pipeline_status
      (product, env, job_url, build_number, started_at, duration_ms, result,
       building, tests_total, tests_failed, cause, error, fetched_at)
    VALUES
      (@product, @env, @job_url, @build_number, @started_at, @duration_ms, @result,
       @building, @tests_total, @tests_failed, @cause, @error, @fetched_at)
    ON CONFLICT(product, env) DO UPDATE SET
      job_url = excluded.job_url, build_number = excluded.build_number,
      started_at = excluded.started_at, duration_ms = excluded.duration_ms,
      result = excluded.result, building = excluded.building,
      tests_total = excluded.tests_total, tests_failed = excluded.tests_failed,
      cause = excluded.cause, error = excluded.error,
      fetched_at = excluded.fetched_at
  `),

  // A failed poll should not leave the job looking like it is still running.
  // Keep the last known build data, but clear the active-running flag.
  markPipelineError: db.prepare(`
    UPDATE pipeline_status
    SET error = ?, fetched_at = ?, building = 0
    WHERE product = ? AND env = ?
  `),

  insertPipelineError: db.prepare(`
    INSERT OR IGNORE INTO pipeline_status (product, env, error, fetched_at)
    VALUES (?, ?, ?, ?)
  `),

  insertHistory: db.prepare(`
    INSERT OR IGNORE INTO build_history
      (product, env, build_number, started_at, duration_ms, result)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  trimHistory: db.prepare(`
    DELETE FROM build_history WHERE product = ? AND env = ? AND build_number NOT IN (
      SELECT build_number FROM build_history WHERE product = ? AND env = ?
      ORDER BY build_number DESC LIMIT ?
    )
  `),

  allStatus: db.prepare(`SELECT * FROM pipeline_status`),

  recent: db.prepare(`
    SELECT build_number, started_at, duration_ms, result FROM build_history
    WHERE product = ? AND env = ? ORDER BY build_number DESC LIMIT ?
  `),

  avgDuration: db.prepare(`
    SELECT AVG(duration_ms) AS avg_ms, COUNT(*) AS n FROM (
      SELECT duration_ms FROM build_history
      WHERE product = ? AND env = ? AND result = 'SUCCESS' AND duration_ms > 0
      ORDER BY build_number DESC LIMIT 10
    )
  `),

  upsertHealth: db.prepare(`
    INSERT INTO server_health
      (id, name, url, status, http_code, response_time_ms, message, checked_at)
    VALUES (@id, @name, @url, @status, @http_code, @response_time_ms, @message, @checked_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, url = excluded.url, status = excluded.status,
      http_code = excluded.http_code, response_time_ms = excluded.response_time_ms,
      message = excluded.message, checked_at = excluded.checked_at
  `),

  allHealth: db.prepare(`SELECT * FROM server_health`),

  saveRun: db.prepare(`
    INSERT INTO collector_runs (id, last_started_at, last_success_at, ok_count, fail_count)
    VALUES (1, @started, @success, @ok, @fail)
    ON CONFLICT(id) DO UPDATE SET
      last_started_at = excluded.last_started_at,
      last_success_at = excluded.last_success_at,
      ok_count = excluded.ok_count, fail_count = excluded.fail_count
  `),

  lastRun: db.prepare(`SELECT * FROM collector_runs WHERE id = 1`),
};

const saveStatusBatch = db.transaction((rows) => {
  for (const r of rows) S.upsertStatus.run(r);
});

const saveHistory = db.transaction((product, env, builds) => {
  for (const b of builds) {
    S.insertHistory.run(product, env, b.number, b.startedAt, b.durationMs, b.result);
  }
  S.trimHistory.run(product, env, product, env, historyDepth);
});

module.exports = {
  db,
  saveStatusBatch,
  saveHistory,
  recordPipelineError(product, env, message, at) {
    S.insertPipelineError.run(product, env, message, at);
    S.markPipelineError.run(message, at, product, env);
  },
  allStatus: () => S.allStatus.all(),
  recent: (p, e, n) => S.recent.all(p, e, n),
  avgDuration: (p, e) => S.avgDuration.get(p, e),
  saveHealth: (row) => S.upsertHealth.run(row),
  allHealth: () => S.allHealth.all(),
  saveRun: (r) => S.saveRun.run(r),
  lastRun: () => S.lastRun.get(),
};
