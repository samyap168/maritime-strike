import { loadChromium, LAUNCH, BASE } from './playwright.mjs';
const chromium = await loadChromium();
import { mkdirSync } from 'node:fs';
const SP = process.env.SP || 'test-output';
mkdirSync(SP, { recursive: true });
const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack||e.message)));
page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE: '+m.text()); });

await page.goto(BASE + '/?range=1', { waitUntil: 'load' });
await page.waitForTimeout(5000);
// The tutorial only appears in the lobby now, so range mode has none.
await page.evaluate(() => window.__game.hud.hideTutorial());
await page.waitForTimeout(500);

// Park a hulk directly in front of us at point blank so aiming is not the variable.
await page.evaluate(() => {
  const g = window.__game, sim = g.sim;
  const me = sim.players.HOST;
  const t = sim.players.TGT0;
  t.x = me.x + Math.sin(me.h) * 45;
  t.z = me.z + Math.cos(me.h) * 45;
  t.hp = 100;
});
await page.waitForTimeout(300);

// Aim by projecting the target's world position to screen — no guessing.
const aim = await page.evaluate(() => {
  const g = window.__game, t = g.sim.players.TGT0;
  const v = new (window.__THREE_V || Object).constructor;
  const p = g.hud.toScreen(t.x, 2, t.z);
  return p;
});
console.log('aim screen point', aim);
if (aim) await page.mouse.move(aim.x, aim.y);
await page.waitForTimeout(200);

const results = {};
async function volley(label, ms) {
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(500);
  results[label] = await page.evaluate(() => {
    const g = window.__game;
    return { targetHp: g.sim.players.TGT0.hp, myVessel: g.sim.players.HOST.v, inFlight: g.sim.projectiles.length };
  });
}

await volley('rifle', 2500);
await page.screenshot({ path: SP + '/c1-rifle.png' });

// Now test each upgrade path by granting the vessel directly, the same way a
// pickup would, then firing again.
for (const vessel of ['patrol','destroyer','submarine','minelayer']) {
  await page.evaluate((v) => {
    const g = window.__game;
    g.sim.players.HOST.v = v;
    g.sim.players.HOST.cd = 0; g.sim.players.HOST.heat = 0; g.sim.players.HOST.lockedUntil = 0;
    g.sim.players.TGT0.hp = 100;
    g.sim.players.TGT0.a = true;
  }, vessel);
  await page.waitForTimeout(400);
  const a2 = await page.evaluate(() => { const g=window.__game,t=g.sim.players.TGT0; return g.hud.toScreen(t.x,2,t.z); });
  if (a2) await page.mouse.move(a2.x, a2.y);
  await volley(vessel, 3200);
}
await page.screenshot({ path: SP + '/c2-destroyer.png' });

const mines = await page.evaluate(() => window.__game.sim.mines.length);
console.log('RESULTS', JSON.stringify(results, null, 2));
console.log('mines laid:', mines);
console.log('ERRORS(' + errors.length + ')'); errors.slice(0,10).forEach(e=>console.log('  '+e.slice(0,300)));
await browser.close();
