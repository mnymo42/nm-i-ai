# Grocery Bot Experiment Log

Purpose: keep an operational record of strategy experiments so we can avoid repeating failed ideas and know which branch of behavior produced the current benchmark.

## Current Benchmarks

- Easy: `118`
- Medium: `115`
- Expert historical reference: `33` (91 high score on previous UTC day)
- Expert current UTC-day baseline: `89` (`2026-03-08T10-50-21-635Z-expert-expert`)

## Oracle / Script Status

- Expert oracle/script path is now modular:
  - `generate-script.mjs`
  - `src/oracle-script-optimizer.mjs`
  - `src/oracle-script-evaluator.mjs`
  - `src/oracle-script-io.mjs`
- Current generator status:
  - valid script generation works with the new constraint-based scheduler and deterministic evaluator
  - current safe default is conservative (`maxActiveBots = 1`) to avoid stacked-start / drop-bay conflicts while the higher-throughput scheduler is still being tuned
  - latest generated expert script metadata:
    - `orders_covered: 2`
    - `estimated_score: 19`
    - `last_scripted_tick: 221`
- Verdict: `keep scaffolding, continue tuning`
- Notes: the architectural rewrite and validation path are in place, but the throughput target from `ORACLE_OPTIMIZER_PLAN.md` is not met yet.

## Experiments

### Count-aware preview pruning

- Hypothesis: multi-bot score is being lost to speculative preview hoarding and inventory fragmentation.
- Change: reduce preview pickup candidates using current held inventory and remaining true demand.
- Key runs:
  - `2026-03-07T16-03-36-053Z-medium-medium` -> `52`
  - `2026-03-07T16-14-57-783Z-medium-medium` -> `109`
- Verdict: `keep`
- Notes: this is the main structural improvement behind the current medium benchmark.

### Hard 20 ms send throttle

- Hypothesis: delaying sends slightly would reduce risk of command spam and missed registration.
- Change: minimum `20 ms` between sends in the client.
- Key runs:
  - `2026-03-07T16-25-08-457Z-medium-medium` -> `3`
- Verdict: `revert`
- Notes: throttle fired on many ticks and correlated with catastrophic score collapse. Keep the one-send-per-round guard only.

### Short-hold reservations + custom bot priority

- Hypothesis: shorter reservation holds and planning scoring bots first would reduce corridor conflicts.
- Change: limited goal holds and changed multi-bot path reservation order.
- Key runs:
  - `2026-03-07T16-31-27-266Z-medium-medium` -> `90`
  - `2026-03-07T16-34-35-518Z-medium-medium` -> `20`
- Verdict: `revert`
- Notes: too unstable relative to the `109` branch.

### Shelf quarantine in assignment

- Hypothesis: failed pick faces should be treated as temporarily unavailable during multi-bot assignment, not rediscovered through repeated assignment.
- Change: per-bot blocked `item_id` cooldowns now feed directly into the cost matrix.
- Key runs:
  - bundled with zone-affinity experiment below
- Verdict: `keep for now`
- Notes: aligns with real warehouse exception handling and reduces repeated bad picks.

### Zone affinity

- Hypothesis: soft zone ownership will reduce aisle crossing and multi-bot traffic.
- Change: pickup tasks get a zone penalty, stronger for preview work than active work.
- Key runs:
  - `2026-03-07T16-41-11-368Z-medium-medium` -> `99`
- Verdict: `keep for now`
- Notes: not a new benchmark, but healthier than the rigid finisher experiments. Lower waits/stalls than several failed branches.

### Completion-wave control

- Hypothesis: one bot should act as an active-order finisher while others support with local picking.
- Change: selected a finisher bot and penalized preview work around that role.
- Key runs:
  - `2026-03-07T16-48-39-772Z-medium-medium` -> `62`
  - `2026-03-07T16-52-29-717Z-expert-expert` -> `33`
- Verdict: `revert`
- Notes: concept is reasonable, but current implementation is too rigid. It increased waits, forced waits, and wasted inventory in both medium and expert. Revisit later only as a softer bias, especially for higher bot counts.

### Medium mission planner v1

