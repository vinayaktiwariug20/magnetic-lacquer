// Field solver: superposition over every pole face of every magnet.
//
// mu_r ~ 1.05 for NdFeB, so magnetisation is treated as fixed and the total
// field is a plain vector sum - no mutual demagnetisation, no iteration.

import { rectFieldWorld } from './rect.js';
import { discFieldWorld } from './disc.js';
import { gaussLegendre } from './quadrature.js';
import { magnetFaces } from './magnet.js';
import { cross, dot, len, mul, norm, sub, add } from './vec.js';

/**
 * Vacuum permeability, T.m/A. The field path never needs it - faces carry
 * sigmaB = mu0 sigma_m directly in tesla - but anything that converts back to a
 * magnetisation or a force does.
 */
export const MU0 = 4 * Math.PI * 1e-7;

/**
 * Flatten a magnet list into a face list once, then reuse it for every sample.
 * This is the hot-path optimisation: face construction involves quaternion work
 * that must not happen per texel.
 */
export function buildFaces(magnets) {
  const faces = [];
  for (const m of magnets) faces.push(...magnetFaces(m));
  return faces;
}

/**
 * Field of a uniformly magnetised SPHERE. Outside, this is exactly a point
 * dipole - no approximation whatever:
 *
 *   B = (Br R^3 / 3) [ 3 (mhat . rhat) rhat - mhat ] / r^3
 *
 * and inside it is exactly the uniform (2/3) Br mhat. Every other magnet here
 * needs a surface integral; this one is closed form everywhere, which makes a
 * sphere the natural reference magnet.
 */
function sphereFieldWorld(f, p, out) {
  const dx = p[0] - f.center[0];
  const dy = p[1] - f.center[1];
  const dz = p[2] - f.center[2];
  const r = Math.hypot(dx, dy, dz);
  const a = f.axis;

  if (r <= f.radius) {
    const k = (2 / 3) * f.Br;
    out[0] += k * a[0]; out[1] += k * a[1]; out[2] += k * a[2];
    return out;
  }

  const inv = 1 / r;
  const ux = dx * inv;
  const uy = dy * inv;
  const uz = dz * inv;
  const md = a[0] * ux + a[1] * uy + a[2] * uz;
  const k = (f.Br * f.radius * f.radius * f.radius) / (3 * r * r * r);

  out[0] += k * (3 * md * ux - a[0]);
  out[1] += k * (3 * md * uy - a[1]);
  out[2] += k * (3 * md * uz - a[2]);
  return out;
}

/** B (tesla) at world point p, given a prebuilt face list. */
export function sampleFaces(faces, p, out) {
  const o = out || [0, 0, 0];
  o[0] = 0; o[1] = 0; o[2] = 0;
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (f.kind === 'rect') rectFieldWorld(f, p, o);
    else if (f.kind === 'sphere') sphereFieldWorld(f, p, o);
    else discFieldWorld(f, p, o);
  }
  return o;
}

/** Convenience wrapper: B at p from a magnet list. */
export function sampleB(magnets, p) {
  return sampleFaces(buildFaces(magnets), p);
}

/**
 * Gradient of |B| by central differences. Used for diagnostics and for the
 * up-gradient drift intuition behind the concentration model.
 */
export function gradBMag(faces, p, h = 0.05) {
  const g = [0, 0, 0];
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const pa = [...p];
    const pb = [...p];
    pa[k] -= h;
    pb[k] += h;
    g[k] = (len(sampleFaces(faces, pb, b)) - len(sampleFaces(faces, pa, a))) / (2 * h);
  }
  return g;
}

/** Numerical div B. Should be ~0 everywhere outside the magnets. */
export function divB(faces, p, h = 0.05) {
  let d = 0;
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const pa = [...p];
    const pb = [...p];
    pa[k] -= h;
    pb[k] += h;
    d += (sampleFaces(faces, pb, b)[k] - sampleFaces(faces, pa, a)[k]) / (2 * h);
  }
  return d;
}

/** Numerical curl B. Should be ~0 in current-free space outside the magnets. */
export function curlB(faces, p, h = 0.05) {
  const d = [];
  for (let k = 0; k < 3; k++) {
    const pa = [...p];
    const pb = [...p];
    pa[k] -= h;
    pb[k] += h;
    const a = sampleFaces(faces, pa, [0, 0, 0]);
    const b = sampleFaces(faces, pb, [0, 0, 0]);
    d.push([(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)]);
  }
  // d[i][j] = dB_j / dx_i
  return [
    d[1][2] - d[2][1],
    d[2][0] - d[0][2],
    d[0][1] - d[1][0],
  ];
}

