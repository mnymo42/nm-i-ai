import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ReplayLogger,
  benchmarkReplayCorpus,
  generateAnalysis,
  summarizeReplay,
} from '../src/replay/replay.mjs';

test('ReplayLogger writes JSONL and summarizeReplay returns key metrics', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-test-'));
  const replayPath = path.join(tmpDir, 'run.jsonl');

  const logger = new ReplayLogger(replayPath);

  logger.log({ type: 'tick', tick: 0, state_snapshot: { round: 0 }, actions_sent: [{ bot: 0, action: 'wait' }], planner_metrics: { stalls: 0 } });
  logger.log({ type: 'tick', tick: 1, state_snapshot: { round: 1 }, actions_sent: [{ bot: 0, action: 'wait' }], planner_metrics: { stalls: 1 } });
  logger.log({ type: 'game_over', final_score: 11, orders_completed: 2, items_delivered: 5 });

  logger.close();

  const summary = summarizeReplay(replayPath);

  assert.equal(summary.ticks, 2);
  assert.equal(summary.finalScore, 11);
  assert.equal(summary.ordersCompleted, 2);
  assert.equal(summary.itemsDelivered, 5);
  assert.equal(summary.totalStalls, 1);
});

test('summarizeReplay derives delivered items and completed orders from tick deltas when game_over omits them', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-test-'));
  const replayPath = path.join(tmpDir, 'derive.jsonl');

  const logger = new ReplayLogger(replayPath);
  logger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      score: 0,
      orders: [{ id: 'order_0', status: 'active' }, { id: 'order_1', status: 'preview' }],
    },
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: { stalls: 0 },
  });
  logger.log({
    type: 'tick',
    tick: 1,
    state_snapshot: {
      score: 3,
      orders: [{ id: 'order_0', status: 'active' }, { id: 'order_1', status: 'preview' }],
    },
    actions_sent: [{ bot: 0, action: 'drop_off' }],
    planner_metrics: { stalls: 0 },
  });
  logger.log({
    type: 'tick',
    tick: 2,
    state_snapshot: {
      score: 9,
      orders: [{ id: 'order_1', status: 'active' }, { id: 'order_2', status: 'preview' }],
    },
    actions_sent: [{ bot: 0, action: 'drop_off' }],
    planner_metrics: { stalls: 0 },
  });
  logger.log({ type: 'game_over', final_score: 9, items_delivered: null, orders_completed: null });
  logger.close();

  const summary = summarizeReplay(replayPath);

  assert.equal(summary.finalScore, 9);
  assert.equal(summary.itemsDelivered, 4);
  assert.equal(summary.ordersCompleted, 1);
});

