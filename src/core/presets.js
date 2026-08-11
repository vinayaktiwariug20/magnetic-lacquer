// Scene presets.
//
// World convention: +Z is up, the nail sits near the origin with its normal
// pointing +Z, its length along +Y (free edge toward +Y) and its width along X.
//
// THREE FINISHES, ONE POLISH. What separates them is the SHAPE of the field
// over the nail, not the polish and often not even the tool.
//
//   CAT EYE         The pile CHANGES direction across the nail. The tool
//                   presents both poles to the plate side by side, and the
//                   field arcs from one to the other: flat along the surface on
//                   the seam - flakes lie down and mirror, giving the bright
//                   line - and curling up out of the plate either side, where
//                   the pile stands and goes dark. Rotate the tool and the line
//                   rotates with it. Held CLOSE, for a crisp line.
//
//   VELVET          The pile does NOT change direction: one uniform nap lying
//                   flat across the whole nail, so the sheen blooms evenly
//                   instead of pinching into a line. The standard tool is a
//                   HORSESHOE with the finger sitting in the gap - the field
//                   crosses the plate uniformly, so every flake lies the same
//                   way. Anything that makes the field uniform over the plate
//                   rather than structured will do it.
//
//   REVERSE VELVET  The pile stands PERPENDICULAR to the plate, uniformly. You
//                   look down the ends of the flakes, so there is no sheen at
//                   ordinary angles and the base coat reads through; only a
//                   grazing view flares. The usual tool is a horseshoe turned a
//                   quarter turn, and measured against a finger it is a poor
//                   one - its gap has to clear the whole fingertip, so the nail
//                   can never sit near the middle of it. Two discs pinching the
//                   fingertip do better on every count. Whatever the tool, the
//                   nail's own arch sets a floor: a field going straight down
//                   is 29 degrees off the normal at the sidewall, no matter how
//                   uniform it is.
//
// The `pile parallelism` readout is the number that separates them: small means
// one uniform nap (velvet family), large means the pile is turning across the
// nail (cat eye family).
//
// REACHABILITY. A preset must place its tools where a hand could actually hold
// them - outside the finger. That sounds obvious and it is easy to get wrong,
// because the nail is a thin shell and "just under the plate" is inside the
// flesh. Every preset here is checked against the finger capsule by
// fingerClearance(), and the check is part of the test suite.
//
// A preset may set `finger: false` to opt out, and exactly one does. That is
// not a licence to ignore the geometry: it marks a scene as a THOUGHT
// EXPERIMENT that is there to isolate a piece of physics and could not be
// performed on a real hand. The label says so.

import { createMagnet } from './magnet.js';
import { createNail } from './nail.js';
import { quatFromAxisAngle, quatIdentity } from './vec.js';

/** A cat-eye wand: two bars of opposite polarity, seam down the middle. */
function wand(opts) {
  return createMagnet({
    type: 'array',
    name: 'cat-eye wand',
    size: { nx: 2, ny: 1, pattern: 'stripe', ...opts.size },
    position: opts.position,
    quaternion: opts.quaternion ?? quatIdentity(),
    Br: opts.Br ?? 1.3,
  });
}

const standardNail = () => createNail({
  position: [0, 0, 0], transverseCurv: 0.085, longitudinalCurv: 0.018,
});

