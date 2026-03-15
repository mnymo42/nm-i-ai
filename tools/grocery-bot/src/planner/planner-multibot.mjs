import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from '../utils/coords.mjs';
import { findTimeAwarePath, reservePath } from '../routing/routing.mjs';
import { countInventoryByType } from '../utils/world-model.mjs';
import {
  hasDeliverableInventory,
  countDeliverableInventory,
  shouldScheduleDropOff,
  getNeededTypes,
  estimateCongestion,
  estimateDistanceToDropoff,
  isAtAnyDropOff,
  nearestDropOff,
  closestAdjacentCell,
} from './planner-utils.mjs';
import {
  sumCounts,
  reserveInventoryForDemand,
  estimateZonePenalty,
} from './planner-multibot-common.mjs';

export { estimateZonePenalty } from './planner-multibot-common.mjs';

function buildOracleDemand(oracle, currentTick, activeOrderId, previewOrderId) {
  if (!oracle?.known_orders) return new Map();

  const demand = new Map();
  const knownIds = new Set();
  if (activeOrderId) knownIds.add(activeOrderId);
  if (previewOrderId) knownIds.add(previewOrderId);

  // Look ahead for ALL future orders — we know them from the oracle, pre-stage everything
  for (const order of oracle.known_orders) {
    if (knownIds.has(order.id)) continue;
    if (order.first_seen_tick < currentTick) continue;

    // Weight by proximity: next orders get higher demand score
    const ticksAway = Math.max(1, order.first_seen_tick - currentTick);
    const weight = ticksAway <= 60 ? 1.0 : ticksAway <= 120 ? 0.6 : 0.3;

    for (const itemType of order.items_required) {
      demand.set(itemType, (demand.get(itemType) || 0) + weight);
    }
  }

  return demand;
}

