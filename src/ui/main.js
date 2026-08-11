// Application shell: scene, gizmos, GUI, and the solve scheduler.
//
// Rendering runs at display rate; the field solve does not. Every change marks
// the scene dirty and the solve happens at most once per frame - at a reduced
// nail resolution while something is being dragged, then again at full
// resolution once the drag settles. See scheduleSolve().

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import GUI from 'lil-gui';

import {
  createMagnet, MAGNET_TYPES, defaultSize, insideAnyMagnet, WIRE_SHAPES,
} from '../core/magnet.js';
import {
  createNail, buildNailGrid, fingerFor, nailCentre, fingerClearanceAll,
} from '../core/nail.js';
import { buildFaces, streamline } from '../core/field.js';
import { solveSoftIron, voxelize, SOFT_IRON } from '../core/softIron.js';
import { computeFinish, sampleGrid, DEFAULT_FINISH } from '../core/finish.js';
import { PRESETS, PRESET_KEYS } from '../core/presets.js';
import { TECHNIQUES, TECHNIQUE_KEYS } from '../core/techniques.js';
import { findSnap } from '../core/snap.js';
import { lightPosition, lightParamAt, stepLight } from '../core/lightPath.js';
import {
  createFlakes, resetFlakes, stepFlakes, viscosityAt, alignTime, DEFAULT_POLISH,
} from '../core/dynamics.js';
import {
  posedMagnets, MOTION_KINDS, defaultMotion, unposeMagnet, nailFrame,
} from '../core/motion.js';

import { createNailMaterial, CHANNELS } from './nailMaterial.js';
import {
  buildMagnetMesh, syncMagnetMesh, readMagnetMesh, buildFinger, setMagnetOpacity,
} from './magnetView.js';
import { drawUnwrapped } from './unwrap.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  nail: null,
  magnets: [],
  finish: { ...DEFAULT_FINISH },
  look: {
    baseColor: '#121a2e',
    sheenColor: '#bfd4ff',
    flakeColor: '#2a3550',
    sheenExp: 42,
    sheenGain: 1.5,
    coverPow: 2.2,
    coverage: 0.95,
    ambient: 0.10,
    clearcoat: 0.35,
    roughness: 0.16,
    glitter: 0.22,
    channel: 'shaded',
  },
  light: {
    intensity: 1.0,
    color: '#ffffff',
    distance: 62,
    height: 38,
    // Radians from the free edge (+Y). 0 = in front of the tip, +/-pi = behind
    // the cuticle, +/-pi/2 = out to the sides.
    azimuth: 2.2,
    auto: true,
    // 'sweep' rocks along an arc, 'orbit' circles the nail, 'linear' travels
    // along a straight line at fixed height.
    mode: 'linear',
    speed: 0.5,
    sweep: 2.4,     // half-arc of the arc sweep, radians
    centre: 0,      // the angle the arc sweep rocks about
    phase: 0,
    // Linear mode. lineAngle 0 travels along +X (across the nail); lineOffset
    // shifts the whole line sideways, so 0 passes directly overhead.
    lineAngle: 0,
    lineOffset: 0,
    travel: 70,     // half-length of the line, mm
    linearT: 0,     // manual position along the line, -1..1
    showPath: true,
  },
  view: {
    resU: 96,
    resV: 64,
    dragResU: 44,
    dragResV: 30,
    // While the clock runs the grid is re-solved AND the ensembles stepped
    // every frame, so the useful resolution is lower than for a still scene.
    // It is a separate setting rather than a reuse of the drag resolution
    // because changing it mid-take restarts the coat.
    liveResU: 64,
    liveResV: 44,
    showFieldLines: false,
    fieldLineCount: 14,
    snap: true,
    magnetOpacity: 1,
    unwrapView: 'head-on',   // 'head-on' | 'camera'
    showFinger: true,
    unwrapChannel: 'shaded',
  },
  preset: 'catEye',

  // Polish rheology. See dynamics.js - these are the knobs that decide whether
  // a moving tool leaves a mark or not.
  polish: { ...DEFAULT_POLISH },

  // The clock. `live` off means the static steady-state model, which is what
  // the sandbox has always done and is still the right answer for a tool held
  // still. Turn it on and the pile has to get there in finite time.
  sim: {
    live: false,
    running: false,
    t: 0,          // seconds since the coat went on
    // When the hand picked the tool up. There are TWO clocks and they are not
    // the same: the polish ages from when the coat went on, while a technique's
    // moves are written from when it starts ("lift the bar off at 2 s"). A
    // technique that begins three minutes into the drying curve must still run
    // its own schedule from zero.
    startTime: 0,
    speed: 1,      // clock multiplier, so you need not wait three real minutes
    perTexel: 16,  // flakes in each texel's ensemble
    technique: 'none',
  },
};

let grid = null;
let finish = null;
let flakes = null;
let solveRes = null;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const viewEl = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
viewEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f13);

const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 4000);
camera.up.set(0, 0, 1); // world +Z is up throughout the physics core
// Framed for a ~16 mm nail: closer than it looks like it should be, because
// the scene is measured in millimetres.
camera.position.set(23, -31, 25);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 0, 0);

// Ambient fill for the magnet/finger meshes (the nail has its own shader).
scene.add(new THREE.HemisphereLight(0x8fa6c8, 0x191b22, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(keyLight);

// The movable light, shown as a small sphere.
const lightGizmo = new THREE.Mesh(
  new THREE.SphereGeometry(1.6, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0xffe9b0 }),
);
scene.add(lightGizmo);

// The track the light travels, drawn so the mode is obvious at a glance.
// Preallocated and updated in place - rebuilding a BufferGeometry every frame
// would leak GPU buffers.
const PATH_N = 128;
const lightPathGeo = new THREE.BufferGeometry();
lightPathGeo.setAttribute(
  'position', new THREE.BufferAttribute(new Float32Array(PATH_N * 3), 3),
);
const lightPath = new THREE.Line(lightPathGeo, new THREE.LineBasicMaterial({
  color: 0xb59a5c, transparent: true, opacity: 0.45,
}));
scene.add(lightPath);

function updateLightPath(L, c) {
  lightPath.visible = !!L.showPath;
  if (!lightPath.visible) return;
  const arr = lightPathGeo.attributes.position.array;
  for (let i = 0; i < PATH_N; i++) {
    const u = (i / (PATH_N - 1)) * 2 - 1;
    const p = lightPosition(L, c, lightParamAt(L, u));
    arr[i * 3] = p[0];
    arr[i * 3 + 1] = p[1];
    arr[i * 3 + 2] = p[2];
  }
  lightPathGeo.attributes.position.needsUpdate = true;
  lightPathGeo.computeBoundingSphere();
}

const grid3 = new THREE.GridHelper(120, 24, 0x2a2f3a, 0x1c2029);
grid3.rotation.x = Math.PI / 2; // GridHelper is XZ; we work in XY-up-Z
scene.add(grid3);

const nailMat = createNailMaterial();
let nailMesh = null;
let fingerMesh = null;
const magnetMeshes = new Map(); // id -> Group
const fieldLineGroup = new THREE.Group();
scene.add(fieldLineGroup);

// ---------------------------------------------------------------------------
// Gizmos and selection
// ---------------------------------------------------------------------------

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSpace('world');
gizmo.setSize(0.8);
// r169+ separates the controls object from its helper.
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

let selected = null; // {kind:'magnet'|'nail', id}
let dragging = false;
let resumeAfterDrag = false;

/** Is this tool being driven by a script right now, rather than sitting still? */
function isScripted(m) {
  return !!(state.sim.live && m?.motion && m.motion.kind !== 'still');
}

/** Technique-local time, which is what every motion is a function of. */
function motionTime() {
  return Math.max(0, state.sim.t - state.sim.startTime);
}

gizmo.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  dragging = e.value;
  const m = selected?.kind === 'magnet'
    ? state.magnets.find((x) => x.id === selected.id) : null;

  if (e.value) {
    // A scripted tool does not stop moving just because you grabbed it: the
    // orbit carries on and slides the magnet out from under the pointer. Hold
    // the clock for the length of the drag and put it back afterwards.
    resumeAfterDrag = state.sim.running && isScripted(m);
    if (resumeAfterDrag) state.sim.running = false;
    return;
  }

  // Drag finished: apply snapping, then resolve at full resolution.
  // Snapping is skipped for a scripted tool - findSnap works in authored
  // coordinates, but what you just dragged was the posed magnet, so a snap
  // would clip it to a neighbour it is not actually touching on screen.
  // Alt suppresses it for this drop only, so free placement never means
  // hunting for a checkbox first and remembering to put it back.
  if (m && state.view.snap && !altHeld && !isScripted(m)) {
    const s = findSnap(m, state.magnets);
    if (s) {
      m.position = s.position;
      m.quaternion = s.quaternion;
      syncMagnetMesh(magnetMeshes.get(m.id), m);
    }
  }
  if (resumeAfterDrag) { state.sim.running = true; resumeAfterDrag = false; }
  markDirty();
});

