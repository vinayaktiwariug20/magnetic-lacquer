// Techniques: scenes with a TIME axis.
//
// A preset in presets.js is a still life - a tool parked somewhere and a pile
// that has settled under it. A technique is a performance: the tool moves, and
// sometimes gets picked up and put down, while the polish thickens underneath.
// Every one of these is something people describe doing, written down as
// geometry and timing so it can be tried before it is tried on a hand.
//
// ---------------------------------------------------------------------------
// WHY TIMING MATTERS AT ALL, AND WHEN IT DOES NOT
// ---------------------------------------------------------------------------
//
// The alignment time constant (dynamics.js) is
//
//     tau = 6 mu0 eta / (chi B^2)
//
// which in fresh polish under a 100 mT tool comes out at about 0.2 ms. That is
// worth sitting with: for the first minute or two, a magnet held anywhere near
// a nail combs the pile INSTANTLY. Nothing you do slowly can possibly matter,
// and only the final position of the tool leaves a mark. This is why the static
// model works so well, and it is why "hold it there for ten seconds" is folklore
// rather than physics.
//
// Two things break that, and they are different from each other.
//
//   THICKENING. eta climbs exponentially as solvent leaves, so tau climbs with
//   it. Around three minutes in, tau reaches human timescales and the pile
//   starts to LAG the tool. That is the window every moving technique lives in,
//   and it is narrow - a minute later the coat is set and nothing moves at all.
//
//   TAKING THE TOOL AWAY. No field at all means no torque at all, so a pile
//   with every magnet removed stays exactly as it was, indefinitely and at any
//   viscosity. Putting the tool down is a move in its own right.
//
// It is tempting to conclude from the second that multi-step techniques work on
// fresh polish - set a line with the bar, lift it, then touch one corner with a
// small tool and everything out of reach stays put. That is wrong, and the
// simulation is what showed it:
//
//   A MAGNET'S FIELD NEVER REACHES ZERO. It only gets small. In fresh polish
//   the alignment time even at 1 mT is under a second, so a few seconds of a
//   "local" tool re-combs the ENTIRE nail from its far-field tail, and the
//   first half of the pattern is destroyed. Measured: with fresh polish the
//   far end of the nail turns through 75 degrees, MORE than the end the tool is
//   sitting over. At 112 Pa.s it turns through 2.4 degrees, and at 767 Pa.s
//   through 0.3.
//
// So locality is not a property of the tool. It is a property of the polish.
// A small magnet only becomes a local instrument once the coat has thickened
// enough that weak-field regions run out of time before they finish turning.
// Both kinds of technique therefore live in the same tacky window, and the
// window is the thing to learn to feel for.

import { createMagnet } from './magnet.js';
import { createNail } from './nail.js';
import { quatFromAxisAngle } from './vec.js';

const standardNail = () => createNail({
  position: [0, 0, 0], transverseCurv: 0.085, longitudinalCurv: 0.018,
});

/** The flat bar end of a cat-eye wand: the tool that makes an ordinary line. */
const barEnd = (opts = {}) => createMagnet({
  type: 'array',
  name: 'wand, bar end',
  size: { nx: 2, ny: 1, cellX: 7, cellY: 26, height: 5, pattern: 'stripe' },
  position: [0, 0, 7],
  ...opts,
});

/**
 * The round end of the wand: a SHORT two-pole element, so it carries its own
 * little seam a few millimetres long rather than a single pole face. That
 * distinction turned out to matter - an axially magnetised disc makes a
 * bullseye, not a line, so it cannot bend a line no matter where you put it.
 */
const roundEnd = (opts = {}) => createMagnet({
  type: 'array',
  name: 'wand, round end',
  size: { nx: 2, ny: 1, cellX: 3, cellY: 8, height: 4, pattern: 'stripe' },
  position: [0, 0, 4],
  ...opts,
});

/** Lifted clear of the nail - used for moving between corners. */
const LIFTED = { offset: [0, 0, 40], hold: 0.25 };

