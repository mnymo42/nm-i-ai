import fs from 'node:fs';
import path from 'node:path';

import { collectReplayPaths, extractLayout, parseJsonl, rebuildSnapshot } from './replay-io.mjs';

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

function activeOrderId(snapshot) {
  if (!snapshot?.orders || !Array.isArray(snapshot.orders)) {
    return null;
  }

  const active = snapshot.orders.find((order) => order.status === 'active');
  return active?.id ?? null;
}

function buildDemand(order) {
  const demand = new Map();
  if (!order) {
    return demand;
  }

  for (const type of order.items_required || []) {
    demand.set(type, (demand.get(type) || 0) + 1);
  }

  for (const type of order.items_delivered || []) {
    const current = demand.get(type) || 0;
    if (current > 0) {
      demand.set(type, current - 1);
    }
  }

  return demand;
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

export function generateAnalysis(filePath) {
  const rows = parseJsonl(filePath);
  const tickRows = rows.filter((r) => r.type === 'tick');
  const controlModeTimeline = [];
  const previewWipTimeline = [];
  const activeCloseEtaTimeline = [];

  // Score progression by 25-tick windows
  const scoreByWindow = [];
  const windowSize = 25;
  for (let start = 0; start < 300; start += windowSize) {
    const end = start + windowSize - 1;
    const first = tickRows.find((r) => r.tick >= start);
    const last = [...tickRows].reverse().find((r) => r.tick <= end);
    const startScore = first?.state_snapshot?.score ?? 0;
    const endScore = last?.state_snapshot?.score ?? startScore;
    scoreByWindow.push({ start, end, delta: endScore - startScore });
  }

  // Stagnation windows (25+ ticks with zero score gain)
  const stagnationWindows = [];
  let stagnationStart = null;
  let prevScore = null;
  for (const row of tickRows) {
    const score = row.state_snapshot?.score ?? 0;
    if (prevScore !== null && score === prevScore) {
      if (stagnationStart === null) stagnationStart = row.tick - 1;
    } else {
      if (stagnationStart !== null) {
        const length = row.tick - stagnationStart;
        if (length >= 10) stagnationWindows.push({ startTick: stagnationStart, endTick: row.tick - 1, length });
        stagnationStart = null;
      }
    }
    prevScore = score;
  }
  if (stagnationStart !== null) {
    const last = tickRows.at(-1);
    const length = (last?.tick ?? stagnationStart) - stagnationStart + 1;
    if (length >= 10) stagnationWindows.push({ startTick: stagnationStart, endTick: last?.tick, length });
  }

  // Failed pickups
  const failedByItemId = {};
  const failedByItemType = {};
  let totalFailed = 0;
  for (const row of tickRows) {
    for (const result of row.pickup_result || []) {
      if (!result.succeeded) {
        totalFailed += 1;
        const id = result.attempted_item_id ?? 'unknown';
        failedByItemId[id] = (failedByItemId[id] || 0) + 1;
      }
    }
    // Track item type via items array if available
    const snapshot = row.state_snapshot;
    for (const result of row.pickup_result || []) {
      if (!result.succeeded) {
        const id = result.attempted_item_id;
        const item = (snapshot?.items || []).find((i) => i.id === id);
        if (item?.type) failedByItemType[item.type] = (failedByItemType[item.type] || 0) + 1;
      }
    }
  }

  // Sanitizer overrides
  let totalOverrides = 0;
  const overridesByReason = {};
  for (const row of tickRows) {
    for (const override of row.sanitizer_overrides || []) {
      totalOverrides += 1;
      const reason = override.reason ?? 'unknown';
      overridesByReason[reason] = (overridesByReason[reason] || 0) + 1;
    }
  }

  // Wait actions and non-scoring drop_offs
  let waitActions = 0;
  let nonScoringDropoffs = 0;
  for (let i = 0; i < tickRows.length; i += 1) {
    const row = tickRows[i];
    const nextRow = tickRows[i + 1];
    for (const action of row.actions_sent || []) {
      if (action.action === 'wait') waitActions += 1;
      if (action.action === 'drop_off') {
        const scoreBefore = row.state_snapshot?.score ?? 0;
        const scoreAfter = nextRow?.state_snapshot?.score ?? scoreBefore;
        if (scoreAfter === scoreBefore) nonScoringDropoffs += 1;
      }
    }
  }

  // Wasted inventory at game end
  const lastTick = tickRows.at(-1);
  const wastedInventory = (lastTick?.state_snapshot?.bots || []).flatMap((b) => b.inventory || []);

  // Final result from game_over row
  const gameOver = rows.find((r) => r.type === 'game_over');
  const summary = summarizeReplay(filePath);
  const botCount = lastTick?.state_snapshot?.bots?.length || 0;
  const maxStalledBots = tickRows.reduce((max, row) => Math.max(max, row.planner_metrics?.stalledBots || 0), 0);
  const peakTaskCount = tickRows.reduce((max, row) => Math.max(max, row.planner_metrics?.taskCount || 0), 0);
  const forcedWaitActions = tickRows.reduce((sum, row) => sum + (row.planner_metrics?.forcedWaits || 0), 0);
  let queueAssignmentsPeak = 0;
  let serviceBayAssignmentsPeak = 0;
  let previewWipPeak = 0;
  const missionMetrics = tickRows.reduce((aggregate, row) => {
    const metrics = row.planner_metrics || {};
    if (metrics.missionTypeByBot && Object.keys(metrics.missionTypeByBot).length > 0) {
      aggregate.missionTypeByBot = metrics.missionTypeByBot;
    }
    if (metrics.controlMode && metrics.controlMode !== aggregate.lastControlMode) {
      if (aggregate.lastControlMode !== null) {
        controlModeTimeline.push({
          mode: aggregate.lastControlMode,
          startTick: aggregate.controlStartTick,
          endTick: row.tick - 1,
        });
      }
      aggregate.lastControlMode = metrics.controlMode;
      aggregate.controlStartTick = row.tick;
    }
    if (typeof metrics.previewWipItems === 'number') {
      previewWipPeak = Math.max(previewWipPeak, metrics.previewWipItems);
      const lastPreviewWip = previewWipTimeline.at(-1);
      if (!lastPreviewWip || lastPreviewWip.value !== metrics.previewWipItems) {
        previewWipTimeline.push({ tick: row.tick, value: metrics.previewWipItems });
      }
    }
    if (metrics.orderEtaAtDecision !== undefined && metrics.orderEtaAtDecision !== null) {
      const lastEta = activeCloseEtaTimeline.at(-1);
      if (!lastEta || lastEta.value !== metrics.orderEtaAtDecision) {
        activeCloseEtaTimeline.push({ tick: row.tick, value: metrics.orderEtaAtDecision });
      }
    }
    aggregate.missionReassignments += metrics.missionReassignments || 0;
    aggregate.activeMissionsAssigned = Math.max(
      aggregate.activeMissionsAssigned,
      metrics.activeMissionsAssigned || 0,
    );
    aggregate.previewMissionsAssigned = Math.max(
      aggregate.previewMissionsAssigned,
      metrics.previewMissionsAssigned || 0,
    );
    aggregate.previewSuppressed += metrics.previewSuppressed ? 1 : 0;
    aggregate.dropMissionsAssigned = Math.max(
      aggregate.dropMissionsAssigned,
      metrics.dropMissionsAssigned || 0,
    );
    aggregate.missionTimeouts += metrics.missionTimeouts || 0;
    queueAssignmentsPeak = Math.max(queueAssignmentsPeak, metrics.queueAssignments || 0);
    serviceBayAssignmentsPeak = Math.max(serviceBayAssignmentsPeak, metrics.serviceBayAssignments || 0);
    return aggregate;
  }, {
    missionTypeByBot: {},
    missionReassignments: 0,
    activeMissionsAssigned: 0,
    previewMissionsAssigned: 0,
    previewSuppressed: 0,
    dropMissionsAssigned: 0,
    missionTimeouts: 0,
    lastControlMode: null,
    controlStartTick: null,
  });
  if (missionMetrics.lastControlMode !== null) {
    controlModeTimeline.push({
      mode: missionMetrics.lastControlMode,
      startTick: missionMetrics.controlStartTick,
      endTick: tickRows.at(-1)?.tick ?? missionMetrics.controlStartTick,
    });
  }
  delete missionMetrics.lastControlMode;
  delete missionMetrics.controlStartTick;
  let endInventoryByBot = null;
  if (botCount > 1 && lastTick?.state_snapshot?.bots) {
    const activeOrder = (lastTick.state_snapshot.orders || []).find((order) => order.status === 'active' && !order.complete) || null;
    const activeDemand = buildDemand(activeOrder);
    endInventoryByBot = lastTick.state_snapshot.bots.map((bot) => {
      const localDemand = new Map(activeDemand);
      let deliverable = 0;
      let nondeliverable = 0;

      for (const type of bot.inventory || []) {
        const remaining = localDemand.get(type) || 0;
        if (remaining > 0) {
          deliverable += 1;
          localDemand.set(type, remaining - 1);
        } else {
          nondeliverable += 1;
        }
      }

      return {
        bot: bot.id,
        inventoryCount: (bot.inventory || []).length,
        deliverableActiveItems: deliverable,
        nonDeliverableItems: nondeliverable,
      };
    });
  }

  return {
    finalScore: gameOver?.final_score ?? summary.finalScore,
    ordersCompleted: gameOver?.orders_completed ?? summary.ordersCompleted,
    itemsDelivered: gameOver?.items_delivered ?? summary.itemsDelivered,
    totalTicks: tickRows.length,
    scoreByWindow,
    stagnationWindows,
    failedPickups: {
      total: totalFailed,
      byItemId: failedByItemId,
      byItemType: failedByItemType,
    },
    actionEfficiency: {
      sanitizerOverrides: { total: totalOverrides, byReason: overridesByReason },
      waitActions,
      nonScoringDropoffs,
    },
    multiBotCoordination: botCount > 1 ? {
      botCount,
      totalStalls: summary.totalStalls,
      maxStalledBots,
      peakTaskCount,
      forcedWaitActions,
      ...missionMetrics,
      controlModeTimeline,
      previewWipPeak,
      previewWipTimeline,
      activeCloseEtaTimeline,
      queueAssignmentsPeak,
      serviceBayAssignmentsPeak,
      endInventoryByBot,
    } : null,
    wastedInventoryAtEnd: wastedInventory,
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
  const layout = extractLayout(rows);
  const ticks = rows.filter((row) => row.type === 'tick');

  let compared = 0;
  let matches = 0;
  let waits = 0;

  for (const tick of ticks) {
    if (!tick.state_snapshot) {
      continue;
    }

    const snapshot = rebuildSnapshot(tick.state_snapshot, layout);
    const expected = planner.plan(snapshot);
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
    matchRatio: Number(matchRatio.toFixed(4)),
    waitRatio: Number(waitRatio.toFixed(4)),
    // NOTE: matchRatio measures action agreement with past run, not score.
    // A change in strategy will lower matchRatio even if it improves score.
    // Use live play or estimate-max to evaluate actual score impact.
  };
}

export function benchmarkReplayCorpus({
  targetPath,
  difficulty = null,
  plannerFactory,
}) {
  const replayPaths = collectReplayPaths(targetPath, difficulty);
  const results = replayPaths.map((replayPath) => {
    const summary = summarizeReplay(replayPath);
    const analysis = generateAnalysis(replayPath);
    const simulation = plannerFactory
      ? simulateReplayAgainstObserved(replayPath, plannerFactory())
      : null;

    return {
      replay: replayPath,
      finalScore: summary.finalScore,
      ordersCompleted: summary.ordersCompleted,
      itemsDelivered: summary.itemsDelivered,
      simulation,
      missionStats: analysis.multiBotCoordination ? {
        missionReassignments: analysis.multiBotCoordination.missionReassignments,
        activeMissionsAssigned: analysis.multiBotCoordination.activeMissionsAssigned,
        previewMissionsAssigned: analysis.multiBotCoordination.previewMissionsAssigned,
        dropMissionsAssigned: analysis.multiBotCoordination.dropMissionsAssigned,
        missionTimeouts: analysis.multiBotCoordination.missionTimeouts,
      } : null,
      controlModeTimeline: analysis.multiBotCoordination?.controlModeTimeline || [],
      previewWipTimeline: analysis.multiBotCoordination?.previewWipTimeline || [],
      previewWipPeak: analysis.multiBotCoordination?.previewWipPeak || 0,
      activeCloseEtaTimeline: analysis.multiBotCoordination?.activeCloseEtaTimeline || [],
      queueAssignmentsPeak: analysis.multiBotCoordination?.queueAssignmentsPeak || 0,
      serviceBayAssignmentsPeak: analysis.multiBotCoordination?.serviceBayAssignmentsPeak || 0,
      deliveryCadenceByWindow: analysis.scoreByWindow,
    };
  });

  return {
    replayCount: results.length,
    replays: results,
  };
}
