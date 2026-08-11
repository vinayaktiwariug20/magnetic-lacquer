// Static checks on the nail shader.
//
// The GLSL cannot be compiled without a GPU, so this covers the failure class
// that a GPU would NOT report usefully anyway: a name or type mismatch between
// what the shader declares and what JS supplies. A misspelled uniform silently
// stays at its default and a missing attribute silently reads zero - either way
// you get a black nail and no error in the console.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNailMaterial, CHANNELS } from '../src/ui/nailMaterial.js';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const shaderSrc = src('../src/ui/nailMaterial.js');
const mainSrc = src('../src/ui/main.js');
const unwrapSrc = src('../src/ui/unwrap.js');

/** Everything three.js injects into a ShaderMaterial's prefix for us. */
const THREE_BUILTIN_UNIFORMS = new Set([
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix',
  'normalMatrix', 'cameraPosition', 'isOrthographic',
]);
const THREE_BUILTIN_ATTRIBUTES = new Set(['position', 'normal', 'uv', 'tangent', 'color']);

function declarations(source, keyword) {
  const re = new RegExp(`^\\s*${keyword}\\s+(\\w+)\\s+(\\w+)\\s*;`, 'gm');
  const out = new Map();
  let m;
  while ((m = re.exec(source)) !== null) out.set(m[2], m[1]);
  return out;
}

// The two shader stages, pulled out of the template literals.
const vertSrc = shaderSrc.split('const vert =')[1].split('`;')[0];
const fragSrc = shaderSrc.split('const frag =')[1].split('`;')[0];

describe('nail shader wiring', () => {
  const material = createNailMaterial();

  it('every declared uniform is supplied by JS', () => {
    const declared = new Map([
      ...declarations(vertSrc, 'uniform'),
      ...declarations(fragSrc, 'uniform'),
    ]);
    expect(declared.size).toBeGreaterThan(10);

    for (const [name] of declared) {
      if (THREE_BUILTIN_UNIFORMS.has(name)) continue;
      expect(material.uniforms, `GLSL declares uniform ${name}`).toHaveProperty(name);
      expect(material.uniforms[name].value,
        `uniform ${name} has no value`).not.toBeUndefined();
    }
  });

  it('every supplied uniform is actually declared in the GLSL', () => {
    const declared = new Map([
      ...declarations(vertSrc, 'uniform'),
      ...declarations(fragSrc, 'uniform'),
    ]);
    for (const name of Object.keys(material.uniforms)) {
      expect(declared.has(name), `uniform ${name} is set but never declared`).toBe(true);
    }
  });

  it('uniform value types match their GLSL types', () => {
    const declared = new Map([
      ...declarations(vertSrc, 'uniform'),
      ...declarations(fragSrc, 'uniform'),
    ]);
    for (const [name, type] of declared) {
      if (THREE_BUILTIN_UNIFORMS.has(name)) continue;
      const v = material.uniforms[name].value;
      if (type === 'float' || type === 'int') {
        expect(typeof v, `${name} is ${type}`).toBe('number');
        if (type === 'int') expect(Number.isInteger(v), `${name} must be an integer`).toBe(true);
      } else if (type === 'vec3') {
        // three accepts Color or Vector3 for a vec3.
        expect(typeof v === 'object' && v !== null, `${name} is vec3`).toBe(true);
        const isVec = 'x' in v && 'y' in v && 'z' in v;
        const isColor = 'r' in v && 'g' in v && 'b' in v;
        expect(isVec || isColor, `${name} must be Vector3 or Color`).toBe(true);
      }
    }
  });

  it('every vertex attribute is created as a BufferAttribute', () => {
    const attrs = declarations(vertSrc, 'attribute');
    expect(attrs.size).toBeGreaterThan(0);

    // Widths implied by the GLSL type must match the itemSize used in main.js.
    const width = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

    for (const [name, type] of attrs) {
      if (THREE_BUILTIN_ATTRIBUTES.has(name)) continue;
      // The itemSize is the last argument of the BufferAttribute constructor;
      // the buffer expression before it contains its own parentheses.
      const re = new RegExp(
        `setAttribute\\(\\s*'${name}'\\s*,\\s*new THREE\\.BufferAttribute\\(` +
        `[\\s\\S]*?,\\s*(\\d+)\\s*\\)\\s*\\)`,
      );
      const m = mainSrc.match(re);
      expect(m, `main.js never creates attribute ${name}`).not.toBeNull();
      expect(Number(m[1]), `${name} itemSize should be ${width[type]}`)
        .toBe(width[type]);
    }
  });

  it('every attribute is refreshed after a solve', () => {
    // A BufferAttribute that is written but never flagged needsUpdate shows the
    // first frame's data forever.
    const attrs = [...declarations(vertSrc, 'attribute').keys()]
      .filter((n) => !THREE_BUILTIN_ATTRIBUTES.has(n));
    const flagged = mainSrc.match(/for \(const k of \[([^\]]+)\]\)/);
    expect(flagged, 'no needsUpdate loop found in main.js').not.toBeNull();
    for (const name of attrs) {
      expect(flagged[1], `${name} is never flagged needsUpdate`).toContain(`'${name}'`);
    }
  });

  it('varyings agree in name and type across the two stages', () => {
    const vOut = declarations(vertSrc, 'varying');
    const fIn = declarations(fragSrc, 'varying');
    for (const [name, type] of vOut) {
      expect(fIn.has(name), `fragment stage is missing varying ${name}`).toBe(true);
      expect(fIn.get(name), `varying ${name} type mismatch`).toBe(type);
    }
    for (const [name] of fIn) {
      expect(vOut.has(name), `varying ${name} is read but never written`).toBe(true);
    }
  });

  it('every varying the vertex stage declares is actually assigned', () => {
    for (const name of declarations(vertSrc, 'varying').keys()) {
      expect(vertSrc, `varying ${name} is declared but never written`)
        .toMatch(new RegExp(`${name}\\s*=`));
    }
  });

  it('writes gl_FragColor and runs it through the output transform', () => {
    expect(fragSrc).toContain('gl_FragColor =');
    expect(fragSrc).toContain('#include <tonemapping_fragment>');
    expect(fragSrc).toContain('#include <colorspace_fragment>');

    // Those chunks operate on gl_FragColor, so nothing may return before them.
    const afterAssign = fragSrc.slice(fragSrc.indexOf('gl_FragColor ='));
    expect(afterAssign).toContain('colorspace_fragment');
    expect(fragSrc.includes('return;'),
      'an early return would skip tone mapping and the colour transform').toBe(false);
  });

  it('float literals are written as GLSL floats, not bare integers', () => {
    // `pow(x, 2)` and `max(0, x)` are compile errors in GLSL ES 1.0. Catch the
    // common ones rather than every case.
    const bad = [...fragSrc.matchAll(/\b(max|min|pow|mix|clamp)\s*\(\s*(-?\d+)\s*,/g)]
      .filter((m) => !m[2].includes('.'));
    expect(bad.map((m) => m[0]), 'integer literal passed where a float is required')
      .toEqual([]);
  });

  it('the channel list matches what the shader branches on', () => {
    // main.js sends CHANNELS.indexOf(name) as uChannel, so the shader must
    // handle every index except 0 (the shaded path).
    for (let i = 1; i < CHANNELS.length; i++) {
      expect(fragSrc, `uChannel == ${i} (${CHANNELS[i]}) is unhandled`)
        .toMatch(new RegExp(`uChannel\\s*==\\s*${i}\\b`));
    }
    // ...and must not branch on an index that does not exist.
    const handled = [...fragSrc.matchAll(/uChannel\s*==\s*(\d+)/g)].map((m) => Number(m[1]));
    for (const i of handled) expect(i).toBeLessThan(CHANNELS.length);
  });

  it('the 2D unwrapped view understands the same channel names', () => {
    for (const name of CHANNELS) {
      if (name === 'shaded') continue;
      expect(unwrapSrc, `unwrap.js does not handle channel ${name}`)
        .toContain(`'${name}'`);
    }
  });
});

