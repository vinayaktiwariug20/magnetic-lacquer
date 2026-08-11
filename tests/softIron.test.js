// Induced magnetisation in soft iron.
//
// Unlike every other magnet here, the answer is not evaluated but solved for,
// so it needs a reference. The sphere provides one: a sphere of susceptibility
// chi in a uniform field is uniformly magnetised at 3 chi / (3 + chi) times the
// applied field, exactly. Everything below is anchored on that, or on a
// symmetry that has to hold whatever the solver does.

import { describe, it, expect } from 'vitest';
import {
  solveSoftIron, voxelize, totalMoment, sphereMagnetisationExact, SOFT_IRON,
} from '../src/core/softIron.js';
import { sampleFaces, buildFaces } from '../src/core/field.js';
import { createMagnet, wirePath, WIRE_SHAPES } from '../src/core/magnet.js';

/**
 * A genuinely uniform applied field, which no finite magnet produces.
 *
 * The sphere kernel returns (2/3) Br * axis anywhere inside the sphere, so a
 * sphere of infinite radius is a constant field everywhere - the cleanest way
 * to pose the textbook problem the closed form answers.
 */
function uniformField(b0) {
  const mag = Math.hypot(b0[0], b0[1], b0[2]);
  return [{
    kind: 'sphere',
    center: [0, 0, 0],
    radius: Infinity,
    Br: 1.5 * mag,
    axis: [b0[0] / mag, b0[1] / mag, b0[2] / mag],
  }];
}

/** Iron carries no remanence of its own - that is the entire point. */
const iron = (opts) => createMagnet({ Br: 0, ...opts });

describe('the uniform-field harness really is uniform', () => {
  it('reports the same field wherever it is sampled', () => {
    const f = uniformField([0, 0, 0.01]);
    for (const p of [[0, 0, 0], [30, -12, 7], [-100, 4, 250]]) {
      const b = sampleFaces(f, p);
      expect(b[2]).toBeCloseTo(0.01, 12);
      expect(b[0]).toBeCloseTo(0, 12);
    }
  });
});

