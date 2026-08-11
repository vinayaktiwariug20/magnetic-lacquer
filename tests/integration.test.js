// End-to-end pipeline: presets and edits all the way through to the numbers the
// UI puts on screen. The browser layer cannot be tested headlessly, so this
// covers everything underneath it.

import { describe, it, expect } from 'vitest';
import { PRESETS, PRESET_KEYS } from '../src/core/presets.js';
import { buildNailGrid, createNail } from '../src/core/nail.js';
import { buildFaces } from '../src/core/field.js';
import { computeFinish } from '../src/core/finish.js';
import { createMagnet, MAGNET_TYPES, defaultSize } from '../src/core/magnet.js';
import { quatFromAxisAngle } from '../src/core/vec.js';

const RES = { resU: 40, resV: 28 };

function run(nail, magnets) {
  const grid = buildNailGrid({ ...nail, ...RES });
  return { grid, finish: computeFinish(grid, buildFaces(magnets)) };
}

function assertAllFinite(finish, grid, label) {
  const arrays = {
    bmag: finish.bmag, tilt: finish.tilt, conc: finish.conc,
    order: finish.order, signedTilt: finish.signedTilt,
  };
  for (const [name, a] of Object.entries(arrays)) {
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) {
        throw new Error(`${label}: ${name}[${i}] = ${a[i]}`);
      }
    }
  }
  for (let i = 0; i < grid.count * 3; i++) {
    expect(Number.isFinite(finish.chain[i]), `${label}: chain[${i}]`).toBe(true);
    expect(Number.isFinite(grid.position[i]), `${label}: position[${i}]`).toBe(true);
    expect(Number.isFinite(grid.normal[i]), `${label}: normal[${i}]`).toBe(true);
  }
  for (const [k, v] of Object.entries(finish.stats)) {
    if (k === 'fanKind') {
      expect(['convex', 'concave', 'flat'], label).toContain(v);
      continue;
    }
    if (k === 'focalLength') continue; // legitimately Infinity for a flat fan
    expect(Number.isFinite(v), `${label}: stats.${k} = ${v}`).toBe(true);
  }
}

describe('presets', () => {
  it.each(PRESET_KEYS)('%s solves to finite, in-range values', (key) => {
    const { nail, magnets } = PRESETS[key].build();
    expect(magnets.length).toBeGreaterThan(0);
    const { grid, finish } = run(nail, magnets);
    assertAllFinite(finish, grid, key);

    for (let i = 0; i < grid.count; i++) {
      expect(finish.tilt[i]).toBeGreaterThanOrEqual(0);
      expect(finish.tilt[i]).toBeLessThanOrEqual(90);
      expect(finish.order[i]).toBeGreaterThanOrEqual(0);
      expect(finish.order[i]).toBeLessThanOrEqual(1);
      expect(finish.conc[i]).toBeGreaterThanOrEqual(0);
      expect(finish.conc[i]).toBeLessThanOrEqual(1);
    }
    // Every preset should actually magnetise the nail SOMEWHERE. Not the centre
    // texel: the Halbach quadrupole puts an exact field null right there, which
    // is the entire point of that preset.
    expect(finish.stats.max).toBeGreaterThan(0.005);
    expect(PRESETS[key].label.length).toBeGreaterThan(0);
    expect(PRESETS[key].note.length).toBeGreaterThan(0);
  });

  it('chain directions are unit length', () => {
    const { nail, magnets } = PRESETS.catEye.build();
    const { grid, finish } = run(nail, magnets);
    for (let i = 0; i < grid.count; i++) {
      const l = Math.hypot(
        finish.chain[i * 3], finish.chain[i * 3 + 1], finish.chain[i * 3 + 2],
      );
      expect(l).toBeCloseTo(1, 5);
    }
  });

  it('the disc preset really does produce a dark core and a bright rim', () => {
    const { nail, magnets } = PRESETS.discUmbra.build();
    const { grid, finish } = run(nail, magnets);
    const mid = Math.floor(grid.nu / 2);
    const centre = mid * grid.nv + Math.floor(grid.nv / 2);
    const edge = mid * grid.nv;
    // Standing at the core, laid over at the edge.
    expect(finish.tilt[centre]).toBeLessThan(10);
    expect(finish.tilt[edge]).toBeGreaterThan(30);
  });
});

