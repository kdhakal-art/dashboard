'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSmokeDashboard, normalizeStatus, buildSmokeScenarioRows } = require('../server/smoke');

test('normalizes dynamic Jenkins status values', () => {
  assert.equal(normalizeStatus('Passed'), 'PASS');
  assert.equal(normalizeStatus('Failed'), 'FAIL');
  assert.equal(normalizeStatus('Pending'), 'PENDING');
  assert.equal(normalizeStatus('Skipped'), 'SKIPPED');
});

test('discovers every script from the report table without hard-coded names', () => {
  const html = `
    <h1>Automation Dashboard</h1>
    <table><tr><th>Script</th><th>Runs</th><th>Passed</th></tr>
      <tr><td><strong>Test_case_1</strong></td><td>32</td><td><span class="badge passed">Passed</span></td><td>2026-09-30</td></tr>
      <tr><td><strong>Test_case_2</strong></td><td>4</td><td><span class="badge failed">Failed</span></td><td>2026-10-01</td></tr>
    </table>
    <script>const latestData = {passed: 1, failed: 1, never_run: 0};</script>
  `;

  const report = parseSmokeDashboard(html);
  assert.deepEqual(report.tests.map((testCase) => testCase.testCase), ['Test_case_1', 'Test_case_2']);
  assert.deepEqual(report.tests.map((testCase) => testCase.status), ['PASS', 'FAIL']);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
});

test('preserves the Jenkins report href for each dynamically discovered scenario', () => {
  const html = `
    <table><tr><th>Script</th><th>Runs</th><th>Passed</th><th>Last Status</th><th>Report</th></tr>
      <tr><td>Test_case_1</td><td>32</td><td>Passed</td><td>2026-09-30</td><td><a href="../workbooks/001_Test_case_1_steps/report">Open last report</a></td></tr>
    </table>`;

  const report = parseSmokeDashboard(html, 'https://jenkins.example/job/Smoke_Test_Automation/168/Smoke_20Test_20Report/dashboard/index.html');
  assert.equal(report.tests[0].reportUrl, 'https://jenkins.example/job/Smoke_Test_Automation/168/Smoke_20Test_20Report/workbooks/001_Test_case_1_steps/report');
});

test('reads Last Status instead of the numeric Passed or Failed columns', () => {
  const html = `
    <table>
      <tr><th>Script</th><th>Runs</th><th>Passed</th><th>Failed</th><th>Last Status</th><th>Last Executed</th><th>Report</th></tr>
      <tr><td>Test_case_1</td><td>32</td><td>30</td><td>2</td><td><span class="badge passed">Passed</span></td><td>2026-09-30</td><td><a href="../report">Open</a></td></tr>
      <tr><td>Test_case_5</td><td>28</td><td>18</td><td>10</td><td><span class="badge failed">Failed</span></td><td>2026-10-01</td><td><a href="../report">Open</a></td></tr>
    </table>`;

  const report = parseSmokeDashboard(html, 'https://jenkins.example/dashboard/index.html');
  assert.deepEqual(report.tests.map((testCase) => testCase.status), ['PASS', 'FAIL']);
});

test('builds one database row per environment, build, and scenario', () => {
  const report = {
    env: 'DEV01',
    buildNumber: 168,
    tests: [
      { testCase: 'Test_case_1', status: 'PASS', runs: 32, lastRunAt: '2026-10-01', reportUrl: 'https://jenkins.example/report/1' },
      { testCase: 'Test_case_5', status: 'FAIL', runs: 28, lastRunAt: '2026-10-01', reportUrl: 'https://jenkins.example/report/5' },
    ],
  };

  const rows = buildSmokeScenarioRows(report);
  assert.deepEqual(rows.map((row) => ({
    environmentName: row.environmentName,
    buildNumber: row.buildNumber,
    testCase: row.testCase,
    status: row.status,
  })), [
    { environmentName: 'DEV01', buildNumber: 168, testCase: 'Test_case_1', status: 'PASS' },
    { environmentName: 'DEV01', buildNumber: 168, testCase: 'Test_case_5', status: 'FAIL' },
  ]);
});

test('ignores non-report tables and missing rows', () => {
  const html = '<table><tr><td>not a test</td></tr></table>';
  assert.deepEqual(parseSmokeDashboard(html).tests, []);
});
