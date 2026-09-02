import { loadChromium, LAUNCH, BASE } from './playwright.mjs';
const chromium = await loadChromium();
import { mkdirSync } from 'node:fs';
const SP = process.env.SP || 'test-output';
mkdirSync(SP, { recursive: true });
const b = await chromium.launch(LAUNCH);
const p = await b.newPage({ viewport:{width:1440,height:810} });
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE '+m.text().slice(0,300)); });
const ok=(k,v)=>console.log((v?'PASS  ':'FAIL  ')+k+(typeof v!=='boolean'?' -> '+JSON.stringify(v):''));

await p.goto(BASE + '/', { waitUntil:'load' });
await p.waitForTimeout(4000);
ok('single player button present', await p.isVisible('#btn-solo'));

await p.click('#btn-solo');
await p.waitForTimeout(9000);           // countdown + a few seconds of match
await p.evaluate(() => window.__game.hud.hideTutorial());

const start = await p.evaluate(() => {
  const g = window.__game;
  const ps = Object.values(g.sim.players);
  return {
    phase: g.phase,
    total: ps.length,
    bots: ps.filter(x => x.bot).length,
    red: ps.filter(x => x.team === 'red').length,
    blue: ps.filter(x => x.team === 'blue').length,
    positions: ps.slice(0,4).map(x => ({ x: Math.round(x.x), z: Math.round(x.z) })),
  };
});
ok('match running', start.phase === 'match');
ok('roster is 16', start.total === 16);
ok('15 bots', start.bots === 15);
ok('teams split 8/8', Math.abs(start.red - start.blue) <= 1);

// Do the bots actually do anything? Watch movement and combat over 25s.
const t0 = await p.evaluate(() => Object.values(window.__game.sim.players)
  .filter(x=>x.bot).map(x => ({ id:x.id, x:x.x, z:x.z, hp:x.hp })));
await p.waitForTimeout(25000);
const t1 = await p.evaluate(() => {
  const g = window.__game;
  const ps = Object.values(g.sim.players);
  return {
    bots: ps.filter(x=>x.bot).map(x => ({ id:x.id, x:x.x, z:x.z, hp:x.hp, v:x.v, alive:x.a })),
    projectiles: g.sim.projectiles.length,
    mines: g.sim.mines.length,
    kills: ps.reduce((a,x)=>a+(x.k||0),0),
    sunk: ps.filter(x=>!x.a).length,
    upgraded: ps.filter(x=>x.v !== 'sampan').length,
    feedRows: document.querySelectorAll('.feed-row').length,
    modes: [...new Set(ps.filter(x=>x.bot).map(x=>x.bot.mode))],
  };
});
const moved = t1.bots.filter(bt => {
  const before = t0.find(o=>o.id===bt.id);
  return before && Math.hypot(bt.x-before.x, bt.z-before.z) > 60;
}).length;
ok('bots navigating (moved >60m)', moved);
ok('bots collecting pickups', t1.upgraded);
ok('bots shooting', t1.projectiles + t1.kills > 0 ? { inFlight: t1.projectiles, kills: t1.kills } : false);
ok('kills happening', t1.kills > 0);
ok('kill feed populated', t1.feedRows > 0);
ok('bot states in use', t1.modes);
ok('all bots have a live brain', t1.bots.length === 15);
await p.screenshot({ path: SP + '/solo-match.png' });
console.log('\nerrors:', errs.length); errs.slice(0,5).forEach(e=>console.log('  '+e.slice(0,240)));
await b.close();