- Hypothesis: medium is plateauing because bots are fully re-tasked every tick instead of holding short-lived warehouse-style missions.
- Change: medium-only mission layer with mission persistence, mission-level active demand reservation, one-preview-runner cap, endgame preview cutoff, idle repositioning, and replay-visible mission metrics.
- Follow-up fix: carried-over preview missions are now invalidated when active demand is uncovered again, with targeted specs for that contract.
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - replay simulate against `2026-03-07T16-14-57-783Z-medium-medium` -> `0.6978` match ratio, `0.02` wait ratio
  - replay simulate against `2026-03-07T16-55-44-962Z-medium-medium` -> `0.73` match ratio, `0.0156` wait ratio
  - live medium run `2026-03-07T18-00-47-256Z-medium-medium` -> `2`
- Verdict: `revert as medium default`
- Notes: the mission layer is structurally interesting but catastrophically unstable in live medium. Keep the code available behind a non-default strategy flag only if we revisit it later; medium default is reverted to the stable assignment path.

### Pickup service-bay exclusivity + aisle queue discipline

- Hypothesis: medium is collapsing because bots are allowed to claim occupied aisle slots as their immediate next step and to target pickup approach cells that are already occupied, creating forklift-style bay jams.
- Change: multi-bot pathing now blocks currently occupied slots as immediate next-step destinations, and pickup approach selection now treats occupied adjacent shelf cells as unavailable service bays.
- Validation:
  - `node --test tools/grocery-bot/test/routing.test.mjs tools/grocery-bot/test/planner-multibot.test.mjs` -> pass
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - live medium run `2026-03-07T18-22-15-796Z-medium-medium` -> `90`
- Verdict: `keep for stability, not benchmark`
- Notes: this is a warehouse-queueing fix, not a scoring-weight change. It eliminated the recent legality and pickup collapse (`0` sanitizer overrides, `0` failed pickups, `0` wasted inventory), but score remained below the `109` benchmark because wait/stall volume is still too high.

### Staging-lane fallback for blocked pickers

- Hypothesis: after removing collision collapse, medium is still losing score because blocked bots accept `wait` too easily instead of being actively re-staged into useful zone lanes.
- Change: multi-bot fallback now prefers a zone staging cell before random neighbor moves, blocked non-dropoff tasks can reroute into fallback reposition instead of waiting, and anti-deadlock only applies forced wait when no move is available.
- Validation:
  - `node --test tools/grocery-bot/test/planner-multibot.test.mjs` -> pass
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - live medium run `2026-03-07T18-26-51-234Z-medium-medium` -> `4`
- Verdict: `revert`
- Notes: this reduced waits but broke score conversion badly: `0` completed orders, `21` failed pickups, `5` non-scoring dropoffs, and wasted inventory returned. The throughput idea as implemented was too aggressive and destabilized useful commitment.

### Soft order flush for nearly-complete active orders

