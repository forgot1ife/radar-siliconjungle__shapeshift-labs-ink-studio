# Prefab upgrades

Place compatible prefab revisions in the world catalog under distinct IDs.
The placed assembly retains its ID and moves to the selected revision.
Other instances can keep using their existing definitions.

```sh
ink-studio sim run examples/world-prefab-upgrade.js --ticks 4 --checkpoint before.json
ink-studio scene upgrade before.json lock --to sluice.v2 \
  --migration examples/world-prefab-upgrade.migration.json --dry-run
ink-studio scene upgrade before.json lock --to sluice.v2 \
  --migration examples/world-prefab-upgrade.migration.json --out upgraded.json
ink-studio sim resume upgraded.json --ticks 9
```

`scene upgrade` accepts a world, checkpoint, or recording. A recording
supplies its ending checkpoint. A checkpoint upgrade produces a new
checkpoint at the original tick. That checkpoint can be the origin of a
new recording. The dry run reports parameter and override changes,
attachments, typed links, command rewrites, saved state decisions, and
repair requirements. An unresolved issue blocks the upgrade with exit
code 2. Successful output uses the ordinary world or checkpoint format.

## Map the revision

The optional `from` and `to` records check the prefab IDs and revision
numbers. The target revision must advance. Older stamps use the original
definition to recover effective local edits. Supply `fromDefinition` if
the original is unavailable in the catalog.

| Mapping | Keys and values |
| --- | --- |
| `entities`, `systems` | Local part or system IDs. |
| `sockets` | Local `part/socket` pairs. Use `@root/socket` for an assembly socket. |
| `ports`, `pins` | Public aliases, or local `system/pin` pairs for direct links and saved signals. |
| `params` | Instance parameter names. |
| `overridePaths` | Local structured edit paths such as `/entities/panel/paint`. A mapping also applies to descendant paths. |
| `fields`, `accounts`, `actions` | Local `system/name` pairs for qualified references, transfers, and commands. |
| `actionEdits` | Structured edits to arguments of a named old local action. |
| `chunks` | New local system ID to existing chunk ID. A null value leaves the system global. |

Keep the same names for compatible members. Map changed names explicitly.
Use null to retire a mapping or discard an override intentionally.
An in-use attachment or port needs a valid replacement. Added solvers
inherit the old chunk when the instance had a single owner.

New stamps record their parameter and override choices, including
explicit values that matched an old default. The upgrade compares the
original definition with the current instance so later local edits can
carry over. Older stamps can recover effective edits and baked parameter
values using the original definition and explicit path mappings.
Use `repairs` for ordinary world edits needed elsewhere in the draft.
Scoped connections are checked against the target port types and the
validated result is saved as one transaction.

## Saved state

`state` is keyed by old local solver ID. Compatible state carries over.
Use `mode: "preserve"` with `paths` to move existing record values or
with `edits` for structured changes. Use `mode: "reset"` to initialize a
retained solver or `mode: "discard"` to retire its saved state. Changed
solver kinds require an explicit policy. The target simulation validates
the final state and pending commands.

Compatible buffered signals and local clocks carry over. Changed
routes can initialize a new buffer and appear in the report. Historical
events and causal nodes retain their original IDs.

In JavaScript, use `KIT.world.upgradePrefab(world, instance, target,
{ migration, checkpoint })`. The function returns a report and makes
the validated output available when the report is successful.
