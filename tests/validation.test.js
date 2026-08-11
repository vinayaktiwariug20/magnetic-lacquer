// The four validation tests from the spec, plus the Maxwell identities that
// underwrite them.

import { describe, it, expect } from 'vitest';
import {
  createMagnet, axialBoxFieldReference, insideAnyMagnet, MAGNET_TYPES,
} from '../src/core/magnet.js';
import {
  buildFaces, sampleB, sampleFaces, forceOnMagnet, streamline, divB, curlB,
  findNull, gradBMag, len,
} from '../src/core/field.js';
import { buildNailGrid } from '../src/core/nail.js';
import { computeFinish } from '../src/core/finish.js';
import { PRESETS } from '../src/core/presets.js';
import { quatFromAxisAngle, quatRotate, norm, dot } from '../src/core/vec.js';

// ---------------------------------------------------------------------------
// TEST 1 - single cuboid against the closed-form axial formula
// ---------------------------------------------------------------------------

describe('Test 1: single cuboid vs closed-form axial field', () => {
  const Br = 1.3;
  const size = { sx: 12, sy: 8, sz: 5 };

  it('matches on the magnetisation axis at all standoffs', () => {
    const m = createMagnet({ type: 'box', position: [0, 0, 0], Br, size });
    const faces = buildFaces([m]);

    for (const z of [2.6, 3, 4, 6, 10, 20, 50, 200]) {
      const got = sampleFaces(faces, [0, 0, z], [0, 0, 0]);
      const ref = axialBoxFieldReference(Br, size.sx, size.sy, size.sz, z);
      expect(got[0]).toBeCloseTo(0, 12);
      expect(got[1]).toBeCloseTo(0, 12);
      expect(Math.abs(got[2] / ref - 1), `z=${z}mm`).toBeLessThan(1e-9);
    }
  });

  it('still matches when the magnet is translated and rotated arbitrarily', () => {
    // Same physics through the full transform path: build a rotated, offset
    // magnet and sample along its own axis.
    const q = quatFromAxisAngle([0.3, 1, -0.6], 0.9);
    const pos = [13, -7, 4];
    const m = createMagnet({ type: 'box', position: pos, quaternion: q, Br, size });
    const faces = buildFaces([m]);
    const axis = quatRotate(q, [0, 0, 1]);

    for (const z of [3, 5, 9, 25, 80]) {
      const p = [pos[0] + axis[0] * z, pos[1] + axis[1] * z, pos[2] + axis[2] * z];
      const got = sampleFaces(faces, p, [0, 0, 0]);
      const ref = axialBoxFieldReference(Br, size.sx, size.sy, size.sz, z);

      // Field must be along the magnetisation axis, with the reference size.
      expect(Math.abs(dot(got, axis) / ref - 1), `z=${z}`).toBeLessThan(1e-9);
      const perp = Math.hypot(
        got[0] - axis[0] * dot(got, axis),
        got[1] - axis[1] * dot(got, axis),
        got[2] - axis[2] * dot(got, axis),
      );
      expect(perp / Math.abs(ref)).toBeLessThan(1e-9);
    }
  });

  it('flipping N-S negates the field', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], Br, size });
    const b = createMagnet({ type: 'box', position: [0, 0, 0], Br, size, flip: true });
    const pa = sampleB([a], [3, 2, 7]);
    const pb = sampleB([b], [3, 2, 7]);
    for (let i = 0; i < 3; i++) expect(pb[i]).toBeCloseTo(-pa[i], 12);
  });

  it('gives a sane field magnitude for a real NdFeB bar', () => {
    // Sanity anchor: ~0.2-0.5 T a couple of mm off the face of a 1.3 T N42
    // block is the right ballpark for a cat-eye wand.
    const m = createMagnet({ type: 'box', position: [0, 0, 0], Br, size });
    const b = len(sampleB([m], [0, 0, size.sz / 2 + 2]));
    expect(b).toBeGreaterThan(0.15);
    expect(b).toBeLessThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// TEST 2 - lateral force between two side-by-side magnets
// ---------------------------------------------------------------------------

describe('Test 2: side-by-side magnets, lateral force sign', () => {
  const size = { sx: 8, sy: 8, sz: 4 };
  const GAP = 10; // centre-to-centre along x

  const pair = (flipSecond) => [
    createMagnet({ type: 'box', position: [-GAP / 2, 0, 0], size }),
    createMagnet({ type: 'box', position: [GAP / 2, 0, 0], size, flip: flipSecond }),
  ];

  it('repels when both point the same way (like poles adjacent)', () => {
    const [a, b] = pair(false);
    const Fb = forceOnMagnet(b, [a]);
    const Fa = forceOnMagnet(a, [b]);

    // Right-hand magnet pushed further right, left-hand magnet pushed left.
    expect(Fb[0]).toBeGreaterThan(0);
    expect(Fa[0]).toBeLessThan(0);

    // Newton's third law.
    expect(Fa[0]).toBeCloseTo(-Fb[0], 6);

    // Purely lateral by symmetry.
    expect(Math.abs(Fb[1])).toBeLessThan(Math.abs(Fb[0]) * 1e-6);
    expect(Math.abs(Fb[2])).toBeLessThan(Math.abs(Fb[0]) * 1e-6);
  });

  it('attracts when the second is flipped (opposite polarity)', () => {
    const [a, b] = pair(true);
    const Fb = forceOnMagnet(b, [a]);
    const Fa = forceOnMagnet(a, [b]);

    expect(Fb[0]).toBeLessThan(0); // pulled back toward the left magnet
    expect(Fa[0]).toBeGreaterThan(0);
    expect(Fa[0]).toBeCloseTo(-Fb[0], 6);
  });

  it('force magnitude is equal and opposite between the two cases', () => {
    const same = forceOnMagnet(pair(false)[1], [pair(false)[0]]);
    const opp = forceOnMagnet(pair(true)[1], [pair(true)[0]]);
    expect(same[0]).toBeCloseTo(-opp[0], 9);
  });

  it('falls off steeply with separation', () => {
    const f = (gap) => {
      const a = createMagnet({ type: 'box', position: [-gap / 2, 0, 0], size });
      const b = createMagnet({ type: 'box', position: [gap / 2, 0, 0], size });
      return forceOnMagnet(b, [a])[0];
    };
    const near = f(10);
    const far = f(20);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near / far).toBeGreaterThan(4); // dipole-dipole is ~1/r^4
  });

  it('coaxial magnets attract when N faces S', () => {
    // Cross-check the force integrator on the configuration everyone knows.
    const a = createMagnet({ type: 'box', position: [0, 0, -6], size });
    const b = createMagnet({ type: 'box', position: [0, 0, 6], size });
    const F = forceOnMagnet(b, [a]); // both N up: N of lower faces S of upper
    expect(F[2]).toBeLessThan(0);    // upper magnet pulled down
  });
});

// ---------------------------------------------------------------------------
// TEST 3 - like poles facing across a gap: null point at the centre
// ---------------------------------------------------------------------------

describe('Test 3: like poles facing across a gap', () => {
  const size = { sx: 10, sy: 10, sz: 6 };
  const D = 9; // centre offset along z

  // Lower magnet N up, upper magnet N down -> north faces north across the gap.
  const magnets = [
    createMagnet({ type: 'box', position: [0, 0, -D], size }),
    createMagnet({ type: 'box', position: [0, 0, D], size, flip: true }),
  ];
  const faces = buildFaces(magnets);

  it('has a true null at the geometric centre', () => {
    const b = sampleFaces(faces, [0, 0, 0], [0, 0, 0]);
    expect(len(b)).toBeLessThan(1e-12);
  });

  it('the null is isolated - field grows away from it in every direction', () => {
    for (const r of [0.5, 1, 2, 4]) {
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.6, 0.8, 0]]) {
        const p = [d[0] * r, d[1] * r, d[2] * r];
        expect(len(sampleFaces(faces, p, [0, 0, 0])), `r=${r}`).toBeGreaterThan(1e-5);
      }
    }
  });

  it('Newton converges to the null from scattered starts', () => {
    for (const seed of [[2, 1, 1.5], [-3, 2, -2], [0.5, -0.5, 3]]) {
      const p = findNull(faces, seed, { tol: 1e-9 });
      expect(p).not.toBeNull();
      expect(Math.hypot(p[0], p[1], p[2])).toBeLessThan(1e-4);
    }
  });

  it('just off the null ALONG the axis, B is perpendicular to the mid-plane', () => {
    // Moving off the mid-plane, the field is purely normal to it (+/-z).
    for (const z of [0.25, 0.5, 1, 2]) {
      for (const s of [1, -1]) {
        const b = sampleFaces(faces, [0, 0, s * z], [0, 0, 0]);
        const mag = len(b);
        expect(mag).toBeGreaterThan(0);
        expect(Math.abs(b[0]) / mag).toBeLessThan(1e-9);
        expect(Math.abs(b[1]) / mag).toBeLessThan(1e-9);
        // Pushed away from whichever like pole you moved toward.
        expect(Math.sign(b[2])).toBe(-s);
      }
    }
  });

  it('within the mid-plane the field is tangent to it and points radially out', () => {
    // The complementary statement: on z = 0 the normal component cancels by
    // symmetry, so the field lies IN the mid-plane, streaming radially away
    // from the null. Together with the test above this is the saddle.
    for (const r of [0.5, 1, 3, 6]) {
      for (const th of [0, 0.7, 1.9, 3.6, 5.1]) {
        const p = [r * Math.cos(th), r * Math.sin(th), 0];
        const b = sampleFaces(faces, p, [0, 0, 0]);
        const mag = len(b);
        expect(Math.abs(b[2]) / mag, `r=${r} th=${th}`).toBeLessThan(1e-9);
        const radial = (b[0] * p[0] + b[1] * p[1]) / (r * mag);
        expect(radial).toBeGreaterThan(0.999);
      }
    }
  });

  it('opposite poles facing instead give NO null and a strong axial field', () => {
    const attract = [
      createMagnet({ type: 'box', position: [0, 0, -D], size }),
      createMagnet({ type: 'box', position: [0, 0, D], size }),
    ];
    const b = sampleB(attract, [0, 0, 0]);
    expect(len(b)).toBeGreaterThan(0.05);
    expect(Math.abs(b[2]) / len(b)).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// TEST 4 - field lines never cross
// ---------------------------------------------------------------------------

/**
 * Do open segments p1-p2 and q1-q2 properly cross in 2D, at a real angle?
 *
 * The angle test matters. Two polylines that are numerically retracing the
 * SAME field line weave across each other at ~0 degrees dozens of times; that
 * is integrator jitter, not a violation. A genuine crossing means two distinct
 * field directions at one point, which is a transversal intersection.
 */
function segmentsCross(p1, p2, q1, q2, minAngleDeg = 5) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(q1, q2, p1);
  const d2 = o(q1, q2, p2);
  const d3 = o(p1, p2, q1);
  const d4 = o(p1, p2, q2);
  const proper = ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                 ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  if (!proper) return false;

  const u = [p2[0] - p1[0], p2[1] - p1[1]];
  const v = [q2[0] - q1[0], q2[1] - q1[1]];
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (lu === 0 || lv === 0) return false;
  // Field lines are unoriented for this purpose, so fold to [0, 90].
  const c = Math.abs((u[0] * v[0] + u[1] * v[1]) / (lu * lv));
  const ang = Math.acos(Math.min(1, c)) * 180 / Math.PI;
  return ang > minAngleDeg;
}

/**
 * Trace a fan of field lines confined to the y = 0 symmetry plane and count
 * crossings between distinct lines. Segments whose endpoints sit in a weak
 * field are excluded: at a null the direction is undefined and lines are
 * genuinely allowed to meet.
 */
function crossingsInSymmetryPlane(magnets, seeds, opts = {}) {
  const faces = buildFaces(magnets);
  const nullB = opts.nullB ?? 2e-3;
  const lines = [];

  for (const seed of seeds) {
    for (const dir of [1, -1]) {
      const { points } = streamline(faces, seed, {
        dir,
        step: opts.step ?? 0.25,
        maxSteps: opts.maxSteps ?? 1200,
        bound: opts.bound ?? 90,
        stop: (p) => insideAnyMagnet(magnets, p, 0.05),
      });
      if (points.length < 3) continue;
      lines.push(points.map((p) => {
        const b = len(sampleFaces(faces, p, [0, 0, 0]));
        return { xz: [p[0], p[2]], y: p[1], weak: b < nullB };
      }));
    }
  }

  let crossings = 0;
  let maxDrift = 0;
  for (const line of lines) for (const s of line) maxDrift = Math.max(maxDrift, Math.abs(s.y));

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i];
      const B = lines[j];
      for (let a = 0; a + 1 < A.length; a++) {
        if (A[a].weak || A[a + 1].weak) continue;
        for (let b = 0; b + 1 < B.length; b++) {
          if (B[b].weak || B[b + 1].weak) continue;
          if (segmentsCross(A[a].xz, A[a + 1].xz, B[b].xz, B[b + 1].xz)) crossings++;
        }
      }
    }
  }
  return { crossings, lines: lines.length, maxDrift };
}

