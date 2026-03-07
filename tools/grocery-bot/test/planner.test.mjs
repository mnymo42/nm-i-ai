import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner.mjs';
import { defaultProfiles } from '../src/profile.mjs';

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

test('planner picks up required item when adjacent', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const actions = planner.plan(baseState());

  assert.deepEqual(actions, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
});

test('planner drops off when bot is at dropoff with matching active inventory', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const actions = planner.plan(baseState({
    bots: [{ id: 0, position: [0, 0], inventory: ['milk'] }],
  }));

  assert.deepEqual(actions, [{ bot: 0, action: 'drop_off' }]);
});

test('planner avoids head-on collision by forcing lower-priority bot to wait', () => {
  const planner = new GroceryPlanner(defaultProfiles.medium);
  const state = baseState({
    bots: [
      { id: 0, position: [0, 0], inventory: [] },
      { id: 1, position: [2, 0], inventory: [] },
    ],
    items: [
      { id: 'item_0', type: 'milk', position: [1, 1] },
      { id: 'item_1', type: 'bread', position: [1, 1] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'bread'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const actions = planner.plan(state);

  const byBot = new Map(actions.map((action) => [action.bot, action]));
  assert.equal(byBot.get(0).action.startsWith('move_') || byBot.get(0).action === 'wait', true);
  assert.equal(byBot.get(1).action.startsWith('move_') || byBot.get(1).action === 'wait', true);
  assert.notDeepEqual([byBot.get(0).action, byBot.get(1).action], ['move_right', 'move_left']);
});

test('planner does not route through shelf cells when approaching target shelf', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy);
  const state = baseState({
    bots: [{ id: 0, position: [4, 4], inventory: ['cheese', 'yogurt'] }],
    items: [
      { id: 'milk_target', type: 'milk', position: [5, 3] },
      { id: 'blocking_shelf', type: 'butter', position: [5, 4] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
  });

  const actions = planner.plan(state);

  assert.notDeepEqual(actions, [{ bot: 0, action: 'move_right' }]);
});

test('medium mission planner persists mission while target and order remain valid', () => {
  const profile = structuredClone(defaultProfiles.medium);
  profile.runtime.multi_bot_strategy = 'mission_v1';
  const planner = new GroceryPlanner(profile);
  const state0 = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [5, 1], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
    score: 0,
  });

  planner.plan(state0);
  const firstMission = planner.missionsByBot.get(0);

  planner.plan({ ...state0, round: 1 });
  const secondMission = planner.missionsByBot.get(0);

  assert.equal(firstMission.missionType, 'collect_active');
  assert.equal(secondMission.missionType, 'collect_active');
  assert.equal(secondMission.targetItemId, firstMission.targetItemId);
  assert.equal(secondMission.assignedAtRound, firstMission.assignedAtRound);
});

test('medium mission planner invalidates mission when active order changes', () => {
  const profile = structuredClone(defaultProfiles.medium);
  profile.runtime.multi_bot_strategy = 'mission_v1';
  const planner = new GroceryPlanner(profile);
  const state0 = baseState({
    round: 0,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [5, 1], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['bread'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
    score: 0,
  });

  planner.plan(state0);
  const firstMission = planner.missionsByBot.get(0);

  const state1 = {
    ...state0,
    round: 1,
    items: [
      { id: 'bread_0', type: 'bread', position: [3, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: ['milk'], status: 'done', complete: true },
      { id: 'o1', items_required: ['bread'], items_delivered: [], status: 'active', complete: false },
    ],
  };

  planner.plan(state1);
  const secondMission = planner.missionsByBot.get(0);

  assert.equal(firstMission.orderId, 'o0');
  assert.equal(secondMission.orderId, 'o1');
  assert.equal(secondMission.targetType, 'bread');
});
