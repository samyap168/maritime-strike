# Maritime Strike

A 16-player, team-vs-team 3D naval combat game set in a stylised Singapore.
Runs in the browser. No install, no accounts, no build step, no backend.

Built with Claude Code from a single prompt, as a live demonstration of what
AI-assisted development can produce.

---

## Play it

**Hosted (what the team uses):**

```
https://samyap168.github.io/maritime-strike/
```

One person clicks **Create Game** and reads out the room code; everyone else
clicks **Join Game** and enters it. The browsers connect directly to each other
over WebRTC, with the host's browser acting as the authority — there is no
server to deploy, pay for, or keep awake.

**Before you rely on it, press "Test connection" on the landing screen.**
Peer-to-peer is the one thing a venue's wifi can block, and it fails silently
until people are already waiting. The button answers it in five seconds.

**If peer-to-peer is blocked**, run the bundled relay on the host machine — it
has zero dependencies and needs no internet at all:

```bash
node server/relay.js
```

It prints the two links to share. Everyone must be on the same network for this
path, so it solves a blocked-WebRTC problem, not an isolated-network one.

**If the relay is hosted publicly** (behind TLS), point players at it with
`?net=ws&relay=wss://your-relay-host`. Note that a page served over HTTPS can
only reach a relay over `wss://` — browsers block plaintext `ws://` from an
HTTPS page as mixed content, and the game will tell you so explicitly rather
than failing with a bare connection error.

---

## Running a match

1. Host clicks **Create Game** and reads out the room code (`SG-MARINE-482`).
   Codes deliberately avoid `0`/`O` and `1`/`I` — they get read aloud.
2. Players join, get a random callsign, and can rename themselves.
3. Teams auto-balance; players may switch, but not to a side that would
   unbalance by more than one.
4. Everyone hits **Ready**. The host sees exactly who has not, and can kick a
   player whose laptop has frozen.
5. Host starts. Countdown, then eight minutes.
6. Win by sinking every enemy vessel, or by holding the most sinks at time.

Sunk players stay out for the rest of the match and spectate surviving
teammates. **Play again** returns everyone to the lobby with names and teams
intact.

### Controls

| Input | Action |
|---|---|
| `W` / `S` | Throttle forward / reverse |
| `A` / `D` | Turn left / turn right |
| Mouse | Aim (semi-automatic assist) |
| Left click | Fire |
| `SHIFT` | Submerge (submarine) / lay mine (minelayer) |
| `TAB` (hold) | Scoreboard |

A tactical map sits top-right showing terrain, live weapon crates and **your own
team**. Enemies are deliberately never plotted — that would delete every ambush
the terrain exists to enable.
| `M` | Mute everything |
| `V` | Ship's comms on / off |

Audio is muted until you click it on — fifteen laptops unmuting at once is a
way to lose a room.

**Sound and comms.** A distant naval engagement plays under everything: ocean
swell, wind, and gunfire and shellbursts over the horizon. Your crew calls out
what matters — radar contacts, missiles and torpedoes away, hull breaches, fire
on deck, a kill ("well done, Captain"), and the last ship afloat. Voice uses the
browser's built-in speech synthesis, so like every other asset here there is
nothing to download and nothing that can fail to load; a procedural radio click
either side of each line makes it read as a bridge intercom. Lines are rate-
limited per type with a global gap and priority, because a vessel that talks
over itself is worse than one that says nothing. `V` turns comms off on its own
if you want the game audio without the chatter.

**Damaged ships burn.** Below 55% health a hull starts smoking; the worse the
damage the more it burns, with flame at the deck cooling into smoke above. It is
visible across the map, so a wounded ship is a target everyone can see.

---

## The five vessels

Everyone starts as a sampan. Vessels change **only** by driving over a weapon
pickup, and every vessel has the same 100 HP — they differ in speed, weapon and
ability, never in survivability.

