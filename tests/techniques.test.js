// Scripted motion, and the techniques built on it.
//
// These are the claims the notes in techniques.js make, written as assertions.
// They are the point of the whole time axis: if spinning a tool does not
// actually scatter the pile, the module is decoration.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  motionPose, motionDuration, posedMagnets, nailFrame, activeAt, defaultMotion,
  MOTION_KINDS, unposeMagnet,
} from '../src/core/motion.js';
import { createMagnet } from '../src/core/magnet.js';
import { createNail, buildNailGrid, fingerClearance } from '../src/core/nail.js';
import { buildFaces } from '../src/core/field.js';
import { computeFinish, sampleGrid } from '../src/core/finish.js';
import { createFlakes, stepFlakes, viscosityAt } from '../src/core/dynamics.js';
import { TECHNIQUES, TECHNIQUE_KEYS } from '../src/core/techniques.js';
import { PRESETS, PRESET_KEYS } from '../src/core/presets.js';
import { quatFromAxisAngle } from '../src/core/vec.js';

const RES = { resU: 36, resV: 24 };

/**
 * Play a scene forward and report what the pile ended up like. This is the
 * whole pipeline: pose the tools, sample the field, turn the flakes, measure.
 */
function play({ nail, magnets, polish = {}, startTime = 0, duration, dt = 0.05 }) {
  const grid = buildNailGrid({ ...nail, ...RES });
  const flakes = createFlakes(grid, { perTexel: 16 });
  const steps = Math.max(1, Math.round(duration / dt));
  for (let s = 0; s < steps; s++) {
    const t = s * dt;
    const faces = buildFaces(posedMagnets(magnets, nail, t));
    const field = sampleGrid(grid, faces);
    flakes.t = startTime + t;
    stepFlakes(flakes, grid, field.B, field.bmag, polish, dt);
  }
  const finish = computeFinish(grid, buildFaces([]), {
    director: flakes.director, order: flakes.order,
  });
  return { finish, flakes, grid };
}

