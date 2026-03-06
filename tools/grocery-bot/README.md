# Grocery Bot (NM i AI)

Node.js bot for the NM i AI Grocery Bot warm-up challenge.

## Quick Start

```bash
node tools/grocery-bot/index.mjs --token <TOKEN> --difficulty <easy|medium|hard|expert> --profile <profile-name>
```

Equivalent npm script:

```bash
npm run grocery-bot -- --token <TOKEN> --difficulty expert --profile expert
```

## Modes

### 1) Play live game

```bash
node tools/grocery-bot/index.mjs --token <TOKEN> --difficulty hard --profile hard
```

Artifacts are written to:

- `tools/grocery-bot/out/<run-id>/replay.jsonl`
- `tools/grocery-bot/out/<run-id>/summary.json`

### 2) Summarize replay

```bash
node tools/grocery-bot/index.mjs --mode summarize --difficulty hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

### 3) Simulate planner against observed replay

```bash
node tools/grocery-bot/index.mjs --mode simulate --difficulty hard --profile hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

### 4) Tune profile from replay

```bash
node tools/grocery-bot/index.mjs --mode tune --difficulty hard --profile hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 64
```

Output is written to `tools/grocery-bot/out/tuned-<difficulty>.json`.

### 5) Estimate score ceiling from replay

```bash
node tools/grocery-bot/index.mjs --mode estimate-max --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

This prints:
- `queueBound`: conservative bound using observed active-order sequence
- `optimisticOrderMixUpperBound`: optimistic ceiling from best observed order efficiencies

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
