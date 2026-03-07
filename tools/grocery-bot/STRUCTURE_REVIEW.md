# Grocery Bot Structure Review

Purpose: keep the refactor policy concrete, track large-file exceptions, and define the next decomposition steps for the grocery bot codebase.

## Default Policy

- Prefer behavior-based modules over growing a single strategy file.
- `300+` lines: check whether the new logic belongs in a narrower module.
- `500+` lines: shrink the file in the same change or document the next split here.
- New features and experiments are not done without specs.

## Preferred Boundaries

- planner shell / state orchestration
- single-bot evaluation and recovery
- multi-bot mission and assignment policy
- multi-bot routing and action resolution
- shared planner utilities
- replay and analysis reporting
- client protocol and action sanitization

## First Decomposition Pass

Implemented in this pass:
- extracted multi-bot shared helpers into `src/planner-multibot-common.mjs`
- extracted medium mission logic into `src/planner-missions.mjs`
- extracted multi-bot runtime execution into `src/planner-multibot-runtime.mjs`
- extracted client legality sanitizer into `src/game-client-sanitizer.mjs`
- split planner tests into:
  - `test/planner.test.mjs`
  - `test/planner-singlebot.test.mjs`

## Current Exceptions And Next Splits

### `src/planner.mjs`

- Status: still oversized by policy
- Reason: it still owns `GroceryPlanner` state, phase handling, and the full single-bot orchestration path
- Next split:
  - extract planner state/metrics update helpers from the class body
  - move single-bot orchestration out of the planner shell
  - keep `GroceryPlanner` as the orchestration shell only

### `src/planner-missions.mjs`

- Status: still oversized by policy
- Reason: medium mission assignment and mission action resolution were extracted together in the first pass to get the behavior out of `planner-multibot.mjs`
- Next split:
  - separate mission assignment/state validation from mission action resolution/pathing
  - keep one module for mission selection and one for mission execution

### `src/planner-singlebot.mjs`

- Status: still oversized by policy
- Reason: demand helpers, route scoring, cooldowns, oscillation detection, and recovery planner all live together
- Next split:
  - move cooldown/approach/oscillation state helpers into a dedicated recovery-state module
  - move recovery planner behavior into a dedicated recovery module
  - keep route scoring and evaluation separate from recovery/state tracking

### `test/planner-singlebot.test.mjs`

- Status: still oversized by policy
- Reason: the single-bot suite was split out of the generic planner suite, but recovery, batching, and endgame tests still live together
- Next split:
  - separate recovery/cooldown specs from batching/endgame specs
  - keep `planner.test.mjs` for shared planner shell and medium mission coverage only

### `src/replay.mjs`

- Status: below hard limit, but trending upward
- Next split if it grows materially:
  - separate replay I/O from analysis aggregation

## Review Checklist

- Did the change grow a file past `300` lines without considering a narrower module?
- Did a touched file stay above `500` lines without shrinking or adding an entry here?
- Did the feature or experiment add specs for intended behavior and failure mode?
- If new replay/planner metrics were added, did replay tests assert them?
