// Time-resolved flake dynamics.
//
// The gate for this module is the same one the field solver had to pass: the
// closed-form solution the fast path uses must agree with a brute-force
// integration of the underlying differential equation. If that fails, nothing
// downstream means anything.

import { describe, it, expect } from 'vitest';
import {
  createFlakes, resetFlakes, stepFlakes, viscosityAt, alignRate, alignTime,
  driftSpeed, transportFlakes, DEFAULT_POLISH,
} from '../src/core/dynamics.js';
import { buildNailGrid, createNail } from '../src/core/nail.js';
import { buildFaces, MU0 } from '../src/core/field.js';
import { computeFinish } from '../src/core/finish.js';
import { createMagnet } from '../src/core/magnet.js';
import { PRESETS } from '../src/core/presets.js';

const RES = { resU: 32, resV: 22 };

const gridFor = (nail) => buildNailGrid({ ...nail, ...RES });

/** Uniform field over every texel, for isolating the rotation. */
function uniformField(grid, v) {
  const B = new Float32Array(grid.count * 3);
  const bmag = new Float32Array(grid.count);
  const m = Math.hypot(...v);
  for (let i = 0; i < grid.count; i++) {
    B[i * 3] = v[0]; B[i * 3 + 1] = v[1]; B[i * 3 + 2] = v[2];
    bmag[i] = m;
  }
  return { B, bmag };
}

describe('the rotation integrator is exact', () => {
  // dtheta/dt = -k sin(theta) cos(theta), solved as
  // tan(theta) = tan(theta0) exp(-k t). Everything else rests on this.
  const rk4 = (theta0, k, T, steps) => {
    let th = theta0;
    const h = T / steps;
    const f = (x) => -k * Math.sin(x) * Math.cos(x);
    for (let i = 0; i < steps; i++) {
      const a = f(th);
      const b = f(th + (h / 2) * a);
      const c = f(th + (h / 2) * b);
      const d = f(th + h * c);
      th += (h / 6) * (a + 2 * b + 2 * c + d);
    }
    return th;
  };
  const closed = (theta0, k, T) =>
    Math.atan2(Math.sin(theta0), Math.cos(theta0) * Math.exp(k * T));

  it('matches brute-force RK4 across the whole range, including past 90 deg', () => {
    // Past 90 degrees matters: a flake on the far side of perpendicular has to
    // turn AWAY from B and settle antiparallel, because the pile is nematic.
    for (const th0 of [0.02, 0.4, 1.0, 1.4, 1.71, 1.9, 2.6, 3.1]) {
      for (const kT of [0.01, 0.3, 1, 4, 25]) {
        expect(closed(th0, 1, kT), `theta0=${th0} kT=${kT}`)
          .toBeCloseTo(rk4(th0, 1, kT, 120000), 7);
      }
    }
  });

  it('90 degrees is an equilibrium, and an unstable one', () => {
    // A flake exactly perpendicular to B feels no torque at all - sin(theta)
    // cos(theta) vanishes - so it stays there. It is unstable, so the smallest
    // nudge either side runs away to 0 or to 180. This is not a numerical
    // wart: it is why a field that is too weak to overcome the spread of
    // starting angles leaves part of the pile stranded, which is where the
    // disordered look of a weak-field region comes from.
    const half = Math.PI / 2;
    // Perpendicular stays perpendicular over any timescale the sim will ever
    // use - twenty time constants leaves it put to eight decimal places.
    expect(closed(half, 1, 20)).toBeCloseTo(half, 7);
    // A displacement either side runs away, and the run-away is exponential:
    // the departure from 90 degrees grows by e per time constant, so a nudge
    // of 1e-3 rad needs about seven of them to reach full alignment.
    expect(closed(half - 1e-3, 1, 40)).toBeLessThan(1e-9);
    expect(closed(half + 1e-3, 1, 40)).toBeGreaterThan(Math.PI - 1e-9);
    // Which is why the perpendicular case only holds up as long as it does:
    // double precision puts pi/2 about 6e-17 off the true equilibrium, so it
    // survives roughly 37 time constants and then leaves too. An equilibrium
    // that needs exact arithmetic to sit in is an unstable one.
    expect(closed(half, 1, 100)).toBeLessThan(1e-20);
  });

  it('is unconditionally stable: one huge step equals many small ones', () => {
    // This is what lets the sim be driven by hand at whatever frame rate the
    // browser feels like giving us. There is no CFL condition to violate.
    const nail = createNail();
    const grid = gridFor(nail);
    const f = uniformField(grid, [0.06, 0, 0.02]);

    const oneStep = createFlakes(grid, { perTexel: 12 });
    stepFlakes(oneStep, grid, f.B, f.bmag, {}, 4);

    const many = createFlakes(grid, { perTexel: 12 });
    for (let i = 0; i < 4000; i++) stepFlakes(many, grid, f.B, f.bmag, {}, 0.001);

    for (let i = 0; i < grid.count; i++) {
      const d = Math.abs(
        oneStep.director[i * 3] * many.director[i * 3]
        + oneStep.director[i * 3 + 1] * many.director[i * 3 + 1]
        + oneStep.director[i * 3 + 2] * many.director[i * 3 + 2],
      );
      expect(d).toBeGreaterThan(0.9999);
    }
  });

  it('directors stay unit length after thousands of steps', () => {
    const grid = gridFor(createNail());
    const fl = createFlakes(grid, { perTexel: 8 });
    const f = uniformField(grid, [0.03, 0.02, -0.05]);
    for (let i = 0; i < 500; i++) stepFlakes(fl, grid, f.B, f.bmag, {}, 0.01);
    for (let i = 0; i < fl.dirs.length; i += 3) {
      expect(Math.hypot(fl.dirs[i], fl.dirs[i + 1], fl.dirs[i + 2]))
        .toBeCloseTo(1, 5);
    }
  });
});

