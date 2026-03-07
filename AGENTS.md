# NM i AI — Codex Agent Notes

Use this file together with [CLAUDE.md](/home/magnus/prog/nm-i-ai/CLAUDE.md) when starting a new Codex session in this repo.

## Startup Context

- Read `CLAUDE.md` first for project architecture, workflow, and command reference.
- Read `.claude/settings.json` for Claude-side permissions and hooks that may matter when mirroring the same workflow in Codex.
- Read `.claude/agents/replay-analyzer.md` before deep replay work.
- Read `mcp.json` for repo-declared MCP servers.

## Grocery Bot Workflow

1. Read `tools/grocery-bot/out/<run-id>/analysis.json` before touching planner code.
2. Use targeted `node -e` scripts or summarize/simulate modes instead of manually reading full replay logs.
3. Make the smallest planner change that matches replay evidence.
4. Run `node --test tools/grocery-bot/test/*.test.mjs`.
5. Prefer simulate -> analyze -> change cycles over blind live runs.
6. For multi-bot strategy work, run `--mode benchmark --difficulty medium --replay tools/grocery-bot/out` before spending more live tokens.
7. Use `--profile medium_warehouse_v1` when benchmarking the experimental warehouse-control branch.
8. For expert oracle/script work, use: extract oracle -> generate script -> inspect/evaluate script -> live run with `--script` + `--oracle` -> update oracle.
9. Use the replay viewer to inspect scripted/live handoff and drop-off queue behavior before changing the oracle scheduler again.

## Structural Policy

- Prefer separation of concerns over adding more logic to an already-large file.
- `300+` lines: stop and check whether the change should go in a narrower module instead.
- `500+` lines: either shrink the file in the same change or record a concrete follow-up split in `tools/grocery-bot/STRUCTURE_REVIEW.md`.
- Treat `tools/grocery-bot/STRUCTURE_REVIEW.md` as the current decomposition map for planner/client/test hotspots.
- Default module boundaries for grocery bot work:
  - planner shell/state orchestration
  - single-bot evaluation/recovery
  - multi-bot mission/assignment policy
  - multi-bot routing/action resolution
  - shared planner utilities
  - replay/analysis reporting
  - client protocol/sanitization

## Specs And Experiments

- Every feature must ship with specs for the intended behavior.
- Every experiment must add:
  - at least one targeted spec for the changed behavior
  - a regression spec for the motivating failure mode when applicable
  - replay/analysis specs if new planner metrics or replay metrics are introduced
  - an `EXPERIMENT_LOG.md` entry with hypothesis, change, validation, and verdict
- Do not spend more live tokens on replay-driven strategy changes until the changed behavior is covered by specs or an explicit existing spec is identified.

## Key Files

- Strategy orchestration: `tools/grocery-bot/src/planner.mjs`
- Single-bot recovery and cooldowns: `tools/grocery-bot/src/planner-singlebot.mjs`
- Single-bot runtime orchestration: `tools/grocery-bot/src/planner-singlebot-runtime.mjs`
- Multi-bot task generation and reservations: `tools/grocery-bot/src/planner-multibot.mjs`
- Medium mission policy: `tools/grocery-bot/src/planner-missions.mjs`
- Warehouse-control policy: `tools/grocery-bot/src/planner-warehouse.mjs`
- Multi-bot runtime execution: `tools/grocery-bot/src/planner-multibot-runtime.mjs`
- Client legality sanitizer: `tools/grocery-bot/src/game-client-sanitizer.mjs`
- Shared helpers: `tools/grocery-bot/src/planner-utils.mjs`
- Replay and summaries: `tools/grocery-bot/src/replay.mjs`
- Replay parsing/layout helpers: `tools/grocery-bot/src/replay-io.mjs`
- Structure map and split backlog: `tools/grocery-bot/STRUCTURE_REVIEW.md`
- Oracle/script optimizer: `tools/grocery-bot/generate-script.mjs`
- Heavy oracle optimizer: `tools/grocery-bot/optimize-oracle-script.mjs`
- Oracle/script modules: `tools/grocery-bot/src/oracle-script-optimizer.mjs`, `tools/grocery-bot/src/oracle-script-evaluator.mjs`, `tools/grocery-bot/src/oracle-script-io.mjs`, `tools/grocery-bot/src/oracle-script-search.mjs`, `tools/grocery-bot/src/oracle-script-legacy.mjs`

## MCP

- Repo-declared MCP: `grocery-bot` from `mcp.json`
- Codex global MCP should also contain `grocery-bot`

## Session Prompt

Recommended startup prompt:

`Initialize from AGENTS.md, CLAUDE.md, .claude/settings.json, .claude/agents/replay-analyzer.md, and mcp.json before doing any work.`
