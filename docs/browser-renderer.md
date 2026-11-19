# Browser renderer

The package's browser entry selects WebGL 2. Bundlers that honor the `browser`
field can use the package name. With native browser modules, import
`webgl.mjs` by URL and serve its relative `src/webgl/` modules. Both entry
points export `createRenderer` as a default and named import. Prepare the
authoring toolkit with [the browser bundle](../README.md#embedding-and-custom-scene-collections).
Node's `render()` and the `ink-studio` CLI provide CPU image export.

```js
import createRenderer from '@shapeshift-labs/ink-studio';

const renderer = createRenderer(canvas, { toolkit: { KIT, PixelLook } });
renderer.render(world, { width: 320, height: 200, time: 0 });
```

The factory needs a canvas or `OffscreenCanvas`, a toolkit that exports
`PixelLook`, and an available WebGL 2 context. Include `KIT` to use
per-pixel materials and blue-noise tone generation. The renderer manages
the canvas context and can rebuild GPU resources after context restoration.
Call `renderer.dispose()` when the canvas is removed.

## Frames

Pass the world returned by `builder.finish()`. The drawing buffer is the art
resolution. Choose `width` and `height` to resize it, then enlarge visually
with CSS such as `image-rendering: pixelated`. The host controls input and
calls `world.anim.update(dt, time)` before drawing. Supply `time` and optional
`bornAt` in seconds. A camera override can set `target`, `dist`, `yaw`,
`pitch`, `fov`, and `ortho`. Angles are in radians.

Pass `changedRows` as an array of changed 512-splat texture row indices.
Omit it to upload all packed splat data, or pass `[]` when the data is
unchanged. Initial uploads and changes in the world's buffer or count still
upload the complete data. Replace pixel-material and fine-tile buffers or
their material tables when editing them. An explicit `order` can provide
one `Int32Array` of back-to-front splat IDs for the frame.

The browser defaults reuse depth order when the caller marks the rows
unchanged and the view, depth-dependent time, and ordering inputs match.
Scenes with bone buffers sort again. The canvas also uses a smaller palette
resolve shader when per-pixel materials, ambient occlusion, glass beams,
tone mapping, and grading are inactive. Pass `reuseOrder: false` or
`specialize: false` to the factory to compare the corresponding full path.

| Frame control | Effect |
| --- | --- |
| `raw` | Show the directly blended RGB instead of the palette resolve. |
| `colored` | Use higher-resolution contours over native-size interiors. On by default for scenes without per-pixel materials. |
| `outline`, `dither`, `tone` | Control outline and palette treatment. Use `tone: false` to disable an authored tone. |
| `clean`, `lineClean`, `damp` | Control isolated-pixel cleanup, line cleanup, and per-pixel flicker damping. |
| `edges`, `lightShape` | Toggle surface edge sprites and per-pixel line shading. |
| `scale`, `stepAnimation` | Change the splat size or disable the shared per-pixel animation clock stepping. |
| `water: false` | Compare the scene with water optics disabled. |

Set `frame.target` to a same-context framebuffer descriptor with `framebuffer`,
`width`, and `height` to draw offscreen. Its dimensions supply the defaults for
the frame. The [screen transition compositor](transitions.md#render-ink-studio-worlds-directly-into-a-transition)
can create these targets and reuse their color textures on the GPU.

## Water optics

Attach a [water scene](procedural.md#water-bodies) as `world.water`.
The renderer traces water along each perspective or orthographic ray before
the background, and before each splat at its drawn depth. RGB extinction
depends on the distance traveled through water. Foreground splats and
translucent layers composite in the existing back-to-front draw order, so
water behind an object cannot tint the object's own color. A frame can
contain rays above, below, and crossing the waterline.

Water bodies have optional `optics` controls. `tint` and `surfaceColor`
take 0–1 RGB triples. `extinction` is a nonnegative RGB coefficient per
world unit. `surface`, `foam`, and `caustics` take strengths in [0, 1].
`refraction` takes a maximum displacement of 0–4 art pixels. Surface
highlights are stronger at grazing angles, foam favors shallows, and
stylized caustics fall off with depth. Screen-space refraction samples
pixels that also see the same interface through the splat layers. The art
palette still controls final quantization when `raw` is off.

Run the [Sunken gate example](../examples/water-bodies.html) from the repository
root with the commands below, then open the example through the local server.
The camera controls show the same shallow-water snapshot from above, at the
waterline, and underwater. The arrow keys swim against its sampled current.

```sh
node -e 'const fs = require("node:fs"); fs.mkdirSync("dist", { recursive: true }); fs.writeFileSync("dist/ink-studio.browser.js", require(".").bundle())'
python3 -m http.server 8080
```

## Feature coverage

| Feature | WebGL canvas renderer | Node and CLI renderer |
| --- | --- | --- |
| Packed splats, animation poses, palette and tone | Supported | Supported |
| Fine ink tiles, per-pixel patterns and edge sprites | Supported | Supported |
| Contours, cleanup, and camera-dependent glass beams | Supported | Supported |
| Selective ink, diagnostic buffers, stable art resolves, and frame-history effects | Host integration | Supported |
| View-dependent surface finishes, projected layers, reflection captures, and atmosphere volumes | Host integration | Supported |
| Water-column extinction, surface highlights, foam, caustics, and refraction | Supported | Water data and queries |
| Text rendering, PNG/APNG, scene reviews, and sprite atlases | Host integration | Supported |

Pixel output can differ across the CPU and GPU backends. Use the same
backend for both sides of a pixel-exact comparison.

## Integrate a custom draw pipeline

Hosts that manage their own framebuffers and effects can import
`createSplatPipeline`, `splatShaderSources`, and `pixelShaderSources` from the
same entry. Pass `{ ascii: KIT.ascii?.glsl }` to the pipeline if the host
implements the text passes. Shader sources are available to hosts that
compile and bind independent programs.

Call `pipeline.programFor({ lamps, fine, textZones })` and bind its returned
`p` before setting uniforms. Uniform locations are in `u`. The full shader
is selected when any feature is active or unspecified. The shader can omit
those paths when all three are explicitly false.

Upload order IDs with `setOrder(ids)` and call `draw()` after binding the
framebuffer, textures, and blend state. To use host-owned geometry, pass
`draw(count, vao)`. That VAO needs the two-component quad corners at
attribute 0 and the integer splat ID with instance divisor 1 at attribute 1.
Call `pipeline.dispose()` to release the pipeline's own resources.
