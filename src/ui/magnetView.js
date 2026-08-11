// Visual proxies for magnets, plus the finger.
//
// Each magnet becomes one Group placed at the magnet's own position and
// orientation, so TransformControls can be attached to it directly and the
// result read straight back into the model.

import * as THREE from 'three';
import { magnetParts } from '../core/magnet.js';

const NORTH = 0xd6453f;
const SOUTH = 0x3f7fd6;
const BODY = 0x9aa3ad;
const YOKE = 0x5f666f;

const bodyMat = () => new THREE.MeshStandardMaterial({
  color: BODY, metalness: 0.65, roughness: 0.42,
});
const capMat = (c) => new THREE.MeshStandardMaterial({
  color: c, metalness: 0.25, roughness: 0.55,
});

/** Thickness of the coloured pole caps, as a fraction of the primitive. */
const CAP = 0.18;

/**
 * A block whose magnetisation does not run along its own axis. Colouring the
 * end caps would be a lie here, so the direction is shown as an explicit N/S
 * needle through the block instead.
 */
function obliqueBoxPrimitive(dims, mdir, sign) {
  const g = new THREE.Group();
  const { sx, sy, sz } = dims;
  g.add(new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, sz),
    new THREE.MeshStandardMaterial({
      color: BODY, metalness: 0.6, roughness: 0.45,
      transparent: true, opacity: 0.55,
    }),
  ));

  const m = new THREE.Vector3(mdir[0], mdir[1], mdir[2]).normalize();
  if (sign < 0) m.negate();
  const L = Math.min(sx, sy, sz) * 0.95;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), m);

  for (const side of [1, -1]) {
    const half = new THREE.Mesh(
      new THREE.CylinderGeometry(L * 0.13, L * 0.13, L * 0.5, 16),
      capMat(side > 0 ? NORTH : SOUTH),
    );
    half.position.y = side * L * 0.25;      // build along +Y, then rotate onto m
    const holder = new THREE.Group();
    holder.add(half);
    holder.quaternion.copy(q);
    g.add(holder);
  }
  return g;
}

function boxPrimitive(dims, sign) {
  const g = new THREE.Group();
  const { sx, sy, sz } = dims;
  const capH = Math.min(sz * CAP, 1.2);

  const core = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz - 2 * capH), bodyMat());
  g.add(core);

  // sign > 0 means magnetised along local +Z, so +Z is the north face.
  const nTop = sign > 0;
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, capH), capMat(nTop ? NORTH : SOUTH),
  );
  top.position.z = (sz - capH) * 0.5;
  const bot = new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, capH), capMat(nTop ? SOUTH : NORTH),
  );
  bot.position.z = -(sz - capH) * 0.5;
  g.add(top, bot);
  return g;
}

function cylinderPrimitive(dims, sign) {
  const g = new THREE.Group();
  const { radius, height } = dims;
  const capH = Math.min(height * CAP, 1.2);

  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height - 2 * capH, 48), bodyMat(),
  );
  core.rotation.x = Math.PI / 2; // three's cylinders run along Y; we want Z
  g.add(core);

  const nTop = sign > 0;
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, capH, 48),
      capMat((s > 0) === nTop ? NORTH : SOUTH),
    );
    m.rotation.x = Math.PI / 2;
    m.position.z = s * (height - capH) * 0.5;
    g.add(m);
  }
  return g;
}

function ringPrimitive(dims, sign) {
  const g = new THREE.Group();
  const { outerRadius: ro, innerRadius: ri, height } = dims;
  const capH = Math.min(height * CAP, 1.2);
  const hb = (height - 2 * capH) * 0.5;

  // A lathe of the rectangular cross-section gives a proper annular cylinder;
  // three has no primitive for one.
  const profile = [
    new THREE.Vector2(ri, -hb), new THREE.Vector2(ro, -hb),
    new THREE.Vector2(ro, hb), new THREE.Vector2(ri, hb),
    new THREE.Vector2(ri, -hb),
  ];
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), bodyMat());
  body.rotation.x = Math.PI / 2; // lathe spins about Y; the axis must be Z
  g.add(body);

  const nTop = sign > 0;
  for (const s of [1, -1]) {
    const cap = new THREE.Mesh(
      new THREE.LatheGeometry([
        new THREE.Vector2(ri, -capH / 2), new THREE.Vector2(ro, -capH / 2),
        new THREE.Vector2(ro, capH / 2), new THREE.Vector2(ri, capH / 2),
        new THREE.Vector2(ri, -capH / 2),
      ], 64),
      capMat((s > 0) === nTop ? NORTH : SOUTH),
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.z = s * (height - capH) * 0.5;
    g.add(cap);
  }
  return g;
}