describe('Test 4: field lines never cross', () => {
  // NOTE on seeding: seeds must lie on a surface that each field line crosses
  // exactly ONCE. Seeding on a circle around a bar magnet is wrong - every
  // field line leaves and re-enters that circle, so seeds come in pairs on the
  // same line and you end up comparing a line against a second, jittery copy of
  // itself. The equatorial / mid plane is the right choice: the field is
  // strictly perpendicular to it, so lines pass through exactly once.

  it('single bar magnet: 60 distinct field lines produce zero crossings', () => {
    const m = createMagnet({
      type: 'box', position: [0, 0, 0], size: { sx: 20, sy: 6, sz: 4 },
    });
    // z = 0 outside the magnet: field is purely -z, so one crossing per line.
    const seeds = [];
    for (let i = 0; i < 30; i++) {
      const x = 11 + i * 1.4;
      seeds.push([x, 0, 0]);
      seeds.push([-x, 0, 0]);
    }
    const { crossings, lines, maxDrift } = crossingsInSymmetryPlane([m], seeds);
    expect(lines).toBeGreaterThan(100);
    expect(maxDrift).toBeLessThan(1e-9); // stayed in the symmetry plane
    expect(crossings).toBe(0);
  });

  it('two like poles facing across a gap: zero crossings away from the null', () => {
    const size = { sx: 10, sy: 10, sz: 6 };
    const magnets = [
      createMagnet({ type: 'box', position: [0, 0, -9], size }),
      createMagnet({ type: 'box', position: [0, 0, 9], size, flip: true }),
    ];
    // The mid-plane field is purely radial, so again exactly one crossing per
    // line. Start clear of the null at the origin.
    const seeds = [];
    for (let i = 0; i < 22; i++) {
      const x = 1.5 + i * 1.6;
      seeds.push([x, 0, 0]);
      seeds.push([-x, 0, 0]);
    }
    const { crossings, maxDrift } = crossingsInSymmetryPlane(magnets, seeds, {
      nullB: 5e-3,
    });
    expect(maxDrift).toBeLessThan(1e-9);
    expect(crossings).toBe(0);
  });

  it('three magnets in a messy arrangement: zero crossings', () => {
    const magnets = [
      createMagnet({ type: 'box', position: [-12, 0, 5], size: { sx: 8, sy: 6, sz: 3 } }),
      createMagnet({
        type: 'box', position: [10, 0, -4], size: { sx: 6, sy: 6, sz: 6 }, flip: true,
        quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 3),
      }),
      createMagnet({ type: 'cylinder', position: [0, 0, 14], size: { radius: 5, height: 4 } }),
    ];
    // No surface here is crossed exactly once by every line, so duplicate
    // traces are expected; the transversality criterion in segmentsCross is
    // what makes the assertion meaningful anyway.
    const seeds = [];
    for (let i = 0; i < 24; i++) {
      const th = (i / 24) * 2 * Math.PI;
      seeds.push([28 * Math.cos(th), 0, 28 * Math.sin(th)]);
    }
    const { crossings, maxDrift } = crossingsInSymmetryPlane(magnets, seeds, {
      step: 0.3, maxSteps: 900,
    });
    expect(maxDrift).toBeLessThan(1e-6);
    expect(crossings).toBe(0);
  });

  it('nearby seeds never merge onto one another', () => {
    // The stronger statement behind "lines do not cross": two lines started a
    // hair apart stay apart, because the direction field is single valued.
    const m = createMagnet({ type: 'box', position: [0, 0, 0], size: { sx: 20, sy: 6, sz: 4 } });
    const faces = buildFaces([m]);
    const opts = {
      step: 0.2, maxSteps: 500, bound: 90,
      stop: (p) => insideAnyMagnet([m], p, 0.05),
    };
    const a = streamline(faces, [8, 0, 8], opts).points;
    const b = streamline(faces, [8.05, 0, 8], opts).points;
    const n = Math.min(a.length, b.length);
    let minSep = Infinity;
    for (let i = 0; i < n; i++) {
      minSep = Math.min(minSep, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]));
    }
    expect(minSep).toBeGreaterThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Maxwell identities - the reason Test 4 can pass at all
// ---------------------------------------------------------------------------

describe('Maxwell identities outside the magnets', () => {
  const magnets = [
    createMagnet({ type: 'box', position: [-8, 2, 3], size: { sx: 12, sy: 5, sz: 3 } }),
    createMagnet({
      type: 'box', position: [7, -3, -2], size: { sx: 6, sy: 6, sz: 8 }, flip: true,
      quaternion: quatFromAxisAngle([1, 0.4, 0.2], 0.8),
    }),
  ];
  const faces = buildFaces(magnets);

  const probes = [
    [0, 0, 10], [4, 5, 6], [-14, -6, 9], [20, 3, -8], [2, -12, 4], [-3, 8, -11],
  ];

  it('div B is zero (no monopoles, so lines cannot start or stop in space)', () => {
    for (const p of probes) {
      const scale = len(sampleFaces(faces, p, [0, 0, 0])) / 1.0; // per mm
      expect(Math.abs(divB(faces, p, 0.02)), `p=${p}`).toBeLessThan(1e-3 * (scale + 0.01));
    }
  });

  it('curl B is zero in current-free space', () => {
    for (const p of probes) {
      const c = curlB(faces, p, 0.02);
      const scale = len(sampleFaces(faces, p, [0, 0, 0]));
      expect(Math.hypot(c[0], c[1], c[2]), `p=${p}`).toBeLessThan(1e-3 * (scale + 0.01));
    }
  });

  it('superposition is exact', () => {
    const p = [3, 4, 9];
    const both = sampleB(magnets, p);
    const a = sampleB([magnets[0]], p);
    const b = sampleB([magnets[1]], p);
    for (let i = 0; i < 3; i++) expect(both[i]).toBeCloseTo(a[i] + b[i], 14);
  });
});

// ---------------------------------------------------------------------------
// Composite magnet types
// ---------------------------------------------------------------------------

describe('composite magnets', () => {
  it('horseshoe: opposite poles at the two tips, strong field in the gap', () => {
    const m = createMagnet({ type: 'horseshoe', position: [0, 0, 0] });
    const faces = buildFaces([m]);
    const s = m.size;
    const tipZ = s.yoke + s.legLength;
    const x = (s.gap + s.legWidth) / 2;

    const left = sampleFaces(faces, [-x, 0, tipZ + 1], [0, 0, 0]);
    const right = sampleFaces(faces, [x, 0, tipZ + 1], [0, 0, 0]);
    expect(Math.sign(left[2])).toBe(-Math.sign(right[2]));

    // Between the tips the field crosses the gap, i.e. points along -x
    // (out of the north tip on the left, into the south tip on the right).
    const mid = sampleFaces(faces, [0, 0, tipZ - 2], [0, 0, 0]);
    expect(Math.abs(mid[0])).toBeGreaterThan(Math.abs(mid[2]));
    expect(len(mid)).toBeGreaterThan(0.02);
  });

  it('horseshoe gap holds a nearly uniform field DIRECTION', () => {
    // This is what the "nail in the flat-field area" preset relies on: across
    // the middle of the gap the field points essentially one way, so the whole
    // nail chains in parallel instead of fanning. Direction uniformity is the
    // relevant measure - a bar magnet can match |B| uniformity directly over
    // its face while its direction still fans hard.
    const h = createMagnet({ type: 'horseshoe', position: [0, 0, 0] });
    const faces = buildFaces([h]);
    const tipZ = h.size.yoke + h.size.legLength; // plane of the two pole faces

    const probe = (pts) => {
      const dirs = pts.map((p) => norm(sampleFaces(faces, p, [0, 0, 0])));
      const ref = dirs[(dirs.length - 1) >> 1];
      return Math.max(...dirs.map((d) =>
        Math.acos(Math.min(1, Math.abs(dot(d, ref)))) * 180 / Math.PI));
    };

    // Across the gap, in the pole-face plane: this is the flat-field region
    // the preset parks the nail in.
    expect(probe([-5, -2.5, 0, 2.5, 5].map((x) => [x, 0, tipZ]))).toBeLessThan(6);

    // Along the depth direction it is uniform to machine precision.
    expect(probe([-3, 0, 3].map((y) => [0, y, tipZ]))).toBeLessThan(1e-6);

    // Transverse (crossing the gap), not vertical, and usefully strong.
    const mid = sampleFaces(faces, [0, 0, tipZ], [0, 0, 0]);
    expect(Math.abs(norm(mid)[0])).toBeGreaterThan(0.98);
    expect(len(mid)).toBeGreaterThan(0.05);

    // The flatness is local: 4 mm above the pole plane the field has already
    // fanned out badly, which is why the preset cares where the nail sits.
    expect(probe([-5, -2.5, 0, 2.5, 5].map((x) => [x, 0, tipZ + 4]))).toBeGreaterThan(15);
  });

  it('array tool: polarity alternates across the strip', () => {
    const m = createMagnet({ type: 'array', position: [0, 0, 0] });
    const faces = buildFaces([m]);
    const s = m.size;
    const z = s.height / 2 + 1.5;
    const signs = [];
    for (let i = 0; i < s.nx; i++) {
      const x = i * s.cellX - ((s.nx - 1) * s.cellX) / 2;
      signs.push(Math.sign(sampleFaces(faces, [x, 0, z], [0, 0, 0])[2]));
    }
    for (let i = 1; i < signs.length; i++) expect(signs[i]).toBe(-signs[i - 1]);
  });

  it('a disc magnet held above a plane gives a weak on-axis umbra', () => {
    // The premise of the "dark umbra" preset: directly under an axially
    // magnetised disc the field is normal to the nail, so flakes stand up and
    // show no sheen; the sheen lives on the ring where the field fans over.
    const m = createMagnet({ type: 'cylinder', position: [0, 0, 8], size: { radius: 7, height: 4 } });
    const faces = buildFaces([m]);
    const tilt = (x) => {
      const b = norm(sampleFaces(faces, [x, 0, 0], [0, 0, 0]));
      return Math.acos(Math.min(1, Math.abs(b[2]))) * 180 / Math.PI;
    };
    expect(tilt(0)).toBeLessThan(1);      // dead centre: straight up
    expect(tilt(7)).toBeGreaterThan(25);  // near the rim: fanned over
  });
});

// ---------------------------------------------------------------------------
// Ring and Halbach magnets
// ---------------------------------------------------------------------------

describe('ring magnet', () => {
  it('is exactly the outer disc minus the inner one', () => {
    // Which is why it needs no new field kernel: the field is linear in the
    // charge distribution, so an annulus is a positive disc with a negative one
    // punched out of it.
    const size = { outerRadius: 9, innerRadius: 4, height: 4 };
    const ring = createMagnet({ type: 'ring', position: [0, 0, 0], size });
    const outer = createMagnet({
      type: 'cylinder', position: [0, 0, 0],
      size: { radius: size.outerRadius, height: size.height },
    });
    const inner = createMagnet({
      type: 'cylinder', position: [0, 0, 0],
      size: { radius: size.innerRadius, height: size.height },
    });

    for (const p of [[0, 0, 3], [0, 0, 12], [6, 2, 5], [15, 0, 2], [0, 0, -7]]) {
      const a = sampleB([ring], p);
      const b = sampleB([outer], p);
      const c = sampleB([inner], p);
      for (let k = 0; k < 3; k++) {
        expect(a[k], `ring at ${p} component ${k}`).toBeCloseTo(b[k] - c[k], 12);
      }
    }
  });

  it('reverses on axis inside the hole, as a ring should', () => {
    // Close in over the hole the return flux dominates, so the on-axis field
    // points OPPOSITE to the far-field direction. That sign change is the
    // signature of a ring rather than a disc.
    const ring = createMagnet({
      type: 'ring', position: [0, 0, 0],
      size: { outerRadius: 9, innerRadius: 4, height: 4 },
    });
    const faces = buildFaces([ring]);
    const near = sampleFaces(faces, [0, 0, 3], [0, 0, 0])[2];
    const far = sampleFaces(faces, [0, 0, 30], [0, 0, 0])[2];
    expect(Math.sign(near)).toBe(-Math.sign(far));
  });

  it('a zero-radius hole degenerates to a plain disc', () => {
    const ring = createMagnet({
      type: 'ring', position: [0, 0, 0],
      size: { outerRadius: 7, innerRadius: 0, height: 4 },
    });
    const disc = createMagnet({
      type: 'cylinder', position: [0, 0, 0], size: { radius: 7, height: 4 },
    });
    const a = sampleB([ring], [2, 1, 6]);
    const b = sampleB([disc], [2, 1, 6]);
    for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 12);
  });
});

