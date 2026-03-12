import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner/planner.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 6, height: 6, walls: [] },
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [0, 0],
    score: 0,
    ...overrides,
  };
}

test('single-bot planner avoids premature dropoff when active order can still be batched', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 20,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [3, 6], inventory: ['milk'] }],
    items: [
      { id: 'item_butter', type: 'butter', position: [9, 6] },
      { id: 'item_yogurt', type: 'yogurt', position: [7, 6] },
      { id: 'item_milk', type: 'milk', position: [5, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'butter', 'yogurt'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
  });

  const actions = planner.plan(state);

  assert.deepEqual(actions, [{ bot: 0, action: 'move_right' }]);
});

test('single-bot planner avoids repeating failed pickup on same shelf item', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const stateRound0 = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: ['cheese'] }],
    items: [
      { id: 'milk_primary', type: 'milk', position: [7, 6] },
      { id: 'milk_backup', type: 'milk', position: [5, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'milk'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
    score: 10,
  });

  const firstAction = planner.plan(stateRound0);
  assert.deepEqual(firstAction, [{ bot: 0, action: 'pick_up', item_id: 'milk_primary' }]);

  const stateRound1 = {
    ...stateRound0,
    round: 1,
    score: 10,
  };
  const secondAction = planner.plan(stateRound1);

  assert.deepEqual(secondAction, [{ bot: 0, action: 'pick_up', item_id: 'milk_primary' }]);

  const stateRound2 = {
    ...stateRound0,
    round: 2,
    score: 10,
  };
  const thirdAction = planner.plan(stateRound2);

  assert.notDeepEqual(thirdAction, [{ bot: 0, action: 'pick_up', item_id: 'milk_primary' }]);
});

test('single-bot planner enters recovery mode after score stagnation and prioritizes active order', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 2;
  const planner = new GroceryPlanner(profile);

  const stagnantState = baseState({
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [9, 5], inventory: [] }],
    items: [
      { id: 'butter_preview', type: 'butter', position: [9, 6] },
      { id: 'milk_active', type: 'milk', position: [5, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['butter'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
    score: 12,
  });

  planner.plan({ ...stagnantState, round: 0 });
  planner.plan({ ...stagnantState, round: 1 });
  const action = planner.plan({ ...stagnantState, round: 2 });

  assert.equal(planner.getLastMetrics().recoveryMode, true);
  assert.notDeepEqual(action, [{ bot: 0, action: 'pick_up', item_id: 'butter_preview' }]);
});

test('single-bot planner triggers reset checkpoint at 15 no-score rounds', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 15;
  profile.recovery.burst_rounds = 4;
  const planner = new GroceryPlanner(profile);

  const state = baseState({
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [9, 5], inventory: [] }],
    items: [{ id: 'milk_active', type: 'milk', position: [5, 3] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 3,
  });

  for (let round = 0; round <= 15; round += 1) {
    planner.plan({ ...state, round });
  }

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.noProgressRounds, 15);
  assert.equal(metrics.resetTriggered, true);
  assert.equal(metrics.recoveryMode, true);
});

test('single-bot planner uses tighter no-progress threshold in mid phase', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 15;
  profile.recovery.mid_no_progress_rounds = 10;
  profile.recovery.late_no_progress_rounds = 6;
  profile.recovery.late_rounds_window = 60;
  profile.recovery.burst_rounds = 4;
  const planner = new GroceryPlanner(profile);

  const state = baseState({
    round: 120,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [9, 5], inventory: [] }],
    items: [{ id: 'milk_active', type: 'milk', position: [5, 3] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 3,
  });

  for (let step = 0; step <= 10; step += 1) {
    planner.plan({ ...state, round: 120 + step });
  }

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.noProgressRounds, 10);
  assert.equal(metrics.resetTriggered, true);
  assert.equal(metrics.recoveryMode, true);
});

test('single-bot planner does not immediately penalize pickup until second unresolved round', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  const planner = new GroceryPlanner(profile);

  const state0 = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: [] }],
    items: [{ id: 'milk_active', type: 'milk', position: [7, 6] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 0,
  });

  const a0 = planner.plan(state0);
  assert.deepEqual(a0, [{ bot: 0, action: 'pick_up', item_id: 'milk_active' }]);

  const state1 = { ...state0, round: 1, score: 0 };
  const a1 = planner.plan(state1);
  assert.deepEqual(a1, [{ bot: 0, action: 'pick_up', item_id: 'milk_active' }]);
});

