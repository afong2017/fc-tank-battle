# Defense assignment validation, 2026-09-24

Status: rejected; production AI behavior restored to the pre-experiment snapshot.
No game.js changes. No GitHub push. No browser hot-load verification.

## Evidence

The latest 20 completed NORMAL matches inspected contained 14 wins and 6 losses,
across builds 20260924003741, 20260924003641, 20260924002546 and 20260923224606.
This is a mixed-build diagnostic sample, not a controlled release comparison.
The six base-destruction records identified basic tanks as the shooters.
Several timelines show one ally returning late while the other pursues a remote
target. Assignment, route execution and local action arbitration all require
investigation; the timelines alone do not isolate a single cause.

## Reproduced conflict

The joint coverage solver can select two on-time responses, but its caller
rejects them if the primary response is over 0.35 seconds slower than greedy.
Example response ETA matrix: [[1, 2], [2, 8]], deadlines [3, 3].
The solver assigns owners [1, 0]; the live gate rejects that solution.
The regression reproduces the caller gate, in addition to existing solver tests.

Relaxing the gate to accept an on-time primary response passed unit tests but
regressed real-physics performance. Reserving an additional 0.6 seconds reduced
one regression but still regressed stage 1. Both candidates were withdrawn.

## Paired muted physics results

120-second simulation limit, fixed seeds, same game physics and current policy.
Baseline core SHA256: 36f826582bc125737a66a0a9854360dc2e45b35602b40310c6056c12c9c26305.

| Case | Baseline | Relaxed deadline gate | Gate plus 0.6s reserve |
| --- | --- | --- | --- |
| Stage 4, seed 42 | win 50.47s, 1 death, 2 loops | win 63.57s, 2 deaths, 4 loops | same as baseline |
| Stage 1, seed 42 | win 69.40s, 2 deaths, 2 loops | not run | win 73.18s, 3 deaths, 4 loops |
| Stage 4, seed 731 | loss 31.53s, 2 deaths, 2 kills | not run | same as baseline |

Stage 1 retained one pre-existing protected-brick safety violation in both runs.
Stage 4 runs had no ally-caused safety violations; the seed 731 base loss was
enemy-caused. These finite scenarios cannot establish universal reliability.

## Remaining work

Do not deploy this gate relaxation alone. Capture assignment owner changes,
predicted lethal-hit deadlines and actual progress together in the failure
replays. Check whether route/turn/shot execution realizes the estimated ETA and
whether downstream overrides invalidate the planned coverage. Keep the gate
regression as an explicit TODO until a replacement also passes physics checks.
