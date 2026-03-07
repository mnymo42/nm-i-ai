import { solveMinCostAssignment } from './assignment.mjs';
import { encodeCoord, adjacentManhattan } from './coords.mjs';
import { reservePath } from './routing.mjs';
import { getNeededTypes, pickNearestRelevantItem } from './planner-utils.mjs';
import {
  buildTasks,
  buildCostMatrix,
  makeOccupancyReservations,
  actionFromTask,
  chooseFallbackAction,
} from './planner-multibot.mjs';
import {
  buildMediumMissionAssignments,
  resolveMissionAction,
} from './planner-missions.mjs';

function queuePendingPickup(planner, bot, itemId, round) {
  const existingPending = planner.pendingPickups.get(bot.id);
  const inventorySize = (bot.inventory || []).length;
  if (!existingPending || existingPending.itemId !== itemId) {
    planner.pendingPickups.set(bot.id, {
      itemId,
      expectedMinInventory: inventorySize + 1,
      resolveAfterRound: round + 2,
      approachCell: [...bot.position],
    });
  }
}

function buildBlockedNextStepCoords(occupiedNextStep, bot) {
  const blocked = new Set(occupiedNextStep);
  blocked.delete(encodeCoord(bot.position));
  return blocked;
}

function updateOccupiedNextStep(occupiedNextStep, bot, resolved) {
  const currentKey = encodeCoord(bot.position);
  if (resolved?.action?.startsWith('move_') && resolved.nextPath?.length >= 2) {
    occupiedNextStep.delete(currentKey);
    return;
  }

  occupiedNextStep.add(currentKey);
}

export function executeMissionStrategy({
  planner,
  state,
  world,
  graph,
  phase,
  recoveryMode,
  recoveryThreshold,
  blockedItemsByBot,
  previousPositionByBot,
  previousInventoryKeyByBot,
}) {
  const missionPlan = buildMediumMissionAssignments({
    state,
    world,
    graph,
    profile: planner.profile,
    phase,
    round: state.round,
    existingMissionsByBot: planner.missionsByBot,
    blockedItemsByBot,
    previousPositionByBot,
    previousInventoryKeyByBot,
  });
  planner.missionsByBot = missionPlan.missionsByBot;

  const reservations = makeOccupancyReservations(state);
  const edgeReservations = new Map();
  const occupiedNextStep = new Set(state.bots.map((bot) => encodeCoord(bot.position)));
  const botsByPriority = [...state.bots].sort((a, b) => a.id - b.id);
  const actions = [];
  let forcedWaits = 0;

  for (const bot of botsByPriority) {
    const stallKey = `${bot.id}`;
    const blockedNextStepCoords = buildBlockedNextStepCoords(occupiedNextStep, bot);
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
      updateOccupiedNextStep(occupiedNextStep, bot, { action: 'wait', nextPath: [bot.position] });
      actions.push({ bot: bot.id, action: 'wait' });
      forcedWaits += 1;
      continue;
    }

    const mission = planner.missionsByBot.get(bot.id) || null;
    let resolved = resolveMissionAction({
      bot,
      mission,
      state,
      graph,
      reservations,
      edgeReservations,
      profile: planner.profile,
      blockedNextStepCoords,
      blockedServiceBayCoords: blockedNextStepCoords,
    });

    const previous = planner.previousPositions.get(stallKey);
    const currentCoord = encodeCoord(bot.position);
    const stalled = previous === currentCoord;
    const stallCount = stalled ? (planner.stalls.get(stallKey) || 0) + 1 : 0;
    planner.stalls.set(stallKey, stallCount);

    if (stallCount >= planner.profile.anti_deadlock.stall_threshold && resolved.action.startsWith('move_')) {
      const fallback = chooseFallbackAction(
        bot,
        graph,
        reservations,
        edgeReservations,
        planner.profile.routing.horizon,
        blockedNextStepCoords,
      );
      resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'anti_deadlock', noPath: false };
      planner.forcedWait.set(stallKey, planner.profile.anti_deadlock.forced_wait_rounds);
    }

    planner.previousPositions.set(stallKey, currentCoord);

    reservePath({
      path: resolved.nextPath,
      startTime: 0,
      reservations,
      edgeReservations,
      horizon: planner.profile.routing.horizon,
      holdAtGoal: resolved.targetType !== 'drop_off',
    });
    updateOccupiedNextStep(occupiedNextStep, bot, resolved);

    if (mission) {
      mission.noPathRounds = resolved.noPath ? (mission.noPathRounds || 0) + 1 : 0;
      planner.missionsByBot.set(bot.id, mission);
    }

    if (resolved.action === 'pick_up') {
      queuePendingPickup(planner, bot, resolved.itemId, state.round);
      actions.push({ bot: bot.id, action: 'pick_up', item_id: resolved.itemId });
    } else {
      actions.push({ bot: bot.id, action: resolved.action });
    }

    planner.lastActionByBot.set(bot.id, resolved.action);
  }

  planner.lastMetrics = {
    phase,
    taskCount: Array.from(planner.missionsByBot.values()).filter((mission) => mission?.missionType !== 'idle_reposition').length,
    forcedWaits,
    stalledBots: Array.from(planner.stalls.values()).filter((value) => value > 0).length,
    recoveryMode,
    noProgressRounds: planner.noProgressRounds,
    recoveryThreshold,
    loopDetections: planner.loopDetectionsThisTick,
    approachBlacklistSize: Array.from(blockedItemsByBot.values()).reduce((sum, blocked) => sum + blocked.size, 0),
    orderEtaAtDecision: null,
    projectedCompletionFeasible: null,
    ...missionPlan.metrics,
  };

  return actions;
}

