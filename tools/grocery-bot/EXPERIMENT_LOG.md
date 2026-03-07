# Grocery Bot Experiment Log

Purpose: keep an operational record of strategy experiments so we can avoid repeating failed ideas and know which branch of behavior produced the current benchmark.

## Current Benchmarks

- Easy: `118`
- Medium: `115`

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

## Guidance

- Prefer experiments that are soft cost-shaping changes over hard role locks.
- Treat `109` medium as the last known strong baseline until a higher repeatable score is achieved.
- Update this log whenever an experiment meaningfully changes live behavior, even if the result is a failure.
