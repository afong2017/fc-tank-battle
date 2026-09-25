# AI V3: rules, tactics, and release gate

Status: experimental. CORE remains the default. The start menu and `start-v3.cmd` can launch the independent V3 controller for manual testing; this does not promote V3 over CORE.

V3 stores training time, game count, and the latest 512 stage results separately in browser localStorage. It does not write CORE experience. With HOT UP enabled, V3 controller changes can be loaded during a match without resetting game state; main-game updates still wait for a safe boundary. Switch versions on the title screen before starting a game.

## Game model verified from `game.js`

- The map is 26 by 24 cells, 32 pixels per cell. Player tanks move at up to 105 pixels/s; basic, fast, and armor enemies at 72, 105, and 58 pixels/s. A 90-degree turn takes 0.3 s. Player shots travel at 310 pixels/s, enemy shots at 230 pixels/s.
- `S` steel blocks movement and shots. `W` water blocks tanks but shots pass through. `B` brick blocks both until shot away. `F` forest is traversable but hides enemies from allied targeting. `E` is the base. Shooting the base must never be permitted.
- Enemies spawn at random top-row positions, up to four simultaneously at base difficulty. They generally advance downward, make occasional lateral moves, and aim at the base when near it. Armor starts at two HP and gains HP with optional difficulty scaling.
- Freeze pickups last seven seconds; collecting one sets enemy freeze to five seconds. Enemy movement and firing stop while frozen. An in-range pickup remains the top AI priority.
- Historical normal-mode losses in `ai-memory.db` are most numerous on stages 1, 2, 5, and 3. Stage 12 has a high failure ratio among its fewer attempts. These five stages are the first release gate, not the complete 35-stage validation.

## What the first isolated V3 trial found

- Treating water as a projectile blocker was wrong and has been corrected.
- The first controller chased a moving tank's current center instead of a reliable intercept/shot lane. Both allies could pursue one upper enemy while a new enemy entered an undefended side.
- A planned firing cell could already be occupied by the AI while the actual `game.js` shot check rejected the shot. That caused `replan`/idle rather than relocation.
- Ad hoc target-score adjustments and a speculative interception point did not beat the existing controller. A 45-second fixed-seed trial on stages 1, 2, 3, 5, and 12 rejected V3. The last run on stages 1 and 2 still showed fewer kills, deaths, and a stage-2 base loss. Do not ship based on unit tests alone.

## Joint assignment and close-combat gate

- The independent V3 prototype now has a shared two-ally assignment and an immediate point-blank shot check. A case where one ally idled while enemies were visible was fixed in its unit test, but the 45-second campaign comparison still rejected independent V3: stage 5 lost the base after about 21 seconds, and stage 1 had only 9 kills versus 16 for CORE.
- A stronger base-threat penalty made results worse, including a friendly-fire safety event. It was removed. A broad close-shot override over the mature controller improved stages 2 and 3 but regressed stages 1, 5, and 12, so it was also removed.
- V3's `enhance` path now uses the mature controller as its tactical fallback and only overrides a safe current-direction shot when the fallback is holding idle/replan, with nearby freeze pickup excluded. The bounded comparison on stages 1, 2, 5, 3, and 12 at seed 42 matched CORE exactly and passed the no-regression gate. It showed no measured improvement; it is not a release qualification.
- The independent `createController` can now be selected from the start screen for live manual tests. The `enhance` fallback is not used in live V3 mode. Do not equate the passing hybrid fallback with a proven new command center. The next measurable work is rule-accurate base-shot deadlines and reachable firing/intercept positions, followed by paired mission allocation and the full multi-seed release gate.

## Dynamic base-shot deadline trial

- The independent commander now seeds its base-danger distance map from all current cardinal firing lanes around the actual base rectangle, instead of four hard-coded neighboring tiles. Water passes projectiles but not tanks, steel ends a firing lane, and brick adds estimated clearing time. The map-revision cache remains intact. This improves the stage-5 seed-42 45-second isolated run from an early base loss to 12 kills without a base loss; stage 1 still has only 8 kills versus CORE's 16. This is a useful tactical improvement, not a promotion result.
- Protected-brick checks were widened to match the evaluation safety zone in front of the base. The isolated stage-1 and stage-5 runs then had zero observed protected-brick, friendly-hit, or base-hit violations.
- Immediate clearing of an ordinary brick on the target line passed a local scenario test, but dropped stage-5 kills from 12 to 6 in the same isolated run. That experiment was removed. A future clearing action must compare the time to clear and shoot against the time to reach an alternate firing lane, and must not preempt a higher-value intercept.
- `AI_V3_INDEPENDENT=1` in the isolated evaluator selects the independent controller for measurement; the default V3 evaluator path retains the conservative mature-controller fallback. The live V3 option always selects the independent controller.

## Replacement architecture before promotion

1. Build a rule-accurate topology: tank traversability, projectile visibility, destructible-brick time, base firing corridors, and forest visibility are separate fields. Cache them by map revision.
2. Estimate each enemy's earliest base-shot time and each ally's earliest *verified* intercept/shot time, including route, turns, brick clearance, and bullet travel. Use conservative bounds when the enemy's future direction is uncertain.
3. Enumerate the small two-ally assignment space jointly. Minimize the worst uncovered base threat first, then expected kill time. Reserve cells and shot corridors so allies do not converge or fire into one another. Keep a target commitment until kill, unreachable route, or a strictly more urgent base threat.
4. Plan toward a reachable firing position or a short-horizon intercept position, not the enemy center. For every chosen route endpoint, recheck `canDirectShoot`/`canShoot`; if rejected, discard that endpoint immediately. When an enemy is upper-field, maintain a lower defender unless a second ally can cover the base sooner.
5. Evaluate local movement, shooting, dodging, and base shielding every AI tick, while refreshing strategic assignments less often. `game.js` remains authoritative for actual movement, collision, and shot safety. A near freeze pickup outranks normal combat. A shot must never hit the base.
6. Promote only after deterministic A/B tests on the five hard stages, at least two seeds each, then all 35 stages and transformed maps. Compare base losses, stage clears, kills/time, ally deaths, blocked/stationary time, friendly/base hits, and CPU time. Regressions keep the existing AI active.

Research basis: Koenig and Likhachev's D* Lite for reuse during dynamic replanning; Silver's cooperative pathfinding for collision reservations; and pursuit-assignment research minimizing maximum capture time. These are design references, not claims that the prototype fully implements those algorithms.

- https://publications.ri.cmu.edu/d-lite
- https://ojs.aaai.org/index.php/AIIDE/article/view/18726
- https://arxiv.org/abs/2103.15660
