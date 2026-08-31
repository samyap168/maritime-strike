/**
 * The ocean.
 *
 * Water is the largest thing on screen for an entire match, so it earns real
 * shading — but it has to stay cheap enough for sixteen players on integrated
 * laptop graphics. The split that makes that possible:
 *
 *   VERTEX   displaces the mesh with the low-frequency swell only. Geometry
 *            detail costs vertices, and the big waves are all you can see in
 *            the silhouette anyway.
 *   FRAGMENT rebuilds the surface normal analytically from the same waves plus
 *            higher-frequency ripples that never touch the geometry. Detail
 *            costs nothing per-vertex and looks per-pixel sharp.
 *
 * No render targets, no reflection pass, no post-processing. The sky reflection
 * is the sky's own gradient function evaluated along the reflected ray, which
 * is indistinguishable from a real reflection on a surface this broken up.
 *
 * WAVES is the single source of truth: the GLSL loop is generated from it, so
 * the shader and sampleWaveHeight() below cannot drift apart. They must agree —
 * hulls bob on the waves you can see.
 */

import * as THREE from 'three';
import { CFG } from '../config.js';
import { buildShoreMask } from './world.js';

/** dirX, dirZ (normalised), wavelength (m), amplitude (m), speed multiplier. */
const WAVES = [
  [1.00, 0.15, 190, 0.55, 0.90],
  [0.30, 1.00, 145, 0.46, 0.75],
  [1.00, 1.00, 95, 0.26, 1.35],
  [1.00, -0.60, 58, 0.13, 1.90],
  [-0.40, 1.00, 34, 0.065, 2.40],
];

const TAU = Math.PI * 2;

/** Precomputed per-wave constants shared by the JS sampler and the shader. */
const COMPILED = WAVES.map(([dx, dz, len, amp, spd]) => {
  const l = Math.hypot(dx, dz) || 1;
  const k = TAU / len;
  return { kx: (dx / l) * k, kz: (dz / l) * k, amp, w: spd * Math.sqrt(9.81 * k) };
});

/** Emit the wave sum as unrolled GLSL so the shader shares this exact table. */
function waveGLSL(varH, varDx, varDz, posExpr, count = COMPILED.length) {
  let out = `float ${varH} = 0.0; float ${varDx} = 0.0; float ${varDz} = 0.0;\n`;
  COMPILED.slice(0, count).forEach((w, i) => {
    const f = (v) => v.toPrecision(8);
    out += `  {
    float ph${i} = ${f(w.kx)} * ${posExpr}.x + ${f(w.kz)} * ${posExpr}.y - ${f(w.w)} * uTime;
    ${varH} += ${f(w.amp)} * sin(ph${i});
    float c${i} = ${f(w.amp)} * cos(ph${i});
    ${varDx} += c${i} * ${f(w.kx)};
    ${varDz} += c${i} * ${f(w.kz)};
  }\n`;
  });
  return out;
}

