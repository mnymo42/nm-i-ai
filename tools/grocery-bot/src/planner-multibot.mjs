import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from './coords.mjs';
import { findTimeAwarePath, reservePath } from './routing.mjs';
import { countInventoryByType } from './world-model.mjs';
import {
  cloneDemand,
  hasDeliverableInventory,
  countDeliverableInventory,
  shouldScheduleDropOff,
  getNeededTypes,
  estimateCongestion,
  estimateDistanceToDropoff,
  closestAdjacentCell,
} from './planner-utils.mjs';

function sumCounts(map) {
  return Array.from(map.values()).reduce((sum, count) => sum + Math.max(0, count), 0);
}

function reserveInventoryForDemand(inventoryCounts, demand) {
  const remainingDemand = cloneDemand(demand);
  const surplusInventory = new Map(inventoryCounts);

  for (const [type, count] of inventoryCounts.entries()) {
    const required = remainingDemand.get(type) || 0;
    if (required <= 0 || count <= 0) {
      continue;
    }

    const used = Math.min(count, required);
    remainingDemand.set(type, required - used);
    surplusInventory.set(type, count - used);
  }

  return { remainingDemand, surplusInventory };
}

function zoneIndexForX(x, width, zoneCount) {
  if (zoneCount <= 1 || width <= 0) {
    return 0;
  }

  const normalized = Math.max(0, Math.min(width - 1, x));
  return Math.min(zoneCount - 1, Math.floor((normalized * zoneCount) / width));
}

export function estimateZonePenalty({ bot, task, state, profile }) {
  if (task?.kind !== 'pick_up' || !task.item || state.bots.length <= 1) {
    return 0;
  }

  const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
  const botIndex = botOrder.findIndex((candidate) => candidate.id === bot.id);
  if (botIndex < 0) {
    return 0;
  }

  const itemX = task.item.position?.[0];
  if (!Number.isFinite(itemX)) {
    return 0;
  }

  const taskZoneIndex = zoneIndexForX(itemX, state.grid.width, botOrder.length);
  const zoneDelta = Math.abs(taskZoneIndex - botIndex);
  if (zoneDelta === 0) {
    return 0;
  }

  const activePenalty = profile.assignment.active_zone_penalty ?? 0.35;
  const previewPenalty = profile.assignment.preview_zone_penalty ?? 1.1;
  const basePenalty = task.sourceOrder === 'preview' ? previewPenalty : activePenalty;

  return zoneDelta * basePenalty;
}

export function zoneIdForBot(state, botId) {
  const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
  return Math.max(0, botOrder.findIndex((candidate) => candidate.id === botId));
}

function zoneBounds(state, zoneId) {
  const zoneCount = Math.max(1, state.bots.length);
  const startX = Math.floor((zoneId * state.grid.width) / zoneCount);
  const nextStartX = Math.floor(((zoneId + 1) * state.grid.width) / zoneCount);
  return [startX, Math.max(startX, nextStartX - 1)];
}

function cloneMission(mission) {
  if (!mission) {
    return null;
  }

  return {
    ...mission,
    targetCell: mission.targetCell ? [...mission.targetCell] : null,
  };
}

function missionSignature(mission) {
  if (!mission) {
    return null;
  }

  return JSON.stringify({
    missionType: mission.missionType,
    orderId: mission.orderId,
    targetItemId: mission.targetItemId || null,
    targetType: mission.targetType || null,
    zoneId: mission.zoneId,
    targetCell: mission.targetCell || null,
  });
}

function decrementDemandByCount(demand, type, count = 1) {
  if (!demand.has(type) || count <= 0) {
    return;
  }

  demand.set(type, Math.max(0, demand.get(type) - count));
}

function sumFreeSlots(state) {
  return state.bots.reduce((sum, bot) => sum + Math.max(0, 3 - (bot.inventory || []).length), 0);
}

function findItemById(state, itemId) {
  return (state.items || []).find((item) => item.id === itemId) || null;
}

