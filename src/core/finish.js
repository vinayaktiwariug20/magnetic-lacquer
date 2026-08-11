// The finish model: from B at each texel to what the flake pile looks like.
//
// This is a shading model, not a dynamics simulation. There are no particles
// and no fluid - we assume the pile has already reached its steady state and
// read the geometry straight off the field.
//
//   chain direction  unit B. Flakes are needle/plate shaped and chain along
//                    the field, in 3D.
//   tilt             angle between the chain and the surface normal. ~0 means
//                    the pile stands up (you look down the ends of the fibres
//                    and see the base coat). ~90 means it lies flat and mirrors.
//   concentration    where the particles bunch up. Two drivers are offered,
//                    because they answer different questions:
//
//                      'fieldMagnitude'  a monotonic function of |B|. Particles
//                        drift up-gradient and come to REST at maxima of |B|,
//                        so for a settled steady state this says where they end
//                        up. Cheap: reuses the field we already sampled.
//                      'gradient'  |grad(B^2)|, which is the actual local FORCE
//                        on a particle: F = grad(m.B), and for an induced
//                        moment m ∝ B that is (chi V / 2 mu0) grad(B^2). This
//                        says where the pull is strongest rather than where
//                        particles settle, so it highlights the edges of field
//                        features rather than their peaks. Costs 6 extra field
//                        samples per texel.
//
//                    Neither is derived from a transport calculation - there is
//                    no time in this model - so the exponent is a slider and
//                    both drivers are there to be tuned against real photos.
//   alignment order  saturates with |B|; below a threshold the flakes are
//                    still randomly oriented and there is no sheen at all.
//
// TIME. All of the above is the steady state - the pile given all the time in
// the world. Pass `director`, `order` or `conc` overrides (see the params
// below) and this function instead reports the geometry of a pile that is
// still in motion, as computed by dynamics.js. Everything downstream - tilt,
// signed lean, fan gradient, pile parallelism - is measured off the supplied
// directors, so the same readouts describe a drying coat as describe a settled
// one, and the static model is recovered exactly as the long-time limit.

import { sampleFaces } from './field.js';
import { len, len2, norm, dot, cross } from './vec.js';

export const DEFAULT_FINISH = {
  concDriver: 'fieldMagnitude', // or 'gradient' - see the header
  concExp: 2.2,        // exponent on the normalised driver; tune against photos
  concStrength: 0.85,  // how hard concentration modulates albedo
  orderThreshold: 0.012, // T; below this the pile stays random
  orderSat: 0.055,     // T; scale over which order saturates
};

/**
 * Evaluate the finish over a nail grid.
 *
 * @param {object} grid   from buildNailGrid
 * @param {object[]} faces from buildFaces
 * @param {object} params  see DEFAULT_FINISH, plus the optional overrides
 *   params.director  Float32Array(3n) measured pile direction per texel
 *   params.order     Float32Array(n)  measured nematic order parameter
 *   params.conc      Float32Array(n)  transported concentration, 1 = as applied
 */
/**
 * Sample B over every texel of a grid. Split out from computeFinish because
 * the time-resolved path needs the field BEFORE it can work out what the pile
 * looks like, and sampling it twice per frame is the single most expensive
 * thing this program could do.
 */
export function sampleGrid(grid, faces) {
  const n = grid.count;
  const B = new Float32Array(n * 3);
  const bmag = new Float32Array(n);
  const b = [0, 0, 0];
  const p = [0, 0, 0];
  let bmin = Infinity;
  let bmax = -Infinity;

  for (let i = 0; i < n; i++) {
    p[0] = grid.position[i * 3];
    p[1] = grid.position[i * 3 + 1];
    p[2] = grid.position[i * 3 + 2];

    sampleFaces(faces, p, b);
    B[i * 3] = b[0]; B[i * 3 + 1] = b[1]; B[i * 3 + 2] = b[2];
    bmag[i] = len(b);

    // Track the range from the STORED float32 value, not the double. Rounding
    // to float32 can nudge a texel above a max recorded in double precision,
    // which then makes the readouts mutually inconsistent.
    const mf = bmag[i];
    if (mf < bmin) bmin = mf;
    if (mf > bmax) bmax = mf;
  }
  return { B, bmag, bmin, bmax };
}

