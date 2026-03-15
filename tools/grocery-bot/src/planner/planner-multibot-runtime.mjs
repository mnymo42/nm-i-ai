import { solveMinCostAssignment } from '../routing/assignment.mjs';
import { encodeCoord, adjacentManhattan, manhattanDistance } from '../utils/coords.mjs';
import { reservePath } from '../routing/routing.mjs';
import { getNeededTypes, pickNearestRelevantItem, nearestDropOff, hasDeliverableInventory } from './planner-utils.mjs';
import {
  buildTasks,
  buildCostMatrix,
  makeOccupancyReservations,
  actionFromTask,
  chooseFallbackAction,
  chooseParkingAction,
} from './planner-multibot.mjs';
import {
  buildMediumMissionAssignments,
  resolveMissionAction,
} from './planner-missions.mjs';
import {
  buildWarehouseAssignments,
  resolveWarehouseMissionAction,
} from './planner-warehouse.mjs';
export { executeTeamStrategy } from './planner-teams.mjs';

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

  // Priority ordering: droppers first, then by distance to target, then by ID
  const dropOffs = state.drop_offs || (state.drop_off ? [state.drop_off] : []);
  const activeDemand = world?.activeDemand || new Map();
  const botsByPriority = [...state.bots].sort((a, b) => {
    const aMission = planner.missionsByBot.get(a.id);
    const bMission = planner.missionsByBot.get(b.id);
    // Bots carrying deliverable items for active order get highest priority
    const aDeliverable = hasDeliverableInventory(a, activeDemand) ? 0 : 1;
    const bDeliverable = hasDeliverableInventory(b, activeDemand) ? 0 : 1;
    if (aDeliverable !== bDeliverable) return aDeliverable - bDeliverable;
    // Then by mission type: drop_active > pickup_active > pickup_preview > rest
    const missionPriority = { drop_active: 0, pickup_active: 1, pickup_preview: 2 };
    const aPri = missionPriority[aMission?.missionType] ?? 9;
    const bPri = missionPriority[bMission?.missionType] ?? 9;
    if (aPri !== bPri) return aPri - bPri;
    // Then by distance to target (closer = higher priority)
    const aTarget = aMission?.targetCell;
    const bTarget = bMission?.targetCell;
    const aDist = aTarget ? manhattanDistance(a.position, aTarget) : 99;
    const bDist = bTarget ? manhattanDistance(b.position, bTarget) : 99;
    if (aDist !== bDist) return aDist - bDist;
    return a.id - b.id;
  });

  const actions = [];
  let forcedWaits = 0;

  for (const bot of botsByPriority) {
    const stallKey = `${bot.id}`;
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
    planner._botDetails.set(bot.id, {
      target: resolved.nextPath?.at(-1) || null,
      path: resolved.nextPath || [],
      taskType: resolved.targetType || (mission?.missionType ?? 'none'),
      stallCount: planner.stalls.get(stallKey) || 0,
      orderId: mission?.orderId ?? null,
    });
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
    botDetails: Object.fromEntries(planner._botDetails),
    zoneAssignment: planner.zoneAssignmentByBot ? { ...planner.zoneAssignmentByBot } : null,
  };

  return actions;
}

