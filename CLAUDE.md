# NM i AI — Grocery Bot

Competition bot for the Norwegian Championship in AI (NM i AI).
Goal: maximize score across 300 ticks by routing bots to pick up and deliver grocery items to the drop-off.

Game server: `wss://game.ainm.no/ws`
Docs/MCP: configured in `mcp.json` → `https://mcp-docs.ainm.no/mcp`

## Score Baselines

| Difficulty | Bots | Best score | Orders | Status |
|------------|------|-----------|--------|--------|
| easy       | 1    | 118       | 14     | repeatable |
| medium     | 3    | 115       | 12     | current benchmark |
| hard       | 5    | 28        | 3      | provisional |
| expert     | 10   | 33        | 3      | provisional |

Update this table after every significant run.

Latest verified easy runs:
- `2026-03-07T15-56-13-035Z-easy-easy` -> score `118`, orders `14`, items `48`
- `2026-03-07T16-00-36-191Z-easy-easy` -> score `118`, orders `14`, items `48`
- Both runs had `0` failed pickups, `0` non-scoring dropoffs, and `0` wasted inventory at game over.

Latest medium runs:
- `2026-03-07T16-03-36-053Z-medium-medium` -> score `52`, orders `5`, items `27` (first medium baseline)
- `2026-03-07T16-14-57-783Z-medium-medium` -> score `109`, orders `11`, items `54`
- `2026-03-07T18-48-23-889Z-medium-medium` -> score `115`, orders `12`, items `55` (current benchmark)

Latest hard run:
- `2026-03-07T19-54-02-292Z-hard-hard` -> score `28`, orders `3`, items `13` (first valid hard baseline, still throughput-limited)

Latest expert runs:
- `2026-03-07T16-52-29-717Z-expert-expert` -> score `33`, orders `3`, items `18` (best current expert reference)
- `2026-03-07T19-21-18-326Z-expert-expert` -> score `11`, orders `1`, items `6`

## Quick Commands

All commands run from **repo root** (`/home/magnus/Git/nm-i-ai`).

```bash
# Play live game (requires token)
node tools/grocery-bot/index.mjs --token $TOKEN --difficulty easy --profile easy

# Summarize a replay (no token needed)
node tools/grocery-bot/index.mjs --mode summarize --difficulty easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Simulate planner changes against a saved replay (no token, fast feedback)
node tools/grocery-bot/index.mjs --mode simulate --difficulty easy --profile easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Tune profile parameters from a replay (--seeds = search width, try 128+)
node tools/grocery-bot/index.mjs --mode tune --difficulty easy --profile easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 128

# Estimate theoretical score ceiling from a replay
node tools/grocery-bot/index.mjs --mode estimate-max \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Benchmark a replay corpus offline (directory or single replay)
node tools/grocery-bot/index.mjs --mode benchmark --difficulty medium \
  --replay tools/grocery-bot/out

# Benchmark the experimental warehouse controller offline
node tools/grocery-bot/index.mjs --mode benchmark --difficulty medium --profile medium_warehouse_v1 \
  --replay tools/grocery-bot/out

# Generate expert oracle script
node tools/grocery-bot/generate-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json

# Run tests
node --test tools/grocery-bot/test/*.test.mjs

# Start the local replay viewer
npm run grocery-bot:viewer
```

## Key File Map

