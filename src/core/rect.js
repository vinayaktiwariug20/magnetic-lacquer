// Field of a uniformly *magnetically charged* rectangle (a pole face).
//
// Surface-charge (Gilbert) model: a uniformly magnetised body of magnetisation
// M is equivalent to a magnetic surface charge sigma_m = M . n on its boundary.
// For a magnet magnetised along its local +z, only the two +/-z faces carry
// charge, so a cuboid magnet is exactly two uniformly charged rectangles.
//
// The field of such a sheet is
//
//     B(r) = (mu0 * sigma_m / 4pi) * INT (r - r') / |r - r'|^3 dA'
//
// and we carry the combination `sigmaB = mu0 * sigma_m` (in tesla) around
// directly, because for a face whose normal is parallel to M it is exactly the
// remanence Br. So a Br = 1.30 T magnet has sigmaB = +1.30 on its north face
// and -1.30 on its south face. No mu0 ever appears in the field path.
//
// CLOSED FORM
// -----------
// Rectangle in the local z = 0 plane spanning x in [x1,x2], y in [y1,y2].
// Substituting u = x - x', v = y - y' turns the double integral into a
// separable one whose antiderivative is elementary. Writing
//
//     R = sqrt(u^2 + v^2 + z^2)
//
// the antiderivatives are
//
//     Bx <- -ln(v + R)          By <- -ln(u + R)          Bz <- atan(u*v/(z*R))
//
// each evaluated as the usual double difference over the four corners:
//
//     F(u1,v1) - F(u1,v2) - F(u2,v1) + F(u2,v2)
//
// NUMERICAL NOTE
// --------------
// -ln(v + R) is catastrophically cancellation-prone for v << 0 (where v + R
// -> 0). We use the algebraically identical
//
//     -ln(v + R) = -asinh(v / sqrt(u^2 + z^2)) - ln(sqrt(u^2 + z^2))
//
// and drop the trailing term: it depends only on (u, z), so it cancels exactly
// in the v-difference. asinh is well conditioned for both signs, which is what
// lets the formula hold up right against the face and near the corners.
//
// The remaining true singularity is the rectangle's own edge (u = z = 0 with v
// straddling an edge), where the in-plane field genuinely diverges
// logarithmically. We floor the radical at EPS so callers get a large-but-
// finite number instead of NaN.
//
// The Bz antiderivative must be the PRINCIPAL branch atan(u*v/(z*R)), not
// atan2(u*v, z*R). The two agree only while z*R > 0; for z < 0 atan2 jumps a
// branch and the double difference picks up a spurious 2*pi, i.e. a constant
// offset of exactly sigmaB in Bz on the far side of the sheet. Written as
// atan(t) the ratio t simply runs off to +/-Inf as z -> 0, and atan takes the
// correct +/-pi/2 limit, which is what reproduces the sigmaB/2 surface value
// and the full sigmaB jump across the sheet.
//
// UNITS
// -----
// Scale invariant. Every argument to asinh/atan2 is a ratio of lengths, so
// lengths may be given in any consistent unit (this project uses millimetres)
// and B comes out in tesla.

const EPS = 1e-12;

/**
 * B field of a uniformly charged rectangle, in the rectangle's own frame.
 *
 * @param {number} sigmaB  mu0 * sigma_m, in tesla (= +/-Br for a pole face)
 * @param {number} x1,x2,y1,y2  rectangle extent in the local z=0 plane
 * @param {number} px,py,pz     field point in the local frame
 * @param {number[]} [out]      optional 3-array to accumulate into
 * @returns {number[]} out (or a fresh array) with B *added* to it
 */
export function rectFieldLocal(sigmaB, x1, x2, y1, y2, px, py, pz, out) {
  const o = out || [0, 0, 0];

  const us = [px - x1, px - x2];
  const vs = [py - y1, py - y2];
  const z = pz;
  const z2 = z * z;

  let bx = 0;
  let by = 0;
  let bz = 0;

  for (let i = 0; i < 2; i++) {
    const u = us[i];
    const u2 = u * u;
    for (let j = 0; j < 2; j++) {
      const v = vs[j];
      const s = i === j ? 1 : -1;

      const R = Math.sqrt(u2 + v * v + z2);

      // sqrt(u^2 + z^2) and sqrt(v^2 + z^2), floored off the edge singularity.
      const su = Math.sqrt(u2 + z2) || EPS;
      const sv = Math.sqrt(v * v + z2) || EPS;

      bx -= s * Math.asinh(v / su);
      by -= s * Math.asinh(u / sv);

      // atan(uv / (z*R)). Exactly ON the sheet we must return the PRINCIPAL
      // VALUE, not a one-sided limit: Bz jumps by sigmaB across the sheet, so
      // the value on it is the average of the two sides, which is zero for
      // this term (and correctly zero outside the rectangle too). Letting the
      // ratio run to +/-Inf instead would hand back whichever side the sign of
      // a floating-point zero happened to pick - and a sheet would then exert
      // a force on itself, which shows up the moment two magnets are stacked
      // face to face.
      bz += s * (z === 0 ? 0 : Math.atan((u * v) / (z * R)));
    }
  }

  const k = sigmaB / (4 * Math.PI);
  o[0] += k * bx;
  o[1] += k * by;
  o[2] += k * bz;
  return o;
}

/**
 * Same field, but for a rectangle placed arbitrarily in world space.
 *
 * @param {object} face  {sigmaB, center:[3], ex:[3], ey:[3], ez:[3], hx, hy}
 *   ex/ey span the face, ez is its (unit) normal, hx/hy are half-extents.
 * @param {number[]} p    world-space field point
 * @param {number[]} [out]
 */
export function rectFieldWorld(face, p, out) {
  const o = out || [0, 0, 0];
  const { center, ex, ey, ez } = face;

  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  const dz = p[2] - center[2];

  // World -> face local (the basis is orthonormal, so transpose = inverse).
  const lx = dx * ex[0] + dy * ex[1] + dz * ex[2];
  const ly = dx * ey[0] + dy * ey[1] + dz * ey[2];
  const lz = dx * ez[0] + dy * ez[1] + dz * ez[2];

  const b = rectFieldLocal(
    face.sigmaB,
    -face.hx, face.hx,
    -face.hy, face.hy,
    lx, ly, lz,
    [0, 0, 0],
  );

  // Face local -> world.
  o[0] += b[0] * ex[0] + b[1] * ey[0] + b[2] * ez[0];
  o[1] += b[0] * ex[1] + b[1] * ey[1] + b[2] * ez[1];
  o[2] += b[0] * ex[2] + b[1] * ey[2] + b[2] * ez[2];
  return o;
}