describe('the shell and the script agree on the DOM', () => {
  // Same failure class as a misspelled uniform, one layer out. getElementById
  // returning null throws only when that line is first reached - which for a
  // context menu is the first right-click, long after load looks fine. A
  // missing CSS rule is worse: no error at all, just an invisible menu.

  const htmlSrc = src('../index.html');
  const ids = new Set([...htmlSrc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const styleBlock = htmlSrc.split('<style>')[1].split('</style>')[0];

  it('every element main.js looks up by id exists in index.html', () => {
    const looked = [...mainSrc.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)]
      .map((m) => m[1]);
    expect(looked.length).toBeGreaterThan(0);
    for (const id of looked) {
      expect(ids.has(id), `index.html has no element with id="${id}"`).toBe(true);
    }
  });

  it('the context menu is wired to markup and styling that exist', () => {
    expect(ids.has('ctx')).toBe(true);
    // The classes the menu applies at runtime must all be styled, or it opens
    // as unstyled text over the canvas and nothing reports a problem.
    // `on` is on the menu itself; the rest are on its children.
    for (const sel of ['#ctx.on', '#ctx .hdr', '#ctx .sep', '#ctx button.danger',
      '#ctx button .k']) {
      expect(styleBlock, `${sel} is never styled`).toContain(sel);
    }
  });

  it('the disclosure that replaced the banner is a real details element', () => {
    // It has to be <details>, not a div: the collapse is native, with no JS
    // behind it, so a div would render permanently open.
    expect(htmlSrc).toMatch(/<details\s+id="about"/);
    expect(htmlSrc).toContain('<summary>');
    expect(htmlSrc, 'the always-on banner is back').not.toMatch(/id="banner"/);
  });

  it('every keyboard shortcut the hint advertises is actually handled', () => {
    // The hint is the only documentation these shortcuts have, so it going
    // stale is the whole risk. What the label says, and what KeyboardEvent.key
    // actually reports for it:
    // Modifiers are read as flags on the event, not as `key` values, so they
    // are looked for as `altKey` / `ctrlKey` rather than as 'Alt' / 'Control'.
    const REPORTED_AS = {
      W: ["'w'", "'W'"], E: ["'e'", "'E'"], H: ["'h'", "'H'"],
      Del: ["'Delete'"], Esc: ["'Escape'"],
      Ctrl: ['ctrlKey'], Alt: ['altKey'],
    };
    const hint = htmlSrc.split('id="hint"')[1].split('</div>')[0];
    const keys = [...hint.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1].trim());
    expect(keys.length).toBeGreaterThan(0);

    // Searched over the whole module rather than the listener body. Handling is
    // spread across several places - two keydown listeners plus a named
    // modifier reader - and pinning the test to one of them just makes it break
    // when the code moves. What it is really guarding is a hint that advertises
    // a key nothing implements, and a file-wide search catches that.
    const handler = mainSrc;
    expect(mainSrc).toContain("addEventListener('keydown'");
    for (const k of keys) {
      const accepted = REPORTED_AS[k];
      expect(accepted, `the hint offers ${k}, which this test does not know`)
        .toBeDefined();
      expect(
        accepted.some((lit) => handler.includes(lit)),
        `the hint offers ${k} but keydown never handles it`,
      ).toBe(true);
    }
  });
});
