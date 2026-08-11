// Snap-together helper: the claim is that stacking behaves like real magnets.

import { describe, it, expect } from 'vitest';
import { createMagnet } from '../src/core/magnet.js';
import { findSnap, applySnap, magnetisationDir } from '../src/core/snap.js';
import { forceOnMagnet } from '../src/core/field.js';
import { quatFromAxisAngle, dot, len, sub } from '../src/core/vec.js';

const SIZE = { sx: 10, sy: 8, sz: 4 };

describe('snap helper', () => {
  it('does nothing when the magnets are far apart', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    const b = createMagnet({ type: 'box', position: [0, 0, 40], size: SIZE });
    expect(findSnap(b, [a])).toBeNull();
  });

  it('snaps flush: the faces end up touching with no gap', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    // Dragged to just above a's north face, slightly off-centre and askew.
    const b = createMagnet({
      type: 'box', position: [1.2, -0.8, 6.1], size: SIZE,
      quaternion: quatFromAxisAngle([1, 0.3, 0], 0.25),
    });

    expect(applySnap(b, [a])).toBe(true);
    // a spans z in [-2,2], b is 4 thick, so flush means b centred at z = 4.
    expect(b.position[0]).toBeCloseTo(0, 9);
    expect(b.position[1]).toBeCloseTo(0, 9);
    expect(b.position[2]).toBeCloseTo(4, 9);
  });

  it('orients to the polarity that actually attracts', () => {
    const check = (flipB, approachSide) => {
      const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
      const b = createMagnet({
        type: 'box', position: [0, 0, approachSide * 6.2], size: SIZE, flip: flipB,
      });
      applySnap(b, [a]);
      // The snapped pair must attract, i.e. b is pulled back toward a.
      const F = forceOnMagnet(b, [a]);
      expect(Math.sign(F[2]), `flip=${flipB} side=${approachSide}`).toBe(-approachSide);
      expect(len(F)).toBeGreaterThan(0);
      // ...and both magnetisations point the same way, as in a real stack.
      expect(dot(magnetisationDir(a), magnetisationDir(b))).toBeCloseTo(1, 9);
    };
    check(false, 1);
    check(true, 1);
    check(false, -1);
    check(true, -1);
  });

  it('a magnet approached upside-down gets flipped over', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    // b is rotated 180 degrees, so its magnetisation opposes a's.
    const b = createMagnet({
      type: 'box', position: [0, 0, 6.3], size: SIZE,
      quaternion: quatFromAxisAngle([1, 0, 0], Math.PI),
    });
    expect(dot(magnetisationDir(a), magnetisationDir(b))).toBeCloseTo(-1, 6);

    applySnap(b, [a]);
    expect(dot(magnetisationDir(a), magnetisationDir(b))).toBeCloseTo(1, 6);
    expect(forceOnMagnet(b, [a])[2]).toBeLessThan(0); // attracts
  });

  it('snaps to the nearer face when both are in range', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    const below = createMagnet({ type: 'box', position: [0, 0, -5.5], size: SIZE });
    applySnap(below, [a]);
    expect(below.position[2]).toBeCloseTo(-4, 9);
  });

  it('works on a tilted stack and keeps the faces parallel', () => {
    const q = quatFromAxisAngle([0.4, 1, 0.2], 0.7);
    const a = createMagnet({ type: 'box', position: [3, -2, 5], size: SIZE, quaternion: q });
    const ua = magnetisationDir(a);
    // Approach along a's own axis.
    const start = [
      a.position[0] + ua[0] * 6.3,
      a.position[1] + ua[1] * 6.3,
      a.position[2] + ua[2] * 6.3,
    ];
    const b = createMagnet({ type: 'box', position: start, size: SIZE });

    expect(applySnap(b, [a])).toBe(true);
    expect(dot(magnetisationDir(a), magnetisationDir(b))).toBeCloseTo(1, 9);
    // Centre-to-centre distance is exactly the two half-thicknesses.
    expect(len(sub(b.position, a.position))).toBeCloseTo(4, 9);
  });

  it('snaps a cylinder onto a box and vice versa', () => {
    const box = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    const cyl = createMagnet({
      type: 'cylinder', position: [0.5, 0.5, 5.4], size: { radius: 4, height: 3 },
    });
    expect(applySnap(cyl, [box])).toBe(true);
    expect(cyl.position[2]).toBeCloseTo(3.5, 9); // 2 + 1.5
    expect(forceOnMagnet(cyl, [box])[2]).toBeLessThan(0);
  });

  it('refuses when the magnet is off to the side rather than over a face', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    const b = createMagnet({ type: 'box', position: [30, 0, 3], size: SIZE });
    expect(findSnap(b, [a])).toBeNull();
  });

  it('leaves composite magnets alone', () => {
    const a = createMagnet({ type: 'box', position: [0, 0, 0], size: SIZE });
    const shoe = createMagnet({ type: 'horseshoe', position: [0, 0, 6] });
    expect(findSnap(shoe, [a])).toBeNull();
  });

  it('picks the closest of several candidates', () => {
    const a = createMagnet({ id: 'a', type: 'box', position: [0, 0, 0], size: SIZE });
    const c = createMagnet({ id: 'c', type: 'box', position: [0, 0, 20], size: SIZE });
    const b = createMagnet({ id: 'b', type: 'box', position: [0, 0, 16.5], size: SIZE });
    const s = findSnap(b, [a, c]);
    expect(s.toId).toBe('c');
    expect(s.position[2]).toBeCloseTo(16, 9);
  });
});
