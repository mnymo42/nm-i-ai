/**
 * Team-based bot assignment strategy (team_v1).
 * Builds persistent queue slots that rotate inward as orders advance.
 * Slot 0 fulfills the active order near drop-off.
 * Higher slots stage future orders progressively farther from drop-off.
 */
import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from '../utils/coords.mjs';
import { findTimeAwarePath, reservePath } from '../routing/routing.mjs';
import { buildDemand, countInventoryByType } from '../utils/world-model.mjs';
import {
  hasDeliverableInventory,
  nearestDropOff,
  isAtAnyDropOff,
  closestAdjacentCell,
  primaryDropOff,
} from './planner-utils.mjs';
import {
  sumCounts,
  reserveInventoryForDemand,
  zoneIndexForX,
} from './planner-multibot-common.mjs';
import {
  makeOccupancyReservations,
  chooseFallbackAction,
  chooseParkingAction,
} from './planner-multibot.mjs';

function countRemainingDemand(demand) {
  return Array.from(demand.values()).reduce((sum, count) => sum + Math.max(0, count), 0);
}

function cloneCounts(map) {
  return new Map(Array.from(map.entries()).map(([key, value]) => [key, value]));
}

// ─── Team data structure ────────────────────────────────────────────

/**
 * @typedef {Object} Team
 * @property {number} teamId
 * @property {string|null} orderId
 * @property {number[]} botIds
 * @property {'active'|'prefetch'|'idle'} role
 * @property {number} assignedAtTick
 * @property {number} slotIndex
 * @property {number} goalBand
 */

// ─── Team building ──────────────────────────────────────────────────

/**
 * Find upcoming orders from oracle that are not yet active/preview.
 */
function getUpcomingOracleOrders(oracle, currentTick, activeOrderId, previewOrderId, lookahead) {
  if (!oracle?.known_orders) return [];
  const knownIds = new Set();
  if (activeOrderId) knownIds.add(activeOrderId);
  if (previewOrderId) knownIds.add(previewOrderId);

  return oracle.known_orders
    .filter((o) => !knownIds.has(o.id) && o.first_seen_tick >= currentTick && o.first_seen_tick <= currentTick + lookahead)
    .sort((a, b) => a.first_seen_tick - b.first_seen_tick);
}

/**
 * Compute item cluster center for an order's required items on the grid.
 */
function orderItemClusterCenter(order, items) {
  const typeSet = new Set(order.items_required || []);
  const matching = items.filter((it) => typeSet.has(it.type));
  if (matching.length === 0) return null;

  const sumX = matching.reduce((s, it) => s + it.position[0], 0);
  const sumY = matching.reduce((s, it) => s + it.position[1], 0);
  return [Math.round(sumX / matching.length), Math.round(sumY / matching.length)];
}

export function analyzeActiveDemandCoverage({ state, world, threshold = 2, requireCoverage = true }) {
  const inventoryCounts = countInventoryByType(state.bots);
  const uncoveredDemand = cloneCounts(world.activeDemand);
  const coveredDemand = new Map();

  for (const [type, demand] of world.activeDemand.entries()) {
    const held = inventoryCounts.get(type) || 0;
    const covered = Math.min(demand, held);
    coveredDemand.set(type, covered);
    uncoveredDemand.set(type, Math.max(0, demand - covered));
  }

  const remainingItems = countRemainingDemand(uncoveredDemand);
  const activeCoverageSatisfied = Array.from(uncoveredDemand.values()).every((count) => count <= 0);
  const prefetchBlockedByActiveDemand = requireCoverage
    ? (!activeCoverageSatisfied && remainingItems > threshold)
    : remainingItems > threshold;

  return {
    activeCoverageSatisfied,
    prefetchBlockedByActiveDemand,
    remainingItems,
    uncoveredDemand,
    coveredDemand,
  };
}

function mergeDemandCounts(target, demand) {
  for (const [type, count] of demand.entries()) {
    target.set(type, (target.get(type) || 0) + count);
  }
}

function zoneDistance(zoneA, zoneB) {
  return Math.abs((zoneA ?? 0) - (zoneB ?? 0));
}

function sortItemsForBotZone(items, botZoneId, zoneCount, gridWidth, origin) {
  return [...items].sort((left, right) => {
    const leftZone = zoneIndexForX(left.position[0], gridWidth, zoneCount);
    const rightZone = zoneIndexForX(right.position[0], gridWidth, zoneCount);
    const leftZoneDistance = zoneDistance(leftZone, botZoneId);
    const rightZoneDistance = zoneDistance(rightZone, botZoneId);
    if (leftZoneDistance !== rightZoneDistance) {
      return leftZoneDistance - rightZoneDistance;
    }

    const leftDistance = manhattanDistance(origin, left.position);
    const rightDistance = manhattanDistance(origin, right.position);
    return leftDistance - rightDistance;
  });
}

export function buildPrefetchWavePlan({
  state,
  world,
  oracle,
  lookahead,
  orderCount = 3,
  prefetchBlockedByActiveDemand = true,
}) {
  const upcomingOrders = getUpcomingOracleOrders(
    oracle,
    state.round,
    world.activeOrder?.id,
    world.previewOrder?.id,
    lookahead,
  );
  const waveOrders = [];
  if (world.activeOrder) waveOrders.push(world.activeOrder);
  if (world.previewOrder && waveOrders.length < orderCount) waveOrders.push(world.previewOrder);
  for (const order of upcomingOrders) {
    if (waveOrders.length >= orderCount) break;
    if (waveOrders.some((existing) => existing.id === order.id)) continue;
    waveOrders.push(order);
  }

  const waveDemand = new Map();
  for (const order of waveOrders.slice(1)) {
    mergeDemandCounts(waveDemand, buildDemand(order));
  }

  const inventoryCounts = countInventoryByType(state.bots);
  const reservedFutureCounts = new Map();
  for (const [type, count] of waveDemand.entries()) {
    const remaining = Math.max(0, count - (inventoryCounts.get(type) || 0));
    if (remaining > 0) reservedFutureCounts.set(type, remaining);
  }

  return {
    waveOrderIds: waveOrders.map((order) => order.id),
    waveOrders,
    reservedFutureCounts,
    wavePickupEnabled: !prefetchBlockedByActiveDemand && reservedFutureCounts.size > 0,
  };
}