| Vessel | Pickup | Weapon | Speed | Damage | Notes |
|---|---|---|---|---|---|
| **Sampan** | *(start)* | Deck rifle | 1.15× | 8 | Tightest turning circle in the game |
| **Coast Guard Patrol** | Rifle crate | Twin autocannon | **1.30×** | 6 | Fastest hull; the guns overheat |
| **Missile Destroyer** | Missile pod | Guided missile | **0.70×** | 34 + splash | Longest reach; soft lock-on |
| **Submarine** | Torpedo tube | Torpedo | 0.95× | 40 | `SHIFT` to dive — immune to everything but torpedoes, and cannot fire while under |
| **Minelayer** | Mine crate | Sea mines | 1.00× | 55 on contact | **No direct fire at all.** Lays a mine every 0.4s, 20 live at once — it can close a whole channel |

Mines are invisible to the enemy beyond 25 m; inside that they get a ripple and
a rising warning tone. Your own team always sees them.

## The map

1200 m × 1200 m, mostly open water, with seven named zones so people can call
them out: **Marina Bay** (long sight-lines, destroyer country), **Keppel Yards**
(container maze, the best hard cover), **Kranji Shoals** (mangrove channels,
ambush country), **Sisters Rocks**, **Palawan Cay**, **The Anchorage** (moored
tankers, so mid-map is not a featureless kill zone) and **Merlion Cay**.

Twelve weapon pickups respawn 25 s after being taken, each throwing a coloured
light column visible across the map. That is how fights start.

---

## How it is built

Vanilla ES modules and Three.js. No React, no bundler, no transpiler. Open
`index.html` off any static file server and it runs.

```
src/config.js          every tunable in one place — speeds, damage, timers
src/main.js            bootstrap, render loop, state machine
src/net/               transport interface + WebRTC and WebSocket implementations,
                       authoritative simulation, client prediction, wire protocol
src/game/              vessels, weapons, world, water, effects, controls
src/ui/                lobby, HUD, styles
src/audio/             procedural WebAudio — no sound files
server/relay.js        static server + WebSocket relay, zero dependencies
vendor/                Three.js and PeerJS, vendored — nothing fetched at runtime
```

**Networking.** The host's browser owns the simulation; clients send input and
render snapshots. The host validates every hit, pickup and death, so a modified
client cannot claim a kill it did not earn. The host simulates at 30 Hz and
broadcasts delta-compressed snapshots at 15 Hz; clients predict their own vessel
locally and render everyone else ~100 ms in the past, interpolated.

Both transports sit behind one interface in `src/net/transport.js`, so gameplay
code cannot tell which is in use.

**Assets.** Every vessel, island, crane and skyline is procedural geometry
generated in code. There are no model files, so nothing can fail to load, the
art direction stays consistent, and any asset can be changed by editing a few
numbers — which is rather the point of the demo.

**Rebalancing live.** Everything worth tuning is in `src/config.js`. Changing a
number and reloading is a good second demo beat.

---

## Testing

Requires Playwright (`npm i -D playwright && npx playwright install chromium`).
Start the relay first, then:

```bash
npm test            # full match lifecycle across two real browsers
npm run test:weapons # all five weapons deal damage; minelayer cannot direct-fire
npm run test:smoke   # loads, renders, no console errors
```

`npm test` drives two browsers through join → rename → team switch → ready →
start → pickup → friendly-fire check → kill → kill feed → sunk state →
elimination → winner screen → play again → disconnect.

---

## Known limits

- **The WebRTC path has not been verified end to end**, because the environment
  this was built in blocks the public signalling host. The WebSocket relay path
  is fully tested across two browsers. Run **Test connection** before relying
  on WebRTC.
- No host migration. If the host disconnects, the match ends cleanly and
  everyone returns to the lobby.
- Human players only — there are no AI opponents. `?range=1` gives a solo
  free-roam with three stationary target hulks, for rehearsal and for checking
  a laptop can run the game.
