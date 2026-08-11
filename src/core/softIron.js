// Soft iron: bodies that have no magnetisation of their own until you put them
// in a field.
//
// Every magnet elsewhere in this project carries a PRESCRIBED magnetisation, so
// the field of several of them is a plain vector sum and nothing has to be
// solved. Iron breaks that. Its magnetisation is induced by the local field,
// and its own field is part of the local field - so the answer depends on
// itself and has to be found rather than evaluated.
//
// This is the mechanism behind a shaped tool: stick a steel star on a magnet and
// the star becomes the magnet, with a pole wherever it has a point. The pattern
// on the nail comes from the iron, not from the thing underneath it.
//
// Method. The body is diced into cubic cells, each replaced by a sphere of equal
// volume. A sphere is the one shape whose exterior field is EXACTLY a point
// dipole, so the cells reuse the existing sphere kernel and no new field maths
// is introduced. Each cell then carries
//
//   j_i = chi * b_i          with j = mu0 M and b = mu0 H, both in tesla
//
// where b_i is everything the cell feels: the applied field, the other cells,
// and its own demagnetising field.
//
// The self term is what makes this tractable. Inside a uniformly magnetised
// sphere the field is exactly -j/3, so it can be taken analytically instead of
// numerically:
//
//   j_i = chi (b_applied + SUM_{k != i} b_ik - j_i / 3)
//   j_i (1 + chi/3) = chi (b_applied + SUM_{k != i} b_ik)
//
// which is the iteration below. Note what a single cell reduces to:
//
//   j = 3 chi / (3 + chi) * b0
//
// and that is precisely the textbook answer for a sphere of susceptibility chi
// in a uniform field. The one-cell case is exact, not approximate, which is the
// anchor the tests are built on.
//
// Saturation is not a refinement here, it is the main event. Iron saturates
// around 2.15 T and anything touching a neodymium magnet is far past that, so
// the linear answer is wrong exactly where the interesting patterns are. |j| is
// clamped to Bs, which makes the system nonlinear.
//
// Why this is solved directly rather than iterated. The obvious approach is to
// sweep the cells repeatedly until they stop changing, and it does work while
// the cells are far apart. It stops working as soon as they are not: the gain
// is nearly 3 for iron, each neighbour couples back at order 0.16, and once
// enough neighbours are close the iteration matrix has an eigenvalue above 1.
// Measured, a radius-4 sphere at 2 mm cells settles, and the same sphere at
// 1.3 mm runs away to 39.7 T per cell. Under-relaxation cannot rescue that -
// damped Jacobi steps to 1 + w(lambda - 1), which exceeds 1 for ANY positive w
// when lambda does. So the coupling is assembled as a matrix and solved.
//
// Saturation is then handled as an active set: solve, clamp whatever came out
// past Bs, move those cells to the right-hand side as known sources, and solve
// again for the rest until the set of saturated cells stops changing.

import { sampleFaces } from './field.js';
import { insideMagnet, magnetExtents } from './magnet.js';
import { quatRotate } from './vec.js';

/** Soft iron, near enough. mu_r ~ 1000 and Bs = 2.15 T for a mild steel. */
export const SOFT_IRON = { chi: 999, Bs: 2.15 };

/** A cubic cell of side a, as a sphere of the same volume. */
const EQUIV_RADIUS = (3 / (4 * Math.PI)) ** (1 / 3); // x cell side, ~0.6204

/**
 * Dice a body into cells on a regular lattice.
 *
 * The body is described the same way a magnet is - type, size, position,
 * quaternion - so every shape the project already knows how to draw can be made
 * out of iron, and `insideMagnet` does the containment test.
 */