describe('a diced sphere reproduces the closed form', () => {
  const chi = SOFT_IRON.chi;
  const b0 = [0, 0, 0.01]; // 10 mT: well clear of saturation

  it('gets the mean magnetisation to about 10%, and no better', () => {
    // This is the model's accuracy limit, asserted rather than hoped for.
    //
    // Cells are cubes replaced by equal-volume spheres, and a sphere is only a
    // good stand-in for a cube at a distance. Nearest neighbours are not at a
    // distance, so they over-couple. Measured per shell, the interior cells
    // come out 44-58% HIGH and the surface shell 27% LOW; the two largely
    // cancel, which is why the mean is respectable and the local values are
    // not. Refining the cells does not help - the error floor sits near 8%
    // from 1.6 mm down to 0.95 mm, because it is a near-field modelling error
    // and not a discretisation one.
    //
    // Getting past this needs Newell's exact prism-to-prism demagnetising
    // tensor instead of the dipole approximation. Until then the solver is
    // honest about being a ~10% model of the aggregate.
    const body = iron({ type: 'sphere', size: { radius: 4 }, position: [0, 0, 0] });
    const exact = sphereMagnetisationExact(chi, b0)[2];

    for (const cellSize of [2.0, 1.3]) {
      const sol = solveSoftIron(body, uniformField(b0), { cellSize, chi, Bs: 99 });
      expect(sol.cells).toBeGreaterThan(4);
      const mean = totalMoment(sol)[2] / (sol.cells * sol.volume);
      const err = Math.abs(mean - exact) / Math.abs(exact);
      expect(err, `cellSize ${cellSize}: got ${mean}, exact ${exact}`)
        .toBeLessThan(0.15);
      // ...and it is biased high, not scattered. Worth knowing which way.
      expect(mean).toBeGreaterThan(exact);
    }
  });

  it('stays stable however finely the body is diced', () => {
    // The property the direct solve buys, and the reason it replaced sweeping.
    // Iterating diverged here: at 1.3 mm cells the same body ran away to 39.7 T
    // per cell, because the iteration matrix has an eigenvalue above 1 and no
    // amount of under-relaxation fixes that.
    const body = iron({ type: 'sphere', size: { radius: 4 } });
    for (const cellSize of [2.0, 1.3, 1.1]) {
      const sol = solveSoftIron(body, uniformField(b0), { cellSize, chi, Bs: 99 });
      for (const j of sol.magnetisation) {
        const mag = Math.hypot(j[0], j[1], j[2]);
        expect(Number.isFinite(mag)).toBe(true);
        expect(mag, `cell blew up at cellSize ${cellSize}`).toBeLessThan(0.2);
      }
    }
  });

  it('a single cell IS the closed form, not an approximation of it', () => {
    // One cell has no neighbours, so the solve collapses to the analytic self
    // term - and that term is the sphere formula. This pins the algebra.
    const body = iron({ type: 'sphere', size: { radius: 2 }, position: [0, 0, 0] });
    const sol = solveSoftIron(body, uniformField(b0), {
      cellSize: 99, chi, Bs: 99,
    });
    expect(sol.cells).toBe(1);
    expect(sol.magnetisation[0][2])
      .toBeCloseTo(sphereMagnetisationExact(chi, b0)[2], 9);
  });

  it('the far field of the diced body is a dipole of the right strength', () => {
    const R = 4;
    const body = iron({ type: 'sphere', size: { radius: R }, position: [0, 0, 0] });
    const sol = solveSoftIron(body, uniformField(b0), {
      cellSize: 1.3, chi, Bs: 99,
    });
    const jExact = sphereMagnetisationExact(chi, b0)[2];

    // On axis, a uniformly magnetised sphere gives B = (2/3) j (R/r)^3.
    for (const r of [30, 60, 120]) {
      const b = sampleFaces(sol.faces, [0, 0, r]);
      const expected = (2 / 3) * jExact * (R / r) ** 3;
      expect(Math.abs(b[2] / expected - 1), `at r = ${r} mm`).toBeLessThan(0.2);
      expect(Math.abs(b[0])).toBeLessThan(Math.abs(b[2]) * 0.02);
    }
  });
});

describe('shape decides how easily iron magnetises', () => {
  // The whole reason a shaped tool works. A long body along the field has
  // little demagnetising factor; the same body across the field fights its own
  // poles. Nothing in the solver is told this - it comes out of the coupling.

  const chi = SOFT_IRON.chi;
  const opts = { cellSize: 2, chi, Bs: 99 };

  it('a rod along the field magnetises far harder than across it', () => {
    const along = iron({ type: 'box', size: { sx: 2, sy: 2, sz: 20 } });
    const across = iron({ type: 'box', size: { sx: 20, sy: 2, sz: 2 } });
    const a = solveSoftIron(along, uniformField([0, 0, 0.005]), opts);
    const c = solveSoftIron(across, uniformField([0, 0, 0.005]), opts);
    expect(a.cells).toBe(c.cells); // the same body, just turned

    const ma = Math.abs(totalMoment(a)[2]);
    const mc = Math.abs(totalMoment(c)[2]);
    expect(ma, `along ${ma} should beat across ${mc}`).toBeGreaterThan(mc * 1.5);
  });

  it('turning the body and turning the field give the same answer', () => {
    // A symmetry the solver cannot fake: nothing in it knows which way is up.
    const zRod = iron({ type: 'box', size: { sx: 2, sy: 2, sz: 16 } });
    const xRod = iron({ type: 'box', size: { sx: 16, sy: 2, sz: 2 } });
    const mz = Math.abs(totalMoment(
      solveSoftIron(zRod, uniformField([0, 0, 0.005]), opts),
    )[2]);
    const mx = Math.abs(totalMoment(
      solveSoftIron(xRod, uniformField([0.005, 0, 0]), opts),
    )[0]);
    expect(mz / mx).toBeCloseTo(1, 3);
  });
});

