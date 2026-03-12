import { encodeCoord, manhattanDistance, moveToAction } from '../utils/coords.mjs';
import { evaluateOracleScript } from './oracle-script-evaluator.mjs';
import {
  buildOracleScriptWorld,
  normalizeOracle,
} from './oracle-script-world.mjs';

function findPath(graph, start, goals, startTime, reservations, horizon = 60) {
  const goalSet = new Set(goals.map((goal) => encodeCoord(goal)));
  if (goalSet.has(encodeCoord(start))) {
    return [start];
  }

  function heuristic(position) {
    let best = Number.POSITIVE_INFINITY;
    for (const goal of goals) {
      best = Math.min(best, manhattanDistance(position, goal));
    }
    return best;
  }

  const open = [{ coord: start, time: startTime, g: 0, f: heuristic(start), parent: null }];
  const best = new Map([[`${encodeCoord(start)}@${startTime}`, 0]]);

  while (open.length > 0) {
    let bestIndex = 0;
    for (let index = 1; index < open.length; index += 1) {
      const candidate = open[index];
      const currentBest = open[bestIndex];
      if (candidate.f < currentBest.f || (candidate.f === currentBest.f && candidate.g > currentBest.g)) {
        bestIndex = index;
      }
    }

    const current = open[bestIndex];
    open[bestIndex] = open[open.length - 1];
    open.pop();

    if (goalSet.has(encodeCoord(current.coord))) {
      const path = [];
      let node = current;
      while (node) {
        path.push(node.coord);
        node = node.parent;
      }
      return path.reverse();
    }

    if (current.g >= horizon) {
      continue;
    }

    const nextTime = current.time + 1;
    for (const next of [current.coord, ...graph.neighbors(current.coord)]) {
      const nextKey = encodeCoord(next);
      if (reservations.has(nextTime) && reservations.get(nextTime).has(nextKey)) {
        continue;
      }
      const nextG = current.g + 1;
      const stateKey = `${nextKey}@${nextTime}`;
      if ((best.get(stateKey) ?? Number.POSITIVE_INFINITY) <= nextG) {
        continue;
      }
      best.set(stateKey, nextG);
      open.push({
        coord: next,
        time: nextTime,
        g: nextG,
        f: nextG + heuristic(next),
        parent: current,
      });
    }
  }

  return null;
}

function reserveSlots(path, startTime, reservations, holdTicks = 2) {
  for (let index = 0; index < path.length; index += 1) {
    const tick = startTime + index;
    const key = encodeCoord(path[index]);
    if (!reservations.has(tick)) {
      reservations.set(tick, new Set());
    }
    reservations.get(tick).add(key);
  }

  const goalKey = encodeCoord(path[path.length - 1]);
  const end = startTime + path.length - 1;
  for (let offset = 1; offset <= holdTicks; offset += 1) {
    const tick = end + offset;
    if (!reservations.has(tick)) {
      reservations.set(tick, new Set());
    }
    reservations.get(tick).add(goalKey);
  }
}

function totalMap(map) {
  let total = 0;
  for (const value of map.values()) {
    total += value;
  }
  return total;
}

function countItems(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return counts;
}

function buildAction(botId, action, itemId = null) {
  const entry = { bot: botId, action };
  if (itemId) {
    entry.item_id = itemId;
  }
  return entry;
}

function choosePlannableOrderIndexes(oracle, currentOrderIndex, prefetchDepth) {
  const indexes = [];
  if (currentOrderIndex < oracle.known_orders.length) {
    indexes.push(currentOrderIndex);
  }
  for (let depth = 1; depth <= prefetchDepth; depth += 1) {
    const candidateIndex = currentOrderIndex + depth;
    if (candidateIndex >= oracle.known_orders.length) {
      break;
    }
    indexes.push(candidateIndex);
  }
  return indexes;
}

