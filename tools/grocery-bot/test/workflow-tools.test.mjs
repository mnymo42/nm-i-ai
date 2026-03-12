import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayLogger } from '../src/replay/replay.mjs';
import {
  buildReplayAnalysisReport,
  buildRunListing,
  buildScriptInfoReport,
} from '../src/utils/workflow-tools.mjs';

function writeRun(outDir, runId, { difficulty = 'expert', profile = 'expert' } = {}) {
  const runDir = path.join(outDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const replayPath = path.join(runDir, 'replay.jsonl');
  const logger = new ReplayLogger(replayPath);
  logger.log({
    type: 'layout',
    grid: { width: 5, height: 5, walls: [] },
    drop_off: [1, 3],
    max_rounds: 300,
  });
  logger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      round: 0,
      score: 0,
      bots: [{ id: 0, position: [1, 1], inventory: [] }],
      items: [{ id: 'item_0', type: 'milk', position: [2, 2] }],
      orders: [{ id: 'order_0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    },
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: { stalls: 0, stalledBots: 0, forcedWaits: 0 },
    sanitizer_overrides: [],
    pickup_result: [],
  });
  logger.log({ type: 'game_over', difficulty, profile, final_score: 4, items_delivered: 1, orders_completed: 0 });
  logger.close();

  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({
    runId,
    difficulty,
    profile,
    finalScore: 4,
    finalItems: 1,
    finalOrders: 0,
    metrics: {
      ticks: 1,
      finalScore: 4,
      ordersCompleted: 0,
      itemsDelivered: 1,
      totalStalls: 0,
    },
  }, null, 2));

  fs.writeFileSync(path.join(runDir, 'analysis.json'), JSON.stringify({
    finalScore: 4,
    ordersCompleted: 0,
    itemsDelivered: 1,
    totalTicks: 1,
    scoreByWindow: [{ start: 0, end: 24, delta: 4 }],
    stagnationWindows: [],
    failedPickups: { total: 0, byItemId: {}, byItemType: {} },
    actionEfficiency: { sanitizerOverrides: { total: 0, byReason: {} }, waitActions: 1, nonScoringDropoffs: 0 },
    multiBotCoordination: { totalStalls: 0, maxStalledBots: 0, forcedWaitActions: 0 },
    wastedInventoryAtEnd: [],
  }, null, 2));

  return { runDir, replayPath };
}

test('buildRunListing returns recent runs with score summary', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-tools-'));
  writeRun(outDir, '2026-03-08T10-50-21-635Z-expert-expert');
  writeRun(outDir, '2026-03-08T10-39-20-479Z-expert-expert');

  const listing = buildRunListing({ outDir, difficulty: 'expert', limit: 1 });
  assert.equal(listing.count, 1);
  assert.equal(listing.totalAvailable, 2);
  assert.equal(listing.runs[0].runId, '2026-03-08T10-50-21-635Z-expert-expert');
});

test('buildReplayAnalysisReport reads run directory artifacts', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-tools-'));
  const { runDir } = writeRun(outDir, '2026-03-08T10-50-21-635Z-expert-expert');

  const report = buildReplayAnalysisReport(runDir);
  assert.equal(report.runId, '2026-03-08T10-50-21-635Z-expert-expert');
  assert.equal(report.summary.finalScore, 4);
  assert.equal(report.keyMetrics.waitActions, 1);
  assert.equal(report.scoreByWindow.length, 1);
});

test('buildScriptInfoReport summarizes script and oracle metadata', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-tools-'));
  const oraclePath = path.join(tempRoot, 'oracle.json');
  const scriptPath = path.join(tempRoot, 'script.json');

  fs.writeFileSync(oraclePath, JSON.stringify({
    map_seed: 7004,
    difficulty: 'expert',
    bot_count: 10,
    known_orders: [{ id: 'order_0', items_required: ['milk'], first_seen_tick: 0 }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 2] }],
  }));
  fs.writeFileSync(scriptPath, JSON.stringify({
    strategy: 'legacy',
    last_scripted_tick: 3,
    estimated_score: 8,
    orders_covered: 1,
    ticks: [
      { tick: 0, actions: [{ bot: 0, action: 'wait' }] },
      { tick: 3, actions: [{ bot: 0, action: 'drop_off' }] },
    ],
    evaluation: { valid: true, score: 8, lastScriptedTick: 3, errors: [] },
  }));

  const report = buildScriptInfoReport({ scriptPath, oraclePath });
  assert.equal(report.strategy, 'legacy');
  assert.equal(report.totalTicks, 2);
  assert.equal(report.oracle.knownOrders, 1);
});
