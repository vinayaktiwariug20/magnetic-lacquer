// The nail as a doubly-curved surface patch.
//
// Built as a swept arc: a longitudinal spine arc (cuticle -> free edge) with a
// transverse arc (the arch across the nail) swept along it. Both arcs are true
// circles parametrised by ARC LENGTH, so "length" and "width" stay honest as
// you crank the curvature up - a parabolic profile would silently shrink the
// nail as it curved.
//
// Local frame: +X across the nail, +Y toward the free edge, +Z out of the nail.
// Lengths in millimetres.

import { quatRotate, quatRotateInv, quatIdentity, add, sub, cross, norm } from './vec.js';
import { magnetParts } from './magnet.js';

export function createNail(opts = {}) {
  return {
    length: opts.length ?? 16,
    width: opts.width ?? 12,
    // Curvature = 1/radius, in 1/mm. 0 is flat.
    transverseCurv: opts.transverseCurv ?? 0.09,   // R ~ 11 mm, a normal arch
    longitudinalCurv: opts.longitudinalCurv ?? 0.02, // R ~ 50 mm, gentle
    position: opts.position ? [...opts.position] : [0, 0, 0],
    quaternion: opts.quaternion ? [...opts.quaternion] : quatIdentity(),
    resU: opts.resU ?? 96, // along length
    resV: opts.resV ?? 64, // across width
    taper: opts.taper ?? 0.12, // narrowing toward the cuticle, purely cosmetic
  };
}

/** sin(k*t)/k, with the k -> 0 limit. */
function arcTangential(k, t) {
  return Math.abs(k) < 1e-9 ? t : Math.sin(k * t) / k;
}

/** (cos(k*t) - 1)/k, with the k -> 0 limit. */
function arcNormal(k, t) {
  return Math.abs(k) < 1e-9 ? -0.5 * k * t * t : (Math.cos(k * t) - 1) / k;
}

/**
 * Surface point and normal in the nail's LOCAL frame.
 *
 * @param {object} nail
 * @param {number} s  arc length along the nail, in [-length/2, +length/2]
 * @param {number} t  arc length across the nail, in [-width/2, +width/2]
 */
export function nailPointLocal(nail, s, t) {
  const kl = nail.longitudinalCurv;
  const kt = nail.transverseCurv;

  // Spine arc in the YZ plane.
  const al = kl * s;
  const spine = [0, arcTangential(kl, s), arcNormal(kl, s)];
  const spineN = [0, Math.sin(al), Math.cos(al)]; // spine normal, +Z at s = 0
  const B = [1, 0, 0];                            // binormal: across the nail

  // Transverse arc swept in the (B, spineN) plane.
  const at = kt * t;
  const off = arcTangential(kt, t);
  const dep = arcNormal(kt, t);

  const p = [
    spine[0] + off * B[0] + dep * spineN[0],
    spine[1] + off * B[1] + dep * spineN[1],
    spine[2] + off * B[2] + dep * spineN[2],
  ];

  // dP/ds is parallel to the spine tangent and dP/dt = cos(at) B - sin(at) N,
  // so the outward normal comes out in closed form.
  const n = [
    Math.cos(at) * spineN[0] + Math.sin(at) * B[0],
    Math.cos(at) * spineN[1] + Math.sin(at) * B[1],
    Math.cos(at) * spineN[2] + Math.sin(at) * B[2],
  ];

  return { p, n };
}

/** Half-width of the nail at longitudinal parameter u in [0,1]. */
function halfWidthAt(nail, u) {
  // Slight taper toward the cuticle so it reads as a nail rather than a tile.
  const k = 1 - nail.taper * (1 - u) * (1 - u);
  return (nail.width * 0.5) * k;
}

/**
 * Build the UV grid. Every texel carries world position, world normal, and the
 * UV coordinate; the field sampler fills in B afterwards.
 *
 * @returns {object} grid
 */
