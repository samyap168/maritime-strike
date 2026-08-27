/**
 * MARITIME STRIKE — all gameplay tunables in one place.
 * Rebalancing the whole game should never require touching another file.
 */

export const CFG = {
  map: {
    size: 1200,        // playable square, metres
    half: 600,
    softEdge: 70,      // distance from edge where turn-back warning + push begins
  },

  match: {
    duration: 480,     // 8:00
    countdown: 3,
    minPlayers: 2,     // host cannot start below this
  },

  player: {
    maxHp: 100,
    spawnSpread: 90,
  },

  combat: {
    critChance: 0.15,
    critMultiplier: 2,
    aimAssistCone: 0.42,   // radians, half-angle
    aimAssistRange: 260,
    aimAssistBlend: 0.45,  // 0 = pure mouse, 1 = full snap
  },

  physics: {
    baseSpeed: 22,     // m/s at 1.0x
    baseTurn: 0.95,    // rad/s at 1.0x
    accel: 14,
    reverseFactor: 0.45,
    // A vessel at a standstill turns sluggishly; at speed it carves.
    turnAtRest: 0.35,
  },

  net: {
    simHz: 30,
    snapHz: 15,
    inputHz: 30,
    interpDelayMs: 100,
    timeoutMs: 9000,
  },

  perf: {
    // Automatic quality drop if frame time stays poor for this long.
    degradeAfterMs: 3000,
    degradeFrameMs: 34,   // ~29fps
  },
};

/**
 * The five vessel classes. Every vessel has identical HP — they differ only in
 * speed, turning, weapon and special ability. That is the core balance rule.
 */
export const VESSELS = {
  sampan: {
    id: 'sampan', name: 'SAMPAN', short: 'SAMPAN',
    speed: 1.15, turn: 1.30, weapon: 'rifle',
    length: 7.5, beam: 2.6, radius: 3.6,
    desc: 'Nimble. Tightest turning circle in the game.',
  },
  patrol: {
    id: 'patrol', name: 'COAST GUARD PATROL BOAT', short: 'PATROL',
    speed: 1.30, turn: 1.05, weapon: 'autocannon',
    length: 14, beam: 4.2, radius: 5.2,
    desc: 'Fastest hull. Sustained fire, but the guns overheat.',
  },
  destroyer: {
    id: 'destroyer', name: 'MISSILE DESTROYER', short: 'DESTROYER',
    speed: 0.70, turn: 0.52, weapon: 'missile',
    length: 27, beam: 6.4, radius: 8.5,
    desc: 'Slow and heavy. Longest reach on the map.',
  },
  submarine: {
    id: 'submarine', name: 'SUBMARINE', short: 'SUB',
    speed: 0.95, turn: 0.80, weapon: 'torpedo',
    length: 20, beam: 4.4, radius: 6.2,
    desc: 'Hold SHIFT to submerge. Silent, but cannot fire under.',
  },
  minelayer: {
    id: 'minelayer', name: 'MINELAYER', short: 'MINELAYER',
    speed: 1.00, turn: 0.88, weapon: 'mine',
    length: 18, beam: 5.6, radius: 6.4,
    desc: 'No guns at all. Denies whole channels with mines.',
  },
};

export const WEAPONS = {
  rifle: {
    id: 'rifle', name: 'DECK RIFLE', kind: 'bullet',
    damage: 8, cooldown: 0.35, speed: 170, range: 95, spread: 0.022,
  },
  autocannon: {
    id: 'autocannon', name: 'TWIN AUTOCANNON', kind: 'bullet',
    damage: 6, cooldown: 0.11, speed: 210, range: 115, spread: 0.038,
    heatPerShot: 0.075, coolRate: 0.30, overheatLock: 1.4,
  },
  missile: {
    id: 'missile', name: 'GUIDED MISSILE', kind: 'missile',
    damage: 34, splash: 12, splashRadius: 17, cooldown: 2.6,
    speed: 95, range: 320, homingRate: 1.05, arcHeight: 16,
  },
  torpedo: {
    id: 'torpedo', name: 'TORPEDO', kind: 'torpedo',
    damage: 40, cooldown: 3.0, speed: 62, range: 240,
  },
  mine: {
    id: 'mine', name: 'SEA MINES', kind: 'mine',
    damage: 55, cooldown: 4.0, maxLive: 6,
    triggerRadius: 9, revealRange: 25, armDelay: 1.2, life: 90,
  },
};

/** Pickup kind -> vessel it transforms you into. */
export const PICKUP_TO_VESSEL = {
  rifle: 'patrol',
  missile: 'destroyer',
  torpedo: 'submarine',
  mine: 'minelayer',
};

export const PICKUP_LABEL = {
  rifle: 'RIFLE CRATE',
  missile: 'MISSILE POD',
  torpedo: 'TORPEDO TUBE',
  mine: 'MINE CRATE',
};

export const TEAMS = {
  red:  { id: 'red',  name: 'RED',  color: 0xff4d4d, hex: '#ff4d4d' },
  blue: { id: 'blue', name: 'BLUE', color: 0x4da6ff, hex: '#4da6ff' },
};

export const NICKNAMES = [
  'SeaTiger', 'OceanFox', 'MarinaGhost', 'RedShark', 'BlueWhale', 'HarborWolf',
  'StraitHawk', 'KelongKing', 'BumboatBravo', 'MerlionMako', 'KeppelKite',
  'SentosaSiren', 'JurongJackal', 'ChangiCobra', 'PulauPhantom', 'TekongTiger',
  'RaffleRay', 'BedokBarracuda', 'PasirPike', 'SelatSquall',
];

// Deliberately excludes 0/O and 1/I — these get read aloud across a room.
const CODE_WORDS = ['MARINE', 'STRAIT', 'HARBOR', 'ANCHOR', 'TYPHOON', 'MONSOON', 'LAGOON', 'REEF'];

export function makeRoomCode() {
  const w = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
  const n = 200 + Math.floor(Math.random() * 799);
  return `SG-${w}-${n}`;
}

export function randomNickname() {
  return NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)] +
    (Math.random() < 0.35 ? String(Math.floor(Math.random() * 90) + 10) : '');
}