function buildTeamOrderQueue({ world, oracle, round, lookahead, maxFutureOrders }) {
  const queue = [];
  if (world.activeOrder) queue.push(world.activeOrder);
  if (world.previewOrder) queue.push(world.previewOrder);

  const upcomingOrders = getUpcomingOracleOrders(
    oracle,
    round,
    world.activeOrder?.id,
    world.previewOrder?.id,
    lookahead,
  );

  for (const order of upcomingOrders) {
    if (queue.length >= (1 + maxFutureOrders)) break;
    if (queue.some((existing) => existing.id === order.id)) continue;
    queue.push(order);
  }

  return queue;
}

function buildKnownTeamOrderQueue({ world, oracle, round, lookahead }) {
  const queue = [];
  if (world.activeOrder) queue.push(world.activeOrder);
  if (world.previewOrder) queue.push(world.previewOrder);

  const upcomingOrders = getUpcomingOracleOrders(
    oracle,
    round,
    world.activeOrder?.id,
    world.previewOrder?.id,
    lookahead,
  );

  for (const order of upcomingOrders) {
    if (queue.some((existing) => existing.id === order.id)) continue;
    queue.push(order);
  }

  return queue;
}

function computeFutureSlotCap(order, inventoryCounts = new Map()) {
  const { remainingDemand } = reserveInventoryForDemand(inventoryCounts, orderDemandForTeam(order));
  return Math.max(1, Math.ceil(countRemainingDemand(remainingDemand) / 3));
}

function computeDesiredSlotSizes({ queueOrders, world, botCount, activeMinBots, existingTeams = [], botById = new Map() }) {
  if (queueOrders.length === 0 || botCount <= 0) {
    return [];
  }

  const teams = Array.isArray(existingTeams) ? existingTeams : [];

  const activeDemandCount = sumCounts(world.activeDemand || new Map());
  const desiredFront = Math.min(botCount, Math.max(activeMinBots, Math.ceil(activeDemandCount / 3)));
  const futureOrders = queueOrders.slice(1);
  const maxFutureSlots = Math.min(futureOrders.length, Math.max(0, botCount - desiredFront));

  const sizes = [desiredFront];
  let remaining = botCount - desiredFront;

  for (let i = 0; i < maxFutureSlots; i += 1) {
    sizes.push(1);
    remaining -= 1;
  }

  const existingTeamByOrderId = new Map(
    teams
      .filter((team) => team?.orderId != null)
      .map((team) => [team.orderId, team]),
  );
  const desiredCaps = [
    desiredFront,
    ...futureOrders.slice(0, maxFutureSlots).map((order) =>
      computeFutureSlotCap(order, teamInventoryCounts(existingTeamByOrderId.get(order.id) || { botIds: [] }, botById))),
  ];

  let madeProgress = true;
  while (remaining > 0 && madeProgress) {
    madeProgress = false;
    for (let slotIndex = 0; slotIndex < sizes.length && remaining > 0; slotIndex += 1) {
      if (sizes[slotIndex] >= desiredCaps[slotIndex]) continue;
      sizes[slotIndex] += 1;
      remaining -= 1;
      madeProgress = true;
    }
  }

  let nextFutureOrderIndex = maxFutureSlots;
  while (remaining > 0 && nextFutureOrderIndex < futureOrders.length) {
    sizes.push(1);
    remaining -= 1;
    nextFutureOrderIndex += 1;
  }

  while (remaining > 0) {
    for (let slotIndex = sizes.length - 1; slotIndex >= 0 && remaining > 0; slotIndex -= 1) {
      sizes[slotIndex] += 1;
      remaining -= 1;
    }
  }

  return sizes;
}

function makeInitialRank(allBotIds, botById, initialBotOrder, dropOff) {
  const rankMap = new Map();
  if (Array.isArray(initialBotOrder) && initialBotOrder.length > 0) {
    initialBotOrder.forEach((id, index) => rankMap.set(id, index));
  }

  return [...allBotIds].sort((aId, bId) => {
    const aBot = botById.get(aId);
    const bBot = botById.get(bId);
    const aDist = dropOff ? manhattanDistance(aBot.position, dropOff) : aId;
    const bDist = dropOff ? manhattanDistance(bBot.position, dropOff) : bId;
    if (aDist !== bDist) return aDist - bDist;
    const aRank = rankMap.get(aId) ?? aId;
    const bRank = rankMap.get(bId) ?? bId;
    return aRank - bRank;
  });
}

function orderDemandForTeam(order) {
  return order ? buildDemand(order) : new Map();
}

function teamInventoryCounts(team, botById) {
  const counts = new Map();
  for (const botId of team.botIds || []) {
    const bot = botById.get(botId);
    if (!bot) continue;
    for (const itemType of bot.inventory || []) {
      counts.set(itemType, (counts.get(itemType) || 0) + 1);
    }
  }
  return counts;
}

function reserveTeamInventoryForOrder(team, order, botById) {
  const inventoryCounts = teamInventoryCounts(team, botById);
  return reserveInventoryForDemand(inventoryCounts, orderDemandForTeam(order)).remainingDemand;
}

function countRelevantInventory(bot, orderDemand) {
  if (!bot) return 0;
  const localDemand = cloneCounts(orderDemand);
  let relevant = 0;
  for (const itemType of bot.inventory || []) {
    const remaining = localDemand.get(itemType) || 0;
    if (remaining <= 0) continue;
    relevant += 1;
    localDemand.set(itemType, remaining - 1);
  }
  return relevant;
}

function inventoryFullyRelevant(bot, orderDemand) {
  return (bot.inventory || []).length > 0
    && countRelevantInventory(bot, orderDemand) === (bot.inventory || []).length;
}

function chooseTeamStageGoal({ team, targetOrder, state, graph, maxSlotIndex }) {
  const dropOff = primaryDropOff(state);
  const cluster = orderItemClusterCenter(targetOrder, state.items);
  if (!dropOff && !cluster) return null;

  const anchor = cluster || dropOff;
  if (!anchor) return null;

  if (team.slotIndex === 0 || !dropOff || !cluster || maxSlotIndex <= 0) {
    return findNearestWalkableGoal(anchor, state, graph);
  }

  const factor = Math.min(0.95, Math.max(0.2, team.slotIndex / maxSlotIndex));
  const goal = [
    Math.round(dropOff[0] + (cluster[0] - dropOff[0]) * factor),
    Math.round(dropOff[1] + (cluster[1] - dropOff[1]) * factor),
  ];
  return findNearestWalkableGoal(goal, state, graph) || findNearestWalkableGoal(cluster, state, graph);
}

