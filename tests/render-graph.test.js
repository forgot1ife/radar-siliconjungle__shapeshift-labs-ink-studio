const { test } = require('node:test');
const assert = require('node:assert/strict');
const ink = require('..');
const runWebGL = require('../cli/look-webgl.js');

function fixture({ makeBuilder, KIT }, kind = 'pipeline') {
  const B = makeBuilder(1, [0x102030, 0xff0000, 0x00ff00]);
  if (kind === 'scope') {
    B.disc(-0.7, 0, 0, [0, 0, 1], .45, .04, B.P[1], 3);
    B.describeSplats(0, 1, { object: 'panel', material: 'ink' });
    B.disc(0.7, 0, 0, [0, 0, 1], .45, .04, B.P[2], 3);
    B.describeSplats(1, 2, { object: 'marker', material: 'ink' });
  }
  const world = B.finish({ cam: { target: [0, 0, 0], dist: 4, yaw: 0, pitch: 0 }, radius: 3,
    look: kind === 'scope' ? { composite: { world: { resolution: [18, 12] } } } : {} });
  const blue = { name: 'Swap red and blue', steps: [{ type: 'channelMix', matrix: [[0, 0, 1], [0, 1, 0], [1, 0, 0]] }] };
  const paint = { id: 'paint', type: 'composite', layer: {
    resolution: [4, 3], draw: [{ type: 'rect', rect: [0, 0, 4, 4], color: '#ff0000' }]
  } };
  const grade = { id: 'grade', type: 'grade', stack: blue };
  const passes = kind === 'scope' ? [
    { id: 'ink', type: 'mask', select: { material: 'ink' } },
    { id: 'visible-panel', type: 'mask', select: { object: 'panel' }, mask: 'ink' },
    { ...grade, mask: 'visible-panel' }
  ] : kind === 'edit' ? [paint, grade] : [
    paint,
    { id: 'right', type: 'mask', rect: [4, 0, 4, 6] },
    { id: 'reflect', type: 'reflection', axis: 'x', mask: 'right', source: 'paint' },
    { id: 'lower', type: 'mask', rect: [4, 4, 4, 2], mask: 'right' },
    { id: 'shift', type: 'distortion', offset: [0, -2], mask: 'lower' },
    { ...grade, mask: 'lower' }
  ];
  return { world, editor: KIT.renderGraph.create({ passes }) };
}

const kit = ink.load();
const pixel = (frame, x, y) => Array.from(frame.rgb.subarray((y * frame.w + x) * 3, (y * frame.w + x) * 3 + 3));
const view = { w: 8, h: 6, px: 1, raw: true };
const red = [255, 0, 0], blue = [0, 0, 255];

test('render graph reflects and distorts a named image within masks before grading it', () => {
  const { world, editor } = fixture(kit);
  const frame = ink.render(world, { ...view, renderGraph: editor });
  assert.deepEqual(pixel(frame, 0, 0), red);
  assert.deepEqual(pixel(frame, 7, 1), red);
  assert.deepEqual(pixel(frame, 7, 5), blue);
  assert.deepEqual(pixel(frame, 2, 5), [16, 32, 48]);
  const snapshot = editor.snapshot();
  assert.throws(() => editor.move('right', 4), /earlier mask output/);
  assert.throws(() => editor.remove('paint'), /earlier image output/);
  assert.equal(editor.snapshot(), snapshot);
  editor.update('lower', { enabled: false });
  assert.deepEqual(pixel(ink.render(world, { ...view, renderGraph: editor }), 7, 5), [16, 32, 48]);
});

test('live graph edits change ordering without rebuilding the world', () => {
  const { world, editor } = fixture(kit, 'edit');
  world.look.renderGraph = editor;
  assert.deepEqual(pixel(ink.render(world, view), 0, 0), blue);
  const sample = ink.render(world, { ...view, samples: true });
  assert.deepEqual(Array.from(sample.color.subarray(0, 3)), [16, 32, 48]);
  editor.move('grade', 0);
  assert.deepEqual(pixel(ink.render(world, view), 0, 0), red);
  editor.update('paint', { enabled: false });
  assert.deepEqual(pixel(ink.render(world, view), 0, 0), [48, 32, 16]);
  editor.insert({ id: 'mix', type: 'composite', source: 'scene', opacity: .5, blend: 'add' });
  assert.deepEqual(pixel(ink.render(world, view), 0, 0), [56, 48, 40]);
  editor.replace({ ...editor.snapshot(), output: 'scene' });
  assert.deepEqual(pixel(ink.render(world, view), 0, 0), [16, 32, 48]);
});

test('selectors stay aligned through mixed resolution and preserve requested diagnostics', () => {
  const { world, editor } = fixture(kit, 'scope');
  const options = { w: 36, h: 24, raw: true, outline: false };
  const before = ink.render(world, options);
  const after = ink.render(world, { ...options, renderGraph: editor, passes: ['depth'] });
  const panel = pixel(before, 11, 12);
  assert(panel[0] > 245 && panel[2] < 10);
  assert.deepEqual(pixel(after, 11, 12), [panel[2], panel[1], panel[0]]);
  assert.deepEqual(pixel(after, 24, 12), pixel(before, 24, 12));
  assert.deepEqual(after.worldSize, [18, 12]);
  assert(after.passes.depth);
  assert.equal(after.passes.splatId, undefined);
});

test('WebGL executes the same graph with live edits and native world ownership', {
  skip: !process.env.INK_TEST_CHROME
}, () => {
  const result = runWebGL({}, fixture, (kit, fixture, backend) => {
    const pipeline = fixture(kit), scope = fixture(kit, 'scope'), edit = fixture(kit, 'edit');
    const draw = backend(8, 6, { raw: true, offscreen: true });
    const drawScope = backend(36, 24, { raw: true });
    try {
      const points = { first: [0, 0], reflected: [7, 1], distorted: [7, 5], untouched: [2, 5] };
      draw.draw(pipeline.world, { renderGraph: pipeline.editor });
      const output = draw.sample(points);
      draw.draw(edit.world, { renderGraph: edit.editor });
      const first = draw.sample(points).first;
      edit.editor.move('grade', 0);
      draw.draw(edit.world, { renderGraph: edit.editor });
      const moved = draw.sample(points).first;
      draw.draw(edit.world, { renderGraph: false });
      const original = draw.sample(points).first;
      drawScope.draw(scope.world, { renderGraph: scope.editor });
      return { output, first, moved, original, owners: drawScope.sample({ panel: [11, 12], marker: [24, 12] }) };
    } finally {
      draw.close();
      drawScope.close();
    }
  });
  assert.deepEqual(result.output, { first: red, reflected: red, distorted: blue, untouched: [16, 32, 48] });
  assert.deepEqual(result.first, blue);
  assert.deepEqual(result.moved, red);
  assert.deepEqual(result.original, [16, 32, 48]);
  assert(result.owners.panel[2] > 245 && result.owners.panel[0] < 10, JSON.stringify(result));
  assert(result.owners.marker[1] > 245 && result.owners.marker[2] < 10, JSON.stringify(result));
});
