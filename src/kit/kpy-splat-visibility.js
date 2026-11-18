/* Conservative range culling for stationary and rigidly bound splats. */
(function (K) {
  const BLOCK = 128;

  function prepare(world) {
    const { count, data, dynamic } = world, blocks = [];
    const dynamicStart = dynamic?.start ?? count, dynamicEnd = dynamicStart + (dynamic?.count || 0);
    for (let start = 0; start < count; start += BLOCK) {
      const end = Math.min(start + BLOCK, count), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      const first = start * 16, kind = data[first + 11] % 16, bone = kind === 12 ? data[first + 12] : -1;
      let variance = 0, bounded = (kind === 0 || kind === 12) && (end <= dynamicStart || start >= dynamicEnd);
      for (let i = start; bounded && i < end; i++) {
        const o = i * 16;
        if (data[o + 11] % 16 !== kind || (kind === 12 && (data[o + 12] !== bone || data[o + 14] > 0))) {
          bounded = false;
          break;
        }
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], data[o + axis]);
          max[axis] = Math.max(max[axis], data[o + axis]);
        }
        const bound = Math.abs(data[o + 4]) + Math.abs(data[o + 8]) + Math.abs(data[o + 10]) +
          2 * (Math.abs(data[o + 5]) + Math.abs(data[o + 6]) + Math.abs(data[o + 9]));
        variance = Math.max(variance, bound);
      }
      blocks.push({
        start, end, bone, bounded: bounded && Number.isFinite(variance) && min.every(Number.isFinite) && max.every(Number.isFinite),
        center: min.map((x, i) => (x + max[i]) * 0.5), half: min.map((x, i) => (max[i] - x) * 0.5),
        radius: 3 * Math.sqrt(variance)
      });
    }
    return blocks;
  }

  function boneViews(bones, view) {
    const output = [];
    for (let i = 0; i + 11 < bones.length; i += 12) {
      const transform = new Float64Array(16);
      for (let row = 0; row < 3; row++) {
        const x = view[row], y = view[row + 4], z = view[row + 8];
        for (let col = 0; col < 3; col++)
          transform[col * 4 + row] = x * bones[i + col] + y * bones[i + col + 3] + z * bones[i + col + 6];
        transform[12 + row] = x * bones[i + 9] + y * bones[i + 10] + z * bones[i + 11] + view[12 + row];
      }
      const rowNorm = Math.max(...[0, 3, 6].map(j => Math.abs(bones[i + j]) + Math.abs(bones[i + j + 1]) + Math.abs(bones[i + j + 2])));
      const colNorm = Math.max(...[0, 1, 2].map(j => Math.abs(bones[i + j]) + Math.abs(bones[i + j + 3]) + Math.abs(bones[i + j + 6])));
      output.push({ transform, scale: Math.sqrt(rowNorm * colNorm) });
    }
    return output;
  }

  // Bound the screen ellipse before Gaussian rasterization. For a given side,
  // the shader clamps the perspective Jacobian slope to 1.3 times the frustum
  // slope. The variance bound covers any orientation of the covariance.
  function ranges(blocks, view, tanX, tanY, focal, near, scale, out, bones) {
    out.length = 0;
    const slopeX = Math.hypot(1, 1.3 * tanX), slopeY = Math.hypot(1, 1.3 * tanY);
    const poses = bones?.length ? boneViews(bones, view) : [];
    for (const block of blocks) {
      const pose = block.bone >= 0 ? poses[block.bone] : null;
      if (block.bounded && (block.bone < 0 || pose)) {
        const m = pose ? pose.transform : view;
        const [x, y, z] = block.center, [hx, hy, hz] = block.half;
        const depth = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
        const far = depth + Math.abs(m[2]) * hx + Math.abs(m[6]) * hy + Math.abs(m[10]) * hz;
        if (far < near - 1e-3) continue;
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const ex = Math.abs(m[0]) * hx + Math.abs(m[4]) * hy + Math.abs(m[8]) * hz;
        const ey = Math.abs(m[1]) * hx + Math.abs(m[5]) * hy + Math.abs(m[9]) * hz;
        // Two pixels cover the shader's maximum dilation and pixel snapping.
        // A small world-space margin covers float conversion and projection.
        const margin = 2 * far / focal + 1e-3 * (1 + far), radius = block.radius * Math.abs(scale) * (pose ? pose.scale : 1);
        if (Math.abs(cx) - ex > far * tanX + radius * slopeX + margin ||
            Math.abs(cy) - ey > far * tanY + radius * slopeY + margin) continue;
      }
      const n = out.length;
      if (n && out[n - 1] === block.start) out[n - 1] = block.end;
      else out.push(block.start, block.end);
    }
    return out;
  }

  K.splatVisibility = { prepare, ranges };
})(KIT);
