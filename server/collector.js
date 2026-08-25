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

async function collectOne(pipeline, withHistory) {
  const now = Date.now();
  try {
    const build = await jenkins.readPipeline(pipeline);

    if (withHistory) {
      try {
        const builds = await jenkins.readHistory(pipeline);
        if (builds.length) store.saveHistory(pipeline.product, pipeline.env, builds);
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
    // Keep whatever build data is already stored; just record why the refresh failed.
    store.recordPipelineError(pipeline.product, pipeline.env, err.message, now);
    return { ok: false, env: `${pipeline.product}/${pipeline.env}`, message: err.message };
  }
}

async function collectStatus() {
  const started = Date.now();
  const pipelines = allPipelines();

  // Refresh history every 10th cycle — it changes slowly and costs an extra call.
  const withHistory = historyCounter++ % 10 === 0;

  const results = await pool(pipelines, concurrency, (p) => collectOne(p, withHistory));

  const rows = results.filter((r) => r.ok).map((r) => r.row);
  if (rows.length) store.saveStatusBatch(rows);

  const failures = results.filter((r) => !r.ok);
  store.saveRun({
    started,
    success: rows.length ? Date.now() : (store.lastRun()?.last_success_at ?? null),
    ok: rows.length,
    fail: failures.length,
  });

  log(
    `poll: ${rows.length} ok, ${failures.length} failed, ${Date.now() - started}ms` +
      (withHistory ? ' (with history)' : '')
  );
  for (const f of failures.slice(0, 5)) log(`  ! ${f.env}: ${f.message}`);
}

async function collectHealth() {
  await Promise.all(
    MONITORED_SERVERS.map(async (server) => {
      const result = await jenkins.probe(server);
      store.saveHealth({
        id: server.id,
        name: server.name,
        url: server.url,
        checked_at: Date.now(),
        ...result,
      });
    })
  );
}

function start() {
  log(`collector: ${allPipelines().length} pipelines, every ${pollIntervalMs / 1000}s`);
  collectStatus();
  collectHealth();
  setInterval(collectStatus, pollIntervalMs);
  setInterval(collectHealth, healthIntervalMs);
}

module.exports = { start, collectStatus, collectHealth };

if (require.main === module) start();
