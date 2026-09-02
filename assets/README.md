# Optional 3D models

The game runs entirely on procedural geometry and needs nothing in this folder.
Everything here is an **override**: drop in a GLB and it replaces the built-in
version of that object. Miss one out and the procedural version is used. There
is no failure mode where a missing or broken model breaks the game.

## Adding a model

1. **Generate or make a GLB.** Any tool: Blender, or an image-to-3D service
   (Meshy, Tripo, Rodin, Hunyuan3D). One or two reference photos is usually
   enough for those services.
2. **Save it at the path** listed in the table below.
3. **Add its key** to the `present` array in `manifest.json`.
4. Reload. The model is fetched in the background and swaps in when it arrives.

Step 3 matters: the game only requests models the manifest lists, so an
unlisted slot costs nothing and produces no console noise.

```json
{ "present": ["vessel.destroyer", "vessel.submarine", "landmark.mbs"] }
```

## Slots

| Key | Path | Normalised to |
|---|---|---|
| `vessel.sampan` | `assets/vessels/sampan.glb` | 7.5 m long |
| `vessel.patrol` | `assets/vessels/patrol-boat.glb` | 14 m long |
| `vessel.destroyer` | `assets/vessels/destroyer.glb` | 27 m long |
| `vessel.submarine` | `assets/vessels/submarine.glb` | 20 m long |
| `vessel.minelayer` | `assets/vessels/minelayer.glb` | 18 m long |
| `landmark.mbs` | `assets/landmarks/marina-bay-sands.glb` | 84 m tall |
| `landmark.supertrees` | `assets/landmarks/supertrees.glb` | 52 m tall |
| `landmark.flyer` | `assets/landmarks/singapore-flyer.glb` | 58 m tall |
| `landmark.artscience` | `assets/landmarks/artscience-museum.glb` | 20 m tall |
| `landmark.esplanade` | `assets/landmarks/esplanade.glb` | 16 m tall |
| `landmark.merlion` | `assets/landmarks/merlion.glb` | 14 m tall |
| `landmark.cableCar` | `assets/landmarks/cable-car-pylon.glb` | 52 m tall |
| `landmark.cruiseTerminal` | `assets/landmarks/cruise-terminal.glb` | 12 m tall |
| `port.quayCrane` | `assets/port/quay-crane.glb` | 46 m tall |
| `port.container` | `assets/port/container.glb` | 12.4 m long |
| `port.containerShip` | `assets/port/container-ship.glb` | 190 m long |
| `port.tanker` | `assets/port/tanker.glb` | 230 m long |
| `port.cruiseShip` | `assets/port/cruise-ship.glb` | 260 m long |
| `terrain.island` | `assets/terrain/island.glb` | 100 m across |
| `terrain.rock` | `assets/terrain/rock.glb` | 30 m across |
| `terrain.mangrove` | `assets/terrain/mangrove.glb` | 30 m across |
| `pickup.crate` | `assets/pickups/weapon-crate.glb` | 5 m across |
| `pickup.buoy` | `assets/pickups/buoy.glb` | 4.2 m tall |

## Export requirements

- **Format:** `.glb` (binary glTF), textures embedded.
- **No Draco or meshopt compression.** The vendored loader has no decoder, so a
  compressed file will simply fail and fall back.
- **Orientation:** Y-up, and for vessels the bow pointing **+Z**. If your model
  is longer across X than Z the loader rotates it for you, but getting it right
  is better than relying on that.
- **Origin:** anywhere. Models are recentred on load.
- **Scale:** anywhere. Models are rescaled to the sizes above, because collision
  radii and weapon ranges are already tuned to them.

## Budget — read this before generating twenty models

Right now the whole game is **about 330 KB gzipped** and loads in roughly a
second on poor wifi. A single textured GLB from an image-to-3D service is
commonly **1–10 MB**.

That is the real tradeoff. Sixteen people loading 50 MB simultaneously through
one venue access point is close to a gigabyte through a single radio, and the
game will feel broken before it feels beautiful. Recommendations:

- **Start with the five vessels.** They are on screen for the whole match and
  are where fidelity is actually felt. Landmarks are seen at distance where
  detail matters far less.
- **Keep each vessel under ~2 MB.** Decimate to 5–15k triangles and cap textures
  at 1024px; beyond that you are paying load time for detail nobody can see at
  gameplay range.
- **Test on the venue's wifi**, with several laptops at once, before relying on it.

Team colours are always applied procedurally on top of an imported hull, because
a downloaded model has no idea which side it is fighting for — and team
identification is gameplay, not decoration.
