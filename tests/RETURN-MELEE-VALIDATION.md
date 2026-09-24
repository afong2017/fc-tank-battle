# Return and melee action arbitration

Validated on 2026-09-23. Only ai-core.js runtime logic changed in this iteration;
game.js and its physics were not edited.

## Reproduced defects

- Active loop recovery overwrote valid moving-fire commands with fire=false.
- Hard-obstacle recovery changed dir but retained the previous moveDir.
- Emergency heading commitment conflicted with an explicit fresh moveDir.

The three targeted tests fail against the pre-change source. The corrected
implementation passes these and a negative test for reload, turning, and distant
aiming. Immediate recovery interruption requires a close target, an already
oriented barrel, completed reload/turn, and a confirmed current-position shot.

## Verification

- Full suite: 168 passed. TypeScript check and git diff --check passed.
- Isolated real game physics, fixed 1/60 step, muted, no gameplay database writes.
- Baseline is the working AI immediately before this iteration, not git HEAD.

| Stage / seed | Before and final result | Time | Deaths | Loops | Stalls |
| --- | --- | --- | --- | --- | --- |
| 1 / 42 | win | 69.40 | 2 | 2 | 0 |
| 4 / 42 | win | 55.98 | 1 | 4 | 0 |
| 4 / 731 | loss | 31.53 | 2 | 0 | 0 |

The initial broad fire-interruption patch regressed stage 4 / 42 to 63.80 seconds,
2 deaths and 1 stall. That broad behavior was removed before final verification.

These paired games show no outcome regression, not a measured win-rate increase.
Stage 1 / 42 still records one protected-brick violation in BOTH versions.
Stage 4 / 731 still loses; loop events remain in other cases. No policy generation
was published, no continuous evolution runner started, and no claim of complete
defense or loop elimination is supported by this sample. Browser hot-load adoption
was not verified. The evaluator uses deterministic node limits rather than browser
wall-clock search deadlines.