gizmo.addEventListener('objectChange', () => {
  if (!selected) return;
  if (selected.kind === 'magnet') {
    const m = state.magnets.find((x) => x.id === selected.id);
    readMagnetMesh(gizmo.object, m);
    // What the gizmo just reported is the POSED pose, because that is where the
    // mesh was parked. Convert it back to the authored one, or the script adds
    // its offset on top again next solve - once per frame, compounding.
    if (isScripted(m)) {
      const base = unposeMagnet(
        m.motion, motionTime(), nailFrame(state.nail), m.position, m.quaternion,
      );
      m.position = base.position;
      m.quaternion = base.quaternion;
    }
  } else {
    state.nail.position = [gizmo.object.position.x, gizmo.object.position.y, gizmo.object.position.z];
    state.nail.quaternion = [
      gizmo.object.quaternion.x, gizmo.object.quaternion.y,
      gizmo.object.quaternion.z, gizmo.object.quaternion.w,
    ];
    rebuildNailGeometry();
  }
  markDirty();
});

// A stand-in object the nail gizmo drives (the nail mesh itself is baked into
// world space, so it cannot carry the transform).
const nailProxy = new THREE.Object3D();
scene.add(nailProxy);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});

/** What is under this screen point? Returns a selection, or null for empty space. */
function pickAt(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = [...magnetMeshes.values()];
  if (nailMesh) targets.push(nailMesh);
  const hits = raycaster.intersectObjects(targets, true);
  if (!hits.length) return null;

  let o = hits[0].object;
  while (o && o.userData.magnetId === undefined && o !== nailMesh) o = o.parent;
  if (o === nailMesh) return { kind: 'nail' };
  if (o) return { kind: 'magnet', id: o.userData.magnetId };
  return null;
}

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4 || dragging) return; // that was an orbit, not a click
  if (e.button !== 0) return;        // the right button opens the menu instead
  select(pickAt(e.clientX, e.clientY));
});

function select(sel) {
  selected = sel;
  if (!sel) {
    gizmo.detach();
  } else if (sel.kind === 'magnet') {
    gizmo.attach(magnetMeshes.get(sel.id));
  } else {
    const n = state.nail;
    nailProxy.position.set(n.position[0], n.position[1], n.position[2]);
    nailProxy.quaternion.set(n.quaternion[0], n.quaternion[1], n.quaternion[2], n.quaternion[3]);
    gizmo.attach(nailProxy);
  }
  refreshMagnetFolder();
}

// Modifiers are read from the live keyboard rather than from the drag events,
// because TransformControls forwards neither - and because it lets you decide
// mid-drag rather than before it.
//
//   Alt   drop this one placement without magnet-to-magnet snapping
//   Ctrl  constrain to round numbers: 15 degrees, or 1 mm
//
// The two are deliberately opposites: Alt turns a snap off, Ctrl turns one on.
const ROTATION_STEP_DEG = 15;
const TRANSLATION_STEP_MM = 1;

let altHeld = false;
let ctrlHeld = false;

function applyGizmoSnap() {
  gizmo.translationSnap = ctrlHeld ? TRANSLATION_STEP_MM : null;
  gizmo.rotationSnap = ctrlHeld ? (ROTATION_STEP_DEG * Math.PI) / 180 : null;
}

function readModifiers(e) {
  altHeld = e.altKey;
  ctrlHeld = e.ctrlKey || e.metaKey;
  applyGizmoSnap();
}

addEventListener('keydown', readModifiers, true);
addEventListener('keyup', readModifiers, true);
// Alt-Tab away and back and the keyup never arrives, leaving a modifier stuck
// on for good. Any loss of focus clears both.
addEventListener('blur', () => {
  altHeld = false; ctrlHeld = false; applyGizmoSnap();
});

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'w' || e.key === 'W') gizmo.setMode('translate');
  if (e.key === 'e' || e.key === 'E') gizmo.setMode('rotate');
  if (e.key === 'h' || e.key === 'H') toggleFreeHand();
  if (e.key === 'Delete') removeMagnet(currentMagnet());
  if (e.key === 'Escape') {
    if (ctxEl.classList.contains('on')) closeContextMenu();
    else if (freeHand.on) setFreeHand(false);
    else select(null);
  }
});

// ---------------------------------------------------------------------------
// Context menu
//
// Reaching for a magnet in the side panel means finding it in a list, opening
// its folder and then finding the action - which is three steps too many for
// "delete this one". The menu puts the actions on the object itself.
// ---------------------------------------------------------------------------

const ctxEl = document.getElementById('ctx');
let rightDownAt = null;

function closeContextMenu() {
  ctxEl.classList.remove('on');
}

/** The actions that make sense for whatever was right-clicked. */
function contextItemsFor(hit) {
  if (hit?.kind === 'magnet') {
    const m = state.magnets.find((x) => x.id === hit.id);
    if (!m) return null;
    const off = m.enabled === false;
    return [
      { hdr: m.name || m.type },
      { label: 'Move', key: 'W', run: () => gizmo.setMode('translate') },
      { label: 'Rotate', key: 'E', run: () => gizmo.setMode('rotate') },
      { sep: true },
      { label: 'Duplicate', run: () => duplicateMagnet(m) },
      { label: 'Flip N–S', run: () => setMagnetFlipped(m, !m.flip) },
      { label: off ? 'Enable' : 'Disable', run: () => setMagnetEnabled(m, off) },
      { sep: true },
      { label: 'Delete', key: 'Del', danger: true, run: () => removeMagnet(m) },
    ];
  }
  if (hit?.kind === 'nail') {
    return [
      { hdr: 'Nail' },
      { label: 'Move', key: 'W', run: () => gizmo.setMode('translate') },
      { label: 'Rotate', key: 'E', run: () => gizmo.setMode('rotate') },
      { sep: true },
      { label: 'Add magnet', run: addMagnet },
    ];
  }
  return [
    { hdr: 'Scene' },
    { label: 'Add magnet', run: addMagnet },
    { sep: true },
    { label: 'Deselect', key: 'Esc', run: () => select(null) },
  ];
}

function openContextMenu(clientX, clientY) {
  const hit = pickAt(clientX, clientY);
  const items = contextItemsFor(hit);
  if (!items) { closeContextMenu(); return; }
  select(hit); // the menu acts on what it points at, so show that as selected

  ctxEl.replaceChildren();
  for (const it of items) {
    if (it.sep) {
      ctxEl.append(Object.assign(document.createElement('div'), { className: 'sep' }));
    } else if (it.hdr) {
      ctxEl.append(Object.assign(document.createElement('div'), {
        className: 'hdr', textContent: it.hdr,
      }));
    } else {
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      b.append(Object.assign(document.createElement('span'), { textContent: it.label }));
      if (it.key) {
        b.append(Object.assign(document.createElement('span'), {
          className: 'k', textContent: it.key,
        }));
      }
      b.addEventListener('click', () => { closeContextMenu(); it.run(); });
      ctxEl.append(b);
    }
  }

  // Show it before measuring, then keep it inside the viewport - a menu opened
  // near the right edge would otherwise run under the side panel.
  ctxEl.classList.add('on');
  const vr = document.getElementById('view').getBoundingClientRect();
  const mr = ctxEl.getBoundingClientRect();
  const x = Math.min(clientX - vr.left + 2, vr.width - mr.width - 6);
  const y = Math.min(clientY - vr.top + 2, vr.height - mr.height - 6);
  ctxEl.style.left = `${Math.max(6, x)}px`;
  ctxEl.style.top = `${Math.max(6, y)}px`;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 2) rightDownAt = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // A right-DRAG is OrbitControls panning the camera, not a request for a menu.
  const moved = rightDownAt
    ? Math.hypot(e.clientX - rightDownAt.x, e.clientY - rightDownAt.y) : 0;
  rightDownAt = null;
  if (moved > 4) return;
  openContextMenu(e.clientX, e.clientY);
});

// Anything else the pointer does dismisses it. Capture phase, so the menu is
// gone before a click on the canvas underneath is acted on.
addEventListener('pointerdown', (e) => {
  if (!ctxEl.contains(e.target)) closeContextMenu();
}, true);
addEventListener('wheel', closeContextMenu, { passive: true });
addEventListener('blur', closeContextMenu);

