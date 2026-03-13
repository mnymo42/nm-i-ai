import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner/planner.mjs';
import { buildTeams, executeTeamStrategy } from '../src/planner/planner-teams.mjs';
import { GridGraph } from '../src/utils/grid-graph.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';
import { buildWorldContext } from '../src/utils/world-model.mjs';

function buildExpertProfile() {
  const profile = structuredClone(defaultProfiles.expert_team_v1);
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
      { id: 1, position: [2, 8], inventory: [] },
      { id: 2, position: [3, 8], inventory: [] },
      { id: 3, position: [4, 8], inventory: [] },
    ],
    items: [],
    orders: [],
    drop_off: [1, 8],
    drop_offs: [[1, 8]],
    score: 0,
    ...overrides,
  };
}

test('team builder creates ordered queue slots from active, preview, and oracle orders', () => {
  const profile = buildExpertProfile();
  const state = baseState({
    bots: Array.from({ length: 8 }, (_, id) => ({ id, position: [id + 1, 8], inventory: [] })),
    orders: [
      { id: 'o0', items_required: ['milk', 'bread', 'eggs'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const world = buildWorldContext(state);

  const teams = buildTeams({
    state,
    world,
    oracle: {
      known_orders: [
        { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
        { id: 'o2', items_required: ['cheese'], first_seen_tick: 25 },
        { id: 'o3', items_required: ['apples'], first_seen_tick: 30 },
      ],
    },
    existingTeams: null,
    profile,
  });

  assert.deepEqual(teams.map((team) => team.orderId), ['o0', 'o1', 'o2', 'o3']);
  assert.deepEqual(teams.map((team) => team.slotIndex), [0, 1, 2, 3]);
  assert.equal(teams[0].role, 'active');
  assert.equal(teams[1].goalBand < teams[2].goalBand, true);
});

test('team builder rotates team identities inward when the front order advances', () => {
  const profile = buildExpertProfile();
  const initialState = baseState({
    bots: Array.from({ length: 8 }, (_, id) => ({ id, position: [id + 1, 8], inventory: [] })),
    orders: [
      { id: 'o0', items_required: ['milk', 'bread'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const initialWorld = buildWorldContext(initialState);
  const initialTeams = buildTeams({
    state: initialState,
    world: initialWorld,
    oracle: {
      known_orders: [
        { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
        { id: 'o2', items_required: ['cheese'], first_seen_tick: 25 },
        { id: 'o3', items_required: ['apples'], first_seen_tick: 30 },
      ],
    },
    existingTeams: null,
    profile,
  });

  const teamIdByOrder = Object.fromEntries(initialTeams.map((team) => [team.orderId, team.teamId]));
  const advancedState = baseState({
    round: 21,
    bots: initialState.bots,
    orders: [
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'active', complete: false },
      { id: 'o2', items_required: ['cheese'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const advancedWorld = buildWorldContext(advancedState);
  const rotatedTeams = buildTeams({
    state: advancedState,
    world: advancedWorld,
    oracle: {
      known_orders: [
        { id: 'o2', items_required: ['cheese'], first_seen_tick: 25 },
        { id: 'o3', items_required: ['apples'], first_seen_tick: 30 },
        { id: 'o4', items_required: ['butter'], first_seen_tick: 35 },
      ],
    },
    existingTeams: initialTeams,
    profile,
  });

  assert.equal(rotatedTeams[0].orderId, 'o1');
  assert.equal(rotatedTeams[0].teamId, teamIdByOrder.o1);
  assert.equal(rotatedTeams[1].orderId, 'o2');
  assert.equal(rotatedTeams[1].teamId, teamIdByOrder.o2);
  assert.equal(rotatedTeams[2].orderId, 'o3');
  assert.equal(rotatedTeams[2].teamId, teamIdByOrder.o3);
  assert.equal(rotatedTeams[3].orderId, 'o4');
  assert.equal(rotatedTeams[3].teamId, teamIdByOrder.o0);
});

test('team builder sizes the front slot ahead of deeper queue slots', () => {
  const profile = buildExpertProfile();
  const state = baseState({
    bots: Array.from({ length: 10 }, (_, id) => ({ id, position: [id + 1, 8], inventory: [] })),
    orders: [
      { id: 'o0', items_required: ['milk', 'bread', 'eggs', 'pasta', 'cheese', 'cream', 'butter'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['apples', 'bananas'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const world = buildWorldContext(state);

  const teams = buildTeams({
    state,
    world,
    oracle: {
      known_orders: [
        { id: 'o1', items_required: ['apples', 'bananas'], first_seen_tick: 20 },
        { id: 'o2', items_required: ['rice', 'oats'], first_seen_tick: 25 },
        { id: 'o3', items_required: ['tomatoes', 'yogurt'], first_seen_tick: 30 },
      ],
    },
    existingTeams: null,
    profile,
  });

  assert.equal(teams[0].botIds.length >= teams[1].botIds.length, true);
  assert.equal(teams[0].botIds.length >= 3, true);
  assert.equal(teams.reduce((sum, team) => sum + team.botIds.length, 0), 10);
});

test('front slot keeps the bots nearest drop-off on first assignment', () => {
  const profile = buildExpertProfile();
  const state = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: [] },
      { id: 1, position: [2, 8], inventory: [] },
      { id: 2, position: [8, 2], inventory: [] },
      { id: 3, position: [9, 2], inventory: [] },
      { id: 4, position: [10, 2], inventory: [] },
      { id: 5, position: [11, 2], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'bread', 'eggs'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const world = buildWorldContext(state);
  const teams = buildTeams({ state, world, oracle: null, existingTeams: null, profile });

  assert.deepEqual(new Set(teams[0].botIds.slice(0, 2)), new Set([0, 1]));
});

test('strict team boundaries prevent a future-slot bot from dropping active-order inventory', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.oracle = {
    known_orders: [
      { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
      { id: 'o2', items_required: ['cheese'], first_seen_tick: 25 },
    ],
  };

  const setupState = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: [] },
      { id: 1, position: [1, 8], inventory: [] },
      { id: 2, position: [8, 2], inventory: [] },
      { id: 3, position: [9, 2], inventory: [] },
      { id: 4, position: [10, 2], inventory: [] },
      { id: 5, position: [11, 2], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [8, 3] },
      { id: 'cheese_0', type: 'cheese', position: [10, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  planner.plan(setupState);

  const state = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: [] },
      { id: 1, position: [1, 8], inventory: [] },
      { id: 2, position: [8, 2], inventory: ['milk'] },
      { id: 3, position: [9, 2], inventory: [] },
      { id: 4, position: [10, 2], inventory: [] },
      { id: 5, position: [11, 2], inventory: [] },
    ],
    items: setupState.items,
    orders: setupState.orders,
  });

  const actions = planner.plan(state);

  assert.notEqual(actions.find((action) => action.bot === 2)?.action, 'drop_off');
  assert.equal(planner.lastMetrics.teams.find((team) => team.slotIndex === 1)?.botIds.includes(2), true);
});

test('future-slot bot keeps inventory for its own order until rotation makes it front slot', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.oracle = {
    known_orders: [
      { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
    ],
  };
  const state = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: [] },
      { id: 1, position: [2, 8], inventory: [] },
      { id: 2, position: [8, 2], inventory: ['pasta'] },
      { id: 3, position: [9, 2], inventory: [] },
    ],
    items: [],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  const actions = planner.plan(state);

  assert.notEqual(actions.find((action) => action.bot === 2)?.action, 'drop_off');
  assert.equal(planner.lastMetrics.botDetails['2']?.slotIndex, 1);
});

test('deeper future slots stage farther from drop-off than nearer future slots', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.oracle = {
    known_orders: [
      { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
      { id: 'o2', items_required: ['cheese'], first_seen_tick: 25 },
    ],
  };
  const state = baseState({
    bots: Array.from({ length: 6 }, (_, id) => ({ id, position: [id + 1, 8], inventory: [] })),
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [8, 3] },
      { id: 'cheese_0', type: 'cheese', position: [10, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  planner.plan(state);

  const slotOneBotId = planner.lastMetrics.teams.find((team) => team.slotIndex === 1)?.botIds[0];
  const slotTwoBotId = planner.lastMetrics.teams.find((team) => team.slotIndex === 2)?.botIds[0];
  const slotOneTarget = planner.lastMetrics.botDetails[String(slotOneBotId)]?.target;
  const slotTwoTarget = planner.lastMetrics.botDetails[String(slotTwoBotId)]?.target;
  const dropOff = state.drop_off;

  assert.equal(manhattan(slotTwoTarget, dropOff) >= manhattan(slotOneTarget, dropOff), true);
});

test('recovery mode collapses queue discipline and records slot rotation metrics', () => {
  const planner = new GroceryPlanner(buildExpertProfile());
  planner.oracle = {
    known_orders: [
      { id: 'o1', items_required: ['pasta'], first_seen_tick: 20 },
      { id: 'o2', items_required: ['cheese'], first_seen_tick: 25 },
    ],
  };

  const firstState = baseState({
    bots: Array.from({ length: 6 }, (_, id) => ({ id, position: [id + 1, 8], inventory: [] })),
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [8, 3] },
      { id: 'cheese_0', type: 'cheese', position: [10, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  planner.plan(firstState);

  const secondState = baseState({
    round: 21,
    bots: firstState.bots,
    items: firstState.items,
    orders: [
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'active', complete: false },
      { id: 'o2', items_required: ['cheese'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const graph = new GridGraph({
    ...secondState.grid,
    walls: [...secondState.grid.walls, ...secondState.items.map((item) => item.position)],
  });
  const world = buildWorldContext(secondState);

  executeTeamStrategy({
    planner,
    state: secondState,
    world,
    graph,
    phase: 'mid',
    recoveryMode: true,
    forcePartialDrop: false,
    recoveryThreshold: 20,
    blockedItemsByBot: new Map(),
    oracle: planner.oracle,
  });

  assert.equal(planner.lastMetrics.lastRotationTick, 21);
  assert.equal(planner.lastMetrics.rotatedThisTick, true);
  assert.equal(new Set(planner.lastMetrics.teams[0].botIds).size, secondState.bots.length);
});

function manhattan(left, right) {
  if (!left || !right) return -Infinity;
  return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]);
}
