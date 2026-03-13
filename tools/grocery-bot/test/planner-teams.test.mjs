import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner/planner.mjs';
import { buildPrefetchWavePlan, buildTeams } from '../src/planner/planner-teams.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';
import { buildWorldContext } from '../src/utils/world-model.mjs';

function buildExpertProfile() {
  const profile = structuredClone(defaultProfiles.expert);
  profile.opener.enabled = false;
  profile.routing.use_lane_map_v2 = false;
  return profile;
}

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 20,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 8], inventory: [] },
      { id: 1, position: [2, 2], inventory: [] },
      { id: 2, position: [8, 2], inventory: [] },
      { id: 3, position: [9, 2], inventory: [] },
    ],
    items: [],
    orders: [],
    drop_off: [1, 8],
    drop_offs: [[1, 8]],
    score: 0,
    ...overrides,
  };
}

test('team planner blocks preview pickup while active demand remains broad', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  const state = baseState({
    items: [
      { id: 'milk_0', type: 'milk', position: [2, 3] },
      { id: 'bread_0', type: 'bread', position: [3, 3] },
      { id: 'eggs_0', type: 'eggs', position: [4, 3] },
      { id: 'pasta_0', type: 'pasta', position: [8, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'bread', 'eggs'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  const actions = planner.plan(state);

  assert.equal(actions.some((action) => action.action === 'pick_up' && action.item_id === 'pasta_0'), false);
  assert.equal(planner.lastMetrics.prefetchBlockedByActiveDemand, true);
  assert.equal(planner.lastMetrics.wavePickupEnabled, false);
});

test('team planner allows preview pickup once active demand is covered', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.oracle = {
    known_orders: [
      { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
    ],
  };
  const state = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: ['milk'] },
      { id: 1, position: [2, 2], inventory: [] },
      { id: 2, position: [8, 2], inventory: [] },
      { id: 3, position: [9, 2], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [2, 3] },
      { id: 'pasta_0', type: 'pasta', position: [8, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  const actions = planner.plan(state);

  assert.equal(actions.some((action) => action.action === 'pick_up' && action.item_id === 'pasta_0'), true);
  assert.equal(planner.lastMetrics.activeCoverageSatisfied, true);
  assert.equal(planner.lastMetrics.wavePickupEnabled, true);
});

test('prefetch wave reserves complementary future item types without duplicate hoarding', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: ['milk'] },
      { id: 1, position: [2, 2], inventory: [] },
      { id: 2, position: [8, 2], inventory: [] },
      { id: 3, position: [9, 2], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [2, 3] },
      { id: 'pasta_0', type: 'pasta', position: [8, 3] },
      { id: 'pasta_1', type: 'pasta', position: [9, 3] },
      { id: 'eggs_0', type: 'eggs', position: [10, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const world = buildWorldContext(state);

  const wave = buildPrefetchWavePlan({
    state,
    world,
    oracle: {
      known_orders: [
        { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
        { id: 'o2', items_required: ['eggs'], first_seen_tick: 25 },
      ],
    },
    lookahead: 80,
    orderCount: 3,
    prefetchBlockedByActiveDemand: false,
  });

  assert.deepEqual(wave.waveOrderIds, ['o0', 'o1', 'o2']);
  assert.equal(wave.reservedFutureCounts.get('pasta'), 1);
  assert.equal(wave.reservedFutureCounts.get('eggs'), 1);
  assert.equal(wave.wavePickupEnabled, true);
});

test('team planner takes an approach step instead of freezing on active item assignment', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.lastOpenerRound = 11;
  const state = baseState({
    round: 12,
    max_rounds: 300,
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
    bots: [
      { id: 0, position: [22, 16], inventory: [] },
      { id: 1, position: [23, 15], inventory: [] },
      { id: 2, position: [20, 16], inventory: [] },
      { id: 3, position: [21, 15], inventory: [] },
      { id: 4, position: [18, 16], inventory: [] },
      { id: 5, position: [19, 15], inventory: [] },
      { id: 6, position: [16, 16], inventory: [] },
      { id: 7, position: [17, 15], inventory: [] },
      { id: 8, position: [14, 16], inventory: [] },
      { id: 9, position: [15, 15], inventory: [] },
    ],
    items: [
      { id: 'cream_0', type: 'cream', position: [19, 2] },
      { id: 'onions_0', type: 'onions', position: [19, 4] },
      { id: 'flour_0', type: 'flour', position: [15, 8] },
      { id: 'cereal_0', type: 'cereal', position: [17, 7] },
      { id: 'cheese_0', type: 'cheese', position: [17, 6] },
      { id: 'milk_0', type: 'milk', position: [19, 3] },
      { id: 'yogurt_0', type: 'yogurt', position: [19, 5] },
    ],
    orders: [
      { id: 'order_0', items_required: ['cream', 'onions', 'flour', 'cereal', 'cheese', 'milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'order_1', items_required: ['cereal', 'yogurt'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  const actions = planner.plan(state);
  const movingActions = actions.filter((action) => action.action.startsWith('move_'));

  assert.equal(movingActions.length > 0, true);
  assert.equal(planner.lastMetrics.openerBreakoutActive, true);
  assert.equal(planner.lastMetrics.teams.some((team) => team.role === 'prefetch'), false);
  for (const detail of Object.values(planner.lastMetrics.botDetails)) {
    if (detail.taskType !== 'item') continue;
    assert.notDeepEqual(detail.path, [detail.target]);
  }
});

test('team planner makes drop-off progress when full drop route is unavailable', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.profile.routing.horizon = 1;
  const state = baseState({
    bots: [
      { id: 0, position: [8, 2], inventory: ['milk'] },
      { id: 1, position: [2, 2], inventory: [] },
      { id: 2, position: [9, 2], inventory: [] },
      { id: 3, position: [10, 2], inventory: [] },
    ],
    items: [],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const actions = planner.plan(state);
  assert.equal(actions.find((action) => action.bot === 0)?.action.startsWith('move_'), true);
});

test('team planner favors active bots from the order zone before cross-zone borrowing', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  const state = baseState({
    grid: { width: 24, height: 10, walls: [] },
    bots: [
      { id: 0, position: [2, 2], inventory: [] },
      { id: 1, position: [4, 2], inventory: [] },
      { id: 2, position: [8, 2], inventory: [] },
      { id: 3, position: [12, 2], inventory: [] },
      { id: 4, position: [18, 2], inventory: [] },
      { id: 5, position: [21, 2], inventory: [] },
    ],
    items: [
      { id: 'apples_0', type: 'apples', position: [3, 3] },
      { id: 'apples_1', type: 'apples', position: [4, 4] },
      { id: 'cream_0', type: 'cream', position: [5, 3] },
      { id: 'onions_0', type: 'onions', position: [17, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['apples', 'apples', 'cream'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['onions'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
    drop_offs: [[1, 8]],
  });

  planner.plan(state);
  const activeTeam = planner.lastMetrics.teams.find((team) => team.role === 'active');
  assert.deepEqual(new Set(activeTeam.botIds.slice(0, 2)), new Set([0, 1]));
});

test('team builder preserves spawn-order blocks during initial post-opener assignment', () => {
  const profile = buildExpertProfile();
  const state = baseState({
    round: 9,
    grid: { width: 28, height: 18, walls: [] },
    bots: [
      { id: 0, position: [6, 16], inventory: [] },
      { id: 1, position: [7, 15], inventory: [] },
      { id: 2, position: [8, 16], inventory: [] },
      { id: 3, position: [10, 15], inventory: [] },
      { id: 4, position: [11, 16], inventory: [] },
      { id: 5, position: [12, 16], inventory: [] },
      { id: 6, position: [13, 16], inventory: [] },
      { id: 7, position: [14, 16], inventory: [] },
      { id: 8, position: [16, 16], inventory: [] },
      { id: 9, position: [21, 16], inventory: [] },
    ],
    items: [
      { id: 'apples_0', type: 'apples', position: [5, 3] },
      { id: 'apples_1', type: 'apples', position: [5, 4] },
      { id: 'cream_0', type: 'cream', position: [7, 3] },
      { id: 'bread_0', type: 'bread', position: [21, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['apples', 'apples', 'cream'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['bread'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const world = buildWorldContext(state);
  const zoneAssignmentByBot = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 2 };

  const teams = buildTeams({
    state,
    world,
    oracle: null,
    existingTeams: null,
    profile,
    lastOpenerRound: 8,
    zoneAssignmentByBot,
    initialBotOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  });

  const activeTeam = teams.find((team) => team.role === 'active');
  assert.deepEqual(activeTeam.botIds, [0, 1, 2]);
});
