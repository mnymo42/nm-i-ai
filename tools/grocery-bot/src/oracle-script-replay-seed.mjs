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

function sampleEvenly(values, limit) {
  if (values.length <= limit) {
    return [...values];
  }
  const sampled = [];
  for (let index = 0; index < limit; index += 1) {
    const position = Math.round((index * (values.length - 1)) / Math.max(1, limit - 1));
    sampled.push(values[position]);
  }
  return [...new Set(sampled)];
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

export function buildReplaySeededBucketOptions({ skeleton }) {
  return skeleton.targetCutoffTicks.flatMap((targetCutoffTick) => ([
    {
      maxActiveBots: Math.min(10, Math.max(6, skeleton.activeBotCount + 3)),
      closeNowBotCap: 3,
      stageBotCap: 7,
      maxTripItems: 2,
      previewRunnerCap: 2,
      previewItemCap: 8,
      visibleOrderDepth: Math.min(4, skeleton.visibleOrderDepth + 1),
      knownOrderDepth: 6,
      stageHiddenKnownOrders: true,
      futureOrderBotCap: 7,
      futureOrderItemCap: 12,
      futureOrderPerOrderItemCap: 3,
      closeOrderReserveBots: 3,
      dropLaneConcurrency: 1,
      targetCutoffTick: Math.max(220, targetCutoffTick + 20),
    },
    {
      maxActiveBots: Math.min(10, Math.max(8, skeleton.activeBotCount + 4)),
      closeNowBotCap: 4,
      stageBotCap: 6,
      maxTripItems: 2,
      previewRunnerCap: 1,
      previewItemCap: 6,
      visibleOrderDepth: Math.min(4, skeleton.visibleOrderDepth + 1),
      knownOrderDepth: 8,
      stageHiddenKnownOrders: true,
      futureOrderBotCap: 6,
      futureOrderItemCap: 10,
      futureOrderPerOrderItemCap: 2,
      closeOrderReserveBots: 3,
      dropLaneConcurrency: 1,
      targetCutoffTick: Math.max(220, targetCutoffTick + 40),
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

export function buildReplaySeededOpeningBucketOptions({ skeleton }) {
  return [90, 100, 110].map((targetCutoffTick) => ({
    maxActiveBots: Math.min(10, Math.max(8, skeleton.activeBotCount + 4)),
    closeNowBotCap: 4,
    stageBotCap: 6,
    maxTripItems: 2,
    previewRunnerCap: 2,
    previewItemCap: 10,
    visibleOrderDepth: Math.min(5, skeleton.visibleOrderDepth + 2),
    knownOrderDepth: 8,
    stageHiddenKnownOrders: true,
    futureOrderBotCap: 6,
    futureOrderItemCap: 10,
    futureOrderPerOrderItemCap: 2,
    closeOrderReserveBots: 4,
    dropLaneConcurrency: 1,
    openingFocus: true,
    targetCutoffTick,
  }));
}

export function buildReplaySeededDropLaneOptions({ skeleton }) {
  return [90, 100].map((targetCutoffTick) => ({
    maxActiveBots: Math.min(10, Math.max(7, skeleton.activeBotCount + 3)),
    closeNowBotCap: 5,
    stageBotCap: 5,
    maxTripItems: 1,
    previewRunnerCap: 1,
    previewItemCap: 6,
    visibleOrderDepth: Math.min(4, skeleton.visibleOrderDepth + 1),
    knownOrderDepth: 6,
    stageHiddenKnownOrders: true,
    futureOrderBotCap: 4,
    futureOrderItemCap: 6,
    futureOrderPerOrderItemCap: 2,
    closeOrderReserveBots: 4,
    dropLaneConcurrency: 1,
    openingFocus: true,
    dropLaneScheduler: true,
    targetCutoffTick,
  }));
}

export function buildReplaySeededAislePartitionOptions({ skeleton }) {
  return [100, 120].map((targetCutoffTick) => ({
    maxActiveBots: Math.min(10, Math.max(8, skeleton.activeBotCount + 4)),
    closeNowBotCap: 4,
    stageBotCap: 6,
    maxTripItems: 2,
    previewRunnerCap: 1,
    previewItemCap: 8,
    visibleOrderDepth: Math.min(5, skeleton.visibleOrderDepth + 2),
    knownOrderDepth: 8,
    stageHiddenKnownOrders: true,
    futureOrderBotCap: 6,
    futureOrderItemCap: 8,
    futureOrderPerOrderItemCap: 2,
    closeOrderReserveBots: 3,
    dropLaneConcurrency: 1,
    openingFocus: true,
    aislePartitionWeight: 2,
    targetCutoffTick,
  }));
}

export function buildReplaySeededOpeningCapacityOptions({ skeleton }) {
  const teamSplits = [
    [4, 3, 3, 0],
    [3, 3, 2, 2],
    [4, 2, 2, 2],
  ];
  const alignments = ['bottom_row', 'buffer_row', 'left_heavy_bottom_fanout'];
  const cadences = ['immediate', 'wait_turn', 'occupancy_clear'];
  const variants = [];

  for (const targetCutoffTick of [100, 110, 120]) {
    for (const openingAlignmentTarget of alignments) {
      for (const openingPairReleaseCadence of cadences) {
        for (const openingTeamSplit of teamSplits) {
          variants.push({
            maxActiveBots: Math.min(10, Math.max(8, skeleton.activeBotCount + 4)),
            closeNowBotCap: openingTeamSplit[0],
            stageBotCap: Math.max(0, openingTeamSplit[1] + openingTeamSplit[2]),
            maxTripItems: 2,
            previewRunnerCap: 2,
            previewItemCap: 8,
            visibleOrderDepth: Math.min(5, skeleton.visibleOrderDepth + 2),
            knownOrderDepth: 8,
            openingFutureOrderDepth: 2,
            stageHiddenKnownOrders: true,
            futureOrderBotCap: Math.max(0, openingTeamSplit[1] + openingTeamSplit[2]),
            futureOrderItemCap: 8,
            futureOrderPerOrderItemCap: 2,
            futureOrderBotCaps: [openingTeamSplit[1], openingTeamSplit[2]],
            closeOrderReserveBots: openingTeamSplit[0],
            dropLaneConcurrency: 1,
            openingFocus: true,
            openingCapacityV1: true,
            openingPairReleaseCadence,
            openingAlignmentTarget,
            openingTeamSplit,
            openingFutureOrderBotCaps: [openingTeamSplit[1], openingTeamSplit[2]],
            openingPairSpacing: 2,
            targetCutoffTick,
          });
        }
      }
    }
  }

  return sampleEvenly(variants, 6);
}

export function buildReplaySeededScoreTargets({ replayPath }) {
  const rows = snapshotRows(replayPath);
  const milestones = [];
  let previousScore = -1;

  for (const row of rows) {
    const score = row.state_snapshot?.score ?? 0;
    if (score > 0 && score !== previousScore) {
      milestones.push(score);
    }
    previousScore = score;
  }

  return sampleEvenly([...new Set(milestones)], 12);
}

export function buildReplaySeededRewindTicks({ targetScore }) {
  if (!Number.isFinite(targetScore) || targetScore <= 0) {
    return [0];
  }

  if (targetScore >= 80) {
    return [0, 4, 8, 12, 16, 24];
  }
  if (targetScore >= 60) {
    return [0, 4, 8, 12, 16];
  }
  if (targetScore >= 40) {
    return [0, 4, 8, 12];
  }
  return [0, 4, 8];
}