function candidateItemScore({
  bot,
  item,
  state,
  profile,
  sourceOrder,
}) {
  const zoneId = zoneIdForBot(state, bot.id);
  const itemZoneId = zoneIndexForX(item.position[0], state.grid.width, state.bots.length);
  const zoneDelta = Math.abs(itemZoneId - zoneId);
  const crossZonePenalty = sourceOrder === 'preview'
    ? (profile.assignment.preview_cross_zone_penalty ?? 1.6)
    : (profile.assignment.active_cross_zone_penalty ?? 0.3);

  return (
    Math.max(0, manhattanDistance(bot.position, item.position) - 1) +
    estimateDistanceToDropoff(item, state.drop_off) * 0.2 +
    zoneDelta * crossZonePenalty
  );
}

function pickMissionItem({
  bot,
  state,
  profile,
  demand,
  sourceOrder,
  blockedItems,
  reservedItemIds,
  roundsLeft,
  phase,
}) {
  const zoneId = zoneIdForBot(state, bot.id);
  const types = new Set(Array.from(demand.entries()).filter(([, count]) => count > 0).map(([type]) => type));
  if (types.size === 0) {
    return null;
  }

  const candidates = (state.items || []).filter((item) => (
    types.has(item.type)
    && !reservedItemIds.has(item.id)
    && !(blockedItems?.has(item.id))
  ));
  if (candidates.length === 0) {
    return null;
  }

  const sameZoneCandidates = candidates.filter((item) => (
    zoneIndexForX(item.position[0], state.grid.width, state.bots.length) === zoneId
  ));
  const pool = sourceOrder === 'preview' && sameZoneCandidates.length > 0
    ? sameZoneCandidates
    : candidates;

  let best = null;
  for (const item of pool) {
    const eta = Math.max(0, manhattanDistance(bot.position, item.position) - 1)
      + estimateDistanceToDropoff(item, state.drop_off)
      + 1;
    if ((phase === 'endgame' || phase === 'cutoff') && eta > roundsLeft) {
      continue;
    }

    const score = candidateItemScore({
      bot,
      item,
      state,
      profile,
      sourceOrder,
    });
    if (!best || score < best.score) {
      best = { item, score };
    }
  }

  return best?.item || null;
}

function findIdleRepositionCell(bot, state, graph) {
  const zoneId = zoneIdForBot(state, bot.id);
  const [startX, endX] = zoneBounds(state, zoneId);
  const preferredY = Math.max(1, Math.min(state.grid.height - 2, state.drop_off[1]));
  const centerX = Math.max(startX, Math.min(endX, Math.floor((startX + endX) / 2)));

  let best = null;
  for (let y = 1; y < state.grid.height - 1; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const candidate = [x, y];
      if (!graph.isWalkable(candidate)) {
        continue;
      }

      const score = manhattanDistance(candidate, [centerX, preferredY]) * 2 + manhattanDistance(bot.position, candidate);
      if (!best || score < best.score) {
        best = { cell: candidate, score };
      }
    }
  }

  return best?.cell || [...bot.position];
}

function shouldCommitDropMission({
  bot,
  world,
  phase,
  state,
  profile,
  uncoveredActiveCount,
}) {
  const deliverableCount = countDeliverableInventory(bot, world.activeDemand);
  if (deliverableCount <= 0) {
    return false;
  }

  if (phase === 'endgame' || phase === 'cutoff') {
    return true;
  }

  const dropCommitMin = profile.runtime.drop_commit_min_deliverable ?? 2;
  const inventoryCount = (bot.inventory || []).length;
  const closeToCompletion = uncoveredActiveCount <= dropCommitMin;
  const canCompleteNow = deliverableCount >= uncoveredActiveCount && uncoveredActiveCount > 0;

  return inventoryCount >= 3 || deliverableCount >= dropCommitMin || closeToCompletion || canCompleteNow;
}

function previewStillAllowed({
  state,
  profile,
  phase,
  roundsLeft,
  uncoveredActiveCount,
}) {
  const previewDisableRounds = profile.runtime.endgame_preview_disable_rounds ?? 40;
  if (phase === 'cutoff' || roundsLeft <= previewDisableRounds) {
    return false;
  }

  return sumFreeSlots(state) > uncoveredActiveCount + 2;
}

