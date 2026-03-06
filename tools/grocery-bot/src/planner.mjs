import { solveMinCostAssignment } from './assignment.mjs';
import { encodeCoord, adjacentManhattan, manhattanDistance, moveToAction } from './coords.mjs';
import { GridGraph } from './grid-graph.mjs';
import { findTimeAwarePath, reservePath } from './routing.mjs';
import { buildWorldContext, countInventoryByType } from './world-model.mjs';

function cloneDemand(map) {
  return new Map(Array.from(map.entries()));
}

function decrementDemand(demand, type) {
  if (!demand.has(type)) {
    return;
  }

  demand.set(type, Math.max(0, demand.get(type) - 1));
}

function hasDeliverableInventory(bot, activeDemand) {
  const inventoryDemand = cloneDemand(activeDemand);
  for (const itemType of bot.inventory || []) {
    if ((inventoryDemand.get(itemType) || 0) > 0) {
      return true;
    }
  }

  return false;
}

function countDeliverableInventory(bot, activeDemand) {
  const inventoryDemand = cloneDemand(activeDemand);
  let count = 0;

  for (const itemType of bot.inventory || []) {
    if ((inventoryDemand.get(itemType) || 0) <= 0) {
      continue;
    }

    count += 1;
    decrementDemand(inventoryDemand, itemType);
  }

  return count;
}

function shouldScheduleDropOff({
  bot,
  activeDemand,
  phase,
  dropOff,
  botCount,
  completionInfeasible = false,
}) {
  const deliverableCount = countDeliverableInventory(bot, activeDemand);
  if (deliverableCount === 0) {
    return false;
  }

  if (botCount > 1) {
    return true;
  }

  if (phase === 'cutoff') {
    return true;
  }

  const inventoryCount = (bot.inventory || []).length;
  const activeMissingCount = Array.from(activeDemand.values()).reduce((sum, count) => sum + count, 0);
  const canCompleteOrderNow = deliverableCount >= activeMissingCount;

  if (phase === 'endgame') {
    return inventoryCount >= 3 || canCompleteOrderNow || completionInfeasible;
  }

  return inventoryCount >= 3 || canCompleteOrderNow;
}

function getRoundPhase(state, profile) {
  const roundRatio = state.round / Math.max(1, state.max_rounds);
  const endgameThreshold = profile.phase_switch.endgame_round_ratio;
  const cutoffThreshold = profile.phase_switch.hard_cutoff_round_ratio;

  if (roundRatio >= cutoffThreshold) {
    return 'cutoff';
  }

  if (roundRatio >= endgameThreshold) {
    return 'endgame';
  }

  if (roundRatio < 0.33) {
    return 'early';
  }

  return 'mid';
}

function getNeededTypes(activeDemand, previewDemand, previewWeight, allowPreview) {
  const needed = new Map();

  for (const [type, count] of activeDemand.entries()) {
    if (count > 0) {
      needed.set(type, { activeCount: count, previewCount: 0 });
    }
  }

  if (allowPreview) {
    for (const [type, count] of previewDemand.entries()) {
      const entry = needed.get(type) || { activeCount: 0, previewCount: 0 };
      entry.previewCount = count;
      needed.set(type, entry);
    }
  }

  const weighted = new Map();
  for (const [type, counts] of needed.entries()) {
    const score = counts.activeCount + counts.previewCount * previewWeight;
    if (score > 0) {
      weighted.set(type, score);
    }
  }

  return weighted;
}

function estimateCongestion(cell, bots) {
  let congestion = 0;
  for (const bot of bots) {
    const distance = manhattanDistance(cell, bot.position);
    if (distance <= 2) {
      congestion += 1 / Math.max(1, distance);
    }
  }

  return congestion;
}

function estimateDistanceToDropoff(item, dropOff) {
  return Math.max(1, manhattanDistance(item.position, dropOff) - 1);
}

function pickNearestRelevantItem(bot, items, neededTypes) {
  let best = null;

  for (const item of items) {
    if (!neededTypes.has(item.type)) {
      continue;
    }

    const distance = manhattanDistance(bot.position, item.position);
    if (!best || distance < best.distance) {
      best = { item, distance };
    }
  }

  return best?.item || null;
}

function closestAdjacentCell(graph, from, itemPosition, reservations, edgeReservations, horizon) {
  const adjacent = graph.adjacentWalkableCells(itemPosition);
  if (adjacent.length === 0) {
    return null;
  }

  let bestPath = null;
  let bestTarget = null;

  for (const cell of adjacent) {
    const path = findTimeAwarePath({
      graph,
      start: from,
      goal: cell,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon,
    });

    if (!path) {
      continue;
    }

    if (!bestPath || path.length < bestPath.length) {
      bestPath = path;
      bestTarget = cell;
    }
  }

  if (!bestPath) {
    return null;
  }

  return { target: bestTarget, path: bestPath };
}

function buildTasks(state, world, profile, phase) {
  const tasks = [];
  const inventoryCounts = countInventoryByType(state.bots);
  const activeDemand = cloneDemand(world.activeDemand);

  for (const [type, count] of inventoryCounts.entries()) {
    if (activeDemand.has(type)) {
      activeDemand.set(type, Math.max(0, activeDemand.get(type) - count));
    }
  }

  const totalActiveMissing = Array.from(activeDemand.values()).reduce((sum, count) => sum + count, 0);
  const totalFreeSlots = state.bots.reduce((sum, bot) => sum + Math.max(0, 3 - (bot.inventory || []).length), 0);
  const allowPreviewPrefetch = (phase === 'early' || phase === 'mid') && totalFreeSlots > totalActiveMissing;

  const neededTypes = getNeededTypes(
    activeDemand,
    world.previewDemand,
    profile.assignment.preview_item_weight,
    allowPreviewPrefetch,
  );

  for (const bot of state.bots) {
    const deliverable = hasDeliverableInventory(bot, world.activeDemand);

    if (deliverable && shouldScheduleDropOff({
      bot,
      activeDemand: world.activeDemand,
      phase,
      dropOff: state.drop_off,
      botCount: state.bots.length,
    })) {
      tasks.push({
        key: `drop:${bot.id}`,
        kind: 'drop_off',
        botScoped: true,
        botId: bot.id,
        target: state.drop_off,
        item: null,
        demandScore: 4,
      });
    }
  }

  for (const item of state.items) {
    if (!neededTypes.has(item.type)) {
      continue;
    }

    if (phase === 'cutoff' && (world.activeDemand.get(item.type) || 0) === 0) {
      continue;
    }

    tasks.push({
      key: `item:${item.id}`,
      kind: 'pick_up',
      target: item.position,
      item,
      botScoped: false,
      demandScore: neededTypes.get(item.type),
    });
  }

  return tasks;
}

