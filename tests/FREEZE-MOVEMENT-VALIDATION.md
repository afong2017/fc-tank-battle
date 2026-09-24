# Frozen contact approach movement

2026-09-24. Runtime change limited to ai-core.js; game.js unchanged.

Frozen close-combat alignment previously always emitted core-freeze-contact-align.
The generic alignment cap reduced every such move to 35% speed and held movement
during turn cooldown, even when the selected direction was already correct and
the lateral approach still exceeded a tile.

The final change distinguishes travel from final alignment: when already facing
the approach direction and more than one tile remains, use ordinary approach
movement. Keep the old conservative alignment within the final tile or when still
turning. No change to speed caps, collision, firing safety, freeze pickup priority,
or path-corner alignment. Holding an already valid firing position is still allowed.

An initial broader six-pixel threshold was rejected: stage 4 / seed 42 took
64.40 seconds and recorded one protected-brick violation; stage 1 had more loops.

Final muted real-physics evaluation, fixed 1/60 step, seed 42:

| Stage | Before | Final | Deaths before/final | Loops before/final | Safety violations before/final |
| --- | --- | --- | --- | --- | --- |
| 1 | win 69.40s | win 69.40s | 2 / 2 | 2 / 2 | 1 / 1 |
| 4 | win 55.98s | win 50.47s | 1 / 1 | 4 / 2 | 0 / 0 |

Unit tests cover all four approach directions and retained final/corner alignment.
Full suite: 183 pass, 1 previously known pursuit-fire TODO; typecheck passes.
Limited scenarios do not establish universal improvement or eliminate every freeze
stall. Browser hot-update adoption was not verified; no GitHub push or automatic
policy promotion was performed.
