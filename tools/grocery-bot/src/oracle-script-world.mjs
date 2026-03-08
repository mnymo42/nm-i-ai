import fs from 'node:fs';

import { encodeCoord, manhattanDistance } from './coords.mjs';
import { GridGraph } from './grid-graph.mjs';
import { findTimeAwarePath } from './routing.mjs';
import { extractLayout, parseJsonl, rebuildSnapshot } from './replay-io.mjs';

const DEFAULT_MAX_ROUNDS = 300;
const DEFAULT_MAX_TRIP_ITEMS = 2;
function buildFallbackBotStarts(oracle) {
  const blocked = new Set([
    ...buildFallbackWalls(oracle).map((wall) => encodeCoord(wall)),
    ...(oracle.items || []).map((item) => encodeCoord(item.position)),
  ]);
  const starts = [];
  for (let y = oracle.grid.height - 2; y >= 1 && starts.length < oracle.bot_count; y -= 1) {
    for (let x = oracle.grid.width - 2; x >= 1 && starts.length < oracle.bot_count; x -= 1) {
      const key = encodeCoord([x, y]);
      if (!blocked.has(key)) {
        starts.push([x, y]);
      }
    }
  }

  while (starts.length < oracle.bot_count) {
    starts.push([1, 1]);
  }
  return starts;
}

function buildFallbackWalls(oracle) {
  const width = oracle.grid.width;
  const height = oracle.grid.height;
  const walls = [];

  for (let x = 0; x < width; x += 1) {
    walls.push([x, 0], [x, height - 1]);
  }

  for (let y = 1; y < height - 1; y += 1) {
    walls.push([0, y], [width - 1, y]);
  }

  for (const shelfX of [2, 6, 10, 14, 18, 22]) {
    for (let y = 2; y <= 8; y += 1) {
      walls.push([shelfX, y]);
    }
    for (let y = 10; y <= 14; y += 1) {
      walls.push([shelfX, y]);
    }
  }

  return walls;
}

function loadReplayContext(replayPath) {
  if (!replayPath || !fs.existsSync(replayPath)) {
    return null;
  }

  const rows = parseJsonl(replayPath);
  const layout = extractLayout(rows);
  const firstTick = rows.find((row) => row.type === 'tick');
  if (!layout || !firstTick) {
    return null;
  }

  const snapshot = rebuildSnapshot(firstTick.state_snapshot, layout);
  return { layout, snapshot };
}

function buildItemsByType(items, dropOff) {
  const itemsByType = new Map();
  for (const item of items) {
    const existing = itemsByType.get(item.type) || [];
    existing.push(item);
    itemsByType.set(item.type, existing);
  }

  for (const list of itemsByType.values()) {
    list.sort((left, right) => {
      const distanceDelta = manhattanDistance(left.position, dropOff) - manhattanDistance(right.position, dropOff);
      if (distanceDelta !== 0) {
        return distanceDelta;
      }
      return left.id.localeCompare(right.id);
    });
  }

  return itemsByType;
}

export function buildOracleScriptWorld({ oracle, replayPath = null }) {
  const replayContext = loadReplayContext(replayPath);
  const dropOff = replayContext?.layout?.drop_off || oracle.drop_off;
  const dropOffs = replayContext?.layout?.drop_offs || (dropOff ? [dropOff] : []);
  const grid = replayContext?.layout?.grid || {
    width: oracle.grid.width,
    height: oracle.grid.height,
    walls: buildFallbackWalls(oracle),
  };
  const maxRounds = replayContext?.layout?.max_rounds || DEFAULT_MAX_ROUNDS;
  const botStartPositions = replayContext?.snapshot?.bots?.map((bot) => [...bot.position])
    || buildFallbackBotStarts(oracle);
  const shelfWalls = oracle.items.map((item) => item.position);
  const graph = new GridGraph({
    ...grid,
    walls: [...grid.walls, ...shelfWalls],
  });

  return {
    dropOff,
    dropOffs,
    maxRounds,
    graph,
    grid,
    botStartPositions,
    itemsByType: buildItemsByType(oracle.items, dropOff),
    oracleItemsById: new Map(oracle.items.map((item) => [item.id, item])),
  };
}

export function normalizeOracle(oracle) {
  const knownOrders = [...(oracle.known_orders || [])]
    .map((order) => ({
      ...order,
      itemCounts: countByType(order.items_required || []),
      size: (order.items_required || []).length,
    }))
    .sort((left, right) => left.first_seen_tick - right.first_seen_tick || left.id.localeCompare(right.id));

  return {
    ...oracle,
    known_orders: knownOrders,
  };
}

