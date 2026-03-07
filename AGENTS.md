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

## Key Files

- Strategy orchestration: `tools/grocery-bot/src/planner.mjs`
- Single-bot recovery and cooldowns: `tools/grocery-bot/src/planner-singlebot.mjs`
- Multi-bot routing: `tools/grocery-bot/src/planner-multibot.mjs`
- Shared helpers: `tools/grocery-bot/src/planner-utils.mjs`
- Replay and summaries: `tools/grocery-bot/src/replay.mjs`

## MCP

- Repo-declared MCP: `grocery-bot` from `mcp.json`
- Codex global MCP should also contain `grocery-bot`

## Session Prompt

Recommended startup prompt:

`Initialize from AGENTS.md, CLAUDE.md, .claude/settings.json, .claude/agents/replay-analyzer.md, and mcp.json before doing any work.`
