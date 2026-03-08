import { extractLayout, parseJsonl, rebuildSnapshot } from './replay-io.mjs';

function snapshotRows(replayPath) {
  const rows = parseJsonl(replayPath);
  const layout = extractLayout(rows);
  return rows
    .filter((row) => row.type === 'tick')
    .map((row) => ({
      ...row,
      state_snapshot: rebuildSnapshot(row.state_snapshot, layout),
    }));
}

function deriveCompletionSequence(rows) {
  const seenOrders = new Map();
  const completions = [];
  const botActivity = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const nextRow = rows[index + 1];
    for (const order of row.state_snapshot.orders || []) {
      if (!seenOrders.has(order.id)) {
        seenOrders.set(order.id, {
          orderId: order.id,
          releaseTick: row.tick,
          completionTick: null,
        });
      }
    }

    for (const action of row.actions_sent || []) {
      if (action.action !== 'wait') {
        botActivity.add(action.bot);
      }
    }

    if (!nextRow) {
      continue;
    }

    const currentOrders = new Map((row.state_snapshot.orders || []).map((order) => [order.id, order]));
    const nextOrders = new Map((nextRow.state_snapshot.orders || []).map((order) => [order.id, order]));
    for (const [orderId, currentOrder] of currentOrders.entries()) {
      const nextOrder = nextOrders.get(orderId);
      const currentComplete = currentOrder.complete || currentOrder.status === 'complete';
      const nextComplete = nextOrder?.complete || nextOrder?.status === 'complete';
      if (!currentComplete && nextComplete) {
        const tracked = seenOrders.get(orderId);
        if (tracked && tracked.completionTick === null) {
          tracked.completionTick = nextRow.tick;
          completions.push(tracked);
        }
      }
    }
  }

  return {
    completionSequence: completions.sort((left, right) => left.completionTick - right.completionTick),
    activeBotCount: botActivity.size,
  };
}

export function extractReplaySeedSkeleton({ replayPath }) {
  const rows = snapshotRows(replayPath);
  const timeline = deriveCompletionSequence(rows);
  const earlyCompletions = timeline.completionSequence.slice(0, 4);
  const targetCutoffTicks = [...new Set(
    earlyCompletions
      .map((entry) => entry.completionTick)
      .filter((tick) => Number.isFinite(tick) && tick >= 120),
  )];

  return {
    completionSequence: earlyCompletions,
    activeBotCount: Math.max(1, timeline.activeBotCount),
    visibleOrderDepth: Math.max(2, Math.min(4, earlyCompletions.length + 1)),
    targetCutoffTicks: targetCutoffTicks.length > 0 ? targetCutoffTicks : [160, 180, 200],
  };
}

export function buildReplaySeededModularOptions({ skeleton }) {
  return skeleton.targetCutoffTicks.flatMap((targetCutoffTick) => ([
    {
      maxActiveBots: Math.min(4, Math.max(2, skeleton.activeBotCount)),
      maxTripItems: 1,
      previewRunnerCap: 0,
      previewItemCap: 4,
      visibleOrderDepth: skeleton.visibleOrderDepth,
      futureOrderBotCap: 2,
      futureOrderItemCap: 4,
      futureOrderPerOrderItemCap: 2,
      closeOrderReserveBots: 2,
      dropLaneConcurrency: 1,
      targetCutoffTick,
    },
  ]));
}

export function buildReplaySeededWaveOptions({ skeleton }) {
  return skeleton.targetCutoffTicks.flatMap((targetCutoffTick) => ([
    {
      maxActiveBots: Math.min(5, Math.max(3, skeleton.activeBotCount)),
      maxTripItems: 2,
      previewRunnerCap: 1,
      previewItemCap: 6,
      visibleOrderDepth: Math.min(4, skeleton.visibleOrderDepth + 1),
      futureOrderBotCap: 3,
      futureOrderItemCap: 6,
      futureOrderPerOrderItemCap: 3,
      closeOrderReserveBots: 2,
      dropLaneConcurrency: 1,
      targetCutoffTick,
    },
  ]));
}

export function buildReplaySeededHandoffOptions({ skeleton }) {
  return skeleton.targetCutoffTicks.flatMap((targetCutoffTick) => ([
    {
      maxActiveBots: Math.min(4, Math.max(2, skeleton.activeBotCount)),
      maxTripItems: 1,
      previewRunnerCap: 0,
      previewItemCap: 2,
      visibleOrderDepth: skeleton.visibleOrderDepth,
      futureOrderBotCap: 1,
      futureOrderItemCap: 2,
      futureOrderPerOrderItemCap: 1,
      closeOrderReserveBots: 2,
      dropLaneConcurrency: 1,
      targetCutoffTick: Math.max(120, targetCutoffTick - 20),
    },
  ]));
}
