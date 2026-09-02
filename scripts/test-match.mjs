import { loadChromium, LAUNCH, BASE } from './playwright.mjs';
const chromium = await loadChromium();
import { mkdirSync } from 'node:fs';
const SP = process.env.SP || 'test-output';
mkdirSync(SP, { recursive: true });
const browser = await chromium.launch(LAUNCH);
const errors = [], results = {};
const ok = (k, v) => { results[k] = v; console.log((v ? 'PASS  ' : 'FAIL  ') + k + (typeof v !== 'boolean' ? ' -> ' + JSON.stringify(v) : '')); };

async function newPage(tag) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', e => errors.push(`[${tag}] ` + (e.stack||e.message)));
  p.on('console', m => { if (m.type()==='error') errors.push(`[${tag}] ` + m.text()); });
  return p;
}
const host = await newPage('host'), c1 = await newPage('c1');

/**
 * Wait until a world point's screen projection stops moving, then return it.
 *
 * The chase camera eases toward its target, so straight after anything is
 * teleported the projection is still mid-flight. Under software rendering that
 * ease takes seconds, and a fixed sleep silently yielded an aim point out over
 * open water: the shots missed and the failure looked like a game bug rather
 * than a fragile test.
 */
/**
 * Poll a page until a predicate holds.
 *
 * Fixed sleeps are the wrong tool here: startup cost drifts as the renderer
 * gains work, and a sleep that was generous last month silently becomes a race.
 * Every failure it produces looks like a game bug, which wastes far more time
 * than polling costs.
 */
async function waitUntil(page, exprSrc, timeoutMs = 30000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await page.evaluate((src) => {
      try { return !!new Function('g', src)(window.__game); } catch { return false; }
    }, exprSrc);
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(250);
  }
  console.log(`  (timed out waiting for ${label})`);
  return false;
}

async function settledAim(page, bodySrc) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate((src) => {
      const g = window.__game;
      // eslint-disable-next-line no-new-func
      const w = new Function('g', src)(g);
      return w ? g.hud.toScreen(w.x, 2, w.z) : null;
    }, bodySrc);
    if (s && last && Math.abs(s.x - last.x) < 2 && Math.abs(s.y - last.y) < 2) return s;
    last = s;
    await page.waitForTimeout(250);
  }
  return last;
}

await host.goto(BASE + '/?net=ws', { waitUntil: 'load' });
await host.waitForTimeout(3500);
await host.click('#btn-create');
await host.waitForSelector('#screen-lobby:not(.hidden)');
await host.evaluate(() => window.__game.hud.hideTutorial());
const code = (await host.textContent('#lobby-code')).trim();

await c1.goto(BASE + '/?net=ws&host=localhost', { waitUntil: 'load' });
await c1.waitForTimeout(3500);
await c1.click('#btn-join-screen');
await c1.fill('#in-code', code); await c1.fill('#in-name', 'TESTER');
await c1.click('#btn-join');
await c1.waitForSelector('#screen-lobby:not(.hidden)');
await c1.evaluate(() => window.__game.hud.hideTutorial());
await host.waitForTimeout(1000);

// Nickname editing round-trips to the host and back out to everyone.
await c1.fill('#in-nick', 'RENAMED'); await c1.press('#in-nick', 'Enter');
await c1.evaluate(() => document.getElementById('in-nick').dispatchEvent(new Event('change')));
await host.waitForTimeout(1200);
ok('nickname edit propagates to host',
   await host.evaluate(() => Object.values(window.__game.sim.players).some(p => p.name === 'RENAMED')));

const teams = await host.evaluate(() => Object.values(window.__game.sim.players).map(p=>p.team));
if (teams[0] === teams[1]) { await c1.click('#btn-switch'); await host.waitForTimeout(600); }
ok('teams are split', await host.evaluate(() => { const t = Object.values(window.__game.sim.players).map(p=>p.team); return t[0] !== t[1]; }));

ok('host blocked while players are not ready', await host.evaluate(() => !!window.__game.sim.startBlocker()));
await c1.click('#btn-ready'); await host.click('#btn-ready');
await host.waitForTimeout(1000);
ok('host can start once everyone is ready', await host.evaluate(() => window.__game.sim.startBlocker() === null));

await host.click('#btn-start');
const hostInMatch = await waitUntil(host, "return g.phase === 'match'", 30000, 'host match');
const clientInMatch = await waitUntil(c1, "return g.phase === 'match'", 30000, 'client match');
ok('both reached the match', hostInMatch && clientInMatch);

// Pickup: drop the host onto a crate and confirm the vessel transforms.
await host.bringToFront();
await host.evaluate(() => {
  const g = window.__game, me = g.sim.players[g.localId];
  const pu = g.sim.pickups.find(p => p.active && p.kind === 'missile');
  me.x = pu.x; me.z = pu.z;
});
await waitUntil(host, "return g.sim.players[g.localId].v === 'destroyer'", 15000, 'host pickup');
ok('pickup transforms the vessel', await host.evaluate(() => window.__game.sim.players[window.__game.localId].v));
// The client learns about it over the network, so poll rather than assume.
ok('client sees the new vessel too',
   await waitUntil(c1, "return Object.values(g.lastView.players).some(p => p.v === 'destroyer')", 15000, 'client vessel'));

