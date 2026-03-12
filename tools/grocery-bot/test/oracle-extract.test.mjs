import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayLogger } from '../src/replay/replay.mjs';
import { extractOracleFromReplayCorpus } from '../src/oracle/oracle-extract.mjs';

function writeExpertReplay(outDir, runId, ordersByTick) {
  const runDir = path.join(outDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const replayPath = path.join(runDir, 'replay.jsonl');
  const logger = new ReplayLogger(replayPath);
  logger.log({
    type: 'layout',
    grid: { width: 12, height: 10, walls: [] },
    drop_off: [1, 8],
    max_rounds: 300,
  });

  for (const [tick, orders] of ordersByTick.entries()) {
    logger.log({
      type: 'tick',
      tick,
      state_snapshot: {
        round: tick,
        score: 0,
        bots: [
          { id: 0, position: [9, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
        ],
        items: [
          { id: 'item_milk_0', type: 'milk', position: [3, 3] },
          { id: 'item_oats_0', type: 'oats', position: [5, 3] },
        ],
        orders,
      },
    });
  }
  logger.close();
}

test('extractOracleFromReplayCorpus aggregates expert orders from matching runs', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-extract-'));
  writeExpertReplay(outDir, '2026-03-08T10-50-21-635Z-expert-expert', new Map([
    [0, [{ id: 'order_0', items_required: ['milk'], first_seen_tick: 0 }]],
    [5, [
      { id: 'order_0', items_required: ['milk'], first_seen_tick: 0 },
      { id: 'order_1', items_required: ['oats'], first_seen_tick: 5 },
    ]],
  ]));
  writeExpertReplay(outDir, '2026-03-08T10-39-20-479Z-expert-expert_replay_handoff', new Map([
    [0, [{ id: 'order_2', items_required: ['milk'], first_seen_tick: 0 }]],
  ]));

  const outPath = path.join(outDir, 'oracle.json');
  const { oracle, sources } = extractOracleFromReplayCorpus({
    outDir,
    difficulty: 'expert',
    profile: 'expert',
    outputPath: outPath,
    mapSeed: 7004,
  });

  assert.equal(oracle.known_orders.length, 2);
  assert.deepEqual(oracle.known_orders.map((order) => order.id), ['order_0', 'order_1']);
  assert.equal(sources.length, 1);
  assert.equal(fs.existsSync(outPath), true);
});
