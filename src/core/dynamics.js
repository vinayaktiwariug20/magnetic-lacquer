// Time-resolved flake dynamics: what the pile does WHILE the polish dries.
//
// The static finish model in finish.js answers "where does the pile end up if
// it has all the time in the world". That is the right model for a magnet held
// still until the polish sets, and it is wrong for every technique that
// involves MOVING the tool - spinning a horseshoe, walking a wand from one
// corner to the other - because those depend on the pile lagging behind the
// field. This module adds the missing time axis.
//
// ---------------------------------------------------------------------------
// THE ONE EQUATION
// ---------------------------------------------------------------------------
//
// A flake in polish is overdamped to an absurd degree. A 12 um platelet in a
// 0.3 Pa.s fluid has a Reynolds number around 1e-8 and its inertia decays in
// well under a nanosecond, so there is no oscillation, no overshoot and no
// ringing: viscous torque balances magnetic torque at every instant.
//
// The pigment is magnetically soft and platelet shaped, so its moment is
// INDUCED along the applied field and its easy axis lies in the plane of the
// flake. The energy is therefore
//
//     U = -(1/2) (chi V / mu0) B^2 cos^2(theta)
//
// with theta the angle between the flake's easy axis and B. Note cos^2, not
// cos: the flake has no head and no tail, so theta and theta+pi are the same
// state. That is what makes the pile NEMATIC, and it is why the sheen never
// depends on which way round you hold the magnet.
//
// Balancing -dU/dtheta against a rotational drag zeta_r = 8 pi eta a^3 gives
//
//     dtheta/dt = -k sin(theta) cos(theta),      k = chi B^2 / (6 mu0 eta)
//
// and this has an EXACT solution:
//
//     tan(theta(t)) = tan(theta_0) * exp(-k t)
//
// Two consequences worth stating plainly.
//
//   The flake radius cancels out of k. Orientation does not care how big the
//   flakes are - only chi, B and the viscosity. (Transport does care: see
//   driftSpeed below, where a^2 survives. That asymmetry is the whole reason
//   orientation dominates in practice.)
//
//   Because the solution is exact, the integrator is unconditionally stable
//   for ANY timestep. You can swing a magnet as fast as you like and the worst
//   that happens is that the answer gets less accurate as B changes within a
//   step; it never blows up and never needs a CFL condition. That is what makes
//   a real-time, hand-driven sim viable at all.
//
// The alignment time constant is 1/k. At 100 mT in fresh polish that is about
// 90 microseconds - instantaneous, which is why the static model works so well
// for a magnet held still. The interesting regime is the drying tail, where eta
// has climbed by four or five orders of magnitude and 1/k reaches human
// timescales. That is the working window every technique lives in.
//
// ---------------------------------------------------------------------------
// ORDER IS MEASURED HERE, NOT ASSUMED
// ---------------------------------------------------------------------------
//
// The static model needs an `orderThreshold` slider to say "below this field
// the flakes stay random". Here that is not a parameter: each texel carries an
// ENSEMBLE of flakes started from a spread of directions, and each one relaxes
// at its own rate. In a weak field they simply have not finished turning when
// the polish sets, so the ensemble stays spread out and the order parameter
// comes out low on its own. The threshold is an emergent consequence of the
// drying time, which is the honest way round.
//
// The ensemble is reduced with the nematic order tensor
//
//     Q = <n n^T>,   S = (3 lambda_max - 1) / 2
//
// S = 1 is a perfectly aligned pile, S = 0 is randomly oriented, and the
// eigenvector belonging to lambda_max is the director the shader uses.

import { MU0 } from './field.js';

