// Magnet model.
//
// Everything reduces to two primitives that carry magnetic surface charge:
//
//   box      -> two rectangular pole faces  (exact closed form, rect.js)
//   cylinder -> two circular pole faces     (adaptive quadrature, quadrature.js)
//
// Composite magnets (horseshoe, patterned arrays, Halbach cylinders) are just
// several primitives rigidly attached to the parent transform.
//
// A primitive is magnetised along its own local +Z by default, so only its two
// end faces are charged. A primitive may instead carry an OBLIQUE `mdir` - a
// unit magnetisation direction in its own local frame - in which case all six
// faces are charged with sigma = Br (mhat . nhat). That matters whenever the
// brick's ORIENTATION and its MAGNETISATION are independent, which is exactly
// the Halbach case: the blocks sit on a regular lattice while the magnetisation
// turns through them.
//
// Lengths are millimetres. Br and all fields are tesla.
//
// mu_r ~ 1.05 for NdFeB, so we take the magnetisation as fixed and never solve
// for demagnetisation or mutual-magnetisation effects.

import {
  quatBasis, quatMul, quatRotate, quatRotateInv, quatConj, quatIdentity,
  quatFromAxisAngle, mul, add, sub,
} from './vec.js';

let nextId = 1;

export const MAGNET_TYPES = [
  'box', 'cylinder', 'sphere', 'ring', 'horseshoe', 'array', 'halbachCylinder',
];

export const DEFAULT_BR = 1.3;

export function createMagnet(opts = {}) {
  const type = opts.type ?? 'box';
  return {
    id: opts.id ?? `mag${nextId++}`,
    type,
    name: opts.name ?? type,
    position: opts.position ? [...opts.position] : [0, 0, 12],
    quaternion: opts.quaternion ? [...opts.quaternion] : quatIdentity(),
    Br: opts.Br ?? DEFAULT_BR,
    flip: opts.flip ?? false,
    enabled: opts.enabled ?? true,
    size: { ...defaultSize(type), ...(opts.size ?? {}) },
    // How the operator's hand moves this tool, and when it is in that hand at
    // all. Both are optional and both are pure functions of time - see
    // motion.js. `null` means held still; `active` unset means always held.
    motion: opts.motion ? { ...opts.motion } : null,
    active: opts.active ? [...opts.active] : null,
  };
}

export function defaultSize(type) {
  switch (type) {
    case 'box':
      // A classic cat-eye wand magnet: a long thin bar, magnetised through
      // its thickness (local Z).
      return { sx: 20, sy: 5, sz: 3 };
    case 'cylinder':
      return { radius: 5, height: 3 };
    case 'sphere':
      return { radius: 6 };
    case 'ring':
      return { outerRadius: 9, innerRadius: 4, height: 4 };
    case 'halbachCylinder':
      // Bore wide enough to put a finger in, which is the point.
      return {
        outerRadius: 34, innerRadius: 20, height: 22, segments: 16, poles: 1,
      };
    case 'horseshoe':
      // Gap wide enough to actually sit a nail in, which is the point of the
      // horseshoe preset.
      return { legLength: 16, legWidth: 6, depth: 9, gap: 16, yoke: 6 };
    case 'array':
      return { nx: 6, ny: 1, cellX: 3, cellY: 12, height: 3, pattern: 'stripe' };
    default:
      return {};
  }
}

/** Sign of the magnetisation relative to local +Z. */
const magSign = (m) => (m.flip ? -1 : 1);

/**
 * Decompose a magnet into primitives, expressed in the magnet's LOCAL frame.
 *
 * @returns {Array<{kind:'box'|'cylinder', offset:number[], quat:number[],
 *                  dims:object, sign:number}>}
 */
