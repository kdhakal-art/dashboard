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

/** Shape one stored row into what the dashboard renders. */
function toView(row, now) {
  // A failed poll must not keep a stale "running" state alive in the UI.
  const building = row.building === 1 && !row.error;
  const { avg_ms: avgMs, n } = store.avgDuration(row.product, row.env);
  const typical = n >= 3 && avgMs > 0 ? Math.round(avgMs) : null;

  // Jenkins reports duration 0 while a build runs, so elapsed comes from the start time.
  const elapsedMs = building && row.started_at ? now - row.started_at : null;

  return {
    product: row.product,
    env: row.env,
    jobUrl: row.job_url,
    buildNumber: row.build_number,
    startedAt: row.started_at,
    durationMs: building ? elapsedMs : row.duration_ms,
    status: building ? 'RUNNING' : (row.result || (row.error ? 'UNKNOWN' : 'UNKNOWN')),
    building,
    // Capped at 99 so an overrunning build never displays as finished.
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
    trend: store
      .recent(row.product, row.env, 12)
      .reverse()
      .map((b) => ({ n: b.build_number, ms: b.duration_ms, result: b.result })),
  };
}

/** Everything the dashboard needs, in one request served entirely from SQLite. */
app.get('/api/status', (req, res) => {
  const now = Date.now();
  const pipelines = store.allStatus().map((r) => toView(r, now));

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

  const run = store.lastRun() || {};

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
    servers: store.allHealth().map((h) => ({
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
});

app.get('/api/history/:product/:env', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || historyDepth, 100);
  res.json({
    product: req.params.product,
    env: req.params.env,
    builds: store.recent(req.params.product, req.params.env, limit),
  });
});

/** Forces an immediate poll, behind the Refresh button. */
app.post('/api/refresh', async (req, res) => {
  await collector.collectStatus();
  res.json({ ok: true, refreshedAt: Date.now() });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

collector.start();

app.listen(port, () => {
  console.log(`Dashboard on http://localhost:${port}`);
});
