import fs from 'node:fs';
import path from 'node:path';

export class ReplayLogger {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.closeSync(fs.openSync(filePath, 'a'));
  }

  log(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  close() {
    // Synchronous append writes are already flushed.
  }
}

function parseJsonl(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function activeOrderId(snapshot) {
  if (!snapshot?.orders || !Array.isArray(snapshot.orders)) {
    return null;
  }

  const active = snapshot.orders.find((order) => order.status === 'active');
  return active?.id ?? null;
}

export function summarizeReplay(filePath) {
  const rows = parseJsonl(filePath);
  const ticksRows = rows.filter((row) => row.type === 'tick');

  let ticks = 0;
  let finalScore = 0;
  let ordersCompleted = 0;
  let itemsDelivered = 0;
  let totalStalls = 0;
  let derivedOrdersCompleted = 0;
  let derivedItemsDelivered = 0;
  let previousTick = null;

  for (const row of ticksRows) {
    ticks += 1;
    totalStalls += row.planner_metrics?.stalls || row.planner_metrics?.stalledBots || 0;
    finalScore = row.state_snapshot?.score ?? finalScore;

    if (previousTick) {
      const previousScore = previousTick.state_snapshot?.score ?? 0;
      const currentScore = row.state_snapshot?.score ?? previousScore;
      const deltaScore = currentScore - previousScore;

      if (deltaScore > 0) {
        const prevActive = activeOrderId(previousTick.state_snapshot);
        const currentActive = activeOrderId(row.state_snapshot);
        const completedOrder = prevActive && currentActive && prevActive !== currentActive;
        const completionBonus = completedOrder ? 5 : 0;
        const deliveredItems = Math.max(0, deltaScore - completionBonus);

        if (completedOrder) {
          derivedOrdersCompleted += 1;
        }

        derivedItemsDelivered += deliveredItems;
      }
    }

    previousTick = row;
  }

  for (const row of rows) {
    if (row.type === 'game_over') {
      finalScore = row.final_score ?? row.score ?? finalScore;
      ordersCompleted = row.orders_completed ?? row.orders ?? ordersCompleted;
      itemsDelivered = row.items_delivered ?? row.items ?? itemsDelivered;
    }
  }

  if (!Number.isFinite(ordersCompleted) || ordersCompleted === 0) {
    ordersCompleted = derivedOrdersCompleted;
  }

  if (!Number.isFinite(itemsDelivered) || itemsDelivered === 0) {
    itemsDelivered = derivedItemsDelivered;
  }

  return {
    ticks,
    finalScore,
    ordersCompleted,
    itemsDelivered,
    totalStalls,
  };
}

function toActionMap(actions) {
  const map = new Map();
  for (const action of actions || []) {
    map.set(action.bot, action.action);
  }

  return map;
}

export function simulateReplayAgainstObserved(filePath, planner) {
  const rows = parseJsonl(filePath);
  const ticks = rows.filter((row) => row.type === 'tick');

  let compared = 0;
  let matches = 0;
  let waits = 0;

  for (const tick of ticks) {
    if (!tick.state_snapshot) {
      continue;
    }

    const expected = planner.plan(tick.state_snapshot);
    const expectedMap = toActionMap(expected);
    const actualMap = toActionMap(tick.actions_sent || []);

    for (const [botId, action] of actualMap.entries()) {
      compared += 1;
      if (expectedMap.get(botId) === action) {
        matches += 1;
      }

      if (action === 'wait') {
        waits += 1;
      }
    }
  }

  const matchRatio = compared === 0 ? 0 : matches / compared;
  const waitRatio = compared === 0 ? 0 : waits / compared;

  return {
    compared,
    matches,
    matchRatio,
    waitRatio,
    projectedScore: matchRatio * 100 - waitRatio * 10,
  };
}
