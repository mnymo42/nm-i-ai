import test from 'node:test';
import assert from 'node:assert/strict';

import { GridGraph } from '../src/utils/grid-graph.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';
import {
  buildWarehouseAssignments,
  buildWarehouseControlContext,
} from '../src/planner/planner-warehouse.mjs';
import { buildWorldContext } from '../src/utils/world-model.mjs';

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [5, 1], inventory: [] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    items: [],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
    score: 0,
    ...overrides,
  };
}

function buildGraph(state) {
  return new GridGraph({
    ...state.grid,
    walls: [...state.grid.walls],
  });
}

test('warehouse control blocks preview release while active demand is uncovered', () => {
  const state = baseState({
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
    ],
  });

  const control = buildWarehouseControlContext({
    state,
    world: buildWorldContext(state),
    profile: defaultProfiles.medium,
  });

  assert.equal(control.mode, 'close_active_order');
  assert.equal(control.previewAllowed, false);
  assert.equal(control.activeDemandRemaining, 1);
});

test('warehouse control keeps closing the active order when demand is fully covered by held inventory', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['milk'] },
      { id: 1, position: [5, 1], inventory: [] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    items: [
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
    ],
  });

  const control = buildWarehouseControlContext({
    state,
    world: buildWorldContext(state),
    profile: defaultProfiles.medium,
  });

  assert.equal(control.activeDemandTotal, 1);
  assert.equal(control.activeDemandHeldRemaining, 0);
  assert.equal(control.deliverableHeldCount, 1);
  assert.equal(control.mode, 'close_active_order');
  assert.equal(control.previewAllowed, false);
});

test('warehouse control enters close_if_feasible in late game and partial_cashout when close is infeasible', () => {
  const feasibleState = baseState({
    round: 296,
    drop_off: [1, 1],
    bots: [
      { id: 0, position: [1, 2], inventory: [] },
      { id: 1, position: [5, 1], inventory: [] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [2, 2] },
    ],
  });

  const feasible = buildWarehouseControlContext({
    state: feasibleState,
    world: buildWorldContext(feasibleState),
    profile: defaultProfiles.medium,
  });
  assert.equal(feasible.mode, 'close_if_feasible');

  const infeasibleState = baseState({
    round: 296,
    items: [
      { id: 'milk_0', type: 'milk', position: [11, 8] },
    ],
  });
  const infeasible = buildWarehouseControlContext({
    state: infeasibleState,
    world: buildWorldContext(infeasibleState),
    profile: defaultProfiles.medium,
  });
  assert.equal(infeasible.mode, 'partial_cashout');
});

test('warehouse control disables preview in late game once active demand is already covered', () => {
  const state = baseState({
    round: 275,
    bots: [
      { id: 0, position: [1, 1], inventory: ['milk'] },
      { id: 1, position: [5, 1], inventory: [] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
    ],
  });

  const control = buildWarehouseControlContext({
    state,
    world: buildWorldContext(state),
    profile: defaultProfiles.medium,
  });

  assert.equal(control.mode, 'stop_preview');
  assert.equal(control.previewAllowed, false);
});

test('warehouse control raises active runner cap during close mode when configured', () => {
  const profile = JSON.parse(JSON.stringify(defaultProfiles.expert));
  const state = baseState({
    bots: Array.from({ length: 10 }, (_, id) => ({ id, position: [1 + id, 1], inventory: [] })),
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'milk_1', type: 'milk', position: [5, 3] },
      { id: 'milk_2', type: 'milk', position: [7, 3] },
      { id: 'milk_3', type: 'milk', position: [9, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'milk'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const control = buildWarehouseControlContext({
    state,
    world: buildWorldContext(state),
    profile,
  });

  assert.equal(control.mode, 'close_active_order');
  assert.equal(control.activeRunnerCap, 5);
});

test('warehouse assignments reserve active demand so only one bot targets a single missing unit', () => {
  const state = baseState({
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'milk_1', type: 'milk', position: [9, 3] },
    ],
  });

  const plan = buildWarehouseAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });

  const activePickups = [...plan.missionsByBot.values()].filter((mission) => mission.missionType === 'pickup_active');
  assert.equal(activePickups.length, 1);
  assert.equal(plan.metrics.activeMissionsAssigned, 1);
});

