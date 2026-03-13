import test from 'node:test';
import assert from 'node:assert/strict';

import { GridGraph, buildLaneMapV2, buildLaneMapV3 } from '../src/utils/grid-graph.mjs';
import { findTimeAwarePath } from '../src/routing/routing.mjs';

test('findTimeAwarePath returns a direct path when no reservations exist', () => {
  const graph = new GridGraph({ width: 4, height: 3, walls: [] });
  const reservations = new Map();

  const path = findTimeAwarePath({
    graph,
    start: [0, 0],
    goal: [2, 0],
    reservations,
    startTime: 0,
    horizon: 10,
  });

  assert.deepEqual(path, [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
});

test('findTimeAwarePath avoids reserved cells at reserved timesteps', () => {
  const graph = new GridGraph({ width: 4, height: 3, walls: [] });
  const reservations = new Map([[1, new Set(['1,0'])]]);

  const path = findTimeAwarePath({
    graph,
    start: [0, 0],
    goal: [2, 0],
    reservations,
    startTime: 0,
    horizon: 10,
  });

  assert.equal(path[0][0], 0);
  assert.equal(path[0][1], 0);
  assert.equal(path[path.length - 1][0], 2);
  assert.equal(path[path.length - 1][1], 0);
  assert.notDeepEqual(path[1], [1, 0]);
});

test('findTimeAwarePath does not step into a currently occupied next-step cell', () => {
  const graph = new GridGraph({ width: 4, height: 3, walls: [] });
  const reservations = new Map();

  const path = findTimeAwarePath({
    graph,
    start: [0, 1],
    goal: [2, 1],
    reservations,
    startTime: 0,
    horizon: 10,
    blockedNextStepCoords: new Set(['1,1']),
  });

  assert.equal(path[0][0], 0);
  assert.equal(path[0][1], 1);
  assert.equal(path[path.length - 1][0], 2);
  assert.equal(path[path.length - 1][1], 1);
  assert.notDeepEqual(path[1], [1, 1]);
});

test('buildLaneMapV2 marks center lane and shelf aisles as one-way traffic', () => {
  const walls = [];
  for (let y = 1; y <= 6; y += 1) {
    walls.push([2, y], [6, y]);
  }
  const graph = new GridGraph({ width: 10, height: 8, walls });
  const laneMap = buildLaneMapV2(graph, [[1, 6]]);

  assert.deepEqual(laneMap.oneWayRoads['7,4'], ['left']);
  assert.deepEqual(laneMap.oneWayRoads['1,4'], ['right']);
  assert.deepEqual(laneMap.oneWayRoads['3,3'], ['down']);
  assert.equal(laneMap.trafficLaneCells.has('7,4'), true);
  assert.equal(laneMap.trafficLaneCells.has('3,3'), true);
});

test('buildLaneMapV3 adds a convection return row and return spine', () => {
  const walls = [];
  for (let y = 1; y <= 6; y += 1) {
    walls.push([2, y], [6, y], [10, y]);
  }
  const graph = new GridGraph({ width: 14, height: 10, walls });
  const laneMap = buildLaneMapV3(graph, [[1, 8]]);

  assert.deepEqual(laneMap.oneWayRoads['5,7'], ['right']);
  assert.deepEqual(laneMap.oneWayRoads['3,4'], ['down']);
  assert.deepEqual(laneMap.oneWayRoads['11,4'], ['up']);
  assert.equal(laneMap.trafficLaneCells.has('5,7'), true);
});

test('GridGraph neighbors enforce one-way movement on lane cells', () => {
  const walls = [];
  for (let y = 1; y <= 6; y += 1) {
    walls.push([2, y], [6, y], [10, y]);
  }
  const baseGraph = new GridGraph({ width: 14, height: 10, walls });
  const laneMap = buildLaneMapV3(baseGraph, [[1, 8]]);
  const graph = new GridGraph({
    width: 14,
    height: 10,
    walls,
    oneWayRoads: laneMap.oneWayRoads,
  });

  assert.deepEqual(graph.neighbors([5, 7]), [[6, 7]]);
  assert.deepEqual(graph.neighbors([11, 4]), [[11, 3]]);
});
