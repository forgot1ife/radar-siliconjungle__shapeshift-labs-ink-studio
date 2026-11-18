/* Versioned paint strokes on named planar surfaces. The scene supplies the
   current chart after each edit; saved colors address cells in chart space. */
(function (K) {
  const FORMAT = 'ink-studio/surface-paint',
    MAX_DABS = 8192,
    MAX_SURFACES = 8,
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

  function chart(id, origin, u, v, columns, rows) {
    if (typeof id !== 'string' || !id || !vector(origin) || !vector(u) || !vector(v) ||
        !Number.isSafeInteger(columns) || columns < 1 || columns > 512 ||
        !Number.isSafeInteger(rows) || rows < 1 || rows > 512) {
      throw new Error('A paint chart needs a stable name, a frame and positive cell counts');
    }
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    if (!(length > 0) || !Number.isFinite(length)) throw new Error('A paint chart needs independent axes');
    const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
    if (!(det > 0) || !Number.isFinite(det)) throw new Error('A paint chart needs a finite inverse frame');
    return {
      id, origin: origin.slice(), u: u.slice(), v: v.slice(), normal: normal.map(x => x === 0 ? 0 : x / length),
      inverseU: u.map((x, i) => (x * vv - v[i] * uv) / det),
      inverseV: v.map((x, i) => (x * uu - u[i] * uv) / det),
      columns, rows, tolerance: Math.min(Math.sqrt(uu) / columns, Math.sqrt(vv) / rows) * 0.45
    };
  }

  function cell(surface, position, normal, tolerance = surface.tolerance) {
    if (normal && dot(normal, surface.normal) < 0.5) return null;
    const offset = position.map((n, i) => n - surface.origin[i]);
    if (Math.abs(dot(offset, surface.normal)) > tolerance) return null;
    const s = dot(offset, surface.inverseU), t = dot(offset, surface.inverseV);
    if (s < 0 || s >= 1 || t < 0 || t >= 1) return null;
    return [surface.id, Math.floor(s * surface.columns), Math.floor(t * surface.rows)];
  }

  function document(dabs = []) {
    if (!Array.isArray(dabs) || dabs.length > MAX_DABS || !dabs.every(dab =>
      Array.isArray(dab) && dab.length === 4 && typeof dab[0] === 'string' && dab[0] &&
      dab.slice(1).every(n => Number.isSafeInteger(n) && n >= 0))) {
      throw new Error('Paint dabs need a surface, column, row and palette index');
    }
    return { format: FORMAT, version: 1, dabs: dabs.map(dab => dab.slice()) };
  }

  function read(paint) {
    if (!paint || paint.format !== FORMAT || paint.version !== 1) throw new Error('Unsupported surface paint document');
    return document(paint.dabs);
  }

  function atlas(paint, surfaces) {
    const charts = (surfaces || []).slice(0, MAX_SURFACES);
    const w = Math.max(1, ...charts.map(s => s.columns)), offsets = [];
    let height = 0;
    for (const s of charts) {
      offsets.push(height);
      height += s.rows;
    }
    const h = Math.max(1, height), pixels = new Uint8Array(w * h);
    const byId = new Map(charts.map((s, i) => [s.id, i]));
    for (const [id, x, y, color] of read(paint).dabs) {
      const i = byId.get(id), s = charts[i];
      if (s && x < s.columns && y < s.rows && color < 64) pixels[(offsets[i] + y) * w + x] = color + 1;
    }
    return { charts, offsets, w, h, pixels };
  }

  function colorAt(paintAtlas, position, normal) {
    const { charts, offsets, w, pixels } = paintAtlas;
    for (let i = 0; i < charts.length; i++) {
      const hit = cell(charts[i], position, normal);
      if (hit) {
        const index = pixels[(offsets[i] + hit[2]) * w + hit[1]];
        if (index) return index - 1;
      }
    }
    return -1;
  }

  function resolve(paint, surfaces) {
    const byId = new Map((surfaces || []).map(s => [s.id, s])), latest = new Map();
    for (const [id, column, row, color] of read(paint).dabs) {
      const surface = byId.get(id);
      if (!surface || column >= surface.columns || row >= surface.rows) continue;
      const u = (column + 0.5) / surface.columns, v = (row + 0.5) / surface.rows;
      const point = surface.origin.map((x, i) => x + surface.u[i] * u + surface.v[i] * v);
      const size = Math.min(Math.hypot(...surface.u) / surface.columns, Math.hypot(...surface.v) / surface.rows);
      latest.set(JSON.stringify([id, column, row]), [...point, ...surface.normal, color, size]);
    }
    return [...latest.values()];
  }

  K.pixel.surfacePaint = { chart, cell, document, read, resolve, atlas, colorAt, maxDabs: MAX_DABS };
})(KIT);