describe('magnet editing paths', () => {
  it('every magnet type builds faces and solves', () => {
    const nail = createNail();
    for (const type of MAGNET_TYPES) {
      const m = createMagnet({ type, position: [0, 0, 10] });
      expect(m.size).toEqual(defaultSize(type));
      const faces = buildFaces([m]);
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        if (f.kind === 'sphere') {
          // A sphere is closed form, not a charge sheet: no sigma, no normal.
          expect(Number.isFinite(f.Br)).toBe(true);
          expect(f.axis).toHaveLength(3);
          continue;
        }
        expect(Number.isFinite(f.sigmaB)).toBe(true);
        expect(f.outward).toHaveLength(3);
      }
      const { grid, finish } = run(nail, [m]);
      assertAllFinite(finish, grid, type);
    }
  });

  it('switching a magnet type mid-session keeps everything finite', () => {
    const nail = createNail();
    const m = createMagnet({ type: 'box', position: [0, 0, 9] });
    for (const type of ['cylinder', 'horseshoe', 'array', 'box']) {
      m.type = type;
      m.size = defaultSize(type); // what the GUI does on a type change
      const { grid, finish } = run(nail, [m]);
      assertAllFinite(finish, grid, `switched to ${type}`);
    }
  });

  it('disabled magnets contribute nothing', () => {
    const nail = createNail();
    const a = createMagnet({ type: 'box', position: [0, 0, 9] });
    const b = createMagnet({ type: 'box', position: [0, 0, -9], enabled: false });
    const only = run(nail, [a]).finish;
    const both = run(nail, [a, b]).finish;
    expect(both.stats.centre).toBeCloseTo(only.stats.centre, 12);
  });

  it('an empty scene is handled without blowing up', () => {
    const nail = createNail();
    const { grid, finish } = run(nail, []);
    assertAllFinite(finish, grid, 'empty');
    expect(finish.stats.max).toBe(0);
    expect(finish.stats.spreadPct).toBe(0);
    // With no field the pile stands along the normal by convention.
    expect(finish.stats.meanTilt).toBeCloseTo(0, 6);
    expect(finish.stats.meanOrder).toBe(0);
  });

  it('extreme nail geometry stays well formed', () => {
    const magnets = [createMagnet({ type: 'box', position: [0, 0, 9] })];
    const cases = [
      { transverseCurv: 0, longitudinalCurv: 0 },
      { transverseCurv: 0.2, longitudinalCurv: 0.08 },
      { length: 8, width: 6 },
      { length: 30, width: 22, taper: 0.4 },
      { position: [12, -6, 4], quaternion: quatFromAxisAngle([1, 0.4, 0.2], 0.9) },
    ];
    for (const c of cases) {
      const nail = createNail(c);
      const { grid, finish } = run(nail, magnets);
      assertAllFinite(finish, grid, JSON.stringify(c));
    }
  });

  it('a magnet touching the nail does not produce NaNs', () => {
    // The pole face lands right on the surface: the worst case for both field
    // kernels, and reachable by dragging.
    const nail = createNail({ transverseCurv: 0.09 });
    for (const type of ['box', 'cylinder']) {
      const m = createMagnet({ type, position: [0, 0, 1.5] });
      const { grid, finish } = run(nail, [m]);
      assertAllFinite(finish, grid, `${type} touching`);
    }
  });

  it('the concentration exponent slider spans its full range safely', () => {
    const { nail, magnets } = PRESETS.catEye.build();
    const grid = buildNailGrid({ ...nail, ...RES });
    const faces = buildFaces(magnets);
    for (const concExp of [0.2, 1, 2.2, 8]) {
      const f = computeFinish(grid, faces, { concExp });
      assertAllFinite(f, grid, `concExp=${concExp}`);
      expect(Math.min(...f.conc)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...f.conc)).toBeLessThanOrEqual(1);
    }
  });
});