function shouldKeepMission({
  mission,
  bot,
  state,
  world,
  profile,
  phase,
  blockedItems,
  round,
  roundsLeft,
  uncoveredActive,
  previewAllowed,
  previewSlotsRemaining,
}) {
  if (!mission) {
    return { keep: false, reason: null };
  }

  if (mission.orderId !== (world.activeOrder?.id ?? null)) {
    return { keep: false, reason: 'order_changed' };
  }

  if (round - mission.assignedAtRound > mission.ttl) {
    return { keep: false, reason: 'mission_ttl' };
  }

  if (round - mission.lastProgressRound >= (profile.runtime.mission_stall_rounds ?? 4)) {
    return { keep: false, reason: 'mission_stalled' };
  }

  if ((mission.noPathRounds || 0) >= (profile.runtime.no_path_reassign_rounds ?? 2)) {
    return { keep: false, reason: 'mission_no_path' };
  }

  if (mission.missionType !== 'drop_active' && (bot.inventory || []).length >= 3 && hasDeliverableInventory(bot, world.activeDemand)) {
    return { keep: false, reason: 'full_with_active' };
  }

  if (mission.missionType === 'drop_active') {
    return {
      keep: hasDeliverableInventory(bot, world.activeDemand),
      reason: hasDeliverableInventory(bot, world.activeDemand) ? null : 'drop_done',
    };
  }

  if (mission.missionType === 'collect_active') {
    const item = findItemById(state, mission.targetItemId);
    if (!item || blockedItems?.has(item.id)) {
      return { keep: false, reason: 'target_missing' };
    }

    if ((uncoveredActive.get(mission.targetType) || 0) <= 0) {
      return { keep: false, reason: 'active_covered' };
    }

    const eta = Math.max(0, manhattanDistance(bot.position, item.position) - 1)
      + estimateDistanceToDropoff(item, state.drop_off)
      + 1;
    if ((phase === 'endgame' || phase === 'cutoff') && eta > roundsLeft) {
      return { keep: false, reason: 'too_late' };
    }

    return { keep: true, reason: null };
  }

  if (mission.missionType === 'collect_preview') {
    const item = findItemById(state, mission.targetItemId);
    if (!item || blockedItems?.has(item.id)) {
      return { keep: false, reason: 'target_missing' };
    }

    if (!previewAllowed || previewSlotsRemaining <= 0) {
      return { keep: false, reason: 'preview_suppressed' };
    }

    return { keep: true, reason: null };
  }

  if (mission.missionType === 'idle_reposition') {
    if (!mission.targetCell || (bot.position[0] === mission.targetCell[0] && bot.position[1] === mission.targetCell[1])) {
      return { keep: false, reason: 'idle_reached' };
    }

    return { keep: true, reason: null };
  }

  return { keep: false, reason: 'unknown' };
}