describe('Halbach array', () => {
  const build = (pattern) => createMagnet({
    type: 'array', position: [0, 0, 0],
    size: { nx: 8, ny: 1, cellX: 4, cellY: 20, height: 5, pattern },
  });

  it('concentrates flux on one face and cancels it on the other', () => {
    const h = buildFaces([build('halbach')]);
    const above = len(sampleFaces(h, [0, 0, 6], [0, 0, 0]));
    const below = len(sampleFaces(h, [0, 0, -6], [0, 0, 0]));
    expect(below / above).toBeGreaterThan(5);   // strongly one sided
  });

  it('...unlike the alternating stripe, which is symmetric', () => {
    const s = buildFaces([build('stripe')]);
    const above = len(sampleFaces(s, [0, 0, 6], [0, 0, 0]));
    const below = len(sampleFaces(s, [0, 0, -6], [0, 0, 0]));
    expect(above / below).toBeCloseTo(1, 9);
  });

  it('flipping N-S swaps which face the flux favours', () => {
    const m = build('halbach');
    m.flip = true;
    const f = buildFaces([m]);
    const above = len(sampleFaces(f, [0, 0, 6], [0, 0, 0]));
    const below = len(sampleFaces(f, [0, 0, -6], [0, 0, 0]));
    expect(above / below).toBeGreaterThan(5);   // now the other way round
  });
});

