import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplayLogger, generateAnalysis, summarizeReplay } from '../src/replay.mjs';

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
