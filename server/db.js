'use strict';

const oracledb = require('oracledb');
const { dbType, oracle, historyDepth } = require('./config');
const { buildSmokeScenarioRows } = require('./smoke');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

if (dbType === 'oracle' && oracle.driverMode === 'thick') {
  const libDir = oracle.libDir;
  if (libDir) {
    oracledb.initOracleClient({ libDir });
  } else {
    console.warn('Oracle thick mode is enabled but ORACLE_CLIENT_LIB_DIR/ORACLE_HOME is not set.');
  }
}

const mapLowerKeys = (row = {}) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).toLowerCase(), value]));

function ensureOracleConfig() {
  if (dbType !== 'oracle') return;
  if (!oracle.user || !oracle.password || !oracle.connectString) {
    throw new Error('Oracle database is enabled but DB_USER, DB_PASSWORD, and DB_CONNECT_STRING are not configured.');
  }
}

let pool;

async function getPool() {
  if (dbType !== 'oracle') {
    throw new Error(`Unsupported DB type: ${dbType}. Oracle is required for this app.`);
  }

  if (!pool) {
    ensureOracleConfig();
    try {
      pool = await oracledb.createPool({
        user: oracle.user,
        password: oracle.password,
        connectString: oracle.connectString,
        poolMin: oracle.poolMin,
        poolMax: oracle.poolMax,
        poolIncrement: oracle.poolIncrement,
        stmtCacheSize: oracle.stmtCacheSize,
      });
      pool.on('error', (err) => {
        console.error('Oracle pool error:', err.message || err);
      });
    } catch (err) {
      console.error('Oracle connection failed. If the DB enforces Native Network Encryption, use thick mode with Oracle client libraries or ask the DBA to relax encryption for this service.');
      throw err;
    }
  }

  return pool;
}