test('single-bot planner locks unresolved pickup intent during verification window', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  const planner = new GroceryPlanner(profile);

  planner.pendingPickups.set(0, {
    itemId: 'cheese_active',
    expectedMinInventory: 3,
    resolveAfterRound: 11,
    approachCell: [5, 7],
  });

  const state = baseState({
    round: 10,
    score: 33,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [5, 7], inventory: ['yogurt', 'yogurt'] }],
    items: [
      { id: 'cheese_active', type: 'cheese', position: [5, 6] },
      { id: 'milk_other', type: 'milk', position: [7, 6] },
    ],
    orders: [
      { id: 'o0', items_required: ['yogurt', 'cheese', 'yogurt', 'milk'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
  });

  const action = planner.plan(state);

  assert.deepEqual(action, [{ bot: 0, action: 'pick_up', item_id: 'cheese_active' }]);
  assert.equal(planner.getLastMetrics().pendingPickupLockActive, true);
});

test('single-bot planner blacklists failed approach after configured consecutive failure threshold', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.runtime.max_consecutive_pick_failures_before_forbid = 1;
  profile.runtime.approach_forbid_ttl = 30;
  profile.recovery.no_progress_rounds = 50;
  const planner = new GroceryPlanner(profile);

  const state0 = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: [] }],
    items: [{ id: 'milk_active', type: 'milk', position: [7, 6] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 0,
  });

  planner.plan(state0);
  planner.plan({ ...state0, round: 1, score: 0 });
  planner.plan({ ...state0, round: 2, score: 0 });

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.approachBlacklistSize > 0, true);
});

test('single-bot planner triggers pickup-failure spiral recovery before default no-progress threshold', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 50;
  profile.runtime.pick_failure_spiral_window = 10;
  profile.runtime.pick_failure_spiral_threshold = 1;
  const planner = new GroceryPlanner(profile);

  const state0 = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: [] }],
    items: [{ id: 'milk_active', type: 'milk', position: [7, 6] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 0,
  });

  planner.plan(state0);
  planner.plan({ ...state0, round: 1, score: 0 });
  planner.plan({ ...state0, round: 2, score: 0 });

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.pickupFailureSpiralActive, true);
  assert.equal(metrics.recoveryMode, true);
});

test('single-bot planner prefers active-order completion candidate over preview candidate', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 30,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: [] }],
    items: [
      { id: 'milk_active', type: 'milk', position: [7, 6] },
      { id: 'butter_preview', type: 'butter', position: [9, 6] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['butter', 'butter'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
  });

  const actions = planner.plan(state);

  assert.deepEqual(actions, [{ bot: 0, action: 'pick_up', item_id: 'milk_active' }]);
});

test('single-bot planner does not keep picking when one active item is already in inventory', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 200,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: ['milk'] }],
    items: [
      { id: 'milk_active', type: 'milk', position: [7, 6] },
      { id: 'butter_preview', type: 'butter', position: [9, 6] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['butter', 'butter'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
    score: 30,
  });

  const actions = planner.plan(state);

  assert.equal(actions[0].action.startsWith('move_') || actions[0].action === 'drop_off', true);
  assert.notDeepEqual(actions, [{ bot: 0, action: 'pick_up', item_id: 'milk_active' }]);
});

test('single-bot planner never sends pick_up when inventory is full', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 140,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [8, 6], inventory: ['milk', 'cheese', 'yogurt'] }],
    items: [{ id: 'butter_active', type: 'butter', position: [7, 6] }],
    orders: [{ id: 'o0', items_required: ['butter'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 20,
  });

  const actions = planner.plan(state);

  assert.notDeepEqual(actions, [{ bot: 0, action: 'pick_up', item_id: 'butter_active' }]);
});

test('single-bot planner caps repeated non-scoring drop confirmations', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  const planner = new GroceryPlanner(profile);

  const stagnantDropState = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['milk'] }],
    items: [{ id: 'milk_active', type: 'milk', position: [7, 6] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 50,
  });

  const first = planner.plan({ ...stagnantDropState, round: 0 });
  const second = planner.plan({ ...stagnantDropState, round: 1 });
  const third = planner.plan({ ...stagnantDropState, round: 2 });

  assert.deepEqual(first, [{ bot: 0, action: 'drop_off' }]);
  assert.deepEqual(second, [{ bot: 0, action: 'drop_off' }]);
  assert.notDeepEqual(third, [{ bot: 0, action: 'drop_off' }]);
});

