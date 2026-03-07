# Grocery Bot Experiment Log

Purpose: keep an operational record of strategy experiments so we can avoid repeating failed ideas and know which branch of behavior produced the current benchmark.

## Current Benchmarks

- Easy: `118`
- Medium: `109`

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

## Guidance

- Prefer experiments that are soft cost-shaping changes over hard role locks.
- Treat `109` medium as the last known strong baseline until a higher repeatable score is achieved.
- Update this log whenever an experiment meaningfully changes live behavior, even if the result is a failure.