describe('order parameter', () => {
  it('starts at essentially zero: no field, no sheen', () => {
    // A small ensemble of RANDOM directions would report S ~ 0.3 through
    // sampling bias alone, which would paint sheen onto an unmagnetised nail.
    // The Fibonacci start is what keeps this honest.
    const grid = gridFor(createNail());
    for (const [perTexel, bound] of [[8, 0.09], [16, 0.05], [32, 0.03]]) {
      const fl = createFlakes(grid, { perTexel });
      const zero = uniformField(grid, [0, 0, 0]);
      stepFlakes(fl, grid, zero.B, zero.bmag, {}, 0);
      const mean = fl.order.reduce((a, b) => a + b, 0) / grid.count;
      expect(mean, `perTexel=${perTexel}`).toBeLessThan(bound);
    }
  });

  it('reaches 1 in a strong field and stays low in a weak one', () => {
    const grid = gridFor(createNail());
    const meanS = (B, secs) => {
      const fl = createFlakes(grid, { perTexel: 16 });
      // Start well into the drying curve so the weak case cannot simply
      // finish anyway.
      fl.t = 210;
      const f = uniformField(grid, B);
      for (let i = 0; i < 40; i++) {
        fl.t = 210;
        stepFlakes(fl, grid, f.B, f.bmag, {}, secs / 40);
      }
      return fl.order.reduce((a, b) => a + b, 0) / grid.count;
    };
    expect(meanS([0, 0, 0.2], 4)).toBeGreaterThan(0.98);
    expect(meanS([0, 0, 0.002], 4)).toBeLessThan(0.4);
  });

  it('nothing moves once the coat has set', () => {
    const grid = gridFor(createNail());
    const fl = createFlakes(grid, { perTexel: 12 });
    const f = uniformField(grid, [0, 0, 0.2]);
    fl.t = 1e5; // long past setting
    stepFlakes(fl, grid, f.B, f.bmag, {}, 10);
    expect(fl.frozen).toBe(true);
    const mean = fl.order.reduce((a, b) => a + b, 0) / grid.count;
    expect(mean).toBeLessThan(0.06); // still the disordered starting state
  });
});

describe('the static model is the long-time limit', () => {
  it('a tool held still reproduces computeFinish to a hundredth of a degree', () => {
    // The most important test here. Everything already validated about the
    // steady-state finish model has to survive the addition of time, and the
    // way it survives is by being what the dynamics converges to.
    const { nail, magnets } = PRESETS.catEye.build();
    const grid = gridFor(nail);
    const faces = buildFaces(magnets);
    const stat = computeFinish(grid, faces, {});

    const fl = createFlakes(grid, { perTexel: 16 });
    stepFlakes(fl, grid, stat.B, stat.bmag, {}, 2);
    const dyn = computeFinish(grid, faces, {
      director: fl.director, order: fl.order,
    });

    let worst = 0;
    let sum = 0;
    for (let i = 0; i < grid.count; i++) {
      const d = Math.abs(
        dyn.chain[i * 3] * stat.chain[i * 3]
        + dyn.chain[i * 3 + 1] * stat.chain[i * 3 + 1]
        + dyn.chain[i * 3 + 2] * stat.chain[i * 3 + 2],
      );
      const a = Math.acos(Math.min(1, d)) * 180 / Math.PI;
      sum += a;
      worst = Math.max(worst, a);
    }
    expect(sum / grid.count).toBeLessThan(0.01);
    expect(worst).toBeLessThan(1.5); // one texel at the field null may lag
    // ...and every derived readout agrees too.
    expect(dyn.stats.chainSpread).toBeCloseTo(stat.stats.chainSpread, 1);
    expect(dyn.stats.meanTilt).toBeCloseTo(stat.stats.meanTilt, 1);
    expect(dyn.stats.fanKind).toBe(stat.stats.fanKind);
  });
});