describe('oblique magnetisation', () => {
  it('reduces exactly to the axis-aligned case when M is along +Z', () => {
    // The six-face oblique path and the two-face fast path must agree to the
    // bit, or every Halbach result below is built on sand.
    const plain = createMagnet({
      type: 'box', position: [0, 0, 0], size: { sx: 8, sy: 6, sz: 4 },
    });
    // A single-cell halbach array is the same block, forced down the oblique path.
    const oblique = createMagnet({
      type: 'array', position: [0, 0, 0],
      size: { nx: 1, ny: 1, cellX: 8, cellY: 6, height: 4, pattern: 'halbach' },
    });
    for (const p of [[3, 2, 7], [0, 0, 5], [12, -4, 2], [-6, 9, -3]]) {
      const a = sampleB([plain], p);
      const b = sampleB([oblique], p);
      for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k], 14);
    }
  });

  it('a block magnetised sideways equals the same block rotated', () => {
    // mdir = +X must give the same field as physically turning the magnet so
    // its own +Z points along +X.
    const rotated = createMagnet({
      // Cell 1 of the strip below sits at x = +6, so the reference must too.
      type: 'box', position: [6, 0, 0], size: { sx: 6, sy: 6, sz: 6 },
      quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
    });
    // Cell 1 of a 2-cell halbach strip carries mdir = +X at offset +cellX/2.
    const strip = createMagnet({
      type: 'array', position: [3, 0, 0],
      size: { nx: 2, ny: 1, cellX: 6, cellY: 6, height: 6, pattern: 'halbach' },
    });
    // Isolate: subtract the first cell (mdir = +Z, sitting at the origin).
    const first = createMagnet({
      type: 'box', position: [0, 0, 0], size: { sx: 6, sy: 6, sz: 6 },
    });
    for (const p of [[2, 3, 9], [-8, 1, 4]]) {
      const combined = sampleB([strip], p);
      const solo = sampleB([first], p);
      const ref = sampleB([rotated], p);
      for (let k = 0; k < 3; k++) {
        expect(combined[k] - solo[k], `component ${k}`).toBeCloseTo(ref[k], 12);
      }
    }
  });
});