export function executeWarehouseStrategy({
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
  const warehousePlan = buildWarehouseAssignments({
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
  planner.missionsByBot = warehousePlan.missionsByBot;

  const reservations = makeOccupancyReservations(state);
  const edgeReservations = new Map();
  const occupiedNextStep = new Set(state.bots.map((bot) => encodeCoord(bot.position)));
  const priorityByMissionType = {
    drop_active: 0,
    pickup_active: 1,
    queue_service_bay: 2,
    pickup_preview: 3,
    reposition_zone: 4,
  };
  const botsByPriority = [...state.bots].sort((a, b) => {
    const aMission = planner.missionsByBot.get(a.id);
    const bMission = planner.missionsByBot.get(b.id);
    const missionDelta = (priorityByMissionType[aMission?.missionType] ?? 99) - (priorityByMissionType[bMission?.missionType] ?? 99);
    if (missionDelta !== 0) {
      return missionDelta;
    }

    return a.id - b.id;
  });
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
    let resolved = resolveWarehouseMissionAction({
      bot,
      mission,
      state,
      graph,
      reservations,
      edgeReservations,
      profile: planner.profile,
      blockedNextStepCoords,
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
      );
      resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'warehouse_fallback', noPath: false };
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
    planner._botDetails.set(bot.id, {
      target: resolved.nextPath?.at(-1) || null,
      path: resolved.nextPath || [],
      taskType: resolved.targetType || (mission?.missionType ?? 'none'),
      stallCount: planner.stalls.get(stallKey) || 0,
      orderId: mission?.orderId ?? null,
    });
  }

  planner.lastMetrics = {
    phase,
    taskCount: Array.from(planner.missionsByBot.values()).filter((mission) => mission?.missionType !== 'reposition_zone').length,
    forcedWaits,
    stalledBots: Array.from(planner.stalls.values()).filter((value) => value > 0).length,
    recoveryMode,
    noProgressRounds: planner.noProgressRounds,
    recoveryThreshold,
    loopDetections: planner.loopDetectionsThisTick,
    approachBlacklistSize: Array.from(blockedItemsByBot.values()).reduce((sum, blocked) => sum + blocked.size, 0),
    orderEtaAtDecision: warehousePlan.metrics.projectedActiveCloseEta,
    projectedCompletionFeasible: warehousePlan.metrics.projectedActiveCloseEta !== null
      ? warehousePlan.metrics.projectedActiveCloseEta <= warehousePlan.control.roundsLeft
      : null,
    ...warehousePlan.metrics,
    botDetails: Object.fromEntries(planner._botDetails),
    zoneAssignment: planner.zoneAssignmentByBot ? { ...planner.zoneAssignmentByBot } : null,
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
  oracle,
}) {
  const tasks = buildTasks(state, world, planner.profile, phase, oracle, state.round);
  const costs = buildCostMatrix(state, tasks, planner.profile, phase);
  const { assignment } = solveMinCostAssignment(costs);

  const taskByBot = new Map();
  for (let index = 0; index < state.bots.length; index += 1) {
    const taskIndex = assignment[index];
    if (taskIndex >= 0 && taskIndex < tasks.length) {
      taskByBot.set(state.bots[index].id, tasks[taskIndex]);
    }
  }

  const activeOrderId = state.orders?.find((o) => o.status === 'active' && !o.complete)?.id ?? null;
  const activeDemand = world?.activeDemand || new Map();
  const botsByPriority = [...state.bots].sort((a, b) => a.id - b.id);
  const actions = [];
  let forcedWaits = 0;
  const horizon = planner.profile.routing.horizon;
  const useTwoPass = planner.profile.routing.two_pass_row === true;

  // Helper: resolve a single bot's action given reservations
  function resolveBot(bot, reservations, edgeReservations) {
    const task = taskByBot.get(bot.id);
    let resolved = null;
    if (task) {
      resolved = actionFromTask({
        bot, task, graph, reservations, edgeReservations,
        profile: planner.profile,
        holdGoalSteps: planner.profile.routing.hold_goal_steps,
        previousPosition: planner.previousPositions.get(`${bot.id}`),
      });
    }
    if (!resolved) {
      const isEmpty = (bot.inventory || []).length === 0;
      const hasDeliverable = !isEmpty && hasDeliverableInventory(bot, activeDemand);
      if (isEmpty || !hasDeliverable) {
        const dropOff = nearestDropOff(bot.position, state);
        const parking = chooseParkingAction({
          bot, graph, reservations, edgeReservations,
          horizon, dropOff, otherBots: state.bots, items: state.items,
          gridWidth: state.grid?.width, gridHeight: state.grid?.height,
        });
        resolved = { action: parking.action, nextPath: parking.path, targetType: 'parking' };
      } else {
        const fallback = chooseFallbackAction(bot, graph, reservations, edgeReservations, horizon);
        resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'fallback' };
      }
    }
    // Opportunistic pickup when waiting
    if (resolved.action === 'wait' && !resolved.waitingForPickup && task?.kind === 'pick_up' && (bot.inventory || []).length < 3) {
      const nearest = pickNearestRelevantItem(
        bot, state.items,
        getNeededTypes(world.activeDemand, world.previewDemand, planner.profile.assignment.preview_item_weight),
      );
      if (nearest && adjacentManhattan(bot.position, nearest.position)) {
        const prevPos = planner.previousPositions.get(`${bot.id}`);
        const botMoved = prevPos && prevPos !== encodeCoord(bot.position);
        if (!botMoved) {
          resolved = { action: 'pick_up', itemId: nearest.id, nextPath: [bot.position], targetType: 'item' };
        }
      }
    }
    return { resolved, task };
  }

  // Right-of-way priority: higher = more important
  function computeRightOfWay(bot, task) {
    if (!task) return 0;
    if (task.kind === 'drop_off' && hasDeliverableInventory(bot, activeDemand)) return 3;
    if (task.kind === 'pick_up') return 2;
    return 1;
  }

  // Identify forced-wait bots first (same for both passes)
  const forcedWaitBots = new Set();
  const baseReservations = makeOccupancyReservations(state);
  const baseEdgeReservations = new Map();
  for (const bot of botsByPriority) {
    const stallKey = `${bot.id}`;
    const forcedWaitRemaining = planner.forcedWait.get(stallKey) || 0;
    if (forcedWaitRemaining > 0) {
      planner.forcedWait.set(stallKey, forcedWaitRemaining - 1);
      forcedWaitBots.add(bot.id);
      reservePath({ path: [bot.position], startTime: 0, reservations: baseReservations, edgeReservations: baseEdgeReservations, horizon, holdAtGoal: true });
      forcedWaits += 1;
    }
  }

  if (useTwoPass) {
    // === TWO-PASS RIGHT-OF-WAY ===

    // Pass 1: Compute tentative paths using only base reservations (forced waits + t=0 occupancy)
    const tentative = new Map(); // botId -> { bot, resolved, task, priority }
    for (const bot of botsByPriority) {
      if (forcedWaitBots.has(bot.id)) continue;
      // Each bot sees forced-wait reservations but NOT other bots' tentative paths
      const pass1Reservations = new Map(baseReservations);
      for (const [t, set] of pass1Reservations) pass1Reservations.set(t, new Set(set));
      const pass1EdgeReservations = new Map(baseEdgeReservations);
      for (const [t, set] of pass1EdgeReservations) pass1EdgeReservations.set(t, new Set(set));

      const { resolved, task } = resolveBot(bot, pass1Reservations, pass1EdgeReservations);
      const priority = computeRightOfWay(bot, task);
      tentative.set(bot.id, { bot, resolved, task, priority });
    }

    // Pass 2: Detect conflicts at time=1 (next step) and resolve by priority
    // Build next-step map: cell -> [botId, ...]
    const nextStepMap = new Map();
    for (const [botId, entry] of tentative) {
      const path = entry.resolved.nextPath || [entry.bot.position];
      const nextCell = path.length >= 2 ? encodeCoord(path[1]) : encodeCoord(path[0]);
      if (!nextStepMap.has(nextCell)) nextStepMap.set(nextCell, []);
      nextStepMap.get(nextCell).push(botId);
    }

    // Find losers: lower-priority bot in each conflict yields
    const losers = new Set();
    for (const [cell, botIds] of nextStepMap) {
      if (botIds.length <= 1) continue;
      // Sort by priority desc, then distance to target asc, then ID asc
      const sorted = botIds.map((id) => tentative.get(id)).sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const aDist = a.task?.target ? manhattanDistance(a.bot.position, a.task.target) : 99;
        const bDist = b.task?.target ? manhattanDistance(b.bot.position, b.task.target) : 99;
        if (aDist !== bDist) return aDist - bDist;
        return a.bot.id - b.bot.id;
      });
      // First bot wins, rest are losers
      for (let i = 1; i < sorted.length; i++) losers.add(sorted[i].bot.id);
    }

    // Also detect swap conflicts (A→B's cell, B→A's cell)
    for (const [botIdA, entryA] of tentative) {
      if (losers.has(botIdA)) continue;
      const pathA = entryA.resolved.nextPath || [entryA.bot.position];
      if (pathA.length < 2) continue;
      const nextA = encodeCoord(pathA[1]);
      const curA = encodeCoord(entryA.bot.position);
      for (const [botIdB, entryB] of tentative) {
        if (botIdA >= botIdB || losers.has(botIdB)) continue;
        const pathB = entryB.resolved.nextPath || [entryB.bot.position];
        if (pathB.length < 2) continue;
        const nextB = encodeCoord(pathB[1]);
        const curB = encodeCoord(entryB.bot.position);
        if (nextA === curB && nextB === curA) {
          // Swap conflict — lower priority loses
          if (entryA.priority < entryB.priority) losers.add(botIdA);
          else if (entryB.priority < entryA.priority) losers.add(botIdB);
          else if (entryA.bot.id > entryB.bot.id) losers.add(botIdA);
          else losers.add(botIdB);
        }
      }
    }

    // Build final reservations: reserve winners first
    const finalReservations = new Map(baseReservations);
    for (const [t, set] of finalReservations) finalReservations.set(t, new Set(set));
    const finalEdgeReservations = new Map(baseEdgeReservations);
    for (const [t, set] of finalEdgeReservations) finalEdgeReservations.set(t, new Set(set));

    // Reserve winner paths
    for (const [botId, entry] of tentative) {
      if (losers.has(botId)) continue;
      reservePath({
        path: entry.resolved.nextPath, startTime: 0,
        reservations: finalReservations, edgeReservations: finalEdgeReservations,
        horizon, holdAtGoal: entry.resolved.targetType !== 'drop_off',
      });
    }

    // Re-plan losers with final reservations
    for (const botId of losers) {
      const entry = tentative.get(botId);
      const { resolved } = resolveBot(entry.bot, finalReservations, finalEdgeReservations);
      entry.resolved = resolved;
      reservePath({
        path: resolved.nextPath, startTime: 0,
        reservations: finalReservations, edgeReservations: finalEdgeReservations,
        horizon, holdAtGoal: resolved.targetType !== 'drop_off',
      });
    }

    // Finalize: stall detection + action emission for all bots
    for (const bot of botsByPriority) {
      if (forcedWaitBots.has(bot.id)) {
        actions.push({ bot: bot.id, action: 'wait' });
        planner.lastActionByBot.set(bot.id, 'wait');
        planner._botDetails.set(bot.id, { target: null, path: [bot.position], taskType: 'forced_wait', stallCount: 0, orderId: null });
        continue;
      }

      const entry = tentative.get(bot.id);
      let { resolved, task } = entry;
      const stallKey = `${bot.id}`;
      const previous = planner.previousPositions.get(stallKey);
      const currentCoord = encodeCoord(bot.position);
      const stalled = previous === currentCoord;
      const stallCount = stalled ? (planner.stalls.get(stallKey) || 0) + 1 : 0;
      planner.stalls.set(stallKey, stallCount);

      if (stallCount >= planner.profile.anti_deadlock.stall_threshold && resolved.action.startsWith('move_')) {
        const fallback = chooseFallbackAction(bot, graph, finalReservations, finalEdgeReservations, horizon);
        resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'anti_deadlock' };
        planner.forcedWait.set(stallKey, planner.profile.anti_deadlock.forced_wait_rounds);
      }

      planner.previousPositions.set(stallKey, currentCoord);

      if (resolved.action === 'pick_up') {
        queuePendingPickup(planner, bot, resolved.itemId, state.round);
        actions.push({ bot: bot.id, action: 'pick_up', item_id: resolved.itemId });
      } else {
        actions.push({ bot: bot.id, action: resolved.action });
      }

      planner.lastActionByBot.set(bot.id, resolved.action);
      planner._botDetails.set(bot.id, {
        target: resolved.nextPath?.at(-1) || null,
        path: resolved.nextPath || [],
        taskType: resolved.targetType || (task?.kind ?? 'none'),
        stallCount: planner.stalls.get(stallKey) || 0,
        orderId: task?.kind === 'drop_off' ? activeOrderId : null,
      });
    }
  } else {
    // === ORIGINAL SINGLE-PASS ===
    const reservations = makeOccupancyReservations(state);
    const edgeReservations = new Map();
    // Re-reserve forced waits into single-pass reservations
    for (const bot of botsByPriority) {
      if (forcedWaitBots.has(bot.id)) {
        reservePath({ path: [bot.position], startTime: 0, reservations, edgeReservations, horizon, holdAtGoal: true });
      }
    }

    for (const bot of botsByPriority) {
      if (forcedWaitBots.has(bot.id)) {
        actions.push({ bot: bot.id, action: 'wait' });
        planner.lastActionByBot.set(bot.id, 'wait');
        planner._botDetails.set(bot.id, { target: null, path: [bot.position], taskType: 'forced_wait', stallCount: 0, orderId: null });
        continue;
      }

      const { resolved: rawResolved, task } = resolveBot(bot, reservations, edgeReservations);
      let resolved = rawResolved;
      const stallKey = `${bot.id}`;
      const previous = planner.previousPositions.get(stallKey);
      const currentCoord = encodeCoord(bot.position);
      const stalled = previous === currentCoord;
      const stallCount = stalled ? (planner.stalls.get(stallKey) || 0) + 1 : 0;
      planner.stalls.set(stallKey, stallCount);

      if (stallCount >= planner.profile.anti_deadlock.stall_threshold && resolved.action.startsWith('move_')) {
        const fallback = chooseFallbackAction(bot, graph, reservations, edgeReservations, horizon);
        resolved = { action: fallback.action, nextPath: fallback.path, targetType: 'anti_deadlock' };
        planner.forcedWait.set(stallKey, planner.profile.anti_deadlock.forced_wait_rounds);
      }

      planner.previousPositions.set(stallKey, currentCoord);

      reservePath({
        path: resolved.nextPath, startTime: 0,
        reservations, edgeReservations, horizon,
        holdAtGoal: resolved.targetType !== 'drop_off',
      });

      if (resolved.action === 'pick_up') {
        queuePendingPickup(planner, bot, resolved.itemId, state.round);
        actions.push({ bot: bot.id, action: 'pick_up', item_id: resolved.itemId });
      } else {
        actions.push({ bot: bot.id, action: resolved.action });
      }

      planner.lastActionByBot.set(bot.id, resolved.action);
      planner._botDetails.set(bot.id, {
        target: resolved.nextPath?.at(-1) || null,
        path: resolved.nextPath || [],
        taskType: resolved.targetType || (task?.kind ?? 'none'),
        stallCount: planner.stalls.get(stallKey) || 0,
        orderId: task?.kind === 'drop_off' ? activeOrderId : null,
      });
    }
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
    botDetails: Object.fromEntries(planner._botDetails),
    zoneAssignment: planner.zoneAssignmentByBot ? { ...planner.zoneAssignmentByBot } : null,
  };

  return actions;
}