describe('rheology', () => {
  it('viscosity climbs exponentially, and gel does not climb at all', () => {
    const p = { ...DEFAULT_POLISH };
    expect(viscosityAt(p, 0)).toBeCloseTo(p.eta0, 9);
    expect(viscosityAt(p, p.dryTime) / viscosityAt(p, 0)).toBeCloseTo(Math.E, 6);
    expect(viscosityAt(p, 2 * p.dryTime) / viscosityAt(p, p.dryTime))
      .toBeCloseTo(Math.E, 6);

    const gel = { ...p, kind: 'gel' };
    expect(viscosityAt(gel, 0)).toBe(gel.eta0);
    expect(viscosityAt(gel, 1e4)).toBe(gel.eta0);
    expect(viscosityAt({ ...gel, cured: true }, 0)).toBe(Infinity);
  });

  it('alignment rate is chi B^2 / (6 mu0 eta) below saturation', () => {
    const p = { ...DEFAULT_POLISH, Bsat: 1e4 }; // far from saturation
    for (const B of [0.001, 0.01, 0.05]) {
      for (const eta of [0.3, 10, 500]) {
        const want = (p.chi * B * B) / (6 * MU0 * eta);
        // Relative, because the rate spans six orders of magnitude here.
        expect(alignRate(p, eta, B) / want, `B=${B} eta=${eta}`)
          .toBeCloseTo(1, 8);
      }
    }
  });

  it('saturation turns the B^2 law into a B law', () => {
    const p = { ...DEFAULT_POLISH, Bsat: 0.05 };
    const r = (B) => alignRate(p, 1, B);
    // Well below saturation, doubling B quadruples the rate.
    expect(r(0.004) / r(0.002)).toBeCloseTo(4, 1);
    // Well above it, doubling B only doubles the rate.
    expect(r(2) / r(1)).toBeCloseTo(2, 2);
  });

  it('orientation outruns transport by four orders of magnitude', () => {
    // The quantitative reason this is a shading model and not a transport
    // model. k has no particle radius in it; the drift velocity goes as a^2.
    // At pigment sizes the two timescales are nowhere near each other.
    const p = { ...DEFAULT_POLISH };
    const eta = viscosityAt(p, 0);
    const tAlign = alignTime(p, eta, 0.1);            // seconds to turn
    const v = driftSpeed(p, eta, 0.01);               // mm/s up-gradient
    const tMove = 1 / v;                              // seconds to travel 1 mm
    expect(tAlign).toBeLessThan(1e-3);
    expect(tMove / tAlign).toBeGreaterThan(1e4);
  });

  it('transport conserves pigment and never goes negative', () => {
    const nail = createNail();
    const grid = gridFor(nail);
    const fl = createFlakes(grid, { perTexel: 6 });
    const gradB2 = new Float32Array(grid.count).fill(0.05);
    const tangent = new Float32Array(grid.count * 2);
    for (let i = 0; i < grid.count; i++) {
      tangent[i * 2] = 0.4;      // steady drift toward the free edge
      tangent[i * 2 + 1] = 0.1;
    }
    const total = (a) => a.reduce((x, y) => x + y, 0);
    const before = total(fl.conc);
    for (let i = 0; i < 60; i++) {
      transportFlakes(fl, grid, gradB2, tangent, { mobility: 400 }, 0.1);
    }
    expect(total(fl.conc)).toBeCloseTo(before, 3);
    expect(Math.min(...fl.conc)).toBeGreaterThanOrEqual(0);
    // ...and it actually moved something.
    expect(Math.max(...fl.conc)).toBeGreaterThan(1.05);
  });
});

describe('determinism', () => {
  it('same seed, same coat', () => {
    const grid = gridFor(createNail());
    const run = () => {
      const fl = createFlakes(grid, { perTexel: 10, seed: 7 });
      const f = uniformField(grid, [0.02, 0.01, 0.03]);
      for (let i = 0; i < 20; i++) stepFlakes(fl, grid, f.B, f.bmag, {}, 0.05);
      return fl.director;
    };
    const a = run();
    const b = run();
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('resetting gives back the fresh coat exactly', () => {
    const grid = gridFor(createNail());
    const fl = createFlakes(grid, { perTexel: 10, seed: 3 });
    const fresh = Float32Array.from(fl.dirs);
    const f = uniformField(grid, [0.1, 0, 0]);
    for (let i = 0; i < 10; i++) stepFlakes(fl, grid, f.B, f.bmag, {}, 0.1);
    expect(fl.t).toBeGreaterThan(0);
    resetFlakes(fl, grid);
    expect(fl.t).toBe(0);
    for (let i = 0; i < fresh.length; i++) expect(fl.dirs[i]).toBe(fresh[i]);
  });
});