function chooseReadyStageGoal({ team, state, graph }) {
  const dropOff = primaryDropOff(state);
  if (!dropOff) return null;

  const anchors = [
    [dropOff[0] + 3 + Math.max(0, team.slotIndex - 1), Math.max(1, dropOff[1] - 1)],
    [dropOff[0] + 4 + Math.max(0, team.slotIndex - 1), dropOff[1]],
    [dropOff[0] + 5 + Math.max(0, team.slotIndex - 1), Math.min(state.grid.height - 2, dropOff[1] + 1)],
    [dropOff[0] + 4 + Math.max(0, team.slotIndex - 1), Math.max(1, dropOff[1] - 2)],
  ];

  for (const anchor of anchors) {
    const goal = findNearestWalkableGoal(anchor, state, graph);
    if (goal && !isAtAnyDropOff(goal, state) && manhattanDistance(goal, dropOff) >= 2) {
      return goal;
    }
  }

  return findNearestWalkableGoal([dropOff[0] + 4, dropOff[1]], state, graph);
}

function findNearestWalkableGoal(goal, state, graph, maxRadius = 4) {
  if (!goal) return null;
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.abs(dx) + Math.abs(dy) !== radius) continue;
        const candidate = [goal[0] + dx, goal[1] + dy];
        if (!graph.isWalkable(candidate)) continue;
        if (candidate[0] < 1 || candidate[1] < 1 || candidate[0] >= state.grid.width - 1 || candidate[1] >= state.grid.height - 1) continue;
        return candidate;
      }
    }
  }
  return null;
}

function fillTeamsWithBots({
  teams,
  desiredSizes,
  allBotIds,
  botById,
  state,
  initialBotOrder,
}) {
  const dropOff = primaryDropOff(state);
  const preferredBotOrder = makeInitialRank(allBotIds, botById, initialBotOrder, dropOff);
  const usedBots = new Set();

  for (const team of teams) {
    const desiredSize = desiredSizes[team.slotIndex] ?? 0;
    const retained = [];
    for (const botId of team.botIds || []) {
      if (!botById.has(botId) || usedBots.has(botId)) continue;
      if (retained.length >= desiredSize) continue;
      retained.push(botId);
      usedBots.add(botId);
    }
    team.botIds = retained;
  }

  const remainingBots = preferredBotOrder.filter((botId) => !usedBots.has(botId));
  const dropOffCoord = dropOff;

  for (const team of teams) {
    const desiredSize = desiredSizes[team.slotIndex] ?? 0;
    if (team.botIds.length >= desiredSize) continue;

    const demand = orderDemandForTeam(team.order);
    const cluster = orderItemClusterCenter(team.order, state.items || []);
    const candidates = [...remainingBots].sort((aId, bId) => {
      const aBot = botById.get(aId);
      const bBot = botById.get(bId);
      const aCarry = hasDeliverableInventory(aBot, demand) ? 0 : 1;
      const bCarry = hasDeliverableInventory(bBot, demand) ? 0 : 1;
      if (aCarry !== bCarry) return aCarry - bCarry;

      if (team.slotIndex === 0 && dropOffCoord) {
        const aDrop = manhattanDistance(aBot.position, dropOffCoord);
        const bDrop = manhattanDistance(bBot.position, dropOffCoord);
        if (aDrop !== bDrop) return aDrop - bDrop;
      }

      const aCluster = cluster ? manhattanDistance(aBot.position, cluster) : aId;
      const bCluster = cluster ? manhattanDistance(bBot.position, cluster) : bId;
      if (aCluster !== bCluster) return aCluster - bCluster;

      return preferredBotOrder.indexOf(aId) - preferredBotOrder.indexOf(bId);
    });

    for (const botId of candidates) {
      if (team.botIds.length >= desiredSize) break;
      if (usedBots.has(botId)) continue;
      team.botIds.push(botId);
      usedBots.add(botId);
    }
  }
}

function claimFutureWaveItem({
  bot,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
  reservedItemIds,
  reservedFutureCounts,
  activeDemand,
  botZoneId = 0,
  zoneCount = 1,
}) {
  const futureTypes = new Set(
    Array.from(reservedFutureCounts.entries())
      .filter(([, count]) => count > 0)
      .map(([type]) => type),
  );
  if (futureTypes.size === 0) return null;

  const activeTypes = new Set(
    Array.from(activeDemand.entries()).filter(([, count]) => count > 0).map(([type]) => type),
  );
  const candidates = state.items.filter((item) =>
    futureTypes.has(item.type)
    && !activeTypes.has(item.type)
    && !reservedItemIds.has(item.id),
  );
  if (candidates.length === 0) return null;

  for (const item of candidates) {
    if (!adjacentManhattan(bot.position, item.position)) continue;
    reservedItemIds.add(item.id);
    reservedFutureCounts.set(item.type, Math.max(0, (reservedFutureCounts.get(item.type) || 0) - 1));
    return { action: 'pick_up', itemId: item.id, nextPath: [bot.position], targetType: 'prefetch_item', noPath: false };
  }

  const [bestTarget] = sortItemsForBotZone(
    candidates,
    botZoneId,
    zoneCount,
    state.grid.width,
    bot.position,
  );
  if (!bestTarget) return null;

  reservedItemIds.add(bestTarget.id);
  reservedFutureCounts.set(bestTarget.type, Math.max(0, (reservedFutureCounts.get(bestTarget.type) || 0) - 1));
  const target = closestAdjacentCell(
    graph,
    bot.position,
    bestTarget.position,
    reservations,
    edgeReservations,
    profile.routing.horizon,
  );
  if (target?.path?.length >= 2) {
    return { action: moveToAction(target.path[0], target.path[1]), nextPath: target.path, targetType: 'prefetch_item', noPath: false };
  }
  return { action: 'wait', nextPath: [bot.position], targetType: 'prefetch_item', noPath: true };
}

