import { manhattanDistance } from './coords.mjs';
import { findTimeAwarePath } from './routing.mjs';

export function cloneDemand(map) {
  return new Map(Array.from(map.entries()));
}

export function decrementDemand(demand, type) {
  if (!demand.has(type)) {
    return;
  }

  demand.set(type, Math.max(0, demand.get(type) - 1));
}

export function hasDeliverableInventory(bot, activeDemand) {
  const inventoryDemand = cloneDemand(activeDemand);
  for (const itemType of bot.inventory || []) {
    if ((inventoryDemand.get(itemType) || 0) > 0) {
      return true;
    }
  }

  return false;
}

export function countDeliverableInventory(bot, activeDemand) {
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

export function shouldScheduleDropOff({
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

export function getRoundPhase(state, profile) {
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

export function getNeededTypes(activeDemand, previewDemand, previewWeight, allowPreview) {
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

export function estimateCongestion(cell, bots) {
  let congestion = 0;
  for (const bot of bots) {
    const distance = manhattanDistance(cell, bot.position);
    if (distance <= 2) {
      congestion += 1 / Math.max(1, distance);
    }
  }

  return congestion;
}

export function estimateDistanceToDropoff(item, dropOff) {
  return Math.max(1, manhattanDistance(item.position, dropOff) - 1);
}

export function pickNearestRelevantItem(bot, items, neededTypes) {
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

export function closestAdjacentCell(graph, from, itemPosition, reservations, edgeReservations, horizon) {
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
