# Next Session Prompt

Initialize from `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, and this file before doing any work.

Current starting point:
- Current UTC-day expert baseline is `tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert`
- Result: score `89`, `9` orders, `44` items
- Key remaining pattern: `18` sanitizer overrides, `932` waits, `1042` stalls, slow opening through tick `31`

What changed recently:
- `index.mjs` now supports `--mode runs`, `--mode analyze`, and `--mode script-info`
- `extract-oracle.mjs` is the supported expert oracle extractor
- Replay/handoff tooling is instrumented and provenance-tagged, but remains archival until the live expert baseline is exhausted

Do first:
1. Read:
   - `tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/analysis.json`
   - `tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert/summary.json`
   - `tools/grocery-bot/STRATEGY_REVIEW.md`
   - `tools/grocery-bot/EXPERIMENT_LOG.md`
2. Use the supported inspection loop first:
   - `node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5`
   - `node tools/grocery-bot/index.mjs --mode analyze --replay tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert`
   - `npm run grocery-bot:viewer` only if tick-level inspection is needed
3. Rebuild `tools/grocery-bot/config/oracle-expert.json` for the new day before any new expert oracle/script attempts:
   - `node tools/grocery-bot/extract-oracle.mjs --difficulty expert --profile expert --out tools/grocery-bot/config/oracle-expert.json`
4. Focus on hybrid improvement on top of the live expert baseline:
   - shrink the 32-tick opening ramp
   - reduce 10-18 tick delivery gaps
   - use the `89` run as the replay source for oracle/compactor work first
5. Follow the repeat loop:
   - live planner baseline run
   - pick best replay with `runs` + `analyze`
   - compress that replay into the shortest safe high-score prefix
   - replay it live with `--script` + `--oracle`
   - let the planner take over after handoff
   - keep only improved runs and iterate

Do not assume:
- old `oracle-expert.json` is valid
- old `script-expert.json` is valid
- archived replay-handoff profiles are part of the default workflow

Helpful references:
- Current live expert baseline:
  - `tools/grocery-bot/out/2026-03-08T10-50-21-635Z-expert-expert`
- Archived hybrid references:
  - `tools/grocery-bot/out/2026-03-07T23-52-29-214Z-expert-expert_replay_handoff`
  - `tools/grocery-bot/out/2026-03-07T23-59-03-111Z-expert-expert_replay_handoff`

Initial objective for tomorrow:
- preserve the `89`-point live expert baseline
- rebuild same-day oracle/script assets from that baseline
- push the hybrid path toward the first `300+` expert run
