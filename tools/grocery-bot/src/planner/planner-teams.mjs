/**
 * Team-based bot assignment strategy (team_v1).
 * Splits bots into persistent teams assigned to orders.
 * Active teams pick up + deliver items for the current order.
 * Prefetch teams pre-position near items for upcoming orders.
 * Idle bots spread to parking positions.
 *
 * KEY DESIGN: Any bot carrying deliverable items for the active order
 * will deliver them regardless of team assignment. Delivery decisions
 * use the full (original) demand, not decremented copies.
 */
import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from '../utils/coords.mjs';
import { findTimeAwarePath, reservePath } from '../routing/routing.mjs';
import { buildDemand, countInventoryByType } from '../utils/world-model.mjs';
import {
  hasDeliverableInventory,
  countDeliverableInventory,
  nearestDropOff,
  isAtAnyDropOff,
  closestAdjacentCell,
  primaryDropOff,
} from './planner-utils.mjs';
import {
  sumCounts,
  reserveInventoryForDemand,
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

  let bestTarget = null;
  let bestDistance = Infinity;
  for (const item of candidates) {
    const distance = manhattanDistance(bot.position, item.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = item;
    }
  }
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
}) {
  const round = state.round;
  const teamsConfig = profile.teams || {};
  const activeBotRatio = teamsConfig.active_bot_ratio ?? 1.2;
  const activeMaxBots = teamsConfig.active_max_bots ?? 5;
  const previewBotRatio = teamsConfig.preview_bot_ratio ?? 0.8;
  const previewMaxBots = teamsConfig.preview_max_bots ?? 3;
  const reassignCooldown = teamsConfig.reassign_cooldown ?? 5;
  const prefetchLookahead = teamsConfig.prefetch_lookahead_ticks ?? 80;

  const activeOrder = world.activeOrder;
  const previewOrder = world.previewOrder;
  const upcomingOrders = getUpcomingOracleOrders(
    oracle,
    round,
    activeOrder?.id,
    previewOrder?.id,
    prefetchLookahead,
  );

  const allBotIds = state.bots.map((b) => b.id);
  const botById = new Map(state.bots.map((b) => [b.id, b]));
  const teams = [];
  const assignedBots = new Set();
  let nextTeamId = 0;
  const openerBreakoutTicks = teamsConfig.opener_breakout_ticks ?? 8;
  const openerBreakoutActiveCap = teamsConfig.opener_breakout_active_cap ?? 3;
  const inOpenerBreakout = lastOpenerRound !== null
    && (round - lastOpenerRound) <= openerBreakoutTicks;

  // FIX #3: Preserve existing active team if order unchanged and within cooldown
  const existingActiveTeam = existingTeams?.find((t) => t.role === 'active');
  if (
    existingActiveTeam
    && activeOrder
    && existingActiveTeam.orderId === activeOrder.id
    && (round - existingActiveTeam.assignedAtTick) < reassignCooldown * 10
  ) {
    const validBots = existingActiveTeam.botIds.filter((id) => botById.has(id));
    if (validBots.length > 0) {
      teams.push({
        teamId: nextTeamId++,
        orderId: activeOrder.id,
        botIds: validBots,
        role: 'active',
        assignedAtTick: existingActiveTeam.assignedAtTick,
      });
      validBots.forEach((id) => assignedBots.add(id));
    }
  }

  // Build active team if not preserved
  if (activeOrder && !teams.find((t) => t.role === 'active')) {
    const activeDemand = world.activeDemand;
    const itemsNeeded = sumCounts(activeDemand);
    let teamSize = Math.min(activeMaxBots, Math.max(2, Math.ceil(itemsNeeded * activeBotRatio)));
    if (inOpenerBreakout) {
      teamSize = Math.min(teamSize, openerBreakoutActiveCap);
    }

    // Prioritize bots carrying deliverable items, then by distance
    const cluster = orderItemClusterCenter(activeOrder, state.items);
    const availableBots = allBotIds
      .filter((id) => !assignedBots.has(id))
      .sort((aId, bId) => {
        const aBot = botById.get(aId);
        const bBot = botById.get(bId);
        const aDel = hasDeliverableInventory(aBot, activeDemand) ? 0 : 1;
        const bDel = hasDeliverableInventory(bBot, activeDemand) ? 0 : 1;
        if (aDel !== bDel) return aDel - bDel;
        const aDist = cluster ? manhattanDistance(aBot.position, cluster) : aId;
        const bDist = cluster ? manhattanDistance(bBot.position, cluster) : bId;
        return aDist - bDist;
      });

    const picked = inOpenerBreakout
      ? pickDiversifiedBots(availableBots, botById, teamSize, 2)
      : availableBots.slice(0, teamSize);
    if (picked.length > 0) {
      teams.push({
        teamId: nextTeamId++,
        orderId: activeOrder.id,
        botIds: picked,
        role: 'active',
        assignedAtTick: round,
      });
      picked.forEach((id) => assignedBots.add(id));
    }
  }

  // FIX #3: Preserve existing prefetch team if target unchanged and within cooldown
  const existingPrefetchTeam = existingTeams?.find((t) => t.role === 'prefetch');
  const prefetchTarget = previewOrder || upcomingOrders[0] || null;
  if (
    existingPrefetchTeam
    && prefetchTarget
    && existingPrefetchTeam.orderId === prefetchTarget.id
    && (round - existingPrefetchTeam.assignedAtTick) < reassignCooldown * 10
  ) {
    const validBots = existingPrefetchTeam.botIds.filter((id) => botById.has(id) && !assignedBots.has(id));
    if (validBots.length > 0) {
      teams.push({
        teamId: nextTeamId++,
        orderId: prefetchTarget.id,
        botIds: validBots,
        role: 'prefetch',
        assignedAtTick: existingPrefetchTeam.assignedAtTick,
      });
      validBots.forEach((id) => assignedBots.add(id));
    }
  }

  // Build prefetch team if not preserved
  if (!inOpenerBreakout && prefetchTarget && !teams.find((t) => t.role === 'prefetch')) {
    const itemsRequired = (prefetchTarget.items_required || []).length;
    const teamSize = Math.min(previewMaxBots, Math.max(1, Math.ceil(itemsRequired * previewBotRatio)));

    const cluster = orderItemClusterCenter(prefetchTarget, state.items);
    const availableBots = allBotIds
      .filter((id) => !assignedBots.has(id))
      .sort((aId, bId) => {
        const aDist = cluster ? manhattanDistance(botById.get(aId).position, cluster) : aId;
        const bDist = cluster ? manhattanDistance(botById.get(bId).position, cluster) : bId;
        return aDist - bDist;
      });

    const picked = availableBots.slice(0, teamSize);
    if (picked.length > 0) {
      teams.push({
        teamId: nextTeamId++,
        orderId: prefetchTarget.id,
        botIds: picked,
        role: 'prefetch',
        assignedAtTick: round,
      });
      picked.forEach((id) => assignedBots.add(id));
    }
  }

  // Remaining bots form idle team
  const idleBots = allBotIds.filter((id) => !assignedBots.has(id));
  if (idleBots.length > 0) {
    teams.push({
      teamId: nextTeamId++,
      orderId: null,
      botIds: idleBots,
      role: 'idle',
      assignedAtTick: round,
    });
  }

  return teams;
}