/**
 * Trace a field line from `seed` by arc-length RK4 on the unit field
 * direction, with step-doubling error control.
 *
 * The adaptivity is not a nicety. The field has a logarithmic singularity
 * along every pole-face EDGE, and the direction there turns over a length
 * scale that goes to zero. A fixed 0.25 mm step sails straight through it and
 * produces trajectories that visibly cross one another - which then reads as a
 * physics bug when it is really integrator error. Each step is taken once at h
 * and again as two h/2 steps; the disagreement drives h.
 *
 * @param {object[]} faces
 * @param {number[]} seed
 * @param {object} [opts] {step, minStep, tol, maxSteps, dir, bound, nullEps, stop}
 *   `stop(p)` lets callers halt at a magnet surface - inside the material the
 *   surface-charge model yields H rather than B, so lines there are meaningless
 *   and would spuriously converge onto one another at the pole face.
 * @returns {{points:number[][], hitNull:boolean, escaped:boolean, stalled:boolean}}
 */
export function streamline(faces, seed, opts = {}) {
  const maxStep = opts.step ?? 0.4;
  const minStep = opts.minStep ?? maxStep * 1e-3;
  const tol = opts.tol ?? 1e-5;
  const maxSteps = opts.maxSteps ?? 2000;
  const dir = opts.dir ?? 1;
  const bound = opts.bound ?? 200;
  const nullEps = opts.nullEps ?? 1e-6;
  const stop = opts.stop ?? null;

  const points = [[...seed]];
  let p = [...seed];
  let h = maxStep;
  const tmp = [0, 0, 0];

  const f = (q) => {
    const b = sampleFaces(faces, q, tmp);
    const l = len(b);
    if (l < nullEps) return null;
    return [(dir * b[0]) / l, (dir * b[1]) / l, (dir * b[2]) / l];
  };

  /** One classical RK4 step of length s. Returns null at a field null. */
  const rk4 = (q, s) => {
    const k1 = f(q);
    if (!k1) return null;
    const k2 = f(add(q, mul(k1, s * 0.5)));
    if (!k2) return null;
    const k3 = f(add(q, mul(k2, s * 0.5)));
    if (!k3) return null;
    const k4 = f(add(q, mul(k3, s)));
    if (!k4) return null;
    return add(q, [
      (s * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])) / 6,
      (s * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])) / 6,
      (s * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])) / 6,
    ]);
  };

  let accepted = 0;
  let budget = maxSteps * 8; // retries are bounded separately from progress

  while (accepted < maxSteps && budget-- > 0) {
    const full = rk4(p, h);
    if (!full) return { points, hitNull: true, escaped: false, stalled: false };
    const mid = rk4(p, h * 0.5);
    if (!mid) return { points, hitNull: true, escaped: false, stalled: false };
    const fine = rk4(mid, h * 0.5);
    if (!fine) return { points, hitNull: true, escaped: false, stalled: false };

    const err = Math.hypot(full[0] - fine[0], full[1] - fine[1], full[2] - fine[2]);

    if (err > tol && h > minStep) {
      // Shrink toward the RK4 error scaling (err ~ h^5) but never wildly.
      h = Math.max(minStep, h * Math.max(0.2, 0.9 * Math.pow(tol / err, 0.2)));
      continue;
    }

    p = fine; // the two-half-step result is the more accurate one
    points.push([...p]);
    accepted++;

    if (err < tol * 0.05) h = Math.min(maxStep, h * 1.7);

    if (Math.abs(p[0]) > bound || Math.abs(p[1]) > bound || Math.abs(p[2]) > bound) {
      return { points, hitNull: false, escaped: true, stalled: false };
    }
    if (stop && stop(p)) return { points, hitNull: false, escaped: false, stalled: false };
  }
  return { points, hitNull: false, escaped: false, stalled: budget <= 0 };
}

/**
 * Net force (newtons) on `target` from the field of all `others`.
 *
 * Gilbert model: F = INT sigma_m * B_ext dA over the target's charged faces,
 * with sigma_m = Br/mu0. In SI, [A/m][T][m^2] = N directly. Lengths here are
 * millimetres, hence the 1e-6 area conversion.
 *
 * Samples are nudged a hair INTO the target's own body. That matters only in
 * the degenerate case where two magnets sit exactly face to face: there the
 * external field is discontinuous precisely on the sample plane, and its value
 * on the plane is the average of the two sides. The force needs the limit
 * approached from the target's side, which is what the nudge picks out. Without
 * it, a stacked pair reports a repulsive force.
 */