test('single-bot planner does not drop partial inventory only because it is at dropoff', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 40,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['milk'] }],
    items: [
      { id: 'item_butter', type: 'butter', position: [5, 6] },
      { id: 'item_milk', type: 'milk', position: [7, 6] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'butter', 'milk'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
  });

  const actions = planner.plan(state);

  assert.notDeepEqual(actions, [{ bot: 0, action: 'drop_off' }]);
});

test('single-bot planner avoids partial drop at endgame when inventory is not full', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 255,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['butter', 'cheese'] }],
    items: [
      { id: 'item_cheese', type: 'cheese', position: [3, 4] },
      { id: 'item_butter', type: 'butter', position: [5, 6] },
    ],
    orders: [
      { id: 'o0', items_required: ['butter', 'cheese', 'cheese'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
    score: 40,
  });

  const actions = planner.plan(state);

  assert.notDeepEqual(actions, [{ bot: 0, action: 'drop_off' }]);
});

test('no-progress counter is reset by inventory progress even when score is unchanged', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 3;
  const planner = new GroceryPlanner(profile);

  const state0 = baseState({
    round: 0,
    score: 0,
    bots: [{ id: 0, position: [8, 6], inventory: [] }],
    items: [{ id: 'milk_active', type: 'milk', position: [7, 6] }],
  });
  const state1 = {
    ...state0,
    round: 1,
    bots: [{ id: 0, position: [8, 6], inventory: ['milk'] }],
  };
  const state2 = {
    ...state0,
    round: 2,
    bots: [{ id: 0, position: [8, 6], inventory: ['milk'] }],
  };

  planner.plan(state0);
  planner.plan(state1);
  planner.plan(state2);

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.noProgressRounds, 1);
  assert.equal(metrics.recoveryMode, false);
});

test('single-bot planner does not bounce back to dropoff when one active item is still missing', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 30,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [2, 8], inventory: ['butter', 'milk'] }],
    items: [
      { id: 'item_yogurt', type: 'yogurt', position: [5, 6] },
      { id: 'item_milk', type: 'milk', position: [7, 6] },
      { id: 'item_butter', type: 'butter', position: [9, 6] },
    ],
    orders: [
      { id: 'o0', items_required: ['butter', 'milk', 'yogurt'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
    score: 0,
  });

  const actions = planner.plan(state);

  assert.notDeepEqual(actions, [{ bot: 0, action: 'move_left' }]);
});

test('single-bot planner forces partial drop after prolonged no-progress recovery window', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 2;
  profile.recovery.partial_drop_no_progress_rounds = 2;
  const planner = new GroceryPlanner(profile);

  const stagnantState = baseState({
    round: 0,
    score: 10,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['milk'] }],
    items: [{ id: 'item_butter', type: 'butter', position: [7, 6] }],
    orders: [{ id: 'o0', items_required: ['milk', 'butter'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
  });

  planner.plan({ ...stagnantState, round: 0 });
  planner.plan({ ...stagnantState, round: 1 });
  const third = planner.plan({ ...stagnantState, round: 2 });

  assert.deepEqual(third, [{ bot: 0, action: 'drop_off' }]);
});

test('single-bot planner does not attempt drop-off of non-deliverable inventory after prolonged no-progress', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 2;
  profile.recovery.partial_drop_no_progress_rounds = 2;
  const planner = new GroceryPlanner(profile);

  const stagnantState = baseState({
    round: 0,
    score: 12,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['butter'] }],
    items: [{ id: 'item_yogurt', type: 'yogurt', position: [5, 6] }],
    orders: [{ id: 'o0', items_required: ['yogurt'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
  });

  planner.plan({ ...stagnantState, round: 0 });
  planner.plan({ ...stagnantState, round: 1 });
  const third = planner.plan({ ...stagnantState, round: 2 });

  // With non-deliverable inventory (butter, but only yogurt is needed), the bot should
  // navigate toward the needed item instead of attempting a futile drop-off.
  assert.notDeepEqual(third, [{ bot: 0, action: 'drop_off' }]);
  assert.strictEqual(third[0].bot, 0);
  assert.ok(['move_right', 'move_left', 'move_up', 'move_down'].includes(third[0].action),
    `Expected a move action toward yogurt, got: ${third[0].action}`);
});

test('single-bot planner avoids starting infeasible trip at final round', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 299,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [10, 8], inventory: [] }],
    items: [{ id: 'item_milk_far', type: 'milk', position: [5, 3] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 20,
  });

  const actions = planner.plan(state);

  assert.deepEqual(actions, [{ bot: 0, action: 'wait' }]);
});

