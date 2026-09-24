# Offline candidate gate

Run `node tests/release-gate.cjs evidence.json` with an array of paired results.
Exit 0 means the numerical gate passed, not that a policy was published.
No browser, server, learning generation, or production policy is changed.

Required evidence: core/physics/map SHA-256 hashes, stage, seed, suite,
completed outcome, duration, deaths, loop/stall counts, and audited safety
violations. Unknown values and timeouts fail closed. Duplicate pairs and mixed
core/physics versions are rejected.

Minimum coverage is 10 pairs for each of 35 stages plus 30 holdout pairs across
at least three additional maps. No paired regression is allowed; at least seven
pairs must improve. These are conservative acceptance rules, not proof of
universal improvement or a calibrated statistical confidence interval.

The evaluator supplies fingerprints and safety counters through test-only source
observers. They count allied protected-brick destruction, allied base hits, and
actual teammate damage without changing collision results. Observer markers
must match exactly once; source drift aborts evaluation. These counters do not
prove absence of every possible safety defect.

The optional sixth CLI argument selects `mirror-upper`, `open-even`, or `open-odd`
holdout transformations. Spawn rows and the lower base area remain untouched.
Symmetric mirrors may produce an unchanged map; the gate rejects reuse of that
map hash as independent evidence. Runs never write training memory. Synthetic
unit tests validate gate behavior only, not gameplay improvement.

The integrated workflow is `tools/evolve.cjs`: it captures immutable production
parameter snapshots, makes bounded mutations, screens on three stages, then
validates on fresh seeds and three generated holdout layouts. Evaluation never
writes learning data. Publication rechecks exact policy, code, physics and
evaluator hashes and reruns this gate. A single atomic registry retains the
previous policy for rollback. Standalone hand-authored reports are not an
independent proof of gameplay improvement; the local artifact directory is
trusted and should not be edited during validation.

## Resumable batches

`node tests/batch-evaluate.cjs` runs a two-job, one-second smoke plan. Timeouts
are expected and must not qualify for release. Run it again to verify resume.
`node tests/batch-evaluate.cjs --full` selects 760 campaign/holdout jobs, each
bounded to 180 simulation seconds. Only two jobs run per invocation by default;
`AI_MAX_JOBS` controls this explicit budget. No scheduler or shadow tab is started.

Results are stored under ignored `test-results/smoke` or `test-results/campaign`.
Checkpoint identity includes source fingerprints and the full job plan. Code
changes require a new result directory rather than mixing old evidence. A
single-instance lock prevents concurrent writes. After an abnormal process
termination, inspect the PID in `running.lock` and confirm it is no longer running
before removing that lock. Checkpoints are committed only after completed jobs.

The legacy batch CLI defaults to neutral weights unless both policy file
environment variables are supplied. The integrated workflow always supplies
explicit baseline/candidate policy snapshots and evaluates the same AI code.
Normal gameplay does not perform random action exploration or automatic DSAC
tuning. A release is staged and becomes active at the next match boundary;
hot handoffs preserve the current match snapshot. Runtime self-base-hit and
friendly-death events trigger rollback after reporting. Sustained per-stage
win-rate regression triggers rollback only when 95% Wilson intervals separate
after at least 30 live games. Other runtime safety telemetry is not complete;
protected-brick damage is audited offline by the instrumented simulator.

`pnpm ai:evolve -- --jobs 20` runs at most twenty serial jobs and resumes on the
next invocation. Rejected candidates are automatically replaced with the next
bounded mutation within the remaining budget. `--smoke` never publishes.
`pnpm ai:release-status` reads the active generation; append `--rollback` for
manual rollback. No background daemon or recurring desktop task is installed.
