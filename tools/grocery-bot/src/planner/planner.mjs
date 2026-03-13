/**
 * GroceryPlanner: central orchestrator for all difficulty levels.
 * Routes between script replay, opener phase, and live planning strategies.
 * Public API: plan(state), getLastMetrics()
 */
import { encodeCoord, moveToAction, manhattanDistance } from '../utils/coords.mjs';
import { GridGraph, buildDirectionalPreference, buildLaneMapV2, buildLaneMapV3, buildLaneMapV4 } from '../utils/grid-graph.mjs';
import { buildWorldContext } from '../utils/world-model.mjs';
import { getRoundPhase } from './planner-utils.mjs';
import { findTimeAwarePath, reservePath } from '../routing/routing.mjs';
import { getDropOffs } from '../utils/drop-zones.mjs';
import {
  executeMissionStrategy,
  executeAssignedTaskStrategy,
  executeWarehouseStrategy,
  executeTeamStrategy,
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
import { buildComparableReplayState, diffComparableReplayValues } from '../replay/replay-transition-diff.mjs';
import { zoneIndexForX } from './planner-multibot-common.mjs';

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
    this._botDetails = new Map();
    this.scriptDisabled = false;
    this.scriptDivergedAtRound = null;
    this.assumptionCheckDone = false;
    this.assumptionMismatch = null;
    
    // Opener phase state
    this.openerActive = true;
    this.openerPaths = null;
    this.openerTargetPositions = null;
    this.openerTick = 0;
    this.lastOpenerRound = null;
    this.openerSpawn = null;
    this.openerReleasedBotOrder = [];
    this.initialTeamOrder = null;
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
      return {
        matched: true,
        comparableLiveState: null,
        diffs: [],
      };
    }
    const comparableLiveState = buildComparableReplayState(state);
    const diffs = diffComparableReplayValues(expectedState, comparableLiveState);
    return {
      matched: diffs.length === 0,
      comparableLiveState,
      diffs,
    };
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
    this._botDetails = new Map();
    const assumptionMismatch = this.validateOracleAndScriptAssumptions(state);
    let scriptFallbackMetrics = null;
    // Only run opener phase when enabled in profile, for multi-bot games, not during script replay
    const isMultiBot = state.bots.length > 1;
    const isScripted = !this.scriptDisabled && this.script?.tickMap?.has(state.round);
    const openerEnabled = this.profile.opener?.enabled === true;
    const openerMaxTicks = this.profile.opener?.max_ticks ?? 15;
    if (openerEnabled && this.openerActive && isMultiBot && !isScripted) {
      if (!this.openerTargetPositions) {
        const itemWalls = state.items.map(i => i.position);
        const openerGraph = new GridGraph({ ...state.grid, walls: [...state.grid.walls, ...itemWalls] });
        const dropOff = getDropOffs(state)[0] || [0, 0];
        this.openerTargetPositions = computeOpenerTargets(state, openerGraph, dropOff);
        this.openerSpawn = [...state.bots[0].position];
        this.openerReleasedBotOrder = [];
      }
      for (const bot of [...state.bots].sort((a, b) => a.id - b.id)) {
        const atSpawn = this.openerSpawn
          && bot.position[0] === this.openerSpawn[0]
          && bot.position[1] === this.openerSpawn[1];
        if (!atSpawn && !this.openerReleasedBotOrder.includes(bot.id)) {
          this.openerReleasedBotOrder.push(bot.id);
        }
      }
      const spawnCleared = !this.openerSpawn || state.bots.every((bot) =>
        bot.position[0] !== this.openerSpawn[0] || bot.position[1] !== this.openerSpawn[1],
      );
      if (spawnCleared || this.openerTick >= openerMaxTicks) {
        this.openerActive = false;
        this.lastOpenerRound = state.round;
        this.initialTeamOrder = this.openerReleasedBotOrder.length > 0
          ? [...this.openerReleasedBotOrder]
          : [...state.bots].sort((a, b) => a.id - b.id).map((bot) => bot.id);
      } else {
        const itemWalls = state.items.map(i => i.position);
        const openerGraph = new GridGraph({ ...state.grid, walls: [...state.grid.walls, ...itemWalls] });
        const reservations = new Map();
        const edgeReservations = new Map();
        const actionMap = new Map();
        const releaseMode = this.profile.opener?.release_mode ?? 'sequential_compact';
        const botOrder = state.bots.map((bot, i) => ({ bot, i, target: this.openerTargetPositions[i] }))
          .sort((a, b) => a.bot.id - b.bot.id);
        for (const { bot, i, target } of botOrder) {
          const atTarget = target && bot.position[0] === target[0] && bot.position[1] === target[1];
          if (!target || atTarget) {
            reservePath({ path: [bot.position], startTime: 0, reservations, edgeReservations, horizon: 6, holdAtGoal: true });
            actionMap.set(bot.id, { bot: bot.id, action: 'wait' });
            continue;
          }
          const openerMove = chooseOpenerReleaseAction({
            bot,
            target,
            graph: openerGraph,
            reservations,
            edgeReservations,
            releaseMode,
            openerTick: this.openerTick,
            openerSpawn: this.openerSpawn,
          });
          if (openerMove) {
            reservePath({ path: openerMove.path, startTime: 0, reservations, edgeReservations, horizon: 8, holdAtGoal: false });
            actionMap.set(bot.id, { bot: bot.id, action: openerMove.action });
            continue;
          }

          reservePath({ path: [bot.position], startTime: 0, reservations, edgeReservations, horizon: 6, holdAtGoal: true });
          actionMap.set(bot.id, { bot: bot.id, action: 'wait' });
        }
        const actions = state.bots.map(bot => actionMap.get(bot.id));
        this.openerTick += 1;
        this.lastMetrics = { phase: 'opener', openerTick: this.openerTick, botDetails: {} };
        return actions;
      }
    }
    // Script replay: if we have precomputed actions for this tick, use them verbatim
    if (!this.scriptDisabled && this.script?.tickMap?.has(state.round)) {
      const scriptEntry = this.script.entryMap?.get(state.round) || {
        tick: state.round,
        actions: this.script.tickMap.get(state.round),
      };
      const scriptStateCheck = this.matchesExpectedScriptState(state, scriptEntry.expected_state);
      if (scriptStateCheck.matched) {
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
        scriptExpectedStateDiffPath: scriptStateCheck.diffs[0]?.path ?? null,
        scriptExpectedStateDiffSample: scriptStateCheck.diffs.slice(0, 3),
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
    const baseGrid = new GridGraph(state.grid);
    const laneMapRelaxTicks = this.profile.routing?.lane_map_handoff_relax_ticks ?? 0;
    const laneMapVersion = this.profile.routing?.lane_map_version
      ?? (this.profile.routing?.use_lane_map_v2 ? 'v2' : null);
    const allowLaneMap = laneMapVersion
      && (
        this.lastOpenerRound === null
        || state.round > (this.lastOpenerRound + laneMapRelaxTicks)
      );
    const lanePolicy = allowLaneMap
      ? (laneMapVersion === 'v4'
        ? buildLaneMapV4(baseGrid, state.drop_offs || (state.drop_off ? [state.drop_off] : []))
        : laneMapVersion === 'v3'
        ? buildLaneMapV3(baseGrid, state.drop_offs || (state.drop_off ? [state.drop_off] : []))
        : buildLaneMapV2(baseGrid, state.drop_offs || (state.drop_off ? [state.drop_off] : [])))
      : null;
    const graph = new GridGraph({
      ...state.grid,
      walls: [...state.grid.walls, ...shelfWalls],
      oneWayRoads: lanePolicy?.oneWayRoads || null,
    });
    graph.trafficLaneCells = lanePolicy?.trafficLaneCells || new Set();

    // Attach directional preference + congestion settings for A* routing
    const cacheMode = allowLaneMap ? `lane_${laneMapVersion}` : 'default';
    if (!this._dirPrefCache || this._dirPrefCacheMode !== cacheMode) {
      // Build once from base grid (without shelf walls) and cache
      this._dirPrefCache = allowLaneMap
        ? lanePolicy.directionalPreference
        : buildDirectionalPreference(baseGrid);
      this._dirPrefCacheMode = cacheMode;
    }
    graph.directionalPreference = this._dirPrefCache;
    graph.directionPenalty = this.profile.routing?.direction_penalty || 0;
    graph.congestionWeight = this.profile.routing?.congestion_weight || 0;

    // Build congestion map from current bot positions
    if (graph.congestionWeight > 0 && state.bots.length > 1) {
      const congMap = new Map();
      for (const bot of state.bots) {
        const key = encodeCoord(bot.position);
        congMap.set(key, (congMap.get(key) || 0) + 1);
      }
      graph.congestionMap = congMap;
    }

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

    // Assign bots to zones, allow dynamic switching if needed
    if (!this.zoneAssignmentByBot) {
      this.zoneAssignmentByBot = assignInitialZones(state, this.openerTargetPositions, this.profile, this.initialTeamOrder);
    }
    updateDynamicZones(state, this.zoneAssignmentByBot);
    const blockedItemsByBot = new Map(
      state.bots.map((bot) => [bot.id, this.blockedPickupByBot.get(bot.id) || new Map()]),
    );
    // --- Zone Assignment Helpers ---
    function assignInitialZones(state, openerTargetPositions, profile, initialTeamOrder) {
      const zones = {};
      const zoneCount = Math.max(1, profile.teams?.zone_count ?? 3);
      const order = Array.isArray(initialTeamOrder) && initialTeamOrder.length > 0
        ? initialTeamOrder
        : [...state.bots].sort((a, b) => a.id - b.id).map((bot) => bot.id);
      const botOrder = order
        .map((id) => state.bots.find((bot) => bot.id === id))
        .filter(Boolean);
      for (let i = 0; i < botOrder.length; ++i) {
        const zoneX = openerTargetPositions?.[i]?.[0] ?? botOrder[i].position[0];
        zones[botOrder[i].id] = zoneIndexForX(zoneX, state.grid.width, zoneCount);
      }
      return zones;
    }

    function updateDynamicZones(state, zones) {
      void state;
      void zones;
    }
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

    if (runtime.multi_bot_strategy === 'team_v1') {
      const actions = executeTeamStrategy({
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

function chooseOpenerReleaseAction({
  bot,
  target,
  graph,
  reservations,
  edgeReservations,
  releaseMode,
  openerTick,
  openerSpawn,
}) {
  const scriptedMove = chooseSequentialCompactOpenerAction({
    bot,
    target,
    graph,
    reservations,
    edgeReservations,
    releaseMode,
    openerTick,
    openerSpawn,
  });
  if (scriptedMove) {
    return scriptedMove;
  }

  const candidates = graph.neighbors(bot.position)
    .map((neighbor) => {
      const key = encodeCoord(neighbor);
      const currentKey = encodeCoord(bot.position);
      if (reservations.get(1)?.has(key)) return null;
      if (edgeReservations.get(1)?.has(`${key}>${currentKey}`)) return null;
      return neighbor;
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftVertical = left[1] !== bot.position[1] ? 0 : 1;
      const rightVertical = right[1] !== bot.position[1] ? 0 : 1;
      if (leftVertical !== rightVertical) return leftVertical - rightVertical;
      const leftDistance = manhattanDistance(left, target);
      const rightDistance = manhattanDistance(right, target);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      const leftPriority = Math.abs(left[0] - target[0]);
      const rightPriority = Math.abs(right[0] - target[0]);
      return leftPriority - rightPriority;
    });

  const best = candidates[0];
  if (!best) {
    return null;
  }

  return {
    action: moveToAction(bot.position, best),
    path: [bot.position, best],
  };
}

function chooseSequentialCompactOpenerAction({
  bot,
  target,
  graph,
  reservations,
  edgeReservations,
  releaseMode,
  openerTick,
  openerSpawn,
}) {
  if (releaseMode !== 'sequential_compact' || !openerSpawn) {
    return null;
  }

  const leftLimit = Math.min(bot.id, openerTick * 2);
  const upBotId = openerTick * 2 + 1;
  let preferredNeighbor = null;
  const atSpawn = bot.position[0] === openerSpawn[0] && bot.position[1] === openerSpawn[1];

  if (bot.id <= leftLimit) {
    preferredNeighbor = [bot.position[0] - 1, bot.position[1]];
  } else if (bot.id === upBotId && atSpawn) {
    preferredNeighbor = [bot.position[0], bot.position[1] - 1];
  } else if (atSpawn) {
    return {
      action: 'wait',
      path: [bot.position],
    };
  }

  if (!preferredNeighbor || !graph.isWalkable(preferredNeighbor)) {
    return null;
  }

  const key = encodeCoord(preferredNeighbor);
  const currentKey = encodeCoord(bot.position);
  if (reservations.get(1)?.has(key)) return null;
  if (edgeReservations.get(1)?.has(`${key}>${currentKey}`)) return null;

  if (target && preferredNeighbor[0] === target[0] && preferredNeighbor[1] === target[1]) {
    return {
      action: moveToAction(bot.position, preferredNeighbor),
      path: [bot.position, preferredNeighbor],
    };
  }

  return {
    action: moveToAction(bot.position, preferredNeighbor),
    path: [bot.position, preferredNeighbor],
  };
}

function compactOpenerColumns(baseColumns, count) {
  if (baseColumns.length === 0 || count <= 0) return [];
  const sorted = [...baseColumns].sort((a, b) => a - b);
  const maxColumn = sorted[sorted.length - 1];
  const minColumn = sorted[0];
  const compact = [];
  for (let column = maxColumn; column >= minColumn && compact.length < count; column -= 1) {
    compact.push(column);
  }
  return compact.sort((a, b) => a - b);
}

export function computeOpenerTargets(state, graph, dropOff) {
  // Build item-aware graph (items block movement)
  const itemWalls = state.items.map(i => i.position);
  const aisleGraph = new GridGraph({
    ...state.grid,
    walls: [...state.grid.walls, ...itemWalls],
  });

  // Find open corridor rows (fully walkable except borders)
  const corridorRows = [];
  for (let y = 1; y < state.grid.height - 1; y++) {
    let open = true;
    for (let x = 1; x < state.grid.width - 1; x++) {
      if (!aisleGraph.isWalkable([x, y])) { open = false; break; }
    }
    if (open) corridorRows.push(y);
  }

  // Find true aisle columns: walkable columns flanked by item/wall columns
  const itemXs = new Set(state.items.map(i => i.position[0]));
  const aisleColumns = [];
  if (corridorRows.length >= 2) {
    const shelfTop = corridorRows[corridorRows.length - 2] + 1;
    const shelfBot = corridorRows[corridorRows.length - 1] - 1;
    for (let x = 1; x < state.grid.width - 1; x++) {
      let walkable = true;
      for (let y = shelfTop; y <= shelfBot; y++) {
        if (!aisleGraph.isWalkable([x, y])) { walkable = false; break; }
      }
      // Must have items/walls on at least one side to be a real aisle
      const hasItemNeighbor = itemXs.has(x - 1) || itemXs.has(x + 1);
      if (walkable && hasItemNeighbor) aisleColumns.push(x);
    }
  }

  // Build targets: use the corridor just above drop-off row, overflow to middle corridor
  // Skip the drop-off row itself (bots would block deliveries)
  const dropRow = dropOff[1];
  const bottomCorridors = corridorRows.filter(y => y < dropRow);
  const botCorridor = bottomCorridors[bottomCorridors.length - 1] || dropRow - 1;
  const midCorridor = bottomCorridors.length >= 2 ? bottomCorridors[bottomCorridors.length - 2] : null;
  const corridorColumns = [];
  for (let x = 1; x < state.grid.width - 1; x++) {
    if (aisleGraph.isWalkable([x, botCorridor])) corridorColumns.push(x);
  }
  const compactBaseColumns = aisleColumns.length > 0 ? aisleColumns : corridorColumns;
  const bottomCount = Math.min(compactBaseColumns.length, state.bots.length);
  const bottomColumns = compactOpenerColumns(compactBaseColumns, bottomCount);
  let targets = bottomColumns.map((x) => [x, botCorridor]);
  if (midCorridor && targets.length < state.bots.length) {
    const remaining = state.bots.length - targets.length;
    const midColumns = compactOpenerColumns(compactBaseColumns, remaining);
    for (const x of midColumns) {
      if (targets.length >= state.bots.length) break;
      targets.push([x, midCorridor]);
    }
  }
  // Sort farthest from drop-off first (bot 0 gets longest path, leaves spawn first)
  targets.sort((a, b) => manhattanDistance(b, dropOff) - manhattanDistance(a, dropOff));
  return targets.slice(0, state.bots.length);
}