function buildCostMatrix(state, tasks, profile, phase) {
  const matrix = [];
  const urgency = phase === 'endgame' ? 1.5 : phase === 'cutoff' ? 2.0 : 1;

  for (const bot of state.bots) {
    const row = [];

    for (const task of tasks) {
      if (task.botScoped && task.botId !== bot.id) {
        row.push(1e9);
        continue;
      }

      if (task.kind === 'pick_up' && (bot.inventory || []).length >= 3) {
        row.push(1e9);
        continue;
      }

      const travelToTask = Math.max(0, manhattanDistance(bot.position, task.target) - (task.kind === 'pick_up' ? 1 : 0));
      const travelToDropOff = task.kind === 'pick_up'
        ? estimateDistanceToDropoff(task.item, state.drop_off)
        : Math.max(0, manhattanDistance(task.target, state.drop_off));
      const congestion = estimateCongestion(task.target, state.bots.filter((candidate) => candidate.id !== bot.id));
      const contention = task.kind === 'pick_up'
        ? state.bots.filter((candidate) => candidate.id !== bot.id && manhattanDistance(candidate.position, task.target) < 4).length
        : 0;
      const demandBonus = task.demandScore * profile.assignment.remaining_demand_priority;

      const score =
        travelToTask * profile.assignment.travel_to_item +
        travelToDropOff * profile.assignment.travel_item_to_dropoff +
        congestion * profile.assignment.congestion_penalty +
        contention * profile.assignment.contention_penalty -
        demandBonus * urgency -
        profile.assignment.urgency_bonus * urgency;

      row.push(score);
    }

    matrix.push(row);
  }

  return matrix;
}

function makeOccupancyReservations(state) {
  const reservations = new Map();
  reservations.set(0, new Set(state.bots.map((bot) => encodeCoord(bot.position))));
  return reservations;
}

function actionFromTask({ bot, task, graph, reservations, edgeReservations, profile, holdGoalSteps }) {
  if (task.kind === 'drop_off') {
    if (bot.position[0] === task.target[0] && bot.position[1] === task.target[1]) {
      return { action: 'drop_off', nextPath: [bot.position], targetType: 'drop_off' };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: task.target,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
    });

    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'drop_off' };
    }

    const action = moveToAction(path[0], path[1]);
    return { action, nextPath: path, targetType: 'drop_off', holdGoalSteps };
  }

  const item = task.item;
  if ((bot.inventory || []).length >= 3) {
    return { action: 'wait', nextPath: [bot.position], targetType: 'item' };
  }

  if (adjacentManhattan(bot.position, item.position)) {
    return { action: 'pick_up', itemId: item.id, nextPath: [bot.position], targetType: 'item' };
  }

  const target = closestAdjacentCell(
    graph,
    bot.position,
    item.position,
    reservations,
    edgeReservations,
    profile.routing.horizon,
  );

  if (!target || !target.path || target.path.length < 2) {
    return { action: 'wait', nextPath: [bot.position], targetType: 'item' };
  }

  const action = moveToAction(target.path[0], target.path[1]);
  return { action, nextPath: target.path, targetType: 'item', holdGoalSteps };
}

function chooseFallbackAction(bot, graph, reservations, edgeReservations, horizon) {
  for (const neighbor of graph.neighbors(bot.position)) {
    const moveKey = encodeCoord(neighbor);
    if (reservations.get(1)?.has(moveKey)) {
      continue;
    }

    const reverse = `${encodeCoord(neighbor)}>${encodeCoord(bot.position)}`;
    if (edgeReservations.get(1)?.has(reverse)) {
      continue;
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: neighbor,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon,
    });

    if (path && path.length >= 2) {
      return { action: moveToAction(path[0], path[1]), path };
    }
  }

  return { action: 'wait', path: [bot.position] };
}

