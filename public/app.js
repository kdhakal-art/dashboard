'use strict';

/**
 * The dashboard makes exactly one network call: GET /api/status.
 * Everything — layout, build state, server health — comes back in that
 * response, already read from SQLite. Jenkins is never in the request path.
 */

const POLL_MS = 15_000; // cheap: hits SQLite, not Jenkins
const API = '/api/status';

let snapshot = null;
let activeTab = 'aspen';
let tickTimer = null;

/* ---------- formatting ---------- */

function formatDuration(ms) {
  if (ms == null || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return { value: `${h}:${String(m).padStart(2, '0')}`, unit: 'h' };
  if (m > 0) return { value: `${m}:${String(s).padStart(2, '0')}`, unit: 'm' };
  return { value: String(s), unit: 's' };
}

function shortDuration(ms) {
  const d = formatDuration(ms);
  return d ? `${d.value}${d.unit}` : '—';
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function lastSeenDisplay(ts) {
  if (!ts) return { date: '—', time: '—', ago: 'never' };
  const value = new Date(ts);
  const date = value.toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const time = value.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return { date, time, ago: relativeTime(ts) };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* ---------- pieces ---------- */

/** Bar sparkline of recent build durations, tallest = slowest. */
function sparkline(trend) {
  if (!trend || trend.length < 2) return '';
  const max = Math.max(...trend.map((b) => b.ms || 0)) || 1;
  const w = 100 / trend.length;

  const bars = trend
    .map((b, i) => {
      const h = Math.max(8, ((b.ms || 0) / max) * 100);
      const cls =
        b.result === 'FAILURE' ? 'bad' : b.result === 'UNSTABLE' ? 'warn' : b.result === 'SUCCESS' ? 'ok' : '';
      return `<rect class="bar ${cls}" x="${(i * w + w * 0.16).toFixed(2)}" y="${(100 - h).toFixed(2)}"
              width="${(w * 0.68).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6">
              <title>#${b.n} · ${shortDuration(b.ms)}${b.result ? ' · ' + b.result : ''}</title></rect>`;
    })
    .join('');

  return `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

function tile(product, env, data) {
  if (!data) {
    return `<article class="tile no-pipeline">
      <div class="tile-top"><span class="env-name">${escapeHtml(env.name)}</span></div>
      <div class="duration none">No pipeline</div>
    </article>`;
  }

  if (data.status === 'SCHEDULED' && data.error) {
    return `<article class="tile scheduled" data-status="SCHEDULED">
      <div class="tile-top">
        <span class="env-name">${escapeHtml(env.name)}</span>
        <span class="chip" data-status="SCHEDULED">Scheduled</span>
      </div>
      <div class="duration none">—</div>
      <div class="tile-note">${escapeHtml(data.error)}</div>
    </article>`;
  }

  const status = data.status || 'UNKNOWN';
  const running = data.building;
  const d = formatDuration(data.durationMs);

  const label = running ? 'Running' : status === 'UNKNOWN' ? 'No data' : status;

  const durationBlock = d
    ? `<div class="build-time-group">
         <span class="meta-label">Build time</span>
         <div class="duration" data-started="${running ? data.startedAt : ''}">
           ${d.value}<span class="unit">${d.unit}</span>
         </div>
       </div>`
    : `<div class="build-time-group"><span class="meta-label">Build time</span><div class="duration none">—</div></div>`;

  const typical = data.typicalMs
    ? `<div class="typical">${running ? 'typically ' : 'usually '}${shortDuration(data.typicalMs)}</div>`
    : '';

  const progress = running
    ? `<div class="progress ${data.progressPct == null ? 'unknown' : ''}">
         <span style="width:${data.progressPct ?? 0}%"></span>
       </div>`
    : '';

  const tests =
    data.testsFailed > 0
      ? `<span title="Failing tests">${data.testsFailed}/${data.testsTotal} tests failed</span>`
      : '';

  // Keep the last cached database value visible and suppress transient Jenkins timeout
  // details so the UI reflects the persisted build state instead of a transient error.
  const note = '';
  const seen = lastSeenDisplay(data.startedAt);
  const lastSeenMarkup = data.jobUrl
    ? `<a class="last-run" href="${escapeHtml(data.jobUrl)}" target="_blank" rel="noopener">
         <span class="last-run-date">${escapeHtml(seen.date)}</span>
         <span class="last-run-time">${escapeHtml(seen.time)}</span>
         <span class="last-run-ago">${escapeHtml(seen.ago)}</span>
       </a>`
    : `<span class="last-run">
         <span class="last-run-date">${escapeHtml(seen.date)}</span>
         <span class="last-run-time">${escapeHtml(seen.time)}</span>
         <span class="last-run-ago">${escapeHtml(seen.ago)}</span>
       </span>`;

  return `<article class="tile ${data.stale ? 'stale' : ''}" data-status="${status}">
    <div class="tile-top">
      <span class="env-name">${escapeHtml(env.name)}</span>
      <div class="tile-header-meta">
        <span class="build-no top-build-number">${data.buildNumber ? '#' + data.buildNumber : '—'}</span>
        <span class="chip" data-status="${status}">${escapeHtml(label)}</span>
      </div>
    </div>
    ${durationBlock}
    ${typical}
    ${progress}
    ${sparkline(data.trend)}
    <div class="tile-meta last-build-row">
      <span class="meta-label">Last Build</span>
      ${lastSeenMarkup}
    </div>
    <div class="tile-foot">
      ${tests}
    </div>
    ${note}
  </article>`;
}

function renderBoard(product) {
  const { groups } = snapshot.layout;

  return groups
    .map((group) => {
      const tiles = group.envs
        .map((env) => tile(product, env, snapshot.pipelines[`${product}:${env.id}`]))
        .join('');
      return `<section class="stream">
        <div class="stream-head">
          <span class="stream-name">${escapeHtml(group.name)}</span>
          <span class="stream-note">${escapeHtml(group.label)}</span>
        </div>
        <div class="grid">${tiles}</div>
      </section>`;
    })
    .join('');
}

function responseTimeClass(ms) {
  if (ms == null) return '';
  if (ms < 200) return 'fast';
  if (ms < 1000) return 'medium';
  return 'slow';
}

function renderServers() {
  if (!snapshot.servers.length) {
    return `<div class="empty">No health checks recorded yet.</div>`;
  }

  const rows = snapshot.servers
    .map((s) => {
      const state = s.status === 'up' ? 'up' : s.status === 'down' ? 'down' : 'checking';
      const label = state === 'up' ? 'Online' : state === 'down' ? 'Offline' : 'Checking';
      return `<div class="server-row">
        <div>
          <div class="server-name"><span class="dot ${state}"></span>${escapeHtml(s.name)}</div>
          <div class="server-url">${escapeHtml(s.url)}</div>
        </div>
        <div class="server-meta">
          <span>${label}</span>
          <span class="rt ${responseTimeClass(s.responseTimeMs)}">${
            s.responseTimeMs != null ? s.responseTimeMs + 'ms' : '—'
          }</span>
          <span>${s.httpCode ?? escapeHtml(s.message || '')}</span>
          <span>${relativeTime(s.checkedAt)}</span>
        </div>
      </div>`;
    })
    .join('');

  return `<div class="servers">${rows}</div>`;
}

/* ---------- shell ---------- */

function renderTabs() {
  const tabs = [...snapshot.layout.products, { id: 'servers', name: 'Servers' }];
  document.getElementById('tabs').innerHTML = tabs
    .map(
      (t) => `<button class="tab" role="tab" data-tab="${t.id}"
        aria-selected="${t.id === activeTab}">${escapeHtml(t.name)}</button>`
    )
    .join('');
}

function renderTally() {
  const c = snapshot.counts;
  document.getElementById('tally').innerHTML = `
    <span><b>${c.running}</b> running</span>
    <span><b>${c.failed}</b> failing</span>
    <span><b>${c.total}</b> pipelines</span>
    ${c.unreachable ? `<span><b>${c.unreachable}</b> unreachable</span>` : ''}`;
}

function renderCollectorState() {
  const { collector } = snapshot;
  const pulse = document.getElementById('collectorPulse');
  const text = document.getElementById('collectorText');

  pulse.className = 'pulse ' + (collector.healthy ? 'live' : 'broken');
  text.textContent = collector.healthy
    ? `Polled ${relativeTime(collector.lastSuccessAt)}`
    : `Collector stalled — last success ${relativeTime(collector.lastSuccessAt)}`;

  document.getElementById('footerText').textContent =
    `${collector.okCount} pipelines read, ${collector.failCount} failed · ` +
    `data from local cache, refreshed every minute`;
}

function render() {
  if (!snapshot) return;
  renderTabs();
  renderTally();
  renderCollectorState();
  document.getElementById('main').innerHTML =
    activeTab === 'servers' ? renderServers() : renderBoard(activeTab);
}

/* ---------- live elapsed counter ----------
   Running builds tick up between polls so the board feels current without
   hammering the API. Only the number and bar move; nothing is re-fetched. */

function tick() {
  document.querySelectorAll('.duration[data-started]').forEach((el) => {
    const started = Number(el.dataset.started);
    if (!started) return;
    const d = formatDuration(Date.now() - started);
    if (d) el.innerHTML = `${d.value}<span class="unit">${d.unit}</span>`;
  });
}

/* ---------- data ---------- */

async function load({ force = false } = {}) {
  const spin = document.getElementById('refreshSpin');
  if (force) spin.classList.add('on');

  try {
    if (force) await fetch('/api/refresh', { method: 'POST' });
    const res = await fetch(API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snapshot = await res.json();
    render();
  } catch (err) {
    document.getElementById('collectorPulse').className = 'pulse broken';
    document.getElementById('collectorText').textContent = 'Cannot reach dashboard service';
    if (!snapshot) {
      document.getElementById('main').innerHTML =
        `<div class="empty">Cannot reach the dashboard service on this machine.<br>
         Start it with <code>npm start</code>, then reload.</div>`;
    }
  } finally {
    spin.classList.remove('on');
  }
}

/* ---------- wiring ---------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  render();
});

document.getElementById('refreshBtn').addEventListener('click', () => load({ force: true }));

document.getElementById('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.getElementById('themeGlyph').textContent = next === 'dark' ? '◑' : '◐';
  try { localStorage.setItem('board-theme', next); } catch {}
});

(function boot() {
  try {
    const saved = localStorage.getItem('board-theme');
    if (saved) {
      document.documentElement.dataset.theme = saved;
      document.getElementById('themeGlyph').textContent = saved === 'dark' ? '◑' : '◐';
    }
  } catch {}

  load();
  setInterval(load, POLL_MS);
  tickTimer = setInterval(tick, 1000);
})();
