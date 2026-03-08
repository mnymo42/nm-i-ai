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

Live run provenance is also recorded:
- `summary.json` includes commit, dirty state, profile hash, and oracle/script hashes
- `replay.jsonl` includes a `run_meta` record for the same inputs

### 2) Summarize replay

```bash
node tools/grocery-bot/index.mjs --mode summarize --difficulty hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

### 3) List recent runs

```bash
node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5
```

Use this instead of opening `tools/grocery-bot/out` manually when you just need recent score/order/item/stall summaries.

### 4) Analyze a run or replay path

```bash
node tools/grocery-bot/index.mjs --mode analyze --replay tools/grocery-bot/out/<run-id>
```

This prints compact summary and analysis fields without reading JSON by hand.

### 5) Simulate planner against observed replay

```bash
node tools/grocery-bot/index.mjs --mode simulate --difficulty hard --profile hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

Output is `matchRatio` (action agreement with past run) and `waitRatio`. Note: this measures agreement with past actions, not actual score improvement — use live play to confirm score impact.

### 6) Tune profile from replay

```bash
node tools/grocery-bot/index.mjs --mode tune --difficulty hard --profile hard --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 64
```

Output is written to `tools/grocery-bot/out/tuned-<difficulty>.json`.

### 7) Benchmark a replay corpus

```bash
node tools/grocery-bot/index.mjs --mode benchmark --difficulty expert --replay tools/grocery-bot/out
```

Useful for comparing expert/hard behavior against the current corpus before spending live tokens.

### 8) Estimate score ceiling from replay

```bash
node tools/grocery-bot/index.mjs --mode estimate-max --replay tools/grocery-bot/out/<run-id>/replay.jsonl
```

This prints:
- `queueBound`: conservative bound using observed active-order sequence
- `optimisticOrderMixUpperBound`: optimistic ceiling from best observed order efficiencies

### 9) Inspect script/oracle metadata

```bash
node tools/grocery-bot/index.mjs --mode script-info \
  --script tools/grocery-bot/config/script-expert.json \
  --oracle tools/grocery-bot/config/oracle-expert.json
```

Use this instead of `node -e` when validating hybrid inputs.

### 10) Extract the expert oracle from current-day runs

```bash
node tools/grocery-bot/extract-oracle.mjs \
  --difficulty expert \
  --profile expert \
  --out tools/grocery-bot/config/oracle-expert.json
```

This is the supported replacement for the old `tmp-extract-oracle.mjs` helper.

### 11) Generate expert oracle script

```bash
node tools/grocery-bot/generate-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json
```

Optional:

```bash
node tools/grocery-bot/generate-script.mjs \
  --strategy legacy \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json
```

If `--strategy` is omitted, the generator now searches both the validated modular optimizer and the recovered legacy throughput path, then writes the best locally-evaluated script.

The generated script includes:
- `orders_covered`
- `estimated_score`
- `last_scripted_tick`
- `cutoff_reason`
- `per_order_estimates`
- `aggregate_efficiency`
- `search.top_candidates`

### 12) Sweep oracle script candidates locally

```bash
node tools/grocery-bot/tune-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/out/oracle-script-sweep.json
```

Use this before live expert pushes. It ranks locally-generated candidates so we can spend tokens only on the strongest script.

### 13) Run a heavy oracle optimization pass

```bash
node tools/grocery-bot/optimize-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert.json \
  --out-report tools/grocery-bot/out/oracle-script-optimizer-report.json \
  --objective handoff_first \
  --iterations 1000 \
  --score-to-beat 91 \
  --ticks-to-beat 292
```

This is the intended offline brute-force entrypoint. It:
- explores a larger deterministic search space
- ranks candidates by orders covered, estimated score, then finish tick
- writes the best `fasit` script JSON
- writes a separate report JSON with thresholds, top candidates, and optimizer metadata
- prints progress with the current best candidate while running

Use `--objective handoff_first` when the main goal is to finish known oracle work early and let the live planner score after handoff. Use `score_first` only when you explicitly want to maximize scripted score first.

### 13b) Run a parallel offline optimization batch

```bash
node tools/grocery-bot/optimize-oracle-script-batch.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert-batch-liveworthy.json \
  --out-report tools/grocery-bot/out/oracle-script-batch-liveworthy-report.json \
  --objective live_worthy \
  --objectives live_worthy,handoff_value,handoff_first \
  --iterations 220 \
  --runs 24 \
  --parallel 12
```

Use this when the machine can support many offline searches at once. It:
- spreads seeds across multiple workers
- keeps separate bests for `live_worthy`, `handoff_value`, and `handoff_first`
- writes a single best script for the chosen batch objective plus an aggregate report

Use `live_worthy` when you want a strong handoff candidate instead of the latest high-score replay preserve. Current same-day offline best for that objective is `75` score by tick `260`.

For early-game throughput work, use:

```bash
node tools/grocery-bot/optimize-oracle-script-batch.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert-score100.json \
  --out-report tools/grocery-bot/out/oracle-script-score100-report.json \
  --objective score_by_tick_100 \
  --objectives score_by_tick_100,throughput_frontier,tick_to_score \
  --iterations 180 \
  --runs 18 \
  --parallel 9
```