export const TECHNIQUES = {
  settle: {
    label: 'Control: hold it still and watch it set',
    duration: 20,
    startTime: 150,
    polish: { kind: 'regular' },
    note: 'The baseline, and the one to look at first. A wand held still while '
        + 'the polish thickens. Scrub the clock and watch the alignment-order '
        + 'channel: the pile combs, and then at some point it stops responding '
        + 'and the pattern is locked. The readout tells you which regime you '
        + 'are in - a response time of a few milliseconds means anything you do '
        + 'happens instantly, and a few seconds means the pile is lagging you. '
        + 'Everything else here depends on knowing where that boundary is.',
    build: () => ({ nail: standardNail(), magnets: [barEnd()] }),
  },

  glassBeadSpin: {
    label: 'Glass bead: spin the horseshoe',
    duration: 8,
    startTime: 205,
    polish: { kind: 'regular' },
    note: 'Turning the tool on the spot instead of holding it. The field '
        + 'STRENGTH at each point barely changes while its DIRECTION sweeps a '
        + 'full turn, so the flakes are asked to chase something that keeps '
        + 'moving. Because real pigment is polydisperse, they cannot all chase '
        + 'it at the same rate: fast flakes keep up, slow ones lag, and the '
        + 'ensemble fans out in phase. Alignment order collapses and the texel '
        + 'scatters light in every direction instead of mirroring it in one - '
        + 'which is the bead. '
        + 'Measured here: order falls from 0.92 held still to 0.61 spinning. '
        + 'Note that this only works in a WINDOW. Try it at 20 seconds instead '
        + 'of 205 and nothing happens at all, because the pile re-aligns faster '
        + 'than the tool can turn. '
        + 'You must also LIFT THE TOOL at the end, which is why it is taken '
        + 'away here at 8 s. Stop turning but leave the magnet sitting there '
        + 'and the bead is gone in about four seconds: the field is still '
        + 'present, so the pile simply re-combs, and order climbs 0.70 -> 1.00. '
        + 'The polish cannot save it either - it does not set for another 30 s. '
        + 'Taking the tool away leaves no torque at all, so the scatter freezes '
        + 'exactly where it was.',
    build: () => ({
      nail: standardNail(),
      magnets: [createMagnet({
        type: 'horseshoe',
        name: 'horseshoe, spinning',
        size: { legLength: 16, legWidth: 6, depth: 16, gap: 16, yoke: 6 },
        position: [0, 0, 22],
        quaternion: quatFromAxisAngle([0, 1, 0], Math.PI),
        Br: 1.35,
        active: [0, 8],
        motion: { kind: 'spin', rpm: 90, axis: 'normal' },
      })],
    }),
  },

  glassBeadOrbit: {
    label: 'Glass bead: circle the wand round the nail',
    duration: 10,
    startTime: 205,
    polish: { kind: 'regular' },
    note: 'The other route people describe: walking the round end of the wand '
        + 'in a circle around the nail rather than turning it on the spot. The '
        + 'mechanism is the same - the field direction at any one point of the '
        + 'plate sweeps round - but the field STRENGTH sweeps too, because the '
        + 'tool is moving toward and away from each point in turn. That makes '
        + 'it messier than spinning and more dependent on keeping the radius '
        + 'even, which matches the usual advice that this one takes practice. '
        + 'Set the radius to 0 and it becomes the spin technique. '
        + 'As with the spin, the wand is LIFTED at the end of the take. Leaving '
        + 'it on the nail undoes the whole thing within a few seconds, because '
        + 'a stationary tool is just a cat-eye tool again.',
    build: () => ({
      nail: standardNail(),
      magnets: [roundEnd({
        position: [0, 0, 5],
        active: [0, 10],
        motion: { kind: 'orbit', rpm: 60, radius: 6, yaw: true },
      })],
    }),
  },

  sCurve: {
    label: 'S-curve: bar first, then one corner and the other',
    duration: 18,
    startTime: 185,
    polish: { kind: 'regular' },
    note: 'The two-stage technique. The bar end sets an ordinary straight line '
        + 'and is lifted off at two seconds; the round end then works one '
        + 'corner at a time, and because its seam is only a few millimetres '
        + 'long it bends the line locally instead of dragging the whole thing. '
        + 'Angling it opposite ways at the two corners is what turns a bend '
        + 'into an S. '
        + 'The clock starts at three minutes, and that is not a detail. Run the '
        + 'same script on fresh polish and it fails completely: the round end '
        + 'is not local yet, because its far field is still strong enough to '
        + 'comb the opposite end of the nail within seconds. Measured, the far '
        + 'end swings 75 degrees on fresh polish against 0.3 degrees on tacky. '
        + 'Drag the elapsed slider back to 0 and watch it fall apart. '
        + 'The tool is also lifted clear on the way between corners - dragged '
        + 'across the middle instead, it re-combs everything it passes over. '
        + 'That is not a modelling artefact; it is why the instruction is '
        + 'always to lift.',
    build: () => ({
      nail: standardNail(),
      magnets: [
        barEnd({ active: [0, 2] }),
        roundEnd({
          active: [2, Infinity],
          motion: {
            kind: 'waypoints',
            travel: 0.6,
            stops: [
              { offset: [-4, 5, -0.5], spin: 50, hold: 5 },
              LIFTED,
              { offset: [4, -5, -0.5], spin: -50, hold: 5 },
            ],
          },
        }),
      ],
    }),
  },

  wideThenTight: {
    label: 'Pull the line tighter as it sets',
    duration: 16,
    startTime: 170,
    polish: { kind: 'regular' },
    note: 'One tool, brought down toward the nail as the polish thickens. Far '
        + 'off, the pull is wide and the pile barely turns across the plate - a '
        + 'soft velvet. Close in, the seam pinches into a crisp cat-eye line. '
        + 'Doing it as a MOVE rather than as two separate attempts leaves the '
        + 'outer nail combed by the wide field and the centre re-combed by the '
        + 'tight one, because by the time the tool is close the outer regions '
        + 'are too weakly held to follow. Watch pile parallelism climb as it '
        + 'descends.',
    build: () => ({
      nail: standardNail(),
      magnets: [barEnd({
        position: [0, 0, 7],
        motion: {
          kind: 'waypoints',
          travel: 8,
          stops: [
            { offset: [0, 0, 12], hold: 3 },
            { offset: [0, 0, -1], hold: 5 },
          ],
        },
      })],
    }),
  },

  gelNoRush: {
    label: 'Gel: the same move with no clock running',
    duration: 20,
    startTime: 0,
    polish: { kind: 'gel' },
    note: 'The S-curve again, on gel instead of lacquer. Gel does not dry - its '
        + 'viscosity sits where it started until it goes under the lamp - so '
        + 'the working window is however long you want it to be, and the '
        + 'response stays fast throughout. That is the real difference between '
        + 'the two, and it cuts both ways: gel will not punish you for being '
        + 'slow, but it also will not give you any of the effects that depend '
        + 'on the pile lagging the tool. Spin a horseshoe over uncured gel and '
        + 'you get no bead at all, and a small tool is never local, so the '
        + 'S-curve does not come out either - the second corner simply combs '
        + 'over the first. Press CURE to freeze it.',
    build: () => ({
      nail: standardNail(),
      magnets: [
        barEnd({ active: [0, 3] }),
        roundEnd({
          active: [3, Infinity],
          motion: {
            kind: 'waypoints',
            travel: 0.8,
            stops: [
              { offset: [-4, 5, -0.5], spin: 50, hold: 6 },
              LIFTED,
              { offset: [4, -5, -0.5], spin: -50, hold: 6 },
            ],
          },
        }),
      ],
    }),
  },
};

export const TECHNIQUE_KEYS = Object.keys(TECHNIQUES);
