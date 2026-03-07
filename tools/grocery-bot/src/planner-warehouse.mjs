import { encodeCoord, manhattanDistance, moveToAction, adjacentManhattan } from './coords.mjs';
import { findTimeAwarePath } from './routing.mjs';
import { countInventoryByType } from './world-model.mjs';
import {
  cloneDemand,
  countDeliverableInventory,
  decrementDemand,
  estimateDistanceToDropoff,
  hasDeliverableInventory,
  isAtAnyDropOff,
  nearestDropOff,
  primaryDropOff,
} from './planner-utils.mjs';
import {
  reserveInventoryForDemand,
  sumCounts,
  zoneIdForBot,
  zoneIndexForX,
} from './planner-multibot-common.mjs';

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
    serviceCell: mission.serviceCell ? [...mission.serviceCell] : null,
    queueCell: mission.queueCell ? [...mission.queueCell] : null,
  };
}

function missionSignature(mission) {
  if (!mission) {
    return null;
  }

  return JSON.stringify({
    missionType: mission.missionType,
    queueFor: mission.queueFor || null,
    orderId: mission.orderId,
    targetItemId: mission.targetItemId || null,
    targetType: mission.targetType || null,
    zoneId: mission.zoneId,
    targetCell: mission.targetCell || null,
    serviceCell: mission.serviceCell || null,
    queueCell: mission.queueCell || null,
  });
}

function findItemById(state, itemId) {
  return (state.items || []).find((item) => item.id === itemId) || null;
}

function countPreviewWipItems(surplusInventory, previewDemand) {
  let used = 0;
  for (const [type, count] of surplusInventory.entries()) {
    const previewCount = previewDemand.get(type) || 0;
    used += Math.min(count, previewCount);
  }

  return used;
}

function countAssignedDemand(existingMissionsByBot, activeOrderId) {
  const assigned = new Map();
  for (const mission of existingMissionsByBot.values()) {
    if (!mission || mission.orderId !== activeOrderId) {
      continue;
    }

    const type = mission.targetType;
    if (!type) {
      continue;
    }

    if (mission.missionType === 'pickup_active' || (mission.missionType === 'queue_service_bay' && mission.queueFor === 'pickup_active')) {
      assigned.set(type, (assigned.get(type) || 0) + 1);
    }
  }

  return assigned;
}

function applyReservedDemand(baseDemand, reservedCounts) {
  const remaining = cloneDemand(baseDemand);
  for (const [type, count] of reservedCounts.entries()) {
    for (let index = 0; index < count; index += 1) {
      decrementDemand(remaining, type);
    }
  }
  return remaining;
}

