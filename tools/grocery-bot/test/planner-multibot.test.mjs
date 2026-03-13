import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCostMatrix,
  buildTasks,
  estimateZonePenalty,
  chooseParkingAction,
} from '../src/planner/planner-multibot.mjs';
import { buildMediumMissionAssignments } from '../src/planner/planner-missions.mjs';
import { GridGraph, buildLaneMapV2, buildLaneMapV3 } from '../src/utils/grid-graph.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';
import { buildWorldContext } from '../src/utils/world-model.mjs';

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

test('chooseParkingAction prefers moving away from drop-off and away from crowded bots', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [3, 8], inventory: [] },
      { id: 1, position: [2, 8], inventory: [] },
      { id: 2, position: [4, 8], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'milk_1', type: 'milk', position: [7, 3] },
    ],
    drop_off: [1, 8],
  });
  const graph = buildGraph(state);
  const reservations = new Map();
  const edgeReservations = new Map();
  const dropOff = [1, 8];

  const result = chooseParkingAction({
    bot: state.bots[0],
    graph,
    reservations,
    edgeReservations,
    horizon: 10,
    dropOff,
    otherBots: state.bots,
    items: state.items,
    gridWidth: state.grid.width,
    gridHeight: state.grid.height,
  });

  assert.notEqual(result.action, 'wait');
});

test('chooseParkingAction targets off-lane parking when lane map v2 is active', () => {
  const state = baseState({
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [3, 8], inventory: [] },
      { id: 1, position: [2, 8], inventory: [] },
      { id: 2, position: [4, 8], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'bread_0', type: 'bread', position: [7, 3] },
    ],
    drop_off: [1, 8],
  });
  const graph = buildGraph(state);
  const laneMap = buildLaneMapV2(graph, [state.drop_off]);
  graph.trafficLaneCells = laneMap.trafficLaneCells;
  const result = chooseParkingAction({
    bot: state.bots[0],
    graph,
    reservations: new Map(),
    edgeReservations: new Map(),
    horizon: 10,
    dropOff: state.drop_off,
    otherBots: state.bots,
    items: state.items,
    gridWidth: state.grid.width,
    gridHeight: state.grid.height,
  });

  assert.notEqual(result.action, 'wait');
  assert.equal(graph.trafficLaneCells.has(result.path.at(-1).join(',')), false);
});

test('chooseParkingAction avoids feeder cells under lane map v3', () => {
  const state = baseState({
    grid: { width: 14, height: 10, walls: [] },
    bots: [
      { id: 0, position: [3, 8], inventory: [] },
      { id: 1, position: [1, 8], inventory: [] },
      { id: 2, position: [2, 7], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'bread_0', type: 'bread', position: [7, 3] },
      { id: 'eggs_0', type: 'eggs', position: [11, 3] },
    ],
    drop_off: [1, 8],
  });
  const graph = buildGraph(state);
  const laneMap = buildLaneMapV3(graph, [state.drop_off]);
  graph.trafficLaneCells = laneMap.trafficLaneCells;
  graph.directionalPreference = laneMap.directionalPreference;
  const result = chooseParkingAction({
    bot: state.bots[0],
    graph,
    reservations: new Map(),
    edgeReservations: new Map(),
    horizon: 10,
    dropOff: state.drop_off,
    otherBots: state.bots,
    items: state.items,
    gridWidth: state.grid.width,
    gridHeight: state.grid.height,
  });

  assert.notEqual(result.action, 'wait');
  const target = result.path.at(-1);
  assert.equal(target[0] <= 4 && target[1] >= 6 && target[1] <= 8, false);
  assert.equal(graph.trafficLaneCells.has(target.join(',')), false);
});

test('buildTasks suppresses preview when too many bots already carry non-active items', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['pasta'] },
      { id: 1, position: [3, 1], inventory: ['pasta'] },
      { id: 2, position: [5, 1], inventory: [] },
      { id: 3, position: [7, 1], inventory: [] },
      { id: 4, position: [9, 1], inventory: [] },
      { id: 5, position: [1, 3], inventory: [] },
      { id: 6, position: [3, 3], inventory: [] },
      { id: 7, position: [5, 3], inventory: [] },
      { id: 8, position: [7, 3], inventory: [] },
      { id: 9, position: [9, 3], inventory: [] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta', 'pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 5] },
      { id: 'pasta_0', type: 'pasta', position: [5, 5] },
      { id: 'pasta_1', type: 'pasta', position: [7, 5] },
    ],
  });

  const profile = { ...defaultProfiles.expert, assignment: { ...defaultProfiles.expert.assignment, preview_picker_cap: 2 } };
  const tasks = buildTasks(state, buildWorldContext(state), profile, 'early');
  const previewTasks = tasks.filter((task) => task.kind === 'pick_up' && task.sourceOrder === 'preview');

  assert.equal(previewTasks.length, 0, 'preview tasks should be suppressed when 2 bots already carry preview items');
});
