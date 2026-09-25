# Loop recovery and frozen prediction, 2026-09-24

## Retained fixes

- A completed recovery route releases its last movement direction instead of
  using the fallback direction to move beyond its endpoint.
- During active recovery, a verified close shot at a frozen enemy may finish
  aiming in place. This requires available reload and enough freeze time for
  turning, projectile travel and a margin. Ordinary evasion and freeze pickups
  retain their interrupt behavior.
- Predictive aiming includes only target movement after thaw. It handles both
  a target still frozen at impact and a target that thaws during projectile travel.

The new behavioral tests failed before their respective fixes. Final checks:
213 tests passed, zero failed, zero TODO; TypeScript and diff checks passed.
game.js was not changed. No GitHub push or training database writes were made.

## Paired physics evaluation

Baseline is the working AI immediately before this change, including prior local
changes, not Git HEAD. Both versions use current game.js, fixed 1/60-second steps,
the same seeds and fixed policy weights, muted, with a 100-second limit per case.

- Baseline SHA256: a9981667756bc08f6c6b02cf587d165b8c5e2b652b329a8b0dfdd7cd52e34aeb
- Final SHA256: 190ddf57dce6a11be01b0e45154a3c32640428e094fb977a194a29cfdc470199

| Stage / seed | Before | Final | Deaths before/final | Loop events before/final | Stalls before/final |
| --- | --- | --- | --- | --- | --- |
| 1 / 42 | win 89.12s | win 86.35s | 2 / 2 | 7 / 9 | 0 / 0 |
| 1 / 731 | win 47.18s | win 47.18s | 0 / 0 | 3 / 3 | 1 / 1 |
| 4 / 42 | win 50.42s | win 50.42s | 2 / 2 | 3 / 3 | 0 / 0 |
| 4 / 731 | loss 51.20s | loss 51.20s | 0 / 0 | 5 / 5 | 0 / 0 |
| 5 / 42 | loss 38.97s | win 58.08s | 1 / 3 | 4 / 5 | 0 / 0 |

The stage 5 comparison has unequal exposure because the baseline loses early.
Loop counts are recovery events, not a measurement of all time spent circling.
These results do not establish general loop elimination or a higher live win rate.

Both versions retain two protected-area brick violations on stage 1 / 42 and
one friendly hit on stage 4 / 42. Other listed cases have no safety violations.
The brick observer includes a broader lower-center area than the base guard.
Stage 4 / 731 remains an unresolved enemy-caused base loss.

## Withdrawn experiment

Expiring turn history on every decision regressed stage 1 / 731 from 47.18s,
zero deaths, three loop events to 62.92s, one death, six loop events and three
stalls. Isolating the changes traced this regression to history expiration.
That change and its synthetic test were removed. The final version preserves
the existing stalled-turn detection and reproduces the baseline result there.

HTTP localhost:8080 served the new AI source during verification. Browser
hot-upgrade adoption and a complete 35-stage campaign were not verified.

## Follow-up: defense progress audit

Baseline SHA256: `190ddf57dce6a11be01b0e45154a3c32640428e094fb977a194a29cfdc470199`.
Retained candidate SHA256: `626044682e69c6ae4f03a05f0c9ce46fa46fbf3e902f7d84760dc237a4740ca5`.

The retained change measures the physical distance to a route endpoint even
after entering its grid cell. A new regression test verifies that entering the
cell is not mistaken for completing alignment. All 214 tests and type checking
pass. No game.js changes were made.

Paired 100-second evaluations with game.js physics, seeds 42 and 731, stages
1, 4 and 5 reproduce baseline outcome, completion time, deaths, loops, stalls
and safety counts. Stage 1 wins in 86.35/47.18 seconds; stage 4 wins in 50.42
and loses in 51.20; stage 5 wins in 58.08/68.08. This is non-regression evidence,
not evidence of a better campaign win rate or resolution of the remaining loss.

Two broader watchdog changes were rejected:
- Removing displacement progress credit regressed both stage 5 seeds from wins
  to losses (44.43 and 33.48 seconds).
- Crediting only newly extended displacement preserved stage 5 wins but
  regressed stage 1 seed 42 from a win to a loss at 67.18 seconds.

Both experiments were withdrawn, including their synthetic test. The remaining
defense scheduling, evasive deaths, and orbit recovery need a validated fix;
they must not be marked resolved on the strength of fewer loop events.

## Locked pursuit route refresh

The loop escape route now refreshes when its committed enemy or assigned
intercept endpoint moves at least two cells from the planned position. One-cell
movement keeps the current firing route stable. If replanning reaches an
already occupied firing cell, the controller keeps aiming or reloading rather
than moving along a stale fallback leg. Freeze pickup and emergency evasion
priority were unchanged. `game.js` was not edited.

Paired game-physics checks against the previous AI snapshot (seeds 42 and 731,
100 seconds maximum per match):

| Stage | Baseline | Candidate | Safety change |
| --- | --- | --- | --- |
| 1 / 42 | win 86.35s, 2 deaths, 9 loops | win 78.68s, 2 deaths, 8 loops | protected-area brick events 2 to 1 |
| 1 / 731 | win 47.18s, 0 deaths | win 47.18s, 0 deaths | none |
| 4 / 42 | win 50.42s, 2 deaths | same | none |
| 4 / 731 | loss 51.20s | same | none |
| 5 / 42 | win 58.08s, 3 deaths | same | none |
| 5 / 731 | win 68.08s, 2 deaths, 6 loops | win 71.23s, 2 deaths, 7 loops | none |

Generated map 141 / seed 42 loses at 9.78s under both versions. The mirror-upper
map / seed 731 is unchanged. These checks verify the route-refresh behavior
and bounded sample outcomes; they do not prove that all defensive retreats or
looping have been eliminated. More aggressive rear-position and turn-hold
experiments were withdrawn after they introduced campaign losses or extra
deaths in these same-seed comparisons.
