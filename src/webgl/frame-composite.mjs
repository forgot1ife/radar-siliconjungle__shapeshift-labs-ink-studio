const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_layer;
uniform vec2 u_outputSize;
uniform bool u_topDown, u_linear, u_opaque;
uniform float u_opacity;
out vec4 color;

vec4 at(ivec2 pos, ivec2 size) {
  if (!u_topDown) pos.y = size.y - 1 - pos.y;
  return texelFetch(u_layer, pos, 0);
}

void main() {
  ivec2 size = textureSize(u_layer, 0);
  vec2 pixel = vec2(gl_FragCoord.x, u_outputSize.y - gl_FragCoord.y);
  vec2 uv = pixel * vec2(size) / u_outputSize;
  if (u_linear) {
    vec2 pos = clamp(uv - 0.5, vec2(0.0), vec2(size) - 1.0);
    ivec2 p = ivec2(pos), q = min(p + 1, size - 1);
    vec2 f = fract(pos);
    color = mix(mix(at(p, size), at(ivec2(q.x, p.y), size), f.x),
      mix(at(ivec2(p.x, q.y), size), at(q, size), f.x), f.y);
  } else color = at(min(ivec2(uv), size - 1), size);
  if (u_opaque) color.a = 1.0;
  color *= u_opacity;
}`;

export function createFrameComposite(gl, { program, resources, target, textureUnit, fullscreen }) {
  const shader = program(fragment);
  const base = target(), uploaded = resources.texture();
  let layerWidth = 0, layerHeight = 0;
  return function composite(world, frame, plan, layers, output, present) {
    const { w, h } = plan;
    base.resize(plan.world.w, plan.world.h);
    present(world, frame, plan.world.w, plan.world.h, base.framebuffer);
    if (!output) {
      if (gl.canvas.width !== w) gl.canvas.width = w;
      if (gl.canvas.height !== h) gl.canvas.height = h;
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    textureUnit(0, base.textures[0]);
    fullscreen(shader, output, w, h, { u_layer: 0, u_outputSize: [w, h], u_topDown: false,
      u_opaque: true, u_linear: plan.world.filter === 'linear', u_opacity: 1 });

    if (layers.length) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      for (const layer of layers) {
        textureUnit(0, uploaded);
        if (layerWidth !== layer.w || layerHeight !== layer.h) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, layer.w, layer.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, layer.data);
          layerWidth = layer.w;
          layerHeight = layer.h;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, layer.w, layer.h, gl.RGBA, gl.UNSIGNED_BYTE, layer.data);
        }
        gl.blendFuncSeparate(gl.ONE, layer.blend === 'add' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        fullscreen(shader, output, w, h, { u_topDown: true, u_opaque: false,
          u_linear: layer.filter === 'linear', u_opacity: layer.opacity });
      }
      gl.disable(gl.BLEND);
    }
  };
}