async function withConnection(fn) {
  const connectionPool = await getPool();
  let connection;
  try {
    connection = await connectionPool.getConnection();
    return await fn(connection);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function initDb() {
  if (dbType !== 'oracle') {
    return;
  }

  await withConnection(async (connection) => {
    const statements = [
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE pipeline_status (
        product VARCHAR2(200) NOT NULL,
        env VARCHAR2(100) NOT NULL,
        job_url VARCHAR2(4000),
        build_number NUMBER,
        started_at NUMBER,
        duration_ms NUMBER,
        result VARCHAR2(100),
        building NUMBER(1) DEFAULT 0 NOT NULL,
        tests_total NUMBER,
        tests_failed NUMBER,
        cause VARCHAR2(4000),
        error VARCHAR2(4000),
        fetched_at NUMBER NOT NULL,
        CONSTRAINT pipeline_status_pk PRIMARY KEY (product, env)
      )'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`,
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE build_history (
        product VARCHAR2(200) NOT NULL,
        env VARCHAR2(100) NOT NULL,
        build_number NUMBER NOT NULL,
        started_at NUMBER,
        duration_ms NUMBER,
        result VARCHAR2(100),
        CONSTRAINT build_history_pk PRIMARY KEY (product, env, build_number)
      )'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`,
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE server_health (
        id VARCHAR2(200) PRIMARY KEY,
        name VARCHAR2(200),
        url VARCHAR2(4000),
        status VARCHAR2(100),
        http_code NUMBER,
        response_time_ms NUMBER,
        message VARCHAR2(4000),
        checked_at NUMBER
      )'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`,
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE collector_runs (
        id NUMBER(1) PRIMARY KEY CHECK (id = 1),
        last_started_at NUMBER,
        last_success_at NUMBER,
        ok_count NUMBER,
        fail_count NUMBER
      )'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`,
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE smoke_results (
        environment_name VARCHAR2(100),
        build_number NUMBER,
        build_url VARCHAR2(4000),
        report_url VARCHAR2(4000),
        generated_at NUMBER,
        total_scripts NUMBER,
        passed_count NUMBER,
        failed_count NUMBER,
        pending_count NUMBER,
        history_passed_count NUMBER,
        history_failed_count NUMBER,
        tests CLOB,
        fetched_at NUMBER,
        CONSTRAINT smoke_results_pk PRIMARY KEY (environment_name)
      )'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`,
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE smoke_test_results (
        environment_name VARCHAR2(100) NOT NULL,
        build_number NUMBER NOT NULL,
        test_case VARCHAR2(4000) NOT NULL,
        status VARCHAR2(100) NOT NULL,
        runs NUMBER,
        last_run_at VARCHAR2(200),
        report_url VARCHAR2(4000),
        fetched_at NUMBER NOT NULL,
        CONSTRAINT smoke_test_results_pk PRIMARY KEY (environment_name, build_number, test_case)
      )'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`
    ];

    for (const statement of statements) {
      await connection.execute(statement);
    }

    await connection.commit();
  });
}

async function rowExists(connection, sql, binds) {
  const result = await connection.execute(sql, binds || {});
  return result.rows && result.rows.length > 0;
}

async function saveStatusBatch(rows) {
  if (!rows || !rows.length) return;

  await withConnection(async (connection) => {
    for (const row of rows) {
      await connection.execute(
        `MERGE INTO pipeline_status target
         USING (SELECT :product AS product, :env AS env FROM dual) src
         ON (target.product = src.product AND target.env = src.env)
         WHEN MATCHED THEN UPDATE SET
           job_url = :job_url,
           build_number = :build_number,
           started_at = :started_at,
           duration_ms = :duration_ms,
           result = :result,
           building = :building,
           tests_total = :tests_total,
           tests_failed = :tests_failed,
           cause = :cause,
           error = :error,
           fetched_at = :fetched_at
         WHEN NOT MATCHED THEN INSERT (
           product, env, job_url, build_number, started_at, duration_ms, result,
           building, tests_total, tests_failed, cause, error, fetched_at
         ) VALUES (
           :product, :env, :job_url, :build_number, :started_at, :duration_ms,
           :result, :building, :tests_total, :tests_failed, :cause, :error,
           :fetched_at
         )`,
        {
          product: row.product,
          env: row.env,
          job_url: row.job_url,
          build_number: row.build_number,
          started_at: row.started_at,
          duration_ms: row.duration_ms,
          result: row.result,
          building: row.building,
          tests_total: row.tests_total,
          tests_failed: row.tests_failed,
          cause: row.cause,
          error: row.error,
          fetched_at: row.fetched_at,
        }
      );
    }
    await connection.commit();
  });
}

async function saveHistory(product, env, builds) {
  if (!builds || !builds.length) return;

  await withConnection(async (connection) => {
    for (const build of builds) {
      await connection.execute(
        `MERGE INTO build_history target
         USING (SELECT :product AS product, :env AS env, :build_number AS build_number FROM dual) src
         ON (target.product = src.product AND target.env = src.env AND target.build_number = src.build_number)
         WHEN NOT MATCHED THEN INSERT (
           product, env, build_number, started_at, duration_ms, result
         ) VALUES (
           :product, :env, :build_number, :started_at, :duration_ms, :result
         )`,
        {
          product,
          env,
          build_number: build.number,
          started_at: build.startedAt,
          duration_ms: build.durationMs,
          result: build.result,
        }
      );
    }

    await connection.execute(
      `DELETE FROM build_history
       WHERE product = :product
         AND env = :env
         AND build_number NOT IN (
           SELECT build_number
           FROM (
             SELECT build_number
             FROM build_history
             WHERE product = :product AND env = :env
             ORDER BY build_number DESC
             FETCH FIRST :limit ROWS ONLY
           )
         )`,
      { product, env, limit: Number(historyDepth) }
    );
    await connection.commit();
  });
}

async function recordPipelineError(product, env, message, at) {
  await withConnection(async (connection) => {
    const hasRow = await rowExists(
      connection,
      `SELECT 1 FROM pipeline_status WHERE product = :product AND env = :env`,
      { product, env }
    );

    if (hasRow) {
      await connection.execute(
        `UPDATE pipeline_status
         SET error = :message,
             fetched_at = :at,
             building = 0
         WHERE product = :product AND env = :env`,
        { message, at, product, env }
      );
    } else {
      await connection.execute(
        `INSERT INTO pipeline_status (product, env, error, fetched_at, building)
         VALUES (:product, :env, :message, :at, 0)`,
        { product, env, message, at }
      );
    }
    await connection.commit();
  });
}

async function allStatus() {
  return withConnection(async (connection) => {
    const result = await connection.execute(`SELECT * FROM pipeline_status ORDER BY product, env`);
    return (result.rows || []).map(mapLowerKeys);
  });
}

async function saveSmokeResult(report) {
  await withConnection(async (connection) => {
    await connection.execute(
      `MERGE INTO smoke_results target
       USING (SELECT :env AS environment_name FROM dual) src
       ON (target.environment_name = src.environment_name)
       WHEN MATCHED THEN UPDATE SET
         build_number = :build_number,
         build_url = :build_url,
         report_url = :report_url,
         generated_at = :generated_at,
         total_scripts = :total_scripts,
         passed_count = :passed_count,
         failed_count = :failed_count,
         pending_count = :pending_count,
         history_passed_count = :history_passed_count,
         history_failed_count = :history_failed_count,
         tests = :tests,
         fetched_at = :fetched_at
       WHEN NOT MATCHED THEN INSERT (
         environment_name, build_number, build_url, report_url, generated_at,
         total_scripts, passed_count, failed_count, pending_count,
         history_passed_count, history_failed_count, tests, fetched_at
       ) VALUES (
         :env, :build_number, :build_url, :report_url, :generated_at,
         :total_scripts, :passed_count, :failed_count, :pending_count,
         :history_passed_count, :history_failed_count, :tests, :fetched_at
       )`,
      {
        env: report.env,
        build_number: report.buildNumber,
        build_url: report.buildUrl,
        report_url: report.reportUrl,
        generated_at: report.generatedAt,
        total_scripts: report.totalScripts,
        passed_count: report.passed,
        failed_count: report.failed,
        pending_count: report.pending,
        history_passed_count: report.historyPassed,
        history_failed_count: report.historyFailed,
        tests: JSON.stringify(report.tests),
        fetched_at: Date.now(),
      }
    );

    for (const scenario of buildSmokeScenarioRows(report)) {
      await connection.execute(
        `MERGE INTO smoke_test_results target
         USING (SELECT :environment_name AS environment_name,
                       :build_number AS build_number,
                       :test_case AS test_case
                FROM dual) src
         ON (target.environment_name = src.environment_name
             AND target.build_number = src.build_number
             AND target.test_case = src.test_case)
         WHEN MATCHED THEN UPDATE SET
           status = :status,
           runs = :runs,
           last_run_at = :last_run_at,
           report_url = :report_url,
           fetched_at = :fetched_at
         WHEN NOT MATCHED THEN INSERT (
           environment_name, build_number, test_case, status, runs,
           last_run_at, report_url, fetched_at
         ) VALUES (
           :environment_name, :build_number, :test_case, :status, :runs,
           :last_run_at, :report_url, :fetched_at
         )`,
        {
          environment_name: scenario.environmentName,
          build_number: scenario.buildNumber,
          test_case: scenario.testCase,
          status: scenario.status,
          runs: scenario.runs,
          last_run_at: scenario.lastRunAt,
          report_url: scenario.reportUrl,
          fetched_at: scenario.fetchedAt,
        }
      );
    }

    await connection.commit();
  });
}

async function allSmokeResults() {
  return withConnection(async (connection) => {
    const result = await connection.execute(`SELECT * FROM smoke_results ORDER BY environment_name`);
    const rows = await Promise.all((result.rows || []).map(async (row) => {
      const normalized = mapLowerKeys(row);
      if (normalized.tests && typeof normalized.tests.getData === 'function') {
        const data = await normalized.tests.getData();
        normalized.tests = data.toString('utf8');
      }
      return normalized;
    }));
    return rows;
  });
}

async function allSmokeTestResults() {
  return withConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT * FROM smoke_test_results
       ORDER BY environment_name, build_number, test_case`
    );
    return (result.rows || []).map(mapLowerKeys);
  });
}

async function recent(product, env, n) {
  return withConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT build_number, started_at, duration_ms, result
       FROM build_history
       WHERE product = :product AND env = :env
       ORDER BY build_number DESC
       FETCH FIRST :limit ROWS ONLY`,
      { product, env, limit: Number(n) }
    );
    return (result.rows || []).map(mapLowerKeys);
  });
}