test('single-bot planner activates loop-break mode on repeated two-cell oscillation', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  profile.recovery.partial_drop_no_progress_rounds = 100;
  profile.recovery.loop_break_rounds = 3;
  const planner = new GroceryPlanner(profile);

  const base = baseState({
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['butter', 'milk'] }],
    items: [{ id: 'item_yogurt', type: 'yogurt', position: [5, 6] }],
    orders: [{ id: 'o0', items_required: ['yogurt'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 30,
  });

  for (let round = 0; round <= 6; round += 1) {
    const pos = round % 2 === 0 ? [1, 8] : [2, 8];
    planner.plan({
      ...base,
      round,
      bots: [{ id: 0, position: pos, inventory: ['butter', 'milk'] }],
    });
  }

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.loopBreakActive, true);
  assert.equal(metrics.loopDetections > 0, true);
});

test('single-bot planner activates loop-break mode on confined three-cell loop', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  profile.recovery.partial_drop_no_progress_rounds = 100;
  profile.recovery.loop_break_rounds = 3;
  const planner = new GroceryPlanner(profile);

  const base = baseState({
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 5], inventory: [] }],
    items: [{ id: 'item_cheese', type: 'cheese', position: [3, 4] }],
    orders: [{ id: 'o0', items_required: ['cheese'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 8],
    score: 30,
  });

  const pattern = [[1, 4], [1, 5], [1, 6], [1, 5], [1, 4], [1, 5], [1, 6], [1, 5], [1, 4]];
  for (let round = 0; round < pattern.length; round += 1) {
    planner.plan({
      ...base,
      round,
      bots: [{ id: 0, position: pattern[round], inventory: [] }],
    });
  }

  const metrics = planner.getLastMetrics();
  assert.equal(metrics.loopBreakActive, true);
  assert.equal(metrics.loopDetections > 0, true);
});

test('single-bot planner blacklists stale target after repeated no-progress on same target item', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  profile.runtime.target_lock_stall_rounds = 3;
  profile.runtime.target_lock_forbid_ttl = 20;
  const planner = new GroceryPlanner(profile);

  const state = baseState({
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'milk_target', type: 'milk', position: [4, 1] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [0, 0],
    score: 0,
  });

  let sawTargetStall = false;
  for (let round = 0; round <= 4; round += 1) {
    planner.plan({ ...state, round });
    sawTargetStall = sawTargetStall || Boolean(planner.getLastMetrics().targetStallTriggered);
  }

  const metrics = planner.getLastMetrics();
  assert.equal(sawTargetStall, true);
  assert.equal(metrics.targetLockTicks >= 0, true);
});

test('single-bot planner triggers order-stall bailout on long no-progress active order', () => {
  const profile = structuredClone(defaultProfiles.easy);
  profile.recovery.no_progress_rounds = 100;
  profile.runtime.target_lock_stall_rounds = 50;
  profile.runtime.order_stall_bailout_rounds = 3;
  const planner = new GroceryPlanner(profile);

  const state = baseState({
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'milk_target', type: 'milk', position: [4, 1] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [0, 0],
    score: 0,
  });

  let sawBailout = false;
  for (let round = 0; round <= 6; round += 1) {
    planner.plan({ ...state, round });
    sawBailout = sawBailout || Boolean(planner.getLastMetrics().orderStallBailoutTriggered);
  }

  assert.equal(sawBailout, true);
});

test('single-bot planner prioritizes expensive leftovers in 4-item order batching', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 120,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['butter', 'milk'] }],
    items: [
      { id: 'butter_near', type: 'butter', position: [1, 6] },
      { id: 'milk_far', type: 'milk', position: [9, 6] },
    ],
    orders: [
      {
        id: 'o0',
        items_required: ['butter', 'butter', 'milk', 'milk'],
        items_delivered: [],
        status: 'active',
        complete: false,
      },
    ],
    drop_off: [1, 8],
    score: 40,
  });

  const actions = planner.plan(state);

  assert.deepEqual(actions, [{ bot: 0, action: 'move_right' }]);
});

test('single-bot planner drops partial inventory at endgame when full completion is infeasible', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    round: 278,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [{ id: 0, position: [1, 8], inventory: ['milk'] }],
    items: [
      { id: 'butter_far', type: 'butter', position: [9, 6] },
    ],
    orders: [
      {
        id: 'o0',
        items_required: ['milk', 'butter', 'butter', 'butter'],
        items_delivered: [],
        status: 'active',
        complete: false,
      },
    ],
    drop_off: [1, 8],
    score: 70,
  });

  const actions = planner.plan(state);

  assert.deepEqual(actions, [{ bot: 0, action: 'drop_off' }]);
});
