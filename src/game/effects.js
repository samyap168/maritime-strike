/**
 * All transient visuals, every one of them pooled.
 *
 * Nothing here allocates during a match: projectiles, explosions, splashes and
 * wake puffs are created once at load and recycled. With 16 players putting
 * rounds downrange that is the difference between a smooth match and a
 * stuttering one on an integrated GPU.
 */

import * as THREE from 'three';
import { mat, mesh, box, cyl, cone, sphere } from './geo.js';
import { sampleWaveHeight } from './water.js';

const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

// Reused so the per-particle colour ramp allocates nothing in the hot path.
const FIRE_HOT = new THREE.Color(0xff8a2a);
const FIRE_SMOKE = new THREE.Color(0x3f4247);

/**
 * A soft radial blob, generated once and shared by every foam and splash sprite.
 *
 * Flat-shaded polygons are the right look for hulls and rocks; they are exactly
 * the wrong look for spray, where a hard 7-sided edge reads as a bug. One tiny
 * gradient texture fixes wakes, splashes and explosion smoke together.
 */
let foamTexture = null;
function getFoamTexture() {
  if (foamTexture) return foamTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  foamTexture = new THREE.CanvasTexture(c);
  return foamTexture;
}

class Pool {
  constructor(size, make) {
    this.items = [];
    for (let i = 0; i < size; i++) {
      const it = make(i);
      it.userData.active = false;
      it.visible = false;
      this.items.push(it);
    }
    this.cursor = 0;
  }

  acquire() {
    // Ring-scan for a free slot; if the pool is saturated, steal the oldest.
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[(this.cursor + i) % this.items.length];
      if (!it.userData.active) {
        this.cursor = (this.cursor + i + 1) % this.items.length;
        it.userData.active = true;
        it.visible = true;
        return it;
      }
    }
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.userData.active = true;
    it.visible = true;
    return it;
  }

  release(it) { it.userData.active = false; it.visible = false; }
  forEachActive(fn) { for (const it of this.items) if (it.userData.active) fn(it); }
}

