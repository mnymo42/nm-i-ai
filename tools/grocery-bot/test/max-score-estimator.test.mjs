import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplayLogger } from '../src/replay/replay.mjs';
import { estimateMaxScoreFromReplay } from '../src/utils/max-score-estimator.mjs';

function tickState({ round, score, orders }) {
  return {
    type: 'game_state',
    round,
    max_rounds: 10,
    grid: {
      width: 5,
      height: 5,
      walls: [],
    },
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
    orders,
    drop_off: [1, 1],
    score,
  };
}

test('estimateMaxScoreFromReplay returns conservative and optimistic score targets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-estimator-test-'));
  const replayPath = path.join(tmpDir, 'replay.jsonl');
  const logger = new ReplayLogger(replayPath);

  logger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: tickState({
      round: 0,
      score: 0,
      orders: [
        { id: 'order_0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
        { id: 'order_1', items_required: ['milk'], items_delivered: [], status: 'preview', complete: false },
      ],
    }),
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: {},
  });

  logger.log({
    type: 'tick',
    tick: 1,
    state_snapshot: tickState({
      round: 1,
      score: 6,
      orders: [
        { id: 'order_1', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
        { id: 'order_2', items_required: ['milk'], items_delivered: [], status: 'preview', complete: false },
      ],
    }),
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: {},
  });

  logger.close();

  const estimate = estimateMaxScoreFromReplay(replayPath);

  assert.equal(estimate.queueBound.score, 12);
  assert.equal(estimate.queueBound.completedOrders, 2);
  assert.equal(estimate.targetRange.conservative, 12);
  assert.equal(estimate.targetRange.optimistic, 30);
});

test('estimateMaxScoreFromReplay supports compact replay layout rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-bot-estimator-test-'));
  const replayPath = path.join(tmpDir, 'compact-replay.jsonl');
  const logger = new ReplayLogger(replayPath);

  logger.log({
    type: 'layout',
    grid: {
      width: 5,
      height: 5,
      walls: [],
    },
    drop_off: [1, 1],
    max_rounds: 10,
  });
  logger.log({
    type: 'tick',
    tick: 0,
    state_snapshot: {
      round: 0,
      score: 0,
      bots: [{ id: 0, position: [1, 1], inventory: [] }],
      items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
      orders: [
        { id: 'order_0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
        { id: 'order_1', items_required: ['milk'], items_delivered: [], status: 'preview', complete: false },
      ],
      drop_off: [1, 1],
    },
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: {},
  });
  logger.log({
    type: 'tick',
    tick: 1,
    state_snapshot: {
      round: 1,
      score: 6,
      bots: [{ id: 0, position: [1, 1], inventory: [] }],
      items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
      orders: [
        { id: 'order_1', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      ],
      drop_off: [1, 1],
    },
    actions_sent: [{ bot: 0, action: 'wait' }],
    planner_metrics: {},
  });
  logger.close();

  const estimate = estimateMaxScoreFromReplay(replayPath);

  assert.equal(estimate.queueBound.score, 12);
  assert.equal(estimate.queueBound.completedOrders, 2);
});
