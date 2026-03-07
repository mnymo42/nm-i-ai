import { solveMinCostAssignment } from './assignment.mjs';
import { encodeCoord, adjacentManhattan, moveToAction } from './coords.mjs';
import { GridGraph } from './grid-graph.mjs';
import { findTimeAwarePath, reservePath } from './routing.mjs';
import { buildWorldContext } from './world-model.mjs';
import {
  hasDeliverableInventory,
  shouldScheduleDropOff,
  getRoundPhase,
  getNeededTypes,
  pickNearestRelevantItem,
} from './planner-utils.mjs';
import {
  buildTasks,
  buildCostMatrix,
  makeOccupancyReservations,
  actionFromTask,
  chooseFallbackAction,
} from './planner-multibot.mjs';
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
  resolveRecoveryThreshold,
  isTwoCellOscillation,
  isConfinedLoop,
  recentEventCount,
  decrementCooldownMap,
  addAdaptiveCooldown,
  updateApproachStats,
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
    const atDropoff = bot.position[0] === state.drop_off[0] && bot.position[1] === state.drop_off[1];
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
      const pendingPickup = this.pendingPickups.get(botId) || null;
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
          profile: this.profile,
          blockedItems,
          blockedApproaches,
          approachStats,
          recoveryMode: effectiveRecoveryMode,
          completionCommitMode,
          forcePartialDrop: effectiveForcePartialDrop,
          decisionStats,
        });
      }

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
        pendingPickupLockActive,
      };

      this.lastActionByBot.set(botId, finalAction.action);
      return [finalAction];
    }

    const tasks = buildTasks(state, world, this.profile, phase);
    const blockedItemsByBot = new Map(
      state.bots.map((bot) => [bot.id, this.blockedPickupByBot.get(bot.id) || new Map()]),
    );
    const costs = buildCostMatrix(state, tasks, this.profile, phase, { blockedItemsByBot });
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
        holdAtGoal: resolved.targetType !== 'drop_off',
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
