/* Headless chunk realization from biome intent and one shared physical frame. */
(function (K) {
  const P = K.procedural, { freeze, hash, clone } = P.data;
  const V = K.V, finite = Number.isFinite, integer = Number.isSafeInteger;
  const coordinates = (v, length, check = finite) => Array.isArray(v) && v.length === length && Array.from(v).every(check);
  const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const named = v => typeof v === 'string' && v.length > 0;
  const positive = v => finite(v) && v > 0;
  const checked = (v, what) => { if (!finite(v)) throw new RangeError(what + ' returned a nonfinite value'); return v; };

  function segmentInBox(a, b, box) {
    let lo = 0, hi = 1;
    const delta = V.sub(b, a);
    for (let i = 0; i < 3; i++) {
      if (delta[i] === 0) {
        if (a[i] < box.min[i] || (i === 1 ? a[i] > box.max[i] : a[i] >= box.max[i])) return null;
      } else {
        const enter = (box.min[i] - a[i]) / delta[i], exit = (box.max[i] - a[i]) / delta[i];
        lo = Math.max(lo, Math.min(enter, exit));
        hi = Math.min(hi, Math.max(enter, exit));
        if (hi <= lo) return null;
      }
    }
    return [V.mad(a, delta, lo), V.mad(a, delta, hi)];
  }

  function latticeField(grid, bounds, cell, values) {
    const cells = grid.max.map((v, i) => v - grid.min[i]), size = freeze(cells.map(v => v + 1));
    const at = (x, y, z) => values[x + size[0] * (y + size[1] * z)];
    function sample(x, y, z) {
      const point = [x, y, z];
      if (!P.spatial.contains(bounds, point)) return null;
      const q = point.map((v, i) => v === bounds.min[i] ? 0 : v === bounds.max[i] ? cells[i] :
        Math.max(0, Math.min(cells[i], v / cell - grid.min[i])));
      const base = q.map((v, i) => Math.min(cells[i] - 1, Math.floor(v)));
      const fraction = q.map((v, i) => v - base[i]);
      let sum = 0;
      for (const [dx, dy, dz] of P.geometry.hermite.corners) {
        const w = (dx ? fraction[0] : 1 - fraction[0]) * (dy ? fraction[1] : 1 - fraction[1]) *
          (dz ? fraction[2] : 1 - fraction[2]);
        sum += w * at(base[0] + dx, base[1] + dy, base[2] + dz);
      }
      return sum;
    }
    return Object.freeze({ size, cell, origin: bounds.min, sample, values: () => values.slice() });
  }

  function create({
    height, caves = [], cell = 0.25, chunkCells = 16, verticalCells = [-24, 24], terrainSlope = 1,
    layers = [], project, emit, palette = [0x13232b, 0x435a58, 0x78927a, 0xbdba92, 0xede0b9],
    dependencyHalo = 0, maxSplats = 50000
  } = {}) {
    if (typeof height !== 'function' || !positive(cell) || cell < 1e-6 || !integer(chunkCells) || chunkCells < 1 ||
        !coordinates(verticalCells, 2, integer) || verticalCells[0] >= verticalCells[1] ||
        verticalCells[1] - verticalCells[0] > 4096 || verticalCells.some(v => Math.abs(v * cell) >= 1e6) ||
        chunkCells ** 2 * (verticalCells[1] - verticalCells[0]) > 250000 || !finite(terrainSlope) || terrainSlope < 0 ||
        !Array.isArray(caves) || !Array.isArray(layers) || layers.length > 64 ||
        (emit !== undefined && typeof emit !== 'function') || (project !== undefined && typeof project !== 'function') ||
        !Array.isArray(palette) || !palette.length || palette.length > 64 ||
        !Array.from(palette).every(v => integer(v) && v >= 0 && v <= 0xffffff) ||
        !finite(dependencyHalo) || dependencyHalo < 0 || !integer(maxSplats) || maxSplats < 1)
      throw new Error('Invalid headless biome world options');
    const pal = Object.freeze(palette.slice()), [bottom, top] = verticalCells, size = cell * chunkCells;
    const caveIndex = P.spatial.pointIndex(Array.from(caves, cave => {
      if (!coordinates(cave?.bounds?.min, 3) || !coordinates(cave?.bounds?.max, 3) || typeof cave.sdf !== 'function')
        throw new Error('A biome cave needs XYZ bounds and a negative-inside field');
      return { bounds: cave.bounds, sdf: cave.sdf };
    }));
    const names = new Set();
    const population = Array.from(layers, layer => {
      if (!named(layer?.id) || names.has(layer.id) || (layer.height !== undefined && typeof layer.height !== 'function') ||
          (layer.habitatOffset !== undefined && !finite(layer.habitatOffset)))
        throw new Error('Population layers need unique IDs and optional height samplers and offsets');
      names.add(layer.id);
      const options = P.populations.parameters(clone(layer.options ?? {}));
      return { id: layer.id, height: layer.height, habitatOffset: layer.habitatOffset, options };
    }).sort((a, b) => order(a.id, b.id));
    const halo = Math.max(dependencyHalo, cell, ...population.map(({ options }) =>
      options.exclusion ? options.exclusion.maxDistance + options.spacing : 0));
    const frames = new WeakMap(), emptyWater = P.waterBodies.scene([]);
    const sun = V.norm([-0.43, 0.84, 0.31]), slopeFactor = 1 / Math.hypot(1, terrainSlope);
    const epsilon = cell * 0.027;

    function prepare(source, { water = emptyWater, time = 0 } = {}) {
      if (typeof source?.withEnvironment !== 'function' || typeof water?.changesFrom !== 'function' || !finite(time))
        throw new Error('A world frame needs a biome recipe view, a water scene and finite time');
      const terrain = source.withEnvironment({ media: water.media, solid: undefined, project: undefined });
      const heightAt = (x, z) => {
        const base = checked(height(x, z), 'Terrain height');
        return checked(base + terrain.heightOffsetAt(x, base, z, time), 'Realized height');
      };
      function field(sampleHeight) {
        return function distance(x, y, z) {
          const point = [x, y, z];
          let value = (y - sampleHeight(x, z)) * slopeFactor;
          caveIndex(point, ({ sdf }) => {
            value = Math.max(value, -checked(sdf(x, y, z), 'Cave field'));
          });
          return value;
        };
      }
      const evaluate = field(heightAt);
      function distance(x, y, z) {
        if (![x, y, z].every(finite)) throw new Error('World collision queries need finite XYZ coordinates');
        return evaluate(x, y, z);
      }
      function normalOf(sample, x, y, z) {
        return [sample(x + epsilon, y, z) - sample(x - epsilon, y, z),
          sample(x, y + epsilon, z) - sample(x, y - epsilon, z),
          sample(x, y, z + epsilon) - sample(x, y, z - epsilon)];
      }
      function supports(x, z, low, high) {
        if (![x, z, low, high].every(finite) || low > high) throw new Error('Supports need a finite ordered height range');
        const start = Math.max(low, bottom * cell), end = Math.min(high, top * cell), result = [];
        if (end < start) return result;
        const count = Math.max(1, Math.ceil((end - start) / (cell * 0.5)));
        let last = start - epsilon, wasIn = distance(x, last, z) < 0;
        for (let i = 0; i <= count; i++) {
          const y = start + (end - start) * i / count, inside = distance(x, y, z) < 0;
          if (wasIn && !inside) {
            let a = last, b = y;
            for (let j = 0; j < 18; j++) {
              const m = (a + b) / 2;
              if (distance(x, m, z) < 0) a = m;
              else b = m;
            }
            const normal = V.norm(normalOf(distance, x, b, z));
            if (b >= start - epsilon && normal[1] > 0) {
              const surface = Math.abs(heightAt(x, z) - b) < epsilon ? 'terrain' : 'cave';
              result.push({ y: b, normal, id: surface });
              if (result.length > 256) throw new RangeError('World support count exceeds the traversal budget');
            }
          }
          last = y;
          wasIn = inside;
        }
        return result;
      }
      const geometry = Object.freeze({ heightAt, distance, supports });
      function onSupport(point, feature) {
        if (project) return project(point, feature, geometry);
        const [x, y, z] = point, all = supports(x, z, bottom * cell, top * cell);
        all.sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
        return all.length ? [x, all[0].y, z] : point;
      }
      const view = source.withEnvironment({ media: water.media, solid: distance,
        project: onSupport });

      function traceRoute(points, { radius = 0.18, stride = Math.min(cell / 4, radius / 2), maxSamples = 16000 } = {}) {
        const route = P.routes.polyline(points);
        if (!positive(radius) || !positive(stride) || stride > radius || !integer(maxSamples) || maxSamples < 1 ||
            Math.ceil(route.length / stride) + points.length > maxSamples)
          throw new Error('Route needs a positive radius and bounded stride and sample count');
        const media = [];
        let count = 0, clearance = Infinity;
        for (let i = 1; i < route.points.length; i++) {
          const start = route.points[i - 1], end = route.points[i], delta = V.sub(end, start);
          const length = V.len(delta), steps = Math.ceil(length / stride);
          for (let j = i === 1 ? 0 : 1; j <= steps; j++) {
            const point = V.mad(start, delta, j / steps), gap = distance(...point);
            count++;
            clearance = Math.min(clearance, gap);
            if (gap < radius + stride / 2) return freeze({ ok: false, blocked: point, clearance, count, media });
            const { kind, id } = view.mediumAt(...point, time);
            if (media.at(-1)?.kind !== kind || media.at(-1)?.id !== id) media.push({ kind, id, point });
          }
        }
        return freeze({ ok: true, clearance, count, media });
      }
      const frame = Object.freeze({ water, view, time, ...geometry, traceRoute,
        traversal: body => P.traversal.create({ ...body, supports, clearance: point => distance(...point) }) });
      frames.set(frame, { field, normalOf });
      return frame;
    }

    function address(index) {
      if (!coordinates(index, 2, integer) || index.some(v => Math.abs(v * size) > 1e6 - size))
        throw new Error('A biome chunk needs finite, bounded integer XZ indices');
      const [x, z] = index.map(v => v * chunkCells);
      const grid = { min: [x, bottom, z], max: [x + chunkCells, top, z + chunkCells] };
      const bounds = freeze({ min: grid.min.map(v => v * cell), max: grid.max.map(v => v * cell) });
      return { index: index.slice(), key: index.join('/'), grid, bounds };
    }

    function build(frame, index) {
      const internals = frames.get(frame);
      if (!internals) throw new Error('Expected a frame from this biome world');
      const { key, grid, bounds } = address(index), { view, time } = frame;
      const columns = new Map();
      function heightAt(x, z) {
        const id = x + '/' + z;
        if (!columns.has(id)) columns.set(id, frame.heightAt(x, z));
        return columns.get(id);
      }
      const distance = internals.field(heightAt);
      const surface = P.geometry.surfaceNets(distance, bounds, {
        cell, latticeBounds: grid, topology: false, refine: 1, captureField: true,
        normal: (x, y, z) => internals.normalOf(distance, x, y, z)
      });
      const builder = makeBuilder(hash(key, view.seed), pal, { renderMetadata: false }), ids = [];
      if (surface.points.length > maxSplats) throw new RangeError('Biome chunk exceeds its splat budget');
      const owned = p => P.spatial.contains(bounds, p) && p[0] < bounds.max[0] && p[2] < bounds.max[2];
      for (let i = 0; i < surface.points.length; i++) {
        const point = surface.points[i], normal = surface.normals[i];
        const coord = surface.active[i].key.split('/').map((v, axis) => Number(v) + grid.min[axis]);
        const surfaceY = heightAt(point[0], point[2]);
        const appearance = view.materialAt(...point, { surfaceY, time, probe: V.mad(point, normal, cell * 0.22) });
        const shade = Math.max(0, V.dot(normal, sun));
        const color = appearance.ramp[Math.round(shade * (appearance.ramp.length - 1))].map(v => Math.round(v * 255));
        builder.disc(...point, normal, cell * 0.52, cell * 0.11, color, 1);
        ids.push('surface/' + coord.join('/'));
      }
      const placements = [];
      const ground = (x, z) => {
        const y = heightAt(x, z);
        return distance(x, y - epsilon, z) < 0 ? y : null;
      };
      for (const layer of population) {
        const plan = view.populate(bounds, { ...layer.options, layer: layer.id, time, habitatOffset: layer.habitatOffset,
          height: layer.height ? (x, z) => layer.height(x, z, frame) : ground });
        for (const row of plan.instances) if (owned(row.sample.position)) {
          placements.push({ kind: 'population', id: 'population/' + row.id, point: row.sample.position, asset: row.sample.asset,
            species: row.sample.species, biome: row.sample.biome, seed: row.seed, yaw: row.yaw, scale: row.scale });
        }
      }
      for (const marker of view.layout.landmarks) if (owned(marker.point)) {
        const id = 'landmark/' + JSON.stringify([marker.region, marker.id]);
        placements.push({ ...marker, kind: 'landmark', id, seed: hash(id, view.seed) });
      }
      const routes = [];
      for (const route of view.layout.routes) for (let i = 1; i < route.points.length; i++) {
        const points = segmentInBox(route.points[i - 1], route.points[i], bounds);
        if (points) routes.push({ region: route.region, route: route.id, segment: i - 1, points, pinned: route.pinned });
      }
      const scenePlacements = freeze(placements.sort((a, b) => order(a.id, b.id)));
      for (const item of scenePlacements) {
        const first = builder.count();
        if (emit) emit(builder, item, frame);
        else builder.iso(...item.point, cell * 0.22, builder.P.at(-1), 1);
        for (let i = first; i < builder.count(); i++) ids.push(item.id + '/' + (i - first));
        if (builder.count() > maxSplats) throw new RangeError('Biome chunk exceeds its splat budget');
      }
      if (builder.count() > maxSplats) throw new RangeError('Biome chunk exceeds its splat budget');
      const { data, count, moving, back } = builder.finish();
      return Object.freeze({ key, index: freeze(index.slice()), bounds, placements: scenePlacements, routes: freeze(routes),
        field: latticeField(grid, bounds, cell, surface.fieldSamples()),
        work: freeze({ ...surface.work, heightColumns: columns.size }), splats: Object.freeze({ data, count, moving, back, ids: freeze(ids) }) });
    }

    function makeWorld(frame, chunks, meta = {}) {
      if (!frames.has(frame) || !Array.isArray(chunks)) throw new Error('Expected a prepared frame and built chunks');
      const sorted = chunks.slice().sort((a, b) => order(a.key, b.key));
      if (sorted.some((chunk, i) => i > 0 && chunk.key === sorted[i - 1].key))
        throw new Error('World chunks need distinct keys');
      const count = sorted.reduce((sum, chunk) => sum + chunk.splats.count, 0);
      const data = new Float32Array(count * 16), moving = [], back = [], splatIds = [];
      let first = 0;
      for (const { splats } of sorted) {
        data.set(splats.data, first * 16);
        for (const id of splats.ids) splatIds.push(id);
        for (const row of splats.moving) moving.push(first + row);
        for (const row of splats.back) back.push(first + row);
        first += splats.count;
      }
      return { radius: 14, detail: 1 / cell, dither: 1, fog: { c: 0, start: 1, max: 0 },
        ...meta, cam: { target: [0, 0, 0], dist: 12, yaw: 0, pitch: 0, ...meta.cam }, water: frame.water, pal,
        count, data, splatIds: freeze(splatIds), moving: Int32Array.from(moving), back: Int32Array.from(back) };
    }

    let building, published = null, queue = Promise.resolve();
    const cache = P.chunks.create({ preview: entry => build(building, entry.input) });
    function update(frame, indices) {
      if (!frames.has(frame) || !Array.isArray(indices) || indices.length > 4096)
        throw new Error('Expected a prepared frame and a bounded chunk set');
      const requests = indices.map(address);
      const pending = queue.then(async () => {
        const before = published;
        const intent = before && frame.view.changesFrom(before.view);
        const water = before ? frame.water.changesFrom(before.water) : [];
        const dirty = before ? [...intent.regions, ...water] : [];
        const all = before && (intent.global || before.time !== frame.time || dirty.length > 4096);
        building = frame;
        let patch;
        try {
          patch = await cache.update(requests.map(({ index, key, bounds }) => ({
            key, revision: 1, bounds: P.spatial.expand(bounds, halo), input: index
          })), {
            changedIds: all ? requests.map(row => row.key) : [],
            regions: all ? [] : dirty.map(box => ({
              min: [box.min[0], bottom * cell, box.min[2]], max: [box.max[0], top * cell, box.max[2]]
            }))
          });
        } finally {
          building = null;
        }
        published = frame;
        return Object.freeze({ sequence: patch.sequence, frame, removed: patch.removed,
          replaced: Object.freeze(patch.replaced.map(row => row.value)) });
      });
      queue = pending.catch(() => {});
      return pending;
    }
    return Object.freeze({ prepare, build, update, makeWorld, frame: () => published,
      chunks: () => Object.freeze(cache.entries().map(row => row.value)) });
  }

  P.biomeWorld = Object.freeze({ create });
})(KIT);