function rankLegacyScript(left, right) {
  if (right.orders_covered !== left.orders_covered) {
    return right.orders_covered - left.orders_covered;
  }
  if (right.estimated_score !== left.estimated_score) {
    return right.estimated_score - left.estimated_score;
  }
  if (left.last_scripted_tick !== right.last_scripted_tick) {
    return left.last_scripted_tick - right.last_scripted_tick;
  }
  return (left.aggregate_efficiency?.total_waits || 0) - (right.aggregate_efficiency?.total_waits || 0);
}

export function buildLegacyOracleScript({
  oracle,
  replayPath = null,
  oracleSource = null,
  options = {},
}) {
  const settings = {
    maxTripItems: 2,
    prefetchDepth: 1,
    pathHorizon: 60,
    pickupHoldTicks: 2,
    dropHoldTicks: 1,
    targetCutoffTick: 299,
    ...options,
  };

  const normalizedOracle = normalizeOracle(oracle);
  const world = buildOracleScriptWorld({ oracle: normalizedOracle, replayPath });
  const dropOff = world.dropOff;
  const dropOffKey = encodeCoord(dropOff);
  const botCount = normalizedOracle.bot_count;
  const maxRounds = world.maxRounds;
  const scriptLimitTick = Math.min(settings.targetCutoffTick, maxRounds - 1);

  const itemsByType = new Map();
  for (const [type, list] of world.itemsByType.entries()) {
    itemsByType.set(type, [...list]);
  }

  const bots = world.botStartPositions.map((position, botId) => ({
    id: botId,
    pos: [...position],
    inventory: [],
    pickQueue: [],
    delivering: false,
    path: null,
  }));
  const usedShelves = new Set();
  const reservations = new Map();
  const script = [];

  let score = 0;
  let ordersCompleted = 0;
  let currentOrderIdx = 0;
  let delivered = [];

  function remainingDemand(orderIdx = currentOrderIdx) {
    if (orderIdx >= normalizedOracle.known_orders.length) {
      return new Map();
    }
    const need = countItems(normalizedOracle.known_orders[orderIdx].items_required);
    if (orderIdx === currentOrderIdx) {
      for (const type of delivered) {
        if ((need.get(type) || 0) > 0) {
          need.set(type, need.get(type) - 1);
        }
      }
    }
    return need;
  }

  function findShelf(type) {
    for (const item of itemsByType.get(type) || []) {
      if (!usedShelves.has(item.id)) {
        return item;
      }
    }
    return null;
  }

  function planPickupBatches(orderIdx, priority) {
    if (orderIdx >= normalizedOracle.known_orders.length) {
      return [];
    }

    const need = remainingDemand(orderIdx);
    for (const bot of bots) {
      for (const queued of bot.pickQueue) {
        if (queued.targetOrderIdx === orderIdx) {
          const current = need.get(queued.itemType) || 0;
          if (current > 0) {
            need.set(queued.itemType, current - 1);
          }
        }
      }
      if (orderIdx === currentOrderIdx) {
        for (const type of bot.inventory) {
          const current = need.get(type) || 0;
          if (current > 0) {
            need.set(type, current - 1);
          }
        }
      }
    }

    const shelves = [];
    for (const [type, count] of need.entries()) {
      for (let index = 0; index < count; index += 1) {
        const shelf = findShelf(type);
        if (!shelf) {
          continue;
        }
        shelves.push({
          shelfPos: shelf.position,
          itemId: shelf.id,
          itemType: type,
          priority,
          targetOrderIdx: orderIdx,
        });
        usedShelves.add(shelf.id);
      }
    }
    return shelves;
  }

  function assignShelvesToBots(shelves) {
    const sorted = [...shelves].sort((left, right) => (
      manhattanDistance(left.shelfPos, dropOff) - manhattanDistance(right.shelfPos, dropOff)
    ));

    const used = new Set();
    while (used.size < sorted.length) {
      const firstUnused = sorted.find((_, index) => !used.has(index));
      if (!firstUnused) {
        break;
      }

      let bestBot = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const bot of bots) {
        if (bot.pickQueue.length > 0 || bot.delivering) {
          continue;
        }
        if (bot.inventory.length >= settings.maxTripItems) {
          continue;
        }
        const distance = manhattanDistance(bot.pos, firstUnused.shelfPos);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestBot = bot;
        }
      }

      if (!bestBot) {
        break;
      }

      const capacity = settings.maxTripItems - bestBot.inventory.length;
      const batch = [];
      const remaining = sorted
        .map((shelf, index) => ({ ...shelf, idx: index }))
        .filter((candidate) => !used.has(candidate.idx))
        .sort((left, right) => (
          manhattanDistance(bestBot.pos, left.shelfPos) - manhattanDistance(bestBot.pos, right.shelfPos)
        ));

      for (const candidate of remaining) {
        if (batch.length >= capacity) {
          break;
        }
        batch.push(candidate);
        used.add(candidate.idx);
      }

      const ordered = [];
      let cursor = bestBot.pos;
      const batchCopy = [...batch];
      while (batchCopy.length > 0) {
        let bestIndex = 0;
        let bestDistanceToCursor = Number.POSITIVE_INFINITY;
        for (let index = 0; index < batchCopy.length; index += 1) {
          const distance = manhattanDistance(cursor, batchCopy[index].shelfPos);
          if (distance < bestDistanceToCursor) {
            bestDistanceToCursor = distance;
            bestIndex = index;
          }
        }
        ordered.push(batchCopy.splice(bestIndex, 1)[0]);
        cursor = ordered[ordered.length - 1].shelfPos;
      }

      bestBot.pickQueue = ordered;
    }
  }

  const initialVisible = choosePlannableOrderIndexes(normalizedOracle, 0, settings.prefetchDepth)
    .flatMap((orderIndex, index) => planPickupBatches(orderIndex, index === 0 ? 'active' : 'prefetch'));
  assignShelvesToBots(initialVisible);

  for (let tick = 0; tick <= scriptLimitTick; tick += 1) {
    for (const [reservedTick] of reservations) {
      if (reservedTick < tick) {
        reservations.delete(reservedTick);
      }
    }

    if (currentOrderIdx < normalizedOracle.known_orders.length) {
      const need = remainingDemand();
      if (totalMap(need) === 0) {
        score += 5;
        ordersCompleted += 1;
        currentOrderIdx += 1;
        delivered = [];

        for (const bot of bots) {
          for (const queued of bot.pickQueue) {
            if (queued.priority !== 'active') {
              queued.priority = 'active';
            }
          }
        }

        const visibleIndexes = choosePlannableOrderIndexes(
          normalizedOracle,
          currentOrderIdx,
          settings.prefetchDepth,
        );
        const newShelves = visibleIndexes.flatMap((orderIndex, index) => (
          planPickupBatches(orderIndex, index === 0 ? 'active' : 'prefetch')
        ));
        assignShelvesToBots(newShelves);
      }
    }

    const visibleIndexes = choosePlannableOrderIndexes(
      normalizedOracle,
      currentOrderIdx,
      settings.prefetchDepth,
    );
    const pendingShelves = visibleIndexes.flatMap((orderIndex, index) => (
      planPickupBatches(orderIndex, index === 0 ? 'active' : 'prefetch')
    ));
    if (pendingShelves.length > 0) {
      assignShelvesToBots(pendingShelves);
    }

    for (const bot of bots) {
      if (bot.pickQueue.length === 0 && !bot.delivering && bot.inventory.length > 0) {
        bot.delivering = true;
        bot.path = null;
      }
    }

    for (const bot of bots) {
      if (bot.path && bot.path.length > 1) {
        continue;
      }

      if (bot.pickQueue.length > 0) {
        const target = bot.pickQueue[0];
        const adjacent = world.graph.neighbors(target.shelfPos);
        if (adjacent.some((coord) => encodeCoord(coord) === encodeCoord(bot.pos))) {
          bot.path = [bot.pos];
        } else {
          const path = findPath(world.graph, bot.pos, adjacent, tick, reservations, settings.pathHorizon);
          if (path) {
            reserveSlots(path, tick, reservations, settings.pickupHoldTicks);
            bot.path = path;
          } else {
            bot.path = [bot.pos];
          }
        }
      } else if (bot.delivering) {
        if (encodeCoord(bot.pos) === dropOffKey) {
          bot.path = [bot.pos];
        } else {
          const path = findPath(world.graph, bot.pos, [dropOff], tick, reservations, settings.pathHorizon);
          if (path) {
            reserveSlots(path, tick, reservations, settings.dropHoldTicks);
            bot.path = path;
          } else {
            bot.path = [bot.pos];
          }
        }
      }
    }

    const tickActions = [];
    for (const bot of bots) {
      let action = 'wait';
      let itemId = null;

      if (bot.pickQueue.length > 0) {
        const target = bot.pickQueue[0];
        const adjacent = world.graph.neighbors(target.shelfPos);
        if (adjacent.some((coord) => encodeCoord(coord) === encodeCoord(bot.pos))) {
          action = 'pick_up';
          itemId = target.itemId;
          bot.inventory.push(target.itemType);
          bot.pickQueue.shift();
          bot.path = null;
        } else if (bot.path && bot.path.length > 1) {
          action = moveToAction(bot.path[0], bot.path[1]);
          bot.pos = [...bot.path[1]];
          bot.path = bot.path.slice(1);
        }
      } else if (bot.delivering) {
        if (encodeCoord(bot.pos) === dropOffKey) {
          action = 'drop_off';
          if (currentOrderIdx < normalizedOracle.known_orders.length) {
            const need = remainingDemand();
            for (const type of bot.inventory) {
              if ((need.get(type) || 0) > 0) {
                delivered.push(type);
                need.set(type, need.get(type) - 1);
                score += 1;
              }
            }
          }
          bot.inventory = [];
          bot.delivering = false;
          bot.path = null;
        } else if (bot.path && bot.path.length > 1) {
          action = moveToAction(bot.path[0], bot.path[1]);
          bot.pos = [...bot.path[1]];
          bot.path = bot.path.slice(1);
        }
      }

      tickActions.push(buildAction(bot.id, action, itemId));
    }

    script.push({ tick, actions: tickActions });
  }

  const evaluation = evaluateOracleScript({
    oracle: normalizedOracle,
    script: { ticks: script },
    replayPath,
    maxTripItems: settings.maxTripItems,
  });
  const ticks = evaluation.sanitizedTicks?.length ? evaluation.sanitizedTicks : script;
  const perOrderEstimates = evaluation.perOrder
    .filter((order) => order.complete)
    .map((order) => {
      const plan = normalizedOracle.known_orders.find((candidate) => candidate.id === order.id);
      return {
        order_id: order.id,
        planned_completion_tick: order.completionTick,
        assigned_shelf_ids: [],
        size: plan?.items_required?.length || 0,
      };
    });

  return {
    description: `Legacy oracle script for ${normalizedOracle.difficulty}`,
    strategy: 'legacy',
    settings,
    bot_count: botCount,
    generated_at: new Date().toISOString(),
    oracle_source: oracleSource,
    orders_covered: evaluation.ordersCovered,
    estimated_score: evaluation.finalScore,
    last_scripted_tick: evaluation.lastScriptedTick,
    cutoff_reason: evaluation.lastScriptedTick >= scriptLimitTick ? 'target_cutoff_reached' : 'schedule_exhausted',
    per_order_estimates: perOrderEstimates,
    aggregate_efficiency: {
      total_waits: evaluation.waitActions,
      total_picks: evaluation.pickActions,
      total_drops: evaluation.dropActions,
      average_items_per_trip: evaluation.dropActions > 0 ? Number((evaluation.pickActions / evaluation.dropActions).toFixed(2)) : 0,
    },
    evaluation,
    ticks,
  };
}

export function chooseBestLegacyVariant(candidates) {
  return [...candidates].sort(rankLegacyScript)[0] || null;
}
