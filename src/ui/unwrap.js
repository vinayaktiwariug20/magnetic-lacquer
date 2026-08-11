// The flattened "unwrapped nail" view.
//
// Same finish model as the 3D shader, but with a choice of viewpoint:
//
//   'head-on'  the eye sits directly over EVERY texel (V = N). Physically
//              impossible from any single vantage point, and deliberately so:
//              it removes the viewing geometry entirely and shows the pattern
//              the field has written into the pile. This is what you want when
//              comparing against a photo, or when checking that a bright line
//              really is a line rather than a highlight sweeping past.
//   'camera'   the real camera direction, so the panel matches what the 3D
//              viewport shows, just flattened out.
//
// The difference between the two is not a bug and is often large. Head-on, a
// nail whose flakes all lie flat and parallel looks evenly lit everywhere,
// because every texel is being viewed from its own ideal angle. From one real
// camera the same nail shows a gradient, because the Kajiya-Kay lobe is narrow
// and only a band of the surface satisfies it at once.

const RAMP = [
  [0.05, 0.03, 0.20], [0.13, 0.42, 0.66], [0.20, 0.72, 0.55],
  [0.85, 0.85, 0.22], [0.99, 0.99, 0.85],
];

function ramp(t) {
  t = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t));
  const f = t - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const srgb = (v) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2));

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} grid    from buildNailGrid
 * @param {object} finish  from computeFinish
 * @param {object} opts    {channel, lightPos, viewPos, base, sheen, flake,
 *                          sheenExp, sheenGain, coverPow, coverage,
 *                          concStrength, ambient}
 *   Pass `viewPos` to shade from a real camera; omit it for head-on.
 */
export function drawUnwrapped(canvas, grid, finish, opts) {
  const { nu, nv } = grid;
  const ctx = canvas.getContext('2d');

  const img = ctx.createImageData(nv, nu);
  const data = img.data;

  const span = finish.stats.max - finish.stats.min;
  const ch = opts.channel ?? 'shaded';

  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      const i = iu * nv + iv;
      // Flip u so the free edge lands at the top of the image.
      const px = ((nu - 1 - iu) * nv + iv) * 4;

      let r; let g; let b;

      if (ch === '|B|') {
        [r, g, b] = ramp(span > 1e-12 ? (finish.bmag[i] - finish.stats.min) / span : 0);
      } else if (ch === 'tilt') {
        [r, g, b] = ramp(finish.tilt[i] / 90);
      } else if (ch === 'concentration') {
        [r, g, b] = ramp(finish.conc[i]);
      } else if (ch === 'order') {
        [r, g, b] = ramp(finish.order[i]);
      } else if (ch === 'chain') {
        r = Math.abs(finish.chain[i * 3]);
        g = Math.abs(finish.chain[i * 3 + 1]);
        b = Math.abs(finish.chain[i * 3 + 2]);
      } else {
        [r, g, b] = shade(grid, finish, i, opts);
      }

      data[px] = srgb(r);
      data[px + 1] = srgb(g);
      data[px + 2] = srgb(b);
      data[px + 3] = 255;
    }
  }

  // Blit at grid resolution, then let the canvas scale it up smoothly.
  const tmp = document.createElement('canvas');
  tmp.width = nv;
  tmp.height = nu;
  tmp.getContext('2d').putImageData(img, 0, 0);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Preserve the nail's aspect ratio inside the canvas.
  const aspect = (grid.nail.width / grid.nail.length);
  let w = canvas.width;
  let h = w / aspect;
  if (h > canvas.height) { h = canvas.height; w = h * aspect; }
  ctx.drawImage(tmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

/** The Kajiya-Kay model again, in JS. See the header for the two viewpoints. */
function shade(grid, finish, i, o) {
  const nx = grid.normal[i * 3];
  const ny = grid.normal[i * 3 + 1];
  const nz = grid.normal[i * 3 + 2];

  const lx = o.lightPos[0] - grid.position[i * 3];
  const ly = o.lightPos[1] - grid.position[i * 3 + 1];
  const lz = o.lightPos[2] - grid.position[i * 3 + 2];
  const ll = Math.hypot(lx, ly, lz) || 1;
  const Lx = lx / ll; const Ly = ly / ll; const Lz = lz / ll;

  const tx = finish.chain[i * 3];
  const ty = finish.chain[i * 3 + 1];
  const tz = finish.chain[i * 3 + 2];

  // V is either the real camera direction, or the surface normal (head-on).
  let Vx = nx; let Vy = ny; let Vz = nz;
  if (o.viewPos) {
    const dx = o.viewPos[0] - grid.position[i * 3];
    const dy = o.viewPos[1] - grid.position[i * 3 + 1];
    const dz = o.viewPos[2] - grid.position[i * 3 + 2];
    const dl = Math.hypot(dx, dy, dz);
    if (dl > 1e-9) { Vx = dx / dl; Vy = dy / dl; Vz = dz / dl; }
  }

  const cosTV = tx * Vx + ty * Vy + tz * Vz;
  const cosTL = tx * Lx + ty * Ly + tz * Lz;
  const sinTV = Math.sqrt(Math.max(0, 1 - cosTV * cosTV));
  const sinTL = Math.sqrt(Math.max(0, 1 - cosTL * cosTL));

  const kk = Math.max(0, sinTL * sinTV - cosTL * cosTV);
  const spec = Math.pow(kk, o.sheenExp);

  const aim = Math.abs(cosTV);
  const cover = Math.min(1, Math.max(0,
    (1 - Math.pow(aim, o.coverPow)) * o.coverage * finish.order[i]));

  const cg = (1 - o.concStrength) + 2 * o.concStrength * finish.conc[i];
  const ndl = Math.max(0, nx * Lx + ny * Ly + nz * Lz);

  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const base = o.base[k] * (o.ambient + ndl);
    const flake = o.flake[k] * (o.ambient + ndl * 0.7) * cg;
    out[k] = base + (flake - base) * cover
      + o.sheen[k] * spec * finish.order[i] * cg * o.sheenGain;
  }
  return out;
}
