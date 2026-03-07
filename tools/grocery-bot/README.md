# Grocery Bot (NM i AI)

Node.js bot for the NM i AI Grocery Bot warm-up challenge.

## Quick Start

```bash
node tools/grocery-bot/index.mjs --token <TOKEN-OR-WS-URL> --difficulty <easy|medium|hard|expert|nightmare> --profile <profile-name>
```

Equivalent npm script:

```bash
npm run grocery-bot -- --token 'wss://game.ainm.no/ws?token=...' --profile expert
```

## Modes

### 1) Play live game

```bash
node tools/grocery-bot/index.mjs --token 'wss://game.ainm.no/ws?token=...' --profile hard
```

`play` mode now accepts the full websocket URL directly and infers difficulty from the JWT token unless `--difficulty` is explicitly provided.

Artifacts are written to:

- `tools/grocery-bot/out/<run-id>/replay.jsonl` — slim tick-by-tick log
- `tools/grocery-bot/out/<run-id>/summary.json` — final score, orders, items
- `tools/grocery-bot/out/<run-id>/analysis.json` — compact run analysis (read this first)

### 2) Summarize replay

```bash
node tools/grocery-bot/index.mjs --mode summarize --difficulty hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

### 3) Simulate planner against observed replay

```bash
node tools/grocery-bot/index.mjs --mode simulate --difficulty hard --profile hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

Output is `matchRatio` (action agreement with past run) and `waitRatio`. Note: this measures agreement with past actions, not actual score improvement — use live play to confirm score impact.

### 4) Tune profile from replay

```bash
node tools/grocery-bot/index.mjs --mode tune --difficulty hard --profile hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 64
```

Output is written to `tools/grocery-bot/out/tuned-<difficulty>.json`.

### 5) Benchmark a replay corpus

```bash
node tools/grocery-bot/index.mjs --mode benchmark --difficulty expert --replay tools/grocery-bot/out
```

Useful for comparing expert/hard behavior against the current corpus before spending live tokens.

### 6) Estimate score ceiling from replay

```bash
node tools/grocery-bot/index.mjs --mode estimate-max --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

This prints:
- `queueBound`: conservative bound using observed active-order sequence
- `optimisticOrderMixUpperBound`: optimistic ceiling from best observed order efficiencies

### 7) Generate expert oracle script

```bash
node tools/grocery-bot/generate-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json
```

The generated script includes:
- `orders_covered`
- `estimated_score`
- `last_scripted_tick`
- `cutoff_reason`
- `per_order_estimates`
- `aggregate_efficiency`

## Replay Viewer

Start the local replay viewer:

```bash
npm run grocery-bot:viewer
```

By default it serves `http://127.0.0.1:4173` and reads runs from `tools/grocery-bot/out`.

Viewer v1 supports:
- browsing existing runs by difficulty/profile
- replaying runs tick by tick
- grid rendering for walls, bots, items, and drop zones
- per-tick actions, orders, inventories, and planner metrics
- quick jumps to score changes, failed pickups, sanitizer overrides, control-mode changes, and stagnation starts

Use it for diagnosis before tuning:
- inspect long wait/stall windows
- inspect queue-service-bay pileups
- inspect held deliverable inventory that is not getting cashed out
- inspect warehouse control-mode oscillation

## Strategy Summary

- Centralized multi-bot assignment each round via minimum-cost matching
- Time-aware A* routing with path reservations for collision avoidance
- Deadlock mitigation with stall tracking + forced wait/reroute
- Map-specific profile tuning (`easy`, `medium`, `hard`, `expert`)
- Replay logging for offline simulation and parameter search

## Tests

```bash
npm run grocery-bot:test
```

Recommended expert workflow:

```bash
node tools/grocery-bot/tmp-extract-oracle.mjs
node tools/grocery-bot/generate-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl --out tools/grocery-bot/config/script-expert.json
node -e "const d=require('fs').readFileSync('tools/grocery-bot/config/script-expert.json','utf8'); console.log(d)"
node tools/grocery-bot/index.mjs --mode benchmark --difficulty expert --replay tools/grocery-bot/out
node tools/grocery-bot/index.mjs --mode simulate --difficulty expert --profile expert --replay tools/grocery-bot/out/<run-id>/replay.jsonl
node tools/grocery-bot/index.mjs --mode tune --difficulty expert --profile expert --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 64
node tools/grocery-bot/index.mjs --token 'wss://game.ainm.no/ws?token=...' --profile expert --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json
```