describe('saturation is what happens against a real magnet', () => {
  it('iron with nothing near it is inert', () => {
    const tip = iron({ type: 'box', size: { sx: 4, sy: 4, sz: 4 }, position: [0, 0, 0] });
    const sol = solveSoftIron(tip, [], { cellSize: 2 });
    expect(sol.cells).toBeGreaterThan(0);
    for (const v of totalMoment(sol)) expect(Math.abs(v)).toBeLessThan(1e-12);
    expect(sol.faces).toHaveLength(0);
  });

  it('a steel tip on a 1.3 T block gets close to saturation but not to it', () => {
    // Worth pinning, because the intuition "anything touching neodymium
    // saturates" is wrong and this is the number that says so. The applied
    // field at the nearest cell is 482 mT and the tip reaches 1.37 T, about
    // 64% of Bs. The linear answer, chi * b with chi ~ 1000, would be 480 T.
    const wand = createMagnet({
      type: 'box', size: { sx: 12, sy: 12, sz: 12 }, position: [0, 0, -8], Br: 1.3,
    });
    const tip = iron({ type: 'box', size: { sx: 4, sy: 4, sz: 4 }, position: [0, 0, 0] });
    const driven = solveSoftIron(tip, buildFaces([wand]), { cellSize: 2 });
    const peak = Math.max(...driven.magnetisation.map((j) => Math.hypot(j[0], j[1], j[2])));
    expect(peak).toBeGreaterThan(1.0);
    expect(peak).toBeLessThan(SOFT_IRON.Bs);
    expect(driven.saturated).toBe(0);
  });

  it('the clamp holds when the iron is driven past Bs', () => {
    // Same arrangement with a lower Bs, which is how a real ferrite behaves.
    const wand = createMagnet({
      type: 'box', size: { sx: 12, sy: 12, sz: 12 }, position: [0, 0, -8], Br: 1.3,
    });
    const tip = iron({ type: 'box', size: { sx: 4, sy: 4, sz: 4 }, position: [0, 0, 0] });
    const Bs = 0.4;
    const driven = solveSoftIron(tip, buildFaces([wand]), { cellSize: 2, Bs });
    expect(driven.saturated, 'nothing saturated at Bs = 0.4 T').toBeGreaterThan(0);
    for (const j of driven.magnetisation) {
      expect(Math.hypot(j[0], j[1], j[2])).toBeLessThanOrEqual(Bs * (1 + 1e-6));
    }
  });

  it('below saturation the response is linear in the applied field', () => {
    const body = iron({ type: 'sphere', size: { radius: 3 } });
    const opts = { cellSize: 1.5, chi: 50, Bs: 99 };
    const one = totalMoment(solveSoftIron(body, uniformField([0, 0, 0.001]), opts))[2];
    const two = totalMoment(solveSoftIron(body, uniformField([0, 0, 0.002]), opts))[2];
    expect(two / one).toBeCloseTo(2, 6);
  });
});

describe('dicing', () => {
  it('fills a body without leaking outside it', () => {
    const body = iron({ type: 'sphere', size: { radius: 5 }, position: [1, -2, 3] });
    const v = voxelize(body, 1);
    expect(v.centers.length).toBeGreaterThan(100);
    for (const c of v.centers) {
      const r = Math.hypot(c[0] - 1, c[1] + 2, c[2] - 3);
      expect(r, 'a cell escaped the body').toBeLessThanOrEqual(5 + 1e-9);
    }
    const diced = v.centers.length * v.volume;
    const exact = (4 / 3) * Math.PI * 125;
    expect(Math.abs(diced / exact - 1), "diced volume vs the true sphere").toBeLessThan(0.08);
  });
});

