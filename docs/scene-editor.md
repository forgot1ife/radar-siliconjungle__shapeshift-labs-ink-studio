# Headless scene editor

Open a JSON diorama with `studio.createSceneEditor(source, options)` in Node or `KIT.authoring.sceneEditor.create(source, options)` in the bundled toolkit. The source can be a parsed object or a JSON string. Pass `env` with the same assets as `KIT.diorama.build` when the scene uses meshes. Set `historyLimit` to bound the number of undo steps.

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

## History

Standalone edits commit immediately. Use `begin(label)` to group repeated transform or material edits into one gesture. `preview()` validates the draft, `commit()` records it as one undo step, and `cancel()` restores the prior scene. If preview or commit fails validation, the transaction rolls back.

Use `undo()`, `redo()`, `history()`, and `revision()` to track saved edits. `onChange(listener)` reports committed edits and history changes with the current snapshot. Selection belongs to the editing session.