export function magnetParts(m) {
  const s = m.size;
  const sgn = magSign(m);

  switch (m.type) {
    case 'box':
      return [{
        kind: 'box',
        offset: [0, 0, 0],
        quat: quatIdentity(),
        dims: { sx: s.sx, sy: s.sy, sz: s.sz },
        sign: sgn,
      }];

    case 'cylinder':
      return [{
        kind: 'cylinder',
        offset: [0, 0, 0],
        quat: quatIdentity(),
        dims: { radius: s.radius, height: s.height },
        sign: sgn,
      }];

    case 'sphere':
      // The one magnet in here with no surface integral at all: outside a
      // uniformly magnetised sphere the field is EXACTLY that of a point
      // dipole, and inside it is exactly uniform. No quadrature, no closed-form
      // corner sums, no approximation - which makes it the ideal reference
      // magnet as well as a nice smooth source with no edges or corners.
      return [{
        kind: 'sphere',
        offset: [0, 0, 0],
        quat: quatIdentity(),
        dims: { radius: s.radius },
        sign: sgn,
      }];

    case 'ring':
      // An annular pole face is just the outer disc minus the inner one, and
      // the field is linear in the charge distribution - so a ring needs no new
      // field kernel at all, only a negative disc punched out of a positive one.
      return [{
        kind: 'ring',
        offset: [0, 0, 0],
        quat: quatIdentity(),
        dims: {
          outerRadius: s.outerRadius,
          innerRadius: Math.min(s.innerRadius, s.outerRadius * 0.98),
          height: s.height,
        },
        sign: sgn,
      }];

    case 'halbachCylinder': {
      // A ring of blocks whose magnetisation angle advances at (p+1) times the
      // position angle. Inside the bore that produces a 2p-pole field:
      //   p = 1  dipole     - strong, near uniform transverse field, tiny
      //                       gradient. Torque without translation, which is
      //                       what separates orientation from migration.
      //   p = 2  quadrupole - a null at the centre with |B| growing ~linearly
      //                       outward, so a four-lobed pattern.
      const parts = [];
      const N = Math.max(4, Math.round(s.segments));
      const R = (s.innerRadius + s.outerRadius) * 0.5;
      const chord = 2 * R * Math.sin(Math.PI / N);
      const dims = {
        sx: Math.max(0.1, s.outerRadius - s.innerRadius), // radial
        sy: chord,                                        // tangential
        sz: s.height,                                     // axial
      };
      for (let i = 0; i < N; i++) {
        const phi = (2 * Math.PI * i) / N;
        // The block sits at angle phi with its local +X pointing radially out.
        // World magnetisation angle is (p+1)phi, so in the block's own frame it
        // is (p+1)phi - phi = p*phi.
        const psi = sgn * s.poles * phi;
        parts.push({
          kind: 'box',
          offset: [R * Math.cos(phi), R * Math.sin(phi), 0],
          quat: quatFromAxisAngle([0, 0, 1], phi),
          mdir: [Math.cos(psi), Math.sin(psi), 0],
          dims,
          sign: 1,
        });
      }
      return parts;
    }

    case 'horseshoe': {
      // U opening along +Z, legs separated along X, depth along Y.
      //
      // The two legs are modelled as bar magnets of opposite polarity; the
      // yoke joining their far ends is treated as soft iron (drawn, but not
      // charged). That is the standard approximation and it avoids the
      // spurious corner charges you get from trying to bend a uniformly
      // magnetised body around a right angle. Net charge is still zero, so
      // div B = 0 holds exactly.
      const x = (s.gap + s.legWidth) * 0.5;
      const z0 = s.yoke + s.legLength * 0.5;
      const dims = { sx: s.legWidth, sy: s.depth, sz: s.legLength };
      return [
        { kind: 'box', offset: [-x, 0, z0], quat: quatIdentity(), dims, sign: sgn },
        { kind: 'box', offset: [x, 0, z0], quat: quatIdentity(), dims, sign: -sgn },
      ];
    }

    case 'array': {
      // A pre-patterned polish tool: a tiled grid of small magnets with
      // alternating polarity, which is what produces striped / chequered
      // multi-line cat-eye effects.
      const parts = [];
      const dims = { sx: s.cellX, sy: s.cellY, sz: s.height };
      const ox = ((s.nx - 1) * s.cellX) * 0.5;
      const oy = ((s.ny - 1) * s.cellY) * 0.5;
      for (let i = 0; i < s.nx; i++) {
        for (let j = 0; j < s.ny; j++) {
          if (s.pattern === 'halbach') {
            // Magnetisation turns a quarter turn per cell instead of flipping,
            // reinforcing the field on one face and cancelling it on the other:
            // a one-sided flux tool. The BRICKS stay on the lattice and only the
            // magnetisation rotates, which is how a real Halbach array is built
            // (and is why oblique mdir exists).
            const psi = sgn * i * Math.PI / 2;
            parts.push({
              kind: 'box',
              offset: [i * s.cellX - ox, j * s.cellY - oy, 0],
              quat: quatIdentity(),
              mdir: [Math.sin(psi), 0, Math.cos(psi)],
              dims,
              sign: 1,
            });
          } else {
            const alt = s.pattern === 'checker' ? (i + j) % 2 : i % 2;
            parts.push({
              kind: 'box',
              offset: [i * s.cellX - ox, j * s.cellY - oy, 0],
              quat: quatIdentity(),
              dims,
              sign: sgn * (alt ? -1 : 1),
            });
          }
        }
      }
      return parts;
    }

    default:
      return [];
  }
}

