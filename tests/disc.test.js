// The circular pole face (axially magnetised disc magnet).
//
// The runtime path (disc.js) does the azimuthal integral analytically, leaving
// a 1D radial quadrature. These tests pin it against three independent things:
// the exact on-axis solid-angle result, known values of the elliptic integrals,
// and brute-force 2D quadrature over the face.

import { describe, it, expect } from 'vitest';
import { discFieldLocal, ellipKE, ringIntegral } from '../src/core/disc.js';
import { discFieldQuadrature } from '../src/core/quadrature.js';

const SIGMA = 1.3;
const A = 5; // disc radius, mm

/** Exact on-axis field of a uniformly charged disc: (sigma/2)(1 - z/sqrt(a^2+z^2)). */
const axialExact = (z) =>
  (SIGMA / 2) * (1 - Math.abs(z) / Math.sqrt(A * A + z * z)) * Math.sign(z);

function relErr(a, b) {
  const mag = Math.hypot(b[0], b[1], b[2]);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / mag;
}

describe('complete elliptic integrals', () => {
  it('matches known values', () => {
    // m = 0: both are pi/2.
    let r = ellipKE(0);
    expect(r.K).toBeCloseTo(Math.PI / 2, 14);
    expect(r.E).toBeCloseTo(Math.PI / 2, 14);

    // m = 1/2: K = 1.8540746773013719, E = 1.3506438810476755
    r = ellipKE(0.5);
    expect(r.K).toBeCloseTo(1.8540746773013719, 12);
    expect(r.E).toBeCloseTo(1.3506438810476755, 12);

    // m = 0.9: K = 2.5780921133481733, E = 1.1047747327040733
    r = ellipKE(0.9);
    expect(r.K).toBeCloseTo(2.5780921133481733, 11);
    expect(r.E).toBeCloseTo(1.1047747327040733, 11);

    // m -> 1: E -> 1 exactly, K diverges but must stay finite and large.
    r = ellipKE(1);
    expect(r.E).toBeCloseTo(1, 6);
    expect(Number.isFinite(r.K)).toBe(true);
    expect(r.K).toBeGreaterThan(15);
  });

  it('K is increasing and E decreasing in m', () => {
    let pk = -Infinity;
    let pe = Infinity;
    for (let m = 0; m < 0.999; m += 0.02) {
      const { K, E } = ellipKE(m);
      expect(K).toBeGreaterThan(pk);
      expect(E).toBeLessThan(pe);
      pk = K;
      pe = E;
    }
  });
});

describe('charged ring', () => {
  it('reduces to the textbook on-axis ring field', () => {
    // On axis, INT dtheta of z/|p-r'|^3 = 2 pi z / (r^2 + z^2)^{3/2}.
    for (const r of [1, 3, 7]) {
      for (const z of [0.5, 2, 9]) {
        const [rad, ax] = ringIntegral(0, z, r);
        expect(rad).toBe(0);
        expect(ax).toBeCloseTo((2 * Math.PI * z) / Math.pow(r * r + z * z, 1.5), 10);
      }
    }
  });

  it('is antisymmetric in z for the axial part, symmetric for the radial', () => {
    const up = ringIntegral(2.5, 1.4, 4);
    const dn = ringIntegral(2.5, -1.4, 4);
    expect(dn[0]).toBeCloseTo(up[0], 12);
    expect(dn[1]).toBeCloseTo(-up[1], 12);
  });
});

describe('charged disc face', () => {
  it('matches the exact on-axis solid-angle result', () => {
    for (const z of [0.001, 0.05, 0.2, 1, 3, 5, 12, 40, 200]) {
      const got = discFieldLocal(SIGMA, A, 0, 0, z, [0, 0, 0]);
      expect(got[0]).toBeCloseTo(0, 12);
      expect(got[1]).toBeCloseTo(0, 12);
      expect(Math.abs(got[2] / axialExact(z) - 1), `z=${z}`).toBeLessThan(1e-6);
    }
  });

  it('is antisymmetric in z on axis', () => {
    const up = discFieldLocal(SIGMA, A, 0, 0, 4, [0, 0, 0]);
    const dn = discFieldLocal(SIGMA, A, 0, 0, -4, [0, 0, 0]);
    expect(dn[2]).toBeCloseTo(-up[2], 12);
  });

  it('matches brute-force 2D quadrature off axis', () => {
    const pts = [
      [1, 0, 0.5], [4.5, 0, 1], [5.2, 0, 0.3], [3, 3, 2],
      [8, -2, 6], [0.5, 0.5, 0.1], [12, 4, 20], [6, 0, -1.5],
      [2, -1, 0.02], [4.9, 0.2, 0.05], [0, 4.99, 0.2],
    ];
    for (const [x, y, z] of pts) {
      const fast = discFieldLocal(SIGMA, A, x, y, z, [0, 0, 0]);
      const ref = discFieldQuadrature(SIGMA, A, x, y, z, [0, 0, 0]);
      expect(relErr(fast, ref), `pt ${x},${y},${z}`).toBeLessThan(0.005);
    }
  });

  it('agrees with a heavily oversampled fixed rule', () => {
    for (const [x, y, z] of [[3, 1, 4], [7, 0, 2], [1, 1, 8]]) {
      const fast = discFieldLocal(SIGMA, A, x, y, z, [0, 0, 0]);
      const ref = discFieldQuadrature(SIGMA, A, x, y, z, [0, 0, 0], { nr: 400, nt: 900 });
      expect(relErr(fast, ref), `pt ${x},${y},${z}`).toBeLessThan(1e-4);
    }
  });

  it('tends to the point-charge limit far away', () => {
    const z = 2000;
    const got = discFieldLocal(SIGMA, A, 0, 0, z, [0, 0, 0]);
    const point = (SIGMA * Math.PI * A * A) / (4 * Math.PI * z * z);
    expect(got[2] / point).toBeCloseTo(1, 5);
  });

  it('approaches sigma/2 just off the face and 0 just outside the rim', () => {
    // The infinite-sheet limit over the interior...
    expect(discFieldLocal(SIGMA, A, 0, 0, 1e-4, [0, 0, 0])[2])
      .toBeCloseTo(SIGMA / 2, 4);
    expect(discFieldLocal(SIGMA, A, 2, 0, 1e-4, [0, 0, 0])[2])
      .toBeCloseTo(SIGMA / 2, 3);
    // ...and no normal component just outside it.
    expect(Math.abs(discFieldLocal(SIGMA, A, 8, 0, 1e-6, [0, 0, 0])[2]))
      .toBeLessThan(1e-4);
  });

  it('stays finite on the rim singularity', () => {
    const b = discFieldLocal(SIGMA, A, A, 0, 0, [0, 0, 0]);
    expect(Number.isFinite(b[0])).toBe(true);
    expect(Number.isFinite(b[1])).toBe(true);
    expect(Number.isFinite(b[2])).toBe(true);
  });

  it('scales exactly with sigma and with geometric size', () => {
    const a = discFieldLocal(1, A, 2, 1, 3, [0, 0, 0]);
    const b = discFieldLocal(2.5, A, 2, 1, 3, [0, 0, 0]);
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(2.5 * a[i], 12);

    // B is scale invariant: doubling every length leaves it unchanged.
    const c = discFieldLocal(1, 2 * A, 4, 2, 6, [0, 0, 0]);
    for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(a[i], 10);
  });
});
