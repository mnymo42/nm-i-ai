# Grocery Bot Experiment Log

Purpose: keep an operational record of strategy experiments so we can avoid repeating failed ideas and know which branch of behavior produced the current benchmark.

## Current Benchmarks

- Easy: `118`
- Medium: `115`
- Expert historical reference: `33` (91 high score on previous UTC day)
- Expert current UTC-day baseline: `89` (`2026-03-08T10-50-21-635Z-expert-expert`)

## Oracle / Script Status

- Expert oracle/script path is now modular:
  - `generate-script.mjs`
  - `src/oracle-script-optimizer.mjs`
  - `src/oracle-script-evaluator.mjs`
  - `src/oracle-script-io.mjs`
- Current generator status:
  - valid script generation works with the new constraint-based scheduler and deterministic evaluator
  - current safe default is conservative (`maxActiveBots = 1`) to avoid stacked-start / drop-bay conflicts while the higher-throughput scheduler is still being tuned
  - latest generated expert script metadata:
    - `orders_covered: 2`
    - `estimated_score: 19`
    - `last_scripted_tick: 221`
- Verdict: `keep scaffolding, continue tuning`

## Experiment Verdicts (Compact)

| Experiment | Verdict | Key Result |
|------------|---------|------------|
| Count-aware preview pruning | keep | Main structural improvement behind medium 115 |
| Hard 20ms send throttle | revert | Score collapse to 3 |
| Short-hold reservations + custom bot priority | revert | Unstable vs 109 |
| Shelf quarantine in assignment | keep | Reduces repeated bad picks |
| Zone affinity | keep | Healthier traffic, not a new benchmark |
| Completion-wave control | revert | Too rigid, increased waits |
| Medium mission planner v1 | revert | Catastrophically unstable live |
| Pickup service-bay exclusivity | keep | Stability fix, not benchmark |
| Staging-lane fallback | revert | Broke score conversion |
| Soft order flush | revert | Over-committed, stalled map |
| Medium 109 baseline recovery | keep | Simpler path recovered 115 |
| Warehouse v1 | behind flag | Not promoted until beats 115 |
| High-bot warehouse rollout | keep | First 5+ bot architecture |
| High-bot warehouse close-mode fix | keep | Control-layer correctness |
| Minimal replay viewer | keep | Debugging tool |
| Expert warehouse throughput pass 1 | pending | Expert-focused warehouse tuning |
| Oracle script optimizer v2 | keep | Modular, conservative baseline |
| Opening fidelity audit | keep | Baseline-aware triage |
| Expert idle parking + preview cap + drop boost | keep | Expert 38→89 baseline |
| Aisle-based parking slots | keep | Expert 38→89 (massive improvement) |
| Workflow cleanup | keep | Supported inspection commands |
| Offline wave staging + replay-seeded search | keep | Offline 19→22 |
| Parallel replay frontier + live-worthy ranking | keep | 75@260 offline candidate |
| Checkpoint rewriter + early-game frontier | keep | Isolated opening bottleneck |
| Sim triage + opening-family search | keep | Removed ranking ambiguity |
| Pair release + teamed opening | partial | Not promotable, collision issues |
| Replay handoff fidelity + provenance | keep | Tooling, not main blocker |
| Oracle optimizer harness | keep | Preferred offline entrypoint |
| Replay compression optimizer | keep | Deterministic post-processing |
| Expert opener breakout + longer compact staging | pending | Intended to clear post-opener freeze and remove staged air gaps |
| Expert throughput pass v1 | keep | Deterministic opener, zone-aware team control, drop-off fallback, and viewer lane sync |
| Expert convection lane map v3 | pending | Stronger road backbone with off-road parking to reduce corridor blocking |
| Lane viewer parity + forced-lane regression lock | keep | Viewer now renders actual one-way roads for the active profile, and tests pin hard lane direction enforcement |
| Expert road-pattern reset + oracle-fed offline benchmark | pending | Narrower v4 backbone roads, road-aware static-target rejection, and planner-only expert benchmark against oracle environment |

## Guidance

- Prefer experiments that are soft cost-shaping changes over hard role locks.
- Treat `109` medium as the last known strong baseline until a higher repeatable score is achieved.
- Update this log whenever an experiment meaningfully changes live behavior, even if the result is a failure.
