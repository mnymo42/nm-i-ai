import { encodeCoord } from './coords.mjs';
import { GridGraph } from './grid-graph.mjs';
import { buildWorldContext } from './world-model.mjs';
import { getRoundPhase } from './planner-utils.mjs';
import {
  executeMissionStrategy,
  executeAssignedTaskStrategy,
  executeWarehouseStrategy,
} from './planner-multibot-runtime.mjs';
import { executeSingleBotTurn } from './planner-singlebot-runtime.mjs';
import {
  resolveRecoveryThreshold,
  isTwoCellOscillation,
  isConfinedLoop,
  decrementCooldownMap,
  addAdaptiveCooldown,
  updateApproachStats,
} from './planner-singlebot.mjs';
import { buildComparableReplayState } from './replay-transition-diff.mjs';

export class GroceryPlanner {
  constructor(profile, options = {}) {
    this.profile = profile;
    this.oracle = options.oracle || null;
    this.script = options.script || null;
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
    this.missionsByBot = new Map();
    this.scriptDisabled = false;
    this.scriptDivergedAtRound = null;
    this.assumptionCheckDone = false;
    this.assumptionMismatch = null;
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
    this.missionsByBot = new Map();
  }

  getLastMetrics() {
    return this.lastMetrics;
  }

  matchesExpectedScriptState(state, expectedState) {
    if (!expectedState) {
      return true;
    }
    const comparableLiveState = buildComparableReplayState(state);
    return JSON.stringify(expectedState) === JSON.stringify(comparableLiveState);
  }

  validateOracleAndScriptAssumptions(state) {
    if (this.assumptionCheckDone) {
      return this.assumptionMismatch;
    }

    this.assumptionCheckDone = true;
    const oracleItems = this.oracle?.items;
    if (!Array.isArray(oracleItems) || oracleItems.length === 0) {
      return null;
    }

    const liveItemsById = new Map((state.items || []).map((item) => [item.id, item]));
    const mismatches = [];

    for (const oracleItem of oracleItems) {
      const liveItem = liveItemsById.get(oracleItem.id);
      if (!liveItem) {
        mismatches.push({
          itemId: oracleItem.id,
          reason: 'missing_live_item',
          oracleType: oracleItem.type,
        });
        continue;
      }

      if (oracleItem.type !== liveItem.type) {
        mismatches.push({
          itemId: oracleItem.id,
          reason: 'item_type_mismatch',
          oracleType: oracleItem.type,
          liveType: liveItem.type,
        });
      }
    }

    if (mismatches.length === 0) {
      return null;
    }

    this.assumptionMismatch = {
      reason: 'oracle_item_rotation_mismatch',
      mismatchCount: mismatches.length,
      sample: mismatches.slice(0, 5),
    };

    this.oracle = null;
    this.scriptDisabled = true;
    this.scriptDivergedAtRound = state.round;
    return this.assumptionMismatch;
  }

  plan(state) {
    const assumptionMismatch = this.validateOracleAndScriptAssumptions(state);
    let scriptFallbackMetrics = null;
    // Script replay: if we have precomputed actions for this tick, use them verbatim
    if (!this.scriptDisabled && this.script?.tickMap?.has(state.round)) {
      const scriptEntry = this.script.entryMap?.get(state.round) || {
        tick: state.round,
        actions: this.script.tickMap.get(state.round),
      };
      const expectedStateMatched = this.matchesExpectedScriptState(state, scriptEntry.expected_state);
      if (expectedStateMatched) {
        const scriptedActions = this.script.tickMap.get(state.round);
        this.lastScore = state.score;
        this.lastMetrics = {
          phase: 'scripted',
          scripted: true,
          scriptTrusted: Boolean(scriptEntry.expected_state),
          scriptExpectedStateMatched: Boolean(scriptEntry.expected_state),
        };
        // Update position tracking so handoff to live planner is smooth
        for (const bot of state.bots) {
          this.previousPositions.set(`${bot.id}`, encodeCoord(bot.position));
          const inventoryKey = (bot.inventory || []).slice().sort().join('|');
          this.lastInventoryByBot.set(bot.id, inventoryKey);
        }
        return scriptedActions;
      }

      this.scriptDisabled = true;
      this.scriptDivergedAtRound = state.round;
      scriptFallbackMetrics = {
        scriptDiverged: true,
        scriptDivergedAtRound: state.round,
        scriptExpectedStateMatched: false,
      };
    }

    this.resetTriggered = false;
    this.loopDetectionsThisTick = 0;
    const previousPositionByBot = new Map(this.previousPositions);
    const previousInventoryKeyByBot = new Map(this.lastInventoryByBot);
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
      const actions = executeSingleBotTurn({
        planner: this,
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
      });
      if (scriptFallbackMetrics) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          ...scriptFallbackMetrics,
        };
      }
      if (assumptionMismatch) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          oracleDisabled: true,
          scriptDisabled: true,
          assumptionMismatch,
        };
      }
      return actions;
    }

    const blockedItemsByBot = new Map(
      state.bots.map((bot) => [bot.id, this.blockedPickupByBot.get(bot.id) || new Map()]),
    );
    if (runtime.multi_bot_strategy === 'mission_v1') {
      const actions = executeMissionStrategy({
        planner: this,
        state,
        world,
        graph,
        phase,
        recoveryMode,
        recoveryThreshold,
        blockedItemsByBot,
        previousPositionByBot,
        previousInventoryKeyByBot,
      });
      if (scriptFallbackMetrics) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          ...scriptFallbackMetrics,
        };
      }
      if (assumptionMismatch) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          oracleDisabled: true,
          scriptDisabled: true,
          assumptionMismatch,
        };
      }
      return actions;
    }

    if (runtime.multi_bot_strategy === 'warehouse_v1') {
      const actions = executeWarehouseStrategy({
        planner: this,
        state,
        world,
        graph,
        phase,
        recoveryMode,
        recoveryThreshold,
        blockedItemsByBot,
        previousPositionByBot,
        previousInventoryKeyByBot,
      });
      if (scriptFallbackMetrics) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          ...scriptFallbackMetrics,
        };
      }
      if (assumptionMismatch) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          oracleDisabled: true,
          scriptDisabled: true,
          assumptionMismatch,
        };
      }
      return actions;
    }

    const actions = executeAssignedTaskStrategy({
      planner: this,
      state,
      world,
      graph,
      phase,
      recoveryMode,
      recoveryThreshold,
      blockedItemsByBot,
      oracle: this.oracle,
    });
    if (scriptFallbackMetrics) {
      this.lastMetrics = {
        ...(this.lastMetrics || {}),
        ...scriptFallbackMetrics,
      };
    }
    if (assumptionMismatch) {
      this.lastMetrics = {
        ...(this.lastMetrics || {}),
        oracleDisabled: true,
        scriptDisabled: true,
        assumptionMismatch,
      };
    }
    return actions;
  }
}
