// Snap-together helper.
//
// When a magnet is dragged near another one's pole face, snap it flush and
// orient it to whichever polarity actually attracts - so stacking behaves the
// way magnets do on a desk.
//
// The polarity rule falls out of the geometry: whichever face you approach,
// the attracting arrangement always leaves both magnetisation vectors pointing
// the SAME way (N-S-N-S up the stack). So the snap is always "align my
// magnetisation with yours, then sit flush against the face".

import {
  quatBasis, quatMul, quatFromUnitVectors, add, sub, mul, dot, len,
} from './vec.js';

/** Types whose stacking is well defined. */
const STACKABLE = new Set(['box', 'cylinder']);

/** Half-extent along the magnetisation axis. */
export function axialHalfExtent(m) {
  if (m.type === 'cylinder') return m.size.height * 0.5;
  if (m.type === 'box') return m.size.sz * 0.5;
  if (m.type === 'array') return m.size.height * 0.5;
  return m.size.yoke + m.size.legLength;
}

/** Radius of the pole face, transverse to the magnetisation axis. */
export function faceRadius(m) {
  if (m.type === 'cylinder') return m.size.radius;
  if (m.type === 'box') return Math.max(m.size.sx, m.size.sy) * 0.5;
  if (m.type === 'array') return Math.max(m.size.nx * m.size.cellX, m.size.ny * m.size.cellY) * 0.5;
  return m.size.gap * 0.5;
}

/** Unit magnetisation direction in world space (N pole side). */
export function magnetisationDir(m) {
  const [, , ez] = quatBasis(m.quaternion);
  return m.flip ? [-ez[0], -ez[1], -ez[2]] : ez;
}

/**
 * Find a snap for `target` against `others`.
 *
 * @param {object} target
 * @param {object[]} others
 * @param {object} [opts] {snapDist, lateralSlack}
 * @returns {{position:number[], quaternion:number[], toId:string, gap:number}|null}
 */
export function findSnap(target, others, opts = {}) {
  const snapDist = opts.snapDist ?? 4;
  const lateralSlack = opts.lateralSlack ?? 1.0;

  if (!STACKABLE.has(target.type)) return null;

  const ht = axialHalfExtent(target);
  const rt = faceRadius(target);
  const ut = magnetisationDir(target);

  let best = null;

  for (const o of others) {
    if (o === target || o.id === target.id) continue;
    if (!STACKABLE.has(o.type)) continue;

    const uo = magnetisationDir(o);
    const ho = axialHalfExtent(o);
    const ro = faceRadius(o);

    for (const side of [1, -1]) {
      // Centre of this pole face, and the outward direction from it.
      const faceOut = mul(uo, side);
      const facePoint = add(o.position, mul(faceOut, ho));

      const d = sub(target.position, facePoint);
      const axial = dot(d, faceOut);
      if (axial <= 0) continue; // target is behind this face

      // How far the two faces are from being flush, and how far off-centre.
      const gap = axial - ht;
      const lateral = len(sub(d, mul(faceOut, axial)));

      if (Math.abs(gap) > snapDist) continue;
      if (lateral > ro + rt + lateralSlack) continue;

      const score = Math.abs(gap) + lateral * 0.5;
      if (best && score >= best.score) continue;

      // Attraction always leaves both magnetisation vectors parallel, whichever
      // face you came in on. Rotate the target the short way onto that axis,
      // preserving its roll, and sit it flush and centred.
      const delta = quatFromUnitVectors(ut, uo);
      best = {
        score,
        gap,
        toId: o.id,
        position: add(facePoint, mul(faceOut, ht)),
        quaternion: quatMul(delta, target.quaternion),
      };
    }
  }

  if (!best) return null;
  return {
    position: best.position,
    quaternion: best.quaternion,
    toId: best.toId,
    gap: best.gap,
  };
}

/** Apply a snap in place. Returns true if one was found. */
export function applySnap(target, others, opts) {
  const s = findSnap(target, others, opts);
  if (!s) return false;
  target.position = s.position;
  target.quaternion = s.quaternion;
  return true;
}