- Hypothesis: the stable branch is losing medium score because it keeps allowing preview work when the active order is already almost coverable, delaying completion cadence.
- Change: medium-only assignment mode now detects a small-remaining active order, suppresses preview pickup tasks during that flush window, and boosts drop / active-pick demand scores to close the current order faster.
- Validation:
  - `node --test tools/grocery-bot/test/planner-multibot.test.mjs` -> pass
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - live medium run `2026-03-07T18-34-51-201Z-medium-medium` -> `13`
- Verdict: `revert`
- Notes: the idea was directionally reasonable, but this implementation over-committed and stalled the map: `1` completed order, `8` failed pickups, `5` non-scoring dropoffs`, and a `189`-tick dead zone. Revisit only as a much softer bias if at all.

### Medium 109 baseline recovery

- Hypothesis: the current medium branch drifted too far from the last known strong baseline (`109`), so restoring the simpler `82ee32e` multi-bot assignment/runtime behavior should recover throughput better than adding new policy layers.
- Change: reverted medium assignment-mode task scoring and execution flow toward the `82ee32e` branch:
  - removed zone penalty and blocked-item quarantine from assignment cost scoring
  - removed occupied-next-step / service-bay constraints from assignment-mode planning
  - restored the simpler assignment runtime loop while keeping client-side legality fixes in place
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - replay simulate against `2026-03-07T16-14-57-783Z-medium-medium` -> `0.8956` match ratio, `0.02` wait ratio
  - replay simulate against `2026-03-07T18-22-15-796Z-medium-medium` -> `0.8133` match ratio, `0.1756` wait ratio
  - live medium run `2026-03-07T18-48-23-889Z-medium-medium` -> `115`
- Verdict: `keep`
- Notes: the simpler `82ee32e`-style assignment/runtime recovered medium throughput and established a new benchmark. Result profile stayed healthy enough to promote: `0` failed pickups, `0` non-scoring dropoffs, `18` wait actions, `113` stalls, only `4` sanitizer overrides, and just `1` wasted end item.

### Warehouse-control planner v1 (`warehouse_v1`)

- Hypothesis: medium will not reach the high `200`s through more local assignment tuning; it needs a warehouse-style control layer with explicit work release, stable missions, service-bay queueing, preview WIP caps, and endgame cashout modes.
- Change:
  - added a new non-default `runtime.multi_bot_strategy = "warehouse_v1"` branch
  - implemented:
    - control modes (`close_active_order`, `build_active_inventory`, `limited_preview_prefetch`, `close_if_feasible`, `partial_cashout`, `stop_preview`)
    - mission types (`pickup_active`, `drop_active`, `pickup_preview`, `queue_service_bay`, `reposition_zone`)
    - service-bay and queue-cell reservation
    - queue promotion when a bay clears
    - zone ownership with dynamic borrowing
  - added replay/benchmark support:
    - `benchmark` CLI mode
    - control mode timeline
    - preview WIP timeline
    - queue/service-bay occupancy peaks
    - active close ETA timeline
  - fixed `estimate-max` so it works with current compact replay files
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - `node tools/grocery-bot/index.mjs --mode benchmark --difficulty medium --replay tools/grocery-bot/out` -> pass
  - `node tools/grocery-bot/index.mjs --mode benchmark --difficulty medium --profile medium_warehouse_v1 --replay tools/grocery-bot/out` -> pass
  - `node tools/grocery-bot/index.mjs --mode estimate-max --replay tools/grocery-bot/out/2026-03-07T18-48-23-889Z-medium-medium/replay.jsonl` -> pass
- Verdict: `implemented behind flag, not promoted`
- Notes: this is now a real development branch with specs and offline tooling, but it is intentionally not the live default until it beats the `115` assignment baseline on fresh medium runs.

### High-bot warehouse rollout + multi-drop support

- Hypothesis: `hard`, `expert`, and `nightmare` are failing because the old assignment planner releases too much concurrent work and has no viable traffic/WIP control once bot count reaches `5+`.
- Change:
  - added multi-drop-zone parsing and nearest-drop routing across protocol, replay, planner, sanitizer, and estimator paths
  - promoted `warehouse_v1` as the default multi-bot strategy for:
    - `hard`
    - `expert`
    - `nightmare`
  - added high-bot warehouse tuning:
    - active runner cap via `active_mission_buffer` / `active_runner_cap`
    - deeper service-bay queue depth
    - unique reposition target reservation
    - longer endgame preview cutoff for larger maps / 500-turn nightmare
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
- Verdict: `keep and validate live`
- Notes: this is the first architecture change aimed directly at `5-20` bots. It is necessary because the prior defaults were already non-competitive on `hard+`. Live baselines still need to be re-established on the new branch.

### High-bot warehouse close-mode correction

- Hypothesis: the first `warehouse_v1` hard rollout froze because control mode was allowing preview/idle behavior once active demand was merely assigned or held in inventory, instead of forcing the team to finish the active order; sticky reposition missions also kept overflow bots out of real work for too long.
- Change:
  - control mode now treats `active demand covered by held inventory` as `close_active_order`, not `limited_preview_prefetch`
  - preview release stays blocked until active demand is truly closed, not just "held"
  - `reposition_zone` missions now expire after one tick so overflow bots re-enter assignment quickly
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - `node tools/grocery-bot/index.mjs --mode benchmark --difficulty hard --replay tools/grocery-bot/out` -> pass
- Verdict: `implemented, pending live validation`
- Notes: this is a control-layer correctness fix, not a tuning change. The old hard `score 0` replay should no longer be treated as representative of the current warehouse branch because its failure depended on the now-fixed close/preview mode bug.

### Minimal replay viewer

- Hypothesis: replay analysis is now bottlenecked by raw JSON inspection; a tiny local viewer will shorten diagnosis loops for warehouse coordination failures, especially on `expert` and `nightmare`.
- Change:
  - added a Node-served replay viewer that browses existing runs from `tools/grocery-bot/out`
  - added a shared read-only replay-run adapter for listing/loading `summary.json`, `analysis.json`, layout, and rebuilt ticks
  - added UI support for tick scrubbing plus jumps to score events, failed pickups, overrides, mode changes, and stagnation starts
- Validation:
  - `node --test tools/grocery-bot/test/replay-viewer.test.mjs` -> pass
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
- Verdict: `keep`
- Notes: this is a debugging tool, not a product surface. It is intended to speed up expert/high-bot tuning loops.

### Expert warehouse throughput pass 1

- Hypothesis: expert is being limited by over-queueing and under-release in `close_active_order`; too many bots commit to blocked pickup bays or low-value parking instead of finding alternate active work and converting held value into drop throughput.
- Change:
  - added `close_mode_active_runner_cap` so expert/nightmare can release more active runners during close mode
  - added `allow_pickup_queue_in_close_mode` so expert/nightmare can avoid sticky pickup-bay queues in close mode
  - warehouse pickup assignment now evaluates multiple candidate items in score order and takes the first feasible shelf plan instead of giving up after one blocked choice
- Validation:
  - `node --test tools/grocery-bot/test/planner-warehouse.test.mjs` -> pass
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - expert corpus benchmark to be rerun after landing the viewer-based inspection loop
- Verdict: `implemented, pending offline benchmark and live expert validation`
- Notes: this is the first explicit expert-focused warehouse throughput pass. The target is lower wait/stall density without reopening pickup or legality failures.

### Oracle script optimizer v2

- Hypothesis: expert oracle mode needs a true constraint-based scheduler with global shelf allocation, unary drop-off capacity, pipelined `N+1` pre-pick, deterministic script validation, and a clean scripted-to-live handoff.
- Change:
  - replaced the old greedy monolith in `generate-script.mjs` with modular oracle/script components
  - added:
    - global shelf allocation
    - deterministic script evaluator
    - richer script metadata
    - shared oracle/script file loading
    - scripted planner handoff specs
    - Claude hook coverage for oracle/script/config edits
  - added replay-aware stacked-start handling plus post-drop dock clearing
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - `node tools/grocery-bot/generate-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl --out tools/grocery-bot/config/script-expert.json` -> pass
- Verdict: `keep, throughput still needs tuning`
- Notes: the rewrite is now structurally correct and test-covered, but it is intentionally conservative today (`maxActiveBots = 1`) because higher concurrency still creates invalid schedules. This is the base to tune upward from, not the final optimizer.

### Opening fidelity audit + promotion gate

- Hypothesis: the opening-focused offline search is failing structurally, not because it needs more random variants. We need a replay-vs-sim audit that identifies the first throughput divergence and rejects weak candidates before they look competitive on late metrics.
- Change:
  - added `--mode opening-audit` in `index.mjs`
  - added `src/opening-audit.mjs` to compare:
    - first pickup / drop / score timing
    - productive vs wasted bot-ticks
    - blocked/congestion signals
    - staged future work
  - extended batch reports with:
    - `opening_baseline`
    - `opening_profile`
    - `first_divergence_tick`
    - `first_divergence`
    - `promotable_shortlist`
  - tightened triage so baseline ties with weaker opening capacity stay non-promotable
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - `node tools/grocery-bot/index.mjs --mode opening-audit --difficulty expert --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --script tools/grocery-bot/config/script-expert-opening100.json --max-tick 120` -> pass
  - `node tools/grocery-bot/optimize-oracle-script-batch.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert-opening100.json --out-report tools/grocery-bot/out/oracle-script-opening100-report.json --preset opening_100 --runs 18 --parallel 9 --seed 7004` -> pass
- Verdict: `keep`
- Notes:
  - replay baseline by tick `120`: first pickup `17`, first drop `31`, first score `32`, final score `29`
  - current best `opening_100` candidate still ties only `22` by tick `100`
  - opening audit shows immediate divergence at tick `0` with `drop_lane_or_congestion_gap`
  - candidate opening profile is effectively dead: `0` score by tick `120`, no pickups, no drops
  - next work should target opening-capacity and congestion modeling directly, not broader family count

## Guidance

- Prefer experiments that are soft cost-shaping changes over hard role locks.
- Treat `109` medium as the last known strong baseline until a higher repeatable score is achieved.
- Update this log whenever an experiment meaningfully changes live behavior, even if the result is a failure.
# 2026-03-07 - Oracle Script Recovery

- Hypothesis: the oracle rewrite regressed because it replaced a partially effective high-throughput path with a valid but over-constrained scheduler. Restoring the old heuristic path as a benchmark and letting local search choose the best candidate should recover throughput without discarding the validated optimizer.
- Changes:
  - restored a separate legacy oracle generator in `src/oracle-script-legacy.mjs`
  - added `src/oracle-script-search.mjs` to rank modular vs legacy candidates locally
  - updated `generate-script.mjs` to auto-search and write the best locally-evaluated script by default
  - added `tune-oracle-script.mjs` for local oracle candidate sweeps
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs`
- Verdict: keep. This restores a throughput benchmark path and moves more expert-oracle work into deterministic local scripts instead of chat iteration.

