// The movable light's path.
//
// Regression: the light used to be pinned to the cuticle side of the nail. The
// azimuth slider was capped at +/-1.6 rad and the position was
// y = -cos(a) * distance * 0.55, so cos(a) never fell below -0.03 and there was
// no setting that put the light in front of the free edge.

import { describe, it, expect } from 'vitest';
import {
  lightPosition, lightParamAt, stepLight, wrapPi,
} from '../src/core/lightPath.js';

const base = {
  mode: 'sweep', distance: 60, height: 40, auto: true, speed: 1,
  sweep: 2.4, centre: 0, phase: 0, azimuth: 0,
  lineAngle: 0, lineOffset: 0, travel: 70, linearT: 0,
};
const C = [0, 0, 0];
const L = (o) => ({ ...base, ...o });

describe('wrapPi', () => {
  it('maps into [-pi, pi]', () => {
    for (const x of [0, 1, 3.5, 7, -7, 100, -100]) {
      const w = wrapPi(x);
      expect(w).toBeGreaterThanOrEqual(-Math.PI - 1e-12);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-12);
      expect(Math.abs(Math.sin(w) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(Math.cos(w) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });
});

describe('arc paths', () => {
  it('azimuth 0 puts the light in front of the free edge (+Y)', () => {
    const p = lightPosition(L({}), C, 0);
    expect(p[1]).toBeCloseTo(60, 9);
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[2]).toBeCloseTo(40, 9);
  });

  it('azimuth +/-pi puts it behind the cuticle, +/-pi/2 out to the sides', () => {
    expect(lightPosition(L({}), C, Math.PI)[1]).toBeCloseTo(-60, 9);
    expect(lightPosition(L({}), C, Math.PI / 2)[0]).toBeCloseTo(60, 9);
    expect(lightPosition(L({}), C, -Math.PI / 2)[0]).toBeCloseTo(-60, 9);
  });

  it('the sweep actually reaches in FRONT of the free edge', () => {
    // The whole point of the fix. Run a full sweep cycle and check the light
    // spends real time on the +Y side.
    const l = L({ mode: 'sweep', sweep: 2.4, centre: 0 });
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < 2000; i++) {
      const p = lightPosition(l, C, stepLight(l, 0.01));
      maxY = Math.max(maxY, p[1]);
      minY = Math.min(minY, p[1]);
    }
    expect(maxY).toBeGreaterThan(50);   // well in front of the free edge
    expect(minY).toBeLessThan(-40);     // and well behind the cuticle
  });

  it('orbit covers the whole circle', () => {
    const l = L({ mode: 'orbit' });
    let maxX = -Infinity; let minX = Infinity;
    let maxY = -Infinity; let minY = Infinity;
    for (let i = 0; i < 4000; i++) {
      const p = lightPosition(l, C, stepLight(l, 0.01));
      maxX = Math.max(maxX, p[0]); minX = Math.min(minX, p[0]);
      maxY = Math.max(maxY, p[1]); minY = Math.min(minY, p[1]);
    }
    for (const v of [maxX, maxY]) expect(v).toBeGreaterThan(59);
    for (const v of [minX, minY]) expect(v).toBeLessThan(-59);
  });

  it('the orbit is a circle, not a squashed ellipse', () => {
    // The old code multiplied Y by 0.55.
    const l = L({});
    for (const a of [0, 0.4, 1.1, 2.0, -2.7, Math.PI]) {
      const p = lightPosition(l, C, a);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(60, 9);
    }
  });

  it('distance 0 puts the light directly overhead', () => {
    const p = lightPosition(L({ distance: 0 }), C, 1.234);
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[1]).toBeCloseTo(0, 12);
    expect(p[2]).toBeCloseTo(40, 12);
  });
});

describe('linear path', () => {
  it('travels along a straight line at constant height', () => {
    const l = L({ mode: 'linear', lineAngle: 0, lineOffset: 0, travel: 70 });
    const pts = [-1, -0.5, 0, 0.5, 1].map((t) => lightPosition(l, C, t));
    for (const p of pts) {
      expect(p[1]).toBeCloseTo(0, 12);   // no drift off the line
      expect(p[2]).toBeCloseTo(40, 12);  // constant height
    }
    expect(pts[0][0]).toBeCloseTo(-70, 12);
    expect(pts[4][0]).toBeCloseTo(70, 12);

    // Evenly spaced: it is a line, not an arc.
    const dx = pts.map((p) => p[0]);
    for (let i = 2; i < dx.length; i++) {
      expect(dx[i] - dx[i - 1]).toBeCloseTo(dx[i - 1] - dx[i - 2], 9);
    }
  });

  it('lineAngle turns the travel direction', () => {
    const l = L({ mode: 'linear', lineAngle: Math.PI / 2, travel: 50 });
    const p = lightPosition(l, C, 1);
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(50, 9); // now travelling along the nail
  });

  it('lineOffset shifts the line sideways, perpendicular to travel', () => {
    const l = L({ mode: 'linear', lineAngle: 0, lineOffset: 25, travel: 70 });
    for (const t of [-1, 0, 1]) {
      expect(lightPosition(l, C, t)[1]).toBeCloseTo(25, 9);
    }
    // Offset is perpendicular, so it does not shorten the travel.
    expect(lightPosition(l, C, 1)[0]).toBeCloseTo(70, 9);
  });

  it('offset 0 passes directly over the nail centre', () => {
    const l = L({ mode: 'linear', lineOffset: 0 });
    const p = lightPosition(l, C, 0);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(0, 12);
  });

  it('auto travel rocks between the two ends and stays on the line', () => {
    const l = L({ mode: 'linear', travel: 70, lineOffset: 0, speed: 1 });
    let maxX = -Infinity; let minX = Infinity;
    for (let i = 0; i < 2000; i++) {
      const p = lightPosition(l, C, stepLight(l, 0.01));
      expect(p[1]).toBeCloseTo(0, 9);
      expect(p[2]).toBeCloseTo(40, 9);
      maxX = Math.max(maxX, p[0]); minX = Math.min(minX, p[0]);
    }
    expect(maxX).toBeCloseTo(70, 1);
    expect(minX).toBeCloseTo(-70, 1);
  });

  it('the drawn path agrees with where the light actually goes', () => {
    // Both go through lightPosition/lightParamAt, so the helper cannot drift.
    for (const mode of ['linear', 'sweep', 'orbit']) {
      const l = L({ mode, auto: true, speed: 1 });
      const path = [];
      for (let i = 0; i < 128; i++) {
        const u = (i / 127) * 2 - 1;
        path.push(lightPosition(l, C, lightParamAt(l, u)));
      }
      // Every sampled light position must lie on the drawn path.
      for (let i = 0; i < 400; i++) {
        const p = lightPosition(l, C, stepLight(l, 0.02));
        const near = Math.min(...path.map(
          (q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]),
        ));
        expect(near, `${mode}: light left its drawn path`).toBeLessThan(2);
      }
    }
  });

  it('manual mode holds position', () => {
    const l = L({ mode: 'linear', auto: false, linearT: 0.4 });
    expect(stepLight(l, 0.5)).toBe(0.4);
    expect(stepLight(l, 0.5)).toBe(0.4);
  });
});