describe('Halbach cylinder', () => {
  const cyl = (poles) => createMagnet({
    type: 'halbachCylinder', position: [0, 0, 0],
    size: { outerRadius: 34, innerRadius: 20, height: 22, segments: 24, poles },
  });

  it('dipole: a strong, near-uniform, purely transverse field in the bore', () => {
    const f = buildFaces([cyl(1)]);
    const probes = [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4], [6, 6]];
    const mags = [];
    for (const [x, y] of probes) {
      const b = sampleFaces(f, [x, y, 0], [0, 0, 0]);
      mags.push(len(b));
      // The bore field lies in the plane: no axial component at mid-height.
      expect(Math.abs(b[2]) / len(b), `Bz at ${x},${y}`).toBeLessThan(1e-6);
      // ...and points essentially the same way everywhere.
      expect(Math.abs(Math.atan2(b[1], b[0]) * 180 / Math.PI)).toBeLessThan(4);
    }
    expect(Math.min(...mags)).toBeGreaterThan(0.3);            // strong
    expect((Math.max(...mags) - Math.min(...mags)) / Math.max(...mags))
      .toBeLessThan(0.15);                                     // and uniform
  });

  it('dipole: torque without translation - the gradient is ~zero', () => {
    // This is the point of the geometry. Compare the pull per unit field with a
    // cat-eye wand, which is all gradient.
    const f = buildFaces([cyl(1)]);
    const b = len(sampleFaces(f, [0, 0, 0], [0, 0, 0]));
    const g = len(gradBMag(f, [0, 0, 0], 0.15));
    expect(g / b).toBeLessThan(0.01); // per mm

    const wand = buildFaces([createMagnet({
      type: 'array', position: [0, 0, 7],
      size: { nx: 2, ny: 1, cellX: 7, cellY: 26, height: 5, pattern: 'stripe' },
    })]);
    const bw = len(sampleFaces(wand, [0, 0, 0], [0, 0, 0]));
    const gw = len(gradBMag(wand, [0, 0, 0], 0.15));
    expect(gw / bw).toBeGreaterThan((g / b) * 10);
  });

  it('quadrupole: an exact null at the centre with |B| linear in r', () => {
    const f = buildFaces([cyl(2)]);
    expect(len(sampleFaces(f, [0, 0, 0], [0, 0, 0]))).toBeLessThan(1e-9);

    const slopes = [];
    for (const r of [1, 2, 4, 6]) {
      const b = len(sampleFaces(f, [r, 0, 0], [0, 0, 0]));
      slopes.push(b / r);
    }
    // Constant |B|/r means |B| grows linearly out of the null.
    const spread = (Math.max(...slopes) - Math.min(...slopes)) / Math.max(...slopes);
    expect(spread).toBeLessThan(0.06);
  });

  it('quadrupole leaves the flakes unaligned at the null', () => {
    // No field means no alignment, so a genuinely dark disordered core - the
    // only tool here that produces one.
    const { nail } = PRESETS.halbachQuadrupole.build();
    const g = buildNailGrid({ ...nail, resU: 30, resV: 30 });
    const fin = computeFinish(g, buildFaces(PRESETS.halbachQuadrupole.build().magnets));
    const centre = fin.order[Math.floor(g.nu / 2) * g.nv + Math.floor(g.nv / 2)];
    const edge = fin.order[Math.floor(g.nu / 2) * g.nv];
    expect(centre).toBeLessThan(edge * 0.85);
  });
});

