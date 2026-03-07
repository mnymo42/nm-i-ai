import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFromTask,
  buildCostMatrix,
  buildTasks,
  estimateZonePenalty,
} from '../src/planner-multibot.mjs';
import { buildMediumMissionAssignments } from '../src/planner-missions.mjs';
import { GridGraph } from '../src/grid-graph.mjs';
import { defaultProfiles } from '../src/profile.mjs';
import { buildWorldContext } from '../src/world-model.mjs';

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
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

test('buildTasks does not create preview pickup tasks when preview demand is already covered by inventory', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['pasta', 'pasta', 'pasta'] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
      { id: 'pasta_1', type: 'pasta', position: [7, 3] },
    ],
  });

  const tasks = buildTasks(state, buildWorldContext(state), defaultProfiles.medium, 'early');
  const pickupTypes = tasks.filter((task) => task.kind === 'pick_up').map((task) => task.item.type);

  assert.equal(pickupTypes.includes('pasta'), false);
  assert.equal(pickupTypes.includes('milk'), true);
});

test('buildTasks caps preview pickup candidates to remaining preview demand plus small buffer', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['milk'] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
    ],
    items: [
      { id: 'pasta_0', type: 'pasta', position: [3, 3] },
      { id: 'pasta_1', type: 'pasta', position: [5, 3] },
      { id: 'pasta_2', type: 'pasta', position: [7, 3] },
      { id: 'pasta_3', type: 'pasta', position: [9, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  const tasks = buildTasks(state, buildWorldContext(state), defaultProfiles.medium, 'early');
  const pastaTasks = tasks.filter((task) => task.kind === 'pick_up' && task.item.type === 'pasta');

  assert.equal(pastaTasks.length <= 2, true);
});

test('buildCostMatrix quarantines blocked pickup items per bot', () => {
  const state = baseState({
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'milk_0', type: 'milk', position: [3, 3] }],
  });
  const tasks = [{
    key: 'item:milk_0',
    kind: 'pick_up',
    target: [3, 3],
    item: { id: 'milk_0', type: 'milk', position: [3, 3] },
    botScoped: false,
    demandScore: 1,
    sourceOrder: 'active',
  }];

  const matrix = buildCostMatrix(state, tasks, defaultProfiles.medium, 'early', {
    blockedItemsByBot: new Map([[0, new Map([['milk_0', 4]])]]),
  });

  assert.equal(matrix[0][0], 1e9);
});

test('estimateZonePenalty prefers same-zone preview picking', () => {
  const state = baseState({
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [6, 1], inventory: [] },
      { id: 1, position: [6, 1], inventory: [] },
      { id: 2, position: [6, 1], inventory: [] },
    ],
  });
  const task = {
    key: 'item:pasta_0',
    kind: 'pick_up',
    target: [1, 3],
    item: { id: 'pasta_0', type: 'pasta', position: [1, 3] },
    botScoped: false,
    demandScore: 1,
    sourceOrder: 'preview',
  };

  const leftPenalty = estimateZonePenalty({ bot: state.bots[0], task, state, profile: defaultProfiles.medium });
  const rightPenalty = estimateZonePenalty({ bot: state.bots[2], task, state, profile: defaultProfiles.medium });

  assert.equal(leftPenalty < rightPenalty, true);
});

test('buildMediumMissionAssignments reserves active demand so only one bot targets a single missing unit', () => {
  const state = baseState({
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'milk_1', type: 'milk', position: [7, 3] },
    ],
  });

  const missionPlan = buildMediumMissionAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });

  const activeMissions = [...missionPlan.missionsByBot.values()].filter((mission) => mission.missionType === 'collect_active');
  assert.equal(activeMissions.length, 1);
  assert.equal(missionPlan.metrics.activeMissionsAssigned, 1);
});

test('buildMediumMissionAssignments suppresses preview missions while active demand is still uncovered', () => {
  const state = baseState({
    orders: [
      { id: 'o0', items_required: ['milk', 'milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
    ],
  });

  const missionPlan = buildMediumMissionAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });

  const previewMissions = [...missionPlan.missionsByBot.values()].filter((mission) => mission.missionType === 'collect_preview');
  assert.equal(previewMissions.length, 0);
  assert.equal(missionPlan.metrics.previewSuppressed, true);
});

test('buildMediumMissionAssignments invalidates carried-over preview mission when active demand is uncovered', () => {
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
      missionType: 'collect_preview',
      orderId: 'o0',
      targetItemId: 'pasta_0',
      targetType: 'pasta',
      zoneId: 0,
      targetCell: null,
      assignedAtRound: 0,
      lastProgressRound: 0,
      ttl: 6,
      noPathRounds: 0,
    }],
  ]);

  const missionPlan = buildMediumMissionAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 1,
    existingMissionsByBot,
  });

  assert.notEqual(missionPlan.missionsByBot.get(0).missionType, 'collect_preview');
  assert.equal(missionPlan.missionsByBot.get(0).missionType, 'collect_active');
  assert.equal(missionPlan.metrics.activeMissionsAssigned >= 1, true);
});

