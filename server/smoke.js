'use strict';

const STATUS_ALIASES = {
  passed: 'PASS',
  success: 'PASS',
  successful: 'PASS',
  ok: 'PASS',
  failed: 'FAIL',
  failure: 'FAIL',
  error: 'FAIL',
  aborted: 'FAIL',
  pending: 'PENDING',
  running: 'PENDING',
  skipped: 'SKIPPED',
  never: 'NEVER_RUN',
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .trim();
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '));
}

function textCell(cell) {
  return stripTags(cell).replace(/\s+/g, ' ');
}

function extractTableDetails(html) {
  const tables = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tablePattern.exec(html))) {
    const tableHtml = tableMatch[1];
    const headerMatch = tableHtml.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    const headerCells = headerMatch
      ? (headerMatch[1].match(/<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi) || []).map((cell) => textCell(cell))
      : [];
    const header = headerCells.map((cell) => cell.toLowerCase());
    if (!header.some((cell) => cell === 'script')) continue;

    const rows = [];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(tableHtml))) {
      const cells = rowMatch[1].match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
      if (cells.length) {
        const firstCell = textCell(cells[0]);
        if (firstCell.toLowerCase() !== 'script') rows.push(cells.map((cell) => textCell(cell)));
      }
    }
    tables.push({ headers: headerCells, rows });
  }
  return tables;
}

function extractTableRows(html) {
  return extractTableDetails(html).flatMap((table) => table.rows);
}

function buildSmokeScenarioRows(report) {
  return (report.tests || []).map((testCase) => ({
    environmentName: report.env,
    buildNumber: report.buildNumber,
    testCase: testCase.testCase,
    status: testCase.status,
    runs: Number(testCase.runs) || 0,
    lastRunAt: testCase.lastRunAt,
    reportUrl: testCase.reportUrl,
    fetchedAt: Date.now(),
  }));
}

function normalizeStatus(value, className = '') {
  const source = `${value} ${className}`.toLowerCase();
  const direct = STATUS_ALIASES[source] || STATUS_ALIASES[source.trim()];
  if (direct) return direct;
  if (/passed|success|ok/.test(source)) return 'PASS';
  if (/failed|failure|error|aborted/.test(source)) return 'FAIL';
  if (/pending|running/.test(source)) return 'PENDING';
  if (/skipped/.test(source)) return 'SKIPPED';
  return 'UNKNOWN';
}

function parseJavaScriptObject(source) {
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    const factory = new Function(`return (${source});`);
    return factory();
  }
}

function extractReportLinks(html) {
  const links = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tablePattern.exec(html))) {
    const tableHtml = tableMatch[1];
    const headerMatch = tableHtml.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    const header = headerMatch ? textCell(headerMatch[1]).toLowerCase() : '';
    if (!header.includes('script')) continue;

    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(tableHtml))) {
      const cells = rowMatch[1].match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
      if (!cells.length) continue;
      const firstCell = textCell(cells[0]);
      if (firstCell.toLowerCase() === 'script') continue;
      const linkMatch = rowMatch[1].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
      links.push(linkMatch ? linkMatch[1] : null);
    }
  }
  return links;
}

function parseSmokeDashboard(html, baseUrl = '') {
  const latestDataMatch = html.match(/const\s+latestData\s*=\s*(\{[\s\S]*?\});/i);
  const latestData = latestDataMatch ? parseJavaScriptObject(latestDataMatch[1]) : {};
  const historyDataMatch = html.match(/const\s+historyData\s*=\s*(\{[\s\S]*?\});/i);
  const historyData = historyDataMatch ? parseJavaScriptObject(historyDataMatch[1]) : {};
  const reportLinks = extractReportLinks(html);

  const tests = [];
  for (const table of extractTableDetails(html)) {
    const statusColumn = table.headers.findIndex((header) => header.toLowerCase() === 'last status');
    const statusIndex = statusColumn >= 0 ? statusColumn : 2;
    for (const [rowIndex, cells] of table.rows.entries()) {
      if (cells.length <= statusIndex) continue;
      const script = cells[0].replace(/\s+/g, ' ').trim();
      if (!script) continue;
      const status = normalizeStatus(cells[statusIndex]);
      const reportUrl = reportLinks[tests.length + rowIndex] || null;
      const lastRunAt = cells[statusIndex + 1] || null;
      tests.push({
        testCase: script,
        status,
        runs: Number(cells[1]) || 0,
        lastRunAt,
        reportUrl: reportUrl && new URL(reportUrl, baseUrl).toString(),
        order: tests.length,
      });
    }
  }

  return {
    generatedAt: null,
    totalScripts: Number(latestData.total ?? latestData.passed + latestData.failed + latestData.never_run) || tests.length,
    passed: Number(latestData.passed) || 0,
    failed: Number(latestData.failed) || 0,
    pending: Number(latestData.never_run) || 0,
    historyPassed: Number(historyData.passed) || 0,
    historyFailed: Number(historyData.failed) || 0,
    tests,
  };
}

module.exports = { parseSmokeDashboard, normalizeStatus, extractTableRows, buildSmokeScenarioRows };
