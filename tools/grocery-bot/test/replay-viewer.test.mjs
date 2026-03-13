import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplayLogger } from '../src/replay/replay.mjs';
import { listReplayRuns, loadReplayRun } from '../src/replay/replay-viewer.mjs';
import { handleReplayViewerRequest } from '../viewer/server.mjs';

function writeRun(outDir, runId, { difficulty, profile, dropOffs = [[1, 3]] }) {
  const runDir = path.join(outDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const replayPath = path.join(runDir, 'replay.jsonl');
  const logger = new ReplayLogger(replayPath);
  logger.log({
    type: 'layout',
    grid: { width: 5, height: 5, walls: [] },
    drop_off: dropOffs[0],
    drop_offs: dropOffs,
    max_rounds: 300,
  });
  logger.log({
    type: 'tick',
    tick: 0,
    difficulty,
    state_snapshot: {
      round: 0,
      score: 0,
      bots: [{ id: 0, position: [1, 1], inventory: [] }],
      items: [{ id: 'item_0', type: 'milk', position: [2, 2] }],
      orders: [{ id: 'order_0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    },
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: {
      controlMode: 'build_active_inventory',
      missionTypeByBot: { 0: 'pickup_active' },
    },
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
    stagnationWindows: [],
    failedPickups: { total: 0, byItemId: {}, byItemType: {} },
    actionEfficiency: { sanitizerOverrides: { total: 0, byReason: {} }, waitActions: 1, nonScoringDropoffs: 0 },
    multiBotCoordination: {
      botCount: 1,
      totalStalls: 0,
      missionTypeByBot: { 0: 'pickup_active' },
      controlModeTimeline: [{ mode: 'build_active_inventory', startTick: 0, endTick: 0 }],
      previewWipTimeline: [],
      activeCloseEtaTimeline: [],
      queueAssignmentsPeak: 0,
      serviceBayAssignmentsPeak: 0,
    },
  }, null, 2));

  return runDir;
}

test('listReplayRuns discovers runs and filters by difficulty/profile', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-viewer-'));
  writeRun(outDir, '2026-03-07T00-00-00-000Z-expert-expert', { difficulty: 'expert', profile: 'expert' });
  writeRun(outDir, '2026-03-07T00-00-00-000Z-hard-hard', { difficulty: 'hard', profile: 'hard' });

  const allRuns = listReplayRuns(outDir);
  assert.equal(allRuns.length, 2);

  const expertRuns = listReplayRuns(outDir, { difficulty: 'expert' });
  assert.equal(expertRuns.length, 1);
  assert.equal(expertRuns[0].difficulty, 'expert');
  assert.equal(expertRuns[0].profile, 'expert');
});

test('loadReplayRun returns summary, analysis, layout, and rebuilt ticks', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-viewer-'));
  const runDir = writeRun(outDir, '2026-03-07T00-00-00-000Z-expert-expert', {
    difficulty: 'expert',
    profile: 'expert',
    dropOffs: [[1, 3], [3, 3]],
  });

  const payload = loadReplayRun(runDir, outDir);
  assert.equal(payload.summary.difficulty, 'expert');
  assert.deepEqual(payload.layout.drop_offs, [[1, 3], [3, 3]]);
  assert.equal(Array.isArray(payload.layout.laneMap?.oneWayRoads?.['1,2']), true);
  assert.equal(Array.isArray(payload.layout.laneMap?.trafficLaneCells), true);
  assert.equal(payload.layout.laneMap?.version, 'v4');
  assert.equal(payload.layout.laneMap?.roadGroups !== null, true);
  assert.equal(payload.ticks.length, 1);
  assert.deepEqual(payload.ticks[0].state_snapshot.grid, { width: 5, height: 5, walls: [] });
});

test('viewer server helpers serve run list and run payload', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-viewer-'));
  writeRun(outDir, '2026-03-07T00-00-00-000Z-expert-expert', { difficulty: 'expert', profile: 'expert' });

  const runsResponse = handleReplayViewerRequest('/api/runs?difficulty=expert', outDir);
  assert.equal(runsResponse.statusCode, 200);
  assert.equal(runsResponse.payload.runs.length, 1);

  const runPath = runsResponse.payload.runs[0].relativePath;
  const runResponse = handleReplayViewerRequest(`/api/run?path=${encodeURIComponent(runPath)}`, outDir);
  assert.equal(runResponse.statusCode, 200);
  assert.equal(runResponse.payload.summary.profile, 'expert');
  assert.equal(runResponse.payload.ticks.length, 1);
});
