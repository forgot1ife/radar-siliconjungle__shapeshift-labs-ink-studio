const test = require('node:test');
const assert = require('node:assert/strict');
const { KIT, makeBuilder, makeSculpt } = require('..').load();

test('surface paint keeps local cell addresses through rotation and resizing', () => {
  const paint = KIT.pixel.surfacePaint;
  const wall = paint.chart('wall', [1, 2, 3], [4, 0, 0], [0, 2, 0], 8, 4);
  const hit = paint.cell(wall, [2.25, 2.75, 3], [0, 0, 1]);
  assert.deepEqual(hit, ['wall', 2, 1]);
  assert.equal(paint.cell(wall, [2.25, 2.75, 3.4], [0, 0, 1]), null);
  assert.equal(paint.cell(wall, [2.25, 2.75, 3], [0, 0, -1]), null);
  const saved = paint.read(JSON.parse(JSON.stringify(paint.document([[...hit, 4]]))));
  const moved = paint.chart('wall', [6, 3, 0], [0, 0, -8], [0, 4, 0], 8, 4);
  const [[x, y, z, nx, ny, nz, color]] = paint.resolve(saved, [moved]);
  assert.deepEqual([x, y, z, nx, ny, nz, color], [6, 4.5, -2.5, 1, 0, 0, 4]);
  assert.equal(paint.colorAt(paint.atlas(saved, [moved]), [x, y, z], [nx, ny, nz]), 4);
  assert.equal(paint.colorAt(paint.atlas(saved, []), [x, y, z], [nx, ny, nz]), -1);
});

test('quiet fills and contour controls are independent and leave the source material intact', () => {
  const source = KIT.pixel.masonry({ r: [1, 2, 3] });
  const directed = KIT.pixel.direct(source, { pattern: false, quiet: 0.5, edges: true });
  assert.equal(directed.pat, null);
  assert.equal(directed.tex, null);
  assert.equal(directed.line, true);
  assert.equal(directed.quiet, 0.5);
  assert.equal(source.pat.kind, 'masonry');
  assert.deepEqual(directed.r, source.r);
  assert.equal(KIT.pixel.direct(directed, { quiet: 0 }).quiet, 0);
  assert.throws(() => KIT.pixel.direct(source, { quiet: -1 }), RangeError);
  const builder = makeBuilder(1), sculpt = makeSculpt(builder);
  sculpt.pixel = true;
  sculpt.ball([0, 0, 0], 1, KIT.pixel.direct(source, { pattern: false, quiet: 1 }));
  sculpt.bake();
  const world = builder.finish({});
  assert.ok(world.count > 1);
  for (let i = 0; i < world.count; i++) assert.equal(world.pix[i * 8 + 1], 0.5);
});

test('anchored paint travels as artwork while legacy dabs still bake as geometry', () => {
  const paint = KIT.pixel.surfacePaint.document([['wall', 1, 1, 2]]);
  globalThis.INK_DECAL_NEXT = { decals: [[1, 2, 3, 0, 0, 1, 2]], surfacePaint: paint };
  const world = makeBuilder(1).finish({});
  assert.equal(world.count, 1);
  assert.deepEqual(world.surfacePaint, paint);
  assert.equal(globalThis.INK_DECAL_NEXT, null);
});