/**
 * All charged pole faces of a magnet, in WORLD space.
 *
 * Both faces of a primitive share the primitive's basis (ez = magnetisation
 * axis); the south face simply carries a negative sigmaB. Keeping the basis
 * identical for both avoids any handedness bookkeeping in the field kernels.
 *
 * @returns {Array<object>} rect faces {sigmaB, center, ex, ey, ez, hx, hy}
 *                          and disc faces {sigmaB, center, ex, ey, ez, radius}
 */
export function magnetFaces(m) {
  if (!m.enabled) return [];

  const faces = [];
  const parentQ = m.quaternion;

  for (const part of magnetParts(m)) {
    const q = quatMul(parentQ, part.quat);
    const [ex, ey, ez] = quatBasis(q);
    const origin = add(m.position, quatRotate(parentQ, part.offset));
    const sigmaB = m.Br * part.sign;

    // `outward` points out of the magnet's body at that face. It is not used
    // by the field kernels (both faces share the primitive's basis), but the
    // force integrator needs it to know which side of a face it is standing on.
    const outward = mul(ez, 1);
    const inward = mul(ez, -1);

    // Oblique magnetisation: every face whose normal has a component along M
    // carries charge, sigma = Br (mhat . nhat). The axis-aligned case below is
    // just this with mhat = local +Z, where four of the six terms vanish.
    if (part.kind === 'sphere') {
      faces.push({
        kind: 'sphere',
        Br: m.Br,
        radius: part.dims.radius,
        axis: mul(ez, part.sign),   // unit magnetisation direction, world space
        center: origin,
      });
    } else if (part.kind === 'box' && part.mdir) {
      const [mx, my, mz] = part.mdir;
      const hx = part.dims.sx * 0.5;
      const hy = part.dims.sy * 0.5;
      const hz = part.dims.sz * 0.5;
      const basis = [ex, ey, ez];
      const m3 = [mx, my, mz];
      // For each local axis: the two faces perpendicular to it. Half-extents of
      // a face are the box's other two half-extents, in cyclic order.
      const half = [[hy, hz, hx], [hz, hx, hy], [hx, hy, hz]];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(m3[a]) < 1e-12) continue;
        const [fa, fb, fh] = half[a];
        const u = basis[(a + 1) % 3];
        const v = basis[(a + 2) % 3];
        const nAxis = basis[a];
        for (const side of [1, -1]) {
          faces.push({
            kind: 'rect',
            sigmaB: m.Br * part.sign * m3[a] * side,
            hx: fa, hy: fb,
            ex: u, ey: v, ez: mul(nAxis, side),
            outward: mul(nAxis, side),
            center: add(origin, mul(nAxis, side * fh)),
          });
        }
      }
    } else if (part.kind === 'ring') {
      const h = part.dims.height * 0.5;
      const top = add(origin, mul(ez, h));
      const bot = add(origin, mul(ez, -h));
      // outer disc, minus the inner disc punched out of it, on each face
      faces.push({ kind: 'disc', sigmaB, radius: part.dims.outerRadius,
        ex, ey, ez, outward, center: top });
      faces.push({ kind: 'disc', sigmaB: -sigmaB, radius: part.dims.innerRadius,
        ex, ey, ez, outward, center: top });
      faces.push({ kind: 'disc', sigmaB: -sigmaB, radius: part.dims.outerRadius,
        ex, ey, ez, outward: inward, center: bot });
      faces.push({ kind: 'disc', sigmaB, radius: part.dims.innerRadius,
        ex, ey, ez, outward: inward, center: bot });
    } else if (part.kind === 'box') {
      const h = part.dims.sz * 0.5;
      const hx = part.dims.sx * 0.5;
      const hy = part.dims.sy * 0.5;
      faces.push({
        kind: 'rect', sigmaB, hx, hy, ex, ey, ez, outward,
        center: add(origin, mul(ez, h)),
      });
      faces.push({
        kind: 'rect', sigmaB: -sigmaB, hx, hy, ex, ey, ez, outward: inward,
        center: add(origin, mul(ez, -h)),
      });
    } else {
      const h = part.dims.height * 0.5;
      const radius = part.dims.radius;
      faces.push({
        kind: 'disc', sigmaB, radius, ex, ey, ez, outward,
        center: add(origin, mul(ez, h)),
      });
      faces.push({
        kind: 'disc', sigmaB: -sigmaB, radius, ex, ey, ez, outward: inward,
        center: add(origin, mul(ez, -h)),
      });
    }
  }

  return faces;
}

