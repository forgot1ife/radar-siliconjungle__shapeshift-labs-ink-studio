const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const core = require('..');
const coastline = require('../examples/biome-world');
const { biomes, waterBodies, motion } = core.load().KIT.procedural;

test('a water frame shares shoreline, depth and currents with biome queries and particles', () => {
  const current = [0.25, -0.5];
  const inlet = waterBodies.create({
    id: 'inlet', bounds: { min: [0, 0], max: [2, 1] }, resolution: [2, 1],
    sample: x => x < 1 ? null : { bed: -1, surface: 0, current }
  });
  current[0] = 9;
  const water = waterBodies.scene([inlet]), world = biomes.create({ media: water.media });
  assert.deepEqual(inlet.columnAt(1.5, 0.5), { bed: -1, surface: 0, depth: 1, current: [0.25, 0, -0.5] });
  assert.equal(inlet.columnAt(0.5, 0.5), null);
  assert.equal(inlet.columnAt(2, 0.5), null);
  assert.equal(inlet.shoreline().length, 4);
  assert.deepEqual(inlet.shoreline()[0], [[1, 0, 1], [1, 0, 0]]);
  const wet = world.mediumAt(1.5, -0.25, 0.5);
  assert.deepEqual(wet, { kind: 'water', id: 'inlet', surface: 0, depth: 0.25, current: [0.25, 0, -0.5] });
  assert.deepEqual(water.mediumAt(1, -0.25, 0.5), wet);
  for (const y of [-1, 0]) assert.equal(world.mediumAt(1.5, y, 0.5).kind, 'air');
  for (const particle of inlet.particles({ count: 30, seed: 22 })) {
    const sample = world.mediumAt(...particle.position);
    assert.equal(sample.kind, 'water');
    assert.deepEqual(particle.current, sample.current);
  }
  const packed = water.pack();
  assert.deepEqual([...packed.data.slice(0, 8)], [0, 0, 0, 0, -1, 0, 0.25, -0.5]);
  packed.data.fill(0);
  assert.equal(water.pack().data[4], -1);
});

test('shallow-water frames capture solver state and keep the previous revision readable', () => {
  const solver = motion.shallowWater({
    width: 2, height: 1, cell: 1, terrain: x => x < 1 ? -1 : 0, mask: x => x < 1,
    initial: () => ({ depth: 0.5, velocity: [0.25, 0] })
  });
  const first = waterBodies.fromShallowWater(solver.snapshot(), { id: 'river' });
  const next = waterBodies.fromShallowWater(solver.step(0.25, { rain: 1 }), { id: 'river' });
  assert.equal(first.columnAt(0.5, 0.5).surface, -0.5);
  assert.equal(first.columnAt(0.5, 0.5).current[0], 0.25);
  assert.equal(next.columnAt(0.5, 0.5).surface, -0.25);
  assert.equal(next.columnAt(1.5, 0.5), null);
  const empty = waterBodies.create({ id: 'dry', bounds: { min: [0, 0], max: [1, 1] }, sample: () => null });
  assert.equal(waterBodies.scene([empty]).count, 0);
  assert.deepEqual(empty.particles(), []);
});

test('water frames allow stacked or adjoining bodies and reject ambiguous overlapping volume bounds', () => {
  const body = (id, ox, bed) => waterBodies.create({
    id, bounds: { min: [ox, 0], max: [ox + 1, 1] }, sample: () => ({ bed, surface: bed + 1 })
  });
  const low = body('cave', 0, -3), high = body('pond', 0, 0), side = body('inlet', 1, 0);
  const scene = waterBodies.scene([high, side, low]);
  assert.equal(scene.mediumAt(0.5, -2.5, 0.5).id, 'cave');
  assert.equal(scene.mediumAt(1, 0.5, 0.5).id, 'inlet');
  assert.throws(() => waterBodies.scene([low, body('overlap', 0.5, -2.5)]), /bounds overlap/);
  assert.throws(() => waterBodies.scene([low, low]), /distinct IDs/);
});

