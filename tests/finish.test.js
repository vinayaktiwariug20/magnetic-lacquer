// Nail geometry and the finish model.

import { describe, it, expect } from 'vitest';
import {
  createNail, buildNailGrid, nailPointLocal, nailCentre, fingerFor,
} from '../src/core/nail.js';
import { createMagnet } from '../src/core/magnet.js';
import { buildFaces, sampleFaces, len } from '../src/core/field.js';
import { computeFinish } from '../src/core/finish.js';
import { dot, norm, sub } from '../src/core/vec.js';
import { PRESETS } from '../src/core/presets.js';

describe('nail surface', () => {
  it('preserves arc length as curvature increases', () => {
    // The whole reason the profile is a true circular arc rather than a
    // parabola: a 16 x 12 nail must stay 16 x 12 however hard it is arched.
    for (const kt of [0, 0.03, 0.09, 0.15]) {
      for (const kl of [0, 0.02, 0.05]) {
        const nail = createNail({
          length: 16, width: 12, transverseCurv: kt, longitudinalCurv: kl,
          taper: 0, resU: 400, resV: 400,
        });

        // Walk the transverse arc at mid-length.
        let w = 0;
        for (let i = 1; i <= 400; i++) {
          const t0 = (-0.5 + (i - 1) / 400) * 12;
          const t1 = (-0.5 + i / 400) * 12;
          const a = nailPointLocal(nail, 0, t0).p;
          const b = nailPointLocal(nail, 0, t1).p;
          w += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        }
        expect(w, `width kt=${kt} kl=${kl}`).toBeCloseTo(12, 3);

        // ...and the medial line.
        let l = 0;
        for (let i = 1; i <= 400; i++) {
          const s0 = (-0.5 + (i - 1) / 400) * 16;
          const s1 = (-0.5 + i / 400) * 16;
          const a = nailPointLocal(nail, s0, 0).p;
          const b = nailPointLocal(nail, s1, 0).p;
          l += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        }
        expect(l, `length kt=${kt} kl=${kl}`).toBeCloseTo(16, 3);
      }
    }
  });

  it('normals are unit length and agree with the numerical surface normal', () => {
    const nail = createNail({ transverseCurv: 0.1, longitudinalCurv: 0.04, taper: 0 });
    const h = 1e-4;
    for (const [s, t] of [[0, 0], [3, 2], [-5, -4], [7, 5.5], [-2, 5]]) {
      const { p, n } = nailPointLocal(nail, s, t);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 10);

      const ds = sub(nailPointLocal(nail, s + h, t).p, nailPointLocal(nail, s - h, t).p);
      const dt = sub(nailPointLocal(nail, s, t + h).p, nailPointLocal(nail, s, t - h).p);
      // Tangents must lie in the plane the analytic normal defines.
      expect(Math.abs(dot(norm(ds), n)), `s=${s} t=${t}`).toBeLessThan(1e-6);
      expect(Math.abs(dot(norm(dt), n))).toBeLessThan(1e-6);
      expect(p.length).toBe(3);
    }
  });

  it('a flat nail is planar with all normals up', () => {
    const nail = createNail({ transverseCurv: 0, longitudinalCurv: 0, resU: 8, resV: 8 });
    const g = buildNailGrid(nail);
    for (let i = 0; i < g.count; i++) {
      expect(g.position[i * 3 + 2]).toBeCloseTo(0, 10);
      expect(g.normal[i * 3 + 2]).toBeCloseTo(1, 10);
    }
  });

  it('an arched nail turns its normals outward at the sides', () => {
    const nail = createNail({ transverseCurv: 0.12, longitudinalCurv: 0, taper: 0, resU: 4, resV: 8 });
    const g = buildNailGrid(nail);
    const row = 2;
    const left = row * g.nv + 0;
    const right = row * g.nv + (g.nv - 1);
    expect(g.normal[left * 3]).toBeLessThan(-0.4);   // tips toward -X
    expect(g.normal[right * 3]).toBeGreaterThan(0.4); // tips toward +X
    // ...and the sides sit below the crown.
    const crown = row * g.nv + Math.floor(g.nv / 2);
    expect(g.position[left * 3 + 2]).toBeLessThan(g.position[crown * 3 + 2]);
  });

  it('the finger sits under the nail rather than through it', () => {
    // Regression: the finger capsule was being rotated onto the nail's normal,
    // which stood it upright, and its axis offset put the top surface 2 mm
    // ABOVE the nail plate.
    for (const c of [
      { width: 12, transverseCurv: 0.085 },
      { width: 12, transverseCurv: 0 },      // flat nail: no finite arc radius
      { width: 20, transverseCurv: 0.19 },
      { width: 7, transverseCurv: 0.02 },
    ]) {
      const nail = createNail(c);
      const f = fingerFor(nail);
      const label = JSON.stringify(c);

      expect(Number.isFinite(f.radius), label).toBe(true);
      expect(f.radius).toBeGreaterThan(0);

      // The real guard: every point of the nail plate must lie ON or OUTSIDE
      // the finger cylinder. Measuring distance from the finger's AXIS is the
      // right test - a strongly arched nail wraps past 90 degrees and sits on
      // the lower half of the cylinder, where an "is it above the top surface"
      // check would be meaningless.
      //
      // Sweep the WHOLE plate, not one row. Checking only mid-length missed
      // longitudinal sag burying both ends of the nail in the finger, which
      // showed up as a scalloped intersection along the edge.
      let worst = Infinity;
      for (let i = 0; i <= 24; i++) {
        const s = (i / 24 - 0.5) * nail.length;
        for (let j = 0; j <= 24; j++) {
          const t = (j / 24 - 0.5) * nail.width;
          const p = nailPointLocal(nail, s, t).p;
          const d = Math.hypot(p[0], p[2] - f.offset[2]);
          worst = Math.min(worst, d - f.radius);
          expect(d, `${label}: nail sinks into the finger at s=${s} t=${t}`)
            .toBeGreaterThanOrEqual(f.radius - 1e-9);
        }
      }
      // Tangent somewhere, or the finger has been pushed needlessly far down
      // and would float visibly below the plate.
      expect(worst, `${label}: finger floats ${worst.toFixed(2)}mm clear`)
        .toBeLessThan(1.5);

      // Offset back toward the cuticle, not forward past the free edge.
      expect(f.offset[1]).toBeLessThan(0);
      expect(f.offset[0]).toBe(0);
      // Long enough to read as a finger.
      expect(f.length).toBeGreaterThan(nail.length);
    }
  });

  it('respects position and orientation', () => {
    const nail = createNail({ position: [5, -3, 2] });
    const c = nailCentre(nail);
    expect(c.p[0]).toBeCloseTo(5, 9);
    expect(c.p[2]).toBeCloseTo(2, 9);
    expect(c.n[2]).toBeCloseTo(1, 9);
  });
});