export const DEFAULT_POLISH = {
  // 'regular' dries by evaporation; 'gel' holds its viscosity until it is
  // cured, then freezes instantly.
  kind: 'regular',

  // Viscosity of the fresh polish, Pa.s. Nail lacquer straight from the bottle
  // is around 0.2 - 1; a thick, heavily pigmented one is higher. This is the
  // "how runny is it" knob.
  eta0: 0.35,

  // e-folding time of the viscosity rise, seconds. Viscosity climbs as
  // eta(t) = eta0 exp(t / dryTime), which is the standard picture for a
  // solvent-loss thickening: the solvent leaves at a roughly constant rate and
  // viscosity depends exponentially on what is left.
  dryTime: 26,

  // Above this the pile is frozen and no longer responds at all, Pa.s.
  setViscosity: 4000,

  // Effective susceptibility of the pigment along its easy axis.
  chi: 3,

  // The pigment saturates: past this field the induced moment stops growing,
  // so the alignment rate goes from B^2 to B. Tesla.
  Bsat: 0.05,

  // Hydrodynamic radius of a flake, metres. Only transport uses it.
  flakeRadius: 6e-6,

  // Spread of the alignment rate across the pigment, as the sigma of a
  // log-normal multiplier on k. This is not a fudge factor - it is the single
  // most important thing in the whole module, and leaving it out gives visibly
  // wrong answers for every moving technique.
  //
  // Real pigment is polydisperse: flakes differ in size, thickness, aspect
  // ratio and iron loading, so chi and the shape anisotropy differ, so k
  // differs. That matters because the alignment ODE is CONTRACTING - with a
  // single k, every flake in a texel converges onto the same trajectory and
  // stays there. Spin a magnet over a monodisperse pile and the whole ensemble
  // tracks it in lockstep with one common phase lag, staying perfectly ordered;
  // stop the magnet and you get an ordinary cat eye. No scatter, no bead.
  //
  // Give the flakes a spread of k and they fan out in phase instead. Fast ones
  // keep up with the rotating field, slow ones lag, and the ensemble smears
  // around the cone the field is sweeping - the order parameter collapses and
  // the texel scatters light in every direction rather than mirroring it in
  // one. That is the glass-bead finish, and polydispersity is what produces it.
  kSpread: 0.55,

  // Transport is off by default. It is the more speculative half of the model
  // and, as the numbers below show, it stops mattering long before orientation
  // does.
  transport: false,
  mobility: 1,
};

/** Viscosity in Pa.s at elapsed time t (seconds). */
export function viscosityAt(polish, t) {
  const P = { ...DEFAULT_POLISH, ...polish };
  if (P.kind === 'gel') {
    // Gel does not dry. It stays workable indefinitely and then sets the
    // instant it goes under the lamp, which is exactly why gel is the forgiving
    // one to practise on: the working window is however long you want.
    return P.cured ? Infinity : P.eta0;
  }
  return P.eta0 * Math.exp(t / Math.max(1e-6, P.dryTime));
}

/**
 * Alignment rate k = chi Beff B / (6 mu0 eta), in 1/s. The time constant is
 * 1/k. Beff = Bsat tanh(B / Bsat) rolls the induced moment off smoothly at
 * saturation, so k goes as B^2 in weak fields and as B in strong ones.
 */
export function alignRate(polish, eta, B) {
  const P = { ...DEFAULT_POLISH, ...polish };
  if (!(eta > 0) || !Number.isFinite(eta) || B <= 0) return 0;
  const beff = P.Bsat * Math.tanh(B / Math.max(1e-12, P.Bsat));
  return (P.chi * beff * B) / (6 * MU0 * eta);
}

/** Alignment time constant in seconds; Infinity when nothing can turn. */
export function alignTime(polish, eta, B) {
  const k = alignRate(polish, eta, B);
  return k > 0 ? 1 / k : Infinity;
}

/**
 * Drift speed of a flake up the field gradient, mm/s, given |grad(B^2)| in
 * T^2/mm.
 *
 *     F = grad(m.B) = (chi V / 2 mu0) grad(B^2),   v = F / (6 pi eta a)
 *
 * so v = chi a^2 |grad(B^2)| / (9 mu0 eta). The a^2 is the point: unlike
 * rotation, translation scales with the square of the particle size, so
 * transport is feeble for pigment-sized flakes while orientation is not.
 */
export function driftSpeed(polish, eta, gradB2PerMm) {
  const P = { ...DEFAULT_POLISH, ...polish };
  if (!(eta > 0) || !Number.isFinite(eta)) return 0;
  const a = P.flakeRadius;
  // 1e6 converts T^2/mm -> T^2/m and then m/s -> mm/s.
  return (P.mobility * 1e6 * P.chi * a * a * gradB2PerMm) / (9 * MU0 * eta);
}

// ---------------------------------------------------------------------------
// Flake ensemble state
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * N directions spread evenly over a hemisphere by the Fibonacci construction.
 *
 * Starting the ensemble from a low-discrepancy set rather than from N random
 * draws matters: N random directions have a large-eigenvalue bias of order
 * 1/sqrt(N), so a small random ensemble reports S ~ 0.3 when it is in fact
 * completely disordered. A Fibonacci set starts within a few per cent of
 * S = 0, so "no field means no sheen" comes out right without a fudge.
 */