export function executeAssignedTaskStrategy({
  planner,
  state,
  world,
  graph,
  phase,
  recoveryMode,
  recoveryThreshold,
  blockedItemsByBot,
}) {
  const tasks = buildTasks(state, world, planner.profile, phase);
  const costs = buildCostMatrix(state, tasks, planner.profile, phase, { blockedItemsByBot });
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
  const occupiedNextStep = new Set(state.bots.map((bot) => encodeCoord(bot.position)));
  const botsByPriority = [...state.bots].sort((a, b) => a.id - b.id);
  const actions = [];
  let forcedWaits = 0;

  for (const bot of botsByPriority) {
    const stallKey = `${bot.id}`;
    const blockedNextStepCoords = buildBlockedNextStepCoords(occupiedNextStep, bot);
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
      updateOccupiedNextStep(occupiedNextStep, bot, { action: 'wait', nextPath: [bot.position] });
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
        profile: planner.profile,
        holdGoalSteps: planner.profile.routing.hold_goal_steps,
        blockedNextStepCoords,
        blockedServiceBayCoords: blockedNextStepCoords,
      });
    }

    if (!resolved) {
      const fallback = chooseFallbackAction(
        bot,
        graph,
        reservations,
        edgeReservations,
        planner.profile.routing.horizon,
        blockedNextStepCoords,
      );
      resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'fallback' };
    }

    if (resolved.action === 'wait' && task?.kind === 'pick_up' && (bot.inventory || []).length < 3) {
      const nearest = pickNearestRelevantItem(
        bot,
        state.items,
        getNeededTypes(world.activeDemand, world.previewDemand, planner.profile.assignment.preview_item_weight),
      );
      if (nearest && adjacentManhattan(bot.position, nearest.position)) {
        resolved = { action: 'pick_up', itemId: nearest.id, nextPath: [bot.position], targetType: 'item' };
      }
    }

    const previous = planner.previousPositions.get(stallKey);
    const currentCoord = encodeCoord(bot.position);
    const stalled = previous === currentCoord;
    const stallCount = stalled ? (planner.stalls.get(stallKey) || 0) + 1 : 0;
    planner.stalls.set(stallKey, stallCount);

    if (stallCount >= planner.profile.anti_deadlock.stall_threshold && resolved.action.startsWith('move_')) {
      const fallback = chooseFallbackAction(
        bot,
        graph,
        reservations,
        edgeReservations,
        planner.profile.routing.horizon,
        blockedNextStepCoords,
      );
      resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'anti_deadlock' };
      planner.forcedWait.set(stallKey, planner.profile.anti_deadlock.forced_wait_rounds);
    }

    planner.previousPositions.set(stallKey, currentCoord);

    reservePath({
      path: resolved.nextPath,
      startTime: 0,
      reservations,
      edgeReservations,
      horizon: planner.profile.routing.horizon,
      holdAtGoal: resolved.targetType !== 'drop_off',
    });
    updateOccupiedNextStep(occupiedNextStep, bot, resolved);

    if (resolved.action === 'pick_up') {
      queuePendingPickup(planner, bot, resolved.itemId, state.round);
      actions.push({ bot: bot.id, action: 'pick_up', item_id: resolved.itemId });
    } else {
      actions.push({ bot: bot.id, action: resolved.action });
    }

    planner.lastActionByBot.set(bot.id, resolved.action);
  }

  planner.lastMetrics = {
    phase,
    taskCount: tasks.length,
    forcedWaits,
    stalledBots: Array.from(planner.stalls.values()).filter((value) => value > 0).length,
    recoveryMode,
    noProgressRounds: planner.noProgressRounds,
    recoveryThreshold,
    loopDetections: planner.loopDetectionsThisTick,
    approachBlacklistSize: 0,
    orderEtaAtDecision: null,
    projectedCompletionFeasible: null,
  };

  return actions;
}
