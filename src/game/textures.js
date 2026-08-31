/**
 * Procedurally generated textures.
 *
 * Everything here is drawn into a canvas at load time. That keeps the project's
 * one hard rule — no external assets, nothing to download, nothing that can
 * fail to load — while giving surfaces the fine detail that flat-shaded
 * geometry alone cannot produce. A 256px tile costs under a millisecond to
 * generate and is what separates "untextured low-poly" from "stylised but
 * detailed".
 *
 * All tiles are seamless: the noise wraps on both axes, so they can be repeated
 * across a surface without visible joins.
 */

import * as THREE from 'three';

/** Seamless value noise on a torus, so the tile wraps in both directions. */
function tileableNoise(size, freq, seed) {
  const out = new Float32Array(size * size);
  const g = [];
  const rnd = mulberry(seed);
  for (let i = 0; i < freq * freq; i++) g.push(rnd());

  const at = (x, y) => g[((y % freq) + freq) % freq * freq + (((x % freq) + freq) % freq)];
  const smooth = (t) => t * t * (3 - 2 * t);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * freq, fy = (y / size) * freq;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = smooth(fx - ix), ty = smooth(fy - iy);
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      out[y * size + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sum several octaves of tileable noise into one seamless height field. */
function fbm(size, octaves, baseFreq, seed) {
  const acc = new Float32Array(size * size);
  let amp = 1, total = 0, freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const layer = tileableNoise(size, freq, seed + o * 7919);
    for (let i = 0; i < acc.length; i++) acc[i] += layer[i] * amp;
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= total;
  return acc;
}

/**
 * Water ripple normal map.
 *
 * This is the texture that does the most work in the whole game. Wave geometry
 * gives the sea its shape; this gives it a SURFACE — the fine chop that catches
 * the sun and makes water look wet rather than like tinted glass.
 */
export function makeRippleNormal(size = 256) {
  const h = fbm(size, 4, 8, 0x51DE);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);

  const H = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const strength = 2.6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Central differences give the slope; encode it as a tangent-space normal.
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * A dense, layered cloudscape rendered into an equirectangular strip.
 *
 * Real skies are the single biggest contributor to how "finished" a 3D scene
 * looks, and a flat gradient reads as a placeholder no matter how good the
 * geometry beneath it is. Two fbm fields drive this: one for cloud coverage,
 * one for the vertical structure that gives banks a lit top and a shaded base.
 */
export function makeCloudTexture(w = 1024, h = 512) {
  const cov = fbm(512, 6, 4, 0xC10D);
  const det = fbm(512, 5, 11, 0x77A1);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);

  const S = (arr, u, v) => {
    const x = Math.floor(u * 512) & 511, y = Math.floor(v * 512) & 511;
    return arr[y * 512 + x];
  };

  for (let y = 0; y < h; y++) {
    const v = y / h;
    // Seen from sea level, cloud runs from just above the horizon up to
    // roughly 50 degrees and thins toward the zenith. A band centred high up
    // leaves the horizon bare, which is exactly where you spend a match
    // looking.
    const up = (t, a2, b2) => Math.max(0, Math.min(1, (t - a2) / (b2 - a2)));
    const sm = (t) => t * t * (3 - 2 * t);
    const band = sm(up(v, 0.005, 0.14)) * (1 - sm(up(v, 0.50, 0.98)) * 0.85);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      let d = S(cov, u * 2.0, v * 1.4) * 0.68 + S(det, u * 5.0, v * 3.0) * 0.32;
      // Threshold and contrast set coverage. Too high and the sky reads as a
      // faint wash; the look wanted is genuine banks with clear sky between.
      d = (d - 0.345) * 2.5;
      let a = Math.max(0, Math.min(1, d)) * band;
      a = Math.pow(a, 1.10);

      // Vertical structure: the top of a bank is lit, the base is shadowed.
      const lift = S(det, u * 5.0, v * 3.0 + 0.035) - S(det, u * 5.0, v * 3.0);
      const shade = Math.max(0, Math.min(1, 0.62 + lift * 5.0));

      // A wide tonal range between shadowed base and lit top is what gives a
      // bank volume instead of making it a flat grey smear.
      const i = (y * w + x) * 4;
      img.data[i] = (128 + shade * 126) | 0;
      img.data[i + 1] = (134 + shade * 120) | 0;
      img.data[i + 2] = (146 + shade * 108) | 0;
      img.data[i + 3] = (a * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Grimy panel plating for hulls and port structures: panel seams, plate-to-plate
 * tonal variation, weld lines and streaking. Greyscale, used as a light map
 * multiplier so one tile serves every hull colour.
 */
export function makePanelTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const rnd = mulberry(0xBEEF);

  ctx.fillStyle = '#b8b8b8';
  ctx.fillRect(0, 0, size, size);

  // Plates, each very slightly off its neighbours.
  const cols = 8, rows = 6;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = 176 + Math.floor(rnd() * 26) - 13;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x * size / cols, y * size / rows, size / cols, size / rows);
    }
  }

  // Seams between plates.
  ctx.strokeStyle = 'rgba(90,92,96,0.55)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= cols; x++) {
    ctx.beginPath(); ctx.moveTo(x * size / cols, 0); ctx.lineTo(x * size / cols, size); ctx.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * size / rows); ctx.lineTo(size, y * size / rows); ctx.stroke();
  }

  // Vertical streaking below the seams — the thing that reads as "used".
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size, y = rnd() * size, len = 6 + rnd() * 34;
    ctx.strokeStyle = `rgba(96,90,82,${0.05 + rnd() * 0.12})`;
    ctx.lineWidth = 1 + rnd() * 2.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 2, y + len); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