describe('finish model', () => {
  const grid = (nail) => buildNailGrid({ ...nail, resU: 40, resV: 28 });

  it('standing pile under a disc: near-zero tilt at the core, flat at the rim', () => {
    const { nail, magnets } = PRESETS.discUmbra.build();
    const g = grid(nail);
    const f = computeFinish(g, buildFaces(magnets));

    const centre = f.tilt[Math.floor(g.nu / 2) * g.nv + Math.floor(g.nv / 2)];
    const edge = f.tilt[Math.floor(g.nu / 2) * g.nv + 0];
    expect(centre).toBeLessThan(6);
    expect(edge).toBeGreaterThan(centre + 15);
  });

  it('velvet: flakes lie flat AND all point the same way', () => {
    const { nail, magnets } = PRESETS.velvet.build();
    const g = grid(nail);
    const f = computeFinish(g, buildFaces(magnets));
    expect(f.stats.meanTilt).toBeGreaterThan(70);   // lying down, mirror-like
    expect(f.stats.tiltSpread).toBeLessThan(20);
    // The defining property: one uniform nap, not a turning pile.
    expect(f.stats.chainSpread).toBeLessThan(12);
  });

  it('concentration is monotonic in |B| and the exponent sharpens it', () => {
    const { nail, magnets } = PRESETS.catEye.build();
    const g = grid(nail);
    const faces = buildFaces(magnets);

    const soft = computeFinish(g, faces, { concExp: 1 });
    const hard = computeFinish(g, faces, { concExp: 4 });

    // Monotonic: order texels by |B| and check concentration never decreases.
    const idx = [...Array(g.count).keys()].sort((a, b) => soft.bmag[a] - soft.bmag[b]);
    for (let i = 1; i < idx.length; i++) {
      expect(soft.conc[idx[i]]).toBeGreaterThanOrEqual(soft.conc[idx[i - 1]] - 1e-6);
      expect(hard.conc[idx[i]]).toBeGreaterThanOrEqual(hard.conc[idx[i - 1]] - 1e-6);
    }
    // A bigger exponent concentrates: less area above half brightness.
    const above = (a) => a.reduce((n, v) => n + (v > 0.5 ? 1 : 0), 0);
    expect(above(hard.conc)).toBeLessThan(above(soft.conc));

    // Endpoints are pinned regardless of exponent.
    expect(Math.min(...soft.conc)).toBeCloseTo(0, 6);
    expect(Math.max(...soft.conc)).toBeCloseTo(1, 6);
  });

  it('alignment order is zero below threshold and saturates above it', () => {
    const { nail, magnets } = PRESETS.catEye.build();
    const g = grid(nail);
    const faces = buildFaces(magnets);

    const weak = computeFinish(g, faces, { orderThreshold: 10 }); // unreachable
    expect(Math.max(...weak.order)).toBe(0);

    const strong = computeFinish(g, faces, { orderThreshold: 0, orderSat: 1e-4 });
    expect(Math.min(...strong.order)).toBeGreaterThan(0.99);

    const normal = computeFinish(g, faces);
    for (let i = 0; i < g.count; i++) {
      expect(normal.order[i]).toBeGreaterThanOrEqual(0);
      expect(normal.order[i]).toBeLessThanOrEqual(1);
    }
  });

  it('stats are self-consistent', () => {
    const { nail, magnets } = PRESETS.catEye.build();
    const g = grid(nail);
    const f = computeFinish(g, buildFaces(magnets));
    const s = f.stats;
    expect(s.min).toBeLessThanOrEqual(s.mean);
    expect(s.mean).toBeLessThanOrEqual(s.max);
    expect(s.centre).toBeGreaterThanOrEqual(s.min);
    expect(s.centre).toBeLessThanOrEqual(s.max);
    expect(s.spreadPct).toBeGreaterThan(0);
    expect(s.spreadPct).toBeLessThanOrEqual(100);
    expect(s.meanTilt).toBeGreaterThanOrEqual(0);
    expect(s.meanTilt).toBeLessThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// The claim the whole renderer rests on: which way does the sheen sweep?
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cat eye vs reverse velvet. These are two different finishes and it is easy to
// build the second while believing you built the first, so pin what actually
// distinguishes them.
// ---------------------------------------------------------------------------

describe('a cat eye is an N-to-S transition, not a pole face', () => {
  const spread = (a) => Math.max(...a) - Math.min(...a);

  const solve = (key, nailOverrides) => {
    const { nail, magnets } = PRESETS[key].build();
    const g = buildNailGrid({ ...nail, ...nailOverrides, resU: 48, resV: 48 });
    return { g, f: computeFinish(g, buildFaces(magnets)) };
  };

  /** Tilt sampled across the width at mid length. */
  const tiltAcross = ({ g, f }) => {
    const iu = Math.floor(g.nu / 2);
    return Array.from({ length: g.nv }, (_, iv) => f.tilt[iu * g.nv + iv]);
  };

  // The two finishes are inverted tilt profiles across the nail, which is a far
  // sharper discriminator than any single threshold:
  //   cat eye        24  9  8 27 47 68 [90] 68 47 27  8  9 24   <- peak at centre
  //   reverse velvet 79 69 58 45 31 16  [0] 16 31 45 58 69 79   <- dip at centre

  it('cat eye: pile FLAT on the seam, standing in a dark band either side', () => {
    const row = tiltAcross(solve('catEye'));
    const mid = Math.floor(row.length / 2);

    // On the seam the field lies in the surface: flakes mirror. This is the line.
    expect(row[mid]).toBeGreaterThan(85);
    // The seam is the global maximum - the bright line is a peak, not a plateau.
    expect(row[mid]).toBe(Math.max(...row));

    // A genuinely dark band exists either side, and it is OFF centre.
    const min = Math.min(...row);
    expect(min).toBeLessThan(15);
    expect(row.indexOf(min)).not.toBe(mid);

    // Falling monotonically from the seam out to that dark band is what makes
    // it read as one clean line.
    const dark = row.indexOf(min);
    for (let i = dark + 1; i <= mid; i++) {
      expect(row[i], `not monotonic at ${i}`).toBeGreaterThan(row[i - 1] - 1e-4);
    }
  });

  it('reverse velvet: pile stands, uniformly, with no line', () => {
    // Field crossing straight through the plate, so it stands on end together.
    const r = solve('reverseVelvetClamp');
    const row = tiltAcross(r);
    expect(r.f.stats.chainSpread).toBeLessThan(8);    // all pointing alike
    // No bright line anywhere: nothing lies flat, even at the sidewalls.
    expect(Math.max(...row)).toBeLessThan(45);
  });

  it('what limits reverse velvet is the NAIL, not the magnet', () => {
    // The pile does not stand at 0 degrees even in a perfectly uniform vertical
    // field, and it is worth pinning down why: the plate curves away underneath
    // it. Flat the nail out and the same magnets stand the pile up properly.
    const arched = solve('reverseVelvetClamp');
    const flat = solve('reverseVelvetClamp', { transverseCurv: 0, longitudinalCurv: 0 });

    // The FIELD is equally uniform in both - the magnets have not changed.
    expect(Math.abs(arched.f.stats.chainSpread - flat.f.stats.chainSpread))
      .toBeLessThan(6);
    // But the tilt collapses once the surface stops turning away, down to
    // nothing more than the field's own few degrees of non-uniformity - on a
    // flat nail the two numbers are the same thing.
    expect(flat.f.stats.meanTilt).toBeLessThan(7);
    expect(flat.f.stats.meanTilt)
      .toBeCloseTo(flat.f.stats.chainSpread, 0);
    // Arch the nail and the tilt triples while the field is untouched.
    expect(arched.f.stats.meanTilt)
      .toBeGreaterThan(flat.f.stats.meanTilt * 3);
  });

  it('a quarter-turned horseshoe cannot beat the clamp on a real finger', () => {
    // Not a preference, a measurement. The horseshoe's gap has to clear the
    // whole fingertip, so the nail can never sit near the centre of it, and the
    // field over the plate is correspondingly lopsided. Both scenes here are
    // checked for finger clearance by the reachability test, so this compares
    // two arrangements a hand could actually hold.
    const shoe = solve('reverseVelvet');
    const clamp = solve('reverseVelvetClamp');
    expect(clamp.f.stats.chainSpread).toBeLessThan(shoe.f.stats.chainSpread * 0.5);
    expect(clamp.f.stats.mean).toBeGreaterThan(shoe.f.stats.mean * 1.8);
    expect(clamp.f.stats.meanTilt).toBeLessThan(shoe.f.stats.meanTilt);
  });

  it('a single pole face is the POORER reverse velvet: dark core, bright rim', () => {
    // Why the quarter-turned horseshoe is the right tool. Aiming one pole face
    // at the plate is perpendicular only on the axis; the arched sides turn
    // away from the field and lay the pile over, so the sheen ends up on the
    // rim instead of being absent altogether.
    const r = solve('discUmbra');
    const row = tiltAcross(r);
    const mid = Math.floor(row.length / 2);
    expect(row[mid]).toBeLessThan(10);                // standing at the core
    expect(row[mid]).toBe(Math.min(...row));
    expect(row[0]).toBeGreaterThan(40);               // laid over at the rim
    // Much less uniform than a field that crosses straight through the plate.
    expect(r.f.stats.chainSpread)
      .toBeGreaterThan(solve('reverseVelvetClamp').f.stats.chainSpread * 2);
  });

  it('parallelism separates the velvet family from the cat-eye family', () => {
    // The single number that tells them apart: velvet keeps one nap over the
    // whole nail, a cat eye turns the pile across it to make the line.
    const spread = (k) => solve(k).f.stats.chainSpread;
    for (const k of ['velvet', 'reverseVelvetClamp']) {
      expect(spread(k), `${k} should be one uniform nap`).toBeLessThan(12);
    }
    for (const k of ['catEye', 'catEyeAcross', 'catEyeBelow']) {
      expect(spread(k), `${k} should be a turning pile`).toBeGreaterThan(30);
    }
    // Velvet and reverse velvet are equally uniform - they differ in TILT, not
    // in parallelism: one lies flat, the other stands up.
    expect(solve('velvet').f.stats.meanTilt).toBeGreaterThan(70);
    expect(solve('reverseVelvetClamp').f.stats.meanTilt).toBeLessThan(25);
  });

  it('holding the wand back turns a cat eye into velvet', () => {
    // The salon technique: same tool, wider pull, pile stops turning.
    expect(solve('velvetWide').f.stats.chainSpread)
      .toBeLessThan(solve('catEye').f.stats.chainSpread * 0.6);
  });

  it('presenting both poles beats aiming one pole at the plate', () => {
    // Not a stylistic preference: the seam puts both pole faces close to the
    // nail, so a cat-eye wand is far stronger than either alternative.
    const wand = solve('catEye').f.stats.centre;
    expect(wand).toBeGreaterThan(solve('endBar').f.stats.centre * 4);
  });

  it('the field ARCS across the plate - it does not splay perpendicular', () => {
    // The distinction that separates a cat eye from reverse velvet, and the one
    // the preset notes describe. Sampling across the nail must show the field
    // going UP on one side, FLAT along the surface at the seam, and DOWN on the
    // other: one continuous arc from pole to pole. A splayed, roughly
    // perpendicular field would stand the pile up everywhere and show no line.
    const { nail, magnets } = PRESETS.catEye.build();
    const faces = buildFaces(magnets);
    const at = (x) => sampleFaces(faces, [x, 0, 0], [0, 0, 0]);

    const left = at(-5);
    const mid = at(0);
    const right = at(5);

    // Flat along the surface on the seam: no normal component at all.
    expect(Math.abs(mid[2]) / len(mid)).toBeLessThan(0.02);
    // ...and strongly in-plane there.
    expect(Math.abs(mid[0]) / len(mid)).toBeGreaterThan(0.98);

    // Opposite normal components at the two edges - the two ends of one arc.
    expect(Math.sign(left[2])).toBe(-Math.sign(right[2]));
    expect(Math.abs(left[2]) / len(left)).toBeGreaterThan(0.9);
    expect(Math.abs(right[2]) / len(right)).toBeGreaterThan(0.9);

    // The in-plane component keeps the SAME sign right across the nail. A
    // splayed field would flip it either side of the centre.
    for (const x of [-5, -3, -1, 0, 1, 3, 5]) {
      expect(Math.sign(at(x)[0]), `Bx flipped sign at x=${x}`).toBe(Math.sign(mid[0]));
    }
  });

  it('the standing flakes lean away from the seam above, toward it below', () => {
    // This is exactly what the preset notes claim, so pin it.
    const lean = (key) => {
      const { nail, magnets } = PRESETS[key].build();
      const faces = buildFaces(magnets);
      // Chain direction 5 mm to the +x side, oriented into the upper hemisphere.
      let d = norm(sampleFaces(faces, [5, 0, 0], [0, 0, 0]));
      if (d[2] < 0) d = [-d[0], -d[1], -d[2]];
      return d[0]; // > 0 tips away from the seam, < 0 tips toward it
    };
    expect(lean('catEye')).toBeGreaterThan(0);       // wand above: away
    expect(lean('catEyeBelow')).toBeLessThan(0);     // wand below: toward
  });

  it('rotating the wand rotates the line without changing its character', () => {
    const along = solve('catEye');
    const across = solve('catEyeAcross');

    // Lengthwise: the line runs down the nail, so tilt varies across the WIDTH
    // and is near constant along the LENGTH. Turned a quarter turn, it swaps.
    const varAcross = (s) => spread(tiltAcross(s));
    const varAlong = (s) => {
      const iv = Math.floor(s.g.nv / 2);
      return spread(Array.from({ length: s.g.nu }, (_, iu) => s.f.tilt[iu * s.g.nv + iv]));
    };

    expect(varAcross(along)).toBeGreaterThan(varAlong(along) * 3);
    expect(varAlong(across)).toBeGreaterThan(varAcross(across) * 3);

    // Same finish, just turned: comparable strength and mean tilt.
    expect(across.f.stats.centre).toBeGreaterThan(along.f.stats.centre * 0.5);
  });

});

describe('fan geometry: convex from below, concave from above', () => {
  const flatNail = () => createNail({
    transverseCurv: 0, longitudinalCurv: 0, taper: 0, resU: 40, resV: 40,
  });

  // Through-thickness bar, long axis along the nail: the classic cat-eye wand.
  const barAt = (z) => createMagnet({
    type: 'box', size: { sx: 6, sy: 24, sz: 4 }, position: [0, 0, z],
  });
  const discAt = (z) => createMagnet({
    type: 'cylinder', size: { radius: 7, height: 4 }, position: [0, 0, z],
  });

  it('a magnet BELOW makes flakes lean outward (convex array)', () => {
    // Field lines spray out of the pole face and diverge as they cross the
    // nail, so the flake normals fan apart - a convex mirror. A convex mirror
    // moves its highlight the same way the light moves.
    for (const m of [barAt(-8), discAt(-7)]) {
      const g = buildNailGrid(flatNail());
      const f = computeFinish(g, buildFaces([m]));
      expect(f.stats.fanGradient).toBeGreaterThan(0);
      expect(f.stats.fanKind).toBe('convex');
      expect(f.stats.focalLength).toBeGreaterThan(0);
    }
  });

  it('a magnet ABOVE makes flakes lean inward (concave array)', () => {
    // Lines converge into the pole face, so the array focuses. Past the focus
    // a concave mirror moves its highlight opposite to the light.
    for (const m of [barAt(8), discAt(7)]) {
      const g = buildNailGrid(flatNail());
      const f = computeFinish(g, buildFaces([m]));
      expect(f.stats.fanGradient).toBeLessThan(0);
      expect(f.stats.fanKind).toBe('concave');
      expect(f.stats.focalLength).toBeLessThan(0);
    }
  });

  it('the sign is set by the pole axis, and survives an in-plane magnet too', () => {
    // An end-magnetised bar laid ACROSS the nail magnetises it in-plane rather
    // than through the surface. The above/below rule still holds, but the
    // mechanism is different - here the pile is flat under the middle of the
    // bar and stands up toward the poles - so it is worth pinning separately.
    const endBar = (z) => createMagnet({
      type: 'box', size: { sx: 5, sy: 5, sz: 22 }, position: [0, 0, z],
      quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], // +Z -> +X
    });
    const g = buildNailGrid(flatNail());
    expect(computeFinish(g, buildFaces([endBar(8)])).stats.fanKind).toBe('concave');
    expect(computeFinish(g, buildFaces([endBar(-8)])).stats.fanKind).toBe('convex');
  });

  it('the two arrangements are exact mirror images of each other', () => {
    // Flipping the magnet to the other side of a flat nail must negate the fan
    // and change nothing else - that symmetry is the whole claim.
    const g = buildNailGrid(flatNail());
    const above = computeFinish(g, buildFaces([barAt(8)])).stats;
    const below = computeFinish(g, buildFaces([barAt(-8)])).stats;
    expect(below.fanGradient).toBeCloseTo(-above.fanGradient, 6);
    expect(below.meanTilt).toBeCloseTo(above.meanTilt, 6);
    expect(below.centre).toBeCloseTo(above.centre, 9);
  });

  it('flipping N-S does not change the fan (flakes are nematic)', () => {
    // Reversing the magnet reverses B but the flakes are unoriented rods, so
    // the pile geometry - and therefore the finish - is unchanged.
    const g = buildNailGrid(flatNail());
    const a = computeFinish(g, buildFaces([barAt(9)]));
    const flipped = barAt(9);
    flipped.flip = true;
    const b = computeFinish(g, buildFaces([flipped]));
    expect(b.stats.fanGradient).toBeCloseTo(a.stats.fanGradient, 9);
    expect(b.stats.meanTilt).toBeCloseTo(a.stats.meanTilt, 9);
  });

  it('the fan gets steeper as the magnet gets closer', () => {
    const g = buildNailGrid(flatNail());
    const near = computeFinish(g, buildFaces([barAt(7)])).stats.fanGradient;
    const far = computeFinish(g, buildFaces([barAt(20)])).stats.fanGradient;
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far));
    // ...i.e. a shorter focal length.
    expect(Math.abs(1 / near)).toBeLessThan(Math.abs(1 / far));
  });

  it('the presets carry the fan kinds their notes claim', () => {
    const check = (key) => {
      const { nail, magnets } = PRESETS[key].build();
      const g = buildNailGrid({ ...nail, resU: 40, resV: 40 });
      return computeFinish(g, buildFaces(magnets)).stats;
    };
    expect(check('catEyeBelow').fanKind).toBe('convex');
    expect(check('catEye').fanKind).toBe('concave');
    expect(check('catEyeAcross').fanKind).toBe('concave');
    expect(check('discUmbra').fanKind).toBe('concave');
    expect(check('endBar').fanKind).toBe('concave');
  });
});

describe('the cat eye from below expires just as it becomes buildable', () => {
  // The preset is labelled a thought experiment. The reason is not that a
  // magnet under the finger is impossible - you rest your fingertip on one -
  // but that the pad holds it ~21 mm off the plate, and the convex fan does
  // not reach that far. These pin both halves of that claim.

  const base = PRESETS.catEyeBelow.build();
  const grid = buildNailGrid({ ...base.nail, resU: 60, resV: 40 });
  const at = (z, over = {}) => computeFinish(
    grid, buildFaces([{ ...base.magnets[0], position: [0, 0, z], ...over }]),
  ).stats;

  it('is convex while the wand is inside the finger, concave once it is not', () => {
    expect(at(-8).fanKind).toBe('convex');
    expect(at(-15).fanKind).toBe('convex');
    expect(at(-19).fanGradient).toBeGreaterThan(0);
    // The pad sits at about 21 mm. By there the fan has already turned over.
    expect(at(-21).fanKind).toBe('concave');
    expect(at(-24).fanGradient).toBeLessThan(0);
  });

  it('the crossover sits within a couple of mm of the reachable depth', () => {
    // Two unrelated limits - one geometric, one magnetostatic - landing on top
    // of each other is the whole point of the scene, so it is worth asserting.
    let flip = null;
    for (let z = -5; z >= -26; z -= 1) {
      if (at(z).fanGradient < 0) { flip = z; break; }
    }
    expect(flip).not.toBeNull();
    const reachable = -21;                       // fingerClearance crosses zero here
    expect(Math.abs(flip - reachable)).toBeLessThanOrEqual(2);
  });

  it('no amount of Br rescues it, because direction is scale-invariant', () => {
    // Scaling every source scales |B| everywhere and rotates it nowhere, so a
    // stronger magnet buys order and never buys the fan back. This is the
    // sharpest statement the scene supports.
    const weak = at(-21, { Br: 1.3 });
    const absurd = at(-21, { Br: 20 });
    // Equal to 4e-9, which is summation order over thousands of faces rather
    // than any real dependence on Br.
    expect(absurd.fanGradient).toBeCloseTo(weak.fanGradient, 7);
    expect(absurd.fanKind).toBe(weak.fanKind);
    expect(absurd.meanOrder).toBeGreaterThan(weak.meanOrder + 0.5); // it does buy order
  });
});
