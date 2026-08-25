'use strict';

const https = require('https');
const http = require('http');
const { credentials, fetchTimeoutMs, allowSelfSigned, historyDepth } = require('./config');

/**
 * Jenkins client.
 *
 * The old dashboard made two requests per job: one to read lastBuild.number,
 * then another to fetch that build. Asking for the nested fields via `tree`
 * gets both in a single request, which halves the call count.
 */

const BUILD_FIELDS =
  'number,timestamp,duration,result,building,displayName,' +
  'actions[causes[shortDescription],failCount,totalCount,skipCount]';

const agents = {
  'https:': new https.Agent({ keepAlive: true, rejectUnauthorized: !allowSelfSigned }),
  'http:': new http.Agent({ keepAlive: true }),
};

function authHeader(product) {
  const c = credentials[product];
  if (!c) return null;
  return 'Basic ' + Buffer.from(`${c.user}:${c.token}`).toString('base64');
}

/** Strip any trailing slash or /api/json so we can append cleanly. */
function jobBase(url) {
  return String(url).trim().replace(/\/+$/, '').replace(/\/api\/json$/i, '');
}

/**
 * Uses node's http/https directly rather than global fetch, because the TLS
 * options for the self-signed Jenkins certificate have to be set per-agent —
 * fetch ignores an `agent` option.
 */
function request(url, { headers = {}, timeout = fetchTimeoutMs, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    const client = target.protocol === 'https:' ? https : http;

    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent: agents[target.protocol],
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`No response within ${timeout}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function getJson(url, product) {
  const res = await request(url, {
    headers: { Authorization: authHeader(product), Accept: 'application/json' },
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error('Response was not JSON (check credentials or URL)');
  }
}

function readBuild(b) {
  if (!b) return null;
  const actions = Array.isArray(b.actions) ? b.actions : [];
  const tests = actions.find((a) => a && a.totalCount !== undefined);
  const cause = actions.find((a) => a && Array.isArray(a.causes) && a.causes.length);
  return {
    number: b.number ?? null,
    startedAt: b.timestamp ?? null,
    durationMs: b.duration ?? null,
    result: b.building ? null : (b.result ?? null),
    building: Boolean(b.building),
    testsTotal: tests?.totalCount ?? null,
    testsFailed: tests?.failCount ?? null,
    cause: cause?.causes?.[0]?.shortDescription ?? null,
  };
}

/** Latest build for one job. One HTTP request. */
async function latestBuild(jobUrl, product) {
  const url = `${jobBase(jobUrl)}/api/json?tree=${encodeURIComponent(`lastBuild[${BUILD_FIELDS}]`)}`;
  const json = await getJson(url, product);
  const build = readBuild(json.lastBuild);
  if (!build) throw new Error('Job has no builds yet');
  return build;
}

/** Recent completed builds for one job, for averages and sparklines. */
async function buildHistory(jobUrl, product) {
  const tree = `builds[number,timestamp,duration,result,building]{0,${historyDepth}}`;
  const url = `${jobBase(jobUrl)}/api/json?tree=${encodeURIComponent(tree)}`;
  const json = await getJson(url, product);
  return (json.builds || [])
    .filter((b) => !b.building && b.number != null && b.duration > 0)
    .map((b) => ({
      number: b.number,
      startedAt: b.timestamp ?? null,
      durationMs: b.duration ?? null,
      result: b.result ?? null,
    }));
}

/**
 * Read one dashboard pipeline.
 *
 * Paired pipelines (Aspen deploys) span two jobs: the Multijob that starts the
 * deployment and the Maintenance_Page_Off job that ends it. The meaningful
 * duration is the gap between their start times, which is what the old
 * dashboard computed. A pipeline counts as running if either job is running.
 */
async function readPipeline({ product, env, urls, paired }) {
  if (!paired) {
    const b = await latestBuild(urls[0], product);
    return { ...b, jobUrl: jobBase(urls[0]) };
  }

  const [a, z] = await Promise.all([
    latestBuild(urls[0], product),
    latestBuild(urls[1], product),
  ]);

  const building = a.building || z.building;
  const bothTimestamps = a.startedAt != null && z.startedAt != null;

  return {
    number: a.number,
    startedAt: bothTimestamps ? Math.max(a.startedAt, z.startedAt) : (a.startedAt ?? z.startedAt),
    // Deployment window between the two jobs. Unknown while either is running.
    durationMs: building || !bothTimestamps ? null : Math.abs(a.startedAt - z.startedAt),
    result: building ? null : (a.result === 'FAILURE' || z.result === 'FAILURE' ? 'FAILURE' : (z.result ?? a.result)),
    building,
    testsTotal: a.testsTotal ?? z.testsTotal,
    testsFailed: a.testsFailed ?? z.testsFailed,
    cause: a.cause ?? z.cause,
    jobUrl: jobBase(urls[0]),
  };
}

/** For paired pipelines, history comes from the starting job. */
async function readHistory({ product, urls }) {
  return buildHistory(urls[0], product);
}

/** Reachability probe used by the Status tab. */
async function probe(server) {
  const started = Date.now();
  try {
    const res = await request(server.url, {
      timeout: 5000,
      headers: { 'User-Agent': 'aspen-dashboard-healthcheck' },
    });
    return {
      status: 'up',
      http_code: res.statusCode,
      response_time_ms: Date.now() - started,
      message: 'Reachable',
    };
  } catch (err) {
    return {
      status: 'down',
      http_code: null,
      response_time_ms: null,
      message: err.message,
    };
  }
}

module.exports = { readPipeline, readHistory, probe };