function fibonacciHemisphere(n) {
  const out = new Float64Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    // z over (0,1]: a hemisphere, since the pile is nematic and n = -n.
    const z = (i + 0.5) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = golden * i;
    out[i * 3] = r * Math.cos(th);
    out[i * 3 + 1] = r * Math.sin(th);
    out[i * 3 + 2] = z;
  }
  return out;
}

/** A uniformly random rotation matrix (3x3, row major) from three uniforms. */
function randomRotation(rnd, m) {
  // Arvo's method: a random rotation about z composed with a Householder
  // reflection. Uniform on SO(3), and cheap.
  const th = 2 * Math.PI * rnd();
  const ph = 2 * Math.PI * rnd();
  const zz = rnd();
  const r = Math.sqrt(zz);
  const vx = Math.cos(ph) * r;
  const vy = Math.sin(ph) * r;
  const vz = Math.sqrt(1 - zz);
  const st = Math.sin(th);
  const ct = Math.cos(th);
  const sx = vx * ct - vy * st;
  const sy = vx * st + vy * ct;

  m[0] = vx * sx - ct; m[1] = vx * sy - st; m[2] = vx * vz;
  m[3] = vy * sx + st; m[4] = vy * sy - ct; m[5] = vy * vz;
  m[6] = vz * sx;      m[7] = vz * sy;      m[8] = vz * vz - 1;
}

/**
 * Create the per-texel flake ensembles for a grid.
 *
 * @param {object} grid            from buildNailGrid
 * @param {object} opts.perTexel   flakes per texel (default 12)
 * @param {number} opts.seed       deterministic, so runs are reproducible
 */