function chooseGreedyApproachStep({
  bot,
  item,
  graph,
  reservations,
  edgeReservations,
}) {
  const currentDistance = manhattanDistance(bot.position, item.position);
  let bestNeighbor = null;
  let bestDistance = currentDistance;

  for (const neighbor of graph.neighbors(bot.position)) {
    const neighborKey = encodeCoord(neighbor);
    const currentKey = encodeCoord(bot.position);
    if (reservations.get(1)?.has(neighborKey)) continue;
    if (edgeReservations.get(1)?.has(`${neighborKey}>${currentKey}`)) continue;

    const distance = manhattanDistance(neighbor, item.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNeighbor = neighbor;
    }
  }

  if (!bestNeighbor) {
    return null;
  }

  return {
    action: moveToAction(bot.position, bestNeighbor),
    nextPath: [bot.position, bestNeighbor],
    targetType: 'item_approach',
    noPath: false,
  };
}

function chooseGreedyGoalStep({
  bot,
  goal,
  graph,
  reservations,
  edgeReservations,
}) {
  const currentDistance = manhattanDistance(bot.position, goal);
  let bestNeighbor = null;
  let bestDistance = currentDistance;

  for (const neighbor of graph.neighbors(bot.position)) {
    const neighborKey = encodeCoord(neighbor);
    const currentKey = encodeCoord(bot.position);
    if (reservations.get(1)?.has(neighborKey)) continue;
    if (edgeReservations.get(1)?.has(`${neighborKey}>${currentKey}`)) continue;

    const distance = manhattanDistance(neighbor, goal);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNeighbor = neighbor;
    }
  }

  if (!bestNeighbor) {
    for (const neighbor of graph.neighbors(bot.position)) {
      const neighborKey = encodeCoord(neighbor);
      const currentKey = encodeCoord(bot.position);
      if (reservations.get(1)?.has(neighborKey)) continue;
      if (edgeReservations.get(1)?.has(`${neighborKey}>${currentKey}`)) continue;
      if (!bestNeighbor || manhattanDistance(neighbor, goal) < manhattanDistance(bestNeighbor, goal)) {
        bestNeighbor = neighbor;
      }
    }
  }

  if (!bestNeighbor) {
    return null;
  }

  return {
    action: moveToAction(bot.position, bestNeighbor),
    nextPath: [bot.position, bestNeighbor],
    targetType: 'goal_approach',
    noPath: false,
  };
}

function pickDiversifiedBots(candidateIds, botById, count, minSpacing = 2) {
  const picked = [];
  for (const botId of candidateIds) {
    const bot = botById.get(botId);
    if (!bot) continue;
    const spacedEnough = picked.every((pickedId) => {
      const pickedBot = botById.get(pickedId);
      if (!pickedBot) return true;
      return manhattanDistance(bot.position, pickedBot.position) > minSpacing;
    });
    if (!spacedEnough) continue;
    picked.push(botId);
    if (picked.length >= count) return picked;
  }

  for (const botId of candidateIds) {
    if (picked.includes(botId)) continue;
    picked.push(botId);
    if (picked.length >= count) break;
  }

  return picked;
}

function chooseBreakoutAction({
  bot,
  state,
  graph,
  reservations,
  edgeReservations,
  horizon,
}) {
  const dropOff = primaryDropOff(state);
  if (!dropOff) return null;

  const targetRows = [dropOff[1] - 1, dropOff[1] - 2, dropOff[1]];
    // Prefer moving left and upward out of the staged pack before normal routing resumes.
  let best = null;

  for (const row of targetRows) {
    if (row < 1 || row >= state.grid.height - 1) continue;
    for (let x = bot.position[0] - 1; x >= 1; x -= 1) {
      const candidate = [x, row];
      if (!graph.isWalkable(candidate)) continue;
      const path = findTimeAwarePath({
        graph,
        start: bot.position,
        goal: candidate,
        reservations,
        edgeReservations,
        startTime: 0,
        horizon,
      });
      if (!path || path.length < 2) continue;

      const score = path.length + (row >= bot.position[1] ? 2 : 0);
      if (!best || score < best.score) {
        best = { score, path };
      }
    }
  }

  if (!best) return null;
  return {
    action: moveToAction(best.path[0], best.path[1]),
    nextPath: best.path,
    targetType: 'breakout',
    noPath: false,
  };
}

function isZeroProgressAssignment(bot, resolved) {
  if (!resolved) return false;
  const nextPath = resolved.nextPath || [];
  const target = nextPath.at(-1);
  return nextPath.length <= 1
    || (target && target[0] === bot.position[0] && target[1] === bot.position[1]);
}

function isPerimeterCell(coord, state) {
  if (!coord || !state?.grid) return false;
  const [x, y] = coord;
  return x <= 1 || y <= 1 || x >= state.grid.width - 2 || y >= state.grid.height - 2;
}

function isInvalidStaticTarget({ bot, resolved, state, graph }) {
  if (!resolved) return false;
  if (resolved.action === 'drop_off') return false;
  if (!isZeroProgressAssignment(bot, resolved)) return false;

  const target = resolved.nextPath?.at(-1) || bot.position;
  const targetKey = encodeCoord(target);
  const roadSet = graph.trafficLaneCells || new Set();
  const dropSet = new Set((state.drop_offs || (state.drop_off ? [state.drop_off] : [])).map(encodeCoord));
  return dropSet.has(targetKey)
    || roadSet.has(targetKey)
    || isPerimeterCell(target, state);
}

function resolveTransitFallback({
  bot,
  team,
  state,
  world,
  graph,
  reservations,
  edgeReservations,
  profile,
}) {
  const roadSet = graph.trafficLaneCells || new Set();
  if (roadSet.has(encodeCoord(bot.position))) {
    const fallback = chooseFallbackAction(
      bot,
      graph,
      reservations,
      edgeReservations,
      profile.routing.horizon,
    );
    return { action: fallback.action, nextPath: fallback.path, targetType: 'road_transit', noPath: false };
  }

  const parking = chooseParkingAction({
    bot, graph, reservations, edgeReservations,
    horizon: profile.routing.horizon,
    dropOff: nearestDropOff(bot.position, state),
    otherBots: state.bots,
    items: state.items,
    gridWidth: state.grid?.width,
    gridHeight: state.grid?.height,
  });
  return {
    action: parking.action,
    nextPath: parking.path,
    targetType: team?.role === 'active' ? 'parking' : 'idle_parking',
    noPath: false,
  };
}

