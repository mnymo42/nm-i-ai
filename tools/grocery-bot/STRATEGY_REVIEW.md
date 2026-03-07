# Grocery Bot Strategy Review

## Current Baseline

- Best repeatable easy score: `118`
- Current medium benchmark: `115`
- Verified runs:
  - `tools/grocery-bot/out/2026-03-07T15-56-13-035Z-easy-easy`
  - `tools/grocery-bot/out/2026-03-07T16-00-36-191Z-easy-easy`
- Both runs completed `14` orders, delivered `48` items, and had:
  - `0` failed pickups
  - `0` non-scoring dropoffs
  - `0` wasted inventory at game over
  - `1` wait action
- Client timing in those runs stayed well below danger levels, and the 20 ms send cap never had to delay a send.
- Medium progression:
  - `tools/grocery-bot/out/2026-03-07T16-03-36-053Z-medium-medium` -> score `52`, `5` orders, `27` items
  - `tools/grocery-bot/out/2026-03-07T16-14-57-783Z-medium-medium` -> score `109`, `11` orders, `54` items
  - `tools/grocery-bot/out/2026-03-07T18-48-23-889Z-medium-medium` -> score `115`, `12` orders, `55` items
  - The latest jump came from restoring the simpler `82ee32e`-style multi-bot assignment/runtime path while keeping client legality fixes.
- Hard progression:
  - `tools/grocery-bot/out/2026-03-07T19-54-02-292Z-hard-hard` -> score `28`, `3` orders, `13` items
- Expert references:
  - `tools/grocery-bot/out/2026-03-07T16-52-29-717Z-expert-expert` -> score `33`, `3` orders, `18` items
  - `tools/grocery-bot/out/2026-03-07T19-21-18-326Z-expert-expert` -> score `11`, `1` order, `6` items

## What Changed To Reach 118

- Added a hard `1 send per round` client guard.
- Added a minimum `20 ms` send interval plus replay timing telemetry.
- Added a pending-pickup intent lock so unresolved `pick_up` attempts stay committed through the verification window.

## Current Position

- Easy is no longer the active bottleneck.
- Medium is now the active bottleneck.
- Expert is now the main upside target after the replay viewer lands, because the current expert reference (`33`) is still far below the likely score ceiling.
- The current target is no longer just `>116`; it is to turn the stable `115` branch into an architecture that can climb toward the high `200`s on medium.
- Detailed experiment history now lives in [`EXPERIMENT_LOG.md`](./EXPERIMENT_LOG.md).
- Structural refactor backlog now lives in [`STRUCTURE_REVIEW.md`](./STRUCTURE_REVIEW.md).
- `mission_v1` is not the medium default after a live collapse to score `2`; the stable assignment path remains the baseline.
- `warehouse_v1` now exists behind a non-default strategy flag and is intended as the next real medium architecture, but it must clear offline benchmark gates before any promotion.
- `hard`, `expert`, and `nightmare` now default to `warehouse_v1`, because the old assignment branch is already structurally broken at `5+` bots.
- Multi-drop-zone support is now implemented end-to-end, even though the first observed nightmare payload on `2026-03-07` still exposed only one live drop zone.
- Offline corpus benchmarking is now part of the workflow:
  - `node tools/grocery-bot/index.mjs --mode benchmark --difficulty medium --replay tools/grocery-bot/out`
  - `node tools/grocery-bot/index.mjs --mode estimate-max --replay tools/grocery-bot/out/<run-id>/replay.jsonl`
- A minimal local replay viewer is now part of the workflow:
  - `npm run grocery-bot:viewer`
  - use it to inspect queue-service-bay pileups, held deliverable inventory, and warehouse control-mode oscillation before spending more expert tokens
- Expert oracle/script is now a first-class workflow:
  - `tmp-extract-oracle.mjs` updates `config/oracle-expert.json`
  - `generate-script.mjs` builds `config/script-expert.json`
  - `src/oracle-script-evaluator.mjs` validates the generated script deterministically before it is written
  - the current script optimizer is structurally rebuilt but still conservative on throughput (`maxActiveBots = 1` by default) while the higher-concurrency scheduler is tuned

## Current Strategy (As Implemented)

### 1) Single-bot optimizer (`easy`)
- Uses a dedicated single-bot policy path in [`src/planner.mjs`](./src/planner.mjs).
- Builds candidate pickup type sequences up to free inventory capacity (max 3).
- Scores each candidate by:
  - projected points from next drop (`items + order completion bonuses`)
  - route cost (pick sequence + return to drop-off)
  - leftover inventory penalty
- Chooses first action from best candidate route.

### 2) Recovery mode (anti-flatline)
- Tracks rounds without score increase.
- If stagnation exceeds threshold (`recovery.no_progress_rounds`), switches to recovery behavior:
  - prioritize active-order items only
  - nearest active-needed shelf
  - immediate drop-off when deliverable

### 3) Failed-pickup cooldown
- Tracks attempted `pick_up` and verifies inventory increase on following state.
- If pickup appears to fail, blocks that `item_id` temporarily for that bot.
- Prevents immediate repeated attempts on the same shelf id.