export class Effects {
  constructor(scene, quality = 'high', camera = null) {
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.time = 0;
    this.root = new THREE.Group();
    scene.add(this.root);

    const detail = quality === 'high';

    // ---- projectile visuals, one pool per kind -----------------------------
    // Geometry is pre-rotated so its long axis runs along +Z. Orientation is
    // then a single rotation.y, which cannot be got wrong.
    const tracerGeo = cyl(0.16, 0.16, 3.4, 5);
    tracerGeo.rotateX(Math.PI / 2);
    this.tracers = new Pool(90, () => {
      const m = mesh(tracerGeo, mat(0xffe08a, { emissive: 0xffb020, emissiveIntensity: 1.4 }));
      this.root.add(m);
      return m;
    });

    this.missiles = new Pool(24, () => {
      const g = new THREE.Group();
      g.add(mesh(cyl(0.34, 0.34, 2.6, 7), mat(0xdfe4e8), 0, 0, 0));
      g.children[0].rotation.x = Math.PI / 2;
      g.add(mesh(cone(0.34, 1.0, 7), mat(0xc0392b), 0, 0, 1.7));
      g.children[1].rotation.x = Math.PI / 2;
      const flame = mesh(cone(0.42, 2.2, 6), new THREE.MeshBasicMaterial({ color: 0xffb347, ...ADD, opacity: 0.9 }), 0, 0, -2.0);
      flame.rotation.x = -Math.PI / 2;
      g.add(flame);
      g.userData.flame = flame;
      this.root.add(g);
      return g;
    });

    this.torpedoes = new Pool(24, () => {
      const g = new THREE.Group();
      const body = mesh(cyl(0.32, 0.32, 3.0, 7), mat(0x3a4148));
      body.rotation.x = Math.PI / 2;
      g.add(body);
      // The visible surface wake is what makes a torpedo readable at all.
      const wake = mesh(box(1.1, 0.06, 7.0), new THREE.MeshBasicMaterial({ color: 0xdff2f7, transparent: true, opacity: 0.55, depthWrite: false }), 0, 0.5, -3.4);
      g.add(wake);
      g.userData.wake = wake;
      this.root.add(g);
      return g;
    });

    // ---- explosions --------------------------------------------------------
    this.explosions = new Pool(detail ? 22 : 12, () => {
      const g = new THREE.Group();
      const core = mesh(sphere(1, 9), new THREE.MeshBasicMaterial({ color: 0xffd27a, ...ADD, opacity: 1 }));
      const flame = mesh(sphere(1, 8), new THREE.MeshBasicMaterial({ color: 0xff7a2a, ...ADD, opacity: 0.9 }));
      const ring = mesh(new THREE.TorusGeometry(1, 0.16, 4, 18), new THREE.MeshBasicMaterial({ color: 0xffffff, ...ADD, opacity: 0.85 }));
      ring.rotation.x = -Math.PI / 2;
      g.add(core, flame, ring);
      const shards = [];
      if (detail) {
        for (let i = 0; i < 7; i++) {
          const s = mesh(box(0.5, 0.5, 0.9), mat(0x2b2b2b));
          g.add(s); shards.push(s);
        }
      }
      g.userData = { core, flame, ring, shards };
      this.root.add(g);
      return g;
    });

    // ---- water splashes ----------------------------------------------------
    const splashGeo = new THREE.PlaneGeometry(3, 4.5);
    this.splashes = new Pool(detail ? 40 : 18, () => {
      const m = mesh(splashGeo, new THREE.MeshBasicMaterial({
        map: getFoamTexture(), color: 0xe8f7fd,
        transparent: true, depthWrite: false, opacity: 0.8, toneMapped: false,
      }));
      this.root.add(m);
      return m;
    });

    // ---- wake foam behind moving hulls -------------------------------------
    const foamGeo = new THREE.PlaneGeometry(2, 2);
    const foamMat = new THREE.MeshBasicMaterial({
      map: getFoamTexture(), color: 0xffffff,
      transparent: true, depthWrite: false, opacity: 0.5, toneMapped: false,
    });
    this.foam = new Pool(detail ? 150 : 60, () => {
      // Every puff needs its own material so it can fade independently.
      const m = mesh(foamGeo, foamMat.clone());
      m.rotation.x = -Math.PI / 2;
      this.root.add(m);
      return m;
    });

    // ---- burning hulls -----------------------------------------------------
    // Flame and smoke share one pool: a smoke puff is just a flame particle
    // that has been alive longer, which is also how real fire looks.
    const fireGeo = new THREE.PlaneGeometry(2, 2);
    this.fires = new Pool(detail ? 80 : 36, () => {
      const m = mesh(fireGeo, new THREE.MeshBasicMaterial({
        map: getFoamTexture(), color: 0xff8a2a,
        transparent: true, depthWrite: false, opacity: 0.9, toneMapped: false,
      }));
      this.root.add(m);
      return m;
    });

    // ---- muzzle flashes ----------------------------------------------------
    this.flashes = new Pool(20, () => {
      const m = mesh(sphere(0.9, 6), new THREE.MeshBasicMaterial({ color: 0xfff0c0, ...ADD, opacity: 1 }));
      this.root.add(m);
      return m;
    });

    this.shake = 0;
  }

  // -------------------------------------------------------------- spawners

  explode(x, y, z, scale = 1, small = false) {
    const e = this.explosions.acquire();
    e.position.set(x, Math.max(0.4, y), z);
    e.userData.t = 0;
    e.userData.life = small ? 0.28 : 0.75;
    e.userData.scale = small ? scale * 0.45 : scale;
    for (const s of e.userData.shards) {
      const a = Math.random() * Math.PI * 2;
      s.position.set(0, 0, 0);
      s.userData.v = new THREE.Vector3(Math.cos(a) * (4 + Math.random() * 9), 5 + Math.random() * 8, Math.sin(a) * (4 + Math.random() * 9));
      s.visible = true;
    }
    if (!small) {
      this.splash(x, z, scale * 1.4);
      this.shake = Math.min(1, this.shake + 0.5 * scale);
    }
    return e;
  }

