// Where the movable light sits, and the track it travels.
//
// Three paths:
//
//   linear  a straight line at fixed height. What a strip light or a window
//           does, and the textbook way to read a mirror array's curvature:
//           translate the source and watch which way the highlight runs. A
//           convex array (magnet below) moves its sheen with the source; a
//           concave one (magnet above) moves it against.
//   sweep   an arc, rocking back and forth about a chosen azimuth.
//   orbit   the same arc taken all the way round.
//
// Azimuth is measured FROM THE FREE EDGE: 0 puts the light straight out in
// front of the nail tip, +/-pi behind the cuticle, +/-pi/2 out to the sides.
// `distance` is the horizontal radius only, so distance 0 with a positive
// height puts the light directly overhead.

export const wrapPi = (x) => {
  const t = (x + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};

/**
 * @param {object} L      light settings
 * @param {number[]} c    nail centre in world space
 * @param {number} param  azimuth in radians for the arc modes, or a normalised
 *                        -1..1 position along the line for the linear one
 */
export function lightPosition(L, c, param) {
  if (L.mode === 'linear') {
    const dx = Math.cos(L.lineAngle);
    const dy = Math.sin(L.lineAngle);
    const s = param * L.travel;
    // Travel along (dx, dy), offset sideways along the perpendicular (-dy, dx).
    return [
      c[0] + dx * s - dy * L.lineOffset,
      c[1] + dy * s + dx * L.lineOffset,
      c[2] + L.height,
    ];
  }
  return [
    c[0] + Math.sin(param) * L.distance,
    c[1] + Math.cos(param) * L.distance,
    c[2] + L.height,
  ];
}

/** The mode's parameter at normalised path position u in [-1, 1]. */
export function lightParamAt(L, u) {
  if (L.mode === 'linear') return u;
  if (L.mode === 'orbit') return u * Math.PI;
  return wrapPi(L.centre + u * L.sweep);
}

/** Advance the animation and return the mode's current parameter. */
export function stepLight(L, dt) {
  if (!L.auto) return L.mode === 'linear' ? L.linearT : L.azimuth;

  L.phase = wrapPi(L.phase + dt * L.speed);
  // Orbit runs all the way round; the other two rock back and forth.
  const u = L.mode === 'orbit' ? L.phase / Math.PI : Math.sin(L.phase);

  if (L.mode === 'linear') {
    L.linearT = u;
    return u;
  }
  L.azimuth = lightParamAt(L, u);
  return L.azimuth;
}