function estimateActiveCloseEta({ state, remainingActiveDemand }) {
  if (sumCounts(remainingActiveDemand) === 0) {
    return 0;
  }

  const selectedCosts = [];
  for (const [type, count] of remainingActiveDemand.entries()) {
    if (count <= 0) {
      continue;
    }

    const candidateCosts = (state.items || [])
      .filter((item) => item.type === type)
      .map((item) => {
        let bestBotCost = Number.POSITIVE_INFINITY;
        for (const bot of state.bots) {
          if ((bot.inventory || []).length >= 3) {
            continue;
          }

          const cost = Math.max(0, manhattanDistance(bot.position, item.position) - 1)
            + estimateDistanceToDropoff(item, state.drop_offs || state.drop_off)
            + 1;
          bestBotCost = Math.min(bestBotCost, cost);
        }
        return bestBotCost;
      })
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    if (candidateCosts.length < count) {
      return Number.POSITIVE_INFINITY;
    }

    for (let index = 0; index < count; index += 1) {
      selectedCosts.push(candidateCosts[index]);
    }
  }

  if (selectedCosts.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(...selectedCosts);
}

export function buildWarehouseControlContext({
  state,
  world,
  profile,
  existingMissionsByBot = new Map(),
}) {
  const roundsLeft = Math.max(0, state.max_rounds - state.round);
  const runtime = profile.runtime || {};
  const inventoryCounts = countInventoryByType(state.bots);
  const {
    remainingDemand: activeDemandAfterHeld,
    surplusInventory,
  } = reserveInventoryForDemand(inventoryCounts, world.activeDemand);
  const {
    remainingDemand: previewDemandAfterHeld,
  } = reserveInventoryForDemand(surplusInventory, world.previewDemand);
  const assignedActiveCounts = countAssignedDemand(existingMissionsByBot, world.activeOrder?.id ?? null);
  const activeDemandAfterAssigned = applyReservedDemand(activeDemandAfterHeld, assignedActiveCounts);
  const activeRemainingCount = sumCounts(activeDemandAfterAssigned);
  const previewRemainingCount = sumCounts(previewDemandAfterHeld);
  const previewWipItems = countPreviewWipItems(surplusInventory, world.previewDemand);
  const previewWipCapItems = runtime.preview_wip_cap_items ?? 2;
  const previewRunnerCap = runtime.preview_runner_cap ?? 1;
  const activeMissionBuffer = runtime.active_mission_buffer ?? 1;
  const closeActiveEtaThreshold = runtime.close_active_eta_threshold ?? 9;
  const closeActiveRemainingThreshold = runtime.close_active_remaining_threshold ?? 2;
  const endgameDisablePreviewRounds = runtime.endgame_disable_preview_rounds ?? 40;
  const projectedActiveCloseEta = estimateActiveCloseEta({
    state,
    remainingActiveDemand: activeDemandAfterAssigned,
  });

  let mode = 'build_active_inventory';
  if (roundsLeft <= endgameDisablePreviewRounds) {
    if (activeRemainingCount > 0) {
      mode = projectedActiveCloseEta <= roundsLeft ? 'close_if_feasible' : 'partial_cashout';
    } else {
      mode = 'stop_preview';
    }
  } else if (activeRemainingCount === 0) {
    if (previewRemainingCount > 0 && previewWipItems < previewWipCapItems) {
      mode = 'limited_preview_prefetch';
    } else {
      mode = 'stop_preview';
    }
  } else if (
    activeRemainingCount <= closeActiveRemainingThreshold
    || projectedActiveCloseEta <= closeActiveEtaThreshold
  ) {
    mode = 'close_active_order';
  }

  const previewAllowed = (
    mode === 'limited_preview_prefetch'
    && previewRemainingCount > 0
    && previewWipItems < previewWipCapItems
  );
  const activeRunnerCap = Math.max(
    1,
    Math.min(
      state.bots.length,
      runtime.active_runner_cap ?? (activeRemainingCount + activeMissionBuffer),
    ),
  );

  return {
    mode,
    roundsLeft,
    activeDemandAfterHeld,
    activeDemandAfterAssigned,
    activeDemandRemaining: activeRemainingCount,
    activeDemandCoveredByHeld: sumCounts(world.activeDemand) - sumCounts(activeDemandAfterHeld),
    activeDemandCoveredByAssigned: sumCounts(activeDemandAfterHeld) - activeRemainingCount,
    previewDemandAfterHeld,
    previewDemandRemaining: previewRemainingCount,
    previewWipItems,
    previewWipCapItems,
    previewRunnerCap,
    activeRunnerCap,
    previewAllowed,
    projectedActiveCloseEta,
  };
}

function buildOccupiedByCell(state) {
  return new Map((state.bots || []).map((bot) => [encodeCoord(bot.position), bot.id]));
}

function isCellAvailable(cell, botId, occupiedByCell, reservedCells) {
  const key = encodeCoord(cell);
  const occupant = occupiedByCell.get(key);
  if (occupant !== undefined && occupant !== botId) {
    return false;
  }

  return !reservedCells.has(key);
}

function enumerateQueueCells({ graph, serviceCell, blockedKeys, queueDepth }) {
  const queueCells = [];
  const seen = new Set([encodeCoord(serviceCell)]);
  let frontier = [serviceCell];

  for (let depth = 1; depth <= queueDepth; depth += 1) {
    const nextFrontier = [];
    for (const coord of frontier) {
      for (const neighbor of graph.neighbors(coord)) {
        const key = encodeCoord(neighbor);
        if (seen.has(key) || blockedKeys.has(key)) {
          continue;
        }

        seen.add(key);
        queueCells.push(neighbor);
        nextFrontier.push(neighbor);
      }
    }
    frontier = nextFrontier;
  }

  return queueCells;
}

function serviceCandidatesForItem({ bot, item, state, graph, allowCrossZone }) {
  const adjacent = graph.adjacentWalkableCells(item.position);
  const zoneId = zoneIdForBot(state, bot.id);
  const local = [];
  const global = [];

  for (const cell of adjacent) {
    const cellZone = zoneIndexForX(cell[0], state.grid.width, state.bots.length);
    const score = manhattanDistance(bot.position, cell);
    const target = { cell, score };
    if (cellZone === zoneId) {
      local.push(target);
    } else {
      global.push(target);
    }
  }

  local.sort((a, b) => a.score - b.score);
  global.sort((a, b) => a.score - b.score);
  return allowCrossZone || local.length === 0 ? [...local, ...global] : local;
}

function allocateShelfPlan({
  bot,
  item,
  state,
  graph,
  occupiedByCell,
  reservedServiceCells,
  reservedQueueCells,
  queueDepth,
  allowCrossZone,
}) {
  const blockedKeys = new Set([encodeCoord(item.position), ...reservedServiceCells, ...reservedQueueCells]);
  const candidates = serviceCandidatesForItem({ bot, item, state, graph, allowCrossZone });

  for (const candidate of candidates) {
    const serviceKey = encodeCoord(candidate.cell);
    if (isCellAvailable(candidate.cell, bot.id, occupiedByCell, reservedServiceCells)) {
      reservedServiceCells.add(serviceKey);
      return {
        status: 'service',
        serviceCell: candidate.cell,
        targetCell: candidate.cell,
        queueCell: null,
      };
    }

    const queueCells = enumerateQueueCells({
      graph,
      serviceCell: candidate.cell,
      blockedKeys: new Set([...blockedKeys, serviceKey]),
      queueDepth,
    });
    for (const queueCell of queueCells) {
      const queueKey = encodeCoord(queueCell);
      if (!isCellAvailable(queueCell, bot.id, occupiedByCell, reservedQueueCells)) {
        continue;
      }

      reservedServiceCells.add(serviceKey);
      reservedQueueCells.add(queueKey);
      return {
        status: 'queue',
        serviceCell: candidate.cell,
        targetCell: queueCell,
        queueCell,
      };
    }
  }

  return null;
}

function allocateDropPlan({
  bot,
  state,
  graph,
  occupiedByCell,
  reservedServiceCells,
  reservedQueueCells,
  queueDepth,
}) {
  const serviceCell = nearestDropOff(bot.position, state);
  const serviceKey = encodeCoord(serviceCell);
  if (isCellAvailable(serviceCell, bot.id, occupiedByCell, reservedServiceCells)) {
    reservedServiceCells.add(serviceKey);
    return {
      status: 'service',
      serviceCell,
      targetCell: serviceCell,
      queueCell: null,
    };
  }

  const queueCells = enumerateQueueCells({
    graph,
    serviceCell,
    blockedKeys: new Set([serviceKey, ...reservedServiceCells, ...reservedQueueCells]),
    queueDepth,
  }).sort((a, b) => manhattanDistance(bot.position, a) - manhattanDistance(bot.position, b));

  for (const queueCell of queueCells) {
    const queueKey = encodeCoord(queueCell);
    if (!isCellAvailable(queueCell, bot.id, occupiedByCell, reservedQueueCells)) {
      continue;
    }

    reservedServiceCells.add(serviceKey);
    reservedQueueCells.add(queueKey);
    return {
      status: 'queue',
      serviceCell,
      targetCell: queueCell,
      queueCell,
    };
  }

  return null;
}

function pickWarehouseItem({
  bot,
  state,
  demand,
  blockedItems,
  reservedItemIds,
  sourceOrder,
  control,
  allowCrossZone,
}) {
  const neededTypes = new Set(
    Array.from(demand.entries())
      .filter(([, count]) => count > 0)
      .map(([type]) => type),
  );
  if (neededTypes.size === 0) {
    return null;
  }

  const zoneId = zoneIdForBot(state, bot.id);
  const candidates = (state.items || []).filter((item) => (
    neededTypes.has(item.type)
    && !reservedItemIds.has(item.id)
    && !(blockedItems?.has(item.id))
  ));
  if (candidates.length === 0) {
    return null;
  }

  const local = candidates.filter((item) => (
    zoneIndexForX(item.position[0], state.grid.width, state.bots.length) === zoneId
  ));
  const pool = sourceOrder === 'preview'
    ? (local.length > 0 ? local : (allowCrossZone ? candidates : []))
    : (allowCrossZone || local.length === 0 ? candidates : local);

  let best = null;
  for (const item of pool) {
    const score = Math.max(0, manhattanDistance(bot.position, item.position) - 1)
      + estimateDistanceToDropoff(item, state.drop_offs || state.drop_off) * 0.2;
    if (!best || score < best.score) {
      best = { item, score };
    }
  }

  return best?.item || null;
}

function findZoneRepositionCell(bot, state, graph, reservedQueueCells) {
  const zoneId = zoneIdForBot(state, bot.id);
  const [startX, endX] = zoneBounds(state, zoneId);
  const preferredY = Math.max(1, Math.min(state.grid.height - 2, primaryDropOff(state)[1]));
  const centerX = Math.max(startX, Math.min(endX, Math.floor((startX + endX) / 2)));

  let best = null;
  for (let y = 1; y < state.grid.height - 1; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const candidate = [x, y];
      const key = encodeCoord(candidate);
      if (!graph.isWalkable(candidate) || reservedQueueCells.has(key)) {
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

function isActiveRunnerMission(mission) {
  return mission?.missionType === 'pickup_active'
    || (mission?.missionType === 'queue_service_bay' && mission?.queueFor === 'pickup_active');
}

function shouldKeepWarehouseMission({
  mission,
  bot,
  state,
  world,
  control,
  profile,
  round,
  blockedItems,
}) {
  if (!mission) {
    return false;
  }

  if (mission.orderId !== (world.activeOrder?.id ?? null)) {
    return false;
  }

  if (round - mission.assignedAtRound > (mission.ttl || profile.runtime.mission_ttl_rounds || 6)) {
    return false;
  }

  if (round - mission.lastProgressRound >= (profile.runtime.mission_stall_rounds ?? 4)) {
    return false;
  }

  if ((mission.noPathRounds || 0) >= (profile.runtime.no_path_reassign_rounds ?? 2)) {
    return false;
  }

  if (mission.missionType === 'drop_active') {
    return hasDeliverableInventory(bot, world.activeDemand);
  }

  if (mission.missionType === 'pickup_active') {
    const item = findItemById(state, mission.targetItemId);
    return Boolean(item && !blockedItems?.has(item.id) && (control.activeDemandAfterAssigned.get(mission.targetType) || 0) > 0);
  }

  if (mission.missionType === 'pickup_preview') {
    const item = findItemById(state, mission.targetItemId);
    return Boolean(item && !blockedItems?.has(item.id) && control.previewAllowed);
  }

  if (mission.missionType === 'queue_service_bay') {
    if (mission.serviceCell) {
      const occupant = buildOccupiedByCell(state).get(encodeCoord(mission.serviceCell));
      if (occupant === undefined || occupant === bot.id) {
        return false;
      }
    }

    const item = mission.targetItemId ? findItemById(state, mission.targetItemId) : null;
    if (mission.queueFor === 'drop_active') {
      return hasDeliverableInventory(bot, world.activeDemand);
    }
    if (mission.queueFor === 'pickup_active') {
      return Boolean(item && !blockedItems?.has(item.id));
    }
    if (mission.queueFor === 'pickup_preview') {
      return Boolean(item && !blockedItems?.has(item.id) && control.previewAllowed);
    }
    return false;
  }

  if (mission.missionType === 'reposition_zone') {
    return Boolean(mission.targetCell);
  }

  return false;
}

export function buildWarehouseAssignments({
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
  const control = buildWarehouseControlContext({
    state,
    world,
    profile,
    existingMissionsByBot,
  });
  const missionsByBot = new Map();
  const reservedServiceCells = new Set();
  const reservedQueueCells = new Set();
  const reservedRepositionCells = new Set();
  const reservedItemIds = new Set();
  const occupiedByCell = buildOccupiedByCell(state);
  const reservedActive = cloneDemand(control.activeDemandAfterHeld);
  const reservedPreview = cloneDemand(control.previewDemandAfterHeld);
  const queueDepth = profile.runtime.service_bay_queue_depth ?? 1;
  let missionReassignments = 0;
  let missionTimeouts = 0;
  let previewRunnerCount = 0;
  let activeRunnerCount = 0;
  let queueAssignments = 0;
  let serviceBayAssignments = 0;

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

    const keep = shouldKeepWarehouseMission({
      mission: existingMission,
      bot,
      state,
      world,
      control,
      profile,
      round,
      blockedItems: blockedItemsByBot.get(bot.id),
    });
    if (!keep) {
      if (
        existingMission
        && (
          round - existingMission.assignedAtRound > (existingMission.ttl || profile.runtime.mission_ttl_rounds || 6)
          || round - existingMission.lastProgressRound >= (profile.runtime.mission_stall_rounds ?? 4)
          || (existingMission.noPathRounds || 0) >= (profile.runtime.no_path_reassign_rounds ?? 2)
        )
      ) {
        missionTimeouts += 1;
      }
      continue;
    }

    missionsByBot.set(bot.id, existingMission);
    if (existingMission.serviceCell) {
      reservedServiceCells.add(encodeCoord(existingMission.serviceCell));
      serviceBayAssignments += 1;
    }
    if (existingMission.queueCell) {
      reservedQueueCells.add(encodeCoord(existingMission.queueCell));
      queueAssignments += 1;
    }
    if (existingMission.missionType === 'reposition_zone' && existingMission.targetCell) {
      reservedRepositionCells.add(encodeCoord(existingMission.targetCell));
    }
    if (existingMission.targetItemId) {
      reservedItemIds.add(existingMission.targetItemId);
    }
    if (isActiveRunnerMission(existingMission)) {
      decrementDemand(reservedActive, existingMission.targetType);
      activeRunnerCount += 1;
    } else if (existingMission.missionType === 'pickup_preview' || (existingMission.missionType === 'queue_service_bay' && existingMission.queueFor === 'pickup_preview')) {
      decrementDemand(reservedPreview, existingMission.targetType);
      previewRunnerCount += 1;
    }
  }

  for (const bot of candidateBots) {
    if (missionsByBot.has(bot.id)) {
      continue;
    }

    const previousMission = existingMissionsByBot.get(bot.id) || null;
    let mission = null;
    const blockedItems = blockedItemsByBot.get(bot.id);
    const allowCrossZoneActive = control.mode === 'close_active_order'
      || control.mode === 'partial_cashout'
      || control.projectedActiveCloseEta > (profile.runtime.close_active_eta_threshold ?? 9);

    if (hasDeliverableInventory(bot, world.activeDemand)) {
      const dropPlan = allocateDropPlan({
        bot,
        state,
        graph,
        occupiedByCell,
        reservedServiceCells,
        reservedQueueCells,
        queueDepth,
      });
      if (dropPlan) {
        mission = dropPlan.status === 'service'
          ? {
            missionType: 'drop_active',
            orderId: world.activeOrder?.id ?? null,
            targetItemId: null,
            targetType: null,
            targetCell: dropPlan.targetCell,
            serviceCell: dropPlan.serviceCell,
            queueCell: null,
            queueFor: null,
            zoneId: zoneIdForBot(state, bot.id),
            assignedAtRound: round,
            lastProgressRound: round,
            ttl: profile.runtime.mission_ttl_rounds ?? 6,
            noPathRounds: 0,
          }
          : {
            missionType: 'queue_service_bay',
            queueFor: 'drop_active',
            orderId: world.activeOrder?.id ?? null,
            targetItemId: null,
            targetType: null,
            targetCell: dropPlan.targetCell,
            serviceCell: dropPlan.serviceCell,
            queueCell: dropPlan.queueCell,
            zoneId: zoneIdForBot(state, bot.id),
            assignedAtRound: round,
            lastProgressRound: round,
            ttl: profile.runtime.mission_ttl_rounds ?? 6,
            noPathRounds: 0,
          };
      }
    }

    if (
      !mission
      && sumCounts(reservedActive) > 0
      && activeRunnerCount < control.activeRunnerCap
      && (bot.inventory || []).length < 3
    ) {
      const item = pickWarehouseItem({
        bot,
        state,
        demand: reservedActive,
        blockedItems,
        reservedItemIds,
        sourceOrder: 'active',
        control,
        allowCrossZone: allowCrossZoneActive,
      });

      if (item) {
        const plan = allocateShelfPlan({
          bot,
          item,
          state,
          graph,
          occupiedByCell,
          reservedServiceCells,
          reservedQueueCells,
          queueDepth,
          allowCrossZone: allowCrossZoneActive,
        });

        if (plan) {
          reservedItemIds.add(item.id);
          decrementDemand(reservedActive, item.type);
          activeRunnerCount += 1;
          mission = plan.status === 'service'
            ? {
              missionType: 'pickup_active',
              orderId: world.activeOrder?.id ?? null,
              targetItemId: item.id,
              targetType: item.type,
              targetCell: plan.targetCell,
              serviceCell: plan.serviceCell,
              queueCell: null,
              queueFor: null,
              zoneId: zoneIdForBot(state, bot.id),
              assignedAtRound: round,
              lastProgressRound: round,
              ttl: profile.runtime.mission_ttl_rounds ?? 6,
              noPathRounds: 0,
            }
            : {
              missionType: 'queue_service_bay',
              queueFor: 'pickup_active',
              orderId: world.activeOrder?.id ?? null,
              targetItemId: item.id,
              targetType: item.type,
              targetCell: plan.targetCell,
              serviceCell: plan.serviceCell,
              queueCell: plan.queueCell,
              zoneId: zoneIdForBot(state, bot.id),
              assignedAtRound: round,
              lastProgressRound: round,
              ttl: profile.runtime.mission_ttl_rounds ?? 6,
              noPathRounds: 0,
            };
        }
      }
    }

    if (
      !mission
      && control.previewAllowed
      && previewRunnerCount < control.previewRunnerCap
      && sumCounts(reservedActive) === 0
      && sumCounts(reservedPreview) > 0
      && (bot.inventory || []).length < 3
    ) {
      const item = pickWarehouseItem({
        bot,
        state,
        demand: reservedPreview,
        blockedItems,
        reservedItemIds,
        sourceOrder: 'preview',
        control,
        allowCrossZone: false,
      });

      if (item) {
        const plan = allocateShelfPlan({
          bot,
          item,
          state,
          graph,
          occupiedByCell,
          reservedServiceCells,
          reservedQueueCells,
          queueDepth,
          allowCrossZone: false,
        });

        if (plan) {
          reservedItemIds.add(item.id);
          decrementDemand(reservedPreview, item.type);
          previewRunnerCount += 1;
          mission = plan.status === 'service'
            ? {
              missionType: 'pickup_preview',
              orderId: world.activeOrder?.id ?? null,
              targetItemId: item.id,
              targetType: item.type,
              targetCell: plan.targetCell,
              serviceCell: plan.serviceCell,
              queueCell: null,
              queueFor: null,
              zoneId: zoneIdForBot(state, bot.id),
              assignedAtRound: round,
              lastProgressRound: round,
              ttl: profile.runtime.mission_ttl_rounds ?? 6,
              noPathRounds: 0,
            }
            : {
              missionType: 'queue_service_bay',
              queueFor: 'pickup_preview',
              orderId: world.activeOrder?.id ?? null,
              targetItemId: item.id,
              targetType: item.type,
              targetCell: plan.targetCell,
              serviceCell: plan.serviceCell,
              queueCell: plan.queueCell,
              zoneId: zoneIdForBot(state, bot.id),
              assignedAtRound: round,
              lastProgressRound: round,
              ttl: profile.runtime.mission_ttl_rounds ?? 6,
              noPathRounds: 0,
            };
        }
      }
    }

    if (!mission) {
      const repositionCell = findZoneRepositionCell(bot, state, graph, new Set([
        ...reservedQueueCells,
        ...reservedRepositionCells,
      ]));
      reservedRepositionCells.add(encodeCoord(repositionCell));
      mission = {
        missionType: 'reposition_zone',
        orderId: world.activeOrder?.id ?? null,
        targetItemId: null,
        targetType: null,
        targetCell: repositionCell,
        serviceCell: null,
        queueCell: null,
        queueFor: null,
        zoneId: zoneIdForBot(state, bot.id),
        assignedAtRound: round,
        lastProgressRound: round,
        ttl: profile.runtime.mission_ttl_rounds ?? 6,
        noPathRounds: 0,
      };
    }

    if (mission.serviceCell) {
      serviceBayAssignments += 1;
    }
    if (mission.queueCell) {
      queueAssignments += 1;
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
    control,
    missionsByBot,
    metrics: {
      controlMode: control.mode,
      missionTypeByBot,
      missionReassignments,
      missionTimeouts,
      activeMissionsAssigned: [...missionsByBot.values()].filter((mission) => mission.missionType === 'pickup_active').length,
      previewMissionsAssigned: [...missionsByBot.values()].filter((mission) => mission.missionType === 'pickup_preview').length,
      dropMissionsAssigned: [...missionsByBot.values()].filter((mission) => mission.missionType === 'drop_active').length,
      queueAssignments,
      serviceBayAssignments,
      previewSuppressed: !control.previewAllowed && control.previewDemandRemaining > 0,
      previewWipItems: control.previewWipItems,
      activeRunnerCap: control.activeRunnerCap,
      activeDemandRemaining: control.activeDemandRemaining,
      activeDemandCoveredByHeld: control.activeDemandCoveredByHeld,
      activeDemandCoveredByAssigned: control.activeDemandCoveredByAssigned,
      projectedActiveCloseEta: Number.isFinite(control.projectedActiveCloseEta) ? control.projectedActiveCloseEta : null,
    },
  };
}

export function resolveWarehouseMissionAction({
  bot,
  mission,
  state,
  graph,
  reservations,
  edgeReservations,
  profile,
  blockedNextStepCoords = null,
}) {
  if (!mission) {
    return { action: 'wait', nextPath: [bot.position], targetType: 'warehouse_idle', noPath: false };
  }

  if (mission.missionType === 'drop_active') {
    if (isAtAnyDropOff(bot.position, state)) {
      return { action: 'drop_off', nextPath: [bot.position], targetType: 'drop_off', noPath: false };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: mission.serviceCell || mission.targetCell || nearestDropOff(bot.position, state),
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
      blockedNextStepCoords,
    });
    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'drop_off', noPath: true };
    }

    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'drop_off', noPath: false };
  }

  if (mission.missionType === 'queue_service_bay') {
    const target = mission.targetCell || mission.queueCell || mission.serviceCell;
    if (!target) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'queue_service_bay', noPath: true };
    }

    if (bot.position[0] === target[0] && bot.position[1] === target[1]) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'queue_service_bay', noPath: false };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: target,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
      blockedNextStepCoords,
    });
    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'queue_service_bay', noPath: true };
    }

    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'queue_service_bay', noPath: false };
  }

  if (mission.missionType === 'pickup_active' || mission.missionType === 'pickup_preview') {
    const item = findItemById(state, mission.targetItemId);
    if (!item || (bot.inventory || []).length >= 3) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'item', noPath: true };
    }

    if (adjacentManhattan(bot.position, item.position)) {
      return { action: 'pick_up', itemId: item.id, nextPath: [bot.position], targetType: 'item', noPath: false };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: mission.serviceCell || mission.targetCell,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
      blockedNextStepCoords,
    });
    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'item', noPath: true };
    }

    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'item', noPath: false };
  }

  if (mission.missionType === 'reposition_zone' && mission.targetCell) {
    if (bot.position[0] === mission.targetCell[0] && bot.position[1] === mission.targetCell[1]) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'reposition_zone', noPath: false };
    }

    const path = findTimeAwarePath({
      graph,
      start: bot.position,
      goal: mission.targetCell,
      reservations,
      edgeReservations,
      startTime: 0,
      horizon: profile.routing.horizon,
      blockedNextStepCoords,
    });
    if (!path || path.length < 2) {
      return { action: 'wait', nextPath: [bot.position], targetType: 'reposition_zone', noPath: true };
    }

    return { action: moveToAction(path[0], path[1]), nextPath: path, targetType: 'reposition_zone', noPath: false };
  }

  return { action: 'wait', nextPath: [bot.position], targetType: 'warehouse_idle', noPath: false };
}