// ─── Universal delivery check ───────────────────────────────────────

/**
 * FIX #1 + #2: Any bot carrying deliverable items for the active order
 * should deliver, regardless of team. Uses the ORIGINAL demand (not
 * decremented), so multiple carriers all see they should deliver.
 */
function tryDeliverForActiveOrder({ bot, state, world, graph, reservations, edgeReservations, profile }) {
  // Check against the original demand (not decremented by other bots)
  if (!hasDeliverableInventory(bot, world.activeDemand)) {
    return null;
  }

  if (isAtAnyDropOff(bot.position, state)) {
    return { action: 'drop_off', nextPath: [bot.position], targetType: 'drop_off', noPath: false };
  }

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
  return { action: 'wait', nextPath: [bot.position], targetType: 'drop_off', noPath: true };
}

// ─── Task resolution per team ───────────────────────────────────────

/**
 * Resolve action for a single bot on the active team.
 * FIX #1: Uses shelfDemand (decremented) for PICKUP decisions only.
 * Delivery decisions use the universal tryDeliverForActiveOrder which
 * checks the original world.activeDemand.
 */
function resolveActiveBotAction({
  bot,
  state,
  world,
  graph,
  reservations,
  edgeReservations,
  profile,
  reservedItemIds,
  shelfDemand,
  allowBreakout = false,
}) {
  // Deliver if carrying items for active order (uses original demand)
  const deliveryAction = tryDeliverForActiveOrder({
    bot, state, world, graph, reservations, edgeReservations, profile,
  });
  if (deliveryAction) return deliveryAction;

  // Pick up an item for the active order (uses shelf demand — decremented)
  if ((bot.inventory || []).length < 3) {
    const neededTypes = new Set(
      Array.from(shelfDemand.entries()).filter(([, c]) => c > 0).map(([t]) => t),
    );

    if (neededTypes.size > 0) {
      const candidates = state.items.filter((item) =>
        neededTypes.has(item.type) && !reservedItemIds.has(item.id),
      );

      // Check if adjacent to a candidate — immediate pick up
      for (const item of candidates) {
        if (adjacentManhattan(bot.position, item.position)) {
          reservedItemIds.add(item.id);
          shelfDemand.set(item.type, Math.max(0, (shelfDemand.get(item.type) || 0) - 1));
          return { action: 'pick_up', itemId: item.id, nextPath: [bot.position], targetType: 'item', noPath: false };
        }
      }

      // Navigate to closest candidate
      let bestItem = null;
      let bestScore = Infinity;
      for (const item of candidates) {
        const dist = manhattanDistance(bot.position, item.position);
        if (dist < bestScore) {
          bestScore = dist;
          bestItem = item;
        }
      }

      if (bestItem) {
        reservedItemIds.add(bestItem.id);
        shelfDemand.set(bestItem.type, Math.max(0, (shelfDemand.get(bestItem.type) || 0) - 1));

        const target = closestAdjacentCell(
          graph, bot.position, bestItem.position,
          reservations, edgeReservations, profile.routing.horizon,
        );
        if (target?.path?.length >= 2) {
          return { action: moveToAction(target.path[0], target.path[1]), nextPath: target.path, targetType: 'item', noPath: false };
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
        return { action: 'wait', nextPath: [bot.position], targetType: 'item', noPath: true };
      }
    }
  }

  // Nothing to pick up — park near drop-off (ready for next delivery)
  const dropOff = nearestDropOff(bot.position, state);
  const parking = chooseParkingAction({
    bot, graph, reservations, edgeReservations,
    horizon: profile.routing.horizon, dropOff,
    otherBots: state.bots, items: state.items,
    gridWidth: state.grid?.width, gridHeight: state.grid?.height,
  });
  return { action: parking.action, nextPath: parking.path, targetType: 'parking', noPath: false };
}

/**
 * Resolve action for a single bot on the prefetch team.
 * FIX #2: Full-inventory bots with no deliverable items park near
 * drop-off instead of waiting forever. Bots with deliverables deliver.
 */
function resolvePrefetchBotAction({
  bot,
  state,
  world,
  graph,
  reservations,
  edgeReservations,
  profile,
  targetOrder,
  reservedItemIds,
  prefetchContext,
}) {
  // FIX #2: Deliver if carrying items for active order (uses original demand)
  const deliveryAction = tryDeliverForActiveOrder({
    bot, state, world, graph, reservations, edgeReservations, profile,
  });
  if (deliveryAction) return deliveryAction;

  // FIX #2: Full inventory with nothing deliverable — park near drop-off, don't wait forever
  if ((bot.inventory || []).length >= 3) {
    const dropOff = nearestDropOff(bot.position, state);
    const parking = chooseParkingAction({
      bot, graph, reservations, edgeReservations,
      horizon: profile.routing.horizon, dropOff,
      otherBots: state.bots, items: state.items,
      gridWidth: state.grid?.width, gridHeight: state.grid?.height,
    });
    return { action: parking.action, nextPath: parking.path, targetType: 'prefetch_parking', noPath: false };
  }

  if (!targetOrder) {
    return { action: 'wait', nextPath: [bot.position], targetType: 'prefetch_idle', noPath: false };
  }

  if (!prefetchContext.wavePickupEnabled) {
    const cluster = orderItemClusterCenter(targetOrder, state.items);
    if (cluster) {
      const path = findTimeAwarePath({
        graph, start: bot.position, goal: cluster,
        reservations, edgeReservations, startTime: 0, horizon: profile.routing.horizon,
      });
      if (path && path.length >= 2) {
        return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'prefetch_position', noPath: false };
      }
    }
    return { action: 'wait', nextPath: [bot.position], targetType: 'prefetch_hold', noPath: false };
  }

  if ((prefetchContext.reservedFutureCounts?.size || 0) === 0) {
    // Pre-position near the order's item cluster
    const cluster = orderItemClusterCenter(targetOrder, state.items);
    if (cluster) {
      const path = findTimeAwarePath({
        graph, start: bot.position, goal: cluster,
        reservations, edgeReservations, startTime: 0, horizon: profile.routing.horizon,
      });
      if (path && path.length >= 2) {
        return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'prefetch_position', noPath: false };
      }
    }
    return { action: 'wait', nextPath: [bot.position], targetType: 'prefetch_idle', noPath: false };
  }

  const claimedWaveItem = claimFutureWaveItem({
    bot,
    state,
    graph,
    reservations,
    edgeReservations,
    profile,
    reservedItemIds,
    reservedFutureCounts: prefetchContext.reservedFutureCounts,
    activeDemand: world.activeDemand,
  });
  if (claimedWaveItem) return claimedWaveItem;

  const futureCandidates = state.items.filter((item) =>
    (prefetchContext.reservedFutureCounts.get(item.type) || 0) > 0 && !reservedItemIds.has(item.id),
  );
  const nearestFutureItem = futureCandidates
    .sort((a, b) => manhattanDistance(bot.position, a.position) - manhattanDistance(bot.position, b.position))[0];
  if (nearestFutureItem) {
    const greedyStep = chooseGreedyApproachStep({
      bot,
      item: nearestFutureItem,
      graph,
      reservations,
      edgeReservations,
    });
    if (greedyStep) {
      return { ...greedyStep, targetType: 'prefetch_approach' };
    }
  }

  // No candidates — position near cluster
  const cluster = orderItemClusterCenter(targetOrder, state.items);
  if (cluster) {
    const path = findTimeAwarePath({
      graph, start: bot.position, goal: cluster,
      reservations, edgeReservations, startTime: 0, horizon: profile.routing.horizon,
    });
    if (path && path.length >= 2) {
      return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'prefetch_position', noPath: false };
    }
  }

  return { action: 'wait', nextPath: [bot.position], targetType: 'prefetch_idle', noPath: false };
}

