// Brute-force numerical reference integrators.
//
// These are the ground truth the analytic rectangle formula is validated
// against. They are deliberately dumb: tiled Gauss-Legendre over the face, with
// enough tiles that even a field point sitting a hair off the surface is
// resolved. Slow, but never wrong.
//
// Also the home of the shared Gauss-Legendre nodes, which the runtime
// integrators (disc.js, magnet-on-magnet force) use as well.

/** Gauss-Legendre nodes/weights on [-1,1], computed via Newton on P_n. */
const glCache = new Map();
export function gaussLegendre(n) {
  const hit = glCache.get(n);
  if (hit) return hit;

  const x = new Float64Array(n);
  const w = new Float64Array(n);
  const m = (n + 1) >> 1;

  for (let i = 0; i < m; i++) {
    // Chebyshev-ish initial guess, then Newton to machine precision.
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let pp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1;
      let p1 = 0;
      for (let j = 0; j < n; j++) {
        const p2 = p1;
        p1 = p0;
        p0 = ((2 * j + 1) * z * p1 - j * p2) / (j + 1);
      }
      pp = (n * (z * p0 - p1)) / (z * z - 1);
      const dz = p0 / pp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = -z;
    x[n - 1 - i] = z;
    w[i] = 2 / ((1 - z * z) * pp * pp);
    w[n - 1 - i] = w[i];
  }

  const out = { x, w };
  glCache.set(n, out);
  return out;
}

/**
 * Reference field of a uniformly charged rectangle by direct quadrature.
 *
 * The integrand is a near-singular 1/r^2 spike whose width is the distance
 * from the field point to the sheet, so a uniform tiling is hopeless once you
 * get close: at z = 1 micron off a 20 mm face you would need ~10^8 tiles.
 * Instead we refine adaptively - a panel is split into four whenever it is
 * still large compared with its own distance to the field point. That
 * concentrates work in a small graded patch under the field point and gives a
 * reference good to many digits at any standoff.
 *
 * @param {number} sigmaB
 * @param {number} x1,x2,y1,y2
 * @param {number} px,py,pz
 * @param {object} [opts] {order, ratio, maxDepth}
 */
export function rectFieldQuadrature(
  sigmaB, x1, x2, y1, y2, px, py, pz, opts = {},
) {
  const order = opts.order ?? 10;
  // A panel is accepted once its longest side is below `ratio` x its distance
  // to the field point. 0.35 with a 10-point rule is comfortably converged.
  const ratio = opts.ratio ?? 0.35;
  const maxDepth = opts.maxDepth ?? 26;
  const { x: gx, w: gw } = gaussLegendre(order);

  let bx = 0;
  let by = 0;
  let bz = 0;

  const panel = (ax, bx2, ay, by2, depth) => {
    const w = bx2 - ax;
    const h = by2 - ay;

    // Distance from the field point to this panel (clamp into the rectangle).
    const cx = Math.min(Math.max(px, ax), bx2);
    const cy = Math.min(Math.max(py, ay), by2);
    const d = Math.hypot(px - cx, py - cy, pz);

    if (depth < maxDepth && Math.max(w, h) > ratio * d) {
      const mx = (ax + bx2) * 0.5;
      const my = (ay + by2) * 0.5;
      panel(ax, mx, ay, my, depth + 1);
      panel(mx, bx2, ay, my, depth + 1);
      panel(ax, mx, my, by2, depth + 1);
      panel(mx, bx2, my, by2, depth + 1);
      return;
    }

    const hw = w * 0.5;
    const hh = h * 0.5;
    const mx = ax + hw;
    const my = ay + hh;

    for (let a = 0; a < order; a++) {
      const rx = px - (mx + gx[a] * hw);
      const wa = gw[a] * hw;
      for (let b = 0; b < order; b++) {
        const ry = py - (my + gx[b] * hh);
        const wt = wa * gw[b] * hh;
        const r2 = rx * rx + ry * ry + pz * pz;
        const inv = wt / (r2 * Math.sqrt(r2));
        bx += rx * inv;
        by += ry * inv;
        bz += pz * inv;
      }
    }
  };

  panel(x1, x2, y1, y2, 0);

  const k = sigmaB / (4 * Math.PI);
  return [k * bx, k * by, k * bz];
}