// ---------------------------------------------------------------------------
// Free hand
//
// The gizmo is a CAD idiom: grab an axis, drag along it, let go. That is the
// wrong shape for a tool you are trying to learn the feel of. Here the magnet
// simply follows the pointer, in the nail's own plane, with the clock running -
// so the pile answers while you move rather than after you drop.
//
// The clock is the point. Held still, the finish is whatever the static solve
// says and the path you took to get there is irrelevant; running, the pile
// lags, and how fast you swept starts to matter. That is the thing worth
// building muscle memory for.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Soft iron in the scene
//
// An iron body is stored as an ordinary magnet carrying `iron: true`, so
// selection, the gizmo, the context menu and the finger-clearance check all
// work on it unchanged. What differs is where its field comes from: it is
// excluded from the prescribed sources and solved instead, from whatever the
// real magnets are doing to it.
//
// Two things make that affordable. The solve is dense and cubic in the cell
// count, so it is cached against a signature of every pose that can affect it
// and only redone when one moves; and the dicing is coarsened automatically
// until the cell count is inside a budget, because a body diced at 1 mm is a
// second of arithmetic and nothing here is worth a second.
// ---------------------------------------------------------------------------

const IRON_CELL_BUDGET = 260;
let ironCache = { key: null, faces: [], info: null };

/** The dicing pitch that keeps a body inside the budget, coarsening if need be. */
function affordableCellSize(body, bodyCount = 1) {
  // The budget is on the WHOLE solve, which is cubic in the total cell count -
  // so several bodies each get a share of it, not a copy of it.
  const budget = Math.max(24, Math.floor(IRON_CELL_BUDGET / bodyCount));
  let cell = Math.max(0.4, body.cellSize ?? 2.5);
  for (let i = 0; i < 12; i++) {
    const n = voxelize(body, cell).centers.length;
    if (n <= budget) return { cell, cells: n };
    cell *= 1.25;
  }
  return { cell, cells: voxelize(body, cell).centers.length };
}

function solveIron(sources, posed) {
  const irons = posed.filter((m) => m.iron && m.enabled !== false);
  if (!irons.length) {
    ironCache = { key: null, faces: [], info: null };
    return [];
  }
  // Everything that can change the answer, and nothing that cannot - so
  // orbiting the camera or sweeping the light never triggers a re-solve.
  const key = JSON.stringify([
    sources.map((m) => [m.type, m.size, m.position, m.quaternion, m.Br, m.flip]),
    irons.map((m) => [m.type, m.size, m.position, m.quaternion, m.cellSize]),
  ]);
  if (key === ironCache.key) return ironCache.faces;

  const t0 = performance.now();
  const srcFaces = buildFaces(sources);

  // All the iron goes into ONE solve. Solving each body on its own would drop
  // the coupling between them, and that coupling is the entire mechanism of a
  // shaped tool: a bent wire is several pieces of iron whose whole point is
  // that they carry each other's flux around a corner.
  let cell = 0;
  let coarsened = false;
  for (const body of irons) {
    const a = affordableCellSize(body, irons.length);
    cell = Math.max(cell, a.cell);
    if (a.cell > (body.cellSize ?? 2.5) * 1.001) coarsened = true;
  }
  const sol = solveSoftIron(irons, srcFaces, { cellSize: cell });
  const faces = sol.faces;
  const cells = sol.cells;
  const saturated = sol.saturated;
  ironCache = {
    key,
    faces,
    info: { cells, saturated, coarsened, ms: performance.now() - t0 },
  };
  return faces;
}

const freeHand = { on: false, id: null, standoff: 0 };
const fhPlane = new THREE.Plane();
const fhHit = new THREE.Vector3();
const fhBadge = document.getElementById('freehand');

function setFreeHand(on) {
  const m = currentMagnet();
  if (on && !m) return; // nothing to hold
  freeHand.on = on;
  freeHand.id = on ? m.id : null;

  if (on) {
    // Height above the plate is held constant while the pointer steers, and is
    // whatever the tool was already at - so entering the mode never jumps it.
    const f = nailFrame(state.nail);
    const d = [
      m.position[0] - f.origin[0], m.position[1] - f.origin[1], m.position[2] - f.origin[2],
    ];
    freeHand.standoff = d[0] * f.z[0] + d[1] * f.z[1] + d[2] * f.z[2];
    // A hand-driven take only means anything against a clock.
    state.sim.live = true;
    state.sim.running = true;
    gizmo.detach();
  } else if (selected?.kind === 'magnet') {
    const mesh = magnetMeshes.get(selected.id);
    if (mesh) gizmo.attach(mesh);
  }

  orbit.enabled = !on; // or every sweep would also swing the camera
  fhBadge.classList.toggle('on', on);
  markDirty();
}

function toggleFreeHand() { setFreeHand(!freeHand.on); }

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!freeHand.on) return;
  const m = state.magnets.find((x) => x.id === freeHand.id);
  if (!m) { setFreeHand(false); return; }

  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  // Steer in the plane parallel to the nail at the held standoff, so the tool
  // sweeps ACROSS the plate rather than diving into the finger.
  const f = nailFrame(state.nail);
  const n = new THREE.Vector3(f.z[0], f.z[1], f.z[2]);
  const p = new THREE.Vector3(
    f.origin[0] + f.z[0] * freeHand.standoff,
    f.origin[1] + f.z[1] * freeHand.standoff,
    f.origin[2] + f.z[2] * freeHand.standoff,
  );
  fhPlane.setFromNormalAndCoplanarPoint(n, p);
  if (!raycaster.ray.intersectPlane(fhPlane, fhHit)) return;

  m.position = [fhHit.x, fhHit.y, fhHit.z];
  syncMagnetMesh(magnetMeshes.get(m.id), m);
  markDirty();
});

// The wheel raises and lowers the tool instead of zooming, which is the axis
// the pointer cannot supply and the one that decides how sharp the line is.
renderer.domElement.addEventListener('wheel', (e) => {
  if (!freeHand.on) return;
  e.preventDefault();
  freeHand.standoff = Math.max(1, freeHand.standoff + (e.deltaY > 0 ? 0.8 : -0.8));
  markDirty();
}, { passive: false });

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function rebuildNailGeometry(res) {
  solveRes = res ?? solveRes ?? { u: state.view.resU, v: state.view.resV };
  grid = buildNailGrid({ ...state.nail, resU: solveRes.u, resV: solveRes.v });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(grid.position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(grid.normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(grid.uv, 2));
  geo.setAttribute('aChain', new THREE.BufferAttribute(new Float32Array(grid.count * 3), 3));
  geo.setAttribute('aTilt', new THREE.BufferAttribute(new Float32Array(grid.count), 1));
  geo.setAttribute('aConc', new THREE.BufferAttribute(new Float32Array(grid.count), 1));
  geo.setAttribute('aOrder', new THREE.BufferAttribute(new Float32Array(grid.count), 1));
  geo.setAttribute('aBnorm', new THREE.BufferAttribute(new Float32Array(grid.count), 1));
  geo.setIndex(new THREE.BufferAttribute(grid.index, 1));

  if (nailMesh) { scene.remove(nailMesh); nailMesh.geometry.dispose(); }
  nailMesh = new THREE.Mesh(geo, nailMat);
  nailMesh.name = 'nail';
  scene.add(nailMesh);

  if (fingerMesh) scene.remove(fingerMesh);
  fingerMesh = buildFinger(state.nail, fingerFor(state.nail));
  fingerMesh.visible = state.view.showFinger;
  scene.add(fingerMesh);
}

function rebuildMagnetMeshes() {
  for (const [id, mesh] of magnetMeshes) {
    if (!state.magnets.some((m) => m.id === id)) {
      scene.remove(mesh);
      magnetMeshes.delete(id);
    }
  }
  for (const m of state.magnets) {
    const old = magnetMeshes.get(m.id);
    if (old) scene.remove(old);
    const mesh = buildMagnetMesh(m);
    scene.add(mesh);
    magnetMeshes.set(m.id, mesh);
  }
  applyMagnetOpacity();
  if (selected?.kind === 'magnet') {
    const mesh = magnetMeshes.get(selected.id);
    if (mesh) gizmo.attach(mesh); else select(null);
  }
}

function applyMagnetOpacity() {
  for (const mesh of magnetMeshes.values()) {
    setMagnetOpacity(mesh, state.view.magnetOpacity);
  }
}

// ---------------------------------------------------------------------------
// Solve scheduling
// ---------------------------------------------------------------------------

let dirty = true;
let settleTimer = null;

function markDirty() {
  dirty = true;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { solveRes = null; dirty = true; }, 140);
}

/**
 * The magnet list as it stands right now: authored poses with each tool's
 * scripted motion applied, and tools that are not currently in the hand
 * dropped. With the clock off this is just the authored list.
 */
function liveMagnets() {
  if (!state.sim.live) return state.magnets;
  // Technique-local time, not polish time - see state.sim.startTime.
  return posedMagnets(
    state.magnets, state.nail, Math.max(0, state.sim.t - state.sim.startTime),
  );
}