test('warehouse control does not allow preview mode when active demand is only covered by assigned missions', () => {
  const state = baseState({
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
    ],
  });

  const existingMissionsByBot = new Map([
    [0, {
      missionType: 'pickup_active',
      orderId: 'o0',
      targetItemId: 'milk_0',
      targetType: 'milk',
      targetCell: [2, 3],
      serviceCell: [2, 3],
      queueCell: null,
      queueFor: null,
      zoneId: 0,
      assignedAtRound: 0,
      lastProgressRound: 0,
      ttl: 6,
      noPathRounds: 0,
    }],
  ]);

  const control = buildWarehouseControlContext({
    state,
    world: buildWorldContext(state),
    profile: defaultProfiles.medium,
    existingMissionsByBot,
  });

  assert.equal(control.activeDemandHeldRemaining, 1);
  assert.equal(control.previewAllowed, false);
  assert.notEqual(control.mode, 'limited_preview_prefetch');
});

test('warehouse assignments cap preview to one runner in medium', () => {
  const state = baseState({
    orders: [
      { id: 'o0', items_required: [], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta', 'pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'pasta_0', type: 'pasta', position: [1, 3] },
      { id: 'pasta_1', type: 'pasta', position: [5, 3] },
      { id: 'pasta_2', type: 'pasta', position: [9, 3] },
    ],
  });

  const plan = buildWarehouseAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });

  const previewMissions = [...plan.missionsByBot.values()].filter((mission) => mission.missionType === 'pickup_preview');
  assert.equal(previewMissions.length, 1);
  assert.equal(plan.metrics.previewMissionsAssigned, 1);
});

