'use strict';

const path = require('path');
const express = require('express');
const { port, staleAfterMs, historyDepth } = require('./config');
const { PRODUCTS, ENV_GROUPS, placeholderPipeline } = require('./pipelines');
const store = require('./db');
const collector = require('./collector');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

/** Shape one stored row into what the dashboard renders. */
async function toView(row, now) {
  const building = row.building === 1 && !row.error;
  const { avg_ms: avgMs, n } = await store.avgDuration(row.product, row.env);
  const typical = n >= 3 && avgMs > 0 ? Math.round(avgMs) : null;

  const elapsedMs = building && row.started_at ? now - row.started_at : null;
  const trend = (await store.recent(row.product, row.env, 12)).reverse().map((b) => ({
    n: b.build_number,
    ms: b.duration_ms,
    result: b.result,
  }));

  return {
    product: row.product,
    env: row.env,
    jobUrl: row.job_url,
    buildNumber: row.build_number,
    startedAt: row.started_at,
    durationMs: building ? elapsedMs : row.duration_ms,
    status: building ? 'RUNNING' : (row.result || (row.error ? 'UNKNOWN' : 'UNKNOWN')),
    building,
    progressPct:
      building && typical && elapsedMs != null
        ? Math.min(99, Math.round((elapsedMs / typical) * 100))
        : null,
    typicalMs: typical,
    testsTotal: row.tests_total,
    testsFailed: row.tests_failed,
    cause: row.cause,
    error: row.error,
    fetchedAt: row.fetched_at,
    stale: now - row.fetched_at > staleAfterMs,
    trend,
  };
}

app.get('/api/status', asyncRoute(async (req, res) => {
  const now = Date.now();
  const rows = await store.allStatus();
  const pipelines = await Promise.all(rows.map((r) => toView(r, now)));

  const byKey = {};
  for (const p of pipelines) byKey[`${p.product}:${p.env}`] = p;

  for (const product of PRODUCTS) {
    for (const group of ENV_GROUPS) {
      for (const env of group.envs) {
        const key = `${product.id}:${env.id}`;
        if (!byKey[key]) {
          const placeholder = placeholderPipeline(product.id, env.id);
          if (placeholder) byKey[key] = placeholder;
        }
      }
    }
  }

  const run = (await store.lastRun()) || {};
  const servers = await store.allHealth();

  res.json({
    generatedAt: now,
    layout: { products: PRODUCTS, groups: ENV_GROUPS },
    collector: {
      lastRunAt: run.last_started_at ?? null,
      lastSuccessAt: run.last_success_at ?? null,
      okCount: run.ok_count ?? 0,
      failCount: run.fail_count ?? 0,
      healthy: run.last_success_at != null && now - run.last_success_at <= staleAfterMs,
    },
    servers: servers.map((h) => ({
      id: h.id,
      name: h.name,
      url: h.url,
      status: h.status,
      httpCode: h.http_code,
      responseTimeMs: h.response_time_ms,
      message: h.message,
      checkedAt: h.checked_at,
    })),
    counts: {
      total: pipelines.length,
      running: pipelines.filter((p) => p.building).length,
      failed: pipelines.filter((p) => p.status === 'FAILURE').length,
      unreachable: pipelines.filter((p) => p.error).length,
    },
    pipelines: byKey,
  });
}));

app.get('/api/smoke', asyncRoute(async (req, res) => {
  const rows = await store.allSmokeResults();
  const smoke = rows.map((row) => ({
    env: row.environment_name,
    buildNumber: row.build_number,
    buildUrl: row.build_url,
    reportUrl: row.report_url,
    generatedAt: row.generated_at,
    totalScripts: Number(row.total_scripts || 0),
    passed: Number(row.passed_count || 0),
    failed: Number(row.failed_count || 0),
    pending: Number(row.pending_count || 0),
    historyPassed: Number(row.history_passed_count || 0),
    historyFailed: Number(row.history_failed_count || 0),
    tests: JSON.parse(row.tests || '[]'),
    fetchedAt: row.fetched_at,
  }));
  res.json({ generatedAt: Date.now(), smoke });
}));

app.get('/api/history/:product/:env', asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || historyDepth, 100);
  res.json({
    product: req.params.product,
    env: req.params.env,
    builds: await store.recent(req.params.product, req.params.env, limit),
  });
}));

app.post('/api/refresh', asyncRoute(async (req, res) => {
  await Promise.all([
    collector.collectStatus(),
    collector.collectSmokeResults(),
  ]);
  res.json({ ok: true, refreshedAt: Date.now() });
}));

app.use((error, req, res, next) => {
  console.error('Request failed:', error.message || error);
  if (res.headersSent) return next(error);
  res.status(503).json({ error: 'Dashboard data service is temporarily unavailable.' });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

async function startServer() {
  try {
    await store.initDb();
    collector.start();
    app.listen(port, () => {
      console.log(`Dashboard on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Startup failed:', error.message || error);
    process.exit(1);
  }
}

startServer();