/**
 * Ensure the flake ensembles match the current grid. Changing the solve
 * resolution changes how many texels there are, and the ensembles are per
 * texel, so they have to be rebuilt - which necessarily restarts the coat.
 * That is why the resolution is pinned while the clock runs.
 */
function syncFlakes() {
  if (!state.sim.live) return;
  if (!flakes || flakes.count !== grid.count
      || flakes.perTexel !== state.sim.perTexel) {
    flakes = createFlakes(grid, {
      perTexel: state.sim.perTexel, kSpread: state.polish.kSpread,
    });
    flakes.t = state.sim.t;
  }
}

let simDt = 0; // seconds of polish time to advance on the next solve

function solve() {
  // While the clock runs the resolution stays put: dropping it mid-take would
  // throw away the ensembles and restart the coat halfway through a technique.
  const wantDrag = dragging && !state.sim.running;
  const res = state.sim.live
    ? { u: state.view.liveResU, v: state.view.liveResV }
    : wantDrag
      ? { u: state.view.dragResU, v: state.view.dragResV }
      : { u: state.view.resU, v: state.view.resV };

  if (!grid || solveRes?.u !== res.u || solveRes?.v !== res.v) rebuildNailGeometry(res);

  const t0 = performance.now();
  const posed = liveMagnets();
  const sources = posed.filter((m) => !m.iron && m.enabled !== false);
  const faces = buildFaces(sources).concat(solveIron(sources, posed));

  // Show the tool where the script is holding it, and hide the ones that are
  // not currently in the hand - otherwise a technique reads as magic.
  if (state.sim.live) {
    const held = new Set(posed.map((m) => m.id));
    for (const m of state.magnets) {
      const mesh = magnetMeshes.get(m.id);
      if (!mesh) continue;
      const p = posed.find((x) => x.id === m.id);
      mesh.visible = !!p && m.enabled !== false;
      if (p) {
        mesh.position.set(...p.position);
        mesh.quaternion.set(...p.quaternion);
      }
      if (!held.has(m.id) && selected?.id === m.id) gizmo.detach();
    }
  }

  let params = state.finish;
  if (state.sim.live) {
    syncFlakes();
    // Sample B once, advance the ensembles through it, then read the geometry
    // off the pile that actually exists rather than off the field it is
    // chasing. The field is handed back to computeFinish so it is not sampled
    // a second time.
    const field = sampleGrid(grid, faces);
    flakes.t = state.sim.t;
    stepFlakes(flakes, grid, field.B, field.bmag, state.polish, simDt);
    params = {
      ...state.finish, field, director: flakes.director, order: flakes.order,
    };
  }
  simDt = 0;

  finish = computeFinish(grid, faces, params);
  const ms = performance.now() - t0;

  // Push per-texel results into the shader attributes.
  const g = nailMesh.geometry;
  g.attributes.aChain.array.set(finish.chain);
  g.attributes.aTilt.array.set(finish.tilt);
  g.attributes.aConc.array.set(finish.conc);
  g.attributes.aOrder.array.set(finish.order);

  const span = finish.stats.max - finish.stats.min;
  const bn = g.attributes.aBnorm.array;
  for (let i = 0; i < grid.count; i++) {
    bn[i] = span > 1e-12 ? (finish.bmag[i] - finish.stats.min) / span : 0;
  }

  for (const k of ['aChain', 'aTilt', 'aConc', 'aOrder', 'aBnorm']) {
    g.attributes[k].needsUpdate = true;
  }

  updateReadouts(ms, faces, posed);
  updateFieldLines(faces, posed);
  redrawUnwrapped();
  dirty = false;
}

// ---------------------------------------------------------------------------
// Field lines (optional, for understanding the geometry)
// ---------------------------------------------------------------------------

function updateFieldLines(faces, posed = state.magnets) {
  fieldLineGroup.clear();
  if (!state.view.showFieldLines || !posed.length) return;

  const c = nailCentre(state.nail);
  const n = state.view.fieldLineCount;
  const mat = new THREE.LineBasicMaterial({ color: 0x6ee7b7, transparent: true, opacity: 0.55 });

  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5) * state.nail.width * 1.35;
    const seed = [
      c.p[0] + t + c.n[0] * 1.5,
      c.p[1] + c.n[1] * 1.5,
      c.p[2] + c.n[2] * 1.5,
    ];
    const pts = [];
    for (const dir of [1, -1]) {
      const r = streamline(faces, seed, {
        dir, step: 0.8, maxSteps: 260, bound: 140, tol: 1e-4,
        stop: (p) => insideAnyMagnet(posed, p, 0.05),
      });
      const seq = dir === 1 ? r.points : r.points.slice().reverse();
      if (dir === -1) pts.unshift(...seq); else pts.push(...seq);
    }
    if (pts.length < 2) continue;
    const geo = new THREE.BufferGeometry().setFromPoints(
      pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    );
    fieldLineGroup.add(new THREE.Line(geo, mat));
  }
}

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

const readoutsEl = document.getElementById('readouts');
const statusEl = document.getElementById('status');

const mT = (t) => `${(t * 1000).toFixed(1)} mT`;

/** Human phrasing for a response time, which is the number that matters most. */
function regimeOf(tau) {
  if (!Number.isFinite(tau)) return 'set — nothing moves';
  if (tau < 0.05) return 'instant — only where you finish matters';
  if (tau < 0.5) return 'quick — fast moves start to smear';
  if (tau < 5) return 'laggy — the working window';
  return 'sluggish — almost set';
}

const secs = (t) => (t < 60 ? `${t.toFixed(1)} s` : `${Math.floor(t / 60)}m ${(t % 60).toFixed(0)}s`);

function updateReadouts(ms, faces, posed = state.magnets) {
  const s = finish.stats;
  const focal = Number.isFinite(s.focalLength) && Math.abs(s.focalLength) < 1e4
    ? `${s.focalLength.toFixed(1)} mm` : '—';
  const sweep = s.fanKind === 'convex' ? 'tracks light'
    : s.fanKind === 'concave' ? 'counter-tracks' : 'static';

  const rows = [
    ['|B| at centre', mT(s.centre)],
    ['|B| min / max', `${mT(s.min)} / ${mT(s.max)}`],
    ['|B| mean', mT(s.mean)],
    ['spread', `${s.spreadPct.toFixed(1)} %`],
    ['mean tilt from normal', `${s.meanTilt.toFixed(1)}°`],
    ['tilt spread (1σ)', `${s.tiltSpread.toFixed(1)}°`],
    ['mean alignment order', s.meanOrder.toFixed(3)],
    ['pile parallelism', `${s.chainSpread.toFixed(1)}° spread (${
      s.chainSpread < 12 ? 'velvet-like' : s.chainSpread < 30 ? 'soft' : 'patterned'})`],
    ['fibre fan', `${s.fanKind} (${s.fanGradient.toFixed(2)}°/mm)`],
    ['equivalent focal length', focal],
    ['sheen under moving light', sweep],
  ];

  if (state.sim.live) {
    const eta = viscosityAt(state.polish, state.sim.t);
    // Quote the response time at the field the nail is actually in, not at
    // some nominal value: it goes as 1/B^2, so it differs hugely between a
    // wand pressed against the plate and one held back.
    const tau = alignTime(state.polish, eta, Math.max(1e-6, s.mean));
    const set = !(eta < state.polish.setViscosity);
    rows.push(
      ['— polish clock —', ''],
      ['elapsed', `${secs(state.sim.t)}${state.sim.running ? '' : ' (paused)'}`],
      ['viscosity', set ? 'SET' : `${eta < 10 ? eta.toFixed(2) : eta.toFixed(0)} Pa·s`],
      ['pile response time', set ? '—' : `${tau < 1 ? `${(tau * 1000).toFixed(1)} ms` : `${tau.toFixed(2)} s`}`],
      ['regime', regimeOf(set ? Infinity : tau)],
    );
  }

  // A tool inside the finger is not a rendering nuisance, it is an
  // arrangement that cannot be built - so say so where it cannot be missed.
  const clear = fingerClearanceAll(state.nail, posed);
  if (state.view.showFinger && Number.isFinite(clear) && clear < 0) {
    rows.push(['⚠ tool inside the finger', `${(-clear).toFixed(1)} mm deep`]);
  }

  readoutsEl.innerHTML = rows
    .map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');

  const ir = ironCache.info;
  statusEl.textContent =
    `${grid.count} texels · ${faces.length} pole faces · solved in ${ms.toFixed(1)} ms`
    + (state.sim.live ? ` · ${flakes.perTexel} flakes/texel` : '')
    // The iron solve is cached, so its cost is reported separately - it is not
    // part of the per-frame number above and saying otherwise would mislead.
    + (ir ? ` · iron: ${ir.cells} cells in ${ir.ms.toFixed(0)} ms`
      + (ir.saturated ? `, ${ir.saturated} saturated` : '')
      + (ir.coarsened ? ', dicing coarsened to fit' : '') : '');
}