/**
 * Build or update teams based on current game state.
 * FIX #3: Preserve ALL existing teams within cooldown, not just active.
 */
export function buildTeams({
  state,
  world,
  oracle,
  existingTeams,
  profile,
  lastOpenerRound = null,
  zoneAssignmentByBot = null,
  initialBotOrder = null,
}) {
  const round = state.round;
  const teamsConfig = profile.teams || {};
  const prefetchLookahead = teamsConfig.prefetch_lookahead_ticks ?? 80;
  const activeMinBots = teamsConfig.active_min_bots ?? 2;
  const prefetchMaxOrders = teamsConfig.prefetch_max_orders ?? Math.max(2, Math.floor(state.bots.length / 2) - 1);

  const allBotIds = state.bots.map((b) => b.id);
  const botById = new Map(state.bots.map((b) => [b.id, b]));
  const orderQueue = buildTeamOrderQueue({
    world,
    oracle,
    round,
    lookahead: prefetchLookahead,
    maxFutureOrders: prefetchMaxOrders,
  });
  const knownQueue = buildKnownTeamOrderQueue({
    world,
    oracle,
    round,
    lookahead: prefetchLookahead,
  });
  const desiredSizes = computeDesiredSlotSizes({
    queueOrders: orderQueue,
    world,
    botCount: allBotIds.length,
    activeMinBots,
    existingTeams,
    botById,
  });

  const nextTeamIdBase = Math.max(0, ...((existingTeams || []).map((team) => team.teamId))) + 1;
  let nextTeamId = nextTeamIdBase;
  const reusableTeams = [...(existingTeams || [])]
    .filter((team) => team.orderId !== null)
    .sort((left, right) => (left.slotIndex ?? 99) - (right.slotIndex ?? 99) || left.teamId - right.teamId);
  const unusedTeams = [...reusableTeams];
  const teams = [];

  for (let slotIndex = 0; slotIndex < desiredSizes.length; slotIndex += 1) {
    const order = orderQueue[slotIndex];
    if (!order) break;

    const matchedIndex = unusedTeams.findIndex((team) => team.orderId === order.id);
    const sourceTeam = matchedIndex >= 0
      ? unusedTeams.splice(matchedIndex, 1)[0]
      : unusedTeams.shift() || null;

    teams.push({
      teamId: sourceTeam?.teamId ?? nextTeamId++,
      orderId: order.id,
      order,
      botIds: sourceTeam?.botIds ? [...sourceTeam.botIds] : [],
      role: slotIndex === 0 ? 'active' : 'prefetch',
      slotIndex,
      goalBand: slotIndex,
      assignedAtTick: sourceTeam?.orderId === order.id ? sourceTeam.assignedAtTick : round,
    });
  }

  fillTeamsWithBots({
    teams,
    desiredSizes,
    allBotIds,
    botById,
    state,
    initialBotOrder,
  });

  if (teams.length === 0 && allBotIds.length > 0) {
    teams.push({
      teamId: nextTeamId++,
      orderId: null,
      order: null,
      botIds: [...allBotIds],
      role: 'idle',
      slotIndex: -1,
      goalBand: 0,
      assignedAtTick: round,
    });
  }

  teams._knownQueue = knownQueue;
  return teams;
}

function tryDeliverForTeamOrder({
  bot,
  team,
  orderDemand,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
  dropRunnerCount = { value: 0 },
}) {
  if (!team || team.slotIndex !== 0 || !hasDeliverableInventory(bot, orderDemand)) {
    return null;
  }

  const maxDropRunners = profile.assignment?.max_drop_runners ?? 3;
  if (!isAtAnyDropOff(bot.position, state) && dropRunnerCount.value >= maxDropRunners) {
    return null;
  }

  if (isAtAnyDropOff(bot.position, state)) {
    dropRunnerCount.value++;
    return { action: 'drop_off', nextPath: [bot.position], targetType: 'drop_off', noPath: false };
  }

  dropRunnerCount.value++;
  const dropOff = nearestDropOff(bot.position, state);
  const path = findTimeAwarePath({
    graph,
    start: bot.position,
    goal: dropOff,
    reservations,
    edgeReservations,
    startTime: 0,
    horizon: profile.routing.horizon,
  });
  if (path && path.length >= 2) {
    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'drop_off', noPath: false };
  }
  const greedyStep = chooseGreedyGoalStep({
    bot,
    goal: dropOff,
    graph,
    reservations,
    edgeReservations,
  });
  if (greedyStep) {
    return { ...greedyStep, targetType: 'drop_off' };
  }
  return { action: 'wait', nextPath: [bot.position], targetType: 'drop_off', noPath: true };
}

function tryClaimOrderItem({
  bot,
  team,
  targetOrder,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
  reservedItemIds,
  remainingDemand,
  targetType = 'item',
  allowBreakout = false,
  botZoneId = 0,
  zoneCount = 1,
}) {
  if ((bot.inventory || []).length < 3) {
    const neededTypes = new Set(
      Array.from(remainingDemand.entries()).filter(([, count]) => count > 0).map(([type]) => type),
    );

    if (neededTypes.size > 0) {
      const candidates = sortItemsForBotZone(
        state.items.filter((item) =>
          neededTypes.has(item.type) && !reservedItemIds.has(item.id),
        ),
        botZoneId,
        zoneCount,
        state.grid.width,
        bot.position,
      );

      // Check if adjacent to a candidate — immediate pick up
      for (const item of candidates) {
        if (adjacentManhattan(bot.position, item.position)) {
          reservedItemIds.add(item.id);
          remainingDemand.set(item.type, Math.max(0, (remainingDemand.get(item.type) || 0) - 1));
          return { action: 'pick_up', itemId: item.id, nextPath: [bot.position], targetType, noPath: false };
        }
      }

      const [bestItem] = candidates;
      if (bestItem) {
        reservedItemIds.add(bestItem.id);
        remainingDemand.set(bestItem.type, Math.max(0, (remainingDemand.get(bestItem.type) || 0) - 1));

        const target = closestAdjacentCell(
          graph, bot.position, bestItem.position,
          reservations, edgeReservations, profile.routing.horizon,
        );
        if (target?.path?.length >= 2) {
          return { action: moveToAction(target.path[0], target.path[1]), nextPath: target.path, targetType, noPath: false };
        }
        const greedyStep = chooseGreedyApproachStep({
          bot,
          item: bestItem,
          graph,
          reservations,
          edgeReservations,
        });
        if (greedyStep) {
          return greedyStep;
        }
        if (allowBreakout) {
          const breakout = chooseBreakoutAction({
            bot,
            state,
            graph,
            reservations,
            edgeReservations,
            horizon: profile.routing.horizon,
          });
          if (breakout) {
            return breakout;
          }
        }
        return { action: 'wait', nextPath: [bot.position], targetType, noPath: true };
      }
    }
  }

  if (team?.slotIndex === 0 && targetOrder && !hasDeliverableInventory(bot, orderDemandForTeam(targetOrder))) {
    return null;
  }

  return null;
}