async function avgDuration(product, env) {
  return withConnection(async (connection) => {
    const result = await connection.execute(
      `SELECT AVG(duration_ms) AS avg_ms, COUNT(*) AS n
       FROM (
         SELECT duration_ms
         FROM build_history
         WHERE product = :product AND env = :env AND result = 'SUCCESS' AND duration_ms > 0
         ORDER BY build_number DESC
         FETCH FIRST 10 ROWS ONLY
       )`,
      { product, env }
    );
    const row = result.rows && result.rows[0] ? mapLowerKeys(result.rows[0]) : { avg_ms: null, n: 0 };
    return { avg_ms: row.avg_ms, n: Number(row.n || 0) };
  });
}

async function saveHealth(row) {
  await withConnection(async (connection) => {
    await connection.execute(
      `MERGE INTO server_health target
       USING (SELECT :id AS id FROM dual) src
       ON (target.id = src.id)
       WHEN MATCHED THEN UPDATE SET
         name = :name,
         url = :url,
         status = :status,
         http_code = :http_code,
         response_time_ms = :response_time_ms,
         message = :message,
         checked_at = :checked_at
       WHEN NOT MATCHED THEN INSERT (
         id, name, url, status, http_code, response_time_ms, message, checked_at
       ) VALUES (
         :id, :name, :url, :status, :http_code, :response_time_ms, :message, :checked_at
       )`,
      {
        id: row.id,
        name: row.name,
        url: row.url,
        status: row.status,
        http_code: row.http_code,
        response_time_ms: row.response_time_ms,
        message: row.message,
        checked_at: row.checked_at,
      }
    );
    await connection.commit();
  });
}