// ---------------------------------------------------------------------------
// Unwrapped view
// ---------------------------------------------------------------------------

const unwrapCanvas = document.getElementById('unwrap');
const unwrapLabel = document.getElementById('unwrapLabel');

const hexToLin = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

function redrawUnwrapped() {
  if (!finish) return;
  const rect = unwrapCanvas.getBoundingClientRect();
  if (rect.width && unwrapCanvas.width !== Math.round(rect.width)) {
    unwrapCanvas.width = Math.round(rect.width);
  }
  drawUnwrapped(unwrapCanvas, grid, finish, {
    channel: state.view.unwrapChannel,
    lightPos: [lightGizmo.position.x, lightGizmo.position.y, lightGizmo.position.z],
    viewPos: state.view.unwrapView === 'camera'
      ? [camera.position.x, camera.position.y, camera.position.z] : null,
    base: hexToLin(state.look.baseColor),
    sheen: hexToLin(state.look.sheenColor),
    flake: hexToLin(state.look.flakeColor),
    sheenExp: state.look.sheenExp,
    sheenGain: state.look.sheenGain,
    coverPow: state.look.coverPow,
    coverage: state.look.coverage,
    concStrength: state.finish.concStrength,
    ambient: state.look.ambient,
  });
  unwrapLabel.textContent = state.view.unwrapChannel !== 'shaded'
    ? `Channel: ${state.view.unwrapChannel}. Free edge at top.`
    : state.view.unwrapView === 'camera'
      ? 'Shaded from the real camera - matches the 3D view, flattened out.'
      : 'Head-on: eye directly over EVERY texel, so viewing angle is removed '
        + 'and only the pattern in the pile shows. Free edge at top.';
}

// ---------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------

function updateLight(dt) {
  const L = state.light;

  // Azimuth is measured from the free edge: 0 puts the light straight out in
  // front of the nail tip, +/-pi puts it behind the cuticle. It must be able to
  // reach every one of those - an earlier version squashed the orbit into a
  // half ellipse on the cuticle side, so the light could never get in front of
  // the free edge at all.
  const c = nailCentre(state.nail).p;
  const [x, y, z] = lightPosition(L, c, stepLight(L, dt));
  updateLightPath(L, c);

  lightGizmo.position.set(x, y, z);
  keyLight.position.set(x, y, z);
  nailMat.uniforms.uLightPos.value.set(x, y, z);
}

// ---------------------------------------------------------------------------
// Material sync
// ---------------------------------------------------------------------------

function syncMaterial() {
  const u = nailMat.uniforms;
  const k = state.look;
  u.uBaseColor.value.set(k.baseColor).convertSRGBToLinear();
  u.uSheenColor.value.set(k.sheenColor).convertSRGBToLinear();
  u.uFlakeColor.value.set(k.flakeColor).convertSRGBToLinear();
  u.uLightColor.value.set(state.light.color).convertSRGBToLinear();
  u.uLightIntensity.value = state.light.intensity;
  u.uSheenExp.value = k.sheenExp;
  u.uSheenGain.value = k.sheenGain;
  u.uCoverPow.value = k.coverPow;
  u.uCoverage.value = k.coverage;
  u.uConcStrength.value = state.finish.concStrength;
  u.uAmbient.value = k.ambient;
  u.uClearcoat.value = k.clearcoat;
  u.uRoughness.value = k.roughness;
  u.uGlitter.value = k.glitter;
  u.uChannel.value = Math.max(0, CHANNELS.indexOf(k.channel));
  keyLight.intensity = 1.6 * state.light.intensity;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const presetSel = document.getElementById('preset');
const presetNote = document.getElementById('presetNote');

for (const key of PRESET_KEYS) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = PRESETS[key].label;
  presetSel.appendChild(o);
}

function loadScene({ nail, magnets, note, showFinger = true }) {
  state.nail = nail;
  state.magnets = magnets;
  presetNote.textContent = note;
  state.view.showFinger = showFinger;

  select(null);
  solveRes = null;
  flakes = null;
  rebuildNailGeometry();
  rebuildMagnetMeshes();
  if (fingerMesh) fingerMesh.visible = showFinger;
  orbit.target.set(...nailCentre(nail).p);
  rebuildGUI();
  markDirty();
}

function loadPreset(key) {
  state.preset = key;
  state.sim.technique = 'none';
  state.sim.live = false;
  state.sim.running = false;
  state.sim.t = 0;
  state.sim.startTime = 0;
  const p = PRESETS[key];
  presetSel.value = key;
  loadScene({ ...p.build(), note: p.note, showFinger: p.finger !== false });
}

/**
 * Load a technique: the same kind of scene, plus motion, plus a clock that is
 * already running - started at the point in the drying curve where the move in
 * question actually does something.
 */
function loadTechnique(key) {
  if (key === 'none') { loadPreset(state.preset); return; }
  const t = TECHNIQUES[key];
  state.sim.technique = key;
  state.sim.live = true;
  state.sim.running = true;
  state.sim.startTime = t.startTime ?? 0;
  state.sim.t = state.sim.startTime;
  state.polish = { ...DEFAULT_POLISH, ...(t.polish ?? {}) };
  loadScene({ ...t.build(), note: t.note, showFinger: t.finger !== false });
}

presetSel.addEventListener('change', () => loadPreset(presetSel.value));

// ---------------------------------------------------------------------------
// GUI
// ---------------------------------------------------------------------------

let gui = null;
let magnetFolder = null;

