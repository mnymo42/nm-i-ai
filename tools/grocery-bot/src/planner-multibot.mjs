import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from './coords.mjs';
import { findTimeAwarePath, reservePath } from './routing.mjs';
import { countInventoryByType } from './world-model.mjs';
import {
  cloneDemand,
  hasDeliverableInventory,
  shouldScheduleDropOff,
  getNeededTypes,
  estimateCongestion,
  estimateDistanceToDropoff,
  closestAdjacentCell,
} from './planner-utils.mjs';

export function buildTasks(state, world, profile, phase) {
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
  const allowPreviewPrefetch = phase !== 'cutoff' && totalFreeSlots > totalActiveMissing;

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

export function makeOccupancyReservations(state) {
  const reservations = new Map();
  reservations.set(0, new Set(state.bots.map((bot) => encodeCoord(bot.position))));
  return reservations;
}

export function actionFromTask({ bot, task, graph, reservations, edgeReservations, profile, holdGoalSteps }) {
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

export function chooseFallbackAction(bot, graph, reservations, edgeReservations, horizon) {
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
