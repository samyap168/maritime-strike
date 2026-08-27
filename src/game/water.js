/**
 * The ocean.
 *
 * Water is the single largest thing on screen for the entire match, so it gets
 * a real shader — but a cheap one. Four summed sine waves displace a plane in
 * the vertex stage; the fragment stage does a depth-ish colour ramp, a foam
 * band along every shoreline, and one specular highlight. No reflections, no
 * refraction, no render targets — it holds 60fps on integrated graphics.
 *
 * sampleWaveHeight() mirrors the vertex maths in JS so hulls bob on the same
 * waves you can see, which is most of why the boats feel like boats.
 */

import * as THREE from 'three';
import { CFG } from '../config.js';
import { buildShoreMask } from './world.js';

const VERT = /* glsl */`
  uniform float uTime;
  varying vec3 vWorld;
  varying float vHeight;

  float waveAt(vec2 p, float t) {
    float h = 0.0;
    h += sin(p.x * 0.035 + t * 0.90) * 0.55;
    h += sin(p.y * 0.028 - t * 0.75) * 0.48;
    h += sin((p.x + p.y) * 0.052 + t * 1.35) * 0.28;
    h += sin((p.x - p.y * 0.6) * 0.090 - t * 1.90) * 0.12;
    return h;
  }

  void main() {
    vec3 p = position;
    vec4 world = modelMatrix * vec4(p, 1.0);
    float h = waveAt(world.xz, uTime);
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
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorld;
  varying float vHeight;

  void main() {
    vec2 uv = (vWorld.xz / (uHalf * 2.0)) + 0.5;
    // R = tight waterline band (foam), G = wide shallow shelf (colour).
    vec2 shore = vec2(0.0);
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      shore = texture2D(uShore, uv).rg;
    }

    // Turquoise in the shallows, deep blue offshore.
    vec3 col = mix(uDeep, uShallow, smoothstep(0.04, 0.62, shore.g));

    // Foam: a narrow band hugging the waterline, broken up by a moving ripple
    // so it never reads as a clean drawn circle.
    float ripple = sin(vWorld.x * 0.30 + uTime * 2.1) * sin(vWorld.z * 0.27 - uTime * 1.7);
    float foamBand = smoothstep(0.30, 0.62, shore.r + ripple * 0.09) *
                     (1.0 - smoothstep(0.80, 0.97, shore.r));
    col = mix(col, vec3(0.94, 0.97, 0.99), clamp(foamBand, 0.0, 1.0) * 0.8);

    // Crest lightening — reads as swell moving across open water.
    col += vec3(0.05, 0.08, 0.09) * smoothstep(0.25, 0.75, vHeight);

    // One cheap specular lobe from the sun.
    vec3 view = normalize(cameraPosition - vWorld);
    vec3 n = normalize(vec3(
      -cos(vWorld.x * 0.035 + uTime * 0.9) * 0.019,
      1.0,
      -cos(vWorld.z * 0.028 - uTime * 0.75) * 0.014
    ));
    float spec = pow(max(dot(reflect(-normalize(uSun), n), view), 0.0), 42.0);
    col += vec3(1.0, 0.96, 0.86) * spec * 0.55;

    // Slight fresnel brightening toward the horizon.
    col = mix(col, vec3(0.62, 0.76, 0.86), pow(1.0 - max(dot(n, view), 0.0), 4.0) * 0.45);

    float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));
    col = mix(col, uFogColor, fog);

    gl_FragColor = vec4(col, 1.0);

    // The water is a raw ShaderMaterial, so it does not get three's output
    // stages for free. Without these two chunks its linear colours are written
    // straight to the framebuffer and the ocean renders almost black, while
    // every lit material around it looks correct.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** JS twin of the shader's wave function — keep these two in sync. */
export function sampleWaveHeight(x, z, t) {
  return (
    Math.sin(x * 0.035 + t * 0.90) * 0.55 +
    Math.sin(z * 0.028 - t * 0.75) * 0.48 +
    Math.sin((x + z) * 0.052 + t * 1.35) * 0.28 +
    Math.sin((x - z * 0.6) * 0.090 - t * 1.90) * 0.12
  );
}

/** Approximate surface tilt, so hulls pitch and roll with the swell. */
export function sampleWaveSlope(x, z, t, spread = 6) {
  const hx = sampleWaveHeight(x + spread, z, t) - sampleWaveHeight(x - spread, z, t);
  const hz = sampleWaveHeight(x, z + spread, t) - sampleWaveHeight(x, z - spread, t);
  return { dx: hx / (2 * spread), dz: hz / (2 * spread) };
}

export class Water {
  constructor(quality = 'high') {
    const span = 2600;   // follows the camera, so it only needs to out-reach the fog
    const seg = quality === 'high' ? 170 : 90;
    const geo = new THREE.PlaneGeometry(span, span, seg, seg);
    geo.rotateX(-Math.PI / 2);

    this.uniforms = {
      uTime: { value: 0 },
      uShore: { value: buildShoreMask(quality === 'high' ? 512 : 256) },
      uHalf: { value: CFG.map.half },
      uDeep: { value: new THREE.Color(0x11557f) },
      uShallow: { value: new THREE.Color(0x2fc0cf) },
      uSun: { value: new THREE.Vector3(0.45, 0.75, 0.3).normalize() },
      uFogColor: { value: new THREE.Color(0x9fc9de) },
      uFogNear: { value: 420 },
      uFogFar: { value: 1250 },
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
