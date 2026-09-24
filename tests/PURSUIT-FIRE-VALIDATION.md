# Pursuit fire delay investigation

2026-09-23. Runtime candidates were withdrawn. game.js was not edited.

## Reproduction

faceTankToward allows a shot when tank.dir already matches the desired direction,
even with turnCooldown > 0. The cooldown prevents the next turn, not that shot.
AI aimedFireAction instead enters movingAimAction while cooldown remains, which
can return fire=false when movement is possible. This can defer shooting by the
remaining turn cooldown (up to approximately 0.3 seconds).

The behavior is reproduced in pursuit-fire.test.cjs. Its first case is an explicit
TODO, not a claimed passing fix. Other cases protect obstruction and crossing-target
handling and verify the game's real facing implementation.

## Rejected candidates

Using isolated muted actual game physics, seed 42:

| Stage 4 candidate | Result | Seconds | Deaths | Protected brick violations |
| --- | --- | --- | --- | --- |
| Before changes | win | 55.98 | 1 | 0 |
| General aligned early fire + timing correction | loss | 21.92 | 1 | 0 |
| General aligned early fire only | loss | 19.18 | 0 | 0 |
| Same-direction, confirmed direct shot only | win | 77.93 | 3 | 1 |
| Same-direction early fire preserving previous movement | win | 77.93 | 3 | 1 |

The narrow candidate improved stage 1 / 42 from 69.40 to 66.98 seconds, but loops
increased from 2 to 3; that does not offset the stage 4 safety regression.

Earlier shot timing changes the whole subsequent battle. The causal chain behind
the regression is not yet isolated. Do not promote this candidate based only on
unit tests. Next investigation should capture shot launches, friendly-fire gate
rejections, protected-brick damage, and task reassignment around the first divergent
shot. No generation was published and no automatic evolution job was started.
