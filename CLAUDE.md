# NM i AI — Grocery Bot

Competition bot for the Norwegian Championship in AI (NM i AI).
Goal: maximize score across 300 ticks by routing bots to pick up and deliver grocery items to the drop-off.

Game server: `wss://game.ainm.no/ws`
Docs/MCP: configured in `mcp.json` → `https://mcp-docs.ainm.no/mcp`

## Score Baselines

Daily caveat:
- Orders and shelf item types rotate at midnight UTC.
- Scores from a previous UTC day are historical references, not current-day oracle/script inputs.

| Difficulty | Bots | Best score | Orders | Status |
|------------|------|-----------|--------|--------|
| easy       | 1    | 118       | 14     | historical reference |
| medium     | 3    | 115       | 12     | historical reference |
| hard       | 5    | 28        | 3      | historical reference |
| expert     | 10   | 89        | 9      | current UTC-day baseline |

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
- Current UTC-day baseline:
  - `2026-03-08T10-50-21-635Z-expert-expert` -> score `89`, orders `9`, items `44`
  - key changes: preview picker cap, drop-off priority boost, aisle-based parking slots
- Supporting current-day runs:
  - `2026-03-08T10-34-25-486Z-expert-expert` -> score `38`, orders `4`, items `18`
  - `2026-03-08T10-39-20-479Z-expert-expert` -> score `38`, orders `4`, items `18`
- Historical references:
  - `2026-03-07T16-52-29-717Z-expert-expert` -> score `33`, orders `3`, items `18`
  - `2026-03-08T00-03-58-975Z-expert-expert` -> score `13`, orders `1`, items `8`

## Quick Commands

All commands run from **repo root** (`/home/magnus/Git/nm-i-ai`).