### 4) Pathing and movement rules
- Treats wall cells and shelf cells as non-walkable route nodes.
- Routes to cells adjacent to shelves for pickup.
- Uses shortest-path search (`findTimeAwarePath`) for route segments.

### 5) Multi-bot mode (`medium+`)
- Uses cost-matrix assignment + reservation-based routing + deadlock handling.
- Not used for `easy`, but remains active for higher difficulties.

## Historical Bump Analysis (Easy, Score 45)

Source replay: `tools/grocery-bot/out/2026-03-05T09-25-02-067Z-easy-easy/replay.jsonl`

### Score progression by 25-round segments
- 0-24: +8
- 25-49: +10
- 50-74: +16
- 75-99: +3
- 100-124: +0
- 125-149: +0
- 150-174: +6
- 175-199: +0
- 200-224: +1
- 225-249: +0
- 250-274: +0
- 275-299: +1

### High-value bump events
- Round 17: +8 (order completion)
- Round 36: +7 (order completion)
- Round 54: +8 (order completion)
- Round 72: +8 (order completion)
- Round 151: +6 (order completion)

### Main bottlenecks in stagnation windows
Long zero-gain windows:
- Round 96-150 (55 rounds)
- Round 152-213 (62 rounds)
- Round 215-276 (62 rounds)

Observed behavior in those windows:
- many pickup attempts with no inventory gain
- repeated shelf targeting loops
- occasional drop-off attempts with no score gain

## Where We Have Bumps (and why)

### Bump type A: clean order completion chains
- Large jumps happen when we fill inventory with active-needed items and finish at drop-off.
- This means completion cadence is the strongest lever.

### Bump type B: late isolated +1 item gains
- Endgame bumps are mostly single-item deliveries, indicating we are not reliably assembling full completion trips late.

## Implemented Streamlining Changes (Current)

### 1) 15-round stagnation reset checkpoint
- If score does not increase for 15 rounds, planner now performs a hard intent reset:
  - clears pending pickup intents
  - clears cooldown/failure memory
  - switches to recovery burst mode for focused completion behavior
- Goal: break long no-score loops by re-planning from current state only.
- Updated: threshold is now phase-aware:
  - early: 15
  - mid: 10
  - final ~60 rounds: 6

### 2) Delayed pickup-failure confirmation + adaptive cooldown
- Pickup failure is no longer assumed after one round.
- Planner now waits until a 2-round verification window closes before treating a pickup as failed.
- On confirmed failure, cooldown is adaptive per item id (`6 -> 12 -> 24 -> ...` capped).
- Goal: reduce false negatives from state/action lag while still suppressing repeated bad picks.

### 3) Active-order completion commit mode
- In single-bot mode, planner now enters completion commit behavior when:
  - recovery mode is active, or
  - active-order remaining demand becomes small.
- Preview influence is reduced/disabled in this mode.
- Goal: improve +5 completion cadence and reduce drift into low-value actions.

### 4) One-item-left fast path
- When active order has one remaining missing item, planner prioritizes direct completion flow:
  - if item already in inventory: immediate route to drop-off
  - else: nearest needed shelf -> pick -> drop-off
- Goal: reduce late-game dead-time near almost-complete orders.

### 5) Drop confirmation cap
- Repeated non-scoring `drop_off` is now capped:
  - allow initial `drop_off`
  - allow one confirmation
  - then force replan without another immediate drop
- Goal: prevent wasting rounds stuck on drop-off retries.

## 3 Concrete Streamlining Improvements (If Easy Needs Reopening)

### Improvement 1: Shelf availability model v2 (global reliability score)
Problem it targets:
- repeated failed pickups on specific shelf IDs during stagnation windows.

Change:
- Track reliability score per `item_id` and per `item_type`.
- Penalize low-reliability shelves globally, not just temporary cooldown.
- Prefer alternate shelf ids of same type when reliability is low.

Expected impact:
- fewer wasted pickup rounds
- less looping around “cold” shelf IDs

### Improvement 2: Completion lock with explicit subgoals
Problem it targets:
- strategy drifts before finishing active order, reducing +5 completion frequency.

Change:
- Build explicit subgoal chain for active order:
  - `pickup_needed_items` -> `go_dropoff` -> `drop`
- Keep lock until subgoal transitions, not re-deciding every round.
- Force unlock only on detected impossibility or score movement mismatch.

Expected impact:
- more frequent +5 bumps
- better mid/late-game score slope

### Improvement 3: Lag-aware action stabilization (explicit)
Problem it targets:
- oscillatory move patterns suggest possible control-state mismatch.

Change:
- Maintain short action-intent memory (1-2 rounds).
- If bot position does not reflect previous intent yet, avoid immediate opposite-direction replans.
- Prefer “confirm intent” once before switching target.

Expected impact:
- reduced route thrash
- smoother progress inside long stagnation windows

## Suggested Next Iteration Order
1. Keep `assignment_v1` as the live medium baseline until a new control architecture beats `115`.
2. Build and benchmark `warehouse_v1` offline against the medium corpus before spending live tokens.
3. Promote only if the new branch clears staged gates: `>116`, then `>150`, then `>180`, then `>220`.
4. Only reopen easy-specific logic if a shared change regresses the `118` baseline.
