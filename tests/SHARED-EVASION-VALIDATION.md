# Shared projectile avoidance

2026-09-23. Runtime changes are limited to ai-core.js.

The existing game context already provides both players' positions, bullets,
and allyFireReports. Movement forecasts previously filtered out all friendly
shells, although stationary friendly-fire avoidance existed.

Movement forecasts now include enemy shells, live teammate shells, and the latest
ready-to-fire aim report for each other living shooter. Own shells, dead shells,
expired reports, reloads, mismatched headings, and old fire reports are excluded.
Real launched shells remain dangerous after their owner dies. Swept collision
prediction ranks all eligible shells by earliest collision and still respects
terrain and tank movement blockers. This reuses shared game data; it does not add
a network service, persistent telemetry, or predicted teammate movement.

Three new regression cases cover friendly crossing, announcement lifecycle, and
mixed enemy/friendly collision priority. Existing freeze priority and base-shield
tests are retained. TypeScript check passes.

Muted fixed-step real-physics comparisons with seed 42 remain identical to the
pre-change baseline:

| Stage | Result | Seconds | Deaths | Loops | Protected brick damage |
| --- | --- | --- | --- | --- | --- |
| 1 | win | 69.40 | 2 | 2 | 1 (existing) |
| 4 | win | 55.98 | 1 | 4 | 0 |

This verifies the targeted collision detection and limited non-regression, not
an overall win-rate/death-rate improvement. Browser hot-update adoption has not
been verified. No game.js changes or GitHub push were made in this iteration.