export function computeFinish(grid, faces, params = {}) {
  const P = { ...DEFAULT_FINISH, ...params };
  const n = grid.count;

  const field = P.field ?? sampleGrid(grid, faces);
  const { B, bmag, bmin, bmax } = field;
  const chain = new Float32Array(n * 3);
  const tilt = new Float32Array(n);       // degrees from the normal, 0..90
  const signedTilt = new Float32Array(n); // + = leaning away from the medial line
  const conc = new Float32Array(n);
  const order = new Float32Array(n);

  // Optional: drive concentration from the force on a particle, |grad(B^2)|,
  // rather than from |B| itself. Six extra samples per texel, hence opt-in.
  let drive = bmag;
  let dmin = bmin;
  let dmax = bmax;
  if (P.concDriver === 'gradient') {
    drive = new Float32Array(n);
    dmin = Infinity;
    dmax = -Infinity;
    const h = P.gradStep ?? 0.15; // mm
    const a = [0, 0, 0];
    const c = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const q = [grid.position[i * 3], grid.position[i * 3 + 1], grid.position[i * 3 + 2]];
      let gx = 0; let gy = 0; let gz = 0;
      for (let k = 0; k < 3; k++) {
        const pa = [...q]; pa[k] -= h;
        const pb = [...q]; pb[k] += h;
        // central difference of B^2, which is what the force is proportional to
        const b2a = len2(sampleFaces(faces, pa, a));
        const b2b = len2(sampleFaces(faces, pb, c));
        const d = (b2b - b2a) / (2 * h);
        if (k === 0) gx = d; else if (k === 1) gy = d; else gz = d;
      }
      drive[i] = Math.hypot(gx, gy, gz);
      const v = drive[i];
      if (v < dmin) dmin = v;
      if (v > dmax) dmax = v;
    }
  }

  const span = dmax - dmin;
  let sumTilt = 0;
  let sumTilt2 = 0;

  // Surface width of each row, computed once. This used to be measured per
  // TEXEL, which made the loop below quadratic in the across-nail resolution -
  // 400k distance evaluations at the default grid, and the single most
  // expensive thing in the finish model.
  const rowWidth = new Float64Array(grid.nu);
  for (let iu = 0; iu < grid.nu; iu++) rowWidth[iu] = arcWidthAt(grid, iu);

  // For the fan gradient: least-squares fit of signed tilt against lateral
  // distance from the medial line.
  let sx = 0, sy = 0, sxx = 0, sxy = 0, sn = 0;

  const nrm = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const m = bmag[i];

    // Renormalise: the grid stores normals as float32, so they are only unit
    // to ~1e-7 and acos() turns that into a visible fraction of a degree of
    // spurious tilt on every texel.
    const nl = Math.hypot(
      grid.normal[i * 3], grid.normal[i * 3 + 1], grid.normal[i * 3 + 2],
    ) || 1;
    nrm[0] = grid.normal[i * 3] / nl;
    nrm[1] = grid.normal[i * 3 + 1] / nl;
    nrm[2] = grid.normal[i * 3 + 2] / nl;

    // Chain direction, oriented into the outward hemisphere. Flakes are
    // nematic - the sign carries no extra information here.
    const hasField = m > 1e-12;
    let c;
    if (P.director) {
      // Measured from a live flake ensemble rather than assumed to be along B.
      const dl = Math.hypot(
        P.director[i * 3], P.director[i * 3 + 1], P.director[i * 3 + 2],
      );
      c = dl > 1e-9
        ? [P.director[i * 3] / dl, P.director[i * 3 + 1] / dl, P.director[i * 3 + 2] / dl]
        : [nrm[0], nrm[1], nrm[2]];
      if (dot(c, nrm) < 0) c = [-c[0], -c[1], -c[2]];
    } else if (hasField) {
      c = [B[i * 3] / m, B[i * 3 + 1] / m, B[i * 3 + 2] / m];
      if (dot(c, nrm) < 0) c = [-c[0], -c[1], -c[2]];
    } else {
      // No field: the pile stands along the normal by convention.
      c = [nrm[0], nrm[1], nrm[2]];
    }
    chain[i * 3] = c[0]; chain[i * 3 + 1] = c[1]; chain[i * 3 + 2] = c[2];

    const cosT = Math.min(1, Math.max(-1, dot(c, nrm)));
    const tDeg = (hasField || P.director) ? (Math.acos(cosT) * 180) / Math.PI : 0;
    tilt[i] = tDeg;
    sumTilt += tDeg;
    sumTilt2 += tDeg * tDeg;

    // Concentration: monotonic in the chosen driver, normalised over this nail.
    // With a transported field supplied it is a real pigment density instead,
    // where 1 means "as applied"; the exponent still shapes how hard it reads.
    if (P.conc) {
      conc[i] = Math.pow(Math.min(1, Math.max(0, P.conc[i] * 0.5)), P.concExp);
    } else {
      const bn = span > 1e-12 ? (drive[i] - dmin) / span : 0.5;
      conc[i] = Math.pow(bn, P.concExp);
    }

    // Alignment order. Measured from the flake ensemble when one is running;
    // otherwise the static stand-in - nothing below threshold, then saturating.
    order[i] = P.order
      ? Math.min(1, Math.max(0, P.order[i]))
      : m <= P.orderThreshold
        ? 0
        : 1 - Math.exp(-(m - P.orderThreshold) / Math.max(1e-9, P.orderSat));

    // Signed lean, measured in the plane spanned by the normal and the
    // outward lateral direction. This is what makes the pile behave like a
    // curved mirror array rather than a flat one.
    const iu = Math.floor(i / grid.nv);
    const iv = i % grid.nv;
    const vCentred = iv / (grid.nv - 1) - 0.5;

    // Lateral tangent: across the nail, pointing AWAY from the medial line.
    // Order matters - cross(normal, along) points the other way, which silently
    // inverts every convex/concave verdict downstream.
    const along = medialTangent(grid, iu, iv);
    let lat = cross(along, nrm);
    const ll = len(lat);
    if (ll > 1e-9) {
      lat = [lat[0] / ll, lat[1] / ll, lat[2] / ll];
      if (vCentred < 0) lat = [-lat[0], -lat[1], -lat[2]];
      const st = Math.atan2(dot(c, lat), Math.max(1e-9, cosT)) * 180 / Math.PI;
      signedTilt[i] = st;

      // Lateral distance from the medial line, in mm along the surface.
      const d = Math.abs(vCentred) * rowWidth[iu];
      sx += d; sy += st; sxx += d * d; sxy += d * st; sn++;
    }
  }

  const mean = (bmin + bmax) * 0.5;
  let bsum = 0;
  for (let i = 0; i < n; i++) bsum += bmag[i];
  const bmean = bsum / n;

  const meanTilt = sumTilt / n;
  const tiltSpread = Math.sqrt(Math.max(0, sumTilt2 / n - meanTilt * meanTilt));

  // Fan gradient in deg/mm, and the equivalent mirror focal length.
  const denom = sn * sxx - sx * sx;
  const fanGradient = Math.abs(denom) > 1e-12 ? (sn * sxy - sx * sy) / denom : 0;
  const radPerMm = (fanGradient * Math.PI) / 180;
  const focalLength = Math.abs(radPerMm) > 1e-9 ? 1 / (2 * radPerMm) : Infinity;

  // Centre texel.
  const ci = Math.floor(grid.nu / 2) * grid.nv + Math.floor(grid.nv / 2);

  // How parallel the pile is: the mean angle between each flake and the one at
  // the centre. This is the measure that separates VELVET from a cat eye. A cat
  // eye is defined by the pile CHANGING direction across the nail (that is what
  // makes the line); velvet is defined by it NOT changing - one uniform nap over
  // the whole nail, so the sheen blooms evenly instead of pinching into a line.
  // Small is velvet-like, large is patterned.
  const c0 = [chain[ci * 3], chain[ci * 3 + 1], chain[ci * 3 + 2]];
  let angSum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(
      chain[i * 3] * c0[0] + chain[i * 3 + 1] * c0[1] + chain[i * 3 + 2] * c0[2],
    );
    angSum += Math.acos(Math.min(1, d));
  }
  const chainSpread = (angSum / n) * 180 / Math.PI;

  return {
    B, bmag, chain, tilt, signedTilt, conc, order,
    stats: {
      centre: bmag[ci],
      min: bmin,
      max: bmax,
      mean: bmean,
      // Spread of |B| across the nail, relative to the peak.
      spreadPct: bmax > 1e-12 ? ((bmax - bmin) / bmax) * 100 : 0,
      meanTilt,
      tiltSpread,
      fanGradient,
      focalLength,
      fanKind: fanKindOf(fanGradient),
      chainSpread,
      meanOrder: avg(order),
      midMean: mean,
    },
  };
}