function mapCountFromInventory(inventory) {
  const counts = new Map();
  for (const type of inventory || []) {
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  return counts;
}

function sumDemand(map) {
  return Array.from(map.values()).reduce((sum, value) => sum + value, 0);
}

function copyCounts(map) {
  return new Map(Array.from(map.entries()));
}

function applyCounts(base, delta) {
  const next = copyCounts(base);
  for (const [type, count] of delta.entries()) {
    next.set(type, (next.get(type) || 0) + count);
  }

  return next;
}

function decrementCount(map, type, count = 1) {
  map.set(type, Math.max(0, (map.get(type) || 0) - count));
}

function deliverFromInventoryToDemand(inventoryCounts, demand) {
  let delivered = 0;
  for (const [type, neededCount] of demand.entries()) {
    if (neededCount <= 0) {
      continue;
    }

    const available = inventoryCounts.get(type) || 0;
    const used = Math.min(available, neededCount);
    if (used <= 0) {
      continue;
    }

    inventoryCounts.set(type, available - used);
    demand.set(type, neededCount - used);
    delivered += used;
  }

  return delivered;
}

function evaluateDropGain({
  inventoryCounts,
  activeDemand,
  previewDemand,
}) {
  const inventory = copyCounts(inventoryCounts);
  const active = copyCounts(activeDemand);
  const preview = copyCounts(previewDemand);
  let deliveredTotal = 0;
  let orderBonuses = 0;

  deliveredTotal += deliverFromInventoryToDemand(inventory, active);
  const activeCompleted = sumDemand(active) === 0;

  if (activeCompleted) {
    orderBonuses += 1;
    deliveredTotal += deliverFromInventoryToDemand(inventory, preview);

    if (sumDemand(preview) === 0 && sumDemand(previewDemand) > 0) {
      orderBonuses += 1;
    }
  }

  return {
    deliveredTotal,
    orderBonuses,
    points: deliveredTotal + orderBonuses * 5,
    remainingInventory: inventory,
    activeCompleted,
    remainingActiveDemand: copyCounts(active),
  };
}

function buildTypeSupply({ activeDemand, previewDemand, allowPreview }) {
  const supply = new Map();

  for (const [type, count] of activeDemand.entries()) {
    if (count > 0) {
      supply.set(type, count);
    }
  }

  if (allowPreview) {
    for (const [type, count] of previewDemand.entries()) {
      if (count > 0) {
        supply.set(type, (supply.get(type) || 0) + count);
      }
    }
  }

  return supply;
}

function enumerateTypeSequences(typeSupply, maxLen) {
  const sequences = [];
  const types = Array.from(typeSupply.keys());
  const counts = new Map(typeSupply);

  function dfs(prefix) {
    if (prefix.length > 0) {
      sequences.push([...prefix]);
    }

    if (prefix.length >= maxLen) {
      return;
    }

    for (const type of types) {
      const available = counts.get(type) || 0;
      if (available <= 0) {
        continue;
      }

      counts.set(type, available - 1);
      prefix.push(type);
      dfs(prefix);
      prefix.pop();
      counts.set(type, available);
    }
  }

  dfs([]);
  return sequences;
}

function bestPathToAdjacentShelfCell(graph, from, shelfPosition, horizon, {
  shelfId = null,
  blockedApproaches = null,
  approachStats = null,
} = {}) {
  const options = graph.adjacentWalkableCells(shelfPosition);
  let best = null;

  for (const cell of options) {
    if (shelfId && isBlockedApproach({
      blockedApproaches,
      itemId: shelfId,
      cell,
    })) {
      continue;
    }

    const path = findTimeAwarePath({
      graph,
      start: from,
      goal: cell,
      reservations: new Map(),
      edgeReservations: new Map(),
      startTime: 0,
      horizon,
    });

    if (!path) {
      continue;
    }

    const approachKey = shelfId ? approachCooldownKey(shelfId, cell) : null;
    const stats = approachKey ? approachStats?.get(approachKey) : null;
    const successes = stats?.successes || 0;
    const failures = stats?.failures || 0;
    const consecutiveFailures = stats?.consecutiveFailures || 0;
    const reliabilityScore = (successes * 8) - (failures * 6) - (consecutiveFailures * 10);
    const knownSuccess = successes > 0;
    const knownFailure = failures > 0;
    const candidate = {
      path,
      cell,
      reliabilityScore,
      knownSuccess,
      knownFailure,
    };

    if (
      !best
      || candidate.reliabilityScore > best.reliabilityScore
      || (
        candidate.reliabilityScore === best.reliabilityScore
        && candidate.knownSuccess
        && !best.knownSuccess
      )
      || (
        candidate.reliabilityScore === best.reliabilityScore
        && candidate.knownSuccess === best.knownSuccess
        && candidate.knownFailure === best.knownFailure
        && candidate.path.length < best.path.length
      )
      || (
        candidate.reliabilityScore === best.reliabilityScore
        && candidate.knownSuccess === best.knownSuccess
        && candidate.knownFailure === best.knownFailure
        && candidate.path.length === best.path.length
        && encodeCoord(candidate.cell) < encodeCoord(best.cell)
      )
    ) {
      best = candidate;
    }
  }

  return best;
}

function evaluateTypeSequenceRoute({
  graph,
  start,
  dropOff,
  typeSequence,
  shelvesByType,
  horizon,
  blockedApproaches = null,
  approachStats = null,
}) {
  let best = null;

  function dfs(index, currentCell, firstStep, totalCost) {
    if (index >= typeSequence.length) {
      const toDrop = findTimeAwarePath({
        graph,
        start: currentCell,
        goal: dropOff,
        reservations: new Map(),
        edgeReservations: new Map(),
        startTime: 0,
        horizon,
      });

      if (!toDrop) {
        return;
      }

      const dropCost = Math.max(0, toDrop.length - 1) + 1;
      const candidate = {
        totalCost: totalCost + dropCost,
        firstStep,
      };

      if (!best || candidate.totalCost < best.totalCost) {
        best = candidate;
      }

      return;
    }

    const type = typeSequence[index];
    const shelves = shelvesByType.get(type) || [];

    for (const shelf of shelves) {
      const toShelf = bestPathToAdjacentShelfCell(graph, currentCell, shelf.position, horizon, {
        shelfId: shelf.id,
        blockedApproaches,
        approachStats,
      });
      if (!toShelf) {
        continue;
      }

      const moveCost = Math.max(0, toShelf.path.length - 1);
      const pickCost = 1;

      dfs(
        index + 1,
        toShelf.cell,
        firstStep || { shelf, path: toShelf.path, type },
        totalCost + moveCost + pickCost,
      );
    }
  }

  dfs(0, start, null, 0);
  return best;
}

function createTypeRoundTripCostResolver({
  graph,
  dropOff,
  shelvesByType,
  horizon,
  approachStats = null,
}) {
  const cache = new Map();

  return (type) => {
    if (cache.has(type)) {
      return cache.get(type);
    }

    const shelves = shelvesByType.get(type) || [];
    let bestMoveCost = Infinity;

    for (const shelf of shelves) {
      const toShelf = bestPathToAdjacentShelfCell(graph, dropOff, shelf.position, horizon, {
        shelfId: shelf.id,
        approachStats,
      });
      if (!toShelf) {
        continue;
      }

      const toDrop = findTimeAwarePath({
        graph,
        start: toShelf.cell,
        goal: dropOff,
        reservations: new Map(),
        edgeReservations: new Map(),
        startTime: 0,
        horizon,
      });

      if (!toDrop) {
        continue;
      }

      const moveCost = Math.max(0, toShelf.path.length - 1) + Math.max(0, toDrop.length - 1);
      if (moveCost < bestMoveCost) {
        bestMoveCost = moveCost;
      }
    }

    cache.set(type, bestMoveCost);
    return bestMoveCost;
  };
}

function estimateRemainingDemandCost({
  remainingDemand,
  resolveTypeRoundTripCost,
}) {
  let totalCost = 0;

  for (const [type, count] of remainingDemand.entries()) {
    if (count <= 0) {
      continue;
    }

    const roundTripMoveCost = resolveTypeRoundTripCost(type);
    if (!Number.isFinite(roundTripMoveCost)) {
      return Infinity;
    }

    const trips = Math.ceil(count / 3);
    totalCost += trips * (roundTripMoveCost + 1) + count;
  }

  return totalCost;
}

function estimateDropEta({
  bot,
  dropOff,
  graph,
  horizon,
}) {
  if (bot.position[0] === dropOff[0] && bot.position[1] === dropOff[1]) {
    return 1;
  }

  const path = findTimeAwarePath({
    graph,
    start: bot.position,
    goal: dropOff,
    reservations: new Map(),
    edgeReservations: new Map(),
    startTime: 0,
    horizon,
  });

  if (!path) {
    return Infinity;
  }

  return Math.max(0, path.length - 1) + 1;
}

function estimateMinActiveCompletionEta({
  state,
  bot,
  graph,
  profile,
  activeDemand,
  inventoryCounts,
  shelvesByType,
  resolveTypeRoundTripCost,
  blockedApproaches,
  approachStats = null,
}) {
  const activeGap = copyCounts(activeDemand);
  for (const [type, count] of inventoryCounts.entries()) {
    decrementCount(activeGap, type, count);
  }

  if (sumDemand(activeGap) === 0) {
    return countDeliverableInventory(bot, activeDemand) > 0
      ? estimateDropEta({
        bot,
        dropOff: state.drop_off,
        graph,
        horizon: Math.max(24, profile.routing.horizon + 8),
      })
      : 0;
  }

  const freeSlots = Math.max(0, 3 - (bot.inventory || []).length);
  const typeSupply = buildTypeSupply({
    activeDemand: activeGap,
    previewDemand: new Map(),
    allowPreview: false,
  });
  const sequences = enumerateTypeSequences(typeSupply, freeSlots);
  if ((bot.inventory || []).length > 0) {
    sequences.push([]);
  }

  let best = Infinity;
  for (const sequence of sequences) {
    const pickedCounts = mapCountFromInventory(sequence);
    const projectedInventory = applyCounts(inventoryCounts, pickedCounts);

    let routeCost = Infinity;
    if (sequence.length === 0) {
      routeCost = estimateDropEta({
        bot,
        dropOff: state.drop_off,
        graph,
        horizon: Math.max(24, profile.routing.horizon + 8),
      });
    } else {
      const routeEval = evaluateTypeSequenceRoute({
        graph,
        start: bot.position,
        dropOff: state.drop_off,
        typeSequence: sequence,
        shelvesByType,
        horizon: Math.max(24, profile.routing.horizon + 8),
        blockedApproaches,
        approachStats,
      });
      if (!routeEval) {
        continue;
      }
      routeCost = routeEval.totalCost;
    }

    if (!Number.isFinite(routeCost)) {
      continue;
    }

    const dropEval = evaluateDropGain({
      inventoryCounts: projectedInventory,
      activeDemand,
      previewDemand: new Map(),
    });
    const remainingCost = estimateRemainingDemandCost({
      remainingDemand: dropEval.remainingActiveDemand,
      resolveTypeRoundTripCost,
    });
    if (!Number.isFinite(remainingCost)) {
      continue;
    }

    best = Math.min(best, routeCost + remainingCost);
  }

  return best;
}

function maybeImmediateDrop({
  bot,
  activeDemand,
  dropOff,
  phase,
  botCount,
  completionInfeasible = false,
}) {
  const shouldDrop = shouldScheduleDropOff({
    bot,
    activeDemand,
    phase,
    dropOff,
    botCount,
    completionInfeasible,
  });
  const atDropoff = bot.position[0] === dropOff[0] && bot.position[1] === dropOff[1];

  if (atDropoff && shouldDrop) {
    return { bot: bot.id, action: 'drop_off' };
  }

  return null;
}

function decrementCooldownMap(cooldownMap) {
  const next = new Map();
  for (const [itemId, roundsLeft] of cooldownMap.entries()) {
    if (roundsLeft > 1) {
      next.set(itemId, roundsLeft - 1);
    }
  }

  return next;
}

function addAdaptiveCooldown({
  cooldownMap,
  failureMap,
  itemId,
  baseTtl = 4,
  maxTtl = 24,
}) {
  const currentFailures = failureMap.get(itemId) || 0;
  const nextFailures = currentFailures + 1;
  failureMap.set(itemId, nextFailures);

  const ttl = Math.min(maxTtl, baseTtl * (2 ** (nextFailures - 1)));
  const currentCooldown = cooldownMap.get(itemId) || 0;
  cooldownMap.set(itemId, Math.max(currentCooldown, ttl));
}

function approachCooldownKey(itemId, cell) {
  return `${itemId}@${encodeCoord(cell)}`;
}

function updateApproachStats({
  approachStats,
  itemId,
  approachCell,
  succeeded,
}) {
  if (!approachCell) {
    return null;
  }

  const key = approachCooldownKey(itemId, approachCell);
  const current = approachStats.get(key) || {
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
  const next = {
    successes: current.successes + (succeeded ? 1 : 0),
    failures: current.failures + (succeeded ? 0 : 1),
    consecutiveFailures: succeeded ? 0 : current.consecutiveFailures + 1,
  };
  approachStats.set(key, next);
  return { key, stats: next };
}

function recentEventCount(events, currentRound, withinRounds) {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  return events.reduce((count, eventRound) => (
    currentRound - eventRound <= withinRounds ? count + 1 : count
  ), 0);
}

function isBlockedApproach({
  blockedApproaches,
  itemId,
  cell,
}) {
  if (!blockedApproaches || blockedApproaches.size === 0) {
    return false;
  }

  return blockedApproaches.has(approachCooldownKey(itemId, cell));
}

function resolveRecoveryThreshold({ state, phase, profile }) {
  const base = profile.recovery?.no_progress_rounds ?? 15;
  const mid = profile.recovery?.mid_no_progress_rounds ?? 10;
  const late = profile.recovery?.late_no_progress_rounds ?? 6;
  const lateWindow = profile.recovery?.late_rounds_window ?? 60;
  const roundsLeft = Math.max(0, state.max_rounds - state.round);

  if (roundsLeft <= lateWindow) {
    return late;
  }

  if (phase === 'early') {
    return base;
  }

  return mid;
}

function isTwoCellOscillation(history, window = 6) {
  if (!Array.isArray(history) || history.length < window) {
    return false;
  }

  const tail = history.slice(-window);
  const first = tail[0];
  const second = tail[1];

  if (!first || !second || first === second) {
    return false;
  }

  for (let index = 0; index < tail.length; index += 1) {
    const expected = index % 2 === 0 ? first : second;
    if (tail[index] !== expected) {
      return false;
    }
  }

  return true;
}

function isConfinedLoop(history, {
  window = 12,
  maxUnique = 4,
  minLength = 8,
} = {}) {
  if (!Array.isArray(history) || history.length < minLength) {
    return false;
  }

  const tail = history.slice(-window);
  const unique = new Set(tail);
  return unique.size <= maxUnique;
}

function nearestNeededActiveShelf({
  bot,
  graph,
  items,
  activeDemand,
  blockedItems,
  blockedApproaches,
  approachStats,
  horizon,
}) {
  if ((bot.inventory || []).length >= 3) {
    return null;
  }

  const needed = copyCounts(activeDemand);
  for (const type of bot.inventory || []) {
    decrementCount(needed, type, 1);
  }

  let best = null;
  for (const item of items) {
    if ((needed.get(item.type) || 0) <= 0) {
      continue;
    }

    if (blockedItems.has(item.id)) {
      continue;
    }

    const toShelf = bestPathToAdjacentShelfCell(graph, bot.position, item.position, horizon, {
      shelfId: item.id,
      blockedApproaches,
      approachStats,
    });
    if (!toShelf) {
      continue;
    }

    const cost = Math.max(0, toShelf.path.length - 1);
    if (!best || cost < best.cost) {
      best = { item, path: toShelf.path, cost };
    }
  }

  return best;
}

function planSingleBotRecovery({
  state,
  world,
  graph,
  phase,
  profile,
  blockedItems,
  blockedApproaches,
  approachStats = null,
  completionInfeasible = false,
  suppressDropOff = false,
  forcePartialDrop = false,
  decisionStats = null,
}) {
  const bot = state.bots[0];
  const roundsLeft = Math.max(0, state.max_rounds - state.round);
  const inventoryCount = (bot.inventory || []).length;
  const forceInventoryFlush = forcePartialDrop && inventoryCount > 0;

  if (forceInventoryFlush && !suppressDropOff) {
    const atDropoff = bot.position[0] === state.drop_off[0] && bot.position[1] === state.drop_off[1];
    if (atDropoff) {
      return { bot: bot.id, action: 'drop_off' };
    }
  }

  const directDrop = suppressDropOff ? null : maybeImmediateDrop({
    bot,
    activeDemand: world.activeDemand,
    dropOff: state.drop_off,
    phase,
    botCount: state.bots.length,
    completionInfeasible,
  });
  if (directDrop) {
    return directDrop;
  }

  const allowTransitToDropOff = shouldScheduleDropOff({
    bot,
    activeDemand: world.activeDemand,
    phase,
    dropOff: state.drop_off,
    botCount: state.bots.length,
    completionInfeasible,
  }) || forceInventoryFlush;

  if (!suppressDropOff && allowTransitToDropOff && (hasDeliverableInventory(bot, world.activeDemand) || forceInventoryFlush)) {
    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: state.drop_off,
      reservations: new Map(),
      edgeReservations: new Map(),
      startTime: 0,
      horizon: Math.max(24, profile.routing.horizon + 8),
    });

    if (path && path.length >= 2) {
      const dropEta = Math.max(0, path.length - 1) + 1;
      if ((phase === 'endgame' || phase === 'cutoff') && dropEta > roundsLeft) {
        return { bot: bot.id, action: 'wait' };
      }

      return { bot: bot.id, action: moveToAction(path[0], path[1]) };
    }
  }

  const nearest = nearestNeededActiveShelf({
    bot,
    graph,
    items: state.items,
    activeDemand: world.activeDemand,
    blockedItems,
    blockedApproaches,
    approachStats,
    horizon: Math.max(24, profile.routing.horizon + 8),
  });

  if (nearest) {
    if (decisionStats) {
      decisionStats.targetItemId = nearest.item.id;
    }

    if (phase === 'endgame' || phase === 'cutoff') {
      const finalPickupCell = nearest.path?.[nearest.path.length - 1] || bot.position;
      const toDrop = findTimeAwarePath({
        graph,
        start: finalPickupCell,
        goal: state.drop_off,
        reservations: new Map(),
        edgeReservations: new Map(),
        startTime: 0,
        horizon: Math.max(24, profile.routing.horizon + 8),
      });

      if (!toDrop) {
        return { bot: bot.id, action: 'wait' };
      }

      const pickupCycleEta =
        Math.max(0, (nearest.path?.length || 1) - 1) +
        1 +
        Math.max(0, toDrop.length - 1) +
        1;
      if (pickupCycleEta > roundsLeft) {
        return { bot: bot.id, action: 'wait' };
      }
    }

    if ((bot.inventory || []).length < 3 && adjacentManhattan(bot.position, nearest.item.position)) {
      return { bot: bot.id, action: 'pick_up', item_id: nearest.item.id };
    }

    if (nearest.path && nearest.path.length >= 2) {
      return { bot: bot.id, action: moveToAction(nearest.path[0], nearest.path[1]) };
    }
  }

  return { bot: bot.id, action: 'wait' };
}

