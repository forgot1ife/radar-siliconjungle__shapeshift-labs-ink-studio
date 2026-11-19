/* A water frame shared by world queries and the WebGL ray integrator. */
(function (K) {
  const P = K.procedural;
  const maxAxis = 64, maxBodies = 8;
  const states = new WeakMap();
  const number = value => Number.isFinite(value) && Number.isFinite(Math.fround(value));
  const pair = value => Array.isArray(value) && value.length === 2 && number(value[0]) && number(value[1]);
  const unit = value => number(value) && value >= 0 && value <= 1;
  const name = value => typeof value === 'string' && value.trim().length > 0;
  const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  function optics({
    tint = [0.05, 0.25, 0.31], extinction = [0.8, 0.32, 0.18],
    surfaceColor = [0.46, 0.75, 0.79], surface = 0.22,
    refraction = 1.5, foam = 0.45, caustics = 0.26
  } = {}) {
    const rgb = values => Array.isArray(values) && values.length === 3 && Array.from(values).every(unit);
    if (!rgb(tint) || !rgb(surfaceColor) || !Array.isArray(extinction) || extinction.length !== 3 ||
        !Array.from(extinction).every(v => number(v) && v >= 0 && v <= 32) ||
        ![surface, foam, caustics].every(unit) || !number(refraction) || refraction < 0 || refraction > 4)
      throw new RangeError('Invalid water optics');
    return { tint: tint.slice(), extinction: extinction.slice(), surfaceColor: surfaceColor.slice(),
      surface, refraction, foam, caustics };
  }

  function create({ id, bounds, resolution = [1, 1], sample, optics: look } = {}) {
    if (!name(id) || !pair(bounds?.min) || !pair(bounds?.max) || !Array.isArray(resolution) ||
        resolution.length !== 2 || !Array.from(resolution).every(n => Number.isInteger(n) && n >= 1 && n <= maxAxis) ||
        typeof sample !== 'function')
      throw new TypeError('Water needs an ID, finite XZ bounds, a column sampler and a grid up to 64 × 64');
    const min = bounds.min.map(Math.fround), max = bounds.max.map(Math.fround);
    const [nx, nz] = resolution;
    const width = max[0] - min[0], length = max[1] - min[1];
    const dx = Math.fround(width / nx), dz = Math.fround(length / nz);
    if (!number(width) || !number(length) || !(dx > 0) || !(dz > 0))
      throw new RangeError('Water bounds need a positive extent representable on the GPU');
    const style = optics(look), data = new Float32Array(nx * nz * 4), wet = [];
    let low = Infinity, high = -Infinity;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const result = sample(min[0] + (x + 0.5) * dx, min[1] + (z + 0.5) * dz);
      if (result == null) continue;
      const { bed, surface, current = [0, 0] } = result;
      if (!number(bed) || !number(surface) || !pair(current) || !number(surface - bed))
        throw new RangeError('Water columns need finite bed, surface and XZ current');
      const bottom = Math.fround(bed), top = Math.fround(surface);
      if (top <= bottom) continue;
      const i = z * nx + x;
      data.set([bottom, top, ...current], i * 4);
      wet.push(i);
      low = Math.min(low, bottom);
      high = Math.max(high, top);
    }
    const extent = P.data.freeze({
      min: [min[0], wet.length ? low : 0, min[1]], max: [max[0], wet.length ? high : 0, max[1]]
    });
    function offsetAt(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z) || x < min[0] || x >= max[0] || z < min[1] || z >= max[1]) return -1;
      return (Math.min(nz - 1, Math.floor((z - min[1]) / dz)) * nx +
        Math.min(nx - 1, Math.floor((x - min[0]) / dx))) * 4;
    }
    function columnAt(x, z) {
      const o = offsetAt(x, z);
      return o >= 0 && data[o + 1] > data[o] ? {
        bed: data[o], surface: data[o + 1], depth: data[o + 1] - data[o], current: [data[o + 2], 0, data[o + 3]]
      } : null;
    }
    const medium = Object.freeze({
      id, kind: 'water', bounds: extent,
      surface: (x, z) => data[offsetAt(x, z) + 1],
      sdf(x, y, z) {
        const o = offsetAt(x, z);
        return o >= 0 && data[o + 1] > data[o] ? Math.max(data[o] - y, y - data[o + 1]) : 1;
      },
      current(x, y, z) {
        const o = offsetAt(x, z);
        return [data[o + 2], 0, data[o + 3]];
      }
    });
    function shoreline() {
      const edges = [];
      const edge = (x0, z0, x1, z1, y) => [
        [Math.min(max[0], min[0] + x0 * dx), y, Math.min(max[1], min[1] + z0 * dz)],
        [Math.min(max[0], min[0] + x1 * dx), y, Math.min(max[1], min[1] + z1 * dz)]
      ];
      const hasWater = (x, z) => {
        const o = (z * nx + x) * 4;
        return x >= 0 && x < nx && z >= 0 && z < nz && data[o + 1] > data[o];
      };
      for (const i of wet) {
        const x = i % nx, z = Math.floor(i / nx), y = data[i * 4 + 1];
        if (!hasWater(x - 1, z)) edges.push(edge(x, z + 1, x, z, y));
        if (!hasWater(x + 1, z)) edges.push(edge(x + 1, z, x + 1, z + 1, y));
        if (!hasWater(x, z - 1)) edges.push(edge(x, z, x + 1, z, y));
        if (!hasWater(x, z + 1)) edges.push(edge(x + 1, z + 1, x, z + 1, y));
      }
      return edges;
    }
    // Use the same immutable wet cells for art emission and medium queries.
    function particles({ count = 64, seed = 0 } = {}) {
      if (!Number.isInteger(count) || count < 0 || count > 10000 || !Number.isSafeInteger(seed))
        throw new RangeError('Water particles need a count from 0 to 10000 and an integer seed');
      const dice = K.grow.dice(P.data.hash(id, seed));
      return Array.from({ length: wet.length ? count : 0 }, () => {
        const i = wet[Math.floor(dice() * wet.length)], o = i * 4;
        const x = min[0] + (i % nx + 0.1 + 0.8 * dice()) * dx;
        const z = min[1] + (Math.floor(i / nx) + 0.1 + 0.8 * dice()) * dz;
        const y = data[o] + (data[o + 1] - data[o]) * (0.1 + 0.8 * dice());
        return { position: [x, y, z], current: [data[o + 2], 0, data[o + 3]] };
      });
    }
    const body = Object.freeze({ id, bounds: extent, columnAt, medium, shoreline, particles });
    states.set(body, { nx, nz, dx, dz, data, style, empty: !wet.length });
    return body;
  }

  function fromShallowWater(snapshot, { id, resolution = [snapshot?.width, snapshot?.height], optics } = {}) {
    if (typeof snapshot?.sample !== 'function') throw new TypeError('Expected a shallow-water snapshot');
    return create({
      id, bounds: snapshot.bounds, resolution, optics,
      sample(x, z) {
        const local = snapshot.sample(x, z);
        return local?.depth > 0 ? { bed: local.bed, surface: local.level, current: local.velocity } : null;
      }
    });
  }

  function scene(bodies) {
    if (!Array.isArray(bodies) || bodies.length > maxBodies || !Array.from(bodies).every(body => states.has(body)) ||
        new Set(bodies.map(body => body.id)).size !== bodies.length)
      throw new TypeError('A water scene holds up to eight water bodies with distinct IDs');
    const sorted = bodies.slice().sort(compare), active = sorted.filter(body => !states.get(body).empty);
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i].bounds, b = active[j].bounds;
      if (a.min.every((v, axis) => v < b.max[axis] && a.max[axis] > b.min[axis]))
        throw new RangeError('Water body bounds overlap: ' + active[i].id + ' and ' + active[j].id);
    }
    const media = Object.freeze(sorted.map(body => body.medium));
    const { mediumAt } = P.biomes.create({ media });
    function pack() {
      const rows = active.reduce((sum, body) => sum + states.get(body).nz, 0);
      const data = new Float32Array(maxAxis * Math.max(rows, 1) * 4);
      const boxesMin = new Float32Array(maxBodies * 4), boxesMax = new Float32Array(maxBodies * 4);
      const grids = new Float32Array(maxBodies * 4), tint = new Float32Array(maxBodies * 4);
      const extinction = new Float32Array(maxBodies * 4), highlights = new Float32Array(maxBodies * 4);
      let row = 0;
      active.forEach((body, i) => {
        const { nx, nz, dx, dz, data: grid, style } = states.get(body), o = i * 4;
        boxesMin.set([...body.bounds.min, row], o);
        boxesMax.set([...body.bounds.max, style.refraction], o);
        grids.set([dx, dz, nx, nz], o);
        tint.set([...style.tint, style.foam], o);
        extinction.set([...style.extinction, style.caustics], o);
        highlights.set([...style.surfaceColor, style.surface], o);
        for (let z = 0; z < nz; z++) data.set(grid.subarray(z * nx * 4, (z + 1) * nx * 4), (row + z) * maxAxis * 4);
        row += nz;
      });
      const uniforms = { u_waterCount: active.length, u_waterMin: boxesMin, u_waterMax: boxesMax,
        u_waterGrid: grids, u_waterTint: tint, u_waterLoss: extinction, u_waterHighlight: highlights };
      return { width: maxAxis, height: Math.max(rows, 1), data, uniforms };
    }
    return Object.freeze({ media, mediumAt, count: active.length, pack });
  }

  P.waterBodies = Object.freeze({ create, fromShallowWater, scene });
})(KIT);
