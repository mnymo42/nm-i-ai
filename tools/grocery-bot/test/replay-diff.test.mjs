import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComparableReplayState,
  compareReplayTransitionAtTick,
  findFirstReplayTransitionMismatch,
} from '../src/replay-transition-diff.mjs';

function writeReplay(rows) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-diff-'));
  const replayPath = path.join(tempRoot, 'replay.jsonl');
  fs.writeFileSync(replayPath, rows.map((row) => JSON.stringify(row)).join('\n'));
  return replayPath;
}

test('buildComparableReplayState preserves semantically important fields', () => {
  const state = buildComparableReplayState({
    type: 'game_state',
    round: 3,
    max_rounds: 300,
    score: 7,
    drop_off: [1, 2],
    drop_offs: [[1, 2]],
    bots: [{ id: 1, position: [4, 5], inventory: ['b', 'a'] }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
    orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['bread', 'milk'], items_delivered: ['milk'] }],
  });

  assert.deepEqual(state, {
    type: 'game_state',
    round: 3,
    max_rounds: 300,
    score: 7,
    drop_off: [1, 2],
    drop_offs: [[1, 2]],
    bots: [{ id: 1, position: [4, 5], inventory: ['a', 'b'] }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
    orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['bread', 'milk'], items_delivered: ['milk'] }],
  });
});

test('compareReplayTransitionAtTick detects next-state drift even when pre-state and actions match', () => {
  const sourceReplay = writeReplay([
    { type: 'tick', tick: 0, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'move_right' }] },
    { type: 'tick', tick: 1, state_snapshot: { score: 1, bots: [{ id: 0, position: [2, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'wait' }] },
  ]);
  const validationReplay = writeReplay([
    { type: 'tick', tick: 0, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'move_right' }] },
    { type: 'tick', tick: 1, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'wait' }] },
  ]);

  const comparison = compareReplayTransitionAtTick({
    sourceReplayPath: sourceReplay,
    validationReplayPath: validationReplay,
    tick: 0,
  });

  assert.equal(comparison.preStateEqual, true);
  assert.equal(comparison.actionsEqual, true);
  assert.equal(comparison.actionEnvelopeEqual, true);
  assert.equal(comparison.nextStateEqual, false);
  assert.equal(comparison.firstDifference.phase, 'next_state');
});

test('findFirstReplayTransitionMismatch returns earliest bad transition', () => {
  const sourceReplay = writeReplay([
    { type: 'tick', tick: 0, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'move_right' }] },
    { type: 'tick', tick: 1, state_snapshot: { score: 1, bots: [{ id: 0, position: [2, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'move_right' }] },
    { type: 'tick', tick: 2, state_snapshot: { score: 2, bots: [{ id: 0, position: [3, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'wait' }] },
  ]);
  const validationReplay = writeReplay([
    { type: 'tick', tick: 0, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'move_right' }] },
    { type: 'tick', tick: 1, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'move_right' }] },
    { type: 'tick', tick: 2, state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] }, actions_sent: [{ bot: 0, action: 'wait' }] },
  ]);

  const comparison = findFirstReplayTransitionMismatch({
    sourceReplayPath: sourceReplay,
    validationReplayPath: validationReplay,
  });

  assert.equal(comparison.tick, 0);
  assert.equal(comparison.firstDifference.phase, 'next_state');
});
