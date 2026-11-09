'use strict';

const { pollIntervalMs, healthIntervalMs, concurrency } = require('./config');
const { allPipelines, MONITORED_SERVERS } = require('./pipelines');
const jenkins = require('./jenkins');
const store = require('./db');

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Run tasks with a fixed number in flight, so we never flood the Jenkins master. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

let historyCounter = 0;
let statusPollInFlight = false;
let healthPollInFlight = false;
const SMOKE_ENVIRONMENTS = ['DEV01', 'DEV02', 'DEV03', 'DEV04'];

async function collectOne(pipeline, withHistory) {
  const now = Date.now();
  try {
    const build = await jenkins.readPipeline(pipeline);

    if (withHistory) {
      try {
        const builds = await jenkins.readHistory(pipeline);
        if (builds.length) await store.saveHistory(pipeline.product, pipeline.env, builds);
      } catch {
        // History is a nice-to-have; never let it fail the status read.
      }
    }

    return {
      ok: true,
      row: {
        product: pipeline.product,
        env: pipeline.env,
        job_url: build.jobUrl,
        build_number: build.number,
        started_at: build.startedAt,
        duration_ms: build.durationMs,
        result: build.result,
        building: build.building ? 1 : 0,
        tests_total: build.testsTotal,
        tests_failed: build.testsFailed,
        cause: build.cause,
        error: null,
        fetched_at: now,
      },
    };
  } catch (err) {
    const message = err.message || String(err);
    try {
      await store.recordPipelineError(pipeline.product, pipeline.env, message, now);
    } catch (storageError) {
      log(`could not save ${pipeline.product}/${pipeline.env} error:`, storageError.message || storageError);
    }
    return { ok: false, env: `${pipeline.product}/${pipeline.env}`, message };
  }
}

async function collectStatus() {
  const started = Date.now();
  const pipelines = allPipelines();
  const withHistory = historyCounter++ % 10 === 0;

  const results = await pool(pipelines, concurrency, (p) => collectOne(p, withHistory));

  const rows = results.filter((r) => r.ok).map((r) => r.row);
  if (rows.length) await store.saveStatusBatch(rows);

  const failures = results.filter((r) => !r.ok);
  const previousRun = await store.lastRun();
  await store.saveRun({
    started,
    success: rows.length ? Date.now() : (previousRun?.last_success_at ?? null),
    ok: rows.length,
    fail: failures.length,
  });

  log(
    `poll: ${rows.length} ok, ${failures.length} failed, ${Date.now() - started}ms` +
      (withHistory ? ' (with history)' : '')
  );
  for (const f of failures.slice(0, 5)) log(`  ! ${f.env}: ${f.message}`);
}

async function collectSmokeResults() {
  const results = await Promise.allSettled(
    SMOKE_ENVIRONMENTS.map(async (env) => {
      const report = await jenkins.readSmokeReport(env);
      await store.saveSmokeResult(report);
      return env;
    })
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    log('smoke poll failed:', failures.map((failure) => failure.reason.message || failure.reason).join('; '));
  }
  return { ok: SMOKE_ENVIRONMENTS.length - failures.length, fail: failures.length };
}

async function collectHealth() {
  const results = await Promise.allSettled(
    MONITORED_SERVERS.map(async (server) => {
      const result = await jenkins.probe(server);
      await store.saveHealth({
        id: server.id,
        name: server.name,
        url: server.url,
        checked_at: Date.now(),
        ...result,
      });
    })
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

function runStatusPoll() {
  if (statusPollInFlight) return;
  statusPollInFlight = true;
  collectStatus()
    .catch((error) => log('collectStatus failed:', error.message || error))
    .finally(() => {
      statusPollInFlight = false;
    });
}

function runHealthPoll() {
  if (healthPollInFlight) return;
  healthPollInFlight = true;
  collectHealth()
    .catch((error) => log('collectHealth failed:', error.message || error))
    .finally(() => {
      healthPollInFlight = false;
    });
}

async function start() {
  await store.initDb();
  log(`collector: ${allPipelines().length} pipelines, every ${pollIntervalMs / 1000}s`);
  runStatusPoll();
  collectSmokeResults().catch((error) => log('collectSmokeResults failed:', error.message || error));
  runHealthPoll();
  setInterval(runStatusPoll, pollIntervalMs);
  setInterval(() => collectSmokeResults().catch((error) => log('collectSmokeResults failed:', error.message || error)), pollIntervalMs);
  setInterval(runHealthPoll, healthIntervalMs);
}

module.exports = { start, collectStatus, collectHealth, collectSmokeResults };

if (require.main === module) {
  start().catch((error) => {
    console.error('Collector startup failed:', error.message || error);
    process.exit(1);
  });
}
