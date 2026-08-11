// The nail shader: an anisotropic fibre BRDF driven entirely by the computed
// field.
//
// Each texel carries the chain direction (unit B), the tilt of that chain from
// the surface normal, the local particle concentration and the alignment order.
// The specular lobe is Kajiya-Kay, whose tangent IS the chain direction, so
// every visual behaviour below is a consequence of the physics rather than a
// hand-authored effect:
//
//  * Standing pile, viewed head on. The fibre points at you, so angle(T,V) ~ 0
//    and the Kajiya-Kay condition angle(T,L) + angle(T,V) = pi cannot be met
//    for any light above the horizon. No sheen - you see between the fibres,
//    down to the base coat.
//  * The same pile at a grazing view with the light grazing from the far side.
//    Now both angles approach 90 degrees, their sum reaches pi, and the sheen
//    switches on. That is the reverse-velvet flare.
//  * Fibres whose lean changes across the nail behave as a curved mirror array.
//    If the lean opens outward the array is convex and the sheen tracks the
//    light; if it closes inward the array is concave and the sheen
//    counter-tracks. Nothing in the shader encodes this - it falls out of where
//    the reflection condition is satisfied across a varying tangent field.

import * as THREE from 'three';

export const CHANNELS = ['shaded', '|B|', 'tilt', 'concentration', 'order', 'chain'];

const vert = /* glsl */`
attribute vec3 aChain;
attribute float aTilt;
attribute float aConc;
attribute float aOrder;
attribute float aBnorm;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vChain;
varying float vTilt;
varying float vConc;
varying float vOrder;
varying float vBnorm;

void main() {
  // The nail geometry is authored directly in world millimetres and the mesh
  // is left at identity, so no normal matrix juggling is needed.
  vWorld = position;
  vNormal = normal;
  vChain = aChain;
  vTilt = aTilt;
  vConc = aConc;
  vOrder = aOrder;
  vBnorm = aBnorm;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */`
uniform vec3 uLightPos;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform vec3 uBaseColor;
uniform vec3 uSheenColor;
uniform vec3 uFlakeColor;
uniform float uSheenExp;
uniform float uSheenGain;
uniform float uCoverPow;
uniform float uCoverage;
uniform float uConcStrength;
uniform float uAmbient;
uniform float uClearcoat;
uniform float uRoughness;
uniform float uGlitter;
uniform int uChannel;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vChain;
varying float vTilt;
varying float vConc;
varying float vOrder;
varying float vBnorm;

// Perceptual ramp for the data channels.
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.05, 0.03, 0.20);
  vec3 c1 = vec3(0.13, 0.42, 0.66);
  vec3 c2 = vec3(0.20, 0.72, 0.55);
  vec3 c3 = vec3(0.85, 0.85, 0.22);
  vec3 c4 = vec3(0.99, 0.99, 0.85);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N;           // the nail is drawn double sided
  // Safe normalize: distance 0 and height 0 puts the light exactly on the
  // surface, and normalize(vec3(0)) is NaN - which would blow a hole in the nail.
  vec3 Lv = uLightPos - vWorld;
  float Ldist = length(Lv);
  vec3 L = Ldist > 1e-6 ? Lv / Ldist : N;

  vec3 T = normalize(vChain);

  // --- Kajiya-Kay fibre specular ------------------------------------------
  // Both products are even under T -> -T, so the lobe is orientation free.
  // Flakes are nematic rods; the sign of B carries no extra information.
  float cosTL = dot(T, L);
  float cosTV = dot(T, V);
  float sinTL = sqrt(max(0.0, 1.0 - cosTL * cosTL));
  float sinTV = sqrt(max(0.0, 1.0 - cosTV * cosTV));
  float kk = max(0.0, sinTL * sinTV - cosTL * cosTV);
  float fibreSpec = pow(kk, uSheenExp);

  // --- How much of the base coat the pile hides ----------------------------
  // Looking down the fibre axis you see past the pile; side on it closes up.
  float aim = abs(cosTV);
  float cover = clamp((1.0 - pow(aim, uCoverPow)) * uCoverage * vOrder, 0.0, 1.0);

  // Concentration modulates albedo, so bunching reads as a bright line.
  float cg = mix(1.0 - uConcStrength, 1.0 + uConcStrength, vConc);

  float ndl = max(dot(N, L), 0.0);
  float I = uLightIntensity;

  vec3 baseCol = uBaseColor * (uAmbient + ndl * I);
  vec3 flakeCol = uFlakeColor * (uAmbient + ndl * 0.7 * I) * cg;
  vec3 col = mix(baseCol, flakeCol, cover);

  // The sheen itself.
  col += uSheenColor * uLightColor * fibreSpec * vOrder * cg * uSheenGain * I;

  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);

  // Where the field is too weak to align anything, the flakes stay random and
  // scatter into a dull isotropic glitter instead of a directional sheen.
  col += uSheenColor * pow(ndh, 30.0) * (1.0 - vOrder) * uGlitter * I;

  // --- Clear top coat ------------------------------------------------------
  float a = max(1e-3, uRoughness * uRoughness);
  float d = ndh * ndh * (a * a - 1.0) + 1.0;
  float D = (a * a) / (3.14159265 * d * d);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  col += uClearcoat * D * F * uLightColor * I;

  // A cheap sky term so the gloss has something to reflect at grazing angles.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += uClearcoat * 0.5 * fres * vec3(0.35, 0.45, 0.62);

  // Data channels replace the shaded result rather than returning early, so
  // that every path still runs through tone mapping and the output transform.
  if (uChannel == 1) col = ramp(vBnorm);
  else if (uChannel == 2) col = ramp(vTilt / 90.0);
  else if (uChannel == 3) col = ramp(vConc);
  else if (uChannel == 4) col = ramp(vOrder);
  else if (uChannel == 5) col = abs(T);

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createNailMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.DoubleSide,
    uniforms: {
      uLightPos: { value: new THREE.Vector3(30, -30, 45) },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uLightIntensity: { value: 1.0 },
      uBaseColor: { value: new THREE.Color(0x121a2e) },
      uSheenColor: { value: new THREE.Color(0xbfd4ff) },
      uFlakeColor: { value: new THREE.Color(0x2a3550) },
      uSheenExp: { value: 42 },
      uSheenGain: { value: 1.5 },
      uCoverPow: { value: 2.2 },
      uCoverage: { value: 0.95 },
      uConcStrength: { value: 0.85 },
      uAmbient: { value: 0.10 },
      uClearcoat: { value: 0.35 },
      uRoughness: { value: 0.16 },
      uGlitter: { value: 0.22 },
      uChannel: { value: 0 },
    },
  });
}