test('generateAnalysis includes compact multi-bot coordination metrics', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-test-'));
  const replayPath = path.join(tmpDir, 'multibot.jsonl');

  const logger = new ReplayLogger(replayPath);
  logger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      score: 0,
      bots: [
        { id: 0, inventory: ['milk'], position: [1, 1] },
        { id: 1, inventory: ['bread', 'bread'], position: [2, 1] },
      ],
      orders: [
        { id: 'order_0', items_required: ['milk', 'yogurt'], items_delivered: [], status: 'active', complete: false },
        { id: 'order_1', items_required: ['bread'], items_delivered: [], status: 'preview', complete: false },
      ],
    },
    actions_sent: [{ bot: 0, action: 'wait' }, { bot: 1, action: 'wait' }],
    planner_metrics: {
      stalls: 1,
      stalledBots: 1,
      taskCount: 6,
      forcedWaits: 1,
      missionTypeByBot: { 0: 'collect_active', 1: 'idle_reposition' },
      missionReassignments: 2,
      activeMissionsAssigned: 1,
      previewMissionsAssigned: 0,
      previewSuppressed: true,
      dropMissionsAssigned: 0,
      missionTimeouts: 1,
    },
  });
  logger.log({
    type: 'tick',
    tick: 1,
    state_snapshot: {
      score: 0,
      bots: [
        { id: 0, inventory: ['milk'], position: [1, 1] },
        { id: 1, inventory: ['bread', 'bread'], position: [2, 1] },
      ],
      orders: [
        { id: 'order_0', items_required: ['milk', 'yogurt'], items_delivered: [], status: 'active', complete: false },
        { id: 'order_1', items_required: ['bread'], items_delivered: [], status: 'preview', complete: false },
      ],
    },
    actions_sent: [{ bot: 0, action: 'wait' }, { bot: 1, action: 'wait' }],
    planner_metrics: {
      stalls: 2,
      stalledBots: 2,
      taskCount: 8,
      forcedWaits: 0,
      missionTypeByBot: { 0: 'drop_active', 1: 'collect_preview' },
      missionReassignments: 1,
      activeMissionsAssigned: 0,
      previewMissionsAssigned: 1,
      previewSuppressed: false,
      dropMissionsAssigned: 1,
      missionTimeouts: 0,
    },
  });
  logger.log({ type: 'game_over', final_score: 0, items_delivered: 0, orders_completed: 0 });
  logger.close();

  const analysis = generateAnalysis(replayPath);

  assert.equal(analysis.multiBotCoordination.botCount, 2);
  assert.equal(analysis.multiBotCoordination.totalStalls, 3);
  assert.equal(analysis.multiBotCoordination.maxStalledBots, 2);
  assert.equal(analysis.multiBotCoordination.peakTaskCount, 8);
  assert.equal(analysis.multiBotCoordination.forcedWaitActions, 1);
  assert.deepEqual(analysis.multiBotCoordination.missionTypeByBot, { 0: 'drop_active', 1: 'collect_preview' });
  assert.equal(analysis.multiBotCoordination.missionReassignments, 3);
  assert.equal(analysis.multiBotCoordination.activeMissionsAssigned, 1);
  assert.equal(analysis.multiBotCoordination.previewMissionsAssigned, 1);
  assert.equal(analysis.multiBotCoordination.previewSuppressed, 1);
  assert.equal(analysis.multiBotCoordination.dropMissionsAssigned, 1);
  assert.equal(analysis.multiBotCoordination.missionTimeouts, 1);
  assert.deepEqual(analysis.multiBotCoordination.endInventoryByBot, [
    { bot: 0, inventoryCount: 1, deliverableActiveItems: 1, nonDeliverableItems: 0 },
    { bot: 1, inventoryCount: 2, deliverableActiveItems: 0, nonDeliverableItems: 2 },
  ]);
});

test('generateAnalysis tracks warehouse control timeline and queue metrics', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-test-'));
  const replayPath = path.join(tmpDir, 'warehouse.jsonl');

  const logger = new ReplayLogger(replayPath);
  logger.log({
    type: 'layout',
    grid: { width: 5, height: 5, walls: [] },
    drop_off: [1, 1],
    max_rounds: 300,
  });
  logger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      score: 0,
      bots: [
        { id: 0, inventory: ['milk'], position: [1, 1] },
        { id: 1, inventory: [], position: [2, 1] },
      ],
      orders: [
        { id: 'order_0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
        { id: 'order_1', items_required: ['bread'], items_delivered: [], status: 'preview', complete: false },
      ],
    },
    actions_sent: [{ bot: 0, action: 'drop_off' }, { bot: 1, action: 'wait' }],
    planner_metrics: {
      stalledBots: 1,
      taskCount: 2,
      controlMode: 'close_active_order',
      missionTypeByBot: { 0: 'drop_active', 1: 'queue_service_bay' },
      previewWipItems: 1,
      queueAssignments: 1,
      serviceBayAssignments: 1,
      orderEtaAtDecision: 3,
    },
  });
  logger.log({
    type: 'tick',
    tick: 1,
    state_snapshot: {
      score: 6,
      bots: [
        { id: 0, inventory: [], position: [1, 1] },
        { id: 1, inventory: ['bread'], position: [2, 1] },
      ],
      orders: [
        { id: 'order_1', items_required: ['bread'], items_delivered: [], status: 'active', complete: false },
      ],
    },
    actions_sent: [{ bot: 0, action: 'wait' }, { bot: 1, action: 'pick_up', item_id: 'item_1' }],
    planner_metrics: {
      stalledBots: 0,
      taskCount: 1,
      controlMode: 'limited_preview_prefetch',
      missionTypeByBot: { 0: 'reposition_zone', 1: 'pickup_preview' },
      previewWipItems: 0,
      queueAssignments: 0,
      serviceBayAssignments: 1,
      orderEtaAtDecision: 1,
    },
  });
  logger.log({ type: 'game_over', final_score: 6, items_delivered: 1, orders_completed: 1 });
  logger.close();

  const analysis = generateAnalysis(replayPath);

  assert.deepEqual(analysis.multiBotCoordination.controlModeTimeline, [
    { mode: 'close_active_order', startTick: 0, endTick: 0 },
    { mode: 'limited_preview_prefetch', startTick: 1, endTick: 1 },
  ]);
  assert.deepEqual(analysis.multiBotCoordination.previewWipTimeline, [
    { tick: 0, value: 1 },
    { tick: 1, value: 0 },
  ]);
  assert.deepEqual(analysis.multiBotCoordination.activeCloseEtaTimeline, [
    { tick: 0, value: 3 },
    { tick: 1, value: 1 },
  ]);
  assert.equal(analysis.multiBotCoordination.previewWipPeak, 1);
  assert.equal(analysis.multiBotCoordination.queueAssignmentsPeak, 1);
  assert.equal(analysis.multiBotCoordination.serviceBayAssignmentsPeak, 1);
});