export function buildNailGrid(nail) {
  const { resU, resV } = nail;
  const nu = resU + 1;
  const nv = resV + 1;
  const count = nu * nv;

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const localPos = new Float32Array(count * 3);

  for (let iu = 0; iu < nu; iu++) {
    const u = iu / resU;
    const s = (u - 0.5) * nail.length;
    const hw = halfWidthAt(nail, u);

    for (let iv = 0; iv < nv; iv++) {
      const v = iv / resV;
      const t = (v - 0.5) * 2 * hw;

      const { p, n } = nailPointLocal(nail, s, t);
      const wp = add(nail.position, quatRotate(nail.quaternion, p));
      const wn = quatRotate(nail.quaternion, n);

      const i = iu * nv + iv;
      position[i * 3] = wp[0];
      position[i * 3 + 1] = wp[1];
      position[i * 3 + 2] = wp[2];
      localPos[i * 3] = p[0];
      localPos[i * 3 + 1] = p[1];
      localPos[i * 3 + 2] = p[2];
      normal[i * 3] = wn[0];
      normal[i * 3 + 1] = wn[1];
      normal[i * 3 + 2] = wn[2];
      uv[i * 2] = v;
      uv[i * 2 + 1] = u;
    }
  }

  // Triangle indices.
  const index = new Uint32Array(resU * resV * 6);
  let w = 0;
  for (let iu = 0; iu < resU; iu++) {
    for (let iv = 0; iv < resV; iv++) {
      const a = iu * nv + iv;
      const b = a + nv;
      index[w++] = a; index[w++] = b; index[w++] = a + 1;
      index[w++] = b; index[w++] = b + 1; index[w++] = a + 1;
    }
  }

  return { nu, nv, count, position, normal, uv, localPos, index, nail };
}

/** World-space centre point and normal of the nail. */
export function nailCentre(nail) {
  const { p, n } = nailPointLocal(nail, 0, 0);
  return {
    p: add(nail.position, quatRotate(nail.quaternion, p)),
    n: quatRotate(nail.quaternion, n),
  };
}

/**
 * Medial line direction (along the nail) in world space at the centre. The
 * fibre fan that produces the moving sheen is organised about this line.
 */