test('water changes bound modified columns and carry strict interior air pockets', () => {
  const body = changed => waterBodies.create({ id: 'pool', bounds: { min: [-4, 0], max: [4, 4] }, resolution: [4, 2],
    sample: (x, z) => ({ bed: -4, surface: changed && x < -2 && z < 2 ? 1 : 0 }) });
  const before = waterBodies.scene([body(false)]);
  const bounds = { min: [-2, -2, 1], max: [0, -0.5, 3] };
  const after = waterBodies.scene([body(true)], { airPockets: [{ id: 'void', bounds }] });
  assert.equal(after.mediumAt(-1, -1, 2).id, 'void');
  assert.equal(after.mediumAt(-2, -1, 2).kind, 'water');
  assert.equal(after.mediumAt(-1, -2, 2).kind, 'water');
  assert.equal(after.mediumAt(-3, 0.5, 1).kind, 'water');
  assert.deepEqual(after.changesFrom(before), [{ min: [-4, -4, 0], max: [-2, 1, 2] }, bounds]);
  assert.deepEqual(waterBodies.scene([body(true)], { airPockets: [{ id: 'void', bounds }] }).changesFrom(after), []);
  assert.equal(after.pack().uniforms.u_waterAirCount, 1);
  assert.throws(() => waterBodies.scene([body(false)], { airPockets: [{ id: 'pool', bounds }] }), /distinct IDs/);
});

