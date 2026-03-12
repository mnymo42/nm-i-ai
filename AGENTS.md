# NM i AI — Codex Agent Notes

Use this file together with [CLAUDE.md](/home/magnus/prog/nm-i-ai/CLAUDE.md) when starting a new Codex session in this repo.

## Startup Context

- Read `CLAUDE.md` first for project architecture, workflow, and command reference.
- Read `.claude/settings.json` for Claude-side permissions and hooks that may matter when mirroring the same workflow in Codex.
- Read `.claude/agents/replay-analyzer.md` before deep replay work.
- Read `mcp.json` for repo-declared MCP servers.

## Grocery Bot Workflow

1. Read `tools/grocery-bot/out/<run-id>/analysis.json` before touching planner code.
2. Treat user-provided live game tokens as single-use unless the user explicitly says otherwise.
3. Wait for the user to provide or re-provide the token before each live run; do not assume an old token is still valid.
2. Use supported workflow commands before ad hoc scripts:
   - `node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5`
   - `node tools/grocery-bot/index.mjs --mode analyze --replay tools/grocery-bot/out/<run-id>`
   - `node tools/grocery-bot/index.mjs --mode script-info --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json`
   - use the replay viewer before writing new one-off inspectors
4. Make the smallest planner change that matches replay evidence.
5. Run `node --test tools/grocery-bot/test/*.test.mjs`.
6. Prefer simulate -> analyze -> change cycles over blind live runs.
7. For multi-bot strategy work, run `--mode benchmark --difficulty medium --replay tools/grocery-bot/out` before spending more live tokens.
8. Use `--profile medium_warehouse_v1` when benchmarking the experimental warehouse-control branch.
9. For expert oracle/script work, use: extract oracle -> generate script -> inspect/evaluate script -> live run with `--script` + `--oracle` -> update oracle.
10. After UTC rollover, treat old `oracle-expert.json` and `script-expert.json` as stale until rebuilt from the new day.
11. Use the replay viewer plus `diff-replay-transition.mjs` to inspect scripted/live handoff and first replay drift before changing the oracle scheduler again.
12. Read `tools/grocery-bot/NEXT_SESSION_PROMPT.md` at startup when resuming strategy work after a break.

Expert iteration loop:
1. Play a normal live expert run with the best current planner baseline.
2. Pick the best replay with `--mode runs` and `--mode analyze`.
3. Rebuild the same-day oracle if needed with `extract-oracle.mjs`.
4. Run `compress-oracle-script.mjs` on the chosen replay to keep the proven score with the shortest safe prefix.
5. Inspect the result with `--mode script-info`.
6. If replay fidelity is uncertain, validate the handoff with `diff-replay-transition.mjs`.
7. Play live with `--script` + `--oracle`, replay the prefix exactly, and let the live planner take over after `last_scripted_tick`.
8. Keep the new run only if total score or handoff quality improves, then repeat from that new best run.

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
- Oracle extraction: `tools/grocery-bot/extract-oracle.mjs`
- Heavy oracle optimizer: `tools/grocery-bot/optimize-oracle-script.mjs`
- Replay compression optimizer: `tools/grocery-bot/compress-oracle-script.mjs`
- Replay drift debugger: `tools/grocery-bot/diff-replay-transition.mjs`
- Oracle/script modules: `tools/grocery-bot/src/oracle-script-optimizer.mjs`, `tools/grocery-bot/src/oracle-script-evaluator.mjs`, `tools/grocery-bot/src/oracle-script-io.mjs`, `tools/grocery-bot/src/oracle-script-search.mjs`, `tools/grocery-bot/src/oracle-script-legacy.mjs`, `tools/grocery-bot/src/oracle-script-compressor.mjs`
- Run provenance: `tools/grocery-bot/src/run-provenance.mjs`

## MCP

- Repo-declared MCP: `grocery-bot` from `mcp.json`
- Codex global MCP should also contain `grocery-bot`

## Session Prompt

Recommended startup prompt:

`Initialize from AGENTS.md, CLAUDE.md, .claude/settings.json, .claude/agents/replay-analyzer.md, and mcp.json before doing any work.`