export function buildTasks(state, world, profile, phase, oracle, currentTick) {
  const tasks = [];
  // Only count inventory from bots reasonably close to drop-off as "covering" active demand.
  // Far-away bots' items still exist but shouldn't block creating new pickup tasks for closer bots.
  const dropOff = (state.drop_offs || [state.drop_off])[0] || [0, 0];
  const nearThreshold = 15; // bots within 15 Manhattan distance count as "near"
  const nearBots = state.bots.filter(b => manhattanDistance(b.position, dropOff) <= nearThreshold);
  const nearInventory = countInventoryByType(nearBots);
  const fullInventory = countInventoryByType(state.bots);
  const {
    remainingDemand: activeDemand,
    surplusInventory,
  } = reserveInventoryForDemand(nearInventory, world.activeDemand);
  // For preview demand, use full inventory (far bots carrying preview items are still useful)
  const activeSatisfied = new Map(world.activeDemand);
  for (const [type, count] of nearInventory.entries()) {
    if (activeSatisfied.has(type)) activeSatisfied.set(type, Math.max(0, activeSatisfied.get(type) - count));
  }
  const { surplusInventory: fullSurplus } = reserveInventoryForDemand(fullInventory, world.activeDemand);
  const {
    remainingDemand: previewDemand,
    surplusInventory: remainingPreviewSurplus,
  } = reserveInventoryForDemand(fullSurplus, world.previewDemand);

  const totalActiveMissing = sumCounts(activeDemand);
  const totalFreeSlots = state.bots.reduce((sum, bot) => sum + Math.max(0, 3 - (bot.inventory || []).length), 0);
  const previewReserveSlots = profile.assignment.preview_reserve_slots ?? Math.max(2, Math.ceil(state.bots.length / 3));
  const previewCarrySoftCap = profile.assignment.preview_carry_soft_cap ?? Math.max(3, Math.ceil(state.bots.length / 2));

  const previewPickerCap = profile.assignment.preview_picker_cap ?? Math.max(2, Math.floor(state.bots.length / 3));
  let botsCarryingPreview = 0;
  for (const bot of state.bots) {
    const inv = bot.inventory || [];
    if (inv.length === 0) continue;
    const hasActiveItem = inv.some((type) => (world.activeDemand.get(type) || 0) > 0);
    if (!hasActiveItem) botsCarryingPreview += 1;
  }

  const allowPreviewPrefetch = (
    phase !== 'cutoff'
    && state.bots.length > 1
    && sumCounts(previewDemand) > 0
    && totalFreeSlots > totalActiveMissing + previewReserveSlots
    && sumCounts(remainingPreviewSurplus) <= previewCarrySoftCap
    && botsCarryingPreview < previewPickerCap
  );

  const neededTypes = getNeededTypes(
    activeDemand,
    previewDemand,
    profile.assignment.preview_item_weight,
    allowPreviewPrefetch,
  );

  const oracleDemand = buildOracleDemand(
    oracle,
    currentTick ?? 0,
    world.activeOrder?.id,
    world.previewOrder?.id,
  );
  const oracleWeight = profile.assignment.oracle_item_weight ?? 0.15;
  // With oracle, aggressively pre-stage: treat oracle demand at preview-level priority
  const aggressiveOracle = oracle?.known_orders?.length > 0;
  const effectiveOracleWeight = aggressiveOracle ? 0.7 : oracleWeight;
  if (oracleDemand.size > 0) {
    for (const [type, count] of oracleDemand.entries()) {
      if (!neededTypes.has(type)) {
        neededTypes.set(type, count * effectiveOracleWeight);
      }
    }
  }

  // Collect all bots eligible for drop-off, then cap to avoid congestion at drop zone
  const dropCandidates = [];
  for (const bot of state.bots) {
    const deliverable = hasDeliverableInventory(bot, world.activeDemand);

    if (deliverable && shouldScheduleDropOff({
      bot,
      activeDemand: world.activeDemand,
      phase,
      dropOff: nearestDropOff(bot.position, state),
      botCount: state.bots.length,
    })) {
      const deliverableCount = countDeliverableInventory(bot, world.activeDemand);
      const dropOff = nearestDropOff(bot.position, state);
      const dropDist = manhattanDistance(bot.position, dropOff);
      dropCandidates.push({ bot, deliverableCount, dropOff, dropDist });
    }
  }

  // Sort by distance (closest first), cap to avoid drop-off gridlock
  // With many bots, allow more simultaneous drop runners — stagger by distance naturally
  const maxDropRunners = profile.assignment.max_drop_runners ?? Math.max(3, Math.ceil(state.bots.length / 2));
  dropCandidates.sort((a, b) => a.dropDist - b.dropDist);
  for (const { bot, deliverableCount, dropOff, dropDist } of dropCandidates.slice(0, maxDropRunners)) {
    const distanceCompensation = Math.max(0, dropDist * 0.8);
    tasks.push({
      key: `drop:${bot.id}`,
      kind: 'drop_off',
      botScoped: true,
      botId: bot.id,
      target: dropOff,
      item: null,
      demandScore: 4 + deliverableCount * 3 + distanceCompensation,
    });
  }

  const itemsByType = new Map();
  for (const item of state.items) {
    if (!neededTypes.has(item.type)) {
      continue;
    }

    if (phase === 'cutoff' && (world.activeDemand.get(item.type) || 0) === 0) {
      continue;
    }

    const list = itemsByType.get(item.type) || [];
    list.push(item);
    itemsByType.set(item.type, list);
  }

  const activeTaskBuffer = profile.assignment.active_task_buffer ?? Math.max(1, Math.ceil(state.bots.length / 4));
  const previewTaskBuffer = profile.assignment.preview_task_buffer ?? 1;

  for (const [type, score] of neededTypes.entries()) {
    const activeCount = activeDemand.get(type) || 0;
    const previewCount = allowPreviewPrefetch ? (previewDemand.get(type) || 0) : 0;
    const oracleCount = oracleDemand.get(type) || 0;
    // With aggressive oracle: give oracle items a generous budget (up to half the bots)
    const oracleBudgetCap = aggressiveOracle
      ? Math.ceil(state.bots.length / 2)
      : Math.ceil(state.bots.length / 3);
    const budget = activeCount > 0
      ? activeCount + activeTaskBuffer
      : previewCount > 0
        ? previewCount + previewTaskBuffer
        : oracleCount > 0
          ? Math.min(Math.ceil(oracleCount), oracleBudgetCap)
          : 0;
    if (budget <= 0) {
      continue;
    }

    const items = [...(itemsByType.get(type) || [])]
      .sort((a, b) => estimateDistanceToDropoff(a, state.drop_offs || state.drop_off) - estimateDistanceToDropoff(b, state.drop_offs || state.drop_off))
      .slice(0, budget);

    for (const item of items) {
      const sourceOrder = activeCount > 0 ? 'active' : previewCount > 0 ? 'preview' : 'oracle';
      tasks.push({
        key: `item:${item.id}`,
        kind: 'pick_up',
        target: item.position,
        item,
        botScoped: false,
        demandScore: score,
        sourceOrder,
      });
    }
  }

  return tasks;
}