export function nailMedialDir(nail) {
  const a = nailPointLocal(nail, -0.5, 0).p;
  const b = nailPointLocal(nail, 0.5, 0).p;
  return norm(quatRotate(nail.quaternion, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
}

/**
 * Finger capsule for context: radius, total length, and the offset of its axis
 * in the nail's local frame. Purely visual - it carries no physics.
 *
 * The radius is matched to the nail's own transverse arc radius where that is
 * sensible, so the plate sits flush on the finger instead of hovering above it
 * or cutting through it. The axis then sits exactly one radius below the crown,
 * which puts the finger's surface through the nail's centre line.
 */
export function fingerFor(nail) {
  // Capped at the nail's own arc radius. A finger flatter than the nail would
  // fall away more slowly than the plate and burst through it at the sides.
  const arcR = nail.transverseCurv > 1e-6 ? 1 / nail.transverseCurv : Infinity;
  const radius = Math.min(arcR, nail.width * 0.75);

  // Now drop the axis until NO point of the plate lies inside the cylinder.
  //
  // Placing it one radius below the crown is not enough: longitudinal curvature
  // sags both ends of the nail by (1 - cos(k L/2))/k, which buries them in the
  // finger and produces a scalloped intersection along the edge. The axis runs
  // along Y at (0, z0), so each surface point p constrains
  //     z0 <= p.z - sqrt(R^2 - p.x^2)
  // and points beyond the cylinder's lateral reach constrain nothing. Taking
  // the minimum over the whole plate makes the finger tangent at worst.
  let z0 = -radius;
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const s = (u - 0.5) * nail.length;
    const hw = halfWidthAt(nail, u);
    for (let j = 0; j <= N; j++) {
      const { p } = nailPointLocal(nail, s, (j / N - 0.5) * 2 * hw);
      const under = radius * radius - p[0] * p[0];
      if (under <= 0) continue;
      z0 = Math.min(z0, p[2] - Math.sqrt(under));
    }
  }

  return {
    radius,
    length: nail.length * 2.2,
    // Pushed back toward the cuticle so the free edge slightly overhangs the
    // fingertip, as a real nail does.
    offset: [0, -nail.length * 0.72, z0],
  };
}

/**
 * The finger as a capsule in WORLD space: a segment plus a radius.
 *
 * The mesh is built from three's CapsuleGeometry, whose `length` argument is
 * the cylindrical middle only and whose caps add a radius at each end, so the
 * axis segment is shorter than the total length by one diameter.
 */
export function fingerCapsule(nail, finger = fingerFor(nail)) {
  const mid = Math.max(0.1, finger.length - 2 * finger.radius) * 0.5;
  const toWorld = (p) => add(nail.position, quatRotate(nail.quaternion, p));
  return {
    radius: finger.radius,
    a: toWorld([finger.offset[0], finger.offset[1] - mid, finger.offset[2]]),
    b: toWorld([finger.offset[0], finger.offset[1] + mid, finger.offset[2]]),
  };
}

/**
 * Clearance in mm between a magnet and the finger. Negative means the tool is
 * inside the flesh, which is not a rendering nuisance but a statement that the
 * arrangement cannot be built - you cannot hold a magnet there.
 *
 * Measured the right way round: rather than testing the magnet's corners
 * against the capsule (which misses a thin capsule passing through the middle
 * of a big face), this walks the capsule's AXIS and takes the exact distance
 * from each axis point to the magnet body, then subtracts the radius. For a
 * box that distance is closed form in the box's own frame, so the only
 * discretisation is along the axis.
 */
export function fingerClearance(nail, magnet, samples = 96) {
  const cap = fingerCapsule(nail);
  let best = Infinity;

  for (const part of magnetParts(magnet)) {
    for (let i = 0; i <= samples; i++) {
      const s = i / samples;
      const w = [
        cap.a[0] + (cap.b[0] - cap.a[0]) * s,
        cap.a[1] + (cap.b[1] - cap.a[1]) * s,
        cap.a[2] + (cap.b[2] - cap.a[2]) * s,
      ];
      // into the magnet's frame, then into the part's frame
      const ml = quatRotateInv(magnet.quaternion, sub(w, magnet.position));
      const q = quatRotateInv(part.quat, sub(ml, part.offset));
      best = Math.min(best, partDistance(part, q) - cap.radius);
    }
  }
  return best;
}

/** Exact distance from a local-frame point to a primitive's surface/interior. */
function partDistance(part, q) {
  const d = part.dims;
  if (part.kind === 'sphere') {
    return Math.hypot(q[0], q[1], q[2]) - d.radius;
  }
  if (part.kind === 'box') {
    const ex = Math.abs(q[0]) - d.sx * 0.5;
    const ey = Math.abs(q[1]) - d.sy * 0.5;
    const ez = Math.abs(q[2]) - d.sz * 0.5;
    const ox = Math.max(ex, 0);
    const oy = Math.max(ey, 0);
    const oz = Math.max(ez, 0);
    // Outside distance, plus the (negative) inside distance when fully within.
    return Math.hypot(ox, oy, oz) + Math.min(0, Math.max(ex, ey, ez));
  }
  // cylinder and ring: an annulus swept along local z
  const r = Math.hypot(q[0], q[1]);
  const outer = d.outerRadius ?? d.radius;
  const inner = d.innerRadius ?? 0;
  const er = Math.max(inner - r, r - outer);
  const ez = Math.abs(q[2]) - d.height * 0.5;
  const or_ = Math.max(er, 0);
  const oz = Math.max(ez, 0);
  return Math.hypot(or_, oz) + Math.min(0, Math.max(er, ez));
}

/** Smallest clearance over a magnet list; Infinity when there are none. */
export function fingerClearanceAll(nail, magnets) {
  let best = Infinity;
  for (const m of magnets) {
    if (m.enabled === false) continue;
    best = Math.min(best, fingerClearance(nail, m));
  }
  return best;
}
