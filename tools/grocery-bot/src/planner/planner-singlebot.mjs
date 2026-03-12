/**
 * Single-bot (easy) strategy: sequence enumeration, recovery, and cooldowns.
 * Evaluates candidate pickup-type sequences and scores them by
 * (delivery points - route cost - leftover penalty).
 */
import { encodeCoord, adjacentManhattan, moveToAction } from '../utils/coords.mjs';
import { findTimeAwarePath } from '../routing/routing.mjs';
import {
  hasDeliverableInventory,
  shouldScheduleDropOff,
  countDeliverableInventory,
  isAtAnyDropOff,
  nearestDropOff,
} from './planner-utils.mjs';

// --- Inventory / demand helpers ---

export function mapCountFromInventory(inventory) {
  const counts = new Map();
  for (const type of inventory || []) {
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  return counts;
}

export function sumDemand(map) {
  return Array.from(map.values()).reduce((sum, value) => sum + value, 0);
}

export function copyCounts(map) {
  return new Map(Array.from(map.entries()));
}

export function applyCounts(base, delta) {
  const next = copyCounts(base);
  for (const [type, count] of delta.entries()) {
    next.set(type, (next.get(type) || 0) + count);
  }

  return next;
}

export function decrementCount(map, type, count = 1) {
  map.set(type, Math.max(0, (map.get(type) || 0) - count));
}

export function deliverFromInventoryToDemand(inventoryCounts, demand) {
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

// --- Drop gain evaluation ---

export function evaluateDropGain({
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

// --- Route enumeration and evaluation ---

export function buildTypeSupply({ activeDemand, previewDemand, allowPreview }) {
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

export function enumerateTypeSequences(typeSupply, maxLen) {
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

export function bestPathToAdjacentShelfCell(graph, from, shelfPosition, horizon, {
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

export function evaluateTypeSequenceRoute({
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

export function createTypeRoundTripCostResolver({
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

export function estimateRemainingDemandCost({
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

export function estimateDropEta({
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

export function estimateMinActiveCompletionEta({
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
        dropOff: nearestDropOff(bot.position, state),
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
        dropOff: nearestDropOff(bot.position, state),
        graph,
        horizon: Math.max(24, profile.routing.horizon + 8),
      });
    } else {
      const routeEval = evaluateTypeSequenceRoute({
        graph,
        start: bot.position,
        dropOff: nearestDropOff(bot.position, state),
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

// --- Drop scheduling ---

export function maybeImmediateDrop({
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
  const atDropoff = Array.isArray(dropOff?.[0])
    ? isAtAnyDropOff(bot.position, { drop_offs: dropOff })
    : (bot.position[0] === dropOff[0] && bot.position[1] === dropOff[1]);

  if (atDropoff && shouldDrop) {
    return { bot: bot.id, action: 'drop_off' };
  }

  return null;
}

// --- Cooldown and approach tracking ---

export function decrementCooldownMap(cooldownMap) {
  const next = new Map();
  for (const [itemId, roundsLeft] of cooldownMap.entries()) {
    if (roundsLeft > 1) {
      next.set(itemId, roundsLeft - 1);
    }
  }

  return next;
}

export function addAdaptiveCooldown({
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

export function approachCooldownKey(itemId, cell) {
  return `${itemId}@${encodeCoord(cell)}`;
}

export function updateApproachStats({
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

export function recentEventCount(events, currentRound, withinRounds) {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  return events.reduce((count, eventRound) => (
    currentRound - eventRound <= withinRounds ? count + 1 : count
  ), 0);
}

export function isBlockedApproach({
  blockedApproaches,
  itemId,
  cell,
}) {
  if (!blockedApproaches || blockedApproaches.size === 0) {
    return false;
  }

  return blockedApproaches.has(approachCooldownKey(itemId, cell));
}

// --- Recovery threshold and oscillation detection ---

export function resolveRecoveryThreshold({ state, phase, profile }) {
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

export function isTwoCellOscillation(history, window = 6) {
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

export function isConfinedLoop(history, {
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

// --- Recovery shelf selection ---

export function nearestNeededActiveShelf({
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

// --- Recovery planner ---

export function planSingleBotRecovery({
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
  const forceInventoryFlush = forcePartialDrop && inventoryCount > 0 && hasDeliverableInventory(bot, world.activeDemand);

  if (!suppressDropOff && roundsLeft <= 1) {
    const atDropoff = isAtAnyDropOff(bot.position, state);
    if (atDropoff && hasDeliverableInventory(bot, world.activeDemand)) {
      return { bot: bot.id, action: 'drop_off' };
    }
  }

  if (forceInventoryFlush && !suppressDropOff) {
    const atDropoff = isAtAnyDropOff(bot.position, state);
    if (atDropoff) {
      return { bot: bot.id, action: 'drop_off' };
    }
  }

  const directDrop = suppressDropOff ? null : maybeImmediateDrop({
    bot,
    activeDemand: world.activeDemand,
    dropOff: nearestDropOff(bot.position, state),
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
    dropOff: nearestDropOff(bot.position, state),
    botCount: state.bots.length,
    completionInfeasible,
  }) || forceInventoryFlush;

  if (!suppressDropOff && allowTransitToDropOff && (hasDeliverableInventory(bot, world.activeDemand) || forceInventoryFlush)) {
    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: nearestDropOff(bot.position, state),
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
        goal: nearestDropOff(finalPickupCell, state),
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
