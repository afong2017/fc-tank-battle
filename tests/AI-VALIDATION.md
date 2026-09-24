# AI planning and feedback validation

## Implemented integration

- Existing threat profiling includes reachable firing routes, movement, turning,
  reload, armor hit count and projectile travel time.
- Joint coverage enumerates distinct ally assignments for critical threats. It
  overrides greedy coverage only when fewer deadlines are missed and the first
  threat's response is not delayed by more than 0.35 seconds.
- Existing path execution preserves steel avoidance, protected base bricks,
  immediate nearby freeze collection, projectile defense and target commitments.
- Shot feedback now observes actual owner-matched projectiles. A fire command
  alone never creates a missed-shot penalty. Clearing and counterfire are excluded.
- Feedback distinguishes target damage, movement and stationary misses. Damage
  does not attribute a kill to the shooter. Two stationary misses from the same
  cell within 2.5 seconds trigger a bounded reposition attempt, subject to live
  movement and projectile safety checks. Damage or movement clears that recovery.
- Feedback records use `ai_shot_feedback` with explicit outcome reasons through
  the existing experience pipeline. No new database is required.

## Reproduce isolated comparisons

```powershell
node tests/evaluate-ai.cjs 120 42,731
node tests/evaluate-ai.cjs 120 42 baseline 4
node tests/evaluate-ai.cjs 120 42 candidate 4
```

Arguments: simulated seconds (maximum 180), comma-separated seeds, optional
`baseline`/`candidate` filter, starting stage (1-35). Baseline is `HEAD:ai-core.js`;
candidate is the working file. Both use the same current `game.js` physics.
The baseline for the results below was commit `ed9d650`.

The VM runs fixed 1/60-second steps, infinite lives, no rendering, no sound, no
network, no training writes and no auto restart. Search uses the deterministic
node bound instead of wall-clock timing. This is a bounded physics/AI comparison,
not a browser FPS test or a substitute for live play. Production learned weights
are not imported; both versions use equal fixed weights. Identical seeds do not
guarantee identical later random events once decisions diverge.

## Observed results

All three pairs finished with a stage win within 120 simulated seconds.

| Stage / seed | Baseline seconds | Candidate seconds | Deaths old/new | Loops old/new | Defense stalls old/new |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 / 42 | 71.27 | 91.05 | 2 / 2 | 4 / 5 | 1 / 3 |
| 1 / 731 | 82.27 | 71.20 | 2 / 2 | 9 / 4 | 6 / 3 |
| 4 / 42 | 67.33 | 54.08 | 5 / 0 | 5 / 1 | 4 / 2 |

The first pair regressed in completion time and stalls. The other two improved.
This small sample does not establish a higher overall win rate. Full 35-stage
campaigns, finite-life settings and browser wall-clock-budget validation remain
unverified. Do not claim guaranteed completion or unconditional improvement.

`pnpm test` passes 130 tests, including 200 seeded assignment matrices, projectile
observation, no-fire commands, target movement, teammate bullets and stage reset.
`pnpm typecheck` also passes.

## Loop stability follow-up

Baseline was a temporary read-only snapshot of the working AI immediately before
this follow-up (not Git HEAD). `AI_BASELINE_FILE` can select that comparison input.
Stage 5, seed 42, 120-second limit:

- Baseline: win at 71.10 seconds, 4 deaths, 11 loop-recovery events.
- Broad loop exemption: lost at 34.40 seconds. This candidate was withdrawn.
- Narrow exemption: win at 71.10 seconds, 4 deaths, 11 loop-recovery events.

The retained condition exempts alternating/closed turn sequences only when actual
displacement exceeds 1.5 tiles AND distance progress is at least one tile. It does
not exempt circles merely because the target moved closer. Target-reset changes
from the failed candidate were also withdrawn. New tests exercise progressing
detours and true returning loops. All 135 tests and type checking pass.

This follow-up prevents demonstrated false-positive loop detection in unit
scenarios but does not establish improved campaign performance. The retained
candidate reproduced the baseline outcome in this single physics comparison.