function classifyFutureQueuePosture({ bot, team, targetOrder, orderRemainingDemand, botById }) {
  if (!team || team.slotIndex <= 0 || !targetOrder) return null;
  const orderDemand = orderDemandForTeam(targetOrder);
  const relevantInventory = countRelevantInventory(bot, orderDemand);
  const inventoryCount = (bot.inventory || []).length;
  const orderSize = (targetOrder.items_required || []).length;
  const teamInventory = teamInventoryCounts(team, botById);
  const teamCoveredDemand = countRemainingDemand(reserveInventoryForDemand(teamInventory, orderDemand).remainingDemand) <= 0;
  const remainingCovered = countRemainingDemand(orderRemainingDemand || new Map()) <= 0;
  const fullyLoadedForOrder = inventoryCount > 0
    && inventoryFullyRelevant(bot, orderDemand)
    && inventoryCount >= Math.min(3, Math.max(2, orderSize));

  const ready = inventoryCount > 0 && (
    fullyLoadedForOrder
    || (orderSize <= 4 && relevantInventory >= 2)
    || ((teamCoveredDemand || remainingCovered) && relevantInventory === inventoryCount)
  );

  return ready ? 'future_ready' : 'future_collect';
}

function resolveStageAction({
  bot,
  team,
  targetOrder,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
  maxSlotIndex,
  queuePosture = null,
}) {
  const stageGoal = queuePosture === 'future_ready'
    ? chooseReadyStageGoal({ team, state, graph })
    : chooseTeamStageGoal({ team, targetOrder, state, graph, maxSlotIndex });
  if (stageGoal) {
    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: stageGoal,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
    });
    if (path && path.length >= 2) {
      return {
        action: moveToAction(path[0], path[1]),
        nextPath: path,
        targetType: queuePosture === 'future_ready' ? 'future_ready' : (team.slotIndex === 0 ? 'parking' : 'slot_stage'),
        noPath: false,
      };
    }
    const greedyStep = chooseGreedyGoalStep({
      bot,
      goal: stageGoal,
      graph,
      reservations,
      edgeReservations,
    });
    if (greedyStep) {
      return {
        ...greedyStep,
        targetType: queuePosture === 'future_ready' ? 'future_ready' : (team.slotIndex === 0 ? 'parking' : 'slot_stage'),
      };
    }
  }

  const dropOff = team.slotIndex === 0 ? nearestDropOff(bot.position, state) : stageGoal || nearestDropOff(bot.position, state);
  const parking = chooseParkingAction({
    bot, graph, reservations, edgeReservations,
    horizon: profile.routing.horizon, dropOff,
    otherBots: state.bots, items: state.items,
    gridWidth: state.grid?.width, gridHeight: state.grid?.height,
  });
  return {
    action: parking.action,
    nextPath: parking.path,
    targetType: queuePosture === 'future_ready' ? 'future_ready' : (team.slotIndex === 0 ? 'parking' : 'slot_stage'),
    noPath: false,
  };
}

function resolveSlotBotAction({
  bot,
  team,
  targetOrder,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
  orderRemainingDemand,
  reservedItemIds,
  allowBreakout = false,
  botZoneId = 0,
  zoneCount = 1,
  dropRunnerCount = { value: 0 },
  maxSlotIndex = 0,
  botById = new Map(),
}) {
  if (!team || !targetOrder) {
    return resolveStageAction({
      bot, team: team || { slotIndex: -1 }, targetOrder,
      state, graph, reservations, edgeReservations, profile, maxSlotIndex,
    });
  }

  const orderDemand = orderDemandForTeam(targetOrder);
  const deliveryAction = tryDeliverForTeamOrder({
    bot,
    team,
    orderDemand,
    state,
    graph,
    reservations,
    edgeReservations,
    profile,
    dropRunnerCount,
  });
  if (deliveryAction) return deliveryAction;

  const claimedItem = tryClaimOrderItem({
    bot,
    team,
    targetOrder,
    state,
    graph,
    reservations,
    edgeReservations,
    profile,
    reservedItemIds,
    remainingDemand: orderRemainingDemand,
    targetType: team.slotIndex === 0 ? 'item' : 'future_item',
    allowBreakout,
    botZoneId,
    zoneCount,
  });
  if (claimedItem) return claimedItem;

  const queuePosture = classifyFutureQueuePosture({
    bot,
    team,
    targetOrder,
    orderRemainingDemand,
    botById,
  });

  if (team.slotIndex === 0 && hasDeliverableInventory(bot, orderDemand)) {
    return tryDeliverForTeamOrder({
      bot,
      team,
      orderDemand,
      state,
      graph,
      reservations,
      edgeReservations,
      profile,
      dropRunnerCount,
    }) || resolveStageAction({
      bot, team, targetOrder, state, graph, reservations, edgeReservations, profile, maxSlotIndex, queuePosture,
    });
  }

  return resolveStageAction({
    bot,
    team,
    targetOrder,
    state,
    graph,
    reservations,
    edgeReservations,
    profile,
    maxSlotIndex,
    queuePosture,
  });
}

// ─── Strategy executor (called from planner-multibot-runtime.mjs) ───