function planSingleBot({
  state,
  world,
  graph,
  phase,
  profile,
  blockedItems,
  blockedApproaches,
  approachStats = null,
  recoveryMode,
  completionCommitMode,
  suppressDropOff = false,
  forcePartialDrop = false,
  decisionStats = null,
}) {
  const bot = state.bots[0];
  const botCount = state.bots.length;
  const roundsLeft = Math.max(0, state.max_rounds - state.round);
  const inventoryCounts = mapCountFromInventory(bot.inventory);
  const activeGap = copyCounts(world.activeDemand);
  for (const [type, count] of inventoryCounts.entries()) {
    decrementCount(activeGap, type, count);
  }

  const freeSlots = Math.max(0, 3 - (bot.inventory || []).length);
  const activeRemaining = sumDemand(activeGap);
  const shelvesByType = new Map();
  for (const item of state.items) {
    if (blockedItems.has(item.id)) {
      continue;
    }

    const list = shelvesByType.get(item.type) || [];
    list.push(item);
    shelvesByType.set(item.type, list);
  }

  const resolveTypeRoundTripCost = createTypeRoundTripCostResolver({
    graph,
    dropOff: state.drop_off,
    shelvesByType,
    horizon: Math.max(24, profile.routing.horizon + 8),
    approachStats,
  });
  const minCompletionEta = estimateMinActiveCompletionEta({
    state,
    bot,
    graph,
    profile,
    activeDemand: world.activeDemand,
    inventoryCounts,
    shelvesByType,
    resolveTypeRoundTripCost,
    blockedApproaches,
    approachStats,
  });
  const completionInfeasible = (phase === 'endgame' || phase === 'cutoff') && minCompletionEta > roundsLeft;
  const projectedCompletionFeasible = Number.isFinite(minCompletionEta) && minCompletionEta <= roundsLeft;
  if (decisionStats) {
    decisionStats.orderEtaAtDecision = Number.isFinite(minCompletionEta) ? minCompletionEta : null;
    decisionStats.projectedCompletionFeasible = projectedCompletionFeasible;
  }

  if (recoveryMode) {
    return planSingleBotRecovery({
      state,
      world,
      graph,
      phase,
      profile,
      blockedItems,
      blockedApproaches,
      approachStats,
      completionInfeasible,
      suppressDropOff,
      forcePartialDrop,
      decisionStats,
    });
  }

  const directDrop = suppressDropOff ? null : maybeImmediateDrop({
    bot,
    activeDemand: world.activeDemand,
    dropOff: state.drop_off,
    phase,
    botCount,
    completionInfeasible,
  });
  if (directDrop) {
    return directDrop;
  }

  if (activeRemaining <= 1) {
    return planSingleBotRecovery({
      state,
      world,
      graph,
      phase,
      profile,
      blockedItems,
      blockedApproaches,
      approachStats,
      completionInfeasible,
      suppressDropOff,
      forcePartialDrop,
      decisionStats,
    });
  }

  const commitActiveOnly = completionCommitMode || activeRemaining <= 3;
  const allowPreview = !commitActiveOnly && (phase === 'early' || phase === 'mid') && freeSlots > activeRemaining;
  const typeSupply = buildTypeSupply({
    activeDemand: activeGap,
    previewDemand: world.previewDemand,
    allowPreview,
  });
  const sequences = enumerateTypeSequences(typeSupply, freeSlots);
  const futureDemandPenalty = profile.assignment.future_active_completion_penalty ?? 24;
  const infeasibleCompletionPenalty = profile.assignment.infeasible_completion_penalty ?? 80;

  let bestPlan = null;
  for (const sequence of sequences) {
    const pickedCounts = mapCountFromInventory(sequence);
    const projectedInventory = applyCounts(inventoryCounts, pickedCounts);
    const dropEval = evaluateDropGain({
      inventoryCounts: projectedInventory,
      activeDemand: world.activeDemand,
      previewDemand: world.previewDemand,
    });
    const routeEval = evaluateTypeSequenceRoute({
      graph,
      start: bot.position,
      dropOff: state.drop_off,
      typeSequence: sequence,
      shelvesByType,
      horizon: Math.max(24, profile.routing.horizon + 8),
      blockedApproaches,
      approachStats,
    });

    if (!routeEval || !routeEval.firstStep) {
      continue;
    }

    if (phase === 'endgame' || phase === 'cutoff') {
      const etaBuffer = phase === 'endgame' ? 1 : 0;
      const maxTripRounds = Math.max(0, roundsLeft - etaBuffer);
      if (routeEval.totalCost > maxTripRounds) {
        continue;
      }
    }

    if (phase === 'cutoff' && dropEval.points <= 0) {
      continue;
    }

    const remainingActiveCost = estimateRemainingDemandCost({
      remainingDemand: dropEval.remainingActiveDemand,
      resolveTypeRoundTripCost,
    });
    if (!Number.isFinite(remainingActiveCost)) {
      continue;
    }

    const projectedCompletionEta = routeEval.totalCost + remainingActiveCost;
    const leftover = Array.from(dropEval.remainingInventory.values()).reduce((sum, value) => sum + value, 0);
    const activeCompletionBonus = dropEval.activeCompleted ? (commitActiveOnly ? 2200 : 900) : 0;
    let utility = dropEval.points * 1000 + activeCompletionBonus - routeEval.totalCost * 15 - leftover * 20;
    utility -= remainingActiveCost * futureDemandPenalty;
    if ((phase === 'endgame' || phase === 'cutoff') && projectedCompletionEta > roundsLeft) {
      utility -= (projectedCompletionEta - roundsLeft) * infeasibleCompletionPenalty;
    }

    const candidate = {
      utility,
      points: dropEval.points,
      routeCost: routeEval.totalCost,
      projectedCompletionEta,
      firstStep: routeEval.firstStep,
      firstType: sequence[0],
    };

    if (!bestPlan || candidate.utility > bestPlan.utility || (
      candidate.utility === bestPlan.utility && candidate.routeCost < bestPlan.routeCost
    )) {
      bestPlan = candidate;
    }
  }

  if (!bestPlan) {
    if (hasDeliverableInventory(bot, world.activeDemand) && shouldScheduleDropOff({
      bot,
      activeDemand: world.activeDemand,
      phase,
      dropOff: state.drop_off,
      botCount,
      completionInfeasible,
    })) {
      if (bot.position[0] === state.drop_off[0] && bot.position[1] === state.drop_off[1]) {
        return { bot: bot.id, action: 'drop_off' };
      }

      const path = findTimeAwarePath({
        graph,
        start: bot.position,
        goal: state.drop_off,
        reservations: new Map(),
        edgeReservations: new Map(),
        startTime: 0,
        horizon: Math.max(24, profile.routing.horizon + 8),
      });

      if (path && path.length >= 2) {
        const dropEta = Math.max(0, path.length - 1) + 1;
        if ((phase === 'endgame' || phase === 'cutoff') && dropEta > roundsLeft) {
          return { bot: bot.id, action: 'wait' };
        }

        return { bot: bot.id, action: moveToAction(path[0], path[1]) };
      }
    }

    return { bot: bot.id, action: 'wait' };
  }

  const { shelf, path } = bestPlan.firstStep;
  if (decisionStats) {
    decisionStats.targetItemId = shelf.id;
  }
  if ((bot.inventory || []).length < 3 && adjacentManhattan(bot.position, shelf.position)) {
    return { bot: bot.id, action: 'pick_up', item_id: shelf.id };
  }

  if (path && path.length >= 2) {
    return { bot: bot.id, action: moveToAction(path[0], path[1]) };
  }

  return { bot: bot.id, action: 'wait' };
}

