# Headless scene editor

Open a JSON diorama with `studio.createSceneEditor(source, options)` in Node or `KIT.authoring.sceneEditor.create(source, options)` in the bundled toolkit. The source can be a parsed object, a JSON string, or a baked diorama with its source attached. Pass `env` with the same assets as `KIT.diorama.build` when the scene uses meshes. Set `historyLimit` to bound the number of undo steps.

`snapshot()` returns the current immutable diorama. `serialize(space)` produces the same JSON that `ink-studio validate` and `ink-studio render` accept. Keep relative asset files in the same location relative to the saved scene. `build()` bakes the current state for preview or picking.

## Scene tree and selection

- `tree()` returns the scene hierarchy with blend groups, rig parts, solids, and nested operands. Solids assigned to a rig part appear under that part, with any blend group still recorded on the solid.
- `node(key)` looks up a tree entry. Solid entries include their authored properties. Named solids keep stable keys and unnamed solids use their source paths. An unnamed solid receives a temporary render tag for picking.
- `pick(ray, options)` resolves a world-space ray to a visible editable solid and returns its tree key and contributing hit. A miss returns `null`. A compound shape picks as a whole, and its operands can be selected through the tree. Pass a posed world from `build()` as `options.world` when picking an animated preview.
- `select(keys, { mode })` selects solids by tree key. `selectRay(ray, { mode, ...options })` selects the picked solid. Modes are `replace`, `add`, `toggle`, and `remove`. Read the current keys with `selection()`.

## Transforms and materials

`setTransform(patch, keys)`, `setMaterial(material, keys)`, and `setRole(name, ramp)` edit the source diorama. Omit `keys` to edit the current selection. `setMaterial` accepts a role name or the diorama's full material object. `materials()` returns the effective palette and its role ramps, and `setRole` updates a ramp wherever it is referenced.

| Transform field | Meaning |
| --- | --- |
| `translation` | XYZ displacement in scene units. |
| `rotation` | Yaw, tilt, and roll in radians, in the same convention as a diorama solid's `turn` field. |
| `scale` | Positive uniform scale from 0.02 to 20. |
| `pivot` | XYZ center of rotation and scaling. Defaults to the solid's authored `at` or the origin. |

Transform edits replace individual fields in the solid's `transform`. The transform is applied after its authored geometry and `turn`. A nested operand is transformed before its enclosing operation. A rigged solid's transform edits its rest geometry. Rig joint positions remain controlled by the scene's part definitions.

## Non-destructive shape editing

`updateShape(patch, keys)` edits the geometry fields of a solid or an operand in the tree. This includes primitive dimensions and the parameters and operands of existing boolean and procedural shapes.

A solid can store an ordered `modifiers` array in the diorama. Each entry has a unique `id` within that solid, a `kind`, and an optional `enabled` flag. A bake applies enabled entries from first to last, then applies the solid's `transform`. The source shape and all entries stay available for the next edit.

| Modifier | Fields |
| --- | --- |
| `join` | `how` selects an existing boolean or blend operation. Supply an operand as `shape`. Optional `size` and `steps` control transitions. |
| `mask` | `mode` is `keep` for the overlap or `cut` to remove it. Supply the mask volume as `shape`. The edited solid supplies the surface material. |
| `fold` | Use one of `polar`, `mirror`, or `repeat`. Set `centre` and `axis` for polar repetition, `centre` for mirroring, or `count` for grid repetition. |
| `warp` | Use `twist`, `bend`, or a two-value `taper`. Optional `centre` sets the pivot and `wide` bounds the twist's distance correction. |
| `shell` | `t` sets the shell's thickness. |
| `swell` | `by` grows or shrinks the solid by a signed distance. |
| `rough` | `by` sets the height variation and `scale` sets the noise frequency. |
| `bubbles` | `cell` sets the spacing and `h` sets the height of the raised pattern. |

Use `setModifiers(list, keys)` to add, remove, or reorder entries. Use `updateModifier(id, patch, keys)` to edit an entry or bypass it with `enabled: false`. Optional parameter fields can be cleared with `null` in a patch. Mask and join operands appear in the tree even while bypassed. An unnamed operand's tree key follows the modifier ID when the stack is reordered. These edits share the same transactions and undo history as transforms and materials.

Pass the result of `build()` to `createSceneEditor` to reopen its source at the time of the bake. Retain `serialize()` output for durable storage alongside any exported splat or image data. Opening a scene with mesh operands uses the same asset lookup as opening its source JSON. Active modifiers on a separate analytic shape send its edited surface through the general mesh export path.

## History

Standalone edits commit immediately. Use `begin(label)` to group repeated transform or material edits into one gesture. `preview()` validates the draft, `commit()` records it as one undo step, and `cancel()` restores the prior scene. If preview or commit fails validation, the transaction rolls back.

Use `undo()`, `redo()`, `history()`, and `revision()` to track saved edits. `onChange(listener)` reports committed edits and history changes with the current snapshot. Selection belongs to the editing session.