export function countByType(types) {
  const counts = new Map();
  for (const type of types || []) {
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

export function buildScarityTable(oracle, itemsByType) {
  const demand = new Map();
  for (const order of oracle.known_orders || []) {
    for (const type of order.items_required || []) {
      demand.set(type, (demand.get(type) || 0) + 1);
    }
  }

  const scarcity = new Map();
  for (const [type, totalDemand] of demand.entries()) {
    const supply = itemsByType.get(type)?.length || 0;
    scarcity.set(type, {
      demand: totalDemand,
      supply,
      ratio: supply === 0 ? Number.POSITIVE_INFINITY : totalDemand / supply,
    });
  }

  return scarcity;
}

export function getPickupCells(graph, itemPosition) {
  return graph.adjacentWalkableCells(itemPosition)
    .sort((left, right) => encodeCoord(left).localeCompare(encodeCoord(right)));
}

export function buildStagingCells(graph, dropOff, limit = 10) {
  const cells = [];

  for (let y = 0; y < graph.height; y += 1) {
    for (let x = 0; x < graph.width; x += 1) {
      const coord = [x, y];
      if (!graph.isWalkable(coord)) {
        continue;
      }
      if (encodeCoord(coord) === encodeCoord(dropOff)) {
        continue;
      }
      cells.push(coord);
    }
  }

  return cells
    .sort((left, right) => {
      const distanceDelta = manhattanDistance(left, dropOff) - manhattanDistance(right, dropOff);
      if (distanceDelta !== 0) {
        return distanceDelta;
      }
      return encodeCoord(left).localeCompare(encodeCoord(right));
    })
    .slice(0, limit);
}

export function reserveCell(reservations, time, coord) {
  const key = encodeCoord(coord);
  if (!reservations.has(time)) {
    reservations.set(time, new Set());
  }
  reservations.get(time).add(key);
}

export function reserveTimedPath({
  path,
  startTime,
  reservations,
  edgeReservations,
  reserveGoal = true,
  holdGoalTicks = 0,
}) {
  if (!path || path.length === 0) {
    return;
  }

  const lastReservedIndex = reserveGoal ? path.length - 1 : path.length - 2;
  for (let index = 1; index <= lastReservedIndex; index += 1) {
    const time = startTime + index;
    const fromKey = encodeCoord(path[index - 1]);
    const toKey = encodeCoord(path[index]);

    reserveCell(reservations, time, path[index]);
    if (!edgeReservations.has(time)) {
      edgeReservations.set(time, new Set());
    }
    edgeReservations.get(time).add(`${fromKey}>${toKey}`);
  }

  if (reserveGoal) {
    const goal = path[path.length - 1];
    const goalArrivalTime = startTime + path.length - 1;
    for (let offset = 1; offset <= holdGoalTicks; offset += 1) {
      reserveCell(reservations, goalArrivalTime + offset, goal);
    }
  }
}

export function reserveStationaryRange(reservations, coord, startTime, endTimeInclusive) {
  for (let time = startTime; time <= endTimeInclusive; time += 1) {
    reserveCell(reservations, time, coord);
  }
}

export function clearReservedCellRange(reservations, coord, startTime, endTimeInclusive) {
  const key = encodeCoord(coord);
  for (let time = startTime; time <= endTimeInclusive; time += 1) {
    const bucket = reservations.get(time);
    if (!bucket) {
      continue;
    }
    bucket.delete(key);
    if (bucket.size === 0) {
      reservations.delete(time);
    }
  }
}

export function findPathToAnyGoal({
  graph,
  start,
  goals,
  reservations,
  edgeReservations,
  startTime,
  horizon = 120,
  blockedNextStepCoords = null,
}) {
  const uniqueGoals = [...new Map(goals.map((goal) => [encodeCoord(goal), goal])).values()];
  const orderedGoals = uniqueGoals.sort((left, right) => {
    const distanceDelta = manhattanDistance(start, left) - manhattanDistance(start, right);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }
    return encodeCoord(left).localeCompare(encodeCoord(right));
  });

  let bestPath = null;
  for (const goal of orderedGoals) {
    const path = findTimeAwarePath({
      graph,
      start,
      goal,
      reservations,
      edgeReservations,
      startTime,
      horizon,
      blockedNextStepCoords,
    });
    if (!path) {
      continue;
    }

    if (!bestPath || path.length < bestPath.length) {
      bestPath = path;
    }
  }

  return bestPath;
}

export const oracleScriptDefaults = {
  maxTripItems: DEFAULT_MAX_TRIP_ITEMS,
  targetCutoffTick: 200,
  previewRunnerCap: 2,
  previewItemCap: 4,
  maxActiveBots: 1,
  closeNowBotCap: null,
  stageBotCap: null,
  visibleOrderDepth: 2,
  knownOrderDepth: 2,
  stageHiddenKnownOrders: false,
  futureOrderBotCap: 1,
  futureOrderItemCap: 4,
  futureOrderPerOrderItemCap: 2,
  closeOrderReserveBots: 1,
  dropLaneConcurrency: 1,
  stagingCellCount: 12,
  horizon: 120,
};
