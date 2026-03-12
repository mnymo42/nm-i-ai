import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner/planner.mjs';
import { buildPrefetchWavePlan } from '../src/planner/planner-teams.mjs';
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
