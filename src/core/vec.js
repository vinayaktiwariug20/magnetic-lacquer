// Minimal vector / quaternion helpers.
//
// Everything here works on plain 3-element (vectors) or 4-element (quaternions,
// xyzw order) arrays so the physics core stays dependency-free and runnable in
// node, a worker, or the browser.

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const len2 = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function norm(a) {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function addInto(out, a) {
  out[0] += a[0];
  out[1] += a[1];
  out[2] += a[2];
  return out;
}

// --- quaternions (xyzw) -----------------------------------------------------

export const quatIdentity = () => [0, 0, 0, 1];

export function quatFromAxisAngle(axis, angle) {
  const a = norm(axis);
  const h = angle * 0.5;
  const s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
}

export function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConj(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rotate vector v by quaternion q. */
export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (qvec x v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Rotate vector v by the inverse of q. */
export function quatRotateInv(q, v) {
  return quatRotate(quatConj(q), v);
}

/** Shortest-arc rotation taking unit vector `from` to unit vector `to`. */
export function quatFromUnitVectors(from, to) {
  const f = norm(from);
  const t = norm(to);
  let r = dot(f, t) + 1;
  if (r < 1e-9) {
    // Opposite vectors: pick any perpendicular axis.
    r = 0;
    const q =
      Math.abs(f[0]) > Math.abs(f[2]) ? [-f[1], f[0], 0, r] : [0, -f[2], f[1], r];
    return quatNormalize(q);
  }
  const c = cross(f, t);
  return quatNormalize([c[0], c[1], c[2], r]);
}

/** Column-major 3x3 basis (ex, ey, ez) of a quaternion. */
export function quatBasis(q) {
  return [
    quatRotate(q, [1, 0, 0]),
    quatRotate(q, [0, 1, 0]),
    quatRotate(q, [0, 0, 1]),
  ];
}
