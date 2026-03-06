import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplayLogger, summarizeReplay } from '../src/replay.mjs';

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
