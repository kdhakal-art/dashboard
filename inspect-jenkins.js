require('dotenv').config();
const https = require('https');

const auth = 'Basic ' + Buffer.from(process.env.ASPEN_AUTH).toString('base64');
const urls = [
  'https://172.20.54.219:8443/job/Smoke_Test_Automation/',
  'https://172.20.54.219:8443/job/Smoke_Test_Automation/168/Smoke_20Test_20Report/',
  'https://172.20.54.219:8443/job/Smoke_Test_Automation/168/Smoke_20Test_20Report/dashboard/index.html',
];

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      rejectUnauthorized: false,
      headers: { Authorization: auth, 'User-Agent': 'dashboard-smoke-inspect' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Timed out')));
    req.end();
  });
}

(async () => {
  for (const url of urls) {
    const result = await request(url);
    console.log(`=== ${url} ===`);
    console.log(`status=${result.status} type=${result.type} bytes=${result.body.length}`);
    console.log(result.body.slice(0, 12000));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