function spherePrimitive(dims, sign) {
  const g = new THREE.Group();
  const r = dims.radius;
  // Two hemispheres, so the pole axis is readable at a glance.
  for (const side of [1, -1]) {
    const half = new THREE.Mesh(
      new THREE.SphereGeometry(r, 48, 24, 0, Math.PI * 2,
        side > 0 ? 0 : Math.PI / 2, Math.PI / 2),
      capMat((side > 0) === (sign > 0) ? NORTH : SOUTH),
    );
    half.rotation.x = Math.PI / 2; // three's poles are on Y; ours are on Z
    g.add(half);
  }
  return g;
}

/** Build (or rebuild) the mesh group for a magnet. */
export function buildMagnetMesh(magnet) {
  const group = new THREE.Group();
  group.name = `magnet:${magnet.id}`;

  for (const part of magnetParts(magnet)) {
    const prim = part.kind === 'box'
      ? (part.mdir
        ? obliqueBoxPrimitive(part.dims, part.mdir, part.sign)
        : boxPrimitive(part.dims, part.sign))
      : part.kind === 'sphere' ? spherePrimitive(part.dims, part.sign)
      : part.kind === 'ring' ? ringPrimitive(part.dims, part.sign)
      : cylinderPrimitive(part.dims, part.sign);
    prim.position.set(part.offset[0], part.offset[1], part.offset[2]);
    prim.quaternion.set(part.quat[0], part.quat[1], part.quat[2], part.quat[3]);
    group.add(prim);
  }

  // The horseshoe's yoke carries no charge in the model - it is drawn only so
  // the shape reads as a horseshoe.
  if (magnet.type === 'horseshoe') {
    const s = magnet.size;
    const yoke = new THREE.Mesh(
      new THREE.BoxGeometry(s.gap + 2 * s.legWidth, s.depth, s.yoke),
      new THREE.MeshStandardMaterial({ color: YOKE, metalness: 0.55, roughness: 0.5 }),
    );
    yoke.position.z = s.yoke * 0.5;
    group.add(yoke);
  }

  group.userData.magnetId = magnet.id;
  for (const child of group.children) child.userData.magnetId = magnet.id;
  syncMagnetMesh(group, magnet);
  return group;
}

/**
 * Fade the magnet proxies out. A magnet held over the nail necessarily sits
 * between the camera and the thing you are trying to look at, so being able to
 * ghost or hide it is not a luxury.
 */
export function setMagnetOpacity(group, opacity) {
  group.visible = group.userData.enabled !== false && opacity > 0.001;
  group.traverse((o) => {
    if (!o.material) return;
    o.material.transparent = opacity < 0.999;
    o.material.opacity = opacity;
    o.material.depthWrite = opacity > 0.5;
    o.material.needsUpdate = true;
  });
}

/** Push model transform onto the mesh. */
export function syncMagnetMesh(group, magnet) {
  group.position.set(magnet.position[0], magnet.position[1], magnet.position[2]);
  group.quaternion.set(
    magnet.quaternion[0], magnet.quaternion[1],
    magnet.quaternion[2], magnet.quaternion[3],
  );
  group.userData.enabled = magnet.enabled !== false;
  group.visible = magnet.enabled !== false;
}

/** Pull mesh transform back into the model (after a gizmo drag). */
export function readMagnetMesh(group, magnet) {
  magnet.position = [group.position.x, group.position.y, group.position.z];
  magnet.quaternion = [
    group.quaternion.x, group.quaternion.y, group.quaternion.z, group.quaternion.w,
  ];
}

/** A finger to give the nail some context. Purely decorative. */
export function buildFinger(nail, finger) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd8a98c, roughness: 0.72, metalness: 0.0,
  });
  // CapsuleGeometry's axis is already +Y, which IS the nail's length direction,
  // so this must NOT be rotated - rotating it onto Z stands the finger upright.
  // `length` is the cylindrical middle only; the two caps add a radius each.
  const mid = Math.max(0.1, finger.length - 2 * finger.radius);
  const cyl = new THREE.Mesh(
    new THREE.CapsuleGeometry(finger.radius, mid, 12, 48), mat,
  );
  cyl.position.set(finger.offset[0], finger.offset[1], finger.offset[2]);
  g.add(cyl);

  g.position.set(nail.position[0], nail.position[1], nail.position[2]);
  g.quaternion.set(
    nail.quaternion[0], nail.quaternion[1], nail.quaternion[2], nail.quaternion[3],
  );
  return g;
}