export function buildMediumMissionAssignments({
  state,
  world,
  graph,
  profile,
  phase,
  round,
  existingMissionsByBot = new Map(),
  blockedItemsByBot = new Map(),
  previousPositionByBot = new Map(),
  previousInventoryKeyByBot = new Map(),
}) {
  const missionTtl = profile.runtime.mission_ttl_rounds ?? 6;
  const roundsLeft = Math.max(0, state.max_rounds - state.round);
  const previewMissionConcurrency = profile.assignment.preview_mission_concurrency ?? 1;
  const inventoryCounts = countInventoryByType(state.bots);
  const { remainingDemand: activeUncoveredAfterHeld, surplusInventory } = reserveInventoryForDemand(inventoryCounts, world.activeDemand);
  const { remainingDemand: previewUncoveredAfterHeld } = reserveInventoryForDemand(surplusInventory, world.previewDemand);
  const missionsByBot = new Map();
  const reservedActive = cloneDemand(activeUncoveredAfterHeld);
  const reservedPreview = cloneDemand(previewUncoveredAfterHeld);
  const reservedItemIds = new Set();
  let missionReassignments = 0;
  let missionTimeouts = 0;
  let previewSuppressed = false;

  const candidateBots = [...state.bots].sort((a, b) => {
    const deliverableDelta = countDeliverableInventory(b, world.activeDemand) - countDeliverableInventory(a, world.activeDemand);
    if (deliverableDelta !== 0) {
      return deliverableDelta;
    }

    const freeSlotDelta = (3 - (b.inventory || []).length) - (3 - (a.inventory || []).length);
    if (freeSlotDelta !== 0) {
      return freeSlotDelta;
    }

    return a.id - b.id;
  });

  let previewSlotsRemaining = previewMissionConcurrency;
  let previewAllowed = previewStillAllowed({
    state,
    profile,
    phase,
    roundsLeft,
    uncoveredActiveCount: sumCounts(reservedActive),
  });

  for (const bot of candidateBots) {
    const existingMission = cloneMission(existingMissionsByBot.get(bot.id));
    if (!existingMission) {
      continue;
    }

    const previousPosition = previousPositionByBot.get(bot.id) || previousPositionByBot.get(`${bot.id}`) || null;
    const currentInventoryKey = (bot.inventory || []).slice().sort().join('|');
    const previousInventoryKey = previousInventoryKeyByBot.get(bot.id);
    if (
      (previousPosition && previousPosition !== encodeCoord(bot.position))
      || (previousInventoryKey !== undefined && previousInventoryKey !== currentInventoryKey)
    ) {
      existingMission.lastProgressRound = round;
      existingMission.noPathRounds = 0;
    }

    const keepDecision = shouldKeepMission({
      mission: existingMission,
      bot,
      state,
      world,
      profile,
      phase,
      blockedItems: blockedItemsByBot.get(bot.id),
      round,
      roundsLeft,
      uncoveredActive: reservedActive,
      previewAllowed,
      previewSlotsRemaining,
    });

    if (!keepDecision.keep) {
      if (['mission_ttl', 'mission_stalled', 'mission_no_path'].includes(keepDecision.reason)) {
        missionTimeouts += 1;
      }
      continue;
    }

    missionsByBot.set(bot.id, existingMission);
    if (existingMission.missionType === 'collect_active' && (reservedActive.get(existingMission.targetType) || 0) > 0) {
      decrementDemandByCount(reservedActive, existingMission.targetType, 1);
      reservedItemIds.add(existingMission.targetItemId);
    } else if (existingMission.missionType === 'collect_preview' && (reservedPreview.get(existingMission.targetType) || 0) > 0) {
      decrementDemandByCount(reservedPreview, existingMission.targetType, 1);
      reservedItemIds.add(existingMission.targetItemId);
      previewSlotsRemaining = Math.max(0, previewSlotsRemaining - 1);
    }
  }

  previewAllowed = previewStillAllowed({
    state,
    profile,
    phase,
    roundsLeft,
    uncoveredActiveCount: sumCounts(reservedActive),
  });
  if ((!previewAllowed || sumCounts(reservedActive) > 0 || previewSlotsRemaining <= 0) && sumCounts(reservedPreview) > 0) {
    previewSuppressed = true;
  }

  for (const bot of candidateBots) {
    if (missionsByBot.has(bot.id)) {
      continue;
    }

    const previousMission = existingMissionsByBot.get(bot.id) || null;
    const uncoveredActiveCount = sumCounts(reservedActive);
    let mission = null;

    if (shouldCommitDropMission({
      bot,
      world,
      phase,
      state,
      profile,
      uncoveredActiveCount,
    })) {
      mission = {
        missionType: 'drop_active',
        orderId: world.activeOrder?.id ?? null,
        targetItemId: null,
        targetType: null,
        zoneId: zoneIdForBot(state, bot.id),
        targetCell: [...state.drop_off],
        assignedAtRound: round,
        lastProgressRound: round,
        ttl: missionTtl,
        noPathRounds: 0,
      };
    }

    if (!mission && uncoveredActiveCount > 0 && (bot.inventory || []).length < 3) {
      const blockedItems = blockedItemsByBot.get(bot.id);
      const item = pickMissionItem({
        bot,
        state,
        profile,
        demand: reservedActive,
        sourceOrder: 'active',
        blockedItems,
        reservedItemIds,
        roundsLeft,
        phase,
      });

      if (item) {
        mission = {
          missionType: 'collect_active',
          orderId: world.activeOrder?.id ?? null,
          targetItemId: item.id,
          targetType: item.type,
          zoneId: zoneIdForBot(state, bot.id),
          targetCell: null,
          assignedAtRound: round,
          lastProgressRound: round,
          ttl: missionTtl,
          noPathRounds: 0,
        };
        decrementDemandByCount(reservedActive, item.type, 1);
        reservedItemIds.add(item.id);
      }
    }

    previewAllowed = previewStillAllowed({
      state,
      profile,
      phase,
      roundsLeft,
      uncoveredActiveCount: sumCounts(reservedActive),
    });
    if ((!previewAllowed || sumCounts(reservedActive) > 0 || previewSlotsRemaining <= 0) && sumCounts(reservedPreview) > 0) {
      previewSuppressed = true;
    }

    if (
      !mission
      && previewAllowed
      && previewSlotsRemaining > 0
      && sumCounts(reservedActive) === 0
      && sumCounts(reservedPreview) > 0
      && (bot.inventory || []).length < 3
    ) {
      const blockedItems = blockedItemsByBot.get(bot.id);
      const item = pickMissionItem({
        bot,
        state,
        profile,
        demand: reservedPreview,
        sourceOrder: 'preview',
        blockedItems,
        reservedItemIds,
        roundsLeft,
        phase,
      });

      if (item) {
        mission = {
          missionType: 'collect_preview',
          orderId: world.activeOrder?.id ?? null,
          targetItemId: item.id,
          targetType: item.type,
          zoneId: zoneIdForBot(state, bot.id),
          targetCell: null,
          assignedAtRound: round,
          lastProgressRound: round,
          ttl: missionTtl,
          noPathRounds: 0,
        };
        decrementDemandByCount(reservedPreview, item.type, 1);
        reservedItemIds.add(item.id);
        previewSlotsRemaining = Math.max(0, previewSlotsRemaining - 1);
      }
    }

    if (!mission) {
      mission = {
        missionType: 'idle_reposition',
        orderId: world.activeOrder?.id ?? null,
        targetItemId: null,
        targetType: null,
        zoneId: zoneIdForBot(state, bot.id),
        targetCell: findIdleRepositionCell(bot, state, graph),
        assignedAtRound: round,
        lastProgressRound: round,
        ttl: missionTtl,
        noPathRounds: 0,
      };
    }

    missionsByBot.set(bot.id, mission);
    if (missionSignature(previousMission) !== missionSignature(mission)) {
      missionReassignments += 1;
    }
  }

  const missionTypeByBot = Object.fromEntries(
    [...missionsByBot.entries()].sort((a, b) => a[0] - b[0]).map(([botId, mission]) => [botId, mission.missionType]),
  );

  return {
    missionsByBot,
    metrics: {
      missionTypeByBot,
      missionReassignments,
      activeMissionsAssigned: [...missionsByBot.values()].filter((mission) => mission.missionType === 'collect_active').length,
      previewMissionsAssigned: [...missionsByBot.values()].filter((mission) => mission.missionType === 'collect_preview').length,
      previewSuppressed,
      dropMissionsAssigned: [...missionsByBot.values()].filter((mission) => mission.missionType === 'drop_active').length,
      missionTimeouts,
    },
  };
}

