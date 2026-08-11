// GATE: the analytic charged-rectangle field must match brute-force quadrature
// to better than 0.5% everywhere we care about, including right against the
// face and near the corners. Nothing else in the project is allowed to depend
// on the analytic form until this passes.

import { describe, it, expect } from 'vitest';
import { rectFieldLocal } from '../src/core/rect.js';
import { rectFieldQuadrature } from '../src/core/quadrature.js';

const SIGMA = 1.3; // tesla, i.e. a Br = 1.3 T pole face

/** Relative error of two vectors, measured against the reference magnitude. */
function relErr(a, b) {
  const mag = Math.hypot(b[0], b[1], b[2]);
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return d / mag;
}

// A deliberately non-square face so x/y bugs cannot hide.
const X1 = -10, X2 = 10, Y1 = -2.5, Y2 = 2.5;

function check(px, py, pz, opts, tol = 0.005) {
  const analytic = rectFieldLocal(SIGMA, X1, X2, Y1, Y2, px, py, pz, [0, 0, 0]);
  const ref = rectFieldQuadrature(SIGMA, X1, X2, Y1, Y2, px, py, pz, opts);
  const err = relErr(analytic, ref);
  return { analytic, ref, err };
}

describe('uniformly charged rectangle: analytic vs quadrature', () => {
  it('matches on the face axis across four decades of distance', () => {
    // Near the sheet the integrand is sharply peaked, so the reference needs a
    // lot of tiles to be trustworthy - scale them with 1/z.
    const distances = [0.01, 0.05, 0.2, 1, 3, 10, 30, 100, 500];
    for (const z of distances) {
      const tiles = Math.min(1024, Math.max(64, Math.ceil(40 / z)));
      const { err, analytic, ref } = check(0, 0, z, { tiles, order: 8 });
      expect(err, `on-axis z=${z}mm  analytic=${analytic} ref=${ref}`).toBeLessThan(0.005);
    }
  });

  it('matches at a scatter of off-axis points, both signs of z', () => {
    const pts = [
      [3, 1, 0.5], [7, -2, 2], [-4, 1.7, 8], [12, 0, 4], [0, 6, 1],
      [3, 1, -0.5], [-9, -3, -2.5], [25, 10, 15], [-30, 4, 40],
      [0.3, 0.2, 0.05], [15, 3, 0.02],
    ];
    for (const [x, y, z] of pts) {
      const tiles = Math.min(1024, Math.max(96, Math.ceil(40 / Math.abs(z))));
      const { err } = check(x, y, z, { tiles, order: 8 });
      expect(err, `point ${x},${y},${z}`).toBeLessThan(0.005);
    }
  });

  it('matches very close to the face, over the middle of the sheet', () => {
    // 10 microns off a 20x5 mm face: this is the regime where a naive
    // ln(v + R) implementation loses all its digits.
    for (const z of [0.01, 0.005, 0.001]) {
      for (const [x, y] of [[0, 0], [4, 1], [-6, -1.5]]) {
        const { err } = check(x, y, z, { tiles: 1024, order: 10 });
        expect(err, `near-face ${x},${y},${z}`).toBeLessThan(0.005);
      }
    }
  });

  it('matches near the corners and just outside the edges', () => {
    // The corner (10, 2.5) and the edge midpoints, approached from just above
    // the plane and from just outside in-plane.
    const pts = [
      [9.5, 2.2, 0.05], [10.2, 2.7, 0.05], [10, 2.5, 0.1],
      [10.5, 0, 0.05], [0, 2.8, 0.05], [-10.1, -2.6, 0.2],
      [9.99, 2.49, 0.02],
    ];
    for (const [x, y, z] of pts) {
      const { err } = check(x, y, z, { tiles: 1536, order: 10 });
      expect(err, `corner ${x},${y},${z}`).toBeLessThan(0.005);
    }
  });

  it('reproduces the analytic solid-angle limit on axis', () => {
    // Directly on the axis the double difference collapses to
    //   Bz = (sigma/pi) * atan(ab / (z sqrt(a^2+b^2+z^2)))
    const a = (X2 - X1) / 2;
    const b = (Y2 - Y1) / 2;
    for (const z of [0.1, 1, 5, 50]) {
      const closed = (SIGMA / Math.PI) *
        Math.atan2(a * b, z * Math.sqrt(a * a + b * b + z * z));
      const got = rectFieldLocal(SIGMA, X1, X2, Y1, Y2, 0, 0, z, [0, 0, 0]);
      expect(got[0]).toBeCloseTo(0, 12);
      expect(got[1]).toBeCloseTo(0, 12);
      expect(got[2] / closed).toBeCloseTo(1, 10);
    }
  });

  it('tends to the point-charge limit far away', () => {
    const area = (X2 - X1) * (Y2 - Y1);
    const z = 5000;
    const got = rectFieldLocal(SIGMA, X1, X2, Y1, Y2, 0, 0, z, [0, 0, 0]);
    const point = (SIGMA * area) / (4 * Math.PI * z * z);
    expect(got[2] / point).toBeCloseTo(1, 5);
  });

  it('is antisymmetric in z for the normal component and symmetric in-plane', () => {
    const up = rectFieldLocal(SIGMA, X1, X2, Y1, Y2, 3, 1, 2, [0, 0, 0]);
    const dn = rectFieldLocal(SIGMA, X1, X2, Y1, Y2, 3, 1, -2, [0, 0, 0]);
    expect(dn[0]).toBeCloseTo(up[0], 12);
    expect(dn[1]).toBeCloseTo(up[1], 12);
    expect(dn[2]).toBeCloseTo(-up[2], 12);
  });

  it('returns finite values on the singular edge line', () => {
    // u = z = 0 with v straddling an edge is a genuine log divergence; we only
    // require that it stays finite rather than NaN.
    const b = rectFieldLocal(SIGMA, X1, X2, Y1, Y2, 10, 0, 0, [0, 0, 0]);
    expect(Number.isFinite(b[0])).toBe(true);
    expect(Number.isFinite(b[1])).toBe(true);
    expect(Number.isFinite(b[2])).toBe(true);
  });
});

describe('charged rectangle: square face sanity', () => {
  it('matches quadrature for a square face at close range', () => {
    for (const z of [0.02, 0.3, 2, 20]) {
      const analytic = rectFieldLocal(SIGMA, -3, 3, -3, 3, 1.1, -0.7, z, [0, 0, 0]);
      const ref = rectFieldQuadrature(SIGMA, -3, 3, -3, 3, 1.1, -0.7, z, {
        tiles: Math.max(128, Math.ceil(20 / z)), order: 10,
      });
      expect(relErr(analytic, ref), `square z=${z}`).toBeLessThan(0.005);
    }
  });
});