test('buildMediumMissionAssignments allows only one preview mission in medium', () => {
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

  const missionPlan = buildMediumMissionAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });

  const previewMissions = [...missionPlan.missionsByBot.values()].filter((mission) => mission.missionType === 'collect_preview');
  assert.equal(previewMissions.length, 1);
  assert.equal(missionPlan.metrics.previewMissionsAssigned, 1);
});

test('buildMediumMissionAssignments prioritizes drop missions for bots carrying active deliverables', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [6, 4], inventory: ['milk', 'bread'] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'bread'], items_delivered: [], status: 'active', complete: false },
    ],
  });

  const missionPlan = buildMediumMissionAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });

  assert.equal(missionPlan.missionsByBot.get(0).missionType, 'drop_active');
  assert.equal(missionPlan.metrics.dropMissionsAssigned >= 1, true);
});

test('actionFromTask avoids an occupied pickup service bay when another adjacent bay is available', () => {
  const graph = new GridGraph({ width: 5, height: 5, walls: [] });
  const task = {
    key: 'item:milk_0',
    kind: 'pick_up',
    target: [2, 1],
    item: { id: 'milk_0', type: 'milk', position: [2, 1] },
    botScoped: false,
    demandScore: 1,
    sourceOrder: 'active',
  };

  const resolved = actionFromTask({
    bot: { id: 0, position: [0, 1], inventory: [] },
    task,
    graph,
    reservations: new Map(),
    edgeReservations: new Map(),
    profile: defaultProfiles.medium,
    holdGoalSteps: defaultProfiles.medium.routing.hold_goal_steps,
    blockedNextStepCoords: new Set(['1,1']),
    blockedServiceBayCoords: new Set(['1,1']),
  });

  assert.notEqual(resolved.action, 'wait');
  assert.notEqual(resolved.action, 'move_right');
});

test('actionFromTask waits when the only pickup service bay is occupied', () => {
  const graph = new GridGraph({
    width: 5,
    height: 5,
    walls: [
      [2, 0],
      [2, 2],
      [3, 1],
    ],
  });
  const task = {
    key: 'item:milk_0',
    kind: 'pick_up',
    target: [2, 1],
    item: { id: 'milk_0', type: 'milk', position: [2, 1] },
    botScoped: false,
    demandScore: 1,
    sourceOrder: 'active',
  };

  const resolved = actionFromTask({
    bot: { id: 0, position: [0, 1], inventory: [] },
    task,
    graph,
    reservations: new Map(),
    edgeReservations: new Map(),
    profile: defaultProfiles.medium,
    holdGoalSteps: defaultProfiles.medium.routing.hold_goal_steps,
    blockedNextStepCoords: new Set(['1,1']),
    blockedServiceBayCoords: new Set(['1,1']),
  });

  assert.equal(resolved.action, 'wait');
});

test('buildMediumMissionAssignments disables preview missions in endgame cutoff window', () => {
  const state = baseState({
    round: 270,
    orders: [
      { id: 'o0', items_required: [], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'pasta_0', type: 'pasta', position: [3, 3] },
    ],
  });

  const missionPlan = buildMediumMissionAssignments({
    state,
    world: buildWorldContext(state),
    graph: buildGraph(state),
    profile: defaultProfiles.medium,
    phase: 'endgame',
    round: 270,
  });

  const previewMissions = [...missionPlan.missionsByBot.values()].filter((mission) => mission.missionType === 'collect_preview');
  assert.equal(previewMissions.length, 0);
  assert.equal(missionPlan.metrics.previewSuppressed, true);
});

test('buildMediumMissionAssignments prefers same-zone preview item and falls back cross-zone when needed', () => {
  const localState = baseState({
    orders: [
      { id: 'o0', items_required: [], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'pasta_local', type: 'pasta', position: [1, 3] },
      { id: 'pasta_far', type: 'pasta', position: [11, 3] },
    ],
  });

  const localPlan = buildMediumMissionAssignments({
    state: localState,
    world: buildWorldContext(localState),
    graph: buildGraph(localState),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });
  assert.equal(localPlan.missionsByBot.get(0).targetItemId, 'pasta_local');

  const fallbackState = baseState({
    orders: [
      { id: 'o0', items_required: [], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'pasta_far', type: 'pasta', position: [11, 3] },
    ],
  });

  const fallbackPlan = buildMediumMissionAssignments({
    state: fallbackState,
    world: buildWorldContext(fallbackState),
    graph: buildGraph(fallbackState),
    profile: defaultProfiles.medium,
    phase: 'early',
    round: 0,
  });
  assert.equal(fallbackPlan.missionsByBot.get(0).targetItemId, 'pasta_far');
});