function browserProbe(createRenderer, compileSprites, coastline) {
  const canvas = document.querySelector('canvas');
  const { waterBodies } = KIT.procedural;
  const renderer = createRenderer(canvas, { toolkit: { KIT, PixelLook } });
  const gl = canvas.getContext('webgl2'), size = 65, middle = 32;
  compileSprites(gl, PixelLook);
  const blackWater = { tint: [0, 0, 0], extinction: [0.9, 0.4, 0.12],
    surface: 0, refraction: 0, foam: 0, caustics: 0 };
  const volume = (settings = {}) => waterBodies.create({
    id: 'bay', bounds: { min: [-2, -6], max: [2, 3] }, sample: () => ({ bed: -4, surface: 0 }),
    optics: blackWater, ...settings
  });
  const scene = waterBodies.scene([volume()]);
  const baseCamera = { target: [0, 0, -2], dist: 4, pitch: 0 };
  function world(camera, { front = false, blank = false, water = scene, background = 0, alpha = 1 } = {}) {
    const B = makeBuilder(1, [background, 0xffffff, 0x00ff00, 0x286885, 0x6ba8bd]);
    if (!blank) B.disc(...camera.target, [0, 0, 1], 15, 0.01, B.P[1], alpha);
    if (front) B.disc(0, -0.3, 1.25, [0, 0, 1], 4, 0.01, B.P[2], 1);
    return B.finish({ cam: camera, water });
  }
  function draw(w, frame = {}) {
    renderer.render(w, { width: size, height: size, raw: true, ...frame });
    const rgb = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, rgb);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('unexpected WebGL error');
    return (x = middle, y = middle) => [...rgb.slice((y * size + x) * 4, (y * size + x) * 4 + 3)];
  }
  function close(actual, expected, label, tolerance = 4) {
    if (expected.some((v, i) => Math.abs(v - actual[i]) > tolerance))
      throw new Error(label + ': got ' + actual + ', expected ' + expected);
  }
  function checkAttenuation(camera, distance, label, pixel, options) {
    const w = world(camera, options);
    const wet = draw(w)(...pixel), dry = draw(w, { water: false })(...pixel);
    close(wet, dry.slice(0, 3).map((v, i) => v * Math.exp(-distance * blackWater.extinction[i])), label);
  }
  const raySlope = 2 * (10 / size) * Math.tan(19 * Math.PI / 180);
  checkAttenuation(baseCamera, 4 * Math.hypot(1, raySlope), 'lower half at waterline', [middle, middle - 10]);
  checkAttenuation(baseCamera, 0, 'upper half at waterline', [middle, middle + 10]);
  checkAttenuation({ ...baseCamera, target: [0, -1, -2], pitch: 0.6 }, 1 / Math.sin(0.6), 'looking into water', []);
  checkAttenuation({ ...baseCamera, target: [0, 1, -2], pitch: -0.6 }, 4 - 1 / Math.sin(0.6), 'looking out of water', []);
  checkAttenuation({ ...baseCamera, target: [0, -0.5, -2], ortho: true }, 5, 'orthographic submerged splat', []);
  checkAttenuation(baseCamera, 4 * Math.hypot(1, raySlope), 'translucent splat', [middle, middle - 10], { alpha: 0.5 });
  const front = world(baseCamera, { front: true,
    water: waterBodies.scene([volume({ bounds: { min: [-2, -6], max: [2, 0] } })]) });
  close(draw(front)(middle, middle - 10), draw(front, { water: false })(middle, middle - 10), 'foreground occlusion');

  const terrain = waterBodies.scene([volume({ resolution: [2, 3], sample: (x, z) =>
    x < 0 || z > 0 ? null : { bed: -4, surface: 0 } })]);
  const steps = world({ ...baseCamera, target: [0, -0.7, -2] }, { water: terrain });
  const wetSteps = draw(steps), drySteps = draw(steps, { water: false });
  if (wetSteps(43, middle)[0] >= drySteps(43, middle)[0] * 0.3) throw new Error('wet grid cells did not absorb');
  close(wetSteps(22, middle), drySteps(22, middle), 'dry grid cells');

  const layer = (id, z, tint) => volume({ id, bounds: { min: [-2, z], max: [2, z + 1] },
    optics: { ...blackWater, extinction: [0.7, 0.7, 0.7], tint } });
  const layers = waterBodies.scene([layer('back', -2, [0, 0, 1]), layer('front', 0, [1, 0, 0])]);
  const stacked = world({ ...baseCamera, target: [0, -1, -2] }, { blank: true, background: 0xffffff, water: layers });
  const t = Math.exp(-0.7);
  close(draw(stacked)(), [(1 - t + t * t) * 255, t * t * 255, t * 255], 'layers use ray order');

  const styled = waterBodies.scene([volume({ optics: { ...blackWater, surface: 0.65, refraction: 4, foam: 1, caustics: 1 },
    sample: () => ({ bed: -0.35, surface: 0, current: [0.6, 0] }) })]);
  const finish = world({ ...baseCamera, target: [0, -0.12, -2], pitch: 0.22 }, { water: styled });
  const different = (a, b) => {
    for (let y = 12; y < 53; y += 2) for (let x = 12; x < 53; x += 2)
      if (a(x, y).some((value, channel) => Math.abs(value - b(x, y)[channel]) > 4)) return true;
    return false;
  };
  if (!different(draw(finish, { time: 0 }), draw(finish, { time: 0.7 })))
    throw new Error('surface and caustic effects did not animate');
  if (!different(draw(finish, { raw: false }), draw(finish, { raw: false, water: false })))
    throw new Error('water was lost in the colored resolve');

  const patternedBuilder = makeBuilder(4, [0, 0xffffff, 0x4d7b9c, 0x214759]);
  patternedBuilder.pixNext([1, 2], 0.15, null, 0, 0, 1);
  patternedBuilder.disc(0, -1, -2, [0, 0, 1], 2, 0.01, patternedBuilder.P[1], 1);
  const patterned = patternedBuilder.finish({ cam: { ...baseCamera, target: [0, -1, -2] },
    water: scene, look: { pixel: true } });
  if (!different(draw(patterned, { raw: false }), draw(patterned, { raw: false, water: false })))
    throw new Error('water was lost in the patterned resolve');

  const clear = waterBodies.scene([volume({ optics: { ...blackWater, extinction: [0, 0, 0], refraction: 4 } })]);
  const camera = { ...baseCamera, target: [0, -0.7, -2], pitch: 0.45 };
  const B = makeBuilder(2, [0, 0xffffff, 0x00ff00]);
  for (let i = -6; i <= 6; i++) B.disc(i * 0.18, -0.7, -2, [0, 0, 1], 0.06, 0.01, B.P[1], 1);
  const stripe = B.finish({ cam: camera, water: clear });
  if (!different(draw(stripe), draw(stripe, { water: false }))) throw new Error('clear water did not refract');
  B.disc(0, -0.7 + 3.1 * Math.sin(0.45), -2 + 3.1 * Math.cos(0.45),
    [0, 0, 1], 0.07, 0.01, B.P[2], 1);
  const inFront = B.finish({ cam: camera, water: clear });
  close(draw(inFront)(), draw(inFront, { water: false })(), 'refraction preserves the foreground');

  const pockets = waterBodies.scene([volume()], { airPockets: [
    { id: 'left', bounds: { min: [-1, -2, -1], max: [1, -0.25, 1] } },
    { id: 'right', bounds: { min: [-1, -2, -0.5], max: [1, -0.25, 1.5] } }
  ] });
  const throughPockets = { ...baseCamera, target: [0, -1, -2] };
  checkAttenuation(throughPockets, 1.5, 'water ray excludes the union of overlapping air boxes', [], { water: pockets });
  checkAttenuation({ ...throughPockets, dist: 2.1 }, 1, 'ray leaves an air pocket and re-enters water', [], { water: pockets });

  const coast = coastline(KIT), frame = coast.compiler.prepare(coast.author.view(), { water: coast.water(0.38) });
  const route = frame.traceRoute(coast.itinerary(frame));
  if (!route.ok || route.media.map(row => row.kind).join(',') !== 'air,water,air' || route.media.at(-1).id !== 'chamber-air')
    throw new Error('coast traversal did not reach the air chamber');
  const assembled = coast.compiler.makeWorld(frame, coast.indices.map(index => coast.compiler.build(frame, index)));
  const seal = frame.view.layout.landmarks.find(item => item.id === 'seal');
  const chamberCamera = { target: [seal.point[0], seal.point[1] + 0.22, seal.point[2]], dist: 1.2, yaw: -Math.PI / 2 };
  const chamber = draw(assembled, { camera: chamberCamera })(), clearChamber = draw(assembled, { camera: chamberCamera, water: false })();
  if (clearChamber[0] < 110) throw new Error('chamber seal missing from the compiled frame');
  close(chamber, clearChamber, 'chamber seal stays clear inside the shared air pocket');
  const tunnelCamera = { target: [8.6, -2.5, 0.54], dist: 2.1, yaw: -Math.PI / 2 };
  const tunnel = draw(assembled, { camera: tunnelCamera })(), dryTunnel = draw(assembled, { camera: tunnelCamera, water: false })();
  if (dryTunnel[0] - tunnel[0] < 15) throw new Error('compiled tunnel should absorb through water');
  renderer.dispose();
}

