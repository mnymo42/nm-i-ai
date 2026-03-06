import fs from 'node:fs';

import { encodeCoord } from './coords.mjs';
import { GridGraph } from './grid-graph.mjs';
import { findTimeAwarePath } from './routing.mjs';

function parseJsonl(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function typeCounts(items) {
  const counts = new Map();
  for (const item of items || []) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }

  return counts;
}

function countsKey(counts) {
  return Array.from(counts.entries())
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}:${count}`)
    .join('|');
}

function parseOrderIndex(orderId) {
  if (typeof orderId !== 'string') {
    return Number.POSITIVE_INFINITY;
  }

  const match = orderId.match(/(\d+)$/);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }

  return Number(match[1]);
}

function buildObservedReplayModel(rows) {
  const ticks = rows.filter((row) => row.type === 'tick' && row.state_snapshot);
  if (ticks.length === 0) {
    throw new Error('Replay has no tick rows with state snapshots');
  }

  const initialState = ticks[0].state_snapshot;
  const maxRounds = Number(initialState.max_rounds) || ticks.length;
  const orderById = new Map();
  const activeSequence = [];
  let previousActiveId = null;

  for (const row of ticks) {
    const state = row.state_snapshot;
    for (const order of state.orders || []) {
      if (!orderById.has(order.id)) {
        orderById.set(order.id, {
          id: order.id,
          itemsRequired: [...(order.items_required || [])],
        });
      }
    }

    const active = (state.orders || []).find((order) => order.status === 'active' && !order.complete);
    if (active && active.id !== previousActiveId) {
      activeSequence.push(active.id);
      previousActiveId = active.id;
    }
  }

  const knownQueue = activeSequence
    .map((orderId) => orderById.get(orderId))
    .filter(Boolean);
  const observedOrders = Array.from(orderById.values()).sort((a, b) => {
    const indexDiff = parseOrderIndex(a.id) - parseOrderIndex(b.id);
    if (indexDiff !== 0) {
      return indexDiff;
    }

    return String(a.id).localeCompare(String(b.id));
  });

  return {
    ticks,
    initialState,
    maxRounds,
    knownQueue,
    observedOrders,
  };
}

function buildGraphContext(initialState) {
  const shelfWalls = (initialState.items || []).map((item) => item.position);
  const graph = new GridGraph({
    ...initialState.grid,
    walls: [...(initialState.grid?.walls || []), ...shelfWalls],
  });

  const shelvesByType = new Map();
  for (const item of initialState.items || []) {
    const current = shelvesByType.get(item.type) || [];
    current.push(item);
    shelvesByType.set(item.type, current);
  }

  return {
    graph,
    dropOff: initialState.drop_off,
    shelvesByType,
  };
}

function permutations(values) {
  const sorted = [...values].sort();
  const used = new Array(sorted.length).fill(false);
  const result = [];
  const path = [];

  function visit() {
    if (path.length === sorted.length) {
      result.push([...path]);
      return;
    }

    let lastValue = null;
    for (let index = 0; index < sorted.length; index += 1) {
      if (used[index]) {
        continue;
      }

      const value = sorted[index];
      if (value === lastValue) {
        continue;
      }

      used[index] = true;
      path.push(value);
      visit();
      path.pop();
      used[index] = false;
      lastValue = value;
    }
  }

  visit();
  return result;
}

function enumerateBatches(remainingCounts, maxBatchSize = 3) {
  const entries = Array.from(remainingCounts.entries()).filter(([, count]) => count > 0);
  const batches = [];
  const current = new Map();

  function dfs(index, used) {
    if (used > 0) {
      batches.push(new Map(current));
    }

    if (used >= maxBatchSize || index >= entries.length) {
      return;
    }

    const [type, maxCount] = entries[index];
    for (let count = 0; count <= Math.min(maxCount, maxBatchSize - used); count += 1) {
      if (count > 0) {
        current.set(type, count);
      } else {
        current.delete(type);
      }

      dfs(index + 1, used + count);
    }

    current.delete(type);
  }

  dfs(0, 0);

  return batches.filter((batch) => Array.from(batch.values()).reduce((sum, count) => sum + count, 0) > 0);
}

function subtractCounts(base, delta) {
  const next = new Map(base);
  for (const [type, count] of delta.entries()) {
    next.set(type, Math.max(0, (next.get(type) || 0) - count));
  }

  return next;
}

function totalCount(counts) {
  return Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
}

function createDistanceSolver(graph, horizon) {
  const cache = new Map();

  return function distance(start, goal) {
    const cacheKey = `${encodeCoord(start)}>${encodeCoord(goal)}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const path = findTimeAwarePath({
      graph,
      start,
      goal,
      reservations: new Map(),
      edgeReservations: new Map(),
      startTime: 0,
      horizon,
    });

    const dist = path ? Math.max(0, path.length - 1) : Number.POSITIVE_INFINITY;
    cache.set(cacheKey, dist);
    return dist;
  };
}

