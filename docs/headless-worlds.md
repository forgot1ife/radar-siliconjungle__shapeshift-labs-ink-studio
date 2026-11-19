# Headless worlds

Ink Studio can advance a declarative world, apply timed actions, inspect the
result, and replay or compare runs. A scene uses the same query descriptors
from JavaScript and the CLI. Each query reads one published revision.

## Run and compare a watershed

Save the starting checkpoint after the reservoir has settled.

```sh
ink-studio sim run examples/world-watershed.json --ticks 30 --checkpoint filled.json
```

Save an action list as `spillway.json`.

```json
[
  {
    "tick": 31,
    "action": "river/bed",
    "args": {
      "bounds": {"min": [-1.55, -0.75], "max": [-0.55, 0.75]},
      "height": -0.25
    }
  }
]
```

Run both branches to the same tick. The baseline remains dry at the bridge.
The edited bed releases the reservoir and the downstream probe reports flow.

```sh
ink-studio sim fork filled.json --ticks 120 --record hold.run.json
ink-studio sim fork filled.json --ticks 120 --actions spillway.json --record lower.run.json
ink-studio probe lower.run.json --field river/water --entity footbridge --json
ink-studio sim diff hold.run.json lower.run.json --field river/depth --entity footbridge
ink-studio sim replay lower.run.json
ink-studio sim render lower.run.json --out lowered.png
```

`sim resume` and `sim fork` both start a new process from a checkpoint. Keep
their output paths distinct to retain both branches. A run file contains its
starting checkpoint, added commands, and ending checkpoint. Replay verifies the
result against the recorded ending state. Sign differences between positive
and negative zero follow JSON numeric equality. `sim reset` on a recording
returns to its starting checkpoint. `--ticks` selects an absolute tick,
`--steps` advances relative to the current tick, and `--t` converts seconds
to a tick using the scene timestep. Use one of these per invocation.

`sim sweep <world> <cases.json>` runs an array of cases. Each entry accepts
`id`, `seed`, `edits`, `ticks`, `actions`, `probes`, and `assert`.
For sweeps from a checkpoint, use actions to vary the branches. A probe entry
contains `field`, optional `at`, and optional `args`.

`--assert checks.json` accepts an array of field checks with `field`, optional
`at`, optional `args`, optional expected `status` (default `ok`), and a
`when` condition. Use `tick` to check one earlier frame or `byTick` to allow
the condition to become true by a deadline. The default checks the final frame.
`--profile` reports per-system calls, total milliseconds and peak tick time.
A check may use `{"profile":"river","metric":"calls","max":90}`. Failed
assertions return exit code 2.

## Query a revision

```sh
ink-studio inspect lower.run.json
ink-studio inspect lower.run.json --near 2,0,0 --radius 2
ink-studio probe lower.run.json --field world/position --entity footbridge --socket north
ink-studio trace lower.run.json river/flow --at 1,0,0 --args '{"steps":30}'
ink-studio probe lower.run.json --field world/history --args '{"where":{"path":["kind"],"value":"bed-edit"}}'
```

Fields and traces are named `system/name`. Use the short name when only one
system exports it. A probe reports `ok`, `dry`, `outside`, `missing`, or
`unavailable` as appropriate. Runtime scene files, checkpoints and run files use
the same field registry. The existing diorama loader also adapts published water
volumes, material sandboxes and exposed traversal graphs for inspection. A scene
can supply its own query adapter using `world.query(world, time)`.

Use `field <file> <name> --spec samples.json` with one of these sample specs.

```json
{"grid":{"min":[-5,0,-1],"max":[5,0,1],"counts":[21,1,5]}}
```

```json
{"line":{"from":[-5,0,0],"to":[5,0,0],"count":41}}
```

```json
{"ticks":[10,20,30],"at":{"entity":"footbridge"}}
```

An explicit `points` array is also supported. A time series may carry a
`spatial` sample spec to export each frame on the same grid. Grid rows are
X-fastest. The field descriptor supplies units. Conditions accept `path` as a
path array or JSON pointer, `op` as one of `eq`, `ne`, `exists`, `lt`,
`lte`, `gt`, `gte`, or `in`, and `value` where needed. Combine conditions
with `all`, `any`, or `not`.

## Author a world

A manifest has `format: "ink-studio/world"`, `version: 1`, a stable `id`,
`seed`, `dt`, and tables of `entities` and `systems`. A system record
declares a `kind` and a `config`. Optional sections include `connections`,
`prefabs`, `assetPacks`, `commands`, `history`, `metadata` and
`scenario`. See [the watershed](../examples/world-watershed.json) and
[the quarry crossing](../examples/world-crossing.json) for working manifests.

`scene apply <world> <edits>` applies an ordered array of `set`, `remove`,
`merge` and `test` operations atomically. Paths accept arrays or JSON
pointers. Existing branches are shared until changed. `--dry-run` reports
changed paths. `--out` writes the validated result. The same operations accept retained authoring documents and JSON dioramas. `validate` also checks a
world directly, or accepts `--world manifest.json --kind edits|actions` to
check a separate file against a world.