async function allHealth() {
  return withConnection(async (connection) => {
    const result = await connection.execute(`SELECT * FROM server_health ORDER BY checked_at DESC`);
    return (result.rows || []).map(mapLowerKeys);
  });
}

async function saveRun(run) {
  await withConnection(async (connection) => {
    await connection.execute(
      `MERGE INTO collector_runs target
       USING (SELECT 1 AS id FROM dual) src
       ON (target.id = src.id)
       WHEN MATCHED THEN UPDATE SET
         last_started_at = :started,
         last_success_at = :success,
         ok_count = :ok,
         fail_count = :fail
       WHEN NOT MATCHED THEN INSERT (
         id, last_started_at, last_success_at, ok_count, fail_count
       ) VALUES (
         1, :started, :success, :ok, :fail
       )`,
      {
        started: run.started,
        success: run.success,
        ok: run.ok,
        fail: run.fail,
      }
    );
    await connection.commit();
  });
}

async function lastRun() {
  return withConnection(async (connection) => {
    const result = await connection.execute(`SELECT * FROM collector_runs WHERE id = 1`);
    const row = result.rows && result.rows[0] ? mapLowerKeys(result.rows[0]) : null;
    return row;
  });
}

module.exports = {
  initDb,
  saveStatusBatch,
  saveHistory,
  recordPipelineError,
  allStatus,
  saveSmokeResult,
  allSmokeResults,
  allSmokeTestResults,
  recent,
  avgDuration,
  saveHealth,
  allHealth,
  saveRun,
  lastRun,
  close() {
    if (pool) {
      return pool.close();
    }
    return Promise.resolve();
  },
};
