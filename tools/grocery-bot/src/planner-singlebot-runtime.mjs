import { adjacentManhattan, moveToAction } from './coords.mjs';
import { findTimeAwarePath } from './routing.mjs';
import {
  hasDeliverableInventory,
  isAtAnyDropOff,
  nearestDropOff,
  shouldScheduleDropOff,
} from './planner-utils.mjs';
import {
  mapCountFromInventory,
  copyCounts,
  applyCounts,
  decrementCount,
  sumDemand,
  buildTypeSupply,
  enumerateTypeSequences,
  evaluateDropGain,
  evaluateTypeSequenceRoute,
  createTypeRoundTripCostResolver,
  estimateRemainingDemandCost,
  estimateMinActiveCompletionEta,
  planSingleBotRecovery,
  maybeImmediateDrop,
  recentEventCount,
} from './planner-singlebot.mjs';

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

  if (!suppressDropOff && roundsLeft <= 1) {
    const atDropoff = isAtAnyDropOff(bot.position, state);
    if (atDropoff && hasDeliverableInventory(bot, world.activeDemand)) {
      return { bot: bot.id, action: 'drop_off' };
    }
  }

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
    dropOff: nearestDropOff(bot.position, state),
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
    dropOff: nearestDropOff(bot.position, state),
    phase,
    botCount,
    completionInfeasible,
  });
  if (directDrop) {
    return directDrop;
  }

  if (activeRemaining === 0) {
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

  const commitActiveOnly = completionCommitMode;
  const allowPreview = !commitActiveOnly && phase !== 'cutoff' && freeSlots > activeRemaining;
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
      dropOff: nearestDropOff(bot.position, state),
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
      dropOff: nearestDropOff(bot.position, state),
      botCount,
      completionInfeasible,
    })) {
      if (isAtAnyDropOff(bot.position, state)) {
        return { bot: bot.id, action: 'drop_off' };
      }

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

export function executeSingleBotTurn({
  planner,
  state,
  world,
  graph,
  phase,
  recoveryMode,
  forcePartialDrop,
  recoveryThreshold,
  loopBreakRounds,
  targetLockStallRounds,
  targetLockForbidTtl,
  orderStallBailoutRounds,
  pickFailureSpiralWindow,
  pickFailureSpiralThreshold,
  scoreImproved,
  operationalProgress,
  activeOrderId,
}) {
  const botId = state.bots[0].id;
  const loopBreakRemaining = planner.loopBreakRoundsByBot.get(botId) || 0;
  const loopBreakActive = loopBreakRemaining > 0;
  if (loopBreakActive) {
    planner.loopBreakRoundsByBot.set(botId, loopBreakRemaining - 1);
  }

  const existingBlockedPickup = new Map(planner.blockedPickupByBot.get(botId) || new Map());
  const blockedItems = new Set(Array.from(existingBlockedPickup.keys()));
  const blockedApproaches = planner.blockedApproachByBot.get(botId) || new Map();
  const approachStats = planner.approachStatsByBot.get(botId) || new Map();
  const pendingPickup = planner.pendingPickups.get(botId) || null;
  const previousTargetFocus = planner.targetFocusByBot.get(botId) || { itemId: null, ticks: 0, orderId: null };
  const inventoryEmpty = (state.bots[0].inventory || []).length === 0;
  let orderStallBailoutTriggered = false;

  if (
    activeOrderId
    && previousTargetFocus.orderId === activeOrderId
    && previousTargetFocus.itemId
    && inventoryEmpty
    && planner.noProgressRounds >= orderStallBailoutRounds
  ) {
    const currentCooldown = existingBlockedPickup.get(previousTargetFocus.itemId) || 0;
    existingBlockedPickup.set(previousTargetFocus.itemId, Math.max(currentCooldown, targetLockForbidTtl));
    blockedItems.add(previousTargetFocus.itemId);
    planner.blockedPickupByBot.set(botId, existingBlockedPickup);
    planner.loopBreakRoundsByBot.set(
      botId,
      Math.max(planner.loopBreakRoundsByBot.get(botId) || 0, loopBreakRounds),
    );
    orderStallBailoutTriggered = true;
  }

  const recentPickFailures = recentEventCount(
    planner.pickupFailureRoundsByBot.get(botId) || [],
    state.round,
    pickFailureSpiralWindow,
  );
  const pickupFailureSpiralActive = (
    planner.noProgressRounds > 0
    && recentPickFailures >= pickFailureSpiralThreshold
  );

  if (pickupFailureSpiralActive) {
    planner.recoveryBurstRounds = Math.max(planner.recoveryBurstRounds, 3);
    const pending = planner.pendingPickups.get(botId);
    if (pending) {
      const current = existingBlockedPickup.get(pending.itemId) || 0;
      existingBlockedPickup.set(pending.itemId, Math.max(current, 8));
      planner.blockedPickupByBot.set(botId, existingBlockedPickup);
      blockedItems.add(pending.itemId);
      planner.pendingPickups.delete(botId);
    }
  }

  const effectiveRecoveryMode = recoveryMode || loopBreakActive || pickupFailureSpiralActive;
  const effectiveForcePartialDrop = forcePartialDrop || loopBreakActive || pickupFailureSpiralActive;
  const completionCommitMode = effectiveRecoveryMode || planner.noProgressRounds >= Math.max(8, Math.floor(recoveryThreshold / 2));
  const decisionStats = {};
  const bot = state.bots[0];
  let pendingPickupLockActive = false;
  let action = null;
  if (
    pendingPickup
    && state.round < pendingPickup.resolveAfterRound
    && (bot.inventory || []).length < pendingPickup.expectedMinInventory
    && bot.position[0] === pendingPickup.approachCell[0]
    && bot.position[1] === pendingPickup.approachCell[1]
  ) {
    const pendingItem = (state.items || []).find((item) => item.id === pendingPickup.itemId);
    if (
      pendingItem
      && (bot.inventory || []).length < 3
      && adjacentManhattan(bot.position, pendingItem.position)
    ) {
      pendingPickupLockActive = true;
      decisionStats.targetItemId = pendingItem.id;
      action = { bot: bot.id, action: 'pick_up', item_id: pendingItem.id };
    }
  }

  if (!action) {
    action = planSingleBot({
      state,
      world,
      graph,
      phase,
      profile: planner.profile,
      blockedItems,
      blockedApproaches,
      approachStats,
      recoveryMode: effectiveRecoveryMode,
      completionCommitMode,
      forcePartialDrop: effectiveForcePartialDrop,
      decisionStats,
    });
  }

  const nonScoringDropStreak = planner.nonScoringDropStreakByBot.get(botId) || 0;
  let finalAction = action;
  if (action.action === 'drop_off' && nonScoringDropStreak >= 2) {
    finalAction = planSingleBot({
      state,
      world,
      graph,
      phase,
      profile: planner.profile,
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
    planner.blockedPickupByBot.set(botId, existingBlockedPickup);
    planner.loopBreakRoundsByBot.set(
      botId,
      Math.max(planner.loopBreakRoundsByBot.get(botId) || 0, loopBreakRounds),
    );
    targetLockTicks = 0;
    targetStallTriggered = true;
  }

  planner.targetFocusByBot.set(botId, {
    itemId: targetStallTriggered ? null : targetItemId,
    ticks: targetLockTicks,
    orderId: activeOrderId,
  });

  if (finalAction.action === 'pick_up') {
    const existingPending = planner.pendingPickups.get(state.bots[0].id);
    const inventorySize = (state.bots[0].inventory || []).length;
    if (!existingPending || state.round >= existingPending.resolveAfterRound || existingPending.itemId !== finalAction.item_id) {
      planner.pendingPickups.set(state.bots[0].id, {
        itemId: finalAction.item_id,
        expectedMinInventory: inventorySize + 1,
        resolveAfterRound: state.round + 2,
        approachCell: [...state.bots[0].position],
      });
    }
  }

  planner.lastMetrics = {
    phase,
    taskCount: 1,
    forcedWaits: finalAction.action === 'wait' ? 1 : 0,
    stalledBots: 0,
    singleBotMode: true,
    recoveryMode: effectiveRecoveryMode,
    completionCommitMode,
    noProgressRounds: planner.noProgressRounds,
    recoveryBurstRounds: planner.recoveryBurstRounds,
    resetTriggered: planner.resetTriggered,
    recoveryThreshold,
    partialDropThreshold: planner.profile.recovery?.partial_drop_no_progress_rounds ?? Math.max(18, recoveryThreshold * 2),
    forcePartialDrop: effectiveForcePartialDrop,
    loopBreakActive,
    loopBreakRemaining,
    loopDetections: planner.loopDetectionsThisTick,
    nonScoringDropStreak,
    recentPickFailures,
    pickupFailureSpiralActive,
    approachBlacklistSize: blockedApproaches.size,
    orderEtaAtDecision: decisionStats.orderEtaAtDecision ?? null,
    projectedCompletionFeasible: decisionStats.projectedCompletionFeasible ?? null,
    targetLockTicks,
    targetStallTriggered,
    orderStallBailoutTriggered,
    pendingPickupLockActive,
  };

  planner.lastActionByBot.set(botId, finalAction.action);
  return [finalAction];
}