```
tools/grocery-bot/
├── index.mjs                    Entry point, mode dispatch
├── src/
│   ├── planner.mjs              planSingleBot + GroceryPlanner class — read for strategy changes
│   ├── planner-singlebot.mjs    Single-bot evaluation, recovery, cooldowns, oscillation detection
│   ├── planner-singlebot-runtime.mjs Single-bot runtime orchestration and metric/lock handling
│   ├── planner-multibot.mjs     Multi-bot task generation, costs, reservations, action helpers
│   ├── planner-multibot-common.mjs Shared multi-bot demand/zone helpers
│   ├── planner-missions.mjs     Medium mission assignment and mission action resolution
│   ├── planner-warehouse.mjs    Warehouse-control strategy: modes, missions, service bays, queue cells
│   ├── planner-multibot-runtime.mjs Multi-bot runtime execution for mission/task strategies
│   ├── planner-utils.mjs        Shared helpers (demand, phase, congestion, path utils)
│   ├── game-client.mjs          WebSocket loop, replay logging, send guard
│   ├── game-client-sanitizer.mjs Client-side legality sanitizer and nudge logic
│   ├── routing.mjs              Time-aware A* + path reservations (collision avoidance)
│   ├── assignment.mjs           Min-cost bot-to-item matching
│   ├── optimizer.mjs            Profile parameter search (random mutation over replay)
│   ├── replay.mjs               Logging, summarize, simulate, analysis generation
│   ├── replay-io.mjs            Shared replay parsing/layout reconstruction helpers
│   ├── replay-viewer.mjs        Shared run listing/loading for the local replay viewer
│   ├── oracle-script-optimizer.mjs Constraint-based oracle scheduler for scripted expert runs
│   ├── oracle-script-evaluator.mjs Deterministic validator/score estimator for generated scripts
│   ├── oracle-script-io.mjs     Shared oracle/script file loading for CLI + tests
│   ├── world-model.mjs          Demand/inventory helpers
│   ├── coords.mjs               Grid geometry, move encoding
│   ├── grid-graph.mjs           Graph for pathfinding
│   ├── max-score-estimator.mjs  Theoretical score ceiling
│   ├── protocol.mjs             WebSocket message parsing/serialization
│   ├── profile.mjs              Profile loading + merging
│   └── cli.mjs                  Argument parsing
├── config/
│   ├── profiles.json            Tunable parameters per difficulty (source of truth)
│   ├── oracle-expert.json       Known expert orders/items for script generation
│   └── script-expert.json       Generated expert script consumed by `--script`
├── out/
│   ├── <run-id>/
│   │   ├── replay.jsonl         Slim tick-by-tick log (layout entry + diffs) — do not delete
│   │   ├── summary.json         Final score, orders, items
│   │   └── analysis.json        Compact run analysis — READ THIS first before touching code
│   └── tuned-<diff>.json        Output of tune mode (merge back into profiles.json when good)
└── test/                        Node --test unit tests
```

Viewer app:

```
tools/grocery-bot/viewer/
├── server.mjs                   Tiny local API + static server
└── public/
    ├── index.html
    ├── app.js
    └── styles.css
```

## Architecture

**Critical constraint:** The game server receives one unified action payload per tick covering all bots. All coordination is centralized in the planner. Do not attempt to split bot control across separate processes or network calls.

**Single-bot (easy):**
Enumerate candidate pickup-type sequences → score each by (projected delivery points − route cost − leftover-inventory penalty) → execute first step of best candidate. Recovery mode activates on stagnation.

**Multi-bot (medium/hard/expert):**
Each tick: build world context → cost-matrix assignment (each bot → item or drop-off) → time-aware A* with path reservations → deadlock detection (stall counter + forced wait/reroute) → send all actions.

Experimental branch available but not promoted:
- `warehouse_v1` (medium-only for now): warehouse-control modes, stable missions, service-bay reservation, queue cells, preview WIP cap, and endgame cashout rules.
- Convenience profile: `medium_warehouse_v1`
- Keep `assignment_v1` as the live default until `warehouse_v1` beats `115` on real medium runs.

High-bot defaults:
- `hard`, `expert`, and `nightmare` now default to `warehouse_v1`
- reason: the old assignment branch collapses structurally at `5+` bots

Drop zones:
- planner/sanitizer/protocol now support multiple drop zones through `drop_offs`
- route selection uses nearest drop zone when multiple exist

**Key parameters** (`config/profiles.json` + `out/tuned-<diff>.json`):
- `assignment.congestion_penalty` / `contention_penalty` / `urgency_bonus` — shape bot-to-item assignment costs
- `routing.horizon` — lookahead depth for time-aware A*
- `anti_deadlock.stall_threshold` / `forced_wait_rounds` — deadlock recovery aggressiveness
- `recovery.*` — stagnation detection thresholds