/**
 * REFERENCE field of a uniformly charged disc, by brute-force 2D quadrature.
 *
 * This is not the runtime path - see disc.js, which does the theta integral
 * analytically and is ~100x faster. This version exists to validate that one.
 *
 * @param {number} sigmaB
 * @param {number} radius
 * @param {number} px,py,pz  field point in the disc frame
 * @param {number[]} [out]
 * @param {object} [opts] {nr, nt} to force a fixed rule (used by tests)
 */
export function discFieldQuadrature(sigmaB, radius, px, py, pz, out, opts) {
  const o = out || [0, 0, 0];

  let bx = 0;
  let by = 0;
  let bz = 0;

  const rho = Math.hypot(px, py);
  const gap = Math.hypot(rho - Math.min(rho, radius), pz);

  if ((opts && opts.nr) || gap > 2 * radius) {
    // Fixed product rule. Far from the disc the integrand is smooth and a
    // small rule is exact to many digits; this is also the path tests use to
    // build an oversampled reference.
    const nr = opts?.nr ?? 10;
    const nt = opts?.nt ?? 24;
    const { x: gx, w: gw } = gaussLegendre(nr);
    const dth = (2 * Math.PI) / nt;

    for (let i = 0; i < nr; i++) {
      const r = (gx[i] + 1) * 0.5 * radius;
      const wr = gw[i] * 0.5 * radius * r * dth; // includes the r dA Jacobian
      // Accumulate the angular sum locally: for a point near the axis the
      // individual in-plane terms are large and cancel, so summing them into
      // the running total directly would lose precision.
      let ax = 0, ay = 0, az = 0;
      for (let j = 0; j < nt; j++) {
        const th = (j + 0.5) * dth;
        const dx = px - r * Math.cos(th);
        const dy = py - r * Math.sin(th);
        const r2 = dx * dx + dy * dy + pz * pz;
        const inv = 1 / (r2 * Math.sqrt(r2));
        ax += dx * inv; ay += dy * inv; az += pz * inv;
      }
      bx += wr * ax; by += wr * ay; bz += wr * az;
    }
  } else {
    // Adaptive sectors, exactly the scheme used for the rectangle but in
    // (r, theta): split a sector whenever it is still large compared with its
    // own distance to the field point. Without this the rule collapses right
    // against the face, where the 1/r^2 spike is narrower than any affordable
    // uniform grid.
    const order = opts?.order ?? 6;
    const ratio = opts?.ratio ?? 0.4;
    const maxDepth = opts?.maxDepth ?? 20;
    const { x: gx, w: gw } = gaussLegendre(order);

    let thp = Math.atan2(py, px);
    if (thp < 0) thp += 2 * Math.PI;

    const sector = (r0, r1, t0, t1, depth) => {
      // Nearest point of the sector, by clamping in polar coordinates.
      const rc = Math.min(Math.max(rho, r0), r1);
      const tc = Math.min(Math.max(thp, t0), t1);
      const d = Math.hypot(px - rc * Math.cos(tc), py - rc * Math.sin(tc), pz);
      const size = Math.max(r1 - r0, r1 * (t1 - t0));

      // depth < 2 forces the first two splits: a full-circle sector is too
      // coarse for the product rule no matter how far away the point is.
      if (depth < maxDepth && (depth < 2 || size > ratio * d)) {
        const rm = (r0 + r1) * 0.5;
        const tm = (t0 + t1) * 0.5;
        sector(r0, rm, t0, tm, depth + 1);
        sector(rm, r1, t0, tm, depth + 1);
        sector(r0, rm, tm, t1, depth + 1);
        sector(rm, r1, tm, t1, depth + 1);
        return;
      }

      const hr = (r1 - r0) * 0.5;
      const mr = r0 + hr;
      const ht = (t1 - t0) * 0.5;
      const mt = t0 + ht;

      for (let i = 0; i < order; i++) {
        const r = mr + gx[i] * hr;
        const wr = gw[i] * hr * r;
        for (let j = 0; j < order; j++) {
          const th = mt + gx[j] * ht;
          const w = wr * gw[j] * ht;
          const dx = px - r * Math.cos(th);
          const dy = py - r * Math.sin(th);
          const r2 = dx * dx + dy * dy + pz * pz;
          const inv = w / (r2 * Math.sqrt(r2));
          bx += dx * inv; by += dy * inv; bz += pz * inv;
        }
      }
    };

    sector(0, radius, 0, 2 * Math.PI, 0);
  }

  const k = sigmaB / (4 * Math.PI);
  o[0] += k * bx;
  o[1] += k * by;
  o[2] += k * bz;
  return o;
}