Entity positions are relative to their parent or host socket when attached.
Use `scene stamp <world> <prefab> --as id` to instantiate a reusable assembly.
The optional JSON `--args` accepts `position`, `params`, and local edit
`overrides`. In prefab declarations, `{"$param":"name"}` reads a parameter,
`{"$local":"id"}` refers to an internal object or system, and
`{"$port":"system/output"}` refers to a local port. Stamp rewrites internal
connections and exposes public ports as `assembly/port`. Prefabs can require
asset-pack IDs or exact revisions. `scene remix` modifies a definition and
`scene capture` saves a placed, edited assembly under a new prefab ID.

`world/input` drives an unconnected typed input, `world/patch` edits live
entity and metadata records, and `world/event` emits a named event. Each
scheduled command has a positive integer `tick`, an `action`, and an
optional `args` object. Commands scheduled for one tick run in order. All
stepping systems read a common snapshot after that tick's commands. A
combinational control block can pass its result in the same tick. Stateful
outputs feed the next tick. Set a connection's `delay` to queue its signal
for a fixed number of ticks. The validator rejects instantaneous cycles.

A scenario accepts an initial patch in `start`, `commands`, an `allow` list
for external actions, an `until` tick, and ordered `rules` of kinds
`score`, `metric`, `win` and `fail`. A rule can probe a field and apply a
condition to its value. Run with `--scenario` to stop at an outcome. The quarry
example awards points when the sheep crosses an opening and ends when it
reaches the feeder.

## Built-in systems

| Kind | State, queries and actions |
| --- | --- |
| `fields` | Named scalar fields with units, rectangular regions and a `set` action. |
| `control` | Typed arithmetic, thresholds, selection, binary logic, pulses, latches, timers and hysteresis. |
| `water` | Bounded XZ shallow water with live bed edits, fractional face openings, conservative pump transfer, sensors and probes for the bed, depth, current and volume. An `obstacle` field may supply signed solid clearance. |
| `mechanics` | Oriented box bodies and shared clearance or support queries, fixed and powered mounts, transmission ratios and stall reports, physical separation, configurable fracture, wheel traction, buoyancy and thrust. |
| `navigation` | Bounded walking, swimming or flying route traces. Ground search can take depth, clearance and wear into account. Hosts can also expose the volumetric traversal graph. |
| `habitat` | Authored species rules evaluate world fields and nearby or reachable resources. Probes return a score, suitability and the reasons behind the decision. |
| `agents` | Ground, swim and flight movement with replanning, scene-aware destinations and optional limb contacts. Agents publish their real movement contacts for other systems. |
| `wear` | Optional wear from contact-producing systems or submitted contact batches. Track local accumulation and recovery, and use `enabled` to control updates. Trace a durable route and promote it with `scene promote <run> <trace> --as id`, supplying its endpoints through `--at` and JSON `--args`. |

The mechanics model uses bounded box colliders and approximate contact,
traction and buoyancy. Water handles one surface column per XZ cell. Keep a
simulation's resolution and bounds appropriate to these models. Use the same
query names to provide richer implementations for individual scenes.

`history.where` defines which events are meaningful to the world.
`history.limit` bounds retention, and the readout reports how many events
rolled off. `scene history <world> <rules.json>` adds seeded backstory.
A rule supplies `id`, a negative starting tick in `start`, optional
`count`, `interval` and `chance`, an `event`, and optional `edits`.
String values can reference `{id}`, `{index}` and `{tick}`. A
`{"$choose":[...]}` value selects from authored alternatives by seed.
The earlier events and their world edits survive in the derived manifest.

## Extend the runtime in JavaScript

```js
const { KIT: { world: W } } = require('@shapeshift-labs/ink-studio').load();

W.runtime.register('counter', ({ rate = 1 }) => ({
  initial: () => ({ count: 0 }),
  step: (state, tick) => ({ count: state.count + rate * tick.dt }),
  fields: {
    count: { type: 'number', read: ({ state }) => W.query.ok(state.count) }
  }
}));

const run = W.runtime.create({ systems: { meter: { kind: 'counter' } } });
run.advance(60);
console.log(run.query().probe('meter/count').value);
```

A system factory compiles its definition once per runtime instance.
`initial`, `step`, and `actions` return finite JSON state. Keep persistent
state in those values so fork and replay can recreate it. Optional hooks
include `checkAction(type,args)`, `validateState(state)`, `pose(state,id)`,
`fields`, `traces`, typed `inputs` and `outputs`, and
`output(state,context)`. A tick context exposes the world, peer state, shared
queries, input values, `emit(kind, detail)`, and a seeded `random(key)`.
Load custom factories through the CLI's existing `ink-studio.config.js`
`load` hook when reading their checkpoints in a separate process.

Rill's revision and spatial lookup contracts inspired the query snapshots and
stable selectors. Frontier's path edits and Ink's state/action/query separation
inform the authoring and simulation interfaces. The implementation uses Ink
Studio's own data and solver primitives with the JavaScript standard library.