## Development Workflow

For each improvement iteration:
1. Read `out/<run-id>/analysis.json` — compact score/pickup/stall summary, fast to read
2. Use the **replay-analyzer** subagent (`.claude/agents/replay-analyzer.md`) for deep replay digs
3. Read the relevant planner file (not all of planner.mjs — pick the right module):
   - Strategy changes → `planner.mjs` (planSingleBot + GroceryPlanner)
   - Recovery/cooldown bugs → `planner-singlebot.mjs`
   - Multi-bot routing/assignment → `planner-multibot.mjs`
4. Make the targeted change
5. Run tests: `node --test tools/grocery-bot/test/*.test.mjs`
6. Simulate offline: `--mode simulate` against the latest replay (measures action agreement, not score)
7. Benchmark replay corpus when changing multi-bot control flow: `--mode benchmark --difficulty medium --replay tools/grocery-bot/out`
8. If change looks good → play live to confirm actual score
9. If score improves → run `--mode tune` against the new replay and merge params

Oracle/script workflow for expert:
1. Extract/update oracle data: `node tools/grocery-bot/tmp-extract-oracle.mjs`
2. Generate script: `node tools/grocery-bot/generate-script.mjs --oracle ... --replay ... --out tools/grocery-bot/config/script-expert.json`
3. Inspect metadata in `tools/grocery-bot/config/script-expert.json`
4. Use the replay viewer to inspect handoff assumptions and drop-off queueing
5. Play live with both flags: `--script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json`
6. Update the oracle after the run

## Structural Policy

- Prefer separation of concerns over adding more logic to an already-large file.
- `300+` lines means stop and ask whether the change belongs in a narrower module.
- `500+` lines requires one of:
  - shrink the file in the same change, or
  - record a concrete split plan in `tools/grocery-bot/STRUCTURE_REVIEW.md`
- Use behavior-based module boundaries:
  - planner shell/state orchestration
  - single-bot evaluation/recovery
  - multi-bot mission/assignment policy
  - multi-bot routing/action resolution
  - shared planner utilities
  - replay/analysis reporting
  - client protocol/sanitization

Current structure map and file-size exceptions live in `tools/grocery-bot/STRUCTURE_REVIEW.md`.

## Specs And Experiments

- No feature is complete without specs for the intended behavior.
- Every experiment must add:
  - at least one targeted spec for the changed behavior
  - a regression spec for the motivating failure mode when relevant
  - replay/analysis specs when new metrics are introduced
  - an entry in `tools/grocery-bot/EXPERIMENT_LOG.md`
- For replay-driven strategy work, update tests before spending more live tokens unless the behavior is already covered by existing specs.

## Active Improvement Backlog

Full analysis in `tools/grocery-bot/STRATEGY_REVIEW.md`. Priority order:

1. **Freeze easy winner** — treat the current `118` build as the baseline until medium work proves a better shared change
2. **Push medium into the 200s** — current benchmark is `115`, which is a stable baseline but not the architectural ceiling
3. **Prove or reject `warehouse_v1` offline first** — use benchmark mode, replay metrics, and specs before live tokens
4. **Reduce multi-bot stall cascades** — focus on released-work control, service-bay queueing, and order-close cadence
5. **Tune expert on warehouse_v1** — use the replay viewer plus corpus benchmark before spending more expert tokens

## Conventions

- All source files are `.mjs` (ESM), no transpilation, no build step
- No external npm dependencies — pure Node.js stdlib + native WebSocket
- Use `node --test` for tests, not jest/vitest
- Profiles are plain JSON — tuned outputs live in `out/`, merge manually into `config/profiles.json` after validation
- Never delete replay files — they are training data for the offline optimizer
- Keep `STRATEGY_REVIEW.md` updated with findings after each significant run