export function buildCostMatrix(state, tasks, profile, phase) {
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
        ? estimateDistanceToDropoff(task.item, state.drop_offs || state.drop_off)
        : Math.max(0, manhattanDistance(task.target, nearestDropOff(task.target, state)));
      const congestion = estimateCongestion(task.target, state.bots.filter((candidate) => candidate.id !== bot.id));
      const contention = task.kind === 'pick_up'
        ? state.bots.filter((candidate) => candidate.id !== bot.id && manhattanDistance(candidate.position, task.target) < 4).length
        : 0;
      const demandBonus = task.demandScore * profile.assignment.remaining_demand_priority;

      const score =
        travelToTask * profile.assignment.travel_to_item +
        travelToDropOff * profile.assignment.travel_item_to_dropoff +
        congestion * profile.assignment.congestion_penalty +
        contention * profile.assignment.contention_penalty +
        demandBonus * urgency -
        profile.assignment.urgency_bonus * urgency;

      row.push(score);
    }

    matrix.push(row);
  }

  return matrix;
}

export function makeOccupancyReservations(state) {
  const reservations = new Map();
  reservations.set(0, new Set(state.bots.map((bot) => encodeCoord(bot.position))));
  return reservations;
}

export function actionFromTask({
  bot,
  task,
  graph,
  reservations,
  edgeReservations,
  profile,
  holdGoalSteps,
  previousPosition,
}) {
  if (task.kind === 'drop_off') {
    if (isAtAnyDropOff(bot.position, { drop_offs: [task.target] })) {
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
    // Server requires bot to be stationary before pickup (momentum causes failed pickups)
    const botMoved = previousPosition && previousPosition !== encodeCoord(bot.position);
    if (botMoved) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'item', waitingForPickup: true };
    }
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

export function chooseFallbackAction(
  bot,
  graph,
  reservations,
  edgeReservations,
  horizon,
) {
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

function computeParkingSlots(graph, gridWidth, gridHeight, items) {
  const trafficLaneCells = graph.trafficLaneCells || new Set();
  const hasLanes = trafficLaneCells.size > 0;

  const itemCols = [...new Set(items.map((item) => item.position[0]))].sort((a, b) => a - b);

  // Lane-aware parking: find cells adjacent to lanes but not on them
  if (hasLanes) {
    const directionalPreference = graph.directionalPreference || new Map();
    const slots = [];
    for (const col of itemCols) {
      for (let y = 1; y < gridHeight - 1; y += 1) {
        const candidates = [[col, y], [col + 1, y], [col - 1, y]];
        for (const candidate of candidates) {
          const key = encodeCoord(candidate);
          if (!graph.isWalkable(candidate) || trafficLaneCells.has(key)) continue;
          if (directionalPreference.has(key)) continue;
          const laneAdjacency = graph.neighbors(candidate)
            .some((neighbor) => trafficLaneCells.has(encodeCoord(neighbor)));
          if (!laneAdjacency) continue;
          slots.push(candidate);
          y = gridHeight;
          break;
        }
      }
    }
    return [...new Map(slots.map((slot) => [encodeCoord(slot), slot])).values()];
  }

  // Default parking: use corridor rows
  const corridorRows = [];
  for (let y = 1; y < gridHeight - 1; y += 1) {
    let open = 0;
    for (let x = 1; x < gridWidth - 1; x += 1) {
      if (graph.isWalkable([x, y])) open += 1;
    }
    if (open >= gridWidth - 4) corridorRows.push(y);
  }

  const parkRow = corridorRows.length >= 2
    ? corridorRows[corridorRows.length - 2]
    : corridorRows.length > 0
      ? corridorRows[corridorRows.length - 1]
      : gridHeight - 2;

  const slots = [];
  for (const col of itemCols) {
    if (graph.isWalkable([col, parkRow])) {
      slots.push([col, parkRow]);
    } else if (graph.isWalkable([col + 1, parkRow])) {
      slots.push([col + 1, parkRow]);
    } else if (graph.isWalkable([col - 1, parkRow])) {
      slots.push([col - 1, parkRow]);
    }
  }
  return slots;
}

export function chooseParkingAction({
  bot,
  graph,
  reservations,
  edgeReservations,
  horizon,
  dropOff,
  otherBots,
  items,
  gridWidth,
  gridHeight,
}) {
  const neighbors = [...graph.neighbors(bot.position)];
  if (neighbors.length === 0) {
    return { action: 'wait', path: [bot.position] };
  }

  const slots = computeParkingSlots(graph, gridWidth || 28, gridHeight || 18, items || []);
  const queueCells = new Set(
    otherBots
      .filter((other) => manhattanDistance(other.position, dropOff) <= 1)
      .map((other) => encodeCoord(other.position)),
  );
  const feederCells = new Set();
  for (let y = Math.max(1, dropOff[1] - 2); y <= Math.min((gridHeight || 18) - 2, dropOff[1] + 1); y += 1) {
    for (let x = Math.max(1, dropOff[0]); x <= Math.min((gridWidth || 28) - 2, dropOff[0] + 3); x += 1) {
      feederCells.add(encodeCoord([x, y]));
    }
  }

  let targetSlot = null;
  if (slots.length > 0) {
    const otherBotSlots = new Set();
    for (const other of otherBots) {
      if (other.id === bot.id) continue;
      let bestSlotIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < slots.length; i += 1) {
        const d = manhattanDistance(other.position, slots[i]);
        if (d < bestDist) { bestDist = d; bestSlotIdx = i; }
      }
      if (bestDist <= 2) otherBotSlots.add(bestSlotIdx);
    }

    let bestDist = Infinity;
    for (let i = 0; i < slots.length; i += 1) {
      if (otherBotSlots.has(i)) continue;
      if (queueCells.has(encodeCoord(slots[i]))) continue;
      if (feederCells.has(encodeCoord(slots[i]))) continue;
      const d = manhattanDistance(bot.position, slots[i]);
      if (d < bestDist) { bestDist = d; targetSlot = slots[i]; }
    }

    if (!targetSlot) {
      let fallbackBest = Infinity;
      for (const slot of slots) {
        if (queueCells.has(encodeCoord(slot))) continue;
        if (feederCells.has(encodeCoord(slot))) continue;
        const d = manhattanDistance(bot.position, slot);
        if (d < fallbackBest) { fallbackBest = d; targetSlot = slot; }
      }
    }
  }

  if (targetSlot) {
    if (bot.position[0] === targetSlot[0] && bot.position[1] === targetSlot[1]) {
      return { action: 'wait', path: [bot.position] };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: targetSlot,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon,
    });

    if (path && path.length >= 2) {
      return { action: moveToAction(path[0], path[1]), path };
    }
  }

  const scored = [];
  for (const neighbor of neighbors) {
    const moveKey = encodeCoord(neighbor);
    if (reservations.get(1)?.has(moveKey)) continue;
    const reverse = `${encodeCoord(neighbor)}>${encodeCoord(bot.position)}`;
    if (edgeReservations.get(1)?.has(reverse)) continue;

    const dropDist = manhattanDistance(neighbor, dropOff);
    const botDropDist = manhattanDistance(bot.position, dropOff);
    let crowding = 0;
    for (const other of otherBots) {
      if (other.id === bot.id) continue;
      const dist = manhattanDistance(neighbor, other.position);
      if (dist <= 1) crowding += 4;
      else if (dist <= 2) crowding += 2;
      else if (dist <= 3) crowding += 1;
    }

    const score = dropDist - botDropDist + (dropDist > botDropDist ? 2 : 0) - crowding;
    scored.push({ neighbor, score });
  }

  scored.sort((a, b) => b.score - a.score);

  for (const { neighbor } of scored) {
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
