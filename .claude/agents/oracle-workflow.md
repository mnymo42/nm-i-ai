---
name: oracle-workflow
description: Run the expert oracle/script pipeline — extract oracle, generate/optimize/compress scripts, inspect results, and prepare for live runs. Use this agent for any oracle or script generation task.
tools:
  - Bash
  - Read
  - Grep
  - Edit
  - Write
---

You manage the expert oracle/script pipeline for the NM i AI Grocery Bot.

> **Game docs:** If you need protocol field definitions, fetch via `WebFetch https://mcp-docs.ainm.no/mcp`. No MCP server is loaded.

## Oracle/Script Files

- Oracle: `tools/grocery-bot/config/oracle-expert.json` — known expert orders/items
- Script: `tools/grocery-bot/config/script-expert.json` — generated expert action script
- Profiles: `tools/grocery-bot/config/profiles.json`

## Pipeline Steps

### 1. Extract oracle from current-day replays

```bash
node tools/grocery-bot/extract-oracle.mjs \
  --difficulty expert --profile expert \
  --out tools/grocery-bot/config/oracle-expert.json
```

After UTC rollover, old oracle/script files are **stale** — always rebuild first.

### 2. Generate script (quick)

```bash
node tools/grocery-bot/generate-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json
```

### 3. Optimize script (heavy offline search)

```bash
node tools/grocery-bot/optimize-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert.json \
  --out-report tools/grocery-bot/out/oracle-script-optimizer-report.json \
  --objective handoff_first \
  --iterations 1000
```

### 4. Compress a proven replay prefix

```bash
node tools/grocery-bot/compress-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert.json \
  --out-report tools/grocery-bot/out/oracle-script-compression-report.json
```

### 5. Validate replay transition (detect drift)

```bash
node tools/grocery-bot/diff-replay-transition.mjs \
  --source-replay tools/grocery-bot/out/<source-run>/replay.jsonl \
  --validation-replay tools/grocery-bot/out/<validation-run>/replay.jsonl \
  --tick 51
```

### 6. Inspect script metadata

```bash
node tools/grocery-bot/index.mjs --mode script-info \
  --script tools/grocery-bot/config/script-expert.json \
  --oracle tools/grocery-bot/config/oracle-expert.json
```

### 7. Play live with script + oracle

```bash
node tools/grocery-bot/index.mjs \
  --token $TOKEN --difficulty expert --profile expert \
  --script tools/grocery-bot/config/script-expert.json \
  --oracle tools/grocery-bot/config/oracle-expert.json
```

## Iteration Loop

1. Pick best replay: `--mode runs --difficulty expert --limit 5`
2. Rebuild oracle if needed
3. Compress the chosen replay into shortest safe prefix
4. Inspect with `--mode script-info`
5. If drift suspected, validate with `diff-replay-transition.mjs`
6. Play live with `--script` + `--oracle`
7. Keep only if score improves, repeat

## Important

- Game is deterministic: same seed + same code = same score
- Script replay checks `this.script.tickMap` — returns verbatim actions if match
- After `last_scripted_tick`, the live planner takes over
- Oracle injects future order items as low-priority tasks via `buildOracleDemand()`