export function voxelize(body, cellSize) {
  const half = magnetExtents(body);
  const cells = [];
  const a = cellSize;
  // Walk the body's own bounding box in its LOCAL frame, then rotate out. A
  // world-axis-aligned walk would need a box big enough to hold every rotation
  // of the body, which for a long thin bar is mostly empty space.
  const n = half.map((h) => Math.max(1, Math.ceil((2 * h) / a)));
  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let k = 0; k < n[2]; k++) {
        const local = [
          -half[0] + (i + 0.5) * (2 * half[0]) / n[0],
          -half[1] + (j + 0.5) * (2 * half[1]) / n[1],
          -half[2] + (k + 0.5) * (2 * half[2]) / n[2],
        ];
        const w = quatRotate(body.quaternion, local);
        const p = [
          w[0] + body.position[0], w[1] + body.position[1], w[2] + body.position[2],
        ];
        if (!insideMagnet(body, p)) continue;
        cells.push(p);
      }
    }
  }
  // Cell volume is the lattice spacing actually used, which may differ per axis
  // when the body does not divide evenly.
  const vol = ((2 * half[0]) / n[0]) * ((2 * half[1]) / n[1]) * ((2 * half[2]) / n[2]);
  const radius = EQUIV_RADIUS * Math.cbrt(vol);
  return { centers: cells, volume: vol, radius, counts: n };
}

/**
 * The 3x3 tensor taking cell k's magnetisation to the field it puts at point p.
 * Straight from the sphere kernel: B = (R^3 / 3 r^3) (3 rhat rhat^T - I) j.
 */
function dipoleTensor(p, c, radius, out) {
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  const dz = p[2] - c[2];
  const r2 = dx * dx + dy * dy + dz * dz;
  const r = Math.sqrt(r2);
  const k = (radius * radius * radius) / (3 * r2 * r);
  const ux = dx / r; const uy = dy / r; const uz = dz / r;
  out[0] = k * (3 * ux * ux - 1); out[1] = k * (3 * ux * uy); out[2] = k * (3 * ux * uz);
  out[3] = k * (3 * uy * ux); out[4] = k * (3 * uy * uy - 1); out[5] = k * (3 * uy * uz);
  out[6] = k * (3 * uz * ux); out[7] = k * (3 * uz * uy); out[8] = k * (3 * uz * uz - 1);
  return out;
}

/** Dense Gaussian elimination with partial pivoting. A is n x n, row-major. */
function solveDense(A, b, n) {
  const x = new Float64Array(b);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) continue; // singular column; leave it be
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = t;
      }
      const t = x[col]; x[col] = x[piv]; x[piv] = t;
    }
    const d = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      x[r] -= f * x[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
    const d = A[r * n + r];
    x[r] = Math.abs(d) < 1e-14 ? 0 : s / d;
  }
  return x;
}

/** The sphere face a cell presents to the rest of the world. */
function cellFace(center, radius, j) {
  const mag = Math.hypot(j[0], j[1], j[2]);
  if (mag < 1e-12) return null;
  return {
    kind: 'sphere',
    center,
    radius,
    Br: mag,
    axis: [j[0] / mag, j[1] / mag, j[2] / mag],
  };
}

/**
 * Solve the induced magnetisation of one or more iron bodies standing in the
 * field of `sourceFaces`.
 *
 * Returns faces that can be concatenated onto any other face list and sampled
 * by the ordinary field path - the rest of the project never learns that
 * anything unusual happened.
 */