# 2026-03-07 - Oracle Optimizer Harness

- Hypothesis: the expert oracle workflow should not depend on one lightweight generator call. A heavy local harness with score/tick targets and deterministic wide search will let us brute-force many candidate schedules cheaply and keep only the best `fasit`.
- Changes:
  - expanded `src/oracle-script-search.mjs` with wide search, deterministic candidate shuffling, and report generation
  - added `optimize-oracle-script.mjs` to run hundreds/thousands of local candidate evaluations and write:
    - best script JSON
    - optimizer report JSON
  - added tests for wide search reporting
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs`
- Verdict: keep. This is now the preferred offline oracle entrypoint before live expert script attempts.

# 2026-03-07 - Replay Compression Optimizer

- Hypothesis: once the live/player model has already proven a good oracle-known prefix, we should optimize that run backward instead of asking the forward scheduler to rediscover it. Removing redundant slack from a proven replay should free ticks for earlier handoff.
- Changes:
  - added `src/oracle-script-compressor.mjs` to extract replay actions, evaluate the oracle-known outcome, and remove redundant all-wait ticks from the back of the schedule
  - added `compress-oracle-script.mjs` to emit a replay-derived compressed script and report JSON
  - documented replay compression as a first-class expert oracle workflow
- Validation:
  - `node --test tools/grocery-bot/test/oracle-script.test.mjs`
- Verdict: keep as `v1`. It is intentionally narrow, but it matches the replay-tightening strategy and gives us a deterministic post-processing pass on proven runs.

# 2026-03-07/08 - Replay Handoff Fidelity + Provenance

- Hypothesis: replay drift in expert hybrid mode was caused by our replay model or execution path, not by game randomness, so exact diff tooling plus stricter expected-state handling should make rewind/handoff debuggable and traceable.
- Changes:
  - added `diff-replay-transition.mjs` plus `src/replay-transition-diff.mjs`
  - tightened replay-script expected-state checks in `src/planner.mjs`
  - fixed replay-derived script generation in `src/oracle-script-compressor.mjs` to preserve full expected state and merge layout drop-zone data
  - added run provenance capture via `src/run-provenance.mjs` and `index.mjs`
  - added `expert_replay_handoff` as an explicit frozen handoff profile
- Validation:
  - `node --test tools/grocery-bot/test/run-provenance.test.mjs tools/grocery-bot/test/oracle-script.test.mjs tools/grocery-bot/test/planner-script.test.mjs`
  - replay/handoff live runs improved from immediate tick-0 failure to trusted replay prefixes and clean handoff
- Key runs:
  - `2026-03-07T23-52-29-214Z-expert-expert_replay_handoff` -> `13`, trusted replay through tick `51`
  - `2026-03-07T23-59-03-111Z-expert-expert_replay_handoff` -> `12`, replay drift at tick `27`
  - `2026-03-08T00-03-58-975Z-expert-expert` -> `13`, first new-day clean expert baseline
- Verdict: keep the tooling; stop treating replay as the main blocker.
- Notes: replay/handoff is now instrumented and provenance-tagged. The dominant expert problem is still post-opening planner robustness, not just replay execution.

# 2026-03-08 - Expert Idle Bot Parking + Preview Cap + Drop-off Priority Boost

- Hypothesis: expert 10-bot gridlock is caused by (1) empty bots blocking delivery corridors, (2) too many bots hoarding preview items, and (3) the cost matrix undervaluing drop-off tasks for distant bots carrying deliverables.
- Changes:
  - `chooseParkingAction()` in `planner-multibot.mjs`: idle empty bots now score neighbor cells by distance-from-dropoff (move away) and crowding penalty (avoid clustering), instead of random fallback
  - `buildTasks()` preview picker cap: counts bots already carrying non-active items and suppresses preview prefetch when `botsCarryingPreview >= floor(bots/3)` (3 for expert)
  - `buildTasks()` drop-off demand boost: `demandScore = 4 + deliverableCount * 3 + dropDistance * 0.8`, compensating for travel cost so distant bots still prioritize delivery
  - `executeAssignedTaskStrategy()`: no-task bots use parking instead of random fallback when empty or carrying non-deliverable items
- Also tested and reverted:
  - delivery-first bot reservation priority ordering: reduced stalls (1276→439) but hurt score (38→22) by blocking pickup bots in early game
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> 131 pass (2 new specs)
  - medium simulate: 90% match, 0.02 wait ratio (no regression)
  - live expert runs:
    - `2026-03-08T10-28-09-789Z-expert-expert` -> `20` (parking + preview cap only)
    - `2026-03-08T10-34-25-486Z-expert-expert` -> `38` (+ drop-off boost)
    - `2026-03-08T10-36-37-665Z-expert-expert` -> `22` (+ reservation reorder, reverted)
    - `2026-03-08T10-39-20-479Z-expert-expert` -> `38` (reproducibility confirmed)
- Verdict: `keep` — new expert current-day baseline
- Notes: sanitizer overrides dropped from 373→75 (-80%), scoring extended from tick 101 to tick 175. Dead zone still forms eventually (tick 175-299). Next bottleneck is the same structural pattern occurring later: bots cluster once active tasks run low. The 125-tick dead zone at end suggests either more aggressive recovery or better idle-bot utilization is needed.

# 2026-03-08 - Aisle-Based Parking Slots

- Hypothesis: random neighbor parking causes bots to cluster near drop-off and block corridors. If idle bots park at aisle-aligned slots on the second-to-last corridor row (row 15), they stay close to item shelves without blocking delivery traffic.
- Changes:
  - added `computeParkingSlots()` in `planner-multibot.mjs`: finds item columns and corridor rows from the grid, computes parking slots at the second-to-last corridor aligned with each aisle
  - rewrote `chooseParkingAction()` to first try computed parking slots (avoiding already-claimed slots), then fall back to crowding-based neighbor scoring
  - passing `items`, `gridWidth`, `gridHeight` into parking calls from runtime
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> 131 pass
  - live expert run: `2026-03-08T10-50-21-635Z-expert-expert` -> `89` (9 orders, 44 items)
- Verdict: `keep` — massive improvement, new expert baseline
- Key metrics vs previous 38 baseline:
  - Sanitizer overrides: 75 → 18 (-76%)
  - Stalls: 1276 → 1042 (-18%)
  - Forced waits: 292 → 186 (-36%)
  - Max stalled bots: 10 → 8
  - Wasted end inventory: 8 → 3
  - Scoring through ALL 12 windows (was dead after tick 150)
  - Only gap: tick 200-224 window scored just +2
- Notes: the parking system produces consistent scoring throughout the full 300-tick game. Remaining bottleneck is 10-18 tick stagnation windows between deliveries and the 32-tick opening ramp-up. Score of 89 is close to the previous UTC-day high of 91 (different map/seed), proving the approach generalizes.

# 2026-03-08 - Workflow Cleanup + Supported Inspection Commands

- Hypothesis: replay analysis and expert hybrid work are slower than necessary because the active workflow still relies on ad hoc `node -e` snippets, `tmp-*` helpers, and stale docs. Supported read-only commands plus a stable oracle extractor should reduce context churn and keep the repo centered on the live 89-point expert baseline.
- Changes:
  - added supported read-only workflow helpers in `src/workflow-tools.mjs`
  - added `index.mjs` modes:
    - `runs`
    - `analyze`
    - `script-info`
  - added stable oracle extraction via `extract-oracle.mjs` and `src/oracle-extract.mjs`
  - kept `tmp-extract-oracle.mjs` as a compatibility wrapper instead of the active entrypoint
  - updated startup/runbook docs to point at:
    - `2026-03-08T10-50-21-635Z-expert-expert` as the current expert baseline
    - `assignment_v1` as the active expert path
    - `warehouse_v1` and replay-handoff as archived/experimental workflow surfaces
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
- Verdict: keep
- Notes: this is a workflow-surface cleanup, not a strategy change. It preserves the current expert baseline while making the next oracle/compressor pass cheaper to inspect and reason about.

# 2026-03-08 - Offline Expert Wave Staging + Replay-Seeded Search

- Hypothesis: the offline expert oracle stack is capped by two structural limits: it only stages the immediate next order, and its search mostly explores generic parameter grids instead of starting from the proven `89` replay structure. Bounded multi-order wave staging plus replay-seeded candidates should improve score before handoff without spending live tokens.
- Changes:
  - extended modular oracle settings with wave-level controls:
    - `visibleOrderDepth`
    - `futureOrderBotCap`
    - `futureOrderItemCap`
    - `futureOrderPerOrderItemCap`
    - `closeOrderReserveBots`
    - `dropLaneConcurrency`
  - updated `src/oracle-script-optimizer.mjs` to:
    - reserve a close-now bot lane for the active order
    - build a rolling frontier of visible future orders
    - pre-stage bounded future work across more than one visible order
    - keep staged future inventory attached to the target order for later handoff
  - added replay-seeded skeleton extraction plus seeded option families in `src/oracle-script-replay-seed.mjs`
  - updated `src/oracle-script-search.mjs` with:
    - `handoff_value` objective
    - replay-seeded modular/wave/handoff candidate families
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> pass
  - `node tools/grocery-bot/optimize-oracle-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert-eval.json --out-report tools/grocery-bot/out/oracle-script-optimizer-report-eval.json --objective handoff_value --iterations 150 --score-to-beat 19 --ticks-to-beat 176` -> best candidate `22` score, `2` orders, tick `282`
- Verdict: keep and iterate
- Notes: this improves the offline best score over the previous quick baseline (`19` -> `22`), proving the new search surface can beat the old result. It does not yet improve cutoff tick, so the next follow-up should focus on replay-seeded candidates that preserve more of the early `89`-run cadence instead of just raising pre-handoff score.

# 2026-03-08 - Parallel Replay Frontier Search + Live-Worthy Ranking

- Hypothesis: the offline search is still underperforming because replay-derived candidates are too coarse and the ranking collapses onto the latest high-score preserve script. Finer replay score targets, explicit rewind windows, and a handoff-aware `live_worthy` ranking should produce a better offline frontier for live handoff tests.
- Changes:
  - extended `compressOracleReplayScript()` with configurable `rewindTicks`
  - changed replay score target extraction to use real replay score changes instead of only 10-point buckets
  - added replay rewind families in `src/oracle-script-search.mjs` across multiple rewind windows per target score
  - added `live_worthy` ranking:
    - only gives time-credit once the prefix reaches a viable score bucket
    - prefers strong mid-handoff prefixes over near-complete late preserves
  - added `optimize-oracle-script-batch.mjs` aggregate reporting for `best_by_objective`
  - documented the parallel batch optimizer in `README.md` and `NEXT_SESSION_PROMPT.md`
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> 19 pass
  - `node tools/grocery-bot/optimize-oracle-script-batch.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert-batch-liveworthy.json --out-report tools/grocery-bot/out/oracle-script-batch-liveworthy-report.json --objective live_worthy --objectives live_worthy,handoff_value,handoff_first --iterations 220 --runs 24 --parallel 12 --seed 7004`
    - best `live_worthy`: `75` score at tick `260`
    - best `handoff_value`: `89` score at tick `298`
    - best `handoff_first`: `19` score at tick `160`
- Verdict: keep
- Notes: `75@260` is the new offline candidate most worth a live handoff test because it preserves materially more score than the early modular scripts while returning `40` live ticks instead of `24`. The next improvement should focus on handoff state quality, not just score/tick compression.

# 2026-03-08 - Checkpoint Rewriter + Early-Game Frontier Search

- Hypothesis: the replay/oracle stack is still optimizing the wrong target. To reach leaderboard throughput, the offline search needs to optimize score inside the first `100` ticks, not late-prefix handoff only. Replay checkpoints plus early-game ranking should expose the real opening bottleneck.
- Changes:
  - added `src/oracle-script-checkpoints.mjs` to extract deterministic replay checkpoints and build `checkpoint_rewriter` candidates
  - extended `src/oracle-script-evaluator.mjs` with score timelines and final bot state
  - added `src/oracle-script-metrics.mjs` to compute:
    - `score_at_tick_100`
    - `tick_to_40`
    - `tick_to_60`
    - `tick_to_80`
    - continuation metrics like stranded inventory and drop-off crowding
  - updated `src/oracle-script-search.mjs` with new objectives:
    - `score_by_tick_100`
    - `tick_to_score`
    - `throughput_frontier`
  - updated batch reporting to emit a shared early frontier
  - switched optimizer defaults toward early-game objectives
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> 20 pass
  - `node tools/grocery-bot/optimize-oracle-script-batch.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert-score100.json --out-report tools/grocery-bot/out/oracle-script-score100-report.json --objective score_by_tick_100 --objectives score_by_tick_100,throughput_frontier,tick_to_score --iterations 180 --runs 18 --parallel 9 --seed 7004`
  - resulting frontier:
    - best `score_by_tick_100`: `22`
    - best `tick_to_40`: `156`
    - best `tick_to_60`: `237`
    - best `tick_to_80`: `276`
- Verdict: keep and iterate
- Notes: this pass did not beat the baseline replay’s early pace. That is still useful because it proves the opening bottleneck is now isolated and measurable. The next offline improvement should attack the first `100` ticks directly with stronger opening orchestration rather than more late replay compression.

# 2026-03-08 - Sim Triage + Opening-Family Search

- Hypothesis: poor sim results are being over-ranked because the search does not compare against the replay baseline strongly enough, and the report does not distinguish tied/weak candidates from promotable ones. Baseline-aware triage plus opening-focused families should make the failure mode explicit and allow stronger opening search to compete fairly.
- Changes:
  - added replay-baseline extraction and candidate triage in `src/oracle-script-metrics.mjs`
  - search now decorates candidates with:
    - `baseline_match`
    - `baseline_beat`
    - `promotable`
    - penalty reasons
  - added opening families in `src/oracle-script-replay-seed.mjs`:
    - `opening_bucket_v2`
    - `drop_lane_scheduler`
    - `opening_aisle_partition`
  - added lightweight optimizer support for opening families in `src/oracle-script-optimizer.mjs`:
    - true pre-release staging for hidden known orders
    - aisle-bias bot selection
    - opening/drop-lane ranking hints
  - batch reporting now includes:
    - replay `baseline`
    - `promotable_shortlist`
    - per-candidate triage flags
  - batch CLI now supports presets:
    - `opening_100`
    - `tick_to_40`
    - `tick_to_60`
    - `tick_to_80`
- Validation:
  - `node --test tools/grocery-bot/test/*.test.mjs` -> 20 pass
  - `node tools/grocery-bot/optimize-oracle-script-batch.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert-opening100.json --out-report tools/grocery-bot/out/oracle-script-opening100-report.json --preset opening_100 --runs 18 --parallel 9 --seed 7004`
  - result:
    - baseline `score_at_tick_100`: `22`
    - best candidate `score_at_tick_100`: `22`
    - `promotable_shortlist`: empty
- Verdict: keep
- Notes: this did not beat the opening baseline, but it removed ambiguity: the current opening families are still too weak, and the report now says so directly instead of hiding that behind late-score winners.