describe('several bodies in one solve', () => {
  // The UI puts all the iron into a single solve, because solving each body
  // alone would drop the coupling between them - and that coupling is the
  // whole mechanism of a shaped tool, where a bent wire is several pieces
  // whose job is to carry each other's flux around a corner.

  const chi = SOFT_IRON.chi;
  const b0 = [0, 0, 0.01];
  const opts = { cellSize: 1.5, chi, Bs: 99 };

  it('two identical bodies far apart give twice one body', () => {
    const one = iron({ type: 'sphere', size: { radius: 3 }, position: [0, 0, 0] });
    const far = iron({ type: 'sphere', size: { radius: 3 }, position: [400, 0, 0] });
    const single = totalMoment(solveSoftIron([one], uniformField(b0), opts))[2];
    const pair = totalMoment(solveSoftIron([one, far], uniformField(b0), opts))[2];
    expect(pair / single).toBeCloseTo(2, 3);
  });

  it('bodies of different sizes are weighted by their own cell volume', () => {
    // The bug this guards: taking the cell radius and volume from the LAST body
    // diced, which is wrong for every other body the moment they differ.
    const small = iron({ type: 'box', size: { sx: 3, sy: 3, sz: 3 }, position: [0, 0, 0] });
    const big = iron({ type: 'box', size: { sx: 9, sy: 9, sz: 9 }, position: [300, 0, 0] });
    const mS = totalMoment(solveSoftIron([small], uniformField(b0), opts))[2];
    const mB = totalMoment(solveSoftIron([big], uniformField(b0), opts))[2];
    const together = totalMoment(solveSoftIron([small, big], uniformField(b0), opts))[2];
    // Far apart, the pair is the sum of the two solved alone - but only to
    // about 1e-5, because a dipole field never actually reaches zero and at
    // 300 mm these two still feel each other slightly. That residue is the
    // coupling working, not an error in it.
    expect(Math.abs(together - (mS + mB)) / Math.abs(mS + mB)).toBeLessThan(1e-4);
    const swapped = totalMoment(solveSoftIron([big, small], uniformField(b0), opts))[2];
    expect(swapped).toBeCloseTo(together, 9);
  });

  it('touching bodies are not the same as distant ones', () => {
    // If the coupling were dropped, these two would be indistinguishable.
    const a1 = iron({ type: 'box', size: { sx: 3, sy: 3, sz: 9 }, position: [0, 0, 0] });
    const touching = iron({ type: 'box', size: { sx: 3, sy: 3, sz: 9 }, position: [0, 0, 9] });
    const apart = iron({ type: 'box', size: { sx: 3, sy: 3, sz: 9 }, position: [0, 0, 400] });
    const near = totalMoment(solveSoftIron([a1, touching], uniformField(b0), opts))[2];
    const away = totalMoment(solveSoftIron([a1, apart], uniformField(b0), opts))[2];
    // End to end along the field, two bars help each other: less demagnetising
    // factor together than separately.
    expect(near).toBeGreaterThan(away * 1.05);
  });
});

describe('a bent wire puts its own shape on the nail', () => {
  // The mechanism behind the "heart magnet" sold for cat-eye gel: the wire is
  // not the magnet. A plain cylinder supplies the flux, the steel carries it
  // out to wherever its tips are, and what lands on the plate is the wire's
  // outline re-emitted. If that is not what happens, the feature is decoration.

  const barrel = createMagnet({
    type: 'cylinder', Br: 1.3, size: { radius: 5, height: 14 }, position: [0, 0, 16],
  });
  const heart = iron({
    type: 'wire', size: { shape: 'heart', scale: 10, thickness: 0.8 },
    position: [0, 0, 0.9],
  });

  it('the wire is what the nail sees, not the magnet behind it', () => {
    const src = buildFaces([barrel]);
    const sol = solveSoftIron(heart, src, { cellSize: 0.7 });
    expect(sol.cells).toBeGreaterThan(40);

    // Sample the iron's own field just under the plate, on the wire's outline
    // and well outside it. Comparing against the enclosed area would be the
    // wrong test - a closed loop of magnetised wire fills its own middle - so
    // the claim being checked is that the pattern FOLLOWS the wire and falls
    // away from it.
    const path = wirePath('heart', 10);
    const at = (x, y) => Math.hypot(...sampleFaces(sol.faces, [x, y, -0.4]));
    const onWire = path.filter((_, i) => i % 6 === 0).map((p) => at(p[0], p[1]));
    const outside = [[8, 8], [-8, 8], [8, -8], [-8, -8], [0, 9]].map(([x, y]) => at(x, y));

    const meanOn = onWire.reduce((s, v) => s + v, 0) / onWire.length;
    const meanOut = outside.reduce((s, v) => s + v, 0) / outside.length;
    expect(meanOn, 'the outline should be far brighter than the surround')
      .toBeGreaterThan(meanOut * 3);
  });

  it('changing the shape changes the pattern', () => {
    // The strongest statement available: nothing else about the scene moves.
    const src = buildFaces([barrel]);
    const probe = (shape) => {
      const body = iron({
        type: 'wire', size: { shape, scale: 10, thickness: 0.8 },
        position: [0, 0, 0.9],
      });
      const sol = solveSoftIron(body, src, { cellSize: 0.8 });
      // A coarse signature of the pattern over the plate.
      const out = [];
      for (let x = -5; x <= 5; x += 2.5) {
        for (let y = -5; y <= 5; y += 2.5) {
          out.push(Math.hypot(...sampleFaces(sol.faces, [x, y, -0.4])));
        }
      }
      return out;
    };
    const h = probe('heart');
    const r = probe('ring');
    const diff = h.reduce((s, v, i) => s + Math.abs(v - r[i]), 0)
      / h.reduce((s, v) => s + v, 0);
    expect(diff, 'a heart and a ring should not read the same').toBeGreaterThan(0.1);
  });

  it('a wire with no magnet near it does nothing at all', () => {
    const sol = solveSoftIron(heart, [], { cellSize: 0.9 });
    expect(sol.cells).toBeGreaterThan(20);
    expect(sol.faces).toHaveLength(0);
  });
});