function expandCountsToTypes(counts) {
  const items = [];
  for (const [type, count] of counts.entries()) {
    for (let index = 0; index < count; index += 1) {
      items.push(type);
    }
  }

  return items;
}

function createTripCostEstimator({ graph, dropOff, shelvesByType, horizon }) {
  const dist = createDistanceSolver(graph, horizon);
  const tripCostCache = new Map();

  function movementForSequence(typeSequence) {
    let states = new Map([[encodeCoord(dropOff), { coord: dropOff, cost: 0 }]]);

    for (const type of typeSequence) {
      const shelves = shelvesByType.get(type) || [];
      if (shelves.length === 0) {
        return Number.POSITIVE_INFINITY;
      }

      const nextStates = new Map();

      for (const { coord, cost } of states.values()) {
        for (const shelf of shelves) {
          for (const adjacent of graph.adjacentWalkableCells(shelf.position)) {
            const stepCost = dist(coord, adjacent);
            if (!Number.isFinite(stepCost)) {
              continue;
            }

            const total = cost + stepCost;
            const key = encodeCoord(adjacent);
            const existing = nextStates.get(key);
            if (!existing || total < existing.cost) {
              nextStates.set(key, { coord: adjacent, cost: total });
            }
          }
        }
      }

      states = nextStates;
      if (states.size === 0) {
        return Number.POSITIVE_INFINITY;
      }
    }

    let bestMovement = Number.POSITIVE_INFINITY;
    for (const { coord, cost } of states.values()) {
      const toDrop = dist(coord, dropOff);
      if (!Number.isFinite(toDrop)) {
        continue;
      }

      bestMovement = Math.min(bestMovement, cost + toDrop);
    }

    return bestMovement;
  }

  return function tripCost(batchCounts) {
    const key = countsKey(batchCounts);
    if (tripCostCache.has(key)) {
      return tripCostCache.get(key);
    }

    const picks = expandCountsToTypes(batchCounts);
    const orderings = permutations(picks);

    let best = Number.POSITIVE_INFINITY;
    for (const ordering of orderings) {
      const movement = movementForSequence(ordering);
      if (!Number.isFinite(movement)) {
        continue;
      }

      const total = movement + ordering.length + 1;
      best = Math.min(best, total);
    }

    tripCostCache.set(key, best);
    return best;
  };
}

function createOrderEvaluators({ tripCost }) {
  const completionMemo = new Map();
  const partialMemo = new Map();

  function minCompletionRounds(orderCounts) {
    const key = countsKey(orderCounts);
    if (completionMemo.has(key)) {
      return completionMemo.get(key);
    }

    if (totalCount(orderCounts) === 0) {
      return 0;
    }

    let best = Number.POSITIVE_INFINITY;
    for (const batch of enumerateBatches(orderCounts, 3)) {
      const cost = tripCost(batch);
      if (!Number.isFinite(cost)) {
        continue;
      }

      const nextCounts = subtractCounts(orderCounts, batch);
      const remainder = minCompletionRounds(nextCounts);
      if (!Number.isFinite(remainder)) {
        continue;
      }

      best = Math.min(best, cost + remainder);
    }

    completionMemo.set(key, best);
    return best;
  }

  function maxItemsWithinRounds(orderCounts, roundsLeft) {
    const key = `${countsKey(orderCounts)}@${roundsLeft}`;
    if (partialMemo.has(key)) {
      return partialMemo.get(key);
    }

    let bestItems = 0;
    for (const batch of enumerateBatches(orderCounts, 3)) {
      const cost = tripCost(batch);
      if (!Number.isFinite(cost) || cost > roundsLeft) {
        continue;
      }

      const delivered = totalCount(batch);
      const remaining = subtractCounts(orderCounts, batch);
      const candidate = delivered + maxItemsWithinRounds(remaining, roundsLeft - cost);
      bestItems = Math.max(bestItems, candidate);
    }

    partialMemo.set(key, bestItems);
    return bestItems;
  }

  return {
    minCompletionRounds,
    maxItemsWithinRounds,
  };
}