test('WebGL traces water before each splat and through perspective and orthographic waterlines', {
  skip: !process.env.INK_TEST_CHROME
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-water-'));
  try {
    const browserEntry = pathToFileURL(path.resolve(__dirname, '../webgl.mjs')).href;
    const resources = pathToFileURL(path.resolve(__dirname, '../src/webgl/resources.mjs')).href;
    fs.writeFileSync(path.join(temp, 'bundle.js'), core.bundle());
    fs.writeFileSync(path.join(temp, 'water.html'), `<!doctype html><canvas></canvas><pre id="result">PENDING</pre>
<script src="bundle.js"></script><script type="module">
import { createRenderer, pixelShaderSources } from ${JSON.stringify(browserEntry)};
import { createResources } from ${JSON.stringify(resources)};
const result = document.querySelector('#result');
try {
  (${browserProbe.toString()})(createRenderer, (gl, pixel) => {
    const shaders = pixelShaderSources(pixel, { water: true });
    const resources = createResources(gl);
    resources.program(shaders.SPR_VS, shaders.SPR_FS);
    resources.dispose();
  }, ${coastline.toString()});
  result.textContent = 'PASS';
} catch (error) { result.textContent = error.stack; }
</script>`);
    const html = execFileSync(process.env.INK_TEST_CHROME, [
      '--headless', '--no-first-run', '--disable-background-networking', '--allow-file-access-from-files',
      '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--user-data-dir=' + path.join(temp, 'profile'),
      '--dump-dom', pathToFileURL(path.join(temp, 'water.html')).href
    ], { timeout: 60000, encoding: 'utf8', maxBuffer: 4e6, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(html.match(/<pre id="result">([^<]*)<\/pre>/)?.[1], 'PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
