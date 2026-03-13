import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner, computeOpenerTargets } from '../src/planner/planner.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';
import { GridGraph } from '../src/utils/grid-graph.mjs';

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

test('computeOpenerTargets packs opener staging columns without one-tile gaps', () => {
  const state = {
    grid: {
      width: 28,
      height: 18,
      walls: [
        [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0], [13, 0], [14, 0], [15, 0], [16, 0], [17, 0], [18, 0], [19, 0], [20, 0], [21, 0], [22, 0], [23, 0], [24, 0], [25, 0], [26, 0], [27, 0],
        [0, 1], [27, 1],
        [0, 2], [2, 2], [6, 2], [10, 2], [14, 2], [18, 2], [22, 2], [27, 2],
        [0, 3], [2, 3], [6, 3], [10, 3], [14, 3], [18, 3], [22, 3], [27, 3],
        [0, 4], [2, 4], [6, 4], [10, 4], [14, 4], [18, 4], [22, 4], [27, 4],
        [0, 5], [2, 5], [6, 5], [10, 5], [14, 5], [18, 5], [22, 5], [27, 5],
        [0, 6], [2, 6], [6, 6], [10, 6], [14, 6], [18, 6], [22, 6], [27, 6],
        [0, 7], [2, 7], [6, 7], [10, 7], [14, 7], [18, 7], [22, 7], [27, 7],
        [0, 8], [2, 8], [6, 8], [10, 8], [14, 8], [18, 8], [22, 8], [27, 8],
        [0, 9], [27, 9],
        [0, 10], [2, 10], [6, 10], [10, 10], [14, 10], [18, 10], [22, 10], [27, 10],
        [0, 11], [2, 11], [6, 11], [10, 11], [14, 11], [18, 11], [22, 11], [27, 11],
        [0, 12], [2, 12], [6, 12], [10, 12], [14, 12], [18, 12], [22, 12], [27, 12],
        [0, 13], [2, 13], [6, 13], [10, 13], [14, 13], [18, 13], [22, 13], [27, 13],
        [0, 14], [2, 14], [6, 14], [10, 14], [14, 14], [18, 14], [22, 14], [27, 14],
        [0, 15], [27, 15],
        [0, 16], [27, 16],
        [0, 17], [1, 17], [2, 17], [3, 17], [4, 17], [5, 17], [6, 17], [7, 17], [8, 17], [9, 17], [10, 17], [11, 17], [12, 17], [13, 17], [14, 17], [15, 17], [16, 17], [17, 17], [18, 17], [19, 17], [20, 17], [21, 17], [22, 17], [23, 17], [24, 17], [25, 17], [26, 17], [27, 17],
      ],
    },
    bots: Array.from({ length: 10 }, (_, id) => ({ id, position: [26, 16], inventory: [] })),
    items: Array.from({ length: 120 }, (_, index) => {
      const cols = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
      const rows = [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14];
      return { id: `item_${index}`, type: `t${index}`, position: [cols[index % cols.length], rows[Math.floor(index / cols.length)]] };
    }),
  };
  const graph = new GridGraph({
    ...state.grid,
    walls: [...state.grid.walls, ...state.items.map((item) => item.position)],
  });

  const targets = computeOpenerTargets(state, graph, [1, 16]);
  const bottomRowTargets = targets.filter(([, y]) => y === 15).map(([x]) => x).sort((a, b) => a - b);

  assert.deepEqual(bottomRowTargets, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
});

test('expert opener budget is long enough to finish the compact staging move', () => {
  assert.equal(defaultProfiles.expert.opener.max_ticks, 20);
});

test('expert opener releases bots with left-plus-up spawn sequencing', () => {
  const planner = new GroceryPlanner(structuredClone(defaultProfiles.expert));
  const state0 = {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 12, height: 8, walls: [] },
    bots: [
      { id: 0, position: [10, 6], inventory: [] },
      { id: 1, position: [10, 6], inventory: [] },
      { id: 2, position: [10, 6], inventory: [] },
      { id: 3, position: [10, 6], inventory: [] },
    ],
    items: [],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 6],
    drop_offs: [[1, 6]],
    score: 0,
  };

  const actions0 = planner.plan(state0);
  assert.equal(actions0.find((action) => action.bot === 0)?.action, 'move_left');
  assert.equal(actions0.find((action) => action.bot === 1)?.action, 'move_up');
  assert.equal(actions0.find((action) => action.bot === 2)?.action, 'wait');
  assert.equal(actions0.find((action) => action.bot === 3)?.action, 'wait');

  const state1 = {
    ...state0,
    round: 1,
    bots: [
      { id: 0, position: [9, 6], inventory: [] },
      { id: 1, position: [10, 5], inventory: [] },
      { id: 2, position: [10, 6], inventory: [] },
      { id: 3, position: [10, 6], inventory: [] },
    ],
  };
  const actions1 = planner.plan(state1);
  assert.equal(actions1.find((action) => action.bot === 0)?.action, 'move_left');
  assert.equal(actions1.find((action) => action.bot === 1)?.action, 'move_left');
  assert.equal(actions1.find((action) => action.bot === 2)?.action, 'move_left');
});