function simulateKnownQueue({ knownQueue, maxRounds, minCompletionRounds, maxItemsWithinRounds }) {
  let roundsUsed = 0;
  let score = 0;
  let completedOrders = 0;
  let deliveredItems = 0;
  let partialOrderId = null;
  let partialItems = 0;

  for (const order of knownQueue) {
    const counts = typeCounts(order.itemsRequired);
    const itemCount = totalCount(counts);
    const completionRounds = minCompletionRounds(counts);

    if (!Number.isFinite(completionRounds)) {
      break;
    }

    if (roundsUsed + completionRounds <= maxRounds) {
      roundsUsed += completionRounds;
      completedOrders += 1;
      deliveredItems += itemCount;
      score += itemCount + 5;
      continue;
    }

    const remainingRounds = maxRounds - roundsUsed;
    partialItems = maxItemsWithinRounds(counts, remainingRounds);
    if (partialItems > 0) {
      partialOrderId = order.id;
      deliveredItems += partialItems;
      score += partialItems;
      roundsUsed = maxRounds;
    }
    break;
  }

  return {
    score,
    roundsUsed,
    roundsRemaining: Math.max(0, maxRounds - roundsUsed),
    completedOrders,
    deliveredItems,
    partialOrderId,
    partialItems,
  };
}

function optimisticOrderMixUpperBound({ observedOrders, maxRounds, minCompletionRounds }) {
  const options = observedOrders
    .map((order) => {
      const counts = typeCounts(order.itemsRequired);
      const rounds = minCompletionRounds(counts);
      const items = totalCount(counts);
      const score = items + 5;

      return {
        id: order.id,
        rounds,
        score,
        items,
      };
    })
    .filter((option) => Number.isFinite(option.rounds) && option.rounds > 0);

  if (options.length === 0) {
    return {
      score: 0,
      roundsUsed: 0,
      bestScorePerRound: 0,
      chosenOrderId: null,
    };
  }

  const dp = Array.from({ length: maxRounds + 1 }, () => 0);
  for (let round = 0; round <= maxRounds; round += 1) {
    for (const option of options) {
      const nextRound = round + option.rounds;
      if (nextRound > maxRounds) {
        continue;
      }

      dp[nextRound] = Math.max(dp[nextRound], dp[round] + option.score);
    }
  }

  const bestScore = Math.max(...dp);
  const roundsUsed = dp.indexOf(bestScore);
  const bestOption = options.reduce((best, option) => (
    option.score / option.rounds > best.score / best.rounds ? option : best
  ));

  return {
    score: bestScore,
    roundsUsed,
    bestScorePerRound: bestOption.score / bestOption.rounds,
    chosenOrderId: bestOption.id,
  };
}

export function estimateMaxScoreFromReplay(filePath) {
  const rows = parseJsonl(filePath);
  const {
    initialState,
    maxRounds,
    knownQueue,
    observedOrders,
  } = buildObservedReplayModel(rows);
  const {
    graph,
    dropOff,
    shelvesByType,
  } = buildGraphContext(initialState);

  const horizon = Math.max(32, graph.width * graph.height);
  const tripCost = createTripCostEstimator({
    graph,
    dropOff,
    shelvesByType,
    horizon,
  });
  const evaluators = createOrderEvaluators({ tripCost });
  const queueBound = simulateKnownQueue({
    knownQueue,
    maxRounds,
    minCompletionRounds: evaluators.minCompletionRounds,
    maxItemsWithinRounds: evaluators.maxItemsWithinRounds,
  });
  const optimistic = optimisticOrderMixUpperBound({
    observedOrders,
    maxRounds,
    minCompletionRounds: evaluators.minCompletionRounds,
  });

  return {
    maxRounds,
    knownQueueOrders: knownQueue.length,
    observedOrders: observedOrders.length,
    queueBound: {
      score: queueBound.score,
      completedOrders: queueBound.completedOrders,
      deliveredItems: queueBound.deliveredItems,
      roundsUsed: queueBound.roundsUsed,
      roundsRemaining: queueBound.roundsRemaining,
      partialOrderId: queueBound.partialOrderId,
      partialItems: queueBound.partialItems,
    },
    optimisticOrderMixUpperBound: optimistic,
    targetRange: {
      conservative: queueBound.score,
      optimistic: optimistic.score,
    },
    assumptions: [
      'Single-bot model with infinite shelf stock and static map walls.',
      'Movement uses shortest paths without collisions or server lag.',
      'Queue bound only uses active-order sequence observed in the replay.',
      'Optimistic bound allows repeating best observed order efficiencies.',
    ],
  };
}