test('benchmarkReplayCorpus evaluates a replay directory and includes simulation and warehouse metrics', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-test-'));
  const mediumDir = path.join(tmpDir, '2026-03-07T00-00-00-000Z-medium-medium');
  const easyDir = path.join(tmpDir, '2026-03-07T00-00-00-000Z-easy-easy');
  fs.mkdirSync(mediumDir, { recursive: true });
  fs.mkdirSync(easyDir, { recursive: true });

  const mediumReplay = path.join(mediumDir, 'replay.jsonl');
  const mediumLogger = new ReplayLogger(mediumReplay);
  mediumLogger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      round: 0,
      max_rounds: 10,
      grid: { width: 5, height: 5, walls: [] },
      drop_off: [1, 1],
      score: 0,
      bots: [
        { id: 0, position: [1, 1], inventory: [] },
        { id: 1, position: [2, 1], inventory: [] },
      ],
      orders: [],
      items: [],
    },
    actions_sent: [{ bot: 0, action: 'wait' }, { bot: 1, action: 'wait' }],
    planner_metrics: {
      stalledBots: 0,
      taskCount: 0,
      controlMode: 'stop_preview',
      missionTypeByBot: { 0: 'reposition_zone', 1: 'reposition_zone' },
      previewWipItems: 0,
      orderEtaAtDecision: 0,
    },
  });
  mediumLogger.log({ type: 'game_over', final_score: 0, orders_completed: 0, items_delivered: 0 });
  mediumLogger.close();

  const easyReplay = path.join(easyDir, 'replay.jsonl');
  const easyLogger = new ReplayLogger(easyReplay);
  easyLogger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      round: 0,
      max_rounds: 10,
      grid: { width: 5, height: 5, walls: [] },
      drop_off: [1, 1],
      score: 0,
      bots: [{ id: 0, position: [1, 1], inventory: [] }],
      orders: [],
      items: [],
    },
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: {},
  });
  easyLogger.log({ type: 'game_over', final_score: 0, orders_completed: 0, items_delivered: 0 });
  easyLogger.close();

  const benchmark = benchmarkReplayCorpus({
    targetPath: tmpDir,
    difficulty: 'medium',
    plannerFactory: () => ({
      plan() {
        return [{ bot: 0, action: 'wait' }, { bot: 1, action: 'wait' }];
      },
    }),
  });

  assert.equal(benchmark.replayCount, 1);
  assert.equal(benchmark.replays[0].replay, mediumReplay);
  assert.equal(benchmark.replays[0].simulation.matchRatio, 1);
  assert.deepEqual(benchmark.replays[0].controlModeTimeline, [
    { mode: 'stop_preview', startTick: 0, endTick: 0 },
  ]);
});