export const PRESETS = {
  catEye: {
    label: 'Classic cat eye (lengthwise)',
    note: 'Two opposite poles side by side, seam running down the nail. The '
        + 'field ARCS from one pole to the other across the plate: flat along '
        + 'the surface on the seam, so the flakes lie down and mirror - that is '
        + 'the bright line - and curling up out of the surface toward the '
        + 'edges, where the pile stands on end and goes dark. With the wand '
        + 'above, the standing flakes lean away from the seam: a concave array, '
        + 'so the sheen sweeps AGAINST the light. Select the magnet and press E '
        + 'to rotate the seam - the line follows it.',
    build: () => ({
      nail: standardNail(),
      magnets: [wand({
        size: { cellX: 7, cellY: 26, height: 5 },
        position: [0, 0, 7],
      })],
    }),
  },

  catEyeAcross: {
    label: 'Cat eye, seam turned across the nail',
    note: 'The same wand rotated a quarter turn. Nothing else changed - but the '
        + 'N-to-S transition now runs across the nail, so the bright line does '
        + 'too. This is the control that sets the orientation of the sheen.',
    build: () => ({
      nail: standardNail(),
      magnets: [wand({
        size: { cellX: 9, cellY: 20, height: 5 },
        position: [0, 0, 7],
        quaternion: quatFromAxisAngle([0, 0, 1], Math.PI / 2),
      })],
    }),
  },

  catEyeBelow: {
    label: 'Cat eye from below (convex fan) — a thought experiment: '
         + 'the wand has to be inside the finger',
    finger: false,
    note: 'A THOUGHT EXPERIMENT, and the only scene here that is - but not for '
        + 'the reason you might expect. Putting a magnet UNDER the finger is '
        + 'perfectly easy: you rest your fingertip on it. What you cannot do is '
        + 'get it CLOSE. A fingertip is 18 mm thick, so the pad puts the wand '
        + 'about 21 mm from the plate, and the convex fan does not survive '
        + 'that far. Measured with this tool: convex at 7.3 deg/mm at 8 mm '
        + 'down, 0.4 at 19 mm, flat at 20 mm, and CONCAVE from 21 mm - which is '
        + 'almost exactly where the arrangement becomes buildable. The effect '
        + 'expires within a millimetre or two of where the geometry allows it. '
        + 'A stronger magnet does not help, and cannot: multiplying every '
        + 'source by a constant scales |B| everywhere and changes its DIRECTION '
        + 'nowhere, so the fan gradient is identical at Br = 1.3 and Br = 20. '
        + 'Only geometry moves it. Tightening the pole spacing does restore '
        + 'convexity from below - but reach falls as exp(-2 pi z / lambda), so '
        + 'a 3 mm pitch at the pad delivers 1.5 mT and combs nothing. From '
        + 'below you can have the convex fan or you can have enough field; the '
        + 'pole spacing sets both, in opposite directions. '
        + 'It earns its place because it isolates one variable - which '
        + 'side of the plate the field arcs through - and shows that the sheen '
        + 'reversal follows from that alone. '
        + 'The same wand underneath the nail. The field still arcs from one pole '
        + 'to the other across the plate - flat on the seam, curling up out of '
        + 'the surface toward the edges - but now the arc bows UP through the '
        + 'nail instead of dipping down through it. The standing flakes lean '
        + 'toward the seam rather than away from it, which makes the array '
        + 'convex instead of concave, and the sheen sweeps WITH the light. '
        + 'Switch between this and the lengthwise cat eye with the light on '
        + 'auto to watch the reversal.',
    build: () => ({
      nail: standardNail(),
      magnets: [wand({
        size: { cellX: 7, cellY: 26, height: 5 },
        position: [0, 0, -7],
      })],
    }),
  },

  reverseVelvet: {
    label: 'Reverse velvet (horseshoe, quarter turn)',
    note: 'REVERSE VELVET, with the tool people actually use: the velvet '
        + 'horseshoe turned a quarter turn so one pole sits above the nail and '
        + 'one below, and the field crosses straight THROUGH the plate. The pile '
        + 'stands rather than lying over, so you look down the ends of the '
        + 'flakes: little sheen at ordinary angles, the base coat reading '
        + 'through, and a flare at grazing view. '
        + 'It is also the hardest finish to get evenly, and this scene shows '
        + 'why. The gap has to clear the whole FINGERTIP, not just the nail - '
        + 'about 18 mm of it - so the gap cannot be small, and the nail ends up '
        + 'sitting well off the centre line of a gap it cannot be centred in. '
        + 'Searched over gap, leg length, leg width and placement, the best '
        + 'REACHABLE arrangement still leaves the pile 39 degrees off the normal '
        + 'with 18 degrees of spread. Compare the clamp preset, which gets to 21 '
        + 'and 6 with two ordinary discs. The awkwardness is geometry, not '
        + 'technique.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'horseshoe',
        name: 'horseshoe (quarter turn)',
        size: { legLength: 20, legWidth: 10, depth: 18, gap: 30, yoke: 8 },
        // -pi/2 about Y lays the gap vertically. Centred on the FINGER rather
        // than on the nail: at the nail's own height the lower leg runs through
        // the flesh, which is what the original placement here did.
        position: [34, 0, -11],
        quaternion: quatFromAxisAngle([0, 1, 0], -Math.PI / 2),
        Br: 1.35,
      })],
    }),
  },

  reverseVelvetClamp: {
    label: 'Reverse velvet, done better (disc above and below)',
    note: 'The same finish from two ordinary discs pinching the fingertip - one '
        + 'over the nail, one pressed against the pad underneath - with their '
        + 'poles arranged so the field runs straight through the plate. This '
        + 'beats the quarter-turned horseshoe on every measure that matters: 244 '
        + 'mT against 109, and a field uniform to 6 degrees against 18. '
        + 'What is left is not the magnet\'s fault. The mean tilt sits around 21 '
        + 'degrees even though the field is uniform to 6, because the NAIL '
        + 'CURVES AWAY underneath a field that is going straight down - at this '
        + 'arch the surface normal at the edge is already 29 degrees off '
        + 'vertical. Perfect reverse velvet on a curved nail is impossible with '
        + 'any parallel field, which is exactly why the finish always shows some '
        + 'flare at the sidewalls.',
    build: () => ({
      nail: standardNail(),
      magnets: [
        createMagnet({
          type: 'cylinder', name: 'disc over the nail',
          size: { radius: 20, height: 8 }, position: [0, 0, 9], Br: 1.35,
        }),
        createMagnet({
          type: 'cylinder', name: 'disc under the pad',
          size: { radius: 20, height: 8 }, position: [0, -4, -30], Br: 1.35,
        }),
      ],
    }),
  },

  endBar: {
    label: 'End-magnetised bar across the nail',
    note: 'A bar with its poles at the two ENDS, laid across the nail. This is '
        + 'also an N-to-S transition, so it is a cat eye - but a weak one, only '
        + 'about 20 mT at the plate, because the poles are held off to the '
        + 'sides instead of down near the surface. Compare the readout with the '
        + 'wand presets.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'box',
        name: 'end-magnetised bar',
        // sz is the long axis, so this bar is magnetised end to end; rotating
        // local +Z onto world +X lays it across the nail.
        size: { sx: 5, sy: 5, sz: 22 },
        position: [0, 0, 8],
        quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
      })],
    }),
  },

  velvet: {
    label: 'Velvet (horseshoe, nail in the flat field)',
    note: 'VELVET. The nail sits in the pole-face plane of a strong horseshoe, '
        + 'where the field direction is uniform to a few degrees, so the flakes '
        + 'lie flat and all point the SAME way - one nap over the whole nail. '
        + 'That is the difference from a cat eye: there is no transition for a '
        + 'line to form on, so the sheen blooms evenly and the whole nail '
        + 'brightens and dims together as you tilt it. Watch the pile-'
        + 'parallelism readout.',
    build: () => ({
      nail: createNail({
        position: [0, 0, 0], transverseCurv: 0.07, longitudinalCurv: 0.015,
      }),
      // pi about Y puts the pole axis down and keeps the depth along the nail.
      magnets: [createMagnet({
        type: 'horseshoe',
        name: 'horseshoe',
        size: { legLength: 16, legWidth: 6, depth: 16, gap: 16, yoke: 6 },
        position: [0, 0, 22],
        quaternion: quatFromAxisAngle([0, 1, 0], Math.PI),
        Br: 1.35,
      })],
    }),
  },

  velvetWide: {
    label: 'Velvet with a wand instead (wider pull)',
    note: 'A second route to velvet, for comparison - the horseshoe above is the '
        + 'standard tool. Take the cat-eye wand, make it bigger and hold it back: '
        + 'the pull widens, the seam spreads over the whole plate and the pile '
        + 'stops turning. Drag it down toward the nail and watch the pile-'
        + 'parallelism readout climb as the velvet tightens back into a cat-eye '
        + 'line - the same tool giving both finishes. It never gets as uniform as '
        + 'the horseshoe (19 degrees against 8), and distance alone guts the '
        + 'field, which is why a wand used this way has to be a big one.',
    build: () => ({
      nail: standardNail(),
      magnets: [wand({
        size: { cellX: 26, cellY: 46, height: 12 },
        position: [0, 0, 14],
      })],
    }),
  },

  discUmbra: {
    label: 'Disc above: dark umbra, sheen on the rim',
    note: 'Another pole-facing-down arrangement, so another member of the '
        + 'reverse-velvet family. Directly under the disc the field is normal '
        + 'to the nail, the pile stands on end and the base coat reads through '
        + 'as a dark core. The field fans over near the rim, laying flakes down '
        + 'into a bright ring.',
    build: () => ({
      nail: createNail({
        position: [0, 0, 0], transverseCurv: 0.075, longitudinalCurv: 0.02,
      }),
      magnets: [createMagnet({
        type: 'cylinder',
        name: 'disc',
        size: { radius: 7, height: 4 },
        position: [0, 0, 7],
        quaternion: quatIdentity(),
      })],
    }),
  },

  halbachBore: {
    label: 'Halbach bore: torque without pull',
    note: 'A dipole Halbach cylinder with the finger inside the bore. The field '
        + 'is huge and almost perfectly uniform - about 400 mT with essentially '
        + 'ZERO gradient - which matters because it separates the two things a '
        + 'magnet does to a flake. Torque (m x B) rotates it; force (grad of '
        + 'm.B) drags it. Here there is torque and no drag, so the pile is the '
        + 'most uniform of any tool in the sandbox (about 1 degree of spread, '
        + 'against 9 for the horseshoe). If real magnetic polish is driven by '
        + 'orientation rather than particle migration, this should give a '
        + 'flawless velvet - which makes it a clean experiment, not just a '
        + 'preset.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'halbachCylinder',
        name: 'Halbach bore (dipole)',
        size: {
          outerRadius: 42, innerRadius: 26, height: 26, segments: 24, poles: 1,
        },
        position: [0, 0, 0],
        // The bore axis must run ALONG THE FINGER. Built with the axis on local
        // +Z it stood vertically, so the finger entered through the wall rather
        // than the bore - the scene claimed something its geometry did not do.
        // -pi/2 about X lays local +Z onto world +Y, which is the finger's axis.
        quaternion: quatFromAxisAngle([1, 0, 0], -Math.PI / 2),
      })],
    }),
  },

  halbachQuadrupole: {
    label: 'Halbach quadrupole: null in the middle',
    note: 'The same cylinder wound as a quadrupole. |B| is exactly zero at the '
        + 'centre and grows almost perfectly linearly outward (about 37 mT per '
        + 'mm), so the flakes are UNALIGNED in the middle and progressively '
        + 'ordered toward the edges. Watch the alignment-order channel: a dark '
        + 'disordered core ringed by sheen, with a four-fold twist from the '
        + 'field direction rotating around the null. Nothing else here produces '
        + 'a genuine field null over the nail.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'halbachCylinder',
        name: 'Halbach bore (quadrupole)',
        size: {
          outerRadius: 42, innerRadius: 26, height: 26, segments: 24, poles: 2,
        },
        position: [0, 0, 0],
        quaternion: quatFromAxisAngle([1, 0, 0], -Math.PI / 2),
      })],
    }),
  },

  halbachStripes: {
    label: 'Linear Halbach: rolling wave',
    note: 'A linear Halbach array under the nail. Its magnetisation turns a '
        + 'quarter turn per block, so the field DIRECTION rotates steadily '
        + 'across the plate while |B| stays nearly constant - measured at 22.7 '
        + 'deg/mm of rotation against 3 per cent variation in strength. The pile '
        + 'therefore rolls smoothly through flat-tilted-standing-tilted-flat '
        + 'instead of pinching into one line. The catch is baked into the '
        + 'physics: the reach falls off as exp(-2 pi z / lambda), so finer '
        + 'stripes must be held closer. At this 12 mm pitch the decay length is '
        + 'under 2 mm - raise the tool from 3 mm to 5 mm and the field over the '
        + 'plate falls from 432 mT to 151. Pitch and reach are not independent, '
        + 'which is why a finely striped tool is not a practical one.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'array',
        name: 'linear Halbach',
        size: { nx: 14, ny: 1, cellX: 3, cellY: 26, height: 4, pattern: 'halbach' },
        // ABOVE the nail. Under it is inside the finger, and a one-sided flux
        // tool does not care which way up it is held - reversing the handedness
        // swaps which face is the strong one, so the same array works from
        // either side. Held this way up the strong face points down: 256 mT
        // mean over the plate, against 8 mT for the wrong way round. That
        // 30-fold difference between the two faces IS the Halbach effect.
        position: [0, 0, 4],
      })],
    }),
  },

  cusp: {
    label: 'Like poles facing: a field null under the nail',
    note: 'Two magnets with their NORTH poles facing each other across a gap, '
        + 'nail in the middle. Unlike an N-S pair, the fields OPPOSE, creating a '
        + 'null with a separatrix through it - the direction swings through a '
        + 'full turn over a couple of millimetres. Flakes go unaligned at the '
        + 'null and fan hard around it, so you get a dark seam with high-'
        + 'contrast structure either side rather than a smooth line. The same '
        + 'configuration is validation Test 3, where the null is verified to '
        + 'better than 1e-12 T.',
    build: () => ({
      nail: standardNail(),
      // Straddling the fingertip SIDEWAYS rather than above and below. Facing
      // poles above and below would put the lower magnet inside the finger; two
      // magnets pinched either side of the tip is a thing a hand can actually
      // do, and it puts the null line right down the middle of the nail.
      magnets: [
        createMagnet({
          type: 'box', name: 'left (N inward)',
          size: { sx: 18, sy: 18, sz: 8 }, position: [-15, 0, 0],
          quaternion: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
        }),
        createMagnet({
          type: 'box', name: 'right (N inward)',
          size: { sx: 18, sy: 18, sz: 8 }, position: [15, 0, 0],
          quaternion: quatFromAxisAngle([0, 1, 0], -Math.PI / 2),
        }),
      ],
    }),
  },

  sphere: {
    label: 'Sphere: the clean reference magnet',
    note: 'A uniformly magnetised sphere, held over the nail. Outside it the '
        + 'field is EXACTLY a point dipole - the only magnet here needing no '
        + 'surface integral at all - and it has no edges or corners, so the '
        + 'direction turns smoothly everywhere instead of breaking at a pole-'
        + 'face rim. That makes it both the natural reference for checking the '
        + 'solver and a source of unusually soft, rounded highlights.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'sphere', name: 'sphere', size: { radius: 7 }, position: [0, 0, 9],
      })],
    }),
  },

  heartTool: {
    label: 'The "heart magnet": a steel V, and the heart it draws',
    note: 'The viral one, and the only scene here whose tool is not a magnet. '
        + 'The barrel is a plain cylinder; the thin V in front of it is SOFT '
        + 'IRON, with no field of its own until the cylinder induces one. Its '
        + 'magnetisation is solved rather than prescribed - see softIron.js - '
        + 'and only then does it act as a source. '
        + 'The point of the scene is that the wire is bent into a V and what '
        + 'lands on the nail is a HEART. The pattern is not the tool\'s outline '
        + 'redrawn: it is a level set of the field, and the level set of two '
        + 'angled poles happens to be heart-shaped - two arms with a dark cleft '
        + 'straight down the middle, closing to a single bright point below. '
        + 'Switch the wire\'s shape to `heart` and it gets WORSE, not better: a '
        + 'closed loop fills its own middle and reads as a bright disc. Bending '
        + 'the wire into the shape you want is the wrong intuition, which is '
        + 'why these tools look so odd in the packet. '
        + 'Watch the readout: with 0.8 mm wire every cell saturates, so a '
        + 'stronger barrel buys nothing. Thicker wire carries more flux and '
        + 'blurs the pattern; thinner draws a sharper one and delivers less.',
    build: () => ({
      nail: standardNail(),
      magnets: [
        createMagnet({
          type: 'wire',
          name: 'steel V (soft iron)',
          iron: true,
          Br: 0,
          cellSize: 0.7,
          // 6.5 mm across a 12 mm nail. At 10 the pattern runs to the
          // sidewalls; this leaves it centred with margin, which is where
          // the real ones sit.
          size: { shape: 'vee', scale: 6.5, thickness: 0.8 },
          position: [0, 0, 0.9],
        }),
        createMagnet({
          type: 'cylinder',
          name: 'barrel magnet',
          size: { radius: 5, height: 14 },
          position: [0, 0, 16],
        }),
      ],
    }),
  },

  striped: {
    label: 'Pre-patterned striped tool',
    note: 'The same idea as the wand, repeated: a tool of alternating polarity '
        + 'strips presents several N-to-S transitions at once, so you get a '
        + 'repeating set of parallel velvet lines instead of a single one.',
    build: () => ({
      nail: createNail({
        position: [0, 0, 0], transverseCurv: 0.08, longitudinalCurv: 0.018,
      }),
      magnets: [createMagnet({
        type: 'array',
        name: 'striped tool',
        size: { nx: 7, ny: 1, cellX: 3, cellY: 18, height: 4, pattern: 'stripe' },
        position: [0, 0, 6],
        quaternion: quatIdentity(),
      })],
    }),
  },
};

export const PRESET_KEYS = Object.keys(PRESETS);