describe('uniformly magnetised sphere', () => {
  const R = 6;
  const Br = 1.3;
  const sph = createMagnet({ type: 'sphere', position: [0, 0, 0], Br, size: { radius: R } });

  it('is EXACTLY a point dipole outside, at every distance', () => {
    // The reason a sphere is the natural reference magnet: no quadrature, no
    // corner sums, no near-field correction. Same law at 1.01 R and at 100 R.
    const faces = buildFaces([sph]);
    const k = (Br * R ** 3) / 3;
    for (const r of [R * 1.001, R * 1.01, 7, 10, 40, 500]) {
      // on axis: B = 2k/r^3 along the axis
      const on = sampleFaces(faces, [0, 0, r], [0, 0, 0]);
      expect(on[2]).toBeCloseTo((2 * k) / r ** 3, 12);
      expect(Math.hypot(on[0], on[1])).toBeLessThan(1e-15);
      // equatorial: B = -k/r^3 along the axis
      const eq = sampleFaces(faces, [r, 0, 0], [0, 0, 0]);
      expect(eq[2]).toBeCloseTo(-k / r ** 3, 12);
      expect(Math.hypot(eq[0], eq[1])).toBeLessThan(1e-15);
      // on-axis is exactly twice the equatorial, and opposite
      expect(on[2] / eq[2]).toBeCloseTo(-2, 10);
    }
  });

  it('is exactly uniform inside, at 2/3 Br', () => {
    const faces = buildFaces([sph]);
    for (const p of [[0, 0, 0], [1, 2, -3], [0, 0, 5.9], [4, 4, 0]]) {
      const b = sampleFaces(faces, p, [0, 0, 0]);
      expect(b[0]).toBeCloseTo(0, 12);
      expect(b[1]).toBeCloseTo(0, 12);
      expect(b[2]).toBeCloseTo((2 / 3) * Br, 12);
    }
  });

  it('obeys div B = 0 and curl B = 0 outside, like everything else', () => {
    const faces = buildFaces([sph]);
    for (const p of [[9, 0, 0], [4, 5, 8], [-12, 3, -7]]) {
      const scale = len(sampleFaces(faces, p, [0, 0, 0]));
      expect(Math.abs(divB(faces, p, 0.02))).toBeLessThan(1e-3 * (scale + 0.01));
      const c = curlB(faces, p, 0.02);
      expect(Math.hypot(c[0], c[1], c[2])).toBeLessThan(1e-3 * (scale + 0.01));
    }
  });

  it('has no edges: the field direction turns smoothly all the way round', () => {
    // The point of a sphere for polish work. Compare the biggest step in field
    // ANGLE around a circuit at fixed radius against a cuboid of equal volume.
    const circuit = (magnets, rad) => {
      const f = buildFaces(magnets);
      let worst = 0;
      let prev = null;
      for (let i = 0; i <= 180; i++) {
        const th = (i / 180) * 2 * Math.PI;
        const b = norm(sampleFaces(f, [rad * Math.cos(th), 0, rad * Math.sin(th)], [0, 0, 0]));
        if (prev) {
          worst = Math.max(worst, Math.acos(Math.min(1, Math.abs(dot(b, prev)))));
        }
        prev = b;
      }
      return worst * 180 / Math.PI;
    };
    // Cuboid of the same volume as the sphere.
    const side = Math.cbrt((4 / 3) * Math.PI * R ** 3);
    const cube = createMagnet({
      type: 'box', position: [0, 0, 0], Br,
      size: { sx: side, sy: side, sz: side },
    });
    const rad = R * 1.3;
    expect(circuit([sph], rad)).toBeLessThan(circuit([cube], rad));
  });
});