describe('motion is a pure function of time', () => {
  const nail = createNail();
  const frame = nailFrame(nail);
  const base = createMagnet({ type: 'box', position: [0, 0, 10] });

  it('scrubbing gives the same pose as playing forward', () => {
    // Which is what makes a technique reproducible: no accumulated state, so
    // jumping to 12 s and running to 12 s cannot disagree.
    for (const kind of MOTION_KINDS) {
      const m = defaultMotion(kind);
      for (const t of [0, 0.37, 3.2, 9.9, 42]) {
        const a = motionPose(m, t, base, frame);
        const b = motionPose(m, t, base, frame);
        expect(a.position, `${kind} @${t}`).toEqual(b.position);
        expect(a.quaternion).toEqual(b.quaternion);
      }
    }
  });

  it('still means still', () => {
    const p = motionPose({ kind: 'still' }, 5, base, frame);
    expect(p.position).toEqual(base.position);
    expect(p.quaternion).toEqual(base.quaternion);
  });

  it('a spin turns the tool without moving it', () => {
    const m = { kind: 'spin', rpm: 60, axis: 'normal' };
    expect(motionDuration(m)).toBeCloseTo(1, 9); // 60 rpm is one turn a second
    for (const t of [0, 0.25, 0.5, 0.9]) {
      expect(motionPose(m, t, base, frame).position).toEqual(base.position);
    }
    // ...and after a whole turn it is back where it started (up to the sign
    // ambiguity of a quaternion, which is the same rotation).
    const q0 = motionPose(m, 0, base, frame).quaternion;
    const q1 = motionPose(m, 1, base, frame).quaternion;
    const d = Math.abs(q0.reduce((s, v, i) => s + v * q1[i], 0));
    expect(d).toBeCloseTo(1, 9);
  });

  it('an orbit moves the tool on a circle of the right radius', () => {
    const m = { kind: 'orbit', rpm: 60, radius: 6, yaw: false };
    for (const t of [0, 0.1, 0.3, 0.75]) {
      const p = motionPose(m, t, base, frame);
      const d = Math.hypot(
        p.position[0] - base.position[0],
        p.position[1] - base.position[1],
        p.position[2] - base.position[2],
      );
      expect(d).toBeCloseTo(6, 9);
    }
  });

  it('waypoints hold, travel, and then park on the last stop', () => {
    const m = {
      kind: 'waypoints',
      travel: 1,
      stops: [{ offset: [-5, 0, 0], hold: 2 }, { offset: [5, 0, 0], hold: 2 }],
    };
    const x = (t) => motionPose(m, t, base, frame).position[0];
    expect(x(0)).toBeCloseTo(base.position[0] - 5, 6);
    expect(x(1.9)).toBeCloseTo(base.position[0] - 5, 6);   // still holding
    expect(x(2.5)).toBeCloseTo(base.position[0], 6);        // half way across
    expect(x(3.1)).toBeCloseTo(base.position[0] + 5, 6);    // arrived
    expect(x(500)).toBeCloseTo(base.position[0] + 5, 6);    // and stays
  });

  it('a tool can be picked up and put down', () => {
    const nailX = createNail();
    const held = createMagnet({ type: 'box', position: [0, 0, 10], active: [2, 5] });
    expect(activeAt(held, 1)).toBe(false);
    expect(activeAt(held, 3)).toBe(true);
    expect(activeAt(held, 6)).toBe(false);
    expect(posedMagnets([held], nailX, 1)).toHaveLength(0);
    expect(posedMagnets([held], nailX, 3)).toHaveLength(1);
  });

  it('posing never mutates the authored magnet', () => {
    const m = createMagnet({
      type: 'box', position: [0, 0, 10], motion: { kind: 'spin', rpm: 120 },
    });
    const before = JSON.stringify(m);
    posedMagnets([m], nail, 7.3);
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe('techniques do what their notes claim', () => {
  it('every technique plays through to finite values', () => {
    for (const key of TECHNIQUE_KEYS) {
      const t = TECHNIQUES[key];
      const { finish, grid } = play({
        ...t.build(), polish: t.polish, startTime: t.startTime,
        duration: Math.min(6, t.duration), dt: 0.1,
      });
      for (let i = 0; i < grid.count; i++) {
        expect(Number.isFinite(finish.tilt[i]), `${key} tilt[${i}]`).toBe(true);
        expect(finish.order[i], `${key} order[${i}]`).toBeGreaterThanOrEqual(0);
        expect(finish.order[i]).toBeLessThanOrEqual(1);
      }
      expect(t.note.length).toBeGreaterThan(80);
      expect(t.duration).toBeGreaterThan(0);
    }
  });

  it('spinning the tool scatters the pile — but only in a window', () => {
    // The glass-bead claim, and the sharpest prediction the time axis makes.
    // Fresh polish re-aligns faster than any hand can turn a magnet, so
    // spinning does nothing at all; once the coat has thickened, the same spin
    // collapses the order parameter.
    const { nail, magnets } = TECHNIQUES.glassBeadSpin.build();
    const still = magnets.map((m) => ({ ...m, motion: null }));

    const orderAt = (mags, startTime) =>
      play({ nail, magnets: mags, startTime, duration: 4, dt: 0.02 })
        .finish.stats.meanOrder;

    // Fresh: spinning is indistinguishable from holding it still.
    expect(orderAt(magnets, 0)).toBeCloseTo(orderAt(still, 0), 2);

    // Tacky: spinning costs a large chunk of the order, holding still does not.
    const tackyStill = orderAt(still, 205);
    const tackySpun = orderAt(magnets, 205);
    expect(tackyStill).toBeGreaterThan(0.85);
    expect(tackySpun).toBeLessThan(tackyStill - 0.15);
  });

  it('gel gives no bead, because nothing ever lags', () => {
    // The practical corollary of the window: gel holds its viscosity, so the
    // pile always keeps up and the spin leaves no trace. Same tool, same move.
    const { nail, magnets } = TECHNIQUES.glassBeadSpin.build();
    const gel = { kind: 'gel' };
    const spun = play({ nail, magnets, polish: gel, duration: 4, dt: 0.02 });
    const still = play({
      nail, magnets: magnets.map((m) => ({ ...m, motion: null })),
      polish: gel, duration: 4, dt: 0.02,
    });
    expect(spun.finish.stats.meanOrder)
      .toBeCloseTo(still.finish.stats.meanOrder, 2);
    expect(spun.finish.stats.meanOrder).toBeGreaterThan(0.9);
  });

  it('taking the tool away freezes the pattern, at any viscosity', () => {
    // The mechanism behind every multi-step technique, and the thing that is
    // easy to get wrong: it is not the polish thickening that holds the first
    // half of the pattern, it is the absence of a field.
    const nail = createNail();
    const bar = createMagnet({
      type: 'array', size: { nx: 2, ny: 1, cellX: 7, cellY: 26, height: 5, pattern: 'stripe' },
      position: [0, 0, 7], active: [0, 1],
    });
    const combed = play({ nail, magnets: [bar], duration: 1, dt: 0.05 });
    // Fresh polish, tool gone, a long time to drift: nothing changes.
    const later = play({ nail, magnets: [bar], duration: 30, dt: 0.25 });

    for (let i = 0; i < combed.grid.count; i += 7) {
      const d = Math.abs(
        combed.finish.chain[i * 3] * later.finish.chain[i * 3]
        + combed.finish.chain[i * 3 + 1] * later.finish.chain[i * 3 + 1]
        + combed.finish.chain[i * 3 + 2] * later.finish.chain[i * 3 + 2],
      );
      expect(d).toBeGreaterThan(0.9999);
    }
  });

  it('a small tool is only LOCAL once the polish has thickened', () => {
    // This one surprised me and it is worth stating carefully.
    //
    // A magnet's field never actually reaches zero, it just gets small. In
    // fresh polish the alignment time at 1 mT is still under a second, so
    // given a few seconds the far end of the nail is combed by the tail of the
    // field just as thoroughly as the near end is combed by its core - the
    // small tool re-combs the WHOLE nail and wrecks whatever was there.
    //
    // Thickening is what buys locality: once eta is high enough that the weak
    // regions cannot finish turning in the time available, the tool's reach
    // becomes finite. So the S-curve is not a technique you can do at any
    // moment and merely do better when tacky - the tacky window is what makes
    // it possible at all.
    const nail = createNail();
    const bar = createMagnet({
      type: 'array', size: { nx: 2, ny: 1, cellX: 7, cellY: 26, height: 5, pattern: 'stripe' },
      position: [0, 0, 7], active: [0, 1],
    });
    const round = createMagnet({
      type: 'array', size: { nx: 2, ny: 1, cellX: 3, cellY: 8, height: 4, pattern: 'stripe' },
      position: [0, 0, 4], active: [1, Infinity],
      quaternion: quatFromAxisAngle([0, 0, 1], 0.9),
      motion: {
        kind: 'waypoints', travel: 0.4,
        stops: [{ offset: [0, 5.5, -0.5], hold: 6 }],
      },
    });
    const reach = (startTime) => {
      const before = play({ nail, magnets: [bar], duration: 1, dt: 0.05, startTime });
      const after = play({
        nail, magnets: [bar, round], duration: 7, dt: 0.05, startTime,
      });
      const g = before.grid;
      const rowAngle = (iu) => {
        let s = 0;
        for (let iv = 0; iv < g.nv; iv++) {
          const i = iu * g.nv + iv;
          const d = Math.abs(
            before.finish.chain[i * 3] * after.finish.chain[i * 3]
            + before.finish.chain[i * 3 + 1] * after.finish.chain[i * 3 + 1]
            + before.finish.chain[i * 3 + 2] * after.finish.chain[i * 3 + 2],
          );
          s += Math.acos(Math.min(1, d)) * 180 / Math.PI;
        }
        return s / g.nv;
      };
      // The tool sits near the tip, so that is the end it is meant to work on.
      return { near: rowAngle(g.nu - 3), far: rowAngle(2) };
    };

    // Fresh: the tool reaches everywhere. The far end moves as much as the
    // near end - in fact more, because the near end is pinned by the strong
    // part of the field while the far end is free to be swung anywhere.
    const fresh = reach(0);
    expect(fresh.far).toBeGreaterThan(30);

    // Tacky: the same tool, the same move, but now its reach is finite. The
    // near end is still fully re-combed and the far end is untouched.
    const tacky = reach(190);
    expect(tacky.near).toBeGreaterThan(30);
    expect(tacky.far).toBeLessThan(2);
    expect(tacky.far).toBeLessThan(fresh.far / 20);
  });
});

describe('the app shell wires the two clocks up correctly', () => {
  // A static check, because this bug is invisible to every unit test: the
  // physics module is handed whatever time the shell passes it and cannot
  // tell that it is the wrong one.
  //
  // There are TWO clocks. The polish ages from when the coat went on; a
  // technique's schedule ("lift the bar off at 2 s") runs from when the take
  // starts. Feeding polish time into posedMagnets made every `active` window
  // expire before the take began, so the S-curve silently ran with its first
  // tool already put down - and still produced a plausible-looking nail.
  const mainSrc = readFileSync(
    fileURLToPath(new URL('../src/ui/main.js', import.meta.url)), 'utf8',
  );

  it('poses tools on technique-local time, not polish time', () => {
    const call = mainSrc.match(/posedMagnets\([^)]*\)/s);
    expect(call, 'main.js should pose its magnets').not.toBeNull();
    expect(call[0]).toContain('startTime');
    expect(call[0]).not.toMatch(/state\.sim\.t\s*[,)]/);
  });

  it('ages the polish on polish time', () => {
    // ...and the other way round for viscosity: the coat does not get younger
    // because a new take started.
    expect(mainSrc).toMatch(/flakes\.t\s*=\s*state\.sim\.t\b/);
  });
});

describe('every scene is reachable on a real hand', () => {
  // The rule that catches the class of bug where a preset quietly puts a
  // magnet inside the finger. Opting out is allowed but has to be declared.
  it.each(PRESET_KEYS)('%s keeps its tools out of the finger', (key) => {
    const p = PRESETS[key];
    const { nail, magnets } = p.build();
    const worst = Math.min(...magnets.map((m) => fingerClearance(nail, m)));
    if (p.finger === false) {
      // Declared thought experiments must SAY so where the user will see it.
      expect(p.label.toLowerCase()).toMatch(/not reachable|thought experiment/);
      return;
    }
    expect(worst, `${key}: ${worst.toFixed(1)} mm into the finger`)
      .toBeGreaterThan(0);
  });

  it.each(TECHNIQUE_KEYS)('%s keeps its tools out of the finger, throughout', (key) => {
    // A technique has to clear the finger at EVERY instant, not just at the
    // pose it was authored in - a scripted move can walk a tool into the hand.
    const t = TECHNIQUES[key];
    const { nail, magnets } = t.build();
    for (let i = 0; i <= 40; i++) {
      const time = (i / 40) * t.duration;
      for (const m of posedMagnets(magnets, nail, time)) {
        expect(fingerClearance(nail, m), `${key} at t=${time.toFixed(1)}s`)
          .toBeGreaterThan(0);
      }
    }
  });
});

describe('a scripted tool can still be dragged', () => {
  // The gizmo necessarily rides the POSED magnet, so a drag reports the posed
  // transform. Storing that as the authored pose makes the script re-apply its
  // own offset every frame, and the tool spirals away from the pointer. These
  // pin the inverse that prevents it.

  const nail = createNail();
  const frame = nailFrame(nail);
  const base = createMagnet({
    type: 'box',
    position: [1.5, -2, 12],
    quaternion: quatFromAxisAngle([0, 1, 0], 0.4),
  });

  const kinds = MOTION_KINDS.filter((k) => k !== 'still');

  it.each(kinds)('unpose inverts pose exactly: %s', (kind) => {
    const motion = defaultMotion(kind);
    for (const t of [0, 0.17, 1, 2.5, 7.3]) {
      const posed = motionPose(motion, t, base, frame);
      const back = unposeMagnet(
        motion, t, frame, posed.position, posed.quaternion,
      );
      for (let i = 0; i < 3; i++) {
        expect(back.position[i], `${kind} @ ${t}s, axis ${i}`)
          .toBeCloseTo(base.position[i], 9);
      }
      // q and -q are the same rotation, so compare up to sign.
      const s = Math.sign(back.quaternion[3] * base.quaternion[3]) || 1;
      for (let i = 0; i < 4; i++) {
        expect(s * back.quaternion[i], `${kind} @ ${t}s, quat ${i}`)
          .toBeCloseTo(base.quaternion[i], 9);
      }
    }
  });

  it.each(kinds)('dragging does not compound frame over frame: %s', (kind) => {
    // The actual bug: re-posing what a drag stored, over and over, used to add
    // one offset per frame. Held still, the shown pose must not drift.
    const motion = defaultMotion(kind);
    const t = 1.4;
    const m = { ...base };
    const shown = motionPose(motion, t, m, frame).position;

    for (let frameNo = 0; frameNo < 120; frameNo++) {
      const posed = motionPose(motion, t, m, frame);
      const stored = unposeMagnet(
        motion, t, frame, posed.position, posed.quaternion,
      );
      m.position = stored.position;
      m.quaternion = stored.quaternion;
    }

    const after = motionPose(motion, t, m, frame).position;
    for (let i = 0; i < 3; i++) {
      expect(after[i], `${kind} drifted on axis ${i}`).toBeCloseTo(shown[i], 8);
    }
  });

  it('a drag moves the orbit centre, so the circle follows the hand', () => {
    const motion = defaultMotion('orbit');
    const t = 0.6;
    const posed = motionPose(motion, t, base, frame);
    // Pointer drags the tool 3 mm across the nail.
    const dragged = [posed.position[0] + 3, posed.position[1], posed.position[2]];
    const stored = unposeMagnet(motion, t, frame, dragged, posed.quaternion);

    expect(stored.position[0]).toBeCloseTo(base.position[0] + 3, 9);
    expect(stored.position[1]).toBeCloseTo(base.position[1], 9);
    // ...and the orbit is still an orbit of the same radius about the new centre.
    const r0 = Math.hypot(
      posed.position[0] - base.position[0], posed.position[1] - base.position[1],
      posed.position[2] - base.position[2],
    );
    const p1 = motionPose(motion, t, stored, frame);
    const r1 = Math.hypot(
      p1.position[0] - stored.position[0], p1.position[1] - stored.position[1],
      p1.position[2] - stored.position[2],
    );
    expect(r1).toBeCloseTo(r0, 9);
  });
});

describe('the glass bead only survives if the tool is taken away', () => {
  // The bead is a fanned-out ensemble held in place by nothing. Stop turning
  // but leave the magnet there and its field simply re-combs the pile: the
  // orientation ODE is contracting, so order climbs back to where it started.
  // Measured, that takes about four seconds - and the polish does not set for
  // another thirty, so setting cannot rescue it. Lifting the tool leaves no
  // torque at all, which is the only thing that makes the bead permanent.

  const T = TECHNIQUES.glassBeadSpin;

  function orderAfter({ spinFor, thenFor, lift }) {
    const { nail, magnets } = T.build();
    const grid = buildNailGrid({ ...nail, ...RES });
    const flakes = createFlakes(grid, { perTexel: 16 });
    const polish = { ...T.polish };
    const dt = 0.02;
    const spun = magnets.map((m) => ({ ...m, active: undefined }));
    const still = spun.map((m) => ({ ...m, motion: null }));

    let t = 0;
    const step = (mags) => {
      const field = sampleGrid(grid, buildFaces(mags));
      flakes.t = T.startTime + t;
      stepFlakes(flakes, grid, field.B, field.bmag, polish, dt);
      t += dt;
    };
    for (let s = 0; s < Math.round(spinFor / dt); s++) {
      step(posedMagnets(spun, nail, t));
    }
    const duringSpin = computeFinish(grid, buildFaces([]), {
      director: flakes.director, order: flakes.order,
    }).stats.meanOrder;

    const after = lift ? [] : posedMagnets(still, nail, t);
    for (let s = 0; s < Math.round(thenFor / dt); s++) step(after);
    const ended = computeFinish(grid, buildFaces([]), {
      director: flakes.director, order: flakes.order,
    }).stats.meanOrder;

    return { duringSpin, ended };
  }

  it('a tool left in place re-combs the pile and erases the bead', () => {
    const { duringSpin, ended } = orderAfter({ spinFor: 8, thenFor: 6, lift: false });
    expect(duringSpin).toBeLessThan(0.8);      // the bead formed
    expect(ended).toBeGreaterThan(0.97);       // ...and then it did not survive
    expect(ended - duringSpin).toBeGreaterThan(0.2);
  });

  it('lifting the tool freezes the scatter, with no field left to undo it', () => {
    const { duringSpin, ended } = orderAfter({ spinFor: 8, thenFor: 6, lift: true });
    expect(duringSpin).toBeLessThan(0.8);
    // Not bit-exact: renormalising the directors each step drifts by ~1e-4 over
    // six seconds. That is float housekeeping, not torque - the point is that
    // it is three orders of magnitude below what leaving the tool there costs.
    expect(Math.abs(ended - duringSpin)).toBeLessThan(1e-3);
  });

  it('both glass-bead techniques put their tool down when the take ends', () => {
    // The regression this guards: without an `active` window the tool sits on
    // the nail for ever, and the finish you are shown is a plain cat eye.
    for (const key of ['glassBeadSpin', 'glassBeadOrbit']) {
      const t = TECHNIQUES[key];
      const { nail, magnets } = t.build();
      expect(magnets.some((m) => m.active), `${key} never lifts its tool`).toBe(true);
      const afterTake = posedMagnets(magnets, nail, t.duration + 0.5);
      expect(afterTake, `${key} still holds a tool after the take`).toHaveLength(0);
    }
  });
});
