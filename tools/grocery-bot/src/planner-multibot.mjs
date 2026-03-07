import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from './coords.mjs';
import { findTimeAwarePath, reservePath } from './routing.mjs';
import { countInventoryByType } from './world-model.mjs';
import {
  hasDeliverableInventory,
  shouldScheduleDropOff,
  getNeededTypes,
  estimateCongestion,
  estimateDistanceToDropoff,
  closestAdjacentCell,
} from './planner-utils.mjs';
import {
  sumCounts,
  reserveInventoryForDemand,
  estimateZonePenalty,
} from './planner-multibot-common.mjs';

export { estimateZonePenalty } from './planner-multibot-common.mjs';

export function buildTasks(state, world, profile, phase) {
  const tasks = [];
  const inventoryCounts = countInventoryByType(state.bots);
  const {
    remainingDemand: activeDemand,
    surplusInventory,
  } = reserveInventoryForDemand(inventoryCounts, world.activeDemand);
  const {
    remainingDemand: previewDemand,
    surplusInventory: remainingPreviewSurplus,
  } = reserveInventoryForDemand(surplusInventory, world.previewDemand);

  const totalActiveMissing = sumCounts(activeDemand);
  const totalFreeSlots = state.bots.reduce((sum, bot) => sum + Math.max(0, 3 - (bot.inventory || []).length), 0);
  const previewReserveSlots = profile.assignment.preview_reserve_slots ?? Math.max(2, Math.ceil(state.bots.length / 3));
  const previewCarrySoftCap = profile.assignment.preview_carry_soft_cap ?? Math.max(3, Math.ceil(state.bots.length / 2));
  const allowPreviewPrefetch = (
    phase !== 'cutoff'
    && sumCounts(previewDemand) > 0
    && totalFreeSlots > totalActiveMissing + previewReserveSlots
    && sumCounts(remainingPreviewSurplus) <= previewCarrySoftCap
  );

  const neededTypes = getNeededTypes(
    activeDemand,
    previewDemand,
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
    const budget = activeCount > 0
      ? activeCount + activeTaskBuffer
      : previewCount > 0
        ? previewCount + previewTaskBuffer
        : 0;
    if (budget <= 0) {
      continue;
    }

    const items = [...(itemsByType.get(type) || [])]
      .sort((a, b) => estimateDistanceToDropoff(a, state.drop_off) - estimateDistanceToDropoff(b, state.drop_off))
      .slice(0, budget);

    for (const item of items) {
      tasks.push({
        key: `item:${item.id}`,
        kind: 'pick_up',
        target: item.position,
        item,
        botScoped: false,
        demandScore: score,
        sourceOrder: activeCount > 0 ? 'active' : 'preview',
      });
    }
  }

  return tasks;
}

export function buildCostMatrix(state, tasks, profile, phase, context = {}) {
  const matrix = [];
  const urgency = phase === 'endgame' ? 1.5 : phase === 'cutoff' ? 2.0 : 1;
  const blockedItemsByBot = context.blockedItemsByBot || new Map();

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

      if (task.kind === 'pick_up') {
        const blockedItems = blockedItemsByBot.get(bot.id);
        if (blockedItems?.has(task.item.id)) {
          row.push(1e9);
          continue;
        }
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
      const zonePenalty = estimateZonePenalty({ bot, task, state, profile });

      const score =
        travelToTask * profile.assignment.travel_to_item +
        travelToDropOff * profile.assignment.travel_item_to_dropoff +
        congestion * profile.assignment.congestion_penalty +
        contention * profile.assignment.contention_penalty +
        zonePenalty -
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
  blockedNextStepCoords = null,
  blockedServiceBayCoords = null,
}) {
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
      blockedNextStepCoords,
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
    {
      blockedNextStepCoords,
      blockedGoalCoords: blockedServiceBayCoords,
    },
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
  blockedNextStepCoords = null,
) {
  for (const neighbor of graph.neighbors(bot.position)) {
    const moveKey = encodeCoord(neighbor);
    if (blockedNextStepCoords?.has(moveKey)) {
      continue;
    }

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
      blockedNextStepCoords,
    });

    if (path && path.length >= 2) {
      return { action: moveToAction(path[0], path[1]), path };
    }
  }

  return { action: 'wait', path: [bot.position] };
}