This produces a frontier report with:
- `best_score_by_tick_100`
- `best_tick_to_40`
- `best_tick_to_60`
- `best_tick_to_80`
- replay `baseline`
- `promotable_shortlist`
- per-candidate `baseline_match`, `baseline_beat`, and `promotable`

Current same-day early frontier from the `89` replay is only `22` score by tick `100`, so the next work should target opening throughput rather than late handoff.

Preset shortcuts are also supported:

```bash
node tools/grocery-bot/optimize-oracle-script-batch.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert-opening100.json \
  --out-report tools/grocery-bot/out/oracle-script-opening100-report.json \
  --preset opening_100 \
  --runs 18 \
  --parallel 9
```

Available presets:
- `opening_100`
- `tick_to_40`
- `tick_to_60`
- `tick_to_80`

### 14) Compress a proven replay backward

```bash
node tools/grocery-bot/compress-oracle-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --out-script tools/grocery-bot/config/script-expert.json \
  --out-report tools/grocery-bot/out/oracle-script-compression-report.json
```

This is the backward optimizer:
- starts from a proven replay trajectory
- extracts the replayed actions as a script prefix
- walks backward removing redundant all-wait ticks
- keeps only compressions that preserve oracle-known legality and achieved oracle outcome

### 15) Audit opening fidelity against the baseline replay

```bash
node tools/grocery-bot/index.mjs --mode opening-audit \
  --difficulty expert \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl \
  --script tools/grocery-bot/config/script-expert-opening100.json \
  --max-tick 120
```

This prints an opening audit with:
- replay `opening_baseline`
- candidate `opening_profile`
- `first_divergence_tick`
- `first_divergence.cause`

Use this before adding more search families. Current same-day audit shows the best `opening_100` candidate diverges at tick `0` on congestion/blocked capacity and never scores by tick `120`.

Use this when the live/player model has already proven a good known-order prefix and you want to free ticks for a better handoff.

### 15) Diff a replay transition

```bash
node tools/grocery-bot/diff-replay-transition.mjs \
  --source-replay tools/grocery-bot/out/<source-run>/replay.jsonl \
  --validation-replay tools/grocery-bot/out/<validation-run>/replay.jsonl \
  --tick 51
```

Use this when a replay-derived script drifts unexpectedly. It compares the full comparable replay state, exact action envelope, and next-state delta for the chosen tick.

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

Default inspection loop:
1. `--mode runs` to find the replay
2. `--mode analyze` to read compact metrics
3. replay viewer only when tick-level inspection is needed

## Daily Rotation Warning

Orders and shelf item types rotate at midnight UTC.

Implications:
- old `oracle-expert.json` and `script-expert.json` become stale after UTC rollover
- the live planner remains valid because it reads shelf items from game state
- rebuild oracle/script assets from the new day before trusting them again

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
node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5
node tools/grocery-bot/index.mjs --mode analyze --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert
node tools/grocery-bot/extract-oracle.mjs --difficulty expert --profile expert --out tools/grocery-bot/config/oracle-expert.json
node tools/grocery-bot/generate-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out tools/grocery-bot/config/script-expert.json
node tools/grocery-bot/index.mjs --mode script-info --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json
node tools/grocery-bot/tune-oracle-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out tools/grocery-bot/out/oracle-script-sweep.json
node tools/grocery-bot/optimize-oracle-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert.json --out-report tools/grocery-bot/out/oracle-script-optimizer-report.json --objective handoff_first --iterations 1000 --score-to-beat 91 --ticks-to-beat 292
node tools/grocery-bot/compress-oracle-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/replay.jsonl --out-script tools/grocery-bot/config/script-expert.json --out-report tools/grocery-bot/out/oracle-script-compression-report.json
node tools/grocery-bot/diff-replay-transition.mjs --source-replay tools/grocery-bot/out/<source-run>/replay.jsonl --validation-replay tools/grocery-bot/out/<validation-run>/replay.jsonl --tick 51
node tools/grocery-bot/index.mjs --mode benchmark --difficulty expert --replay tools/grocery-bot/out
node tools/grocery-bot/index.mjs --mode simulate --difficulty expert --profile expert --replay tools/grocery-bot/out/<run-id>/replay.jsonl
node tools/grocery-bot/index.mjs --mode tune --difficulty expert --profile expert --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 64
node tools/grocery-bot/index.mjs --token 'wss://game.ainm.no/ws?token=...' --profile expert --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json
```

Recommended expert repeat loop:
1. Play a normal live expert run with the best planner baseline.
2. Use `--mode runs` and `--mode analyze` to select the best replay.
3. Rebuild the same-day oracle if needed.
4. Run `compress-oracle-script.mjs` on that replay to preserve the proven score with the shortest safe prefix.
5. Inspect the result with `--mode script-info`.
6. If needed, use `diff-replay-transition.mjs` to validate the scripted-to-live handoff.
7. Play live with `--script` + `--oracle`, replay the prefix exactly, and let the live planner continue after handoff.
8. Keep the new run only if total score or handoff quality improves, then repeat from that run.
