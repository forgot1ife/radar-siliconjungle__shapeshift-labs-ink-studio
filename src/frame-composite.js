/* Output-space layers with independent sample grids. All images use top-down rows. */
const FrameComposite = (() => {
  const byte = data => data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  const positive = n => Number.isSafeInteger(n) && n > 0;
  const tuple = (value, length) => Array.isArray(value) && value.length === length && Array.from(value).every(Number.isFinite);
  const clamp = n => Math.min(1, Math.max(0, n));

  function record(value, fields, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
      throw new TypeError('Invalid ' + name);
  }

  function resolution(value) {
    if (value === undefined || positive(value)) return value;
    if (tuple(value, 2) && value.every(positive)) return value.slice();
    throw new RangeError('Resolution must be a positive pixel size or [width, height]');
  }

  function filter(value = 'nearest') {
    if (value !== 'nearest' && value !== 'linear') throw new TypeError('Layer filter must be nearest or linear');
    return value;
  }

  function image(source) {
    const { w, h, rgba, rgb, alpha } = source ?? {};
    if (!positive(w) || !positive(h)) throw new RangeError('A composite source needs positive integer dimensions');
    const length = w * h;
    if (rgba !== undefined ? !byte(rgba) || rgba.length !== length * 4 :
      !byte(rgb) || rgb.length !== length * 3 || alpha !== undefined && (!byte(alpha) || alpha.length !== length))
      throw new TypeError('A composite source needs top-down RGBA bytes, or RGB and optional alpha bytes');
    return source;
  }

  function color(value = '#ffffff') {
    if (typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      const rgba = value.slice(1).match(/../g).map(pair => parseInt(pair, 16));
      return rgba.length === 3 ? [...rgba, 255] : rgba;
    }
    throw new TypeError('Drawing color must be #rrggbb or #rrggbbaa');
  }

  function strokeWidth(value) {
    if (!(Number.isFinite(value) && value > 0)) throw new RangeError('Stroke width must be positive and finite');
    return value;
  }

  function command(value) {
    switch (value?.type) {
      case 'text': {
        record(value, ['type', 'text', 'at', 'size', 'width', 'color'], 'text command');
        const { text, at, size = 12, width } = value;
        if (typeof text !== 'string' || !tuple(at, 2)) throw new TypeError('Text needs a string and XY anchor');
        return { type: 'text', text, at: at.slice(), size: strokeWidth(size),
          width: width === undefined ? undefined : strokeWidth(width), color: color(value.color) };
      }
      case 'path': {
        record(value, ['type', 'points', 'width', 'closed', 'color'], 'path command');
        const { points, width = 1, closed = false } = value;
        if (!Array.isArray(points) || points.length < 2 || !Array.from(points).every(point => tuple(point, 2)) ||
            typeof closed !== 'boolean') throw new TypeError('A path needs at least two XY points and a boolean closed flag');
        return { type: 'path', points: points.map(point => point.slice()), width: strokeWidth(width), closed, color: color(value.color) };
      }
      case 'rect': {
        record(value, ['type', 'rect', 'color'], 'rectangle command');
        const { rect } = value;
        if (!tuple(rect, 4) || rect[2] <= 0 || rect[3] <= 0) throw new RangeError('A rectangle needs finite XY and positive size');
        return { type: 'rect', rect: rect.slice(), color: color(value.color) };
      }
      default: throw new TypeError('Drawing commands support text, path and rect');
    }
  }

  function settings(value) {
    if (value === false || value === undefined) return null;
    record(value, ['world', 'layers'], 'frame composite');
    const { world = {}, layers = [] } = value;
    record(world, ['resolution', 'filter'], 'world composite');
    if (!Array.isArray(layers)) throw new TypeError('Composite layers must be an ordered list');
    return { world: { resolution: resolution(world.resolution), filter: filter(world.filter) },
      layers: Array.from(layers, layer => {
        record(layer, ['resolution', 'filter', 'opacity', 'blend', 'draw', 'source'], 'composite layer');
        const { opacity = 1, blend = 'over', draw, source } = layer;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('Layer opacity must be in [0, 1]');
        if (blend !== 'over' && blend !== 'add') throw new TypeError('Layer blend must be over or add');
        if ((draw === undefined) === (source === undefined) || draw !== undefined && !Array.isArray(draw))
          throw new TypeError('A layer needs either drawing commands or a raster source');
        if (source !== undefined && typeof source !== 'function') image(source);
        return { resolution: resolution(layer.resolution), filter: filter(layer.filter), opacity, blend, source,
          draw: draw && Array.from(draw, command) };
      }) };
  }

  function size(value, w, h) {
    const [width, height] = Array.isArray(value) ? value : [Math.ceil(w / value), Math.ceil(h / value)];
    if (!positive(width) || !positive(height) || width * height > 0x1fffffff)
      throw new RangeError('Composite dimensions exceed the supported byte buffer size');
    return { w: width, h: height };
  }

  function prepare(value, w, h, pixelSize = 1) {
    const prepared = settings(value);
    if (!prepared) return null;
    size(1, w, h);
    return { ...size(1, w, h),
      world: { ...size(prepared.world.resolution ?? resolution(pixelSize), w, h), filter: prepared.world.filter },
      layers: prepared.layers.map(layer => {
        const grid = layer.resolution ?? (layer.source && typeof layer.source !== 'function' ? [layer.source.w, layer.source.h] : 1);
        return { ...layer, ...size(grid, w, h) };
      }) };
  }

  function pixels(source) {
    const { w, h, rgba, rgb, alpha } = image(source);
    const output = new Uint8Array(w * h * 4);
    const data = rgba ?? rgb, stride = rgba ? 4 : 3;
    for (let p = 0; p < w * h; p++) {
      const i = p * 4, j = p * stride;
      const a = rgba ? rgba[i + 3] : alpha?.[p] ?? 255;
      for (let c = 0; c < 3; c++) output[i + c] = Math.round(data[j + c] * a / 255);
      output[i + 3] = a;
    }
    return { w, h, data: output };
  }

  function drawLayer(layer, w, h, text) {
    const data = new Uint8Array(layer.w * layer.h * 4);
    const mask = new Float32Array(layer.w * layer.h);
    const sx = w / layer.w, sy = h / layer.h, aa = Math.max(sx, sy);
    let dirty;
    // Limit work to the affected output-space bounds of each command.
    function raster(x, y, right, bottom, sample) {
      const x0 = Math.max(0, Math.floor(x / sx)), y0 = Math.max(0, Math.floor(y / sy));
      const x1 = Math.min(layer.w, Math.ceil(right / sx)), y1 = Math.min(layer.h, Math.ceil(bottom / sy));
      if (x1 <= x0 || y1 <= y0) return;
      dirty = dirty ? [Math.min(x0, dirty[0]), Math.min(y0, dirty[1]), Math.max(x1, dirty[2]), Math.max(y1, dirty[3])] :
        [x0, y0, x1, y1];
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
        const p = j * layer.w + i;
        mask[p] = Math.max(mask[p], sample(i * sx, j * sy));
      }
    }
    function path(points, width, closed) {
      const radius = width * .5, reach = radius + aa * .5;
      for (let i = 1; i < points.length + Number(closed); i++) {
        const [ax, ay] = points[i - 1], [bx, by] = points[i % points.length];
        const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
        raster(Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach, (x, y) => {
          const X = x + sx * .5 - ax, Y = y + sy * .5 - ay;
          const t = length ? clamp((X * dx + Y * dy) / length) : 0;
          return clamp(.5 + (radius - Math.hypot(X - dx * t, Y - dy * t)) / aa);
        });
      }
    }
    for (const draw of layer.draw) {
      if (draw.type === 'path') path(draw.points, draw.width, draw.closed);
      else if (draw.type === 'text') {
        const glyphs = text(draw.text, draw.size, { width: draw.width });
        const [x, y] = draw.at;
        for (const stroke of glyphs.strokes)
          path(stroke.map(([dx, dy]) => [x + dx, y - dy]), glyphs.width, false);
      } else {
        const [x, y, width, height] = draw.rect, right = x + width, bottom = y + height;
        raster(x, y, right, bottom, (u, v) =>
          (Math.min(u + sx, right) - Math.max(u, x)) * (Math.min(v + sy, bottom) - Math.max(v, y)) / (sx * sy));
      }
      if (!dirty) continue;
      const rgba = draw.color, [x0, y0, x1, y1] = dirty;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const p = y * layer.w + x;
        if (!mask[p]) continue;
        const a = rgba[3] / 255 * mask[p], q = p * 4;
        for (let c = 0; c < 4; c++)
          data[q + c] = Math.round(data[q + c] * (1 - a) + (c === 3 ? 255 : rgba[c]) * a);
        mask[p] = 0;
      }
      dirty = undefined;
    }
    return { w: layer.w, h: layer.h, data };
  }

  function layers(plan, world, time, text) {
    return plan.layers.filter(layer => layer.opacity > 0).map(layer => {
      const { w, h } = layer;
      const result = layer.draw ? drawLayer(layer, plan.w, plan.h, text) : pixels(
        typeof layer.source === 'function' ? layer.source({ w, h, outputWidth: plan.w, outputHeight: plan.h, world, time }) : layer.source);
      if (result.w !== w || result.h !== h) throw new RangeError('Composite raster dimensions must match the layer resolution');
      return { ...result, filter: layer.filter, blend: layer.blend, opacity: layer.opacity };
    });
  }

  function resample(layer, w, h, visit) {
    const { data, w: width, h: height } = layer, sample = new Float64Array(4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + .5) * width / w, v = (y + .5) * height / h;
      if (layer.filter === 'linear') {
        const nx = Math.max(0, Math.min(width - 1, u - .5)), ny = Math.max(0, Math.min(height - 1, v - .5));
        const ix = Math.floor(nx), iy = Math.floor(ny), dx = nx - ix, dy = ny - iy;
        const aa = (iy * width + ix) * 4, ba = ix + 1 < width ? aa + 4 : aa;
        const ab = iy + 1 < height ? aa + width * 4 : aa, bb = ab + ba - aa;
        for (let c = 0; c < 4; c++)
          sample[c] = ((1 - dx) * data[aa + c] + dx * data[ba + c]) * (1 - dy) +
            ((1 - dx) * data[ab + c] + dx * data[bb + c]) * dy;
      } else {
        const q = (Math.floor(v) * width + Math.floor(u)) * 4;
        for (let c = 0; c < 4; c++) sample[c] = data[q + c];
      }
      visit((y * w + x) * 4, sample);
    }
  }

  function compose(base, overlays, w, h, filter) {
    const data = new Uint8Array(w * h * 4);
    resample({ ...pixels(base), filter }, w, h, (p, sample) => {
      for (let c = 0; c < 4; c++) data[p + c] = Math.round(sample[c]);
    });
    for (const layer of overlays) {
      const add = layer.blend === 'add', opacity = layer.opacity;
      resample(layer, w, h, (p, sample) => {
        const remaining = 1 - sample[3] * opacity / 255;
        const a = Math.round(data[p + 3] * remaining + sample[3] * opacity);
        for (let c = 0; c < 3; c++)
          data[p + c] = Math.min(a, Math.round(data[p + c] * (add ? 1 : remaining) + sample[c] * opacity));
        data[p + 3] = a;
      });
    }
    const rgb = new Uint8Array(w * h * 3), alpha = base.alpha && new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const a = data[p * 4 + 3];
      if (alpha) alpha[p] = a;
      if (a) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round(data[p * 4 + c] * 255 / a);
    }
    return { w, h, rgb, ...(alpha && { alpha }) };
  }

  return Object.freeze({ settings, prepare, layers, compose });
})();
if (typeof module !== 'undefined') module.exports = FrameComposite;
