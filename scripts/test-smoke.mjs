import { loadChromium, LAUNCH, BASE } from './playwright.mjs';
const chromium = await loadChromium();

const URL = process.argv[2] || BASE + '/?range=1';
const OUT = process.argv[3] || 'shot.png';
const WAIT = Number(process.argv[4] || 6000);

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

const errors = [], logs = [];
page.on('console', (m) => { const t = `${m.type()}: ${m.text()}`; logs.push(t); if (m.type() === 'error') errors.push(t); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
page.on('requestfailed', (r) => errors.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(WAIT);

const diag = await page.evaluate(() => {
  const c = document.getElementById('c');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return {
    canvas: c ? `${c.width}x${c.height}` : 'missing',
    webgl: !!gl,
    visibleScreen: [...document.querySelectorAll('.screen')].filter(e => !e.classList.contains('hidden')).map(e => e.id),
    hudVisible: !document.getElementById('hud').classList.contains('hidden'),
    hp: document.querySelector('#self-hp b')?.textContent,
    vessel: document.getElementById('self-vessel')?.textContent,
    weapon: document.getElementById('weapon-name')?.textContent,
    timer: document.getElementById('timer-val')?.textContent,
    zone: document.getElementById('zone')?.textContent,
  };
});

await page.screenshot({ path: OUT });
console.log('DIAG', JSON.stringify(diag, null, 2));
console.log('ERRORS(' + errors.length + '):');
errors.slice(0, 25).forEach(e => console.log('  ' + e.slice(0, 400)));
await browser.close();
process.exit(errors.length ? 1 : 0);