export function solveSoftIron(bodies, sourceFaces, opts = {}) {
  const {
    cellSize = 1.5,
    chi = SOFT_IRON.chi,
    Bs = SOFT_IRON.Bs,
  } = opts;

  const list = Array.isArray(bodies) ? bodies : [bodies];
  const centers = [];
  // Per cell, not per solve: two bodies of different sizes do not divide into
  // the same lattice even at one requested pitch, so a single radius would be
  // wrong for every body but the last.
  const radii = [];
  const volumes = [];
  for (const b of list) {
    const v = voxelize(b, cellSize);
    for (const c of v.centers) {
      centers.push(c);
      radii.push(v.radius);
      volumes.push(v.volume);
    }
  }
  const radius = radii.length ? radii[0] : 0;
  const volume = volumes.length ? volumes[0] : 0;
  const n = centers.length;
  if (!n) return { faces: [], cells: 0, passes: 0, saturated: 0, magnetisation: [], centers: [], volume: 0, radius: 0 };

  // The applied field never changes, so it is sampled once.
  const applied = centers.map((c) => sampleFaces(sourceFaces, c));

  const gain = chi / (1 + chi / 3);
  const N = 3 * n;

  // Coupling, assembled once: T[i][k] is the tensor from cell k to cell i.
  // This is the O(N^2) memory the method costs, and what caps how finely a
  // body can be diced before it stops being interactive.
  const T = new Float64Array(N * N);
  const t9 = new Float64Array(9);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (k === i) continue; // self term is analytic, and lives in `gain`
      dipoleTensor(centers[i], centers[k], radii[k], t9);
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) T[(3 * i + a) * N + 3 * k + b] = t9[3 * a + b];
      }
    }
  }

  const j = new Float64Array(N);
  const clamped = new Array(n).fill(false);
  const dir = centers.map(() => [0, 0, 1]);
  let passes = 0;

  // Active set: solve, clamp whatever saturated, solve again for the rest.
  for (let pass = 0; pass < 8; pass++) {
    passes = pass + 1;

    const A = new Float64Array(N * N);
    const rhs = new Float64Array(N);

    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        const row = 3 * i + a;
        if (clamped[i]) {
          // This cell is pinned at Bs along the direction it wanted to take.
          A[row * N + row] = 1;
          rhs[row] = Bs * dir[i][a];
          continue;
        }
        A[row * N + row] = 1;
        rhs[row] = gain * applied[i][a];
        for (let k = 0; k < n; k++) {
          if (k === i) continue;
          for (let b = 0; b < 3; b++) {
            const col = 3 * k + b;
            const coupling = gain * T[row * N + col];
            if (clamped[k]) rhs[row] += coupling * Bs * dir[k][b];
            else A[row * N + col] -= coupling;
          }
        }
      }
    }

    const sol = solveDense(A, rhs, N);
    for (let i = 0; i < N; i++) j[i] = sol[i];

    let changed = false;
    for (let i = 0; i < n; i++) {
      const mag = Math.hypot(j[3 * i], j[3 * i + 1], j[3 * i + 2]);
      if (mag > Bs * (1 + 1e-9) && !clamped[i]) {
        clamped[i] = true;
        dir[i] = [j[3 * i] / mag, j[3 * i + 1] / mag, j[3 * i + 2] / mag];
        changed = true;
      }
    }
    if (!changed) break;
  }

  const magnetisation = [];
  const faces = [];
  let saturated = 0;
  for (let i = 0; i < n; i++) {
    const v = [j[3 * i], j[3 * i + 1], j[3 * i + 2]];
    magnetisation.push(v);
    if (Math.hypot(v[0], v[1], v[2]) > Bs * 0.999) saturated++;
    const f = cellFace(centers[i], radii[i], v);
    if (f) faces.push(f);
  }

  return {
    faces, cells: n, passes, saturated,
    volume, radius, volumes, radii, magnetisation, centers,
  };
}

/**
 * Total induced moment, expressed the same way a cell is: tesla of mu0*M times
 * volume. Useful for comparing a diced body against a closed-form answer
 * without caring how it was diced.
 */
export function totalMoment(solution) {
  const t = [0, 0, 0];
  // Weighted per cell, because cells from different bodies need not be the
  // same size even when one pitch was asked for.
  solution.magnetisation.forEach((j, i) => {
    const v = solution.volumes?.[i] ?? solution.volume;
    t[0] += j[0] * v; t[1] += j[1] * v; t[2] += j[2] * v;
  });
  return t;
}

/**
 * Closed form for a sphere of susceptibility chi in a uniform applied field:
 * j = 3 chi / (3 + chi) * b0, uniform throughout. The reference the diced
 * solver is gated against.
 */
export function sphereMagnetisationExact(chi, b0) {
  const k = (3 * chi) / (3 + chi);
  return [k * b0[0], k * b0[1], k * b0[2]];
}
