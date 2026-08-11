// Field of a uniformly charged DISC (the pole face of an axially magnetised
// cylinder magnet).
//
// There is no elementary closed form for the disc off-axis - the exact answer
// needs complete elliptic integrals of the third kind. But we do not have to
// integrate in two dimensions to get it. A disc is a stack of concentric
// charged RINGS, and the field of a ring can be written exactly with complete
// elliptic integrals of the first and second kind only. That collapses the
// surface integral to a single radial quadrature.
//
// DERIVATION (ring at radius r in the z = 0 plane, field point at (rho, z))
//
//   |p - r'|^2 = A - B cos(theta),   A = rho^2 + r^2 + z^2,  B = 2 rho r
//
// Writing a+ = (rho+r)^2 + z^2 and a- = (rho-r)^2 + z^2, and m = 4 rho r / a+,
// the two integrals we need are the standard ones
//
//   I0 = INT dtheta / |p-r'|      = 4 K(m) / sqrt(a+)
//   I1 = INT dtheta / |p-r'|^3    = 4 E(m) / (sqrt(a+) a-)
//
// and the ring's contribution to INT (p - r')/|p-r'|^3 dtheta is
//
//   axial:  z * I1
//   radial: [ I1 (rho^2 - r^2 - z^2) + I0 ] / (2 rho)
//
// The y-component vanishes by symmetry. The disc is then
//
//   B = (sigmaB/4pi) INT_0^a ring(r) r dr
//
// which is one dimensional and needs only a handful of nodes at normal
// standoffs. Compared with brute-force 2D adaptive quadrature this is ~100x
// faster and, being exact in theta, more accurate.
//
// The radial integrand is peaked at r = rho when |z| is small (the ring
// passing through the field point), so the r-quadrature is still adaptive.

import { gaussLegendre } from './quadrature.js';

/**
 * Complete elliptic integrals K(m) and E(m), parameter convention m = k^2,
 * via the arithmetic-geometric mean. Converges quadratically.
 */
export function ellipKE(m) {
  if (m < 0) m = 0;
  // K diverges logarithmically at m = 1 (the ring passing through the field
  // point). Clamp just short of it so callers get a large finite value.
  if (m > 1 - 1e-15) m = 1 - 1e-15;

  let a = 1;
  let b = Math.sqrt(1 - m);
  let sum = m; // accumulates 2^n * c_n^2, starting with c_0^2 = m
  let pow = 1;

  for (let i = 0; i < 60; i++) {
    const c = (a - b) * 0.5;
    const an = (a + b) * 0.5;
    b = Math.sqrt(a * b);
    a = an;
    pow *= 2;
    sum += pow * c * c;
    if (Math.abs(c) < 1e-16 * a) break;
  }

  const K = Math.PI / (2 * a);
  const E = K * (1 - sum * 0.5);
  return { K, E };
}

/**
 * INT over theta of (p - r')/|p - r'|^3 for a unit-density ring of radius r.
 * Returns [radial, axial]; the azimuthal component is zero by symmetry.
 */
export function ringIntegral(rho, z, r) {
  const dp = rho + r;
  const dm = rho - r;
  const ap = dp * dp + z * z;
  const am = dm * dm + z * z;

  if (ap <= 0) return [0, 0];

  const m = (4 * rho * r) / ap;
  const { K, E } = ellipKE(m);
  const sap = Math.sqrt(ap);

  // a- -> 0 exactly on the ring; the field genuinely diverges there.
  const amSafe = am > 0 ? am : 1e-300;
  const I1 = (4 * E) / (sap * amSafe);
  const I0 = (4 * K) / sap;

  const axial = z * I1;

  // On the axis the radial component is zero by symmetry; the general formula
  // is a difference of two O(rho) terms there and loses precision.
  const radial = rho > 1e-9 * Math.max(1, r)
    ? (I1 * (rho * rho - r * r - z * z) + I0) / (2 * rho)
    : 0;

  return [radial, axial];
}

/**
 * B field of a uniformly charged disc, in the disc's own frame (disc in the
 * z = 0 plane, centred on the origin).
 *
 * @param {number} sigmaB  mu0 * sigma_m, in tesla
 * @param {number} radius
 * @param {number} px,py,pz  field point in the disc frame
 * @param {number[]} [out]
 * @param {object} [opts] {order, ratio, maxDepth}
 */
export function discFieldLocal(sigmaB, radius, px, py, pz, out, opts = {}) {
  const o = out || [0, 0, 0];
  const order = opts.order ?? 8;
  const ratio = opts.ratio ?? 0.5;
  const maxDepth = opts.maxDepth ?? 24;
  const { x: gx, w: gw } = gaussLegendre(order);

  const rho = Math.hypot(px, py);
  const z = pz;

  let sr = 0; // radial
  let sz = 0; // axial

  // Adaptive panels in r: refine where the ring approaches the field point.
  const panel = (r0, r1, depth) => {
    const width = r1 - r0;
    // Distance from the field point to the nearest ring in this panel.
    const dr = Math.max(0, Math.max(r0 - rho, rho - r1));
    const d = Math.hypot(dr, z);

    if (depth < maxDepth && width > ratio * d) {
      const rm = (r0 + r1) * 0.5;
      panel(r0, rm, depth + 1);
      panel(rm, r1, depth + 1);
      return;
    }

    const h = width * 0.5;
    const mid = r0 + h;
    for (let i = 0; i < order; i++) {
      const r = mid + gx[i] * h;
      const w = gw[i] * h * r; // r dr
      const [rad, ax] = ringIntegral(rho, z, r);
      sr += w * rad;
      sz += w * ax;
    }
  };

  panel(0, radius, 0);

  const k = sigmaB / (4 * Math.PI);
  const br = k * sr;
  o[2] += k * sz;
  if (rho > 1e-12) {
    o[0] += (br * px) / rho;
    o[1] += (br * py) / rho;
  }
  return o;
}

/** Disc face placed arbitrarily in world space. */
export function discFieldWorld(face, p, out) {
  const o = out || [0, 0, 0];
  const { center, ex, ey, ez } = face;

  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  const dz = p[2] - center[2];

  const lx = dx * ex[0] + dy * ex[1] + dz * ex[2];
  const ly = dx * ey[0] + dy * ey[1] + dz * ey[2];
  const lz = dx * ez[0] + dy * ez[1] + dz * ez[2];

  const b = discFieldLocal(face.sigmaB, face.radius, lx, ly, lz, [0, 0, 0]);

  o[0] += b[0] * ex[0] + b[1] * ey[0] + b[2] * ez[0];
  o[1] += b[0] * ex[1] + b[1] * ey[1] + b[2] * ez[1];
  o[2] += b[0] * ex[2] + b[1] * ey[2] + b[2] * ez[2];
  return o;
}