export function executeTeamStrategy({
  planner,
  state,
  world,
  graph,
  phase,
  recoveryMode,
  forcePartialDrop = false,
  recoveryThreshold,
  blockedItemsByBot,
  oracle,
}) {
  const previousTeams = planner._teams || null;
  const teams = buildTeams({
    state,
    world,
    oracle,
    existingTeams: previousTeams,
    profile: planner.profile,
    lastOpenerRound: planner.lastOpenerRound,
    zoneAssignmentByBot: planner.zoneAssignmentByBot,
    initialBotOrder: planner.initialTeamOrder,
  });
  planner._teams = teams;

  const previousFrontTeamId = previousTeams?.find((team) => (team.slotIndex ?? 0) === 0)?.teamId ?? null;
  const currentFrontTeamId = teams.find((team) => team.slotIndex === 0)?.teamId ?? null;
  const rotatedThisTick = previousFrontTeamId !== null && currentFrontTeamId !== null && previousFrontTeamId !== currentFrontTeamId;
  if (rotatedThisTick) {
    planner._lastTeamRotationTick = state.round;
  }

  // Build team lookup
  const teamByBot = new Map();
  for (const team of teams) {
    for (const botId of team.botIds) {
      teamByBot.set(botId, team);
    }
  }

  const reservations = makeOccupancyReservations(state);
  const edgeReservations = new Map();
  const reservedItemIds = new Set();
  const teamsConfig = planner.profile.teams || {};
  const openerBreakoutTicks = teamsConfig.opener_breakout_ticks ?? 8;
  const inOpenerBreakout = planner.lastOpenerRound !== null
    && (state.round - planner.lastOpenerRound) <= openerBreakoutTicks;
  const zoneCount = Math.max(1, teamsConfig.zone_count ?? 3);
  const orderQueue = teams
    .filter((team) => team.order)
    .sort((left, right) => left.slotIndex - right.slotIndex)
    .map((team) => team.order);
  const knownQueue = teams._knownQueue || orderQueue;
  const maxSlotIndex = Math.max(0, ...teams.map((team) => team.slotIndex));
  const orderStateById = new Map(state.orders.map((order) => [order.id, order]));
  const botById = new Map(state.bots.map((bot) => [bot.id, bot]));
  const remainingDemandByTeamId = new Map();

  for (const team of teams) {
    if (!team.order) continue;
    const liveOrder = orderStateById.get(team.orderId) || team.order;
    team.order = liveOrder;
    remainingDemandByTeamId.set(team.teamId, reserveTeamInventoryForOrder(team, liveOrder, botById));
  }

  // In recovery mode, rebuild teams to focus all bots on active order
  if (recoveryMode && world.activeOrder) {
    const activeTeam = teams.find((t) => t.role === 'active');
    if (activeTeam) {
      // Move all non-active bots to the active team
      const allBotIds = state.bots.map((b) => b.id);
      const activeBotSet = new Set(activeTeam.botIds);
      for (const botId of allBotIds) {
        if (!activeBotSet.has(botId)) {
          activeTeam.botIds.push(botId);
          activeBotSet.add(botId);
        }
      }
      // Remove prefetch and idle teams
      for (let i = teams.length - 1; i >= 0; i--) {
        if (teams[i].role !== 'active') teams.splice(i, 1);
      }
      // Update teamByBot
      for (const botId of allBotIds) {
        teamByBot.set(botId, activeTeam);
      }
    }
  }

  const botsByPriority = [...state.bots].sort((a, b) => {
    const aTeam = teamByBot.get(a.id);
    const bTeam = teamByBot.get(b.id);
    const aSlot = aTeam?.slotIndex ?? 99;
    const bSlot = bTeam?.slotIndex ?? 99;
    if (aSlot !== bSlot) return aSlot - bSlot;
    return a.id - b.id;
  });

  const actions = [];
  let forcedWaits = 0;
  const dropRunnerCount = { value: 0 };  // Shared counter for drop-off cap

  for (const bot of botsByPriority) {
    const stallKey = `${bot.id}`;
    const team = teamByBot.get(bot.id);

    // Handle forced waits
    const forcedWaitRemaining = planner.forcedWait.get(stallKey) || 0;
    if (forcedWaitRemaining > 0) {
      planner.forcedWait.set(stallKey, forcedWaitRemaining - 1);
      reservePath({
        path: [bot.position],
        startTime: 0,
        reservations,
        edgeReservations,
        horizon: planner.profile.routing.horizon,
        holdAtGoal: true,
      });
      actions.push({ bot: bot.id, action: 'wait' });
      forcedWaits += 1;

      planner._botDetails.set(bot.id, {
        target: null,
        path: [],
        taskType: 'forced_wait',
        stallCount: planner.stalls.get(stallKey) || 0,
        orderId: team?.orderId ?? null,
        teamId: team?.teamId ?? null,
        teamRole: team?.role ?? null,
        queuePosture: null,
      });
      continue;
    }

    if (forcePartialDrop && (bot.inventory || []).length > 0 && team?.slotIndex === 0 && team?.order) {
      const deliveryAction = tryDeliverForTeamOrder({
        bot,
        team,
        orderDemand: orderDemandForTeam(team.order),
        state,
        graph,
        reservations,
        edgeReservations,
        profile: planner.profile,
        dropRunnerCount,
      });
      if (deliveryAction) {
        const resolved = deliveryAction;
        planner.previousPositions.set(stallKey, encodeCoord(bot.position));
        reservePath({
          path: resolved.nextPath, startTime: 0, reservations, edgeReservations,
          horizon: planner.profile.routing.horizon, holdAtGoal: false,
        });
        if (resolved.action === 'pick_up') {
          actions.push({ bot: bot.id, action: 'pick_up', item_id: resolved.itemId });
        } else {
          actions.push({ bot: bot.id, action: resolved.action });
        }
        planner.lastActionByBot.set(bot.id, resolved.action);
        planner._botDetails.set(bot.id, {
          target: resolved.nextPath?.at(-1) || null, path: resolved.nextPath || [],
          taskType: 'force_partial_drop', stallCount: planner.stalls.get(stallKey) || 0,
          orderId: team?.orderId ?? null, teamId: team?.teamId ?? null, teamRole: team?.role ?? null,
          queuePosture: null,
        });
        continue;
      }
    }

    let resolved = resolveSlotBotAction({
      bot,
      team,
      targetOrder: team?.order || null,
      state,
      graph,
      reservations,
      edgeReservations,
      profile: planner.profile,
      orderRemainingDemand: remainingDemandByTeamId.get(team?.teamId) || new Map(),
      reservedItemIds,
      allowBreakout: inOpenerBreakout && team?.slotIndex === 0,
      botZoneId: planner.zoneAssignmentByBot?.[bot.id] ?? 0,
      zoneCount,
      dropRunnerCount,
      maxSlotIndex,
      botById,
    });

    if (
      inOpenerBreakout
      && ['item', 'slot_stage', 'parking'].includes(resolved.targetType)
      && isZeroProgressAssignment(bot, resolved)
    ) {
      const breakout = chooseBreakoutAction({
        bot,
        state,
        graph,
        reservations,
        edgeReservations,
        horizon: planner.profile.routing.horizon,
      });
      if (breakout) {
        resolved = breakout;
      }
    }

    if (isInvalidStaticTarget({ bot, resolved, state, graph })) {
      resolved = resolveTransitFallback({
        bot,
        team,
        state,
        world,
        graph,
        reservations,
        edgeReservations,
        profile: planner.profile,
      });
    }

    // Anti-deadlock detection
    const previous = planner.previousPositions.get(stallKey);
    const currentCoord = encodeCoord(bot.position);
    const stalled = previous === currentCoord;
    const stallCount = stalled ? (planner.stalls.get(stallKey) || 0) + 1 : 0;
    planner.stalls.set(stallKey, stallCount);

    if (stallCount >= planner.profile.anti_deadlock.stall_threshold && resolved.action.startsWith('move_')) {
      const fallback = chooseFallbackAction(
        bot, graph, reservations, edgeReservations, planner.profile.routing.horizon,
      );
      resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'anti_deadlock', noPath: false };
      planner.forcedWait.set(stallKey, planner.profile.anti_deadlock.forced_wait_rounds);
    }

    if (
      team?.slotIndex === 0
      && inOpenerBreakout
      && resolved.targetType === 'item'
      && isZeroProgressAssignment(bot, resolved)
    ) {
      const breakout = chooseBreakoutAction({
        bot,
        state,
        graph,
        reservations,
        edgeReservations,
        horizon: planner.profile.routing.horizon,
      });
      if (breakout) {
        resolved = breakout;
      }
    }

    planner.previousPositions.set(stallKey, currentCoord);

    // Reserve path
    reservePath({
      path: resolved.nextPath,
      startTime: 0,
      reservations,
      edgeReservations,
      horizon: planner.profile.routing.horizon,
      holdAtGoal: resolved.targetType !== 'drop_off',
    });

    // Emit action
    if (resolved.action === 'pick_up') {
      const existingPending = planner.pendingPickups.get(bot.id);
      const inventorySize = (bot.inventory || []).length;
      if (!existingPending || existingPending.itemId !== resolved.itemId) {
        planner.pendingPickups.set(bot.id, {
          itemId: resolved.itemId,
          expectedMinInventory: inventorySize + 1,
          resolveAfterRound: state.round + 2,
          approachCell: [...bot.position],
        });
      }
      actions.push({ bot: bot.id, action: 'pick_up', item_id: resolved.itemId });
    } else {
      actions.push({ bot: bot.id, action: resolved.action });
    }

    planner.lastActionByBot.set(bot.id, resolved.action);
    planner._botDetails.set(bot.id, {
      target: resolved.nextPath?.at(-1) || null,
      path: resolved.nextPath || [],
      taskType: resolved.targetType || 'none',
      stallCount,
      orderId: team?.orderId ?? null,
      teamId: team?.teamId ?? null,
      teamRole: team?.role ?? null,
      slotIndex: team?.slotIndex ?? null,
      goalBand: team?.goalBand ?? null,
      queuePosture: classifyFutureQueuePosture({
        bot,
        team,
        targetOrder: team?.order || null,
        orderRemainingDemand: remainingDemandByTeamId.get(team?.teamId) || new Map(),
        botById,
      }),
    });
  }

  const teamSummary = teams.map((t) => ({
    teamId: t.teamId,
    role: t.role,
    orderId: t.orderId,
    slotIndex: t.slotIndex,
    goalBand: t.goalBand,
    teamDistanceRank: t.goalBand,
    botCount: t.botIds.length,
    botIds: t.botIds,
    assigned: t.orderId !== null,
  }));

  planner.lastMetrics = {
    phase,
    strategy: 'team_v1',
    taskCount: teams.filter((t) => t.orderId !== null).reduce((s, t) => s + t.botIds.length, 0),
    forcedWaits,
    stalledBots: Array.from(planner.stalls.values()).filter((v) => v > 0).length,
    recoveryMode,
    noProgressRounds: planner.noProgressRounds,
    recoveryThreshold,
    loopDetections: planner.loopDetectionsThisTick,
    approachBlacklistSize: Array.from(blockedItemsByBot.values()).reduce((sum, blocked) => sum + blocked.size, 0),
    orderEtaAtDecision: null,
    projectedCompletionFeasible: null,
    prefetchBlockedByActiveDemand: false,
    activeCoverageSatisfied: false,
    waveOrderIds: knownQueue.map((order) => order.id),
    waveReservedCounts: {},
    wavePickupEnabled: true,
    openerBreakoutActive: inOpenerBreakout,
    queueOrderIds: knownQueue.map((order) => order.id),
    queueOrders: knownQueue.map((order) => ({
      orderId: order.id,
      firstSeenTick: order.first_seen_tick ?? null,
      requiredItems: [...(order.items_required || [])],
      assigned: teams.some((team) => team.orderId === order.id),
      slotIndex: teams.find((team) => team.orderId === order.id)?.slotIndex ?? null,
      teamId: teams.find((team) => team.orderId === order.id)?.teamId ?? null,
    })),
    lastRotationTick: planner._lastTeamRotationTick ?? null,
    rotatedThisTick,
    teams: teamSummary,
    botDetails: Object.fromEntries(planner._botDetails),
    zoneAssignment: planner.zoneAssignmentByBot ? { ...planner.zoneAssignmentByBot } : null,
  };

  return actions;
}