test('expert opener continues the same release pattern on the next round', () => {
  const planner = new GroceryPlanner(structuredClone(defaultProfiles.expert));
  planner.openerTick = 2;
  planner.openerSpawn = [10, 6];
  planner.openerTargetPositions = [[3, 6], [3, 5], [4, 6], [4, 5], [5, 6], [5, 5]];
  const state = {
    type: 'game_state',
    round: 2,
    max_rounds: 300,
    grid: { width: 12, height: 8, walls: [] },
    bots: [
      { id: 0, position: [8, 6], inventory: [] },
      { id: 1, position: [9, 5], inventory: [] },
      { id: 2, position: [9, 6], inventory: [] },
      { id: 3, position: [10, 5], inventory: [] },
      { id: 4, position: [10, 6], inventory: [] },
      { id: 5, position: [10, 6], inventory: [] },
    ],
    items: [],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 6],
    drop_offs: [[1, 6]],
    score: 0,
  };

  const actions = planner.plan(state);
  assert.equal(actions.find((action) => action.bot === 0)?.action, 'move_left');
  assert.equal(actions.find((action) => action.bot === 1)?.action, 'move_left');
  assert.equal(actions.find((action) => action.bot === 2)?.action, 'move_left');
  assert.equal(actions.find((action) => action.bot === 3)?.action, 'move_left');
  assert.equal(actions.find((action) => action.bot === 4)?.action, 'move_left');
  assert.equal(actions.find((action) => action.bot === 5)?.action, 'move_up');
});

test('expert opener hands off immediately after the spawn stack is empty', () => {
  const planner = new GroceryPlanner(structuredClone(defaultProfiles.expert));
  planner.openerSpawn = [10, 6];
  planner.openerTargetPositions = [[3, 6], [3, 5], [4, 6], [4, 5]];
  planner.openerReleasedBotOrder = [0, 1, 2, 3];
  planner.openerTick = 4;

  const state = {
    type: 'game_state',
    round: 4,
    max_rounds: 300,
    grid: { width: 12, height: 8, walls: [] },
    bots: [
      { id: 0, position: [6, 6], inventory: [] },
      { id: 1, position: [7, 5], inventory: [] },
      { id: 2, position: [8, 6], inventory: [] },
      { id: 3, position: [9, 5], inventory: [] },
    ],
    items: [{ id: 'item_0', type: 'milk', position: [3, 3] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [1, 6],
    drop_offs: [[1, 6]],
    score: 0,
  };

  const actions = planner.plan(state);

  assert.equal(planner.openerActive, false);
  assert.equal(planner.lastOpenerRound, 4);
  assert.deepEqual(planner.initialTeamOrder, [0, 1, 2, 3]);
  assert.equal(planner.lastMetrics.phase === 'opener', false);
  assert.equal(actions.some((action) => action.action.startsWith('move_') || action.action === 'pick_up'), true);
});

test('expert lane map stays relaxed immediately after opener handoff', () => {
  const profile = structuredClone(defaultProfiles.expert);
  profile.opener.enabled = false;
  const planner = new GroceryPlanner(profile);
  planner.openerActive = false;
  planner.lastOpenerRound = 12;

  planner.plan(baseState({
    round: 13,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [2, 1], inventory: [] },
    ],
    items: [
      { id: 'item_0', type: 'milk', position: [3, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
    drop_off: [1, 8],
    drop_offs: [[1, 8]],
    score: 0,
  }));

  assert.equal(planner._dirPrefCacheMode, 'default');
});