export function forceOnMagnet(target, others, opts = {}) {
  const order = opts.order ?? 12;
  const extFaces = buildFaces(others);
  if (extFaces.length === 0) return [0, 0, 0];

  const { x: gx, w: gw } = gaussLegendre(order);
  const F = [0, 0, 0];
  const b = [0, 0, 0];
  const eps = opts.eps ?? 1e-4; // mm, into the target's own material

  for (const f of magnetFaces(target)) {
    // A sphere carries no rectangular/disc charge sheets in this model - its
    // field is closed form - so it contributes no surface-charge force term.
    if (f.kind === 'sphere') continue;
    const sigma_m = f.sigmaB / MU0;
    const ox = -f.outward[0] * eps;
    const oy = -f.outward[1] * eps;
    const oz = -f.outward[2] * eps;

    if (f.kind === 'rect') {
      for (let i = 0; i < order; i++) {
        const u = gx[i] * f.hx;
        const wu = gw[i] * f.hx;
        for (let j = 0; j < order; j++) {
          const v = gx[j] * f.hy;
          const w = wu * gw[j] * f.hy * 1e-6; // mm^2 -> m^2
          const p = [
            f.center[0] + u * f.ex[0] + v * f.ey[0] + ox,
            f.center[1] + u * f.ex[1] + v * f.ey[1] + oy,
            f.center[2] + u * f.ex[2] + v * f.ey[2] + oz,
          ];
          sampleFaces(extFaces, p, b);
          const k = sigma_m * w;
          F[0] += k * b[0]; F[1] += k * b[1]; F[2] += k * b[2];
        }
      }
    } else {
      const nt = order * 3;
      const dth = (2 * Math.PI) / nt;
      for (let i = 0; i < order; i++) {
        const r = (gx[i] + 1) * 0.5 * f.radius;
        const wr = gw[i] * 0.5 * f.radius * r * dth * 1e-6;
        for (let j = 0; j < nt; j++) {
          const th = (j + 0.5) * dth;
          const u = r * Math.cos(th);
          const v = r * Math.sin(th);
          const p = [
            f.center[0] + u * f.ex[0] + v * f.ey[0] + ox,
            f.center[1] + u * f.ex[1] + v * f.ey[1] + oy,
            f.center[2] + u * f.ex[2] + v * f.ey[2] + oz,
          ];
          sampleFaces(extFaces, p, b);
          const k = sigma_m * wr;
          F[0] += k * b[0]; F[1] += k * b[1]; F[2] += k * b[2];
        }
      }
    }
  }
  return F;
}

/**
 * Locate a field null by damped Newton on |B|^2 using numerical derivatives.
 * Returns null if it does not converge to something genuinely small.
 */
export function findNull(faces, seed, opts = {}) {
  const h = opts.h ?? 0.05;
  let p = [...seed];
  for (let it = 0; it < 200; it++) {
    const b = sampleFaces(faces, p, [0, 0, 0]);
    if (len(b) < (opts.tol ?? 1e-6)) return p;
    // Jacobian of B
    const J = [];
    for (let k = 0; k < 3; k++) {
      const pa = [...p]; pa[k] -= h;
      const pb = [...p]; pb[k] += h;
      const a = sampleFaces(faces, pa, [0, 0, 0]);
      const c = sampleFaces(faces, pb, [0, 0, 0]);
      J.push([(c[0] - a[0]) / (2 * h), (c[1] - a[1]) / (2 * h), (c[2] - a[2]) / (2 * h)]);
    }
    // Solve J^T dx = -b  (J[i][j] = dB_j/dx_i, so row i of J^T is dB_i/dx_j)
    const A = [
      [J[0][0], J[1][0], J[2][0], -b[0]],
      [J[0][1], J[1][1], J[2][1], -b[1]],
      [J[0][2], J[1][2], J[2][2], -b[2]],
    ];
    const dx = solve3(A);
    if (!dx) return null;
    const scale = Math.min(1, 2 / (Math.hypot(dx[0], dx[1], dx[2]) || 1));
    p = [p[0] + dx[0] * scale, p[1] + dx[1] * scale, p[2] + dx[2] * scale];
  }
  return len(sampleFaces(faces, p, [0, 0, 0])) < (opts.tol ?? 1e-6) ? p : null;
}

function solve3(A) {
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-14) return null;
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

export { len, norm, dot, cross, sub, add, mul };
