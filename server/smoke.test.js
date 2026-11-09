'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSmokeDashboard, normalizeStatus } = require('./smoke');

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
      <tr><td><strong>Another_Scenario</strong></td><td>4</td><td><span class="badge failed">Failed</span></td><td>2026-10-01</td></tr>
    </table>
    <script>const latestData = {passed: 1, failed: 1, never_run: 0};</script>
  `;

  const report = parseSmokeDashboard(html);
  assert.deepEqual(report.tests.map((testCase) => testCase.testCase), ['Test_case_1', 'Another_Scenario']);
  assert.deepEqual(report.tests.map((testCase) => testCase.status), ['PASS', 'FAIL']);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
});

test('ignores non-report tables and missing rows', () => {
  const html = '<table><tr><td>not a test</td></tr></table>';
  assert.deepEqual(parseSmokeDashboard(html).tests, []);
});
