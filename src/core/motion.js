// Scripted magnet motion: the "hand" that holds the tool.
//
// Everything here is expressed in the NAIL's frame rather than world space, so
// a technique reads the way it is actually described - "circle the round end of
// the wand a few millimetres above the plate", "hold it at one corner, then the
// other" - and keeps working when the nail is moved or turned.
//
// Frame convention, matching the nail's own local axes:
//   x  across the nail (thumb side to little-finger side)
//   y  along the nail, toward the free edge
//   z  out of the nail
//
// The pose returned is absolute, so the caller can drop it straight onto the
// magnet before rebuilding faces. Motion is a pure function of time: there is
// no integration and no state, which means scrubbing backwards, restarting and
// replaying all give bit-identical results.

import {
  add, cross, mul, norm, quatFromAxisAngle, quatMul, quatIdentity,
  quatConj, quatNormalize,
} from './vec.js';
import { nailCentre, nailMedialDir } from './nail.js';

export const MOTION_KINDS = ['still', 'spin', 'orbit', 'waypoints'];

export function defaultMotion(kind) {
  switch (kind) {
    case 'spin':
      // 90 rpm is 0.67 s per turn - the same order as the alignment time
      // constant once the polish has thickened, which is the band where
      // spinning actually does something. See dynamics.js.
      return { kind: 'spin', rpm: 90, axis: 'normal', phase: 0 };
    case 'orbit':
      return { kind: 'orbit', rpm: 45, radius: 5, yaw: true, phase: 0 };
    case 'waypoints':
      return {
        kind: 'waypoints',
        loop: false,
        travel: 1.2,
        stops: [
          { offset: [-4, 4, 0], spin: 0, hold: 4 },
          { offset: [4, -4, 0], spin: 0, hold: 4 },
        ],
      };
    default:
      return { kind: 'still' };
  }
}

/** Orthonormal nail frame in world space: {origin, x, y, z}. */
export function nailFrame(nail) {
  const c = nailCentre(nail);
  const z = norm(c.n);
  const along = nailMedialDir(nail);
  // Re-orthogonalise: the medial direction is not exactly perpendicular to the
  // centre normal once the nail is curved longitudinally.
  const x = norm(cross(along, z));
  const y = norm(cross(z, x));
  return { origin: c.p, x, y, z };
}

/** Nail-frame offset (mm) to a world point. */
function toWorld(frame, o) {
  return [
    frame.origin[0] + frame.x[0] * o[0] + frame.y[0] * o[1] + frame.z[0] * o[2],
    frame.origin[1] + frame.x[1] * o[0] + frame.y[1] * o[1] + frame.z[1] * o[2],
    frame.origin[2] + frame.x[2] * o[0] + frame.y[2] * o[1] + frame.z[2] * o[2],
  ];
}

/** Smoothstep, so a scripted hand accelerates and settles instead of jerking. */
function smooth(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function spinAxis(motion, frame, base) {
  if (Array.isArray(motion.axis)) return norm(motion.axis);
  switch (motion.axis) {
    case 'along': return frame.y;
    case 'across': return frame.x;
    default: return frame.z;
  }
  // (unreachable; kept exhaustive for clarity)
}

/**
 * Total duration of one cycle, seconds. Infinite for the periodic motions,
 * which is why the UI shows elapsed time rather than a progress bar.
 */
export function motionDuration(motion) {
  if (!motion || motion.kind === 'still') return 0;
  if (motion.kind === 'waypoints') {
    const s = motion.stops ?? [];
    let d = 0;
    for (const st of s) d += (st.hold ?? 0) + (motion.travel ?? 1);
    return d;
  }
  const rpm = Math.abs(motion.rpm ?? 0);
  return rpm > 0 ? 60 / rpm : 0;
}

/**
 * Pose of a magnet at time t.
 *
 * @param {object} motion  see MOTION_KINDS; falsy or 'still' returns the base
 * @param {number} t       seconds since the coat was applied
 * @param {object} base    {position, quaternion} as authored
 * @param {object} frame   from nailFrame
 */
export function motionPose(motion, t, base, frame) {
  const pos = [...base.position];
  const quat = [...base.quaternion];
  if (!motion || motion.kind === 'still') return { position: pos, quaternion: quat };

  switch (motion.kind) {
    case 'spin': {
      // Turning the tool about its own centre. The tool does not go anywhere,
      // so the field STRENGTH at each texel barely changes while its DIRECTION
      // sweeps a full turn - which is exactly the input that scatters a pile
      // instead of combing it.
      const ang = (motion.phase ?? 0)
        + (2 * Math.PI * (motion.rpm ?? 0) * t) / 60;
      const ax = spinAxis(motion, frame, base);
      const q = quatFromAxisAngle(ax, ang);
      return { position: pos, quaternion: quatMul(q, quat) };
    }

    case 'orbit': {
      // Walking the tool round a circle without turning it, or turning it to
      // stay pointed inward if `yaw`. This is the "circle the round end of the
      // wand around the nail" technique.
      const ang = (motion.phase ?? 0)
        + (2 * Math.PI * (motion.rpm ?? 0) * t) / 60;
      const r = motion.radius ?? 5;
      const ax = spinAxis(motion, frame, base);
      // Circle in the plane perpendicular to the spin axis, centred on the
      // magnet's authored position so a preset's standoff is preserved.
      const u = norm(cross(Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], ax));
      const v = cross(ax, u);
      const off = add(mul(u, r * Math.cos(ang)), mul(v, r * Math.sin(ang)));
      const p = add(base.position, off);
      const q = motion.yaw ? quatMul(quatFromAxisAngle(ax, ang), quat) : quat;
      return { position: p, quaternion: q };
    }

    case 'waypoints': {
      const stops = motion.stops ?? [];
      if (!stops.length) return { position: pos, quaternion: quat };
      const travel = Math.max(0.01, motion.travel ?? 1);

      // Lay the schedule out as hold, travel, hold, travel, ... and find where
      // t lands. Past the end we park on the last stop, which is what a hand
      // does: it stops moving and the polish finishes setting.
      let cursor = 0;
      const total = motionDuration(motion);
      let tt = t;
      if (motion.loop && total > 0) tt = ((t % total) + total) % total;

      for (let i = 0; i < stops.length; i++) {
        const hold = stops[i].hold ?? 0;
        if (tt < cursor + hold) return atStop(stops[i], base, frame, quat);
        cursor += hold;
        const next = stops[(i + 1) % stops.length];
        const isLast = i === stops.length - 1;
        if (isLast && !motion.loop) return atStop(stops[i], base, frame, quat);
        if (tt < cursor + travel) {
          const a = smooth((tt - cursor) / travel);
          return lerpStops(stops[i], next, a, base, frame, quat);
        }
        cursor += travel;
      }
      return atStop(stops[stops.length - 1], base, frame, quat);
    }

    default:
      return { position: pos, quaternion: quat };
  }
}