  splash(x, z, scale = 1) {
    const n = this.quality === 'high' ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const s = this.splashes.acquire();
      const a = Math.random() * Math.PI * 2, d = Math.random() * 3 * scale;
      s.position.set(x + Math.cos(a) * d, 0.2, z + Math.sin(a) * d);
      s.scale.setScalar(0.5 + Math.random() * 0.7 * scale);
      s.userData.t = 0;
      s.userData.life = 0.5 + Math.random() * 0.3;
      s.userData.vy = 7 + Math.random() * 7 * scale;
    }
  }

  muzzleFlash(x, y, z, scale = 1) {
    const f = this.flashes.acquire();
    f.position.set(x, y, z);
    f.scale.setScalar(scale);
    f.userData.t = 0;
    f.userData.life = 0.09;
  }

  /**
   * Emit fire and smoke from a burning hull.
   *
   * `intensity` runs 0..1 with how badly the ship is hurt. Called every frame
   * for every burning vessel, so emission is throttled per-vessel by an
   * accumulator the caller owns rather than by spawning on every tick.
   */
  fireBurst(x, y, z, intensity, scale = 4, heading = 0) {
    const f = this.fires.acquire();
    // Spread along the hull rather than from a single point, so the fire looks
    // like a ship burning rather than a rocket motor bolted to the deck.
    const along = (Math.random() - 0.5) * scale * 2.4;
    const across = (Math.random() - 0.5) * scale * 0.7;
    f.position.set(
      x + Math.sin(heading) * along + Math.cos(heading) * across,
      y + Math.random() * 0.5,
      z + Math.cos(heading) * along - Math.sin(heading) * across
    );
    const u = f.userData;
    u.t = 0;
    u.life = 0.85 + Math.random() * 0.95;
    u.rise = 3.2 + Math.random() * 3.0 + intensity * 3.0;
    u.drift = (Math.random() - 0.5) * 1.8;
    u.size = scale * (0.40 + Math.random() * 0.34 + intensity * 0.30);
    u.spin = (Math.random() - 0.5) * 1.4;
    f.rotation.z = Math.random() * Math.PI;
    f.material.opacity = 0.9;
    f.material.color.setHex(0xffb347);
    f.scale.setScalar(u.size * 0.45);
  }

  /** Foam puff dropped behind a moving hull. */
  wakePuff(x, z, size, opacity) {
    const f = this.foam.acquire();
    f.position.set(x, 0.16, z);
    f.scale.setScalar(size);
    f.userData.t = 0;
    f.userData.life = 1.5 + Math.random() * 0.8;
    f.userData.size = size;
    f.userData.peak = opacity;
    f.rotation.z = Math.random() * Math.PI;
  }

  // ----------------------------------------------------------- per-frame

  /** Draw every live projectile the host reported this frame. */
  syncProjectiles(list) {
    this.tracers.forEachActive((m) => this.tracers.release(m));
    this.missiles.forEachActive((m) => this.missiles.release(m));
    this.torpedoes.forEachActive((m) => this.torpedoes.release(m));

    for (const p of list) {
      if (p.kind === 'missile') {
        const m = this.missiles.acquire();
        m.position.set(p.x, p.y, p.z);
        m.rotation.set(0, p.heading, 0);
        m.userData.flame.scale.setScalar(0.8 + Math.random() * 0.5);
        if (Math.random() < 0.55) this.wakePuff(p.x, p.z, 1.4, 0.14);
      } else if (p.kind === 'torpedo') {
        const m = this.torpedoes.acquire();
        m.position.set(p.x, -0.2, p.z);
        m.rotation.set(0, p.heading, 0);
        if (Math.random() < 0.8) this.wakePuff(p.x, p.z, 1.5, 0.4);
      } else {
        const m = this.tracers.acquire();
        m.position.set(p.x, p.y, p.z);
        m.rotation.set(0, p.heading, 0);
      }
    }
  }

  update(dt, t) {
    this.time = t;
    this.shake = Math.max(0, this.shake - dt * 2.2);

    this.explosions.forEachActive((e) => {
      const u = e.userData;
      u.t += dt;
      const k = u.t / u.life;
      if (k >= 1) { this.explosions.release(e); return; }
      const s = u.scale;
      u.core.scale.setScalar((0.6 + k * 3.4) * s);
      u.core.material.opacity = Math.max(0, 1 - k * 1.7);
      u.flame.scale.setScalar((1.0 + k * 5.2) * s);
      u.flame.material.opacity = Math.max(0, 0.85 - k * 1.1);
      u.ring.scale.setScalar((1 + k * 14) * s);
      u.ring.material.opacity = Math.max(0, 0.8 - k * 0.95);
      for (const sh of u.shards) {
        sh.userData.v.y -= 22 * dt;
        sh.position.addScaledVector(sh.userData.v, dt);
        sh.rotation.x += dt * 6; sh.rotation.z += dt * 4;
        sh.visible = sh.position.y > -1;
      }
    });

    this.splashes.forEachActive((s) => {
      const u = s.userData;
      u.t += dt;
      const k = u.t / u.life;
      if (k >= 1) { this.splashes.release(s); return; }
      u.vy -= 22 * dt;
      s.position.y += u.vy * dt;
      s.material.opacity = Math.max(0, 0.8 * (1 - k));
      if (s.position.y < 0) s.position.y = 0;
      if (this.camera) s.quaternion.copy(this.camera.quaternion);   // billboard
    });

    this.foam.forEachActive((f) => {
      const u = f.userData;
      u.t += dt;
      const k = u.t / u.life;
      if (k >= 1) { this.foam.release(f); return; }
      f.scale.setScalar(u.size * (1 + k * 1.2));
      f.material.opacity = Math.max(0, u.peak * (1 - k));
      f.position.y = 0.16 + sampleWaveHeight(f.position.x, f.position.z, t) * 0.9;
    });

    // Fire: bright and small at birth, then cooling and swelling into smoke.
    this.fires.forEachActive((f) => {
      const u = f.userData;
      u.t += dt;
      const k = u.t / u.life;
      if (k >= 1) { this.fires.release(f); return; }

      f.position.y += u.rise * dt * (1 - k * 0.5);
      f.position.x += u.drift * dt;
      f.rotation.z += u.spin * dt;
      // Flame stays tight at the hull; smoke is what billows.
      f.scale.setScalar(u.size * (k < 0.3 ? 0.45 + k * 0.9 : 0.72 + (k - 0.3) * 2.6));

      // Yellow-hot at the deck, ember orange, then grey smoke well before the
      // particle dies — otherwise a burning ship reads as a flare, not damage.
      if (k < 0.14) f.material.color.setHex(0xffe08a);
      else if (k < 0.30) f.material.color.setHex(0xff8a2a);
      else f.material.color.lerpColors(
        FIRE_HOT, FIRE_SMOKE, Math.min(1, (k - 0.30) / 0.30)
      );
      f.material.opacity = k < 0.12 ? 0.9 : Math.max(0, 0.62 * (1 - (k - 0.12) / 0.88));
      if (this.camera) f.quaternion.copy(this.camera.quaternion);
    });

    this.flashes.forEachActive((f) => {
      const u = f.userData;
      u.t += dt;
      if (u.t >= u.life) { this.flashes.release(f); return; }
      f.material.opacity = 1 - u.t / u.life;
    });
  }
}
