import { encodeCoord, manhattanDistance, moveToAction } from './coords.mjs';
import { evaluateOracleScript } from './oracle-script-evaluator.mjs';
import {
  buildOracleScriptWorld,
  buildScarityTable,
  buildStagingCells,
  clearReservedCellRange,
  countByType,
  findPathToAnyGoal,
  getPickupCells,
  normalizeOracle,
  oracleScriptDefaults,
  reserveCell,
  reserveStationaryRange,
  reserveTimedPath,
} from './oracle-script-world.mjs';

function buildActionEntry(botId, action, itemId = null) {
  const entry = { bot: botId, action };
  if (itemId) {
    entry.item_id = itemId;
  }
  return entry;
}

function setBotAction(scriptByTick, tick, botId, action, itemId = null) {
  if (!scriptByTick.has(tick)) {
    scriptByTick.set(tick, new Map());
  }
  const tickMap = scriptByTick.get(tick);
  if (tickMap.has(botId)) {
    throw new Error(`Bot ${botId} already has scripted action on tick ${tick}`);
  }
  tickMap.set(botId, buildActionEntry(botId, action, itemId));
}

function finalizeScriptTicks(scriptByTick, botCount, lastScriptedTick) {
  const ticks = [];
  for (let tick = 0; tick <= lastScriptedTick; tick += 1) {
    const tickMap = scriptByTick.get(tick) || new Map();
    const actions = [];
    for (let botId = 0; botId < botCount; botId += 1) {
      actions.push(tickMap.get(botId) || { bot: botId, action: 'wait' });
    }
    ticks.push({ tick, actions });
  }
  return ticks;
}

export function buildOrderAssignments(oracle, itemsByType, dropOff) {
  const scarcity = buildScarityTable(oracle, itemsByType);
  const usedItemIds = new Set();

  return oracle.known_orders.map((order) => {
    const counts = countByType(order.items_required);
    const allocations = [];

    const types = [...counts.entries()].sort((left, right) => {
      const leftScarcity = scarcity.get(left[0])?.ratio || 0;
      const rightScarcity = scarcity.get(right[0])?.ratio || 0;
      if (rightScarcity !== leftScarcity) {
        return rightScarcity - leftScarcity;
      }
      return left[0].localeCompare(right[0]);
    });

    for (const [type, count] of types) {
      const available = (itemsByType.get(type) || []).filter((item) => !usedItemIds.has(item.id));
      if (available.length < count) {
        throw new Error(`Not enough shelves for type ${type}`);
      }

      for (let index = 0; index < count; index += 1) {
        const item = available[index];
        usedItemIds.add(item.id);
        allocations.push({
          itemId: item.id,
          itemType: item.type,
          position: [...item.position],
          dropDistance: manhattanDistance(item.position, dropOff),
        });
      }
    }

    allocations.sort((left, right) => {
      const distanceDelta = left.dropDistance - right.dropDistance;
      if (distanceDelta !== 0) {
        return distanceDelta;
      }
      return left.itemId.localeCompare(right.itemId);
    });

    return {
      orderId: order.id,
      releaseTick: order.first_seen_tick,
      itemsRequired: [...order.items_required],
      allocations,
    };
  });
}

