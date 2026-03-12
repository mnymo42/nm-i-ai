# NM i AI — Grocery Bot

Competition bot for the Norwegian Championship in AI (NM i AI).
Goal: maximize score across 300 ticks by routing bots to pick up and deliver grocery items to the drop-off.

Game server: `wss://game.ainm.no/ws`
Docs: fetch on demand via `WebFetch https://mcp-docs.ainm.no/mcp` (no MCP server loaded — saves tokens)

## Score Baselines

Daily caveat: orders and shelf item types rotate at midnight UTC. Previous-day scores are historical references only.

| Difficulty | Bots | Best | Orders | Status |
|------------|------|------|--------|--------|
| easy       | 1    | 118  | 14     | historical |
| medium     | 3    | 115  | 12     | historical |
| hard       | 5    | 28   | 3      | historical |
| expert     | 10   | 89   | 9      | current UTC-day baseline |

Update after every significant run. Best run IDs in `out/` summary files.

## Quick Reference

All commands run from repo root (`/home/magnus/Git/nm-i-ai`). Entry point: `node tools/grocery-bot/index.mjs`.

Key modes: `--mode runs`, `--mode analyze`, `--mode simulate`, `--mode benchmark`, `--mode tune`, `--mode script-info`, `--mode estimate-max`.

Tests: `node --test tools/grocery-bot/test/*.test.mjs` | Viewer: `npm run grocery-bot:viewer`

Oracle/script workflow: use the **oracle-workflow** agent (`.claude/agents/oracle-workflow.md`).

## Key File Map

```
tools/grocery-bot/src/
  planner/                 Strategy + execution
    planner.mjs              GroceryPlanner orchestrator
    planner-singlebot.mjs    Single-bot evaluation, recovery, cooldowns
    planner-multibot.mjs     Multi-bot tasks, costs, reservations
    planner-multibot-runtime.mjs  Multi-bot runtime execution
    planner-warehouse.mjs    Warehouse-control (experimental, behind flag)
    planner-utils.mjs        Shared helpers (demand, phase, congestion)
  oracle/                  Offline oracle/script pipeline
    oracle-script-optimizer.mjs  Constraint-based script scheduler
    oracle-script-search.mjs     Batch generation + promotion
    oracle-script-evaluator.mjs  Script validation + scoring
  client/                  WebSocket + protocol
    game-client.mjs          WebSocket loop, replay logging
    game-client-sanitizer.mjs  Action legality sanitizer
  routing/                 Pathfinding
    routing.mjs              Time-aware A* + path reservations
    assignment.mjs           Min-cost bot-to-item matching
  replay/                  Replay tooling
    replay.mjs               Logging, summarize, simulate, analysis
  utils/                   Shared utilities
    coords.mjs, drop-zones.mjs, grid-graph.mjs, profile.mjs, ...
  config/
    profiles.json            Tunable parameters per difficulty
    oracle-expert.json       Known expert orders/items
    script-expert.json       Generated expert script
```

## Architecture

**Critical constraint:** One unified action payload per tick covering all bots. All coordination is centralized in the planner.

**Single-bot (easy):** Enumerate candidate pickup-type sequences → score by (delivery points − route cost − leftover penalty) → execute best. Recovery on stagnation.

**Multi-bot (medium/hard/expert):** Build world context → cost-matrix assignment → time-aware A* with path reservations → deadlock detection → send all actions.

- `assignment_v1` is the **live default** for all difficulties except nightmare
- `warehouse_v1` is **experimental** — behind `runtime.multi_bot_strategy` flag, not promoted until it beats 115 on medium. Do not modify without explicit request.

**Key parameters** (`config/profiles.json`): `assignment.congestion_penalty` / `contention_penalty` / `urgency_bonus`, `routing.horizon`, `anti_deadlock.stall_threshold` / `forced_wait_rounds`, `recovery.*`

## Development Workflow

1. Read `out/<run-id>/analysis.json` first
2. Use **replay-analyzer** agent for deep digs
3. Use supported commands: `--mode runs`, `--mode analyze`, `--mode script-info`
4. Read the relevant planner module (not all of planner.mjs)
5. Make targeted change → run tests → simulate offline → play live → tune if improved

Run provenance: every live run records commit, dirty state, profile/oracle/script hashes in `summary.json`.

## Policies

- **Structural:** 300+ lines → ask if change belongs elsewhere. 500+ → shrink or record in `STRUCTURE_REVIEW.md`
- **Experiments:** every experiment needs specs + entry in `EXPERIMENT_LOG.md`
- **Conventions:** `.mjs` ESM, no npm deps, `node --test`, never delete replays

## Active Backlog

Full analysis in `tools/grocery-bot/STRATEGY_REVIEW.md`. Resume from `tools/grocery-bot/NEXT_SESSION_PROMPT.md`.