const VERT = /* glsl */`
  uniform float uTime;
  varying vec3 vWorld;
  varying float vHeight;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 p = world.xz;
    ${waveGLSL('h', 'dhx', 'dhz', 'p')}
    world.y += h;
    vWorld = world.xyz;
    vHeight = h;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uShore;
  uniform float uTime;
  uniform float uHalf;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSunDir;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHorizon;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorld;
  varying float vHeight;

  // Cheap value noise, used only to break up foam so it never reads as a
  // drawn shape.
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  // Same gradient the sky dome uses, so the reflection matches the sky above.
  vec3 skyAt(vec3 dir) {
    return mix(uSkyHorizon, uSkyTop, pow(clamp(dir.y, 0.0, 1.0), 0.55));
  }

  void main() {
    vec3 view = normalize(cameraPosition - vWorld);
    float dist = length(cameraPosition - vWorld);

    // Rebuild the surface slope from the same waves the vertex stage used.
    vec2 p = vWorld.xz;
    ${waveGLSL('h', 'dhx', 'dhz', 'p')}

    // Two ripple octaves that exist only here. Faded out with distance, or they
    // alias into shimmering noise at the horizon.
    float detail = 1.0 - smoothstep(120.0, 620.0, dist);
    {
      vec2 r1 = p * 0.42 + vec2(uTime * 0.9, -uTime * 0.6);
      vec2 r2 = p * 0.91 + vec2(-uTime * 1.7, uTime * 1.2);
      dhx += (cos(r1.x) * 0.020 + cos(r2.x) * 0.010) * detail;
      dhz += (cos(r1.y) * 0.016 + cos(r2.y) * 0.008) * detail;
    }

    vec3 n = normalize(vec3(-dhx, 1.0, -dhz));

    // R = tight waterline band (foam), G = wide shallow shelf (colour).
    //
    // The mask is built from radial gradients, so sampling it straight gives
    // perfect circles — foam reads as chalk outlines drawn around every rock.
    // Warping the lookup coordinate with noise before sampling makes the same
    // mask produce an irregular, organic shoreline for the cost of two noise
    // taps, and it fixes the shelf boundary and the foam band together.
    vec2 warp = vec2(
      noise(p * 0.030 + vec2(uTime * 0.02, 0.0)),
      noise(p * 0.030 + vec2(17.3, 41.9))
    ) - 0.5;
    vec2 warped = p + warp * 34.0 + vec2(noise(p * 0.11) - 0.5, noise(p * 0.11 + 7.1) - 0.5) * 9.0;
    vec2 uv = (warped / (uHalf * 2.0)) + 0.5;
    vec2 shore = vec2(0.0);
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) shore = texture2D(uShore, uv).rg;

    // Depth ramp, with a subsurface tint where light scatters through a crest.
    vec3 col = mix(uDeep, uShallow, smoothstep(0.04, 0.62, shore.g));
    col += uShallow * 0.16 * smoothstep(0.15, 0.85, vHeight) * (1.0 - shore.g * 0.5);

    // Sky reflection along the reflected ray, weighted by Fresnel. This is what
    // makes water read as a liquid surface rather than a coloured plane.
    vec3 refl = reflect(-view, n);
    refl.y = abs(refl.y);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
    col = mix(col, skyAt(refl), clamp(fres, 0.0, 0.72));

    // Sun: a tight highlight for the specular, and a broad one for the glitter
    // path that runs from the sun to the viewer.
    vec3 sun = normalize(uSunDir);
    vec3 halfV = normalize(sun + view);
    float ndh = max(dot(n, halfV), 0.0);
    col += vec3(1.0, 0.94, 0.80) * pow(ndh, 620.0) * 2.4;
    col += vec3(1.0, 0.92, 0.74) * pow(ndh, 34.0) * 0.16 * detail;

    // Whitecaps, and foam along every shoreline.
    //
    // The crest threshold sits near the TOP of the wave sum's range (total
    // amplitude is about 1.46m). Threshold it near the middle instead and
    // roughly half the wave cycle turns white, which reads as a foaming
    // storm rather than a calm strait.
    float crest = smoothstep(1.02, 1.38, vHeight + noise(p * 0.09 + uTime * 0.12) * 0.18);
    float ripple = sin(p.x * 0.30 + uTime * 2.1) * sin(p.y * 0.27 - uTime * 1.7);
    float shoreFoam = smoothstep(0.30, 0.62, shore.r + ripple * 0.09) *
                      (1.0 - smoothstep(0.80, 0.97, shore.r));
    float foam = clamp(max(shoreFoam * 0.78, crest * 0.34 * detail), 0.0, 1.0);
    foam *= 0.42 + 0.58 * noise(p * 0.42 + uTime * 0.55);
    col = mix(col, vec3(0.95, 0.98, 1.0), foam);

    col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));

    gl_FragColor = vec4(col, 1.0);

    // A raw ShaderMaterial gets none of three's output stages for free; without
    // these its linear colours land on the framebuffer un-encoded and the ocean
    // renders almost black.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** JS twin of the shader's wave sum. Generated from the same table. */
export function sampleWaveHeight(x, z, t) {
  let h = 0;
  for (let i = 0; i < COMPILED.length; i++) {
    const w = COMPILED[i];
    h += w.amp * Math.sin(w.kx * x + w.kz * z - w.w * t);
  }
  return h;
}

/** Analytic surface slope, so hulls pitch and roll on the waves you can see. */
export function sampleWaveSlope(x, z, t) {
  let dx = 0, dz = 0;
  for (let i = 0; i < COMPILED.length; i++) {
    const w = COMPILED[i];
    const c = w.amp * Math.cos(w.kx * x + w.kz * z - w.w * t);
    dx += c * w.kx;
    dz += c * w.kz;
  }
  return { dx, dz };
}

export class Water {
  constructor(quality = 'high') {
    const span = 2600;   // follows the camera, so it only needs to out-reach the fog
    const seg = quality === 'high' ? 190 : 96;
    const geo = new THREE.PlaneGeometry(span, span, seg, seg);
    geo.rotateX(-Math.PI / 2);

    this.uniforms = {
      uTime: { value: 0 },
      uShore: { value: buildShoreMask(quality === 'high' ? 512 : 256) },
      uHalf: { value: CFG.map.half },
      uDeep: { value: new THREE.Color(0x0b3d5e) },
      uShallow: { value: new THREE.Color(0x2fc0cf) },
      uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.30).normalize() },
      uSkyTop: { value: new THREE.Color(0x2f7fb8) },
      uSkyHorizon: { value: new THREE.Color(0xc6e2ee) },
      uFogColor: { value: new THREE.Color(0xc6e2ee) },
      uFogNear: { value: 450 },
      uFogFar: { value: 1240 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
  }

  update(t) { this.uniforms.uTime.value = t; }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.uniforms.uShore.value.dispose();
  }
}