// Friendly fire must do nothing.
const ffHp = await host.evaluate(async () => {
  const g = window.__game, sim = g.sim, me = sim.players[g.localId];
  const mate = sim.addPlayer('MATE', 'MATE'); mate.team = me.team; mate.a = true; mate.hp = 100;
  mate.x = me.x + Math.sin(me.h) * 40; mate.z = me.z + Math.cos(me.h) * 40;
  for (let i = 0; i < 40; i++) sim.step(1/30);
  return mate.hp;
});
ok('friendly fire deals no damage', ffHp === 100);
await host.evaluate(() => { delete window.__game.sim.players.MATE; });

// Keep a third hull afloat on the victim's team, so their death does NOT end
// the match — otherwise the result screen correctly replaces the sunk overlay
// before it can be observed.
await host.evaluate(() => {
  const g = window.__game, sim = g.sim, me = sim.players[g.localId];
  const survivor = sim.addPlayer('SURV', 'SURVIVOR');
  survivor.team = me.team === 'red' ? 'blue' : 'red';
  survivor.a = true; survivor.hp = 100;
  survivor.x = me.x + 400; survivor.z = me.z + 400;
});
await host.waitForTimeout(600);

// Fight to a kill.
await host.evaluate(() => {
  const g = window.__game, me = g.sim.players[g.localId];
  const foe = Object.values(g.sim.players).find(p => p.team !== me.team);
  const foes = Object.values(g.sim.players).filter(p => p.team !== me.team && p.id !== 'SURV');
  const target = foes[0];
  target.x = me.x + Math.sin(me.h) * 45; target.z = me.z + Math.cos(me.h) * 45; target.hp = 40;
  me.v = 'patrol'; me.cd = 0;
});
const aim = await settledAim(host, `
  const me = g.sim.players[g.localId];
  const foe = Object.values(g.sim.players).find(p => p.team !== me.team && p.id !== 'SURV');
  return foe ? { x: foe.x, z: foe.z } : null;
`);
await host.mouse.move(aim.x, aim.y);
// Long enough to land a burst even at software-rendering frame rates.
await host.mouse.down(); await host.waitForTimeout(6000); await host.mouse.up();
await host.waitForTimeout(400);
await c1.bringToFront();
await c1.waitForTimeout(900);
ok('victim sees VESSEL SUNK', await c1.evaluate(() => !document.getElementById('sunk').classList.contains('hidden')));
ok('victim controls are dead', await c1.evaluate(() => { const g=window.__game; const me=g.lastView.players[g.localId]; return !me.a || me.hp===0; }));
await c1.screenshot({ path: SP + '/e-sunk.png' });
await host.bringToFront();
await host.waitForTimeout(1600);

ok('victim was sunk', await host.evaluate(() => { const g=window.__game,me=g.sim.players[g.localId];
  const foe=Object.values(g.sim.players).find(p=>p.team!==me.team && p.id!=='SURV'); return foe.hp === 0 && !foe.a; }));
ok('match continues while an enemy is still afloat', await host.evaluate(() => window.__game.phase) === 'match');
// Now remove the survivor and confirm elimination ends it.
await host.evaluate(() => { const g=window.__game; g.sim.damage('SURV', 999, false, g.localId, 'rifle', 0, 0); });
await host.waitForTimeout(1500);
ok('kill feed rendered on host', (await host.evaluate(() => document.querySelectorAll('.feed-row').length)) > 0);
ok('kill feed rendered on victim', (await c1.evaluate(() => document.querySelectorAll('.feed-row').length)) > 0);
// 1v1: sinking the only enemy must end the match.
await host.waitForTimeout(2500);
ok('match ended on team elimination', await host.evaluate(() => window.__game.phase) === 'end');
ok('winner screen shown on host', await host.evaluate(() => !document.getElementById('screen-end').classList.contains('hidden')));
ok('winner screen shown on client', await c1.evaluate(() => !document.getElementById('screen-end').classList.contains('hidden')));
ok('winner text', await host.textContent('#end-winner'));
ok('MVP named', await host.textContent('#mvp-name'));
await host.screenshot({ path: SP + '/e-end.png' });

// Drop the synthetic survivor so the roster counts below reflect real players.
await host.evaluate(() => { delete window.__game.sim.players.SURV; });

// Play again returns everyone to the lobby with the roster intact.
await host.click('#btn-again');
await host.waitForTimeout(2000);
ok('host back in lobby', await host.evaluate(() => !document.getElementById('screen-lobby').classList.contains('hidden')));
ok('client back in lobby', await c1.evaluate(() => !document.getElementById('screen-lobby').classList.contains('hidden')));
ok('roster survived the rematch', await host.evaluate(() => Object.keys(window.__game.sim.players).length) === 2);
ok('ready flags cleared for the rematch', await host.evaluate(() => Object.values(window.__game.sim.players).every(p => !p.ready)));

// A client dropping out must not break the host's match.
await c1.close();
await host.waitForTimeout(2500);
ok('host survives a disconnect', await host.evaluate(() => window.__game.phase) === 'lobby');
ok('disconnected player removed from lobby', await host.evaluate(() => Object.keys(window.__game.sim.players).length) === 1);

console.log('\nERRORS(' + errors.length + ')'); errors.slice(0,10).forEach(e=>console.log('  '+e.slice(0,250)));
const failed = Object.entries(results).filter(([k,v]) => v === false).map(([k])=>k);
console.log(failed.length ? '\nFAILED: ' + failed.join(', ') : '\nALL CHECKS PASSED');
await browser.close();