function rebuildGUI() {
  if (gui) gui.destroy();
  gui = new GUI({ container: document.getElementById('gui'), width: 356 });
  gui.title('Controls');

  // --- magnets ---
  magnetFolder = gui.addFolder('Magnets').open();
  buildMagnetControls();

  // --- nail ---
  const fn = gui.addFolder('Nail').open(false);
  const nailChanged = () => {
    rebuildNailGeometry({ u: state.view.resU, v: state.view.resV });
    markDirty();
  };
  fn.add(state.nail, 'length', 8, 30, 0.5).name('length (mm)').onChange(nailChanged);
  fn.add(state.nail, 'width', 6, 22, 0.5).name('width (mm)').onChange(nailChanged);
  fn.add(state.nail, 'transverseCurv', 0, 0.2, 0.002).name('transverse curv (1/mm)')
    .onChange(nailChanged);
  fn.add(state.nail, 'longitudinalCurv', 0, 0.08, 0.001).name('longitudinal curv (1/mm)')
    .onChange(nailChanged);
  fn.add(state.nail, 'taper', 0, 0.4, 0.01).name('taper').onChange(nailChanged);
  fn.add({ selectNail: () => select({ kind: 'nail' }) }, 'selectNail').name('move / rotate nail');

  // --- finish model ---
  const ff = gui.addFolder('Finish model').open();
  ff.add(state.finish, 'concDriver', ['fieldMagnitude', 'gradient'])
    .name('concentration driven by').onChange(markDirty);
  ff.add(state.finish, 'concExp', 0.2, 8, 0.05).name('concentration exponent')
    .onChange(markDirty);
  ff.add(state.finish, 'concStrength', 0, 1, 0.01).name('concentration strength')
    .onChange(() => { syncMaterial(); redrawUnwrapped(); });
  ff.add(state.finish, 'orderThreshold', 0, 0.08, 0.001).name('order threshold (T)')
    .onChange(markDirty);
  ff.add(state.finish, 'orderSat', 0.002, 0.3, 0.002).name('order saturation (T)')
    .onChange(markDirty);

  // --- the clock ---
  const fp = gui.addFolder('Polish & time').open();
  const restart = (t) => {
    if (flakes) resetFlakes(flakes, grid);
    state.sim.t = t;
    markDirty();
  };
  const acts = {
    technique: state.sim.technique,
    play: () => { state.sim.live = true; state.sim.running = true; },
    pause: () => { state.sim.running = false; },
    // Wipe the coat and start the take again from wherever the technique is
    // meant to begin in the drying curve.
    restartTake: () => { restart(state.sim.startTime); state.sim.running = true; },
    freshCoat: () => {
      state.sim.startTime = 0;
      restart(0);
      state.sim.running = false;
    },
    cure: () => {
      // Gel sets the instant it goes under the lamp; lacquer has to be jumped
      // forward to where it would have set on its own.
      state.polish.cured = true;
      if (state.polish.kind !== 'gel') {
        state.sim.t = Math.max(state.sim.t,
          state.polish.dryTime * Math.log(state.polish.setViscosity / state.polish.eta0));
      }
      state.sim.running = false;
      markDirty();
    },
  };

  fp.add(state.sim, 'live').name('run the clock (else steady state)')
    .onChange(() => { flakes = null; markDirty(); });
  fp.add(acts, 'technique', ['none', ...TECHNIQUE_KEYS])
    .name('technique').onChange(loadTechnique);
  fp.add(state.sim, 'running').name('playing').listen();
  // Scrubbing restarts the coat and replays to the new time, because the pile
  // has memory - where it ends up depends on the whole history, not just on
  // where the tool is now. That is the entire point of the time axis.
  fp.add(state.sim, 't', 0, 300, 0.5).name('elapsed (s)').listen()
    .onChange(() => { if (flakes) resetFlakes(flakes, grid); markDirty(); });
  fp.add(state.sim, 'startTime', 0, 280, 1).name('take starts at (s)')
    .onChange((v) => restart(v));
  fp.add(state.sim, 'speed', 0.1, 20, 0.1).name('clock speed ×');
  fp.add(acts, 'play').name('▶ play');
  fp.add(acts, 'pause').name('❚❚ pause');
  fp.add(acts, 'restartTake').name('↺ restart the take');
  fp.add(acts, 'freshCoat').name('⟲ fresh coat from t=0');
  fp.add(acts, 'cure').name('❄ cure / set now');

  const fpp = fp.addFolder('Polish properties').open(false);
  fpp.add(state.polish, 'kind', ['regular', 'gel']).name('type').onChange(markDirty);
  fpp.add(state.polish, 'eta0', 0.05, 5, 0.05).name('fresh viscosity (Pa·s)')
    .onChange(markDirty);
  fpp.add(state.polish, 'dryTime', 4, 120, 1).name('drying time constant (s)')
    .onChange(markDirty);
  fpp.add(state.polish, 'setViscosity', 100, 20000, 100).name('sets above (Pa·s)')
    .onChange(markDirty);
  fpp.add(state.polish, 'chi', 0.2, 20, 0.1).name('pigment susceptibility')
    .onChange(markDirty);
  fpp.add(state.polish, 'Bsat', 0.005, 0.4, 0.005).name('pigment saturates at (T)')
    .onChange(markDirty);
  fpp.add(state.polish, 'kSpread', 0, 1.5, 0.05)
    .name('flake size spread (σ)')
    .onChange(() => { flakes = null; markDirty(); });
  fpp.add(state.sim, 'perTexel', 4, 48, 1).name('flakes per texel')
    .onChange(() => { flakes = null; markDirty(); });

  // --- look ---
  const fl = gui.addFolder('Appearance').open();
  const look = () => { syncMaterial(); redrawUnwrapped(); };
  fl.addColor(state.look, 'baseColor').name('base coat').onChange(look);
  fl.addColor(state.look, 'sheenColor').name('sheen colour').onChange(look);
  fl.addColor(state.look, 'flakeColor').name('flake body').onChange(look);
  fl.add(state.look, 'sheenExp', 4, 200, 1).name('sheen sharpness').onChange(look);
  fl.add(state.look, 'sheenGain', 0, 5, 0.05).name('sheen gain').onChange(look);
  fl.add(state.look, 'coverage', 0, 1, 0.01).name('pile coverage').onChange(look);
  fl.add(state.look, 'coverPow', 0.5, 8, 0.1).name('show-through falloff').onChange(look);
  fl.add(state.look, 'ambient', 0, 0.6, 0.01).name('ambient').onChange(look);
  fl.add(state.look, 'clearcoat', 0, 1.5, 0.01).name('top coat gloss').onChange(look);
  fl.add(state.look, 'roughness', 0.02, 0.6, 0.01).name('top coat roughness').onChange(look);
  fl.add(state.look, 'glitter', 0, 1, 0.01).name('unaligned glitter').onChange(look);
  fl.add(state.look, 'channel', CHANNELS).name('3D channel').onChange(look);

  // --- light ---
  const fli = gui.addFolder('Light').open();
  fli.add(state.light, 'auto').name('auto move');
  fli.add(state.light, 'mode', ['linear', 'sweep', 'orbit']).name('path');
  fli.add(state.light, 'speed', 0.05, 3, 0.05).name('speed');
  fli.add(state.light, 'showPath').name('draw the path');

  const fLin = fli.addFolder('Linear path').open();
  fLin.add(state.light, 'linearT', -1, 1, 0.005).name('position on line').listen();
  fLin.add(state.light, 'travel', 5, 200, 1).name('half-length (mm)');
  fLin.add(state.light, 'lineAngle', -Math.PI, Math.PI, 0.01)
    .name('direction  0=across nail');
  fLin.add(state.light, 'lineOffset', -120, 120, 1).name('sideways offset (mm)');

  const fArc = fli.addFolder('Arc path').open(false);
  fArc.add(state.light, 'sweep', 0.2, Math.PI, 0.01).name('half-arc (rad)');
  fArc.add(state.light, 'centre', -Math.PI, Math.PI, 0.01).name('centre (rad)');
  fArc.add(state.light, 'azimuth', -Math.PI, Math.PI, 0.01)
    .name('azimuth  0=free edge').listen();
  fli.add(state.light, 'height', -90, 120, 1).name('height (mm)');
  // 0 is legitimate: distance is the HORIZONTAL radius, so distance 0 with a
  // positive height puts the light directly overhead.
  fli.add(state.light, 'distance', 0, 160, 1).name('distance (mm)');
  fli.add(state.light, 'intensity', 0, 3, 0.05).name('intensity').onChange(syncMaterial);
  fli.addColor(state.light, 'color').name('colour').onChange(syncMaterial);

  // --- view ---
  const fv = gui.addFolder('View').open(false);
  fv.add(state.view, 'snap').name('snap magnets together');
  fv.add(state.view, 'magnetOpacity', 0, 1, 0.01).name('magnet opacity')
    .onChange(applyMagnetOpacity);
  fv.add(state.view, 'showFinger').name('show finger')
    .onChange(() => { if (fingerMesh) fingerMesh.visible = state.view.showFinger; });
  fv.add(state.view, 'showFieldLines').name('show field lines').onChange(markDirty);
  fv.add(state.view, 'fieldLineCount', 4, 40, 1).name('field line count').onChange(markDirty);
  fv.add(state.view, 'liveResU', 24, 128, 4).name('live-clock res (length)')
    .onChange(() => { solveRes = null; flakes = null; markDirty(); });
  fv.add(state.view, 'liveResV', 16, 96, 4).name('live-clock res (width)')
    .onChange(() => { solveRes = null; flakes = null; markDirty(); });
  fv.add(state.view, 'resU', 24, 160, 4).name('solve res (length)')
    .onChange(() => { solveRes = null; markDirty(); });
  fv.add(state.view, 'resV', 16, 128, 4).name('solve res (width)')
    .onChange(() => { solveRes = null; markDirty(); });
  fv.add(state.view, 'unwrapChannel', CHANNELS).name('unwrapped channel')
    .onChange(redrawUnwrapped);
  fv.add(state.view, 'unwrapView', ['head-on', 'camera']).name('unwrapped viewpoint')
    .onChange(redrawUnwrapped);

  annotateGUI(gui);
  syncMaterial();
}

/**
 * Short explanations for the controls whose names cannot carry them. Keyed by
 * the controller's display name, so renaming a control here without renaming it
 * above just drops the tooltip rather than mislabelling it.
 */