/**
 * Resolve action for an idle bot.
 * FIX #2: Idle bots also deliver if carrying active items.
 */
function resolveIdleBotAction({ bot, state, world, graph, reservations, edgeReservations, profile }) {
  // Deliver if carrying items for active order
  const deliveryAction = tryDeliverForActiveOrder({
    bot, state, world, graph, reservations, edgeReservations, profile,
  });
  if (deliveryAction) return deliveryAction;

  const dropOff = nearestDropOff(bot.position, state);
  const parking = chooseParkingAction({
    bot, graph, reservations, edgeReservations,
    horizon: profile.routing.horizon, dropOff,
    otherBots: state.bots, items: state.items,
    gridWidth: state.grid?.width, gridHeight: state.grid?.height,
  });
  return { action: parking.action, nextPath: parking.path, targetType: 'idle_parking', noPath: false };
}

// ─── Strategy executor (called from planner-multibot-runtime.mjs) ───

export function executeTeamStrategy({
  planner,
  state,
  world,
  graph,
  phase,
  recoveryMode,
  recoveryThreshold,
  blockedItemsByBot,
  oracle,
}) {
  // Build or update teams
  const teams = buildTeams({
    state,
    world,
    oracle,
    existingTeams: planner._teams || null,
    profile: planner.profile,
    lastOpenerRound: planner.lastOpenerRound,
  });
  planner._teams = teams;

  // Build team lookup
  const teamByBot = new Map();
  for (const team of teams) {
    for (const botId of team.botIds) {
      teamByBot.set(botId, team);
    }
  }

  // Find the target order for prefetch teams
  const previewOrder = world.previewOrder;
  const upcomingOrders = getUpcomingOracleOrders(
    oracle,
    state.round,
    world.activeOrder?.id,
    previewOrder?.id,
    planner.profile.teams?.prefetch_lookahead_ticks ?? 80,
  );

  const reservations = makeOccupancyReservations(state);
  const edgeReservations = new Map();
  const reservedItemIds = new Set();

  // FIX #1: shelfDemand is decremented for PICKUP reservations only.
  // Delivery decisions use world.activeDemand (original, immutable).
  const shelfDemand = new Map(world.activeDemand);
  const teamsConfig = planner.profile.teams || {};
  const coverage = analyzeActiveDemandCoverage({
    state,
    world,
    threshold: teamsConfig.prefetch_enable_remaining_threshold ?? 2,
    requireCoverage: teamsConfig.prefetch_require_active_coverage ?? true,
  });
  const prefetchContext = buildPrefetchWavePlan({
    state,
    world,
    oracle,
    lookahead: teamsConfig.prefetch_lookahead_ticks ?? 80,
    orderCount: teamsConfig.wave_order_count ?? 3,
    prefetchBlockedByActiveDemand: coverage.prefetchBlockedByActiveDemand,
  });
  const openerBreakoutTicks = teamsConfig.opener_breakout_ticks ?? 8;
  const inOpenerBreakout = planner.lastOpenerRound !== null
    && (state.round - planner.lastOpenerRound) <= openerBreakoutTicks;

  // Priority: any bot with deliverables first, then active > prefetch > idle
  const rolePriority = { active: 0, prefetch: 1, idle: 2 };
  const botsByPriority = [...state.bots].sort((a, b) => {
    // Any bot with deliverable items gets top priority (regardless of team)
    const aDel = hasDeliverableInventory(a, world.activeDemand) ? 0 : 1;
    const bDel = hasDeliverableInventory(b, world.activeDemand) ? 0 : 1;
    if (aDel !== bDel) return aDel - bDel;
    // Then by team role
    const aTeam = teamByBot.get(a.id);
    const bTeam = teamByBot.get(b.id);
    const aRole = rolePriority[aTeam?.role] ?? 9;
    const bRole = rolePriority[bTeam?.role] ?? 9;
    if (aRole !== bRole) return aRole - bRole;
    return a.id - b.id;
  });

  const actions = [];
  let forcedWaits = 0;

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
      });
      continue;
    }

    // Resolve action based on team role
    let resolved;
    if (team?.role === 'active') {
      resolved = resolveActiveBotAction({
        bot, state, world, graph,
        reservations, edgeReservations, profile: planner.profile,
        reservedItemIds, shelfDemand,
        allowBreakout: inOpenerBreakout,
      });
    } else if (team?.role === 'prefetch') {
      const targetOrder = previewOrder
        || state.orders?.find((o) => o.id === team.orderId)
        || upcomingOrders.find((o) => o.id === team.orderId)
        || upcomingOrders[0]
        || null;
      resolved = resolvePrefetchBotAction({
        bot, state, world, graph,
        reservations, edgeReservations, profile: planner.profile,
        targetOrder, reservedItemIds,
        prefetchContext,
      });
    } else {
      resolved = resolveIdleBotAction({
        bot, state, world, graph,
        reservations, edgeReservations, profile: planner.profile,
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
      team?.role === 'active'
      && inOpenerBreakout
      && resolved.targetType === 'item'
      && (!resolved.nextPath || resolved.nextPath.length <= 1)
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
    });
  }

  // Build team summary for metrics
  const teamSummary = teams.map((t) => ({
    teamId: t.teamId,
    role: t.role,
    orderId: t.orderId,
    botCount: t.botIds.length,
    botIds: t.botIds,
  }));

  planner.lastMetrics = {
    phase,
    strategy: 'team_v1',
    taskCount: teams.filter((t) => t.role !== 'idle').reduce((s, t) => s + t.botIds.length, 0),
    forcedWaits,
    stalledBots: Array.from(planner.stalls.values()).filter((v) => v > 0).length,
    recoveryMode,
    noProgressRounds: planner.noProgressRounds,
    recoveryThreshold,
    loopDetections: planner.loopDetectionsThisTick,
    approachBlacklistSize: Array.from(blockedItemsByBot.values()).reduce((sum, blocked) => sum + blocked.size, 0),
    orderEtaAtDecision: null,
    projectedCompletionFeasible: null,
    prefetchBlockedByActiveDemand: coverage.prefetchBlockedByActiveDemand,
    activeCoverageSatisfied: coverage.activeCoverageSatisfied,
    waveOrderIds: prefetchContext.waveOrderIds,
    waveReservedCounts: Object.fromEntries(prefetchContext.reservedFutureCounts),
    wavePickupEnabled: prefetchContext.wavePickupEnabled,
    openerBreakoutActive: inOpenerBreakout,
    teams: teamSummary,
    botDetails: Object.fromEntries(planner._botDetails),
    zoneAssignment: planner.zoneAssignmentByBot ? { ...planner.zoneAssignmentByBot } : null,
  };

  return actions;
}
