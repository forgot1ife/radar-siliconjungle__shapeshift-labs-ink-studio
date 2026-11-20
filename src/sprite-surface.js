// Pack nearest-sampled pixel art for depth-tested, world-space surfaces.
const SpriteSurface = (() => {
  function make(width = 1024, limit = 4096) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(limit) || limit < 1)
      throw new RangeError('Expected positive atlas dimensions');
    let x = 0, y = 0, shelf = 0;
    const entries = [], vertices = [];
    function face(origin, right, up, w, h, paint) {
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || w > width || h < 1 ||
          ![origin, right, up].every(v => v.length === 3 && v.every(Number.isFinite)))
        throw new RangeError('Expected a finite surface frame and bounded sprite dimensions');
      if (x + w > width) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      if (y + h > limit) throw new RangeError('Sprite surface atlas is full');
      const pixels = new Uint8Array(w * h * 4);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const ink = paint(i, j), offset = (j * w + i) * 4;
        if (ink == null) continue;
        pixels[offset] = (ink >>> 16) & 255;
        pixels[offset + 1] = (ink >>> 8) & 255;
        pixels[offset + 2] = ink & 255;
        pixels[offset + 3] = 255;
      }
      entries.push({ x, y, w, h, pixels });
      // The image is authored from its upper-left corner. World +up is the
      // top of the face, independently of which way the façade points.
      for (const [u, v] of [[0,0],[1,0],[0,1],[0,1],[1,0],[1,1]]) {
        for (let a = 0; a < 3; a++) vertices.push(origin[a] + right[a] * u + up[a] * (1 - v));
        vertices.push(x + .5 + (w - 1) * u, y + .5 + (h - 1) * v);
      }
      x += w;
      shelf = Math.max(shelf, h);
    }
    function finish() {
      const height = Math.max(1, y + shelf), pixels = new Uint8Array(width * height * 4);
      for (const e of entries) for (let row = 0; row < e.h; row++) {
        pixels.set(e.pixels.subarray(row * e.w * 4, (row + 1) * e.w * 4), ((row + e.y) * width + e.x) * 4);
      }
      return { width, height, pixels, vertices: Float32Array.from(vertices) };
    }
    return { face, finish };
  }
  const updates = new WeakMap();
  function markDirty(atlas, rect = { x: 0, y: 0, width: atlas.width, height: atlas.height }) {
    if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height) ||
      rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > atlas.width || rect.y + rect.height > atlas.height)
      throw new RangeError('Invalid atlas update rectangle');
    const revision = (atlas.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('Invalid atlas revision');
    atlas.revision = revision;
    if (!updates.has(atlas)) updates.set(atlas, []);
    const history = updates.get(atlas); history.push({ revision, ...rect });
    if (history.length > 32) history.shift();
    return revision;
  }
  function updatesSince(atlas, revision) {
    if (revision === (atlas.revision ?? 0)) return [];
    const rows = (updates.get(atlas) ?? []).filter(row => row.revision > revision);
    return rows[0]?.revision === revision + 1 && rows.at(-1).revision === atlas.revision ? rows.map(row => ({ ...row })) : null;
  }
  return Object.freeze({ make, markDirty, updatesSince });
})();
if (typeof module !== 'undefined') module.exports = SpriteSurface;