test('warehouse assignments create a queue mission behind an occupied drop bay and promote it when the bay clears', () => {
  const queuedState = baseState({
    bots: [
      { id: 0, position: [1, 8], inventory: ['milk'] },
      { id: 1, position: [2, 8], inventory: ['milk'] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'milk'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const queuedPlan = buildWarehouseAssignments({
    state: queuedState,
    world: buildWorldContext(queuedState),
    graph: buildGraph(queuedState),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });
  assert.equal(queuedPlan.missionsByBot.get(0).missionType, 'drop_active');
  assert.equal(queuedPlan.missionsByBot.get(1).missionType, 'queue_service_bay');
  assert.equal(queuedPlan.missionsByBot.get(1).queueFor, 'drop_active');

  const promotedState = baseState({
    round: 1,
    bots: [
      { id: 0, position: [3, 8], inventory: [] },
      { id: 1, position: [2, 8], inventory: ['milk'] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const promotedPlan = buildWarehouseAssignments({
    state: promotedState,
    world: buildWorldContext(promotedState),
    graph: buildGraph(promotedState),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 1,
    existingMissionsByBot: queuedPlan.missionsByBot,
  });
  assert.equal(promotedPlan.missionsByBot.get(1).missionType, 'drop_active');
});

test('warehouse assignments do not keep reposition missions sticky once real work should be reconsidered', () => {
  const state = baseState({
    round: 2,
    items: [
      { id: 'milk_0', type: 'milk', position: [2, 3] },
    ],
  });

  const existingMissionsByBot = new Map([
    [0, {
      missionType: 'reposition_zone',
      orderId: 'o0',
      targetItemId: null,
      targetType: null,
      targetCell: [1, 4],
      serviceCell: null,
      queueCell: null,
      queueFor: null,
      zoneId: 0,
      assignedAtRound: 0,
      lastProgressRound: 1,
      ttl: 6,
      noPathRounds: 0,
    }],
  ]);

  const plan = buildWarehouseAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 2,
    existingMissionsByBot,
  });

  assert.equal(plan.missionsByBot.get(0).missionType, 'pickup_active');
});

test('warehouse assignments choose an alternate active item instead of queueing a blocked shelf in close mode', () => {
  const profile = JSON.parse(JSON.stringify(defaultProfiles.expert));
  const state = baseState({
    grid: { width: 14, height: 10, walls: [[3, 2], [3, 4], [4, 3]] },
    bots: [
      { id: 0, position: [2, 3], inventory: ['a', 'b', 'c'] },
      { id: 1, position: [5, 1], inventory: [] },
      { id: 2, position: [9, 1], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'milk_1', type: 'milk', position: [9, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const plan = buildWarehouseAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile,
    phase: 'early',
    round: 0,
  });

  const botOneMission = plan.missionsByBot.get(1);
  assert.equal(botOneMission.missionType, 'pickup_active');
  assert.equal(botOneMission.targetItemId, 'milk_1');
});

test('warehouse assignments prefer in-zone active supply and borrow cross-zone only when needed', () => {
  const localState = baseState({
    items: [
      { id: 'milk_local', type: 'milk', position: [1, 3] },
      { id: 'milk_far', type: 'milk', position: [11, 3] },
    ],
  });
  const localPlan = buildWarehouseAssignments({
    state: localState,
    world: buildWorldContext(localState),
    graph: buildGraph(localState),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });
  assert.equal(localPlan.missionsByBot.get(0).targetItemId, 'milk_local');

  const borrowedState = baseState({
    items: [
      { id: 'milk_far', type: 'milk', position: [11, 3] },
    ],
  });
  const borrowedPlan = buildWarehouseAssignments({
    state: borrowedState,
    world: buildWorldContext(borrowedState),
    graph: buildGraph(borrowedState),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });
  assert.equal(borrowedPlan.missionsByBot.get(0).targetItemId, 'milk_far');
});

test('warehouse control caps simultaneous active runners for high-bot release control', () => {
  const profile = structuredClone(defaultProfiles.expert);
  profile.runtime.active_runner_cap = 2;
  profile.runtime.close_mode_active_runner_cap = 2;
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [2, 1], inventory: [] },
      { id: 2, position: [3, 1], inventory: [] },
      { id: 3, position: [4, 1], inventory: [] },
      { id: 4, position: [5, 1], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'bread', 'eggs', 'juice'], items_delivered: [], status: 'active', complete: false },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [1, 3] },
      { id: 'bread_0', type: 'bread', position: [3, 3] },
      { id: 'eggs_0', type: 'eggs', position: [5, 3] },
      { id: 'juice_0', type: 'juice', position: [7, 3] },
    ],
  });

  const plan = buildWarehouseAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile,
    phase: 'early',
    round: 0,
  });

  const activeRunnerCount = [...plan.missionsByBot.values()].filter((mission) => (
    mission.missionType === 'pickup_active'
    || (mission.missionType === 'queue_service_bay' && mission.queueFor === 'pickup_active')
  )).length;
  assert.equal(activeRunnerCount, 2);
  assert.equal(plan.metrics.activeRunnerCap, 2);
});

test('warehouse assignments reserve distinct reposition targets for overflow bots', () => {
  const profile = structuredClone(defaultProfiles.expert);
  profile.runtime.active_runner_cap = 0;
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [1, 1], inventory: [] },
      { id: 2, position: [1, 1], inventory: [] },
      { id: 3, position: [1, 1], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [9, 3] },
    ],
  });

  const plan = buildWarehouseAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile,
    phase: 'early',
    round: 0,
  });

  const repositionTargets = [...plan.missionsByBot.values()]
    .filter((mission) => mission.missionType === 'reposition_zone')
    .map((mission) => `${mission.targetCell[0]},${mission.targetCell[1]}`);

  assert.equal(new Set(repositionTargets).size, repositionTargets.length);
});
