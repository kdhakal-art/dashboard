'use strict';

/**
 * Dashboard layout and pipeline map.
 *
 * This used to live in a browser-loaded config.js alongside the API tokens.
 * It now stays on the server: the browser receives rendered status only, and
 * never sees a Jenkins URL or credential.
 *
 * Credentials come from environment variables (see .env.example).
 */

const PRODUCTS = [
  { id: 'aspen', name: 'Aspen' },
  { id: 'aspen-plus', name: 'Aspen+' },
];

const ENV_GROUPS = [
  {
    name: 'Stream 1',
    label: 'Available for code check-ins',
    envs: [
      { id: 'dev01', name: 'DEV01' },
      { id: 'test01', name: 'TEST01' },
      { id: 'tt01', name: 'TT01' },
    ],
  },
  {
    name: 'Stream 2',
    label: 'Production builds only',
    envs: [
      { id: 'dev02', name: 'DEV02' },
      { id: 'test02', name: 'TEST02' },
      { id: 'tt02', name: 'TT02' },
      { id: 'reg', name: 'REG' },
      { id: 'perf', name: 'PERF' },
      { id: 'training-dev', name: 'TRAINING-DEV' },
    ],
  },
  {
    name: 'Stream 3',
    label: 'Available for code check-ins',
    envs: [
      { id: 'dev03', name: 'DEV03' },
      { id: 'test03', name: 'TEST03' },
      { id: 'tt03', name: 'TT03' },
      { id: 'sit', name: 'SIT' },
    ],
  },
  {
    name: 'Stream 4',
    label: 'Available for code check-ins',
    envs: [
      { id: 'dev04', name: 'DEV04' },
      { id: 'test04', name: 'TEST04' },
      { id: 'tt04', name: 'TT04' },
    ],
  },
];

const ASPEN = 'https://172.20.54.219:8443';
const PLUS = 'http://172.20.252.53:8080';

const AUTO_TRIGGER_MESSAGE = 'Build will trigger automatically once code is checked-ins';
const AUTO_TRIGGER_PIPELINES = {
  'aspen-plus': {
    dev01: { message: AUTO_TRIGGER_MESSAGE },
    dev02: { message: AUTO_TRIGGER_MESSAGE },
    dev03: { message: AUTO_TRIGGER_MESSAGE },
    dev04: { message: AUTO_TRIGGER_MESSAGE },
  },
};

/**
 * Pipeline job URLs. Two forms:
 *
 *   'url'                 → single job; duration is the build's own duration.
 *   ['urlA', 'urlB']      → paired job; duration is the gap between the two
 *                           builds' start times.
 *
 * The paired form is how Aspen deploys work: the Multijob kicks things off and
 * the Maintenance_Page_Off job closes them out, so the real deployment window
 * is the span between them, not either job's individual duration. This
 * preserves the behaviour of the old dashboard's colon-separated URLs, without
 * the fragile string splitting on ':'.
 */
