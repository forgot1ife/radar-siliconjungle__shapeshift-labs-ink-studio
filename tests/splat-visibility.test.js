const test = require('node:test');
const assert = require('node:assert/strict');
const { KIT } = require('..').load();

test('perspective culling retains the original order of visible and animated ranges', () => {
  const count = 6 * 128;
  const data = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    const block = i >> 7, o = i * 16;
    data[o] = [0, 100, 0, -100, 6, 100][block];
    data[o + 2] = block === 2 ? 10 : -10;
    data[o + 4] = block === 4 ? 4 : 0.002;
    if (block === 5) data[o + 11] = 6;
  }
  const world = { count, data, dynamic: { start: 384, count: 128 } };
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ranges = KIT.splatVisibility.ranges(KIT.splatVisibility.prepare(world), view, 0.5, 0.5, 500, 1, 1, []);
  assert.deepEqual(ranges, [0, 128, 384, 768]);
});

test('a rigid range follows its bone and mixed weights stay drawable', () => {
  const data = new Float32Array(384 * 16);
  for (let i = 0; i < 384; i++) {
    data[i * 16] = i < 128 ? 100 : 0;
    data[i * 16 + 2] = -10;
    data[i * 16 + 11] = 12;
    data[i * 16 + 12] = i < 128 ? 0 : 1;
    if (i >= 256) data[i * 16 + 14] = 0.5;
  }
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const bones = [1, 0, 0, 0, 1, 0, 0, 0, 1, -100, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 0, 0];
  const blocks = KIT.splatVisibility.prepare({ count: 384, data });
  assert.deepEqual(KIT.splatVisibility.ranges(blocks, view, 0.5, 0.5, 500, 1, 1, [], bones), [0, 128, 256, 384]);
  assert.deepEqual(KIT.splatVisibility.ranges(blocks, view, 0.5, 0.5, 500, 1, 1, []), [0, 384]);
});