const CONTROL_HELP = {
  'concentration driven by':
    'Which force decides where pigment piles up. |B| puts it where flakes come '
    + 'to rest; gradient uses |grad(B^2)|, the actual force. They agree closely '
    + 'in practice - see the README.',
  'concentration exponent': 'How sharply density follows the driver. Higher = tighter, harder-edged band.',
  'concentration strength': 'How much the density variation is allowed to show in the shading. 0 = uniform pigment.',
  'order threshold (T)': 'Field strength below which flakes are left disordered. Sets the size of the dark, unaligned region.',
  'order saturation (T)': 'Field strength above which alignment is as good as it gets. Lower = the pile locks in sooner.',
  'run the clock (else steady state)':
    'Off solves the long-time limit directly - where the pile ends up given '
    + 'forever. On integrates the flakes forward in time, which is what any '
    + 'technique involving movement needs.',
  'take starts at (s)': 'How long the polish has already been drying when the tool arrives. This is the single most important control for techniques - the same move does nothing on fresh polish and works on tacky.',
  'clock speed ×': 'Wall-clock playback rate. Does not change the physics, only how fast you watch it.',
  'fresh viscosity (Pa·s)': 'Thickness of the polish the moment it is brushed on, before any solvent has flashed off.',
  'drying time constant (s)': 'How quickly it thickens. Viscosity rises exponentially with this as its time constant.',
  'sets above (Pa·s)':
    'The viscosity at which the polish is treated as solid: flakes stop '
    + 'turning and the finish is frozen. This is what ends the working window.',
  'pigment susceptibility': 'Magnetic susceptibility of the flakes. Higher = they feel the field more strongly and turn faster.',
  'pigment saturates at (T)': 'Field strength above which a flake is fully magnetised and stronger field buys nothing more.',
  'flake size spread (σ)':
    'Spread of turning rates across the flakes in one texel. This is '
    + 'load-bearing: with zero spread every flake tracks the tool in lockstep '
    + 'and no glass bead is possible.',
  'flakes per texel': 'Ensemble size behind each surface point. Higher is smoother and slower.',
  'sheen sharpness': 'Angular tightness of the sheen lobe. Higher = a narrower, harder line.',
  'sheen gain': 'Brightness multiplier on the sheen only, leaving the base coat alone.',
  'pile coverage': 'How much of the surface the flake layer hides. Lower lets the base coat read through.',
  'show-through falloff': 'How quickly the base coat is hidden as pile density rises.',
  'unaligned glitter': 'Sparkle from flakes that never aligned. Independent of the pile direction.',
  '3D channel': 'Swaps the 3D view for a diagnostic map - field strength, tilt, order and so on - instead of the shaded finish.',
  'snap magnets together':
    'When a drag ends, nearby magnets click face-to-face. Hold Alt while '
    + 'dropping to skip it for one placement without turning this off.',
  '✋ steer selected by hand (H)':
    'The tool follows the pointer in the nail\'s own plane, with the clock '
    + 'running, so the pile answers while you move. Wheel raises and lowers it.',
  'live-clock res (length)': 'Solve grid used while the clock runs. Lower to keep playback smooth.',
  'live-clock res (width)': 'Solve grid used while the clock runs. Lower to keep playback smooth.',
  'solve res (length)': 'Solve grid for the static, full-quality solve.',
  'solve res (width)': 'Solve grid for the static, full-quality solve.',
  'direction  0=across nail': 'Heading of the light track. 0 sweeps it across the nail, which is the direction a cat-eye line responds to.',
  'unwrapped viewpoint': 'Whether the flat map is drawn head-on or from where the camera currently is.',
};

/**
 * Two GUI-wide behaviours lil-gui does not offer as options.
 *
 * 1. Tooltips, from CONTROL_HELP above.
 * 2. Scroll containment. lil-gui binds the wheel to its number sliders, so
 *    scrolling the panel with the pointer over a slider edits that slider
 *    instead - which silently changes the scene while you are only trying to
 *    look at it. Swallowing the wheel in the capture phase stops it reaching
 *    the slider; the panel still scrolls, because that is the default action
 *    and nothing here calls preventDefault.
 */
function annotateGUI(root) {
  for (const c of root.controllersRecursive()) {
    const help = CONTROL_HELP[c._name];
    if (help) c.domElement.title = help;
  }
  const panel = root.domElement;
  if (!panel.dataset.wheelGuard) {
    panel.dataset.wheelGuard = '1';
    panel.addEventListener('wheel', (e) => e.stopPropagation(), { capture: true });
  }
}

function buildMagnetControls() {
  magnetFolder.controllers.slice().forEach((c) => c.destroy());
  magnetFolder.folders.slice().forEach((f) => f.destroy());

  const actions = {
    add: () => addMagnet(),
    duplicate: () => duplicateMagnet(currentMagnet()),
    remove: () => removeMagnet(currentMagnet()),
  };

  magnetFolder.add(actions, 'add').name('+ add magnet');
  magnetFolder.add(actions, 'duplicate').name('duplicate selected');
  magnetFolder.add({ iron: () => addIron() }, 'iron').name('+ add iron piece');
  magnetFolder.add({ wire: () => addWire() }, 'wire').name('+ add steel wire (V, draws a heart)');
  magnetFolder.add(actions, 'remove').name('delete selected');
  magnetFolder.add({ hand: () => toggleFreeHand() }, 'hand')
    .name('✋ steer selected by hand (H)');

  for (const m of state.magnets) {
    const f = magnetFolder.addFolder(m.name || m.type);
    f.open(selected?.kind === 'magnet' && selected.id === m.id);
    f.domElement.dataset.magnetId = m.id;

    f.add({ pick: () => select({ kind: 'magnet', id: m.id }) }, 'pick').name('select');
    f.add(m, 'enabled').name('enabled').onChange(() => {
      syncMagnetMesh(magnetMeshes.get(m.id), m);
      markDirty();
    });
    f.add(m, 'type', MAGNET_TYPES).name('shape').onChange((t) => {
      m.size = defaultSize(t);
      rebuildMagnetMeshes();
      rebuildGUI();
      markDirty();
    });
    if (m.iron) {
      // Iron has no remanence and no poles to flip - both would be meaningless
      // here, and showing them would suggest the field comes from the body
      // rather than from what it is standing in.
      f.add(m, 'cellSize', 0.8, 5, 0.1).name('dicing (mm)').onChange(markDirty);
      f.add({ note: '' }, 'note').name('induced, not permanent').disable();
    } else {
      f.add(m, 'Br', 0.1, 1.6, 0.01).name('Br (T)').onChange(markDirty);
      f.add(m, 'flip').name('flip N-S').onChange(() => {
        rebuildMagnetMeshes();
        markDirty();
      });
    }

    const geoChanged = () => { rebuildMagnetMeshes(); markDirty(); };
    const s = m.size;
    if (m.type === 'wire') {
      f.add(s, 'shape', WIRE_SHAPES).name('bent into').onChange(geoChanged);
      f.add(s, 'scale', 4, 26, 0.5).name('size across (mm)').onChange(geoChanged);
      f.add(s, 'thickness', 0.4, 3, 0.1).name('wire thickness (mm)').onChange(geoChanged);
    } else if (m.type === 'box') {
      f.add(s, 'sx', 1, 60, 0.5).name('width X').onChange(geoChanged);
      f.add(s, 'sy', 1, 60, 0.5).name('depth Y').onChange(geoChanged);
      f.add(s, 'sz', 0.5, 60, 0.5).name('thickness Z (magnetised)').onChange(geoChanged);
    } else if (m.type === 'cylinder') {
      f.add(s, 'radius', 0.5, 30, 0.5).name('radius').onChange(geoChanged);
      f.add(s, 'height', 0.5, 40, 0.5).name('height (magnetised)').onChange(geoChanged);
    } else if (m.type === 'sphere') {
      f.add(s, 'radius', 0.5, 30, 0.5).name('radius').onChange(geoChanged);
    } else if (m.type === 'halbachCylinder') {
      f.add(s, 'outerRadius', 6, 80, 1).name('outer radius').onChange(geoChanged);
      f.add(s, 'innerRadius', 2, 70, 1).name('bore radius').onChange(geoChanged);
      f.add(s, 'height', 2, 60, 1).name('height').onChange(geoChanged);
      f.add(s, 'segments', 4, 48, 1).name('segments').onChange(geoChanged);
      f.add(s, 'poles', 1, 4, 1).name('poles (1=dipole 2=quad)').onChange(geoChanged);
    } else if (m.type === 'ring') {
      f.add(s, 'outerRadius', 1, 40, 0.5).name('outer radius').onChange(geoChanged);
      f.add(s, 'innerRadius', 0, 38, 0.5).name('inner radius').onChange(geoChanged);
      f.add(s, 'height', 0.5, 40, 0.5).name('height (magnetised)').onChange(geoChanged);
    } else if (m.type === 'horseshoe') {
      f.add(s, 'legLength', 4, 40, 0.5).name('leg length').onChange(geoChanged);
      f.add(s, 'legWidth', 1, 20, 0.5).name('leg width').onChange(geoChanged);
      f.add(s, 'depth', 1, 30, 0.5).name('depth').onChange(geoChanged);
      f.add(s, 'gap', 2, 40, 0.5).name('gap').onChange(geoChanged);
      f.add(s, 'yoke', 1, 20, 0.5).name('yoke').onChange(geoChanged);
    } else if (m.type === 'array') {
      f.add(s, 'nx', 1, 16, 1).name('cells X').onChange(geoChanged);
      f.add(s, 'ny', 1, 16, 1).name('cells Y').onChange(geoChanged);
      f.add(s, 'cellX', 0.5, 12, 0.25).name('cell X').onChange(geoChanged);
      f.add(s, 'cellY', 0.5, 30, 0.25).name('cell Y').onChange(geoChanged);
      f.add(s, 'height', 0.5, 20, 0.5).name('thickness').onChange(geoChanged);
      f.add(s, 'pattern', ['stripe', 'checker', 'halbach']).name('pattern')
        .onChange(geoChanged);
    }

    buildMotionControls(f, m);
  }
}

/**
 * How the hand holds this tool. Only meaningful with the clock running - with
 * the steady-state model there is no time for anything to move IN.
 */