const PIPELINES = {
  aspen: {
    dev01: [`${ASPEN}/view/DEV01-Pipeline/job/DEV01-Multijob`, `${ASPEN}/view/DEV01-Pipeline/job/Maintenance_Page_Off_DEV01`],
    test01: [`${ASPEN}/view/TEST01-Pipeline/job/TEST01-Multijob`, `${ASPEN}/view/TEST01-Pipeline/job/Maintenance_Page_Off_TEST01`],
    tt01: [`${ASPEN}/view/TT01-Pipeline/job/TT01-Multijob`, `${ASPEN}/view/TT01-Pipeline/job/Maintenance_Page_Off_TT01`],

    dev02: [`${ASPEN}/view/DEV02-Pipeline/job/DEV02-Multijob`, `${ASPEN}/view/DEV02-Pipeline/job/Maintenance_Page_Off_DEV02`],
    test02: [`${ASPEN}/view/TEST02-Pipeline/job/TEST02-Multijob`, `${ASPEN}/view/TEST02-Pipeline/job/Maintenance_Page_Off_TEST02`],
    tt02: [`${ASPEN}/view/TT02-Pipeline/job/TT02-Multijob`, `${ASPEN}/view/TT02-Pipeline/job/Maintenance_Page_Off_TT02`],
    reg: [`${ASPEN}/view/REG-Pipeline/job/REG-Multijob`, `${ASPEN}/view/REG-Pipeline/job/Maintenance_Page_Off_REG`],
    perf: [`${ASPEN}/view/PRF-Pipeline/job/PERF-Multijob`, `${ASPEN}/view/PRF-Pipeline/job/Maintenance_Page_Off_PRF`],
    'training-dev': [`${ASPEN}/view/TDV-Pipeline/job/TDV-Multijob`, `${ASPEN}/view/TDV-Pipeline/job/Maintenance_Page_Off_TDV`],

    dev03: [`${ASPEN}/view/DEV03-Pipeline/job/DEV03-Multijob`, `${ASPEN}/view/DEV03-Pipeline/job/Maintenance_Page_Off_DEV03`],
    test03: [`${ASPEN}/view/TEST03-Pipeline/job/TEST03-Multijob`, `${ASPEN}/view/TEST03-Pipeline/job/Maintenance_Page_Off_TEST03`],
    tt03: [`${ASPEN}/view/TT03-Pipeline/job/TT03-Multijob`, `${ASPEN}/view/TT03-Pipeline/job/Maintenance_Page_Off_TT03`],
    sit: `${ASPEN}/view/SIT-Pipeline/job/SIT-Pipeline`,

    dev04: [`${ASPEN}/view/DEV04-Pipeline/job/DEV04-Multijob`, `${ASPEN}/view/DEV04-Pipeline/job/Maintenance_Page_Off_DEV04`],
    test04: `${ASPEN}/view/TEST04-Pipeline/job/TEST04-Pipeline`,
    tt04: `${ASPEN}/view/TEST04-Pipeline/job/TT04-Pipeline`,
  },

  'aspen-plus': {
    dev01: { autoTrigger: true, message: AUTO_TRIGGER_MESSAGE },
    test01: `${PLUS}/view/test1_build_deploy/job/test1-MASTER-MERGE-BUILD-DEPLOY-PIPELINE`,
    tt01: `${PLUS}/view/tt1_build_deploy/job/tt1-MASTER-BUILD-DEPLOY-PIPELINE`,

    dev02: { autoTrigger: true, message: AUTO_TRIGGER_MESSAGE },
    test02: `${PLUS}/view/test2_build_deploy/job/test2-MASTER-MERGE-BUILD-DEPLOY-PIPELINE`,
    tt02: `${PLUS}/view/tt2_build_deploy/job/tt2-MASTER-BUILD-DEPLOY-PIPELINE`,
    reg: `${PLUS}/view/reg_build_deploy/job/reg-MASTER-MERGE-BUILD-DEPLOY-PIPELINE`,
    perf: `${PLUS}/view/perf_build_deploy/job/perf-MASTER-BUILD-DEPLOY-PIPELINE`,
    'training-dev': `${PLUS}/view/tt4_build_deploy/job/tt4-MASTER-BUILD-DEPLOY-PIPELINE`,

    dev03: { autoTrigger: true, message: AUTO_TRIGGER_MESSAGE },
    test03: `${PLUS}/view/test3_build_deploy/job/test3-MASTER-MERGE-BUILD-DEPLOY-PIPELINE`,
    tt03: `${PLUS}/view/tt3_build_deploy/job/tt3-MASTER-BUILD-DEPLOY-PIPELINE`,
    sit: `${PLUS}/view/sit_build_deploy/job/sit-MASTER-BUILD-DEPLOY-PIPELINE`,

    dev04: { autoTrigger: true, message: AUTO_TRIGGER_MESSAGE },
    test04: `${PLUS}/view/test4_build_deploy/job/test4-MASTER-MERGE-BUILD-DEPLOY-PIPELINE`,
    tt04: `${PLUS}/view/tt4_build_deploy/job/tt4-MASTER-BUILD-DEPLOY-PIPELINE`,
  },
};

/** Servers to health-check on the Status tab. */
const MONITORED_SERVERS = [
  { id: 'aspen', name: 'Aspen Jenkins', url: `${ASPEN}/` },
  { id: 'aspen-plus', name: 'Aspen+ Jenkins', url: `${PLUS}/` },
  { id: 'sonarqube', name: 'SonarQube', url: 'http://172.20.54.183:9000/' },
];

/** Flatten into the list the collector iterates over. */
function allPipelines() {
  const out = [];
  for (const product of PRODUCTS) {
    for (const group of ENV_GROUPS) {
      for (const env of group.envs) {
        const entry = PIPELINES[product.id]?.[env.id];
        if (!entry || (entry && typeof entry === 'object' && entry.autoTrigger)) continue;
        const urls = Array.isArray(entry) ? entry : [entry];
        out.push({ product: product.id, env: env.id, urls, paired: urls.length === 2 });
      }
    }
  }
  return out;
}

function placeholderPipeline(product, env) {
  const entry = AUTO_TRIGGER_PIPELINES[product]?.[env];
  if (!entry) return null;

  return {
    product,
    env,
    jobUrl: null,
    buildNumber: null,
    startedAt: null,
    durationMs: null,
    status: 'SCHEDULED',
    building: false,
    progressPct: null,
    typicalMs: null,
    testsTotal: null,
    testsFailed: 0,
    cause: null,
    error: entry.message,
    fetchedAt: Date.now(),
    stale: false,
    trend: [],
  };
}

module.exports = {
  PRODUCTS,
  ENV_GROUPS,
  PIPELINES,
  MONITORED_SERVERS,
  AUTO_TRIGGER_PIPELINES,
  allPipelines,
  placeholderPipeline,
};