export class GroceryPlanner {
  constructor(profile) {
    this.profile = profile;
    this.previousPositions = new Map();
    this.stalls = new Map();
    this.forcedWait = new Map();
    this.lastMetrics = {};
    this.lastScore = null;
    this.noProgressRounds = 0;
    this.pendingPickups = new Map();
    this.blockedPickupByBot = new Map();
    this.blockedApproachByBot = new Map();
    this.pickupFailureStreakByBot = new Map();
    this.approachStatsByBot = new Map();
    this.pickupFailureRoundsByBot = new Map();
    this.recoveryBurstRounds = 0;
    this.resetTriggered = false;
    this.lastActionByBot = new Map();
    this.nonScoringDropStreakByBot = new Map();
    this.lastInventoryByBot = new Map();
    this.lastActiveOrderId = null;
    this.lastActiveOrderIdByBot = new Map();
    this.positionHistoryByBot = new Map();
    this.loopBreakRoundsByBot = new Map();
    this.loopDetectionsThisTick = 0;
    this.targetFocusByBot = new Map();
  }

  resetIntentState() {
    this.pendingPickups = new Map();
    this.blockedPickupByBot = new Map();
    this.blockedApproachByBot = new Map();
    this.pickupFailureStreakByBot = new Map();
    this.pickupFailureRoundsByBot = new Map();
    this.lastActionByBot = new Map();
    this.nonScoringDropStreakByBot = new Map();
    this.positionHistoryByBot = new Map();
    this.loopBreakRoundsByBot = new Map();
    this.targetFocusByBot = new Map();
  }