function avg(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

/**
 * Convex vs concave, and therefore which way the sheen sweeps.
 *
 * This measures how the flakes' lean CHANGES with distance from the medial
 * line, which is what makes the pile behave as a curved mirror array rather
 * than a flat one. It is a gradient, not a direction: what matters is whether
 * the lean opens out or closes in as you move off the centre line.
 *
 * Positive gradient - the lean opens outward - is a convex array, and a convex
 * mirror moves its highlight the same way the light moves. Negative is concave,
 * and past the focus a concave mirror moves its highlight the opposite way.
 *
 * Which one you get depends on the geometry, not on a single rule about poles:
 *
 *   Two poles side by side (a cat-eye wand). The field ARCS from one pole to
 *   the other across the plate - flat on the seam, curling up out of the
 *   surface toward the edges. Nothing splays. With the wand above, the arc dips
 *   down through the nail and the standing flakes lean away from the seam
 *   (concave); below, the arc bows up through it and they lean toward the seam
 *   (convex).
 *
 *   A single pole face aimed at the plate (reverse velvet, or a disc). Here the
 *   lines really do converge into the face from above, or spread out of it from
 *   below, and the same above/below rule falls out.
 */
function fanKindOf(g) {
  if (Math.abs(g) < 0.15) return 'flat';
  return g > 0 ? 'convex' : 'concave';
}

/** Unit tangent along the nail (medial direction) at grid node (iu, iv). */
function medialTangent(grid, iu, iv) {
  const a = Math.max(0, iu - 1);
  const b = Math.min(grid.nu - 1, iu + 1);
  const ia = a * grid.nv + iv;
  const ib = b * grid.nv + iv;
  return norm([
    grid.position[ib * 3] - grid.position[ia * 3],
    grid.position[ib * 3 + 1] - grid.position[ia * 3 + 1],
    grid.position[ib * 3 + 2] - grid.position[ia * 3 + 2],
  ]);
}

/** Surface arc width of the nail at row iu, in mm. */
function arcWidthAt(grid, iu) {
  let w = 0;
  for (let iv = 1; iv < grid.nv; iv++) {
    const a = iu * grid.nv + iv - 1;
    const b = iu * grid.nv + iv;
    w += Math.hypot(
      grid.position[b * 3] - grid.position[a * 3],
      grid.position[b * 3 + 1] - grid.position[a * 3 + 1],
      grid.position[b * 3 + 2] - grid.position[a * 3 + 2],
    );
  }
  return w;
}