export function groupItemsIntoTrips(items, maxTripItems) {
  const remaining = [...items];
  const trips = [];

  while (remaining.length > 0) {
    const seed = remaining.shift();
    const tripItems = [seed];

    while (tripItems.length < maxTripItems && remaining.length > 0) {
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const distance = tripItems.reduce(
          (sum, item) => sum + manhattanDistance(item.position, candidate.position),
          0,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      tripItems.push(remaining.splice(bestIndex, 1)[0]);
    }

    trips.push(tripItems);
  }

  return trips;
}

function cloneBot(bot) {
  return {
    ...bot,
    position: [...bot.position],
    inventory: [...bot.inventory],
  };
}

function scheduleMoveSequence({
  bot,
  goals,
  startTime,
  graph,
  reservations,
  edgeReservations,
  scriptByTick,
  horizon,
  reserveGoal = true,
}) {
  const path = findPathToAnyGoal({
    graph,
    start: bot.position,
    goals,
    reservations,
    edgeReservations,
    startTime,
    horizon,
  });

  if (!path) {
    return null;
  }

  reserveTimedPath({
    path,
    startTime,
    reservations,
    edgeReservations,
    reserveGoal,
    holdGoalTicks: 0,
  });

  for (let index = 1; index < path.length; index += 1) {
    const tick = startTime + index - 1;
    setBotAction(scriptByTick, tick, bot.id, moveToAction(path[index - 1], path[index]));
  }

  bot.position = [...path[path.length - 1]];
  return startTime + path.length - 1;
}

function reservePickupTick({ bot, tick, reservations, scriptByTick, itemId }) {
  const existing = reservations.get(tick);
  if (existing?.has(encodeCoord(bot.position))) {
    return false;
  }
  reserveCell(reservations, tick, bot.position);
  setBotAction(scriptByTick, tick, bot.id, 'pick_up', itemId);
  return true;
}

function reserveDropTick({ bot, tick, reservations, scriptByTick }) {
  reserveCell(reservations, tick, bot.position);
  setBotAction(scriptByTick, tick, bot.id, 'drop_off');
  return true;
}

function chooseStagingCell({
  bot,
  stageCandidates,
  reservations,
  edgeReservations,
  startTime,
  graph,
  horizon,
}) {
  let best = null;

  for (const cell of stageCandidates) {
    const path = findPathToAnyGoal({
      graph,
      start: bot.position,
      goals: [cell],
      reservations,
      edgeReservations,
      startTime,
      horizon,
    });
    if (!path) {
      continue;
    }
    if (!best || path.length < best.path.length) {
      best = { cell, path };
    }
  }

  return best;
}

export function tryScheduleTask({
  baseBot,
  items,
  mode,
  earliestStartTick,
  latestUsefulTick,
  world,
  reservations,
  edgeReservations,
  scriptByTick,
  stagingCells,
  horizon,
  holdUntilTick = null,
}) {
  const bot = cloneBot(baseBot);
  let time = Math.max(baseBot.availableAt, earliestStartTick);
  if (time > baseBot.availableAt) {
    reserveStationaryRange(reservations, bot.position, baseBot.availableAt, time - 1);
  }

  for (const item of items) {
    const pickupCells = getPickupCells(world.graph, item.position);
    const arrivalTick = scheduleMoveSequence({
      bot,
      goals: pickupCells,
      startTime: time,
      graph: world.graph,
      reservations,
      edgeReservations,
      scriptByTick,
      horizon,
      reserveGoal: false,
    });
    if (arrivalTick === null) {
      return null;
    }
    if (!reservePickupTick({
      bot,
      tick: arrivalTick,
      reservations,
      scriptByTick,
      itemId: item.itemId,
    })) {
      return null;
    }
    bot.inventory.push(item.itemType);
    time = arrivalTick + 1;
  }

  if (mode === 'deliver') {
    const arrivalTick = scheduleMoveSequence({
      bot,
      goals: [world.dropOff],
      startTime: time,
      graph: world.graph,
      reservations,
      edgeReservations,
      scriptByTick,
      horizon,
      reserveGoal: true,
    });
    if (arrivalTick === null) {
      return null;
    }
    if (!reserveDropTick({ bot, tick: arrivalTick, reservations, scriptByTick })) {
      return null;
    }
    const deliveredItems = [...bot.inventory];
    bot.inventory = [];
    let availableAt = arrivalTick + 1;
    if (stagingCells.length > 0) {
      const stage = chooseStagingCell({
        bot,
        stageCandidates: stagingCells,
        reservations,
        edgeReservations,
        startTime: availableAt,
        graph: world.graph,
        horizon,
      });
      if (stage?.path) {
        reserveTimedPath({
          path: stage.path,
          startTime: availableAt,
          reservations,
          edgeReservations,
          reserveGoal: true,
          holdGoalTicks: 0,
        });
        for (let index = 1; index < stage.path.length; index += 1) {
          const tick = availableAt + index - 1;
          setBotAction(scriptByTick, tick, bot.id, moveToAction(stage.path[index - 1], stage.path[index]));
        }
        bot.position = [...stage.cell];
        availableAt = availableAt + stage.path.length - 1;
      }
    }
    bot.availableAt = availableAt + 1;
    baseBot.position = bot.position;
    baseBot.inventory = [];
    baseBot.availableAt = bot.availableAt;
    baseBot.heldOrderId = null;
    baseBot.heldItemIds = [];
    return {
      dropTick: arrivalTick,
      deliveredItems,
      completionTick: arrivalTick,
    };
  }

  const stage = chooseStagingCell({
    bot,
    stageCandidates: stagingCells,
    reservations,
    edgeReservations,
    startTime: time,
    graph: world.graph,
    horizon,
  });
  if (!stage) {
    return null;
  }

  reserveTimedPath({
    path: stage.path,
    startTime: time,
    reservations,
    edgeReservations,
    holdGoalTicks: 0,
  });
  for (let index = 1; index < stage.path.length; index += 1) {
    const tick = time + index - 1;
    setBotAction(scriptByTick, tick, bot.id, moveToAction(stage.path[index - 1], stage.path[index]));
  }

  const arrivalTick = time + stage.path.length - 1;
  if (holdUntilTick !== null && holdUntilTick >= arrivalTick) {
    reserveStationaryRange(reservations, stage.cell, arrivalTick, holdUntilTick);
  }
  bot.position = [...stage.cell];
  bot.availableAt = arrivalTick + 1;
  baseBot.position = bot.position;
  baseBot.inventory = [...bot.inventory];
  baseBot.availableAt = bot.availableAt;
  return {
    stageTick: arrivalTick,
    heldItems: [...bot.inventory],
  };
}

export function chooseBestBotForTrip({
  bots,
  items,
  mode,
  earliestStartTick,
  latestUsefulTick,
  world,
  reservations,
  edgeReservations,
  scriptByTick,
  stagingCells,
  horizon,
  holdUntilTick = null,
  stationaryHoldUntil = null,
}) {
  const candidates = bots
    .filter((bot) => {
      if (bot.lockedOrderId && bot.lockedOrderId !== items[0].orderId) {
        return false;
      }
      if (mode === 'deliver') {
        return bot.inventory.length === 0;
      }
      return bot.inventory.length === 0;
    })
    .map((bot) => {
      const reservationsCopy = new Map([...reservations.entries()].map(([time, set]) => [time, new Set(set)]));
      const edgeReservationsCopy = new Map([...edgeReservations.entries()].map(([time, set]) => [time, new Set(set)]));
      const scriptCopy = new Map([...scriptByTick.entries()].map(([tick, actionMap]) => [tick, new Map(actionMap)]));
      const botCopy = cloneBot(bot);
      if (stationaryHoldUntil !== null && stationaryHoldUntil >= bot.availableAt) {
        clearReservedCellRange(reservationsCopy, bot.position, bot.availableAt, stationaryHoldUntil);
      }
      const outcome = tryScheduleTask({
        baseBot: botCopy,
        items,
        mode,
        earliestStartTick,
        latestUsefulTick,
        world,
        reservations: reservationsCopy,
        edgeReservations: edgeReservationsCopy,
        scriptByTick: scriptCopy,
        stagingCells,
        horizon,
        holdUntilTick,
      });

      if (!outcome) {
        return null;
      }

      const finishTick = outcome.completionTick ?? outcome.stageTick ?? Number.POSITIVE_INFINITY;
      if (latestUsefulTick !== null && finishTick > latestUsefulTick) {
        return null;
      }
      return {
        bot,
        botState: botCopy,
        finishTick,
        reservationsCopy,
        edgeReservationsCopy,
        scriptCopy,
        outcome,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.finishTick - right.finishTick || left.bot.id - right.bot.id);

  if (candidates.length === 0) {
    return null;
  }

  const best = candidates[0];
  reservations.clear();
  for (const [time, bucket] of best.reservationsCopy.entries()) {
    reservations.set(time, bucket);
  }
  edgeReservations.clear();
  for (const [time, bucket] of best.edgeReservationsCopy.entries()) {
    edgeReservations.set(time, bucket);
  }
  scriptByTick.clear();
  for (const [tick, actionMap] of best.scriptCopy.entries()) {
    scriptByTick.set(tick, actionMap);
  }

  best.bot.position = [...best.botState.position];
  best.bot.availableAt = best.botState.availableAt;
  best.bot.inventory = [...best.botState.inventory];
  best.bot.lockedOrderId = best.botState.lockedOrderId || null;
  best.bot.heldItemIds = [...(best.botState.heldItemIds || [])];

  return best;
}

function scheduleHeldDelivery({
  bot,
  order,
  activeStartTick,
  world,
  reservations,
  edgeReservations,
  scriptByTick,
  horizon,
  stagingCells = [],
}) {
  if (!bot.lockedOrderId || bot.lockedOrderId !== order.orderId || bot.inventory.length === 0) {
    return null;
  }

  const arrivalTick = scheduleMoveSequence({
    bot,
    goals: [world.dropOff],
    startTime: Math.max(bot.availableAt, activeStartTick),
    graph: world.graph,
    reservations,
    edgeReservations,
    scriptByTick,
    horizon,
    reserveGoal: true,
  });
  if (arrivalTick === null) {
    return null;
  }

  if (!reserveDropTick({ bot, tick: arrivalTick, reservations, scriptByTick })) {
    return null;
  }
  const delivered = bot.heldItemIds
    .map((itemId) => order.allocations.find((allocation) => allocation.itemId === itemId))
    .filter(Boolean);
  bot.inventory = [];
  let availableAt = arrivalTick + 1;
  if (stagingCells.length > 0) {
    const stage = chooseStagingCell({
      bot,
      stageCandidates: stagingCells,
      reservations,
      edgeReservations,
      startTime: availableAt,
      graph: world.graph,
      horizon,
    });
    if (stage?.path) {
      reserveTimedPath({
        path: stage.path,
        startTime: availableAt,
        reservations,
        edgeReservations,
        reserveGoal: true,
        holdGoalTicks: 0,
      });
      for (let index = 1; index < stage.path.length; index += 1) {
        const tick = availableAt + index - 1;
        setBotAction(scriptByTick, tick, bot.id, moveToAction(stage.path[index - 1], stage.path[index]));
      }
      bot.position = [...stage.cell];
      availableAt = availableAt + stage.path.length - 1;
    }
  }
  bot.availableAt = availableAt + 1;
  bot.lockedOrderId = null;
  bot.heldItemIds = [];
  return {
    dropTick: arrivalTick,
    delivered,
  };
}

function buildAggregateStats(ticks) {
  let waits = 0;
  let picks = 0;
  let drops = 0;
  let tripDrops = 0;
  const carryByBot = new Map();

  for (const tick of ticks) {
    for (const action of tick.actions) {
      switch (action.action) {
        case 'wait':
          waits += 1;
          break;
        case 'pick_up':
          picks += 1;
          carryByBot.set(action.bot, (carryByBot.get(action.bot) || 0) + 1);
          break;
        case 'drop_off':
          drops += 1;
          tripDrops += carryByBot.get(action.bot) || 0;
          carryByBot.set(action.bot, 0);
          break;
        default:
          break;
      }
    }
  }

  return {
    total_waits: waits,
    total_picks: picks,
    total_drops: drops,
    average_items_per_trip: drops === 0 ? 0 : Number((tripDrops / drops).toFixed(2)),
  };
}

function expandTripsForFallback(tripItems) {
  if (tripItems.length <= 1) {
    return [tripItems];
  }
  return tripItems.map((item) => [item]);
}

function findNearestLaunchCells(graph, origin, count) {
  const queue = [origin];
  const visited = new Set([encodeCoord(origin)]);
  const cells = [];

  while (queue.length > 0 && cells.length < count) {
    const current = queue.shift();
    if (encodeCoord(current) !== encodeCoord(origin)) {
      cells.push(current);
    }
    for (const neighbor of graph.neighbors(current)) {
      const key = encodeCoord(neighbor);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      queue.push(neighbor);
    }
  }

  return cells;
}

function spreadBotsFromStacks({
  bots,
  world,
  reservations,
  edgeReservations,
  scriptByTick,
  stationaryHoldUntil,
  horizon,
}) {
  const groups = new Map();
  for (const bot of bots) {
    const key = encodeCoord(bot.position);
    const existing = groups.get(key) || [];
    existing.push(bot);
    groups.set(key, existing);
  }

  for (const [key, group] of groups.entries()) {
    if (group.length <= 1) {
      continue;
    }

    const origin = group[0].position;
    const launchCells = findNearestLaunchCells(world.graph, origin, group.length);
    for (let index = 0; index < group.length; index += 1) {
      const bot = group[index];
      const launchCell = launchCells[index] || origin;
      if (encodeCoord(launchCell) === key) {
        bot.availableAt = 0;
        continue;
      }

      const arrivalTick = scheduleMoveSequence({
        bot,
        goals: [launchCell],
        startTime: 0,
        graph: world.graph,
        reservations,
        edgeReservations,
        scriptByTick,
        horizon,
        reserveGoal: true,
      });
      if (arrivalTick === null) {
        continue;
      }
      bot.availableAt = arrivalTick + 1;
    }
  }

  for (const bot of bots) {
    reserveStationaryRange(reservations, bot.position, bot.availableAt, stationaryHoldUntil);
  }
}

export function generateOracleScript({
  oracle,
  replayPath = null,
  oracleSource = null,
  options = {},
}) {
  const settings = { ...oracleScriptDefaults, ...options };
  const normalizedOracle = normalizeOracle(oracle);
  const world = buildOracleScriptWorld({ oracle: normalizedOracle, replayPath });
  const orderPlans = buildOrderAssignments(normalizedOracle, world.itemsByType, world.dropOff)
    .map((orderPlan) => ({
      ...orderPlan,
      allocations: orderPlan.allocations.map((allocation) => ({
        ...allocation,
        orderId: orderPlan.orderId,
      })),
    }));

  const bots = world.botStartPositions.map((position, botId) => ({
    id: botId,
    position: [...position],
    availableAt: 0,
    inventory: [],
    lockedOrderId: null,
    heldItemIds: [],
  }));
  const activeBots = bots.slice(0, Math.min(settings.maxActiveBots, bots.length));
  const reservations = new Map();
  const edgeReservations = new Map();
  const scriptByTick = new Map();
  const stagingCells = buildStagingCells(world.graph, world.dropOff, settings.stagingCellCount);
  const perOrderEstimates = [];
  const scriptHorizon = Math.min(settings.targetCutoffTick, world.maxRounds - 1);
  const stationaryHoldUntil = Math.min(world.maxRounds, settings.targetCutoffTick + 4);

  spreadBotsFromStacks({
    bots: activeBots,
    world,
    reservations,
    edgeReservations,
    scriptByTick,
    stationaryHoldUntil,
    horizon: settings.horizon,
  });
  let previousCompletionTick = 0;
  let cutoffReason = null;

  for (let index = 0; index < orderPlans.length; index += 1) {
    const order = orderPlans[index];
    const activeStartTick = order.releaseTick;
    if (activeStartTick > scriptHorizon) {
      cutoffReason = 'target_cutoff_reached';
      break;
    }
    const deliveredItemIds = new Set();
    let orderCompletionTick = activeStartTick;

    const heldBots = bots
      .filter((bot) => activeBots.includes(bot))
      .filter((bot) => bot.lockedOrderId === order.orderId && bot.heldItemIds.length > 0)
      .sort((left, right) => left.availableAt - right.availableAt || left.id - right.id);

    for (const bot of heldBots) {
      const heldOutcome = scheduleHeldDelivery({
        bot,
        order,
        activeStartTick,
        world,
      reservations,
      edgeReservations,
      scriptByTick,
      horizon: settings.horizon,
      stagingCells,
      });
      if (!heldOutcome) {
        continue;
      }
      for (const delivered of heldOutcome.delivered) {
        deliveredItemIds.add(delivered.itemId);
      }
      orderCompletionTick = Math.max(orderCompletionTick, heldOutcome.dropTick);
      reserveStationaryRange(reservations, bot.position, bot.availableAt, stationaryHoldUntil);
    }

    const remainingItems = order.allocations.filter((allocation) => !deliveredItemIds.has(allocation.itemId));
    const deliveryTrips = groupItemsIntoTrips(remainingItems, settings.maxTripItems);
    let abortedForHorizon = false;

    for (const tripItems of deliveryTrips) {
      const candidateTrips = expandTripsForFallback(tripItems);
      let scheduledAny = false;
      for (const candidateItems of candidateTrips) {
        const best = chooseBestBotForTrip({
          bots: activeBots,
          items: candidateItems,
          mode: 'deliver',
          earliestStartTick: activeStartTick,
          latestUsefulTick: scriptHorizon,
          world,
          reservations,
          edgeReservations,
          scriptByTick,
          stagingCells,
          horizon: settings.horizon,
          stationaryHoldUntil,
        });

        if (!best) {
          if (tripItems.length === 1) {
            abortedForHorizon = true;
            break;
          }
          scheduledAny = false;
          break;
        }

        scheduledAny = true;
        for (const item of candidateItems) {
          deliveredItemIds.add(item.itemId);
        }
        orderCompletionTick = Math.max(orderCompletionTick, best.outcome.dropTick);
        reserveStationaryRange(reservations, best.bot.position, best.bot.availableAt, stationaryHoldUntil);
      }

      if (!scheduledAny) {
        abortedForHorizon = true;
        break;
      }
    }

    if (abortedForHorizon) {
      cutoffReason = 'target_cutoff_reached';
      break;
    }

    const nextOrder = orderPlans[index + 1];
    const previewTrips = [];
    if (nextOrder && nextOrder.releaseTick <= orderCompletionTick) {
      const nextRemaining = nextOrder.allocations.filter((allocation) => {
        return !bots.some((bot) => bot.heldItemIds.includes(allocation.itemId));
      });
      const potentialTrips = groupItemsIntoTrips(nextRemaining, settings.maxTripItems);
      const previewTripLimit = Math.min(
        settings.previewRunnerCap,
        Math.ceil(settings.previewItemCap / settings.maxTripItems),
        potentialTrips.length,
      );
      previewTrips.push(...potentialTrips.slice(0, previewTripLimit));
    }

    for (const tripItems of previewTrips) {
      const previewReleaseTick = nextOrder.releaseTick;
      for (const candidateItems of expandTripsForFallback(tripItems)) {
        const best = chooseBestBotForTrip({
          bots: activeBots,
          items: candidateItems,
          mode: 'stage',
          earliestStartTick: previewReleaseTick,
          latestUsefulTick: Math.min(orderCompletionTick, scriptHorizon),
          world,
          reservations,
          edgeReservations,
          scriptByTick,
          stagingCells,
          horizon: settings.horizon,
          holdUntilTick: orderCompletionTick + 2,
          stationaryHoldUntil,
        });
        if (!best) {
          continue;
        }

        best.bot.lockedOrderId = nextOrder.orderId;
        best.bot.heldItemIds = candidateItems.map((item) => item.itemId);
        best.bot.inventory = candidateItems.map((item) => item.itemType);
        reserveStationaryRange(reservations, best.bot.position, best.bot.availableAt, stationaryHoldUntil);
      }
    }

    perOrderEstimates.push({
      order_id: order.orderId,
      planned_completion_tick: orderCompletionTick,
      assigned_shelf_ids: order.allocations.map((allocation) => allocation.itemId),
    });
    previousCompletionTick = orderCompletionTick + 1;

    if (previousCompletionTick > settings.targetCutoffTick && index < orderPlans.length - 1) {
      cutoffReason = 'target_cutoff_reached';
      break;
    }
  }

  const lastScriptedTick = Math.min(scriptHorizon, Math.max(
    -1,
    ...[...scriptByTick.keys()],
  ));
  const ticks = finalizeScriptTicks(scriptByTick, normalizedOracle.bot_count, Math.max(0, lastScriptedTick))
    .filter((tick) => tick.tick <= scriptHorizon);
  const evaluation = evaluateOracleScript({
    oracle: normalizedOracle,
    script: { ticks },
    replayPath,
    maxTripItems: settings.maxTripItems,
  });

  if (settings.validate !== false && !evaluation.valid) {
    throw new Error(`Generated script failed validation at tick ${evaluation.invalid.tick}: ${evaluation.invalid.reason}`);
  }

  const emittedTicks = evaluation.sanitizedTicks?.length ? evaluation.sanitizedTicks : ticks;
  const emittedAggregate = buildAggregateStats(emittedTicks);
  return {
    description: `Oracle-optimized script for ${normalizedOracle.difficulty}`,
    bot_count: normalizedOracle.bot_count,
    generated_at: new Date().toISOString(),
    oracle_source: oracleSource,
    orders_covered: evaluation.ordersCovered,
    estimated_score: evaluation.finalScore,
    last_scripted_tick: evaluation.lastScriptedTick,
    cutoff_reason: cutoffReason || (evaluation.ordersCovered === normalizedOracle.known_orders.length
      ? 'oracle_orders_completed'
      : evaluation.lastScriptedTick >= settings.targetCutoffTick
        ? 'target_cutoff_reached'
        : 'schedule_exhausted'),
    per_order_estimates: perOrderEstimates,
    aggregate_efficiency: emittedAggregate,
    evaluation,
    ticks: emittedTicks,
  };
}