export function createFlakes(grid, opts = {}) {
  const perTexel = Math.max(3, Math.round(opts.perTexel ?? 16));
  const seed = opts.seed ?? 12345;
  const n = grid.count;

  const dirs = new Float32Array(n * perTexel * 3);
  const base = fibonacciHemisphere(perTexel);
  const rnd = mulberry32(seed);
  const m = new Float64Array(9);

  // Per-flake alignment-rate multipliers, log-normal with unit median. Fixed
  // per flake for the life of the coat: a given particle keeps its size.
  const sigma = Math.max(0, opts.kSpread ?? DEFAULT_POLISH.kSpread);
  const gain = new Float32Array(perTexel);
  for (let f = 0; f < perTexel; f++) {
    // Box-Muller for a normal deviate, exponentiated.
    const u1 = Math.max(1e-12, rnd());
    const u2 = rnd();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    gain[f] = Math.exp(sigma * g);
  }

  for (let i = 0; i < n; i++) {
    // Each texel gets the same well-spread set under a different random
    // rotation, so neighbouring texels are not correlated but every one starts
    // equally disordered.
    randomRotation(rnd, m);
    for (let f = 0; f < perTexel; f++) {
      const x = base[f * 3];
      const y = base[f * 3 + 1];
      const z = base[f * 3 + 2];
      const o = (i * perTexel + f) * 3;
      dirs[o] = m[0] * x + m[1] * y + m[2] * z;
      dirs[o + 1] = m[3] * x + m[4] * y + m[5] * z;
      dirs[o + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
  }

  return {
    perTexel,
    count: n,
    seed,
    kSpread: sigma,
    dirs,
    gain,
    director: new Float32Array(n * 3),
    order: new Float32Array(n),
    conc: new Float32Array(n).fill(1),
    t: 0,
    frozen: false,
    // Diagnostics filled in by stepFlakes.
    eta: 0,
    meanAlignTime: 0,
    meanDrift: 0,
  };
}

/** Reset to a fresh, disordered coat without reallocating. */
export function resetFlakes(flakes, grid) {
  const fresh = createFlakes(grid, {
    perTexel: flakes.perTexel, seed: flakes.seed, kSpread: flakes.kSpread,
  });
  flakes.dirs.set(fresh.dirs);
  flakes.gain.set(fresh.gain);
  flakes.director.fill(0);
  flakes.conc.fill(1);
  flakes.t = 0;
  flakes.frozen = false;
  return flakes;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Advance every flake by dt seconds in the sampled field, then reduce each
 * ensemble to a director and an order parameter.
 *
 * @param {object} flakes  from createFlakes
 * @param {object} grid    from buildNailGrid
 * @param {Float32Array} B per-texel field, 3 per texel, tesla (from computeFinish)
 * @param {Float32Array} bmag per-texel |B|
 * @param {object} polish  see DEFAULT_POLISH
 * @param {number} dt      seconds
 */
export function stepFlakes(flakes, grid, B, bmag, polish, dt) {
  const P = { ...DEFAULT_POLISH, ...polish };
  const n = flakes.count;
  const N = flakes.perTexel;
  const dirs = flakes.dirs;

  const eta = viscosityAt(P, flakes.t);
  flakes.eta = eta;
  flakes.frozen = !(eta < P.setViscosity);

  // A set coat still gets its director and order reported - it just stops
  // changing. Rotating with dt = 0 is exactly that, so we fall through to the
  // reduction below instead of returning early.
  const step = flakes.frozen ? 0 : Math.max(0, dt);

  let alignSum = 0;
  let alignCount = 0;

  for (let i = 0; i < n; i++) {
    const bm = bmag[i];
    const o3 = i * 3;

    if (step > 0 && bm > 1e-9) {
      const k = alignRate(P, eta, bm);
      if (k > 0) {
        alignSum += 1 / k;
        alignCount++;

        const bx = B[o3] / bm;
        const by = B[o3 + 1] / bm;
        const bz = B[o3 + 2] / bm;

        const fbase = i * N * 3;
        for (let f = 0; f < N; f++) {
          // Each flake turns at its own rate. exp() can legitimately overflow
          // to Infinity, which atan2 handles as "fully aligned" - the correct
          // limit, not an error.
          const E = Math.exp(k * flakes.gain[f] * step);
          const q = fbase + f * 3;
          let nx = dirs[q];
          let ny = dirs[q + 1];
          let nz = dirs[q + 2];

          // Nematic: flip into the hemisphere around B so the flake always
          // takes the short way round. Without this a flake at 179 degrees
          // would crawl the long way to 180 instead of snapping to 0.
          let c = nx * bx + ny * by + nz * bz;
          if (c < 0) { nx = -nx; ny = -ny; nz = -nz; c = -c; }

          // Rotation axis n x b, whose length is sin(theta).
          let ax = ny * bz - nz * by;
          let ay = nz * bx - nx * bz;
          let az = nx * by - ny * bx;
          const s = Math.hypot(ax, ay, az);
          if (s < 1e-12) {
            // Already aligned (c > 0 here, so this is not the unstable
            // anti-aligned case). Nothing to do.
            dirs[q] = nx; dirs[q + 1] = ny; dirs[q + 2] = nz;
            continue;
          }
          ax /= s; ay /= s; az /= s;

          // theta1 = atan2(sin, cos * exp(k dt)) is tan(theta1) =
          // tan(theta0) exp(-k dt) written so it stays accurate at both ends.
          const th0 = Math.atan2(s, c);
          const th1 = Math.atan2(s, c * E);
          const d = th0 - th1;
          const cd = Math.cos(d);
          const sd = Math.sin(d);

          // Rodrigues, with the axis perpendicular to n so the third term
          // drops out entirely.
          const cx = ay * nz - az * ny;
          const cy = az * nx - ax * nz;
          const cz = ax * ny - ay * nx;
          let rx = nx * cd + cx * sd;
          let ry = ny * cd + cy * sd;
          let rz = nz * cd + cz * sd;
          const l = Math.hypot(rx, ry, rz) || 1;
          dirs[q] = rx / l; dirs[q + 1] = ry / l; dirs[q + 2] = rz / l;
        }
      }
    }

    // --- reduce the ensemble to a director and an order parameter ----------
    reduceEnsemble(flakes, i, N);
  }

  flakes.meanAlignTime = alignCount ? alignSum / alignCount : Infinity;
  if (!flakes.frozen) flakes.t += Math.max(0, dt);
  return flakes;
}

/**
 * Nematic order tensor of one texel's ensemble, reduced by power iteration
 * seeded from last frame's director (so it converges in two or three
 * iterations and does not flicker between frames).
 */
function reduceEnsemble(flakes, i, N) {
  const dirs = flakes.dirs;
  const fbase = i * N * 3;

  let qxx = 0, qyy = 0, qzz = 0, qxy = 0, qxz = 0, qyz = 0;
  for (let f = 0; f < N; f++) {
    const q = fbase + f * 3;
    const x = dirs[q];
    const y = dirs[q + 1];
    const z = dirs[q + 2];
    qxx += x * x; qyy += y * y; qzz += z * z;
    qxy += x * y; qxz += x * z; qyz += y * z;
  }
  const inv = 1 / N;
  qxx *= inv; qyy *= inv; qzz *= inv; qxy *= inv; qxz *= inv; qyz *= inv;

  const o3 = i * 3;
  let vx = flakes.director[o3];
  let vy = flakes.director[o3 + 1];
  let vz = flakes.director[o3 + 2];
  if (!(vx * vx + vy * vy + vz * vz > 1e-6)) {
    // First call, or a texel that has never been reduced: seed from the first
    // flake, which is guaranteed to have a non-zero overlap with the dominant
    // eigenvector unless the ensemble is exactly isotropic.
    vx = dirs[fbase]; vy = dirs[fbase + 1]; vz = dirs[fbase + 2];
  }

  let lambda = 0;
  for (let it = 0; it < 8; it++) {
    const wx = qxx * vx + qxy * vy + qxz * vz;
    const wy = qxy * vx + qyy * vy + qyz * vz;
    const wz = qxz * vx + qyz * vy + qzz * vz;
    const l = Math.hypot(wx, wy, wz);
    if (l < 1e-20) break;
    vx = wx / l; vy = wy / l; vz = wz / l;
    lambda = l;
  }

  flakes.director[o3] = vx;
  flakes.director[o3 + 1] = vy;
  flakes.director[o3 + 2] = vz;
  // S = (3 lambda_max - 1) / 2, clamped: lambda is in [1/3, 1] for a trace-1
  // PSD tensor, so S lands in [0, 1].
  flakes.order[i] = Math.min(1, Math.max(0, (3 * lambda - 1) / 2));
}

// ---------------------------------------------------------------------------
// Transport (optional)
// ---------------------------------------------------------------------------

/**
 * Advect the flake concentration up the field gradient across the nail
 * surface, conservatively.
 *
 * This is the "pulling the glitter" half of the story, and it is off by
 * default because the numbers say it stops mattering almost immediately.
 * Rotation and translation share the same viscosity but scale differently with
 * particle size - k has no a in it, v has a^2 - so at pigment sizes the two
 * timescales are separated by about four orders of magnitude. Flakes finish
 * turning in microseconds and have barely moved a micron in that time; by the
 * time they could have travelled a visible distance, the polish has thickened
 * enough to stop them. Turn it on to see how little it changes.
 *
 * Donor-cell upwind on the (u, v) index lattice with CFL-limited substeps, so
 * total pigment is conserved exactly and nothing leaves the nail.
 */
export function transportFlakes(flakes, grid, gradB2, tangent, polish, dt) {
  const P = { ...DEFAULT_POLISH, ...polish };
  const eta = viscosityAt(P, flakes.t);
  if (!(eta > 0) || !Number.isFinite(eta) || eta >= P.setViscosity) return flakes;

  const { nu, nv } = grid;
  const conc = flakes.conc;

  // Index-space velocities, cells per second.
  const cu = new Float32Array(grid.count);
  const cv = new Float32Array(grid.count);
  let cflMax = 0;
  let driftSum = 0;

  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      const i = iu * nv + iv;
      const g = gradB2[i];
      const speed = driftSpeed(P, eta, g); // mm/s
      driftSum += speed;
      // tangent holds the unit up-gradient direction resolved onto the surface,
      // already expressed in (du, dv) per mm; see surfaceGradient below.
      const a = speed * tangent[i * 2];
      const b = speed * tangent[i * 2 + 1];
      cu[i] = a;
      cv[i] = b;
      const c = Math.abs(a) + Math.abs(b);
      if (c > cflMax) cflMax = c;
    }
  }
  flakes.meanDrift = driftSum / grid.count;

  if (cflMax <= 0) return flakes;
  const sub = Math.min(64, Math.max(1, Math.ceil((cflMax * dt) / 0.4)));
  const h = dt / sub;

  const next = new Float32Array(grid.count);
  for (let s = 0; s < sub; s++) {
    next.set(conc);
    // u-direction fluxes between (iu, iv) and (iu+1, iv)
    for (let iu = 0; iu < nu - 1; iu++) {
      for (let iv = 0; iv < nv; iv++) {
        const i = iu * nv + iv;
        const j = i + nv;
        const vel = 0.5 * (cu[i] + cu[j]);
        const f = h * (vel > 0 ? vel * conc[i] : vel * conc[j]);
        next[i] -= f;
        next[j] += f;
      }
    }
    for (let iu = 0; iu < nu; iu++) {
      for (let iv = 0; iv < nv - 1; iv++) {
        const i = iu * nv + iv;
        const j = i + 1;
        const vel = 0.5 * (cv[i] + cv[j]);
        const f = h * (vel > 0 ? vel * conc[i] : vel * conc[j]);
        next[i] -= f;
        next[j] += f;
      }
    }
    for (let i = 0; i < grid.count; i++) conc[i] = Math.max(0, next[i]);
  }
  return flakes;
}