describe('the V draws the heart, and the heart does not', () => {
  // The result that matters here, and the one that is easy to get backwards.
  //
  // The tool sold as a "heart magnet" is a wire bent into a V - two short
  // prongs at an angle, nothing more. The heart on the nail is NOT the wire's
  // outline re-emitted. It is a level set of the field, and the level set of
  // two angled poles happens to be heart-shaped: two lobes at the top with a
  // cleft between them, converging to a point below.
  //
  // Bending the wire into an actual heart does the opposite. A closed loop
  // fills its own middle, so it reads as a bright disc rather than an outline.

  const barrel = createMagnet({
    type: 'cylinder', Br: 1.3, size: { radius: 5, height: 14 }, position: [0, 0, 16],
  });

  /** What the wire ADDS over the plate, with the barrel's broad bump removed. */
  function wireField(shape) {
    const src = buildFaces([barrel]);
    const body = iron({
      type: 'wire', size: { shape, scale: 10, thickness: 0.8 },
      position: [0, 0, 0.9],
    });
    const sol = solveSoftIron(body, src, { cellSize: 0.7 });
    return (x, y) => Math.hypot(...sampleFaces(sol.faces, [x, y, -0.4]));
  }

  it('a V gives two lobes with a dark cleft down the middle', () => {
    // The top of a heart. Measured, the cleft is deep: 0.020 on the axis
    // against 0.093 at the lobes, and it holds all the way from y = +4 down
    // to y = -3.
    const at = wireField('vee');
    const y = 2;
    const centre = at(0, y);
    const left = at(-2.6, y);
    const right = at(2.6, y);
    expect(left).toBeCloseTo(right, 6);            // symmetric, as it must be
    expect(centre, `cleft ${centre} vs lobes ${left}`).toBeLessThan(left * 0.4);
  });

  it('...and converges to a single point at the bottom', () => {
    // The cusp. At y = -4 the axis finally becomes the brightest place, which
    // is what closes the heart.
    const at = wireField('vee');
    const y = -4;
    expect(at(0, y)).toBeGreaterThan(at(-2.6, y));
    expect(at(0, y)).toBeGreaterThan(at(2.6, y));
  });

  it('a heart-shaped wire does the OPPOSITE where it matters', () => {
    // Same row, same everything, other shape. A closed loop fills its own
    // middle, so where the V has its cleft the heart has a peak - 0.149 on the
    // axis against 0.055 either side. Bending the wire into the shape you want
    // is precisely the wrong intuition for these tools.
    const vee = wireField('vee');
    const heart = wireField('heart');
    const y = 2;
    expect(vee(0, y)).toBeLessThan(vee(2.6, y));      // cleft
    expect(heart(0, y)).toBeGreaterThan(heart(2.6, y) * 2); // filled
  });
});