describe('containment, which is what stops a field line inside a magnet', () => {
  // insideAnyMagnet is the stop condition for streamline tracing. Two of the
  // seven magnet types used to get it wrong, and both failed silently in the
  // sense that nothing threw until you happened to draw field lines:
  //   - a sphere part carries no `height`, so it fell through to the cylinder
  //     test, compared against undefined, and reported its own centre as
  //     OUTSIDE itself. Field lines were traced straight through the body.
  //   - the ring branch contained face-building code that referenced variables
  //     not in scope, so it threw ReferenceError on the first ring magnet.

  it('every magnet type answers without throwing', () => {
    for (const type of MAGNET_TYPES) {
      const m = createMagnet({ type, position: [0, 0, 0] });
      expect(() => insideAnyMagnet([m], [0, 0, 0]), `${type} threw`).not.toThrow();
      expect(() => insideAnyMagnet([m], [3, 2, 1]), `${type} threw`).not.toThrow();
    }
  });

  it('a sphere contains its own centre', () => {
    const s = createMagnet({ type: 'sphere', size: { radius: 6 }, position: [1, 2, 3] });
    expect(insideAnyMagnet([s], [1, 2, 3])).toBe(true);
    expect(insideAnyMagnet([s], [1 + 5.9, 2, 3])).toBe(true);
    expect(insideAnyMagnet([s], [1 + 6.1, 2, 3])).toBe(false);
  });

  it('a ring contains its wall but not its bore', () => {
    // The distinction the whole shape exists for, and what a field line
    // threading the hole depends on.
    const r = createMagnet({
      type: 'ring', size: { outerRadius: 9, innerRadius: 4, height: 4 },
      position: [0, 0, 0],
    });
    expect(insideAnyMagnet([r], [6.5, 0, 0]), 'the wall').toBe(true);
    expect(insideAnyMagnet([r], [1, 0, 0]), 'the bore').toBe(false);
    expect(insideAnyMagnet([r], [12, 0, 0]), 'outside').toBe(false);
    expect(insideAnyMagnet([r], [6.5, 0, 9]), 'above it').toBe(false);
  });

  it('a box and a cylinder still behave', () => {
    const b = createMagnet({ type: 'box', size: { sx: 10, sy: 4, sz: 2 } , position: [0, 0, 0] });
    expect(insideAnyMagnet([b], [0, 0, 0])).toBe(true);
    expect(insideAnyMagnet([b], [4.9, 1.9, 0.9])).toBe(true);
    expect(insideAnyMagnet([b], [5.1, 0, 0])).toBe(false);
    const c = createMagnet({ type: 'cylinder', size: { radius: 5, height: 3 }, position: [0, 0, 0] });
    expect(insideAnyMagnet([c], [0, 0, 0])).toBe(true);
    expect(insideAnyMagnet([c], [4.9, 0, 1.4])).toBe(true);
    expect(insideAnyMagnet([c], [0, 0, 1.6])).toBe(false);
  });
});