/**
 * The displacement a motion adds to its base pose at time t.
 *
 * Every kind above is authored as an offset FROM the base: position comes out
 * as base + dp with dp independent of the base, and orientation as dq * base.
 * Evaluating the pose from a zero base therefore recovers (dp, dq) without
 * restating any of the per-kind maths here, and keeps doing so if a kind is
 * added later - provided it keeps that form.
 */
export function motionDelta(motion, t, frame) {
  return motionPose(
    motion, t, { position: [0, 0, 0], quaternion: quatIdentity() }, frame,
  );
}

/**
 * Inverse of motionPose: given where a scripted tool is being SHOWN, recover
 * the authored pose that would put it there.
 *
 * This is what makes a moving tool draggable. The gizmo has to sit on the posed
 * magnet, because that is where the thing you are reaching for appears - so a
 * drag reports the posed transform. Storing that as the authored pose is wrong
 * in a way that compounds: the script re-adds its own offset on the next solve,
 * and again on the one after, so the tool walks off in a spiral instead of
 * following the pointer.
 */
export function unposeMagnet(motion, t, frame, position, quaternion) {
  if (!motion || motion.kind === 'still') {
    return { position: [...position], quaternion: [...quaternion] };
  }
  const d = motionDelta(motion, t, frame);
  return {
    position: [
      position[0] - d.position[0],
      position[1] - d.position[1],
      position[2] - d.position[2],
    ],
    quaternion: quatNormalize(quatMul(quatConj(d.quaternion), quaternion)),
  };
}

function stopQuat(stop, frame, baseQuat) {
  const deg = stop.spin ?? 0;
  if (!deg) return [...baseQuat];
  return quatMul(quatFromAxisAngle(frame.z, (deg * Math.PI) / 180), baseQuat);
}

function atStop(stop, base, frame, baseQuat) {
  const o = stop.offset ?? [0, 0, 0];
  const w = toWorld(frame, o);
  // The offset is a displacement of the tool from where the preset put it, in
  // nail-frame millimetres - so the authored standoff is preserved and only the
  // sideways placement is scripted.
  return {
    position: [
      base.position[0] + (w[0] - frame.origin[0]),
      base.position[1] + (w[1] - frame.origin[1]),
      base.position[2] + (w[2] - frame.origin[2]),
    ],
    quaternion: stopQuat(stop, frame, baseQuat),
  };
}

function lerpStops(a, b, s, base, frame, baseQuat) {
  const pa = atStop(a, base, frame, baseQuat);
  const pb = atStop(b, base, frame, baseQuat);
  const da = a.spin ?? 0;
  const db = b.spin ?? 0;
  return {
    position: [
      pa.position[0] + (pb.position[0] - pa.position[0]) * s,
      pa.position[1] + (pb.position[1] - pa.position[1]) * s,
      pa.position[2] + (pb.position[2] - pa.position[2]) * s,
    ],
    quaternion: stopQuat({ spin: da + (db - da) * s }, frame, baseQuat),
  };
}

/**
 * Is this tool in the operator's hand at time t? A magnet may carry
 * `active: [from, to]` (seconds), which is how a multi-step technique picks a
 * tool up and puts it down.
 *
 * Taking a tool AWAY is not a cosmetic detail - it is the mechanism behind
 * every multi-step technique. With no field there is no torque, so a pile that
 * has already been combed simply stays where it is, indefinitely and at any
 * viscosity. That is what lets you set a line with the bar, remove it, and then
 * distort one corner with the round end without disturbing the rest: the
 * untouched regions are held not by the polish thickening but by the absence of
 * anything to turn them.
 */
export function activeAt(m, t) {
  const w = m.active;
  if (!w) return true;
  const from = w[0] ?? -Infinity;
  const to = w[1] ?? Infinity;
  return t >= from && t < to;
}

/**
 * Apply every magnet's motion at time t, returning a new magnet list. The
 * originals are left untouched so the authored pose survives scrubbing.
 *
 * Time is measured from when the coat went on, and motion is a pure function of
 * it, so scrubbing to 12 s gives the same pose whether you got there by playing
 * forward or by jumping.
 */
export function posedMagnets(magnets, nail, t) {
  const frame = nailFrame(nail);
  const out = [];
  for (const m of magnets) {
    if (!activeAt(m, t)) continue;
    if (!m.motion || m.motion.kind === 'still') { out.push(m); continue; }
    const { position, quaternion } = motionPose(m.motion, t, m, frame);
    out.push({ ...m, position, quaternion });
  }
  return out;
}

export { quatIdentity };
