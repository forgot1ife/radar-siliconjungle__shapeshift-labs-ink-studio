# Shared simulation checkpoints

`run.checkpoint()` returns the run's immutable snapshot. Repeated reads
at the same revision reuse it. `run.fork()` and `run.reset()` reuse
unchanged state and world data while keeping independent command queues and
solver instances. A saved snapshot stays readable after a branch advances.
Plain shallow-water steps reuse the terrain array until it is edited.
Sediment and thermal transport can replace it.

[Simulation scrubbing and takes](simulation-scrubbing.md) uses these snapshots for backward and forward seeks and recording editable motion.

The default checkpoint and recording are still standalone version 1 JSON.
For experiments with several saved runs, use a shared block directory.

```sh
ink-studio sim run examples/world-checkpoint-branch.js --ticks 0 --checkpoint start.json --checkpoint-store ./blocks
printf '%s\n' '[{"tick":1,"action":"canal/gate","args":{"gate":"sluice","opening":1}}]' > open.json
ink-studio sim fork start.json --ticks 4 --checkpoint closed.json
ink-studio sim fork start.json --ticks 4 --actions open.json --checkpoint opened.json --record opened.run.json
ink-studio probe opened.json --field canal/depth --at 28.13,0,5
ink-studio sim replay opened.run.json --checkpoint portable.json --checkpoint-store off
```

A checkpoint reference records a root checksum and a path from the
reference file to its store. The same directory is reused for branch and
replay output. Use `--checkpoint-store DIR` to write to another directory or
`--checkpoint-store off` to export standalone JSON.
The CLI summary reports newly written and reused block counts and bytes.

Numeric arrays of at least 1,024 samples are saved in 1,024-value pages
using little-endian float64. Large keyed tables use stable buckets, with
authored key order stored separately. A row edit reuses the other
buckets. Recordings reuse the start and end checkpoint roots. SHA-256
identifies each block. Readers verify the checksum and
report missing blocks. Writers publish each complete block before its
reference. Keep the store with its references when moving an experiment.
The store is append-only.

Loading restores ordinary JavaScript arrays and records so existing
solvers, queries, replay, diff, and rendering can use the result. Large
fields are materialized when loaded. Identical fields and unchanged table
pages within a recording reuse immutable data.

## Node integration

```js
const studio = require('@shapeshift-labs/ink-studio');
const { KIT } = studio.load();
const store = studio.openCheckpointStore('./blocks');
const { reference } = store.save(run.checkpoint());
const snapshot = store.load(reference);
const branch = KIT.world.runtime.create(snapshot.world, { checkpoint: snapshot });
```

`save` also accepts a recording. `load` verifies the block representation.
The runtime validates the restored state against the world before advancing.

```sh
node scripts/benchmark-shared-checkpoints.js
```