  getLastMetrics() {
    return this.lastMetrics;
  }

  plan(state) {
    this.resetTriggered = false;
    this.loopDetectionsThisTick = 0;
    const previousScore = this.lastScore;
    const scoreImproved = previousScore === null || state.score > previousScore;
    const activeOrder = state.orders?.find((order) => order.status === 'active' && !order.complete) || null;
    const activeOrderId = activeOrder?.id ?? null;
    const activeOrderChanged = this.lastActiveOrderId !== null && this.lastActiveOrderId !== activeOrderId;
    let operationalProgress = activeOrderChanged;

    for (const bot of state.bots) {
      const botId = bot.id;
      const inventoryKey = (bot.inventory || []).slice().sort().join('|');
      const previousInventory = this.lastInventoryByBot.get(botId);

      if (previousInventory !== undefined && previousInventory !== inventoryKey) {
        operationalProgress = true;
      }
    }

    if (scoreImproved) {
      this.noProgressRounds = 0;
      this.recoveryBurstRounds = 0;
    } else if (operationalProgress) {
      this.noProgressRounds = 0;
    } else {
      this.noProgressRounds += 1;
    }
    this.lastScore = state.score;

    const phase = getRoundPhase(state, this.profile);
    const recoveryThreshold = resolveRecoveryThreshold({
      state,
      phase,
      profile: this.profile,
    });
    const partialDropThreshold = this.profile.recovery?.partial_drop_no_progress_rounds ?? Math.max(18, recoveryThreshold * 2);
    const loopBreakRounds = this.profile.recovery?.loop_break_rounds ?? 5;
    const recoveryBurst = this.profile.recovery?.burst_rounds ?? 8;
    const runtime = this.profile.runtime || {};
    const maxConsecutiveApproachFailures = runtime.max_consecutive_pick_failures_before_forbid ?? 2;
    const approachForbidTtl = runtime.approach_forbid_ttl ?? 40;
    const pickFailureSpiralWindow = runtime.pick_failure_spiral_window ?? 10;
    const pickFailureSpiralThreshold = runtime.pick_failure_spiral_threshold ?? 3;
    const targetLockStallRounds = runtime.target_lock_stall_rounds ?? 12;
    const targetLockForbidTtl = runtime.target_lock_forbid_ttl ?? 30;
    const orderStallBailoutRounds = runtime.order_stall_bailout_rounds ?? 20;

    if (this.noProgressRounds === recoveryThreshold) {
      this.resetIntentState();
      this.recoveryBurstRounds = recoveryBurst;
      this.resetTriggered = true;
    }

    const recoveryMode = this.noProgressRounds >= recoveryThreshold || this.recoveryBurstRounds > 0;
    const forcePartialDrop = this.noProgressRounds >= partialDropThreshold;
    if (this.recoveryBurstRounds > 0) {
      this.recoveryBurstRounds -= 1;
    }

    for (const bot of state.bots) {
      const botId = bot.id;
      const coordKey = encodeCoord(bot.position);
      const history = [...(this.positionHistoryByBot.get(botId) || []), coordKey];
      if (history.length > 10) {
        history.shift();
      }
      this.positionHistoryByBot.set(botId, history);
      if (
        this.noProgressRounds >= 4
        && (
          isTwoCellOscillation(history, 6)
          || isConfinedLoop(history, { window: 12, maxUnique: 4, minLength: 8 })
        )
      ) {
        const remaining = this.loopBreakRoundsByBot.get(botId) || 0;
        this.loopBreakRoundsByBot.set(botId, Math.max(remaining, loopBreakRounds));
        this.loopDetectionsThisTick += 1;
      }

      const inventoryKey = (bot.inventory || []).slice().sort().join('|');
      this.lastInventoryByBot.set(botId, inventoryKey);
      const lastAction = this.lastActionByBot.get(botId);
      let dropStreak = this.nonScoringDropStreakByBot.get(botId) || 0;
      if (lastAction === 'drop_off') {
        dropStreak = scoreImproved ? 0 : dropStreak + 1;
      } else if (scoreImproved) {
        dropStreak = 0;
      }
      this.nonScoringDropStreakByBot.set(botId, dropStreak);

      const pending = this.pendingPickups.get(botId);
      const existingCooldown = this.blockedPickupByBot.get(botId) || new Map();
      const existingApproachCooldown = this.blockedApproachByBot.get(botId) || new Map();
      const failureMap = new Map(this.pickupFailureStreakByBot.get(botId) || new Map());
      const approachStats = new Map(this.approachStatsByBot.get(botId) || new Map());
      const failureRounds = [...(this.pickupFailureRoundsByBot.get(botId) || [])]
        .filter((round) => state.round - round <= pickFailureSpiralWindow);
      const nextCooldown = decrementCooldownMap(existingCooldown);
      const nextApproachCooldown = decrementCooldownMap(existingApproachCooldown);

      if (pending) {
        const inventorySize = (bot.inventory || []).length;
        const observedSuccess = inventorySize >= pending.expectedMinInventory;

        if (observedSuccess) {
          nextCooldown.delete(pending.itemId);
          failureMap.delete(pending.itemId);
          updateApproachStats({
            approachStats,
            itemId: pending.itemId,
            approachCell: pending.approachCell || bot.position,
            succeeded: true,
          });
          this.pendingPickups.delete(botId);
        } else if (state.round >= pending.resolveAfterRound) {
          const failedApproach = updateApproachStats({
            approachStats,
            itemId: pending.itemId,
            approachCell: pending.approachCell || bot.position,
            succeeded: false,
          });
          if (failedApproach && failedApproach.stats.consecutiveFailures >= maxConsecutiveApproachFailures) {
            const currentApproachCooldown = nextApproachCooldown.get(failedApproach.key) || 0;
            nextApproachCooldown.set(failedApproach.key, Math.max(currentApproachCooldown, approachForbidTtl));
          }
          addAdaptiveCooldown({
            cooldownMap: nextCooldown,
            failureMap,
            itemId: pending.itemId,
            baseTtl: 4,
            maxTtl: 24,
          });
          failureRounds.push(state.round);
          this.pendingPickups.delete(botId);
        }
      }

      this.blockedPickupByBot.set(botId, nextCooldown);
      this.blockedApproachByBot.set(botId, nextApproachCooldown);
      this.pickupFailureStreakByBot.set(botId, failureMap);
      this.approachStatsByBot.set(botId, approachStats);
      this.pickupFailureRoundsByBot.set(botId, failureRounds);
    }
    this.lastActiveOrderId = activeOrderId;

    const shelfWalls = state.items.map((item) => item.position);
    const graph = new GridGraph({
      ...state.grid,
      walls: [...state.grid.walls, ...shelfWalls],
    });
    const world = buildWorldContext(state);

    if (state.bots.length === 1) {
      const botId = state.bots[0].id;
      const loopBreakRemaining = this.loopBreakRoundsByBot.get(botId) || 0;
      const loopBreakActive = loopBreakRemaining > 0;
      if (loopBreakActive) {
        this.loopBreakRoundsByBot.set(botId, loopBreakRemaining - 1);
      }

      const existingBlockedPickup = new Map(this.blockedPickupByBot.get(botId) || new Map());
      const blockedItems = new Set(Array.from(existingBlockedPickup.keys()));
      const blockedApproaches = this.blockedApproachByBot.get(botId) || new Map();
      const approachStats = this.approachStatsByBot.get(botId) || new Map();
      const previousTargetFocus = this.targetFocusByBot.get(botId) || { itemId: null, ticks: 0, orderId: null };
      const inventoryEmpty = (state.bots[0].inventory || []).length === 0;
      let orderStallBailoutTriggered = false;

      if (
        activeOrderId
        && previousTargetFocus.orderId === activeOrderId
        && previousTargetFocus.itemId
        && inventoryEmpty
        && this.noProgressRounds >= orderStallBailoutRounds
      ) {
        const currentCooldown = existingBlockedPickup.get(previousTargetFocus.itemId) || 0;
        existingBlockedPickup.set(previousTargetFocus.itemId, Math.max(currentCooldown, targetLockForbidTtl));
        blockedItems.add(previousTargetFocus.itemId);
        this.blockedPickupByBot.set(botId, existingBlockedPickup);
        this.loopBreakRoundsByBot.set(
          botId,
          Math.max(this.loopBreakRoundsByBot.get(botId) || 0, loopBreakRounds),
        );
        orderStallBailoutTriggered = true;
      }

      const recentPickFailures = recentEventCount(
        this.pickupFailureRoundsByBot.get(botId) || [],
        state.round,
        pickFailureSpiralWindow,
      );
      const pickupFailureSpiralActive = (
        this.noProgressRounds > 0
        && recentPickFailures >= pickFailureSpiralThreshold
      );

      if (pickupFailureSpiralActive) {
        this.recoveryBurstRounds = Math.max(this.recoveryBurstRounds, 3);
        const pending = this.pendingPickups.get(botId);
        if (pending) {
          const current = existingBlockedPickup.get(pending.itemId) || 0;
          existingBlockedPickup.set(pending.itemId, Math.max(current, 8));
          this.blockedPickupByBot.set(botId, existingBlockedPickup);
          blockedItems.add(pending.itemId);
          this.pendingPickups.delete(botId);
        }
      }

      const effectiveRecoveryMode = recoveryMode || loopBreakActive || pickupFailureSpiralActive;
      const effectiveForcePartialDrop = forcePartialDrop || loopBreakActive || pickupFailureSpiralActive;
      const completionCommitMode = effectiveRecoveryMode || this.noProgressRounds >= Math.max(8, Math.floor(recoveryThreshold / 2));
      const decisionStats = {};
      const action = planSingleBot({
        state,
        world,
        graph,
        phase,
        profile: this.profile,
        blockedItems,
        blockedApproaches,
        approachStats,
        recoveryMode: effectiveRecoveryMode,
        completionCommitMode,
        forcePartialDrop: effectiveForcePartialDrop,
        decisionStats,
      });

      const nonScoringDropStreak = this.nonScoringDropStreakByBot.get(botId) || 0;
      let finalAction = action;
      if (action.action === 'drop_off' && nonScoringDropStreak >= 2) {
        finalAction = planSingleBot({
          state,
          world,
          graph,
          phase,
          profile: this.profile,
          blockedItems,
          blockedApproaches,
          approachStats,
          recoveryMode: true,
          completionCommitMode: true,
          suppressDropOff: true,
          forcePartialDrop: effectiveForcePartialDrop,
          decisionStats,
        });
      }

      const targetItemId = decisionStats.targetItemId || null;
      const sameTargetWithoutProgress = (
        targetItemId
        && previousTargetFocus.itemId === targetItemId
        && previousTargetFocus.orderId === activeOrderId
        && !scoreImproved
        && !operationalProgress
      );
      let targetLockTicks = targetItemId ? (sameTargetWithoutProgress ? previousTargetFocus.ticks + 1 : 1) : 0;
      let targetStallTriggered = false;
      if (targetItemId && targetLockTicks >= targetLockStallRounds) {
        const currentCooldown = existingBlockedPickup.get(targetItemId) || 0;
        existingBlockedPickup.set(targetItemId, Math.max(currentCooldown, targetLockForbidTtl));
        this.blockedPickupByBot.set(botId, existingBlockedPickup);
        this.loopBreakRoundsByBot.set(
          botId,
          Math.max(this.loopBreakRoundsByBot.get(botId) || 0, loopBreakRounds),
        );
        targetLockTicks = 0;
        targetStallTriggered = true;
      }

      this.targetFocusByBot.set(botId, {
        itemId: targetStallTriggered ? null : targetItemId,
        ticks: targetLockTicks,
        orderId: activeOrderId,
      });

      if (finalAction.action === 'pick_up') {
        const existingPending = this.pendingPickups.get(state.bots[0].id);
        const inventorySize = (state.bots[0].inventory || []).length;
        if (!existingPending || state.round >= existingPending.resolveAfterRound || existingPending.itemId !== finalAction.item_id) {
          this.pendingPickups.set(state.bots[0].id, {
            itemId: finalAction.item_id,
            expectedMinInventory: inventorySize + 1,
            resolveAfterRound: state.round + 2,
            approachCell: [...state.bots[0].position],
          });
        }
      }

      this.lastMetrics = {
        phase,
        taskCount: 1,
        forcedWaits: finalAction.action === 'wait' ? 1 : 0,
        stalledBots: 0,
        singleBotMode: true,
        recoveryMode: effectiveRecoveryMode,
        completionCommitMode,
        noProgressRounds: this.noProgressRounds,
        recoveryBurstRounds: this.recoveryBurstRounds,
        resetTriggered: this.resetTriggered,
        recoveryThreshold,
        partialDropThreshold,
        forcePartialDrop: effectiveForcePartialDrop,
        loopBreakActive,
        loopBreakRemaining,
        loopDetections: this.loopDetectionsThisTick,
        nonScoringDropStreak,
        recentPickFailures,
        pickupFailureSpiralActive,
        approachBlacklistSize: blockedApproaches.size,
        orderEtaAtDecision: decisionStats.orderEtaAtDecision ?? null,
        projectedCompletionFeasible: decisionStats.projectedCompletionFeasible ?? null,
        targetLockTicks,
        targetStallTriggered,
        orderStallBailoutTriggered,
      };

      this.lastActionByBot.set(botId, finalAction.action);
      return [finalAction];
    }

    const tasks = buildTasks(state, world, this.profile, phase);
    const costs = buildCostMatrix(state, tasks, this.profile, phase);
    const { assignment } = solveMinCostAssignment(costs);

    const taskByBot = new Map();
    for (let index = 0; index < state.bots.length; index += 1) {
      const taskIndex = assignment[index];
      if (taskIndex >= 0 && taskIndex < tasks.length) {
        taskByBot.set(state.bots[index].id, tasks[taskIndex]);
      }
    }

    const reservations = makeOccupancyReservations(state);
    const edgeReservations = new Map();

    const botsByPriority = [...state.bots].sort((a, b) => a.id - b.id);
    const singleBotMode = botsByPriority.length === 1;
    const actions = [];
    let forcedWaits = 0;

    for (const bot of botsByPriority) {
      const stallKey = `${bot.id}`;
      const forcedWaitRemaining = this.forcedWait.get(stallKey) || 0;
      if (!singleBotMode && forcedWaitRemaining > 0) {
        this.forcedWait.set(stallKey, forcedWaitRemaining - 1);
        const forcedPath = [bot.position];
        reservePath({
          path: forcedPath,
          startTime: 0,
          reservations,
          edgeReservations,
          horizon: this.profile.routing.horizon,
          holdAtGoal: true,
        });
        actions.push({ bot: bot.id, action: 'wait' });
        forcedWaits += 1;
        continue;
      }

      const task = taskByBot.get(bot.id);
      let resolved = null;

      if (task) {
        resolved = actionFromTask({
          bot,
          task,
          graph,
          reservations,
          edgeReservations,
          profile: this.profile,
          holdGoalSteps: this.profile.routing.hold_goal_steps,
        });
      }

      if (!resolved) {
        const fallback = chooseFallbackAction(bot, graph, reservations, edgeReservations, this.profile.routing.horizon);
        resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'fallback' };
      }

      if (resolved.action === 'wait' && task?.kind === 'pick_up' && (bot.inventory || []).length < 3) {
        const nearest = pickNearestRelevantItem(bot, state.items, getNeededTypes(world.activeDemand, world.previewDemand, this.profile.assignment.preview_item_weight));
        if (nearest && adjacentManhattan(bot.position, nearest.position)) {
          resolved = { action: 'pick_up', itemId: nearest.id, nextPath: [bot.position], targetType: 'item' };
        }
      }

      const previous = this.previousPositions.get(stallKey);
      const currentCoord = encodeCoord(bot.position);
      const stalled = previous === currentCoord;
      const stallCount = stalled ? (this.stalls.get(stallKey) || 0) + 1 : 0;
      this.stalls.set(stallKey, stallCount);

      if (!singleBotMode && stallCount >= this.profile.anti_deadlock.stall_threshold && resolved.action.startsWith('move_')) {
        const fallback = chooseFallbackAction(bot, graph, reservations, edgeReservations, this.profile.routing.horizon);
        resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'anti_deadlock' };
        this.forcedWait.set(stallKey, this.profile.anti_deadlock.forced_wait_rounds);
      }

      this.previousPositions.set(stallKey, currentCoord);

      reservePath({
        path: resolved.nextPath,
        startTime: 0,
        reservations,
        edgeReservations,
        horizon: this.profile.routing.horizon,
        holdAtGoal: true,
      });

      if (resolved.action === 'pick_up') {
        const existingPending = this.pendingPickups.get(bot.id);
        const inventorySize = (bot.inventory || []).length;
        if (!existingPending || existingPending.itemId !== resolved.itemId) {
          this.pendingPickups.set(bot.id, {
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

      this.lastActionByBot.set(bot.id, resolved.action);
    }

    this.lastMetrics = {
      phase,
      taskCount: tasks.length,
      forcedWaits,
      stalledBots: Array.from(this.stalls.values()).filter((value) => value > 0).length,
      recoveryMode,
      noProgressRounds: this.noProgressRounds,
      recoveryThreshold,
      loopDetections: this.loopDetectionsThisTick,
      approachBlacklistSize: 0,
      orderEtaAtDecision: null,
      projectedCompletionFeasible: null,
    };

    return actions;
  }
}