/**
 * On-axis field of a single cuboid magnet, from the standard closed-form axial
 * formula for a rectangular bar magnet. Written out independently of the
 * general solver so it can serve as an external check (validation Test 1).
 *
 * @param {number} Br
 * @param {number} sx,sy,sz  full dimensions, magnetised along sz
 * @param {number} z         distance from the magnet CENTRE along the axis
 */
export function axialBoxFieldReference(Br, sx, sy, sz, z) {
  const a = sx * 0.5;
  const b = sy * 0.5;
  const c = sz * 0.5;

  const term = (d) => Math.atan2(a * b, d * Math.sqrt(a * a + b * b + d * d));

  return (Br / Math.PI) * (term(z - c) - term(z + c));
}

/** World-space centres of the north and south pole faces (for snapping/UI). */
export function poleCenters(m) {
  const [, , ez] = quatBasis(m.quaternion);
  const sgn = magSign(m);
  let h;
  if (m.type === 'sphere') h = m.size.radius;
  else if (m.type === 'cylinder' || m.type === 'ring'
      || m.type === 'halbachCylinder') h = m.size.height * 0.5;
  else if (m.type === 'box') h = m.size.sz * 0.5;
  else if (m.type === 'array') h = m.size.height * 0.5;
  else h = m.size.yoke + m.size.legLength; // horseshoe: pole tips

  return {
    north: add(m.position, mul(ez, sgn * h)),
    south: add(m.position, mul(ez, -sgn * h)),
    axis: mul(ez, sgn),
  };
}

/**
 * Is world point p inside the magnet's material? Used to stop field-line
 * tracing at the magnet surface (inside, the surface-charge model returns H,
 * not B, so the streamlines there are not meaningful).
 */
export function insideMagnet(m, p, margin = 0) {
  const local = quatRotateInv(m.quaternion, sub(p, m.position));
  for (const part of magnetParts(m)) {
    const q = quatRotateInv(part.quat, sub(local, part.offset));
    if (part.kind === 'ring') {
      // The material of an annulus: between the two radii, and within the
      // height. The hole is emphatically NOT inside the magnet - that is the
      // whole point of a ring, and what a field line traced through the bore
      // depends on.
      const { outerRadius, innerRadius, height } = part.dims;
      const rho = Math.hypot(q[0], q[1]);
      if (rho <= outerRadius + margin && rho >= innerRadius - margin
          && Math.abs(q[2]) <= height / 2 + margin) return true;
    } else if (part.kind === 'sphere') {
      // A sphere part carries no `height`, so it must not fall through to the
      // cylinder test below - that compares against undefined and is always
      // false, which silently reports the inside of a sphere as outside it.
      if (Math.hypot(q[0], q[1], q[2]) <= part.dims.radius + margin) return true;
    } else if (part.kind === 'box') {
      const { sx, sy, sz } = part.dims;
      if (Math.abs(q[0]) <= sx / 2 + margin &&
          Math.abs(q[1]) <= sy / 2 + margin &&
          Math.abs(q[2]) <= sz / 2 + margin) return true;
    } else {
      const { radius, height } = part.dims;
      if (Math.hypot(q[0], q[1]) <= radius + margin &&
          Math.abs(q[2]) <= height / 2 + margin) return true;
    }
  }
  return false;
}

export function insideAnyMagnet(magnets, p, margin = 0) {
  for (const m of magnets) if (m.enabled !== false && insideMagnet(m, p, margin)) return true;
  return false;
}

/** Axis-aligned local half-extents, used for gizmo/proxy geometry and snapping. */
export function magnetExtents(m) {
  const s = m.size;
  switch (m.type) {
    case 'box': return [s.sx * 0.5, s.sy * 0.5, s.sz * 0.5];
    case 'cylinder': return [s.radius, s.radius, s.height * 0.5];
    case 'sphere': return [s.radius, s.radius, s.radius];
    case 'ring': return [s.outerRadius, s.outerRadius, s.height * 0.5];
    case 'halbachCylinder':
      return [s.outerRadius, s.outerRadius, s.height * 0.5];
    case 'horseshoe':
      return [(s.gap + 2 * s.legWidth) * 0.5, s.depth * 0.5,
        (s.yoke + s.legLength) * 0.5];
    case 'array':
      return [s.nx * s.cellX * 0.5, s.ny * s.cellY * 0.5, s.height * 0.5];
    default: return [1, 1, 1];
  }
}