export function resolveMissionAction({
  bot,
  mission,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
}) {
  if (!mission) {
    return { action: 'wait', nextPath: [bot.position], targetType: 'mission_idle', noPath: false };
  }

  if (mission.missionType === 'drop_active') {
    if (bot.position[0] === state.drop_off[0] && bot.position[1] === state.drop_off[1]) {
      return { action: 'drop_off', nextPath: [bot.position], targetType: 'drop_off', noPath: false };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: state.drop_off,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
    });
    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'drop_off', noPath: true };
    }

    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'drop_off', noPath: false };
  }

  if (mission.missionType === 'collect_active' || mission.missionType === 'collect_preview') {
    const item = findItemById(state, mission.targetItemId);
    if (!item || (bot.inventory || []).length >= 3) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'item', noPath: true };
    }

    if (adjacentManhattan(bot.position, item.position)) {
      return { action: 'pick_up', itemId: item.id, nextPath: [bot.position], targetType: 'item', noPath: false };
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
      return { action: 'wait', nextPath: [bot.position], targetType: 'item', noPath: true };
    }

    return { action: moveToAction(target.path[0], target.path[1]), nextPath: target.path, targetType: 'item', noPath: false };
  }

  if (mission.missionType === 'idle_reposition' && mission.targetCell) {
    if (bot.position[0] === mission.targetCell[0] && bot.position[1] === mission.targetCell[1]) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'idle_reposition', noPath: false };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: mission.targetCell,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
    });
    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'idle_reposition', noPath: true };
    }

    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'idle_reposition', noPath: false };
  }

  return { action: 'wait', nextPath: [bot.position], targetType: 'mission_idle', noPath: false };
}

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
