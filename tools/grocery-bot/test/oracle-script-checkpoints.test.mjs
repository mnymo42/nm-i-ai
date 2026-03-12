import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCheckpointRewriteCandidates,
  extractReplayCheckpoints,
} from '../src/oracle/oracle-script-checkpoints.mjs';

function buildFixtureOracle() {
  return {
    map_seed: 7004,
    difficulty: 'expert',
    grid: { width: 12, height: 10 },
    drop_off: [1, 8],
    bot_count: 2,
    known_orders: [
      { id: 'order_0', items_required: ['oats'], first_seen_tick: 0 },
      { id: 'order_1', items_required: ['milk'], first_seen_tick: 5 },
    ],
    items: [
      { id: 'item_oats_0', type: 'oats', position: [3, 3] },
      { id: 'item_milk_0', type: 'milk', position: [3, 5] },
    ],
  };
}

function writeReplay(rows) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-checkpoint-'));
  const replayPath = path.join(tempRoot, 'replay.jsonl');
  fs.writeFileSync(replayPath, rows.map((row) => JSON.stringify(row)).join('\n'));
  return replayPath;
}

test('checkpoint extraction is deterministic and captures score milestones', () => {
  const replayPath = writeReplay([
    { type: 'layout', grid: { width: 12, height: 10, walls: [] }, drop_off: [1, 8], max_rounds: 300 },
    {
      type: 'tick',
      tick: 0,
      actions_sent: [{ bot: 0, action: 'pick_up', item_id: 'item_oats_0' }],
      state_snapshot: { score: 0, bots: [{ id: 0, position: [9, 8], inventory: [] }], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 10,
      actions_sent: [{ bot: 0, action: 'drop_off' }],
      state_snapshot: { score: 20, bots: [{ id: 0, position: [1, 8], inventory: [] }], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 20,
      actions_sent: [{ bot: 0, action: 'drop_off' }],
      state_snapshot: { score: 40, bots: [{ id: 0, position: [1, 8], inventory: [] }], items: [], orders: [] },
    },
  ]);

  const first = extractReplayCheckpoints({ replayPath, maxTick: 100, scoreTargets: [20, 40] });
  const second = extractReplayCheckpoints({ replayPath, maxTick: 100, scoreTargets: [20, 40] });

  assert.deepEqual(first, second);
  assert.equal(first.some((checkpoint) => checkpoint.name === 'first_pickup_wave'), true);
  assert.equal(first.some((checkpoint) => checkpoint.name === 'score_20' && checkpoint.tick === 10), true);
  assert.equal(first.some((checkpoint) => checkpoint.name === 'score_40' && checkpoint.tick === 20), true);
});

test('checkpoint rewrite candidates preserve checkpoint state metadata and start from tick zero', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplay([
    { type: 'layout', grid: { width: 12, height: 10, walls: [] }, drop_off: [1, 8], max_rounds: 300 },
    {
      type: 'tick',
      tick: 0,
      actions_sent: [{ bot: 0, action: 'move_left' }],
      state_snapshot: { score: 0, bots: [{ id: 0, position: [9, 8], inventory: [] }, { id: 1, position: [8, 8], inventory: [] }], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 1,
      actions_sent: [{ bot: 0, action: 'drop_off' }],
      state_snapshot: { score: 6, bots: [{ id: 0, position: [1, 8], inventory: [] }, { id: 1, position: [8, 8], inventory: [] }], items: [], orders: [] },
    },
  ]);

  const candidates = buildCheckpointRewriteCandidates({
    oracle,
    replayPath,
    maxTick: 100,
    scoreTargets: [6],
  });

  assert.ok(candidates.length > 0);
  const candidate = candidates[0].script;
  assert.equal(candidate.strategy, 'checkpoint_rewriter');
  assert.equal(candidate.checkpoint_rewriter_meta.start_tick, 0);
  assert.equal(candidate.checkpoint_rewriter_meta.target_score, 6);
  assert.equal(candidate.settings.checkpointName, candidate.checkpoint_rewriter_meta.milestone);
  assert.ok(candidate.checkpoint_rewriter_meta.state_snapshot);
});