```bash
# Play live game (requires token)
node tools/grocery-bot/index.mjs --token $TOKEN --difficulty easy --profile easy

# Summarize a replay (no token needed)
node tools/grocery-bot/index.mjs --mode summarize --difficulty easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# List recent runs without opening files manually
node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5

# Read compact run analysis from a run directory or replay path
node tools/grocery-bot/index.mjs --mode analyze \
  --replay tools/grocery-bot/out/<run-id>

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

# Inspect script/oracle metadata without `node -e`
node tools/grocery-bot/index.mjs --mode script-info \
  --script tools/grocery-bot/config/script-expert.json \
  --oracle tools/grocery-bot/config/oracle-expert.json

# Extract a fresh expert oracle from current-day replays
node tools/grocery-bot/extract-oracle.mjs \
  --difficulty expert \
  --profile expert \
  --out tools/grocery-bot/config/oracle-expert.json

# Generate expert oracle script
node tools/grocery-bot/generate-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json

# Run the heavy oracle optimizer (preferred before expert scripted runs)
node tools/grocery-bot/optimize-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert.json \
  --out-report tools/grocery-bot/out/oracle-script-optimizer-report.json \
  --objective handoff_first \
  --iterations 1000 \
  --score-to-beat 91 \
  --ticks-to-beat 292

# Compress a proven replay prefix backward
node tools/grocery-bot/compress-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert.json \
  --out-report tools/grocery-bot/out/oracle-script-compression-report.json

# Diff a replay transition when validating replay-derived scripts
node tools/grocery-bot/diff-replay-transition.mjs \
  --source-replay tools/grocery-bot/out/<source-run>/replay.jsonl \
  --validation-replay tools/grocery-bot/out/<validation-run>/replay.jsonl \
  --tick 51

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
- `hard` and `expert` default to `assignment_v1` (the code defaults, despite earlier intent to switch)
- only `nightmare` defaults to `warehouse_v1`
- explicit `_warehouse_v1` profile variants exist for all difficulties
- reason: `warehouse_v1` was intended for `5+` bots but never promoted as the default for hard/expert

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
3. Prefer supported inspection commands over `node -e`:
   - `node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5`
   - `node tools/grocery-bot/index.mjs --mode analyze --replay tools/grocery-bot/out/<run-id>`
   - `node tools/grocery-bot/index.mjs --mode script-info --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json`
   - use the replay viewer for tick-level inspection
4. Read the relevant planner file (not all of planner.mjs — pick the right module):
   - Strategy changes → `planner.mjs` (planSingleBot + GroceryPlanner)
   - Recovery/cooldown bugs → `planner-singlebot.mjs`
   - Multi-bot routing/assignment → `planner-multibot.mjs`
5. Make the targeted change
6. Run tests: `node --test tools/grocery-bot/test/*.test.mjs`
7. Simulate offline: `--mode simulate` against the latest replay (measures action agreement, not score)
8. Benchmark replay corpus when changing multi-bot control flow: `--mode benchmark --difficulty medium --replay tools/grocery-bot/out`
9. If change looks good → play live to confirm actual score
10. If score improves → run `--mode tune` against the new replay and merge params

Oracle/script workflow for expert:
1. After UTC rollover, treat old `oracle-expert.json` and `script-expert.json` as stale until rebuilt from the new day.
2. Extract/update oracle data: `node tools/grocery-bot/extract-oracle.mjs --difficulty expert --profile expert --out tools/grocery-bot/config/oracle-expert.json`
3. Generate or optimize script:
   - quick pass: `node tools/grocery-bot/generate-script.mjs --oracle ... --replay ... --out tools/grocery-bot/config/script-expert.json`
   - real offline pass: `node tools/grocery-bot/optimize-oracle-script.mjs --oracle ... --replay ... --out-script tools/grocery-bot/config/script-expert.json --out-report tools/grocery-bot/out/oracle-script-optimizer-report.json --objective handoff_first --iterations 1000 --score-to-beat 91 --ticks-to-beat 292`
   - replay-tightening pass: `node tools/grocery-bot/compress-oracle-script.mjs --oracle ... --replay ... --out-script tools/grocery-bot/config/script-expert.json --out-report tools/grocery-bot/out/oracle-script-compression-report.json`
4. Inspect metadata with `node tools/grocery-bot/index.mjs --mode script-info --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json`
5. Use the replay viewer to inspect handoff assumptions and drop-off queueing
6. For replay-derived scripts, use `diff-replay-transition.mjs` to locate the first drift before trusting a longer replay prefix
7. Play live with both flags: `--script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json`
8. Update the oracle after the run

Recommended expert iteration loop:
1. Play a normal live expert run with the best current planner baseline.
2. Use `--mode runs` and `--mode analyze` to select the best replay candidate.
3. Rebuild the same-day oracle if needed.
4. Run `compress-oracle-script.mjs` on the chosen replay to preserve the proven score with the shortest safe prefix.
5. Inspect the compressed result with `--mode script-info`.
6. If there is any sign of drift, validate the handoff with `diff-replay-transition.mjs`.
7. Play live with `--script` + `--oracle`, replay the prefix exactly, then let the live planner take over after `last_scripted_tick`.
8. Keep the run only if total score or handoff quality improves, then repeat from that new best replay.

Run provenance:
- Every live run now records commit, dirty state, profile hash, and oracle/script hashes in `summary.json`.
- A matching `run_meta` event is also written into `replay.jsonl`.
- Use this to revert to a known-good model state with `git checkout <commit>` plus the recorded profile/script/oracle inputs.

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
2. **Push expert past 89 first** — current same-day baseline is healthy enough to support hybrid/oracle work
3. **Keep `assignment_v1` as the active expert path** — `warehouse_v1` remains archived/experimental for offline medium work
4. **Use supported inspection commands** — `runs`, `analyze`, `script-info`, and the viewer replace routine `node -e` inspection
5. **Rebuild same-day oracle/script on top of the 89-point baseline** — do not reuse previous-day oracle/script assets without rebuild

## Next Session

Resume from `tools/grocery-bot/NEXT_SESSION_PROMPT.md`.

## Conventions

- All source files are `.mjs` (ESM), no transpilation, no build step
- No external npm dependencies — pure Node.js stdlib + native WebSocket
- Use `node --test` for tests, not jest/vitest
- Profiles are plain JSON — tuned outputs live in `out/`, merge manually into `config/profiles.json` after validation
- Never delete replay files — they are training data for the offline optimizer
- Keep `STRATEGY_REVIEW.md` updated with findings after each significant run