function buildMotionControls(f, m) {
  const fm = f.addFolder('Motion').open(false);
  const proxy = { kind: m.motion?.kind ?? 'still' };

  fm.add(proxy, 'kind', MOTION_KINDS).name('hand movement').onChange((k) => {
    m.motion = k === 'still' ? null : defaultMotion(k);
    rebuildGUI();
    markDirty();
  });

  if (!m.motion) return;
  // Fill in anything the author left out. A motion written by hand in
  // techniques.js need only say what it cares about, but lil-gui binds by
  // reference and cannot bind a property that is not there.
  const mo = Object.assign(m.motion, {
    ...defaultMotion(m.motion.kind), ...m.motion,
  });
  if (mo.stops) {
    mo.stops = mo.stops.map((st) => ({
      offset: [0, 0, 0], spin: 0, hold: 1, ...st,
    }));
  }
  if (mo.kind === 'spin' || mo.kind === 'orbit') {
    fm.add(mo, 'rpm', -600, 600, 5).name('rpm').onChange(markDirty);
    fm.add(mo, 'axis', ['normal', 'along', 'across']).name('axis').onChange(markDirty);
    fm.add(mo, 'phase', -Math.PI, Math.PI, 0.01).name('start phase').onChange(markDirty);
  }
  if (mo.kind === 'orbit') {
    fm.add(mo, 'radius', 0, 25, 0.5).name('circle radius (mm)').onChange(markDirty);
    fm.add(mo, 'yaw').name('turn to face inward').onChange(markDirty);
  }
  if (mo.kind === 'waypoints') {
    fm.add(mo, 'travel', 0.05, 6, 0.05).name('travel time between stops')
      .onChange(markDirty);
    fm.add(mo, 'loop').name('loop').onChange(markDirty);
    mo.stops.forEach((st, i) => {
      const fs = fm.addFolder(`stop ${i + 1}`).open(false);
      const o = { x: st.offset[0], y: st.offset[1], z: st.offset[2] };
      const push = () => { st.offset = [o.x, o.y, o.z]; markDirty(); };
      fs.add(o, 'x', -20, 20, 0.5).name('across nail (mm)').onChange(push);
      fs.add(o, 'y', -20, 20, 0.5).name('along nail (mm)').onChange(push);
      fs.add(o, 'z', -6, 45, 0.5).name('lift (mm)').onChange(push);
      fs.add(st, 'spin', -90, 90, 1).name('turn (deg)').onChange(markDirty);
      fs.add(st, 'hold', 0, 20, 0.1).name('hold (s)').onChange(markDirty);
    });
  }

  // A tool can be picked up and put down mid-take. That is what makes
  // multi-step techniques possible - see motion.js.
  const w = { from: m.active?.[0] ?? 0, to: Number.isFinite(m.active?.[1]) ? m.active[1] : 300 };
  const setW = () => {
    m.active = (w.from <= 0 && w.to >= 300) ? null : [w.from, w.to];
    markDirty();
  };
  fm.add(w, 'from', 0, 300, 0.5).name('in hand from (s)').onChange(setW);
  fm.add(w, 'to', 0, 300, 0.5).name('put down at (s)').onChange(setW);
}

function currentMagnet() {
  if (selected?.kind !== 'magnet') return null;
  return state.magnets.find((m) => m.id === selected.id) ?? null;
}

// Scene edits. These take the magnet to act on rather than reading the
// selection, because the context menu acts on whatever the pointer is over.

function addMagnet() {
  const c = nailCentre(state.nail);
  state.magnets.push(createMagnet({
    type: 'box',
    position: [c.p[0], c.p[1], c.p[2] + 14],
  }));
  rebuildMagnetMeshes();
  rebuildGUI();
  markDirty();
}

/**
 * A piece of soft iron. Small by default and placed just above the nail, which
 * is where it does something: an iron shape is a passive tool that has to be
 * inside another magnet's field before it is a magnet at all.
 */
function addIron() {
  const c = nailCentre(state.nail);
  state.magnets.push(createMagnet({
    type: 'box',
    name: 'iron piece',
    iron: true,
    Br: 0,
    size: { sx: 8, sy: 4, sz: 3 },
    cellSize: 2,
    position: [c.p[0], c.p[1], c.p[2] + 6],
  }));
  rebuildMagnetMeshes();
  rebuildGUI();
  markDirty();
}

/**
 * A bent steel wire, plus the barrel magnet that drives it - because on its own
 * a wire does nothing at all, and adding one without a source would look like
 * the feature was broken.
 */
function addWire() {
  const c = nailCentre(state.nail);
  const hasSource = state.magnets.some((m) => !m.iron && m.enabled !== false);
  state.magnets.push(createMagnet({
    type: 'wire',
    name: 'steel wire',
    iron: true,
    Br: 0,
    cellSize: 0.9,
    // A V, not a heart - see the note in softIron.js. The tool that draws a
    // heart is bent into a V; a heart-shaped wire draws a blob.
    size: { shape: 'vee', scale: 11, thickness: 1.2 },
    position: [c.p[0], c.p[1], c.p[2] + 2.5],
  }));
  if (!hasSource) {
    state.magnets.push(createMagnet({
      type: 'cylinder',
      name: 'barrel magnet',
      size: { radius: 4, height: 12 },
      position: [c.p[0], c.p[1], c.p[2] + 13],
    }));
  }
  rebuildMagnetMeshes();
  rebuildGUI();
  markDirty();
}

function duplicateMagnet(m) {
  if (!m) return;
  state.magnets.push(createMagnet({
    ...m,
    id: undefined,
    name: `${m.name} copy`,
    position: [m.position[0], m.position[1], m.position[2] + 10],
    quaternion: [...m.quaternion],
    size: { ...m.size },
  }));
  rebuildMagnetMeshes();
  rebuildGUI();
  markDirty();
}

function removeMagnet(m) {
  if (!m) return;
  state.magnets = state.magnets.filter((x) => x !== m);
  select(null);
  rebuildMagnetMeshes();
  rebuildGUI();
  markDirty();
}

function setMagnetFlipped(m, flip) {
  m.flip = flip;
  rebuildMagnetMeshes();
  rebuildGUI();
  markDirty();
}

function setMagnetEnabled(m, on) {
  m.enabled = on;
  syncMagnetMesh(magnetMeshes.get(m.id), m);
  rebuildGUI();
  markDirty();
}

function refreshMagnetFolder() {
  if (!magnetFolder) return;
  for (const f of magnetFolder.folders) {
    const id = f.domElement.dataset.magnetId;
    if (id && selected?.kind === 'magnet' && selected.id === id) f.open();
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function resize() {
  const w = viewEl.clientWidth;
  const h = viewEl.clientHeight;
  // updateStyle must stay ON. With it off, three sets the canvas backing-store
  // size but not its CSS size, so on a HiDPI display the element lays out at
  // devicePixelRatio times too wide and pushes the side panel off screen.
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  redrawUnwrapped();
}
addEventListener('resize', resize);

let last = performance.now();
let unwrapAccum = 0;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  updateLight(dt);
  orbit.update();

  // Advance the polish clock. The rotation integrator is exact for any step,
  // so a dropped frame costs accuracy in how B changed during it - never
  // stability - and there is no CFL condition to respect.
  if (state.sim.live && state.sim.running) {
    state.sim.t += dt * state.sim.speed;
    simDt += dt * state.sim.speed;
    dirty = true;
  }

  if (dirty) solve();

  // The unwrapped view depends on the light, so refresh it while it sweeps -
  // but at ~12 Hz, not every frame.
  unwrapAccum += dt;
  const follows = state.light.auto || state.view.unwrapView === 'camera';
  if (follows && unwrapAccum > 0.08 && state.view.unwrapChannel === 'shaded') {
    unwrapAccum = 0;
    redrawUnwrapped();
  }

  renderer.render(scene, camera);
}

loadPreset(state.preset);
resize();
requestAnimationFrame(tick);

// Debug handle: lets the app be driven and measured from the console, which is
// how the sheen-sweep behaviour is verified rather than eyeballed.
window.__app = {
  state,
  loadPreset,
  loadTechnique,
  solve,
  // Advance the polish clock by hand, exactly as tick() does. This is how the
  // time-resolved behaviour gets driven and measured from the console rather
  // than eyeballed - and it works in a background tab, where rAF is suspended.
  advance(dt) {
    state.sim.t += dt;
    simDt += dt;
    solve();
  },
  markDirty,
  get flakes() { return flakes; },
  redrawUnwrapped,
  applyMagnetOpacity,
  syncMaterial,
  get grid() { return grid; },
  get finish() { return finish; },
  // Input state, which is otherwise only observable by actually using a mouse.
  gizmo,
  // Editing state.magnets from the console leaves the meshes stale, which
  // looks like a rendering bug and is not one - this is how to resync.
  rebuildMagnetMeshes,
  rebuildGUI,
  get freeHand() { return freeHand; },
  get modifiers() { return { alt: altHeld, ctrl: ctrlHeld }; },
  setFreeHand,
};
