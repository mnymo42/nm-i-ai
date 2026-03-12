import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { generateOracleScript } from '../src/oracle/oracle-script-optimizer.mjs';

function buildFixtureOracle() {
  return {
    map_seed: 7004,
    difficulty: 'expert',
    grid: { width: 12, height: 10 },
    drop_off: [1, 8],
    bot_count: 4,
    known_orders: [
      { id: 'order_0', items_required: ['oats'], first_seen_tick: 0 },
      { id: 'order_1', items_required: ['milk'], first_seen_tick: 4 },
      { id: 'order_2', items_required: ['eggs'], first_seen_tick: 20 },
    ],
    items: [
      { id: 'item_oats_0', type: 'oats', position: [3, 3] },
      { id: 'item_milk_0', type: 'milk', position: [3, 5] },
      { id: 'item_eggs_0', type: 'eggs', position: [5, 5] },
    ],
  };
}

function writeReplayWithActions(oracle, tickRows) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-opening-capacity-'));
  const replayPath = path.join(tempRoot, 'replay.jsonl');
  const rows = [
    {
      type: 'layout',
      grid: { width: oracle.grid.width, height: oracle.grid.height, walls: [] },
      drop_off: oracle.drop_off,
      max_rounds: 300,
    },
    ...tickRows,
  ];
  fs.writeFileSync(replayPath, rows.map((row) => JSON.stringify(row)).join('\n'));
  return replayPath;
}

function writeStackedStartReplay(oracle, botCount = 4, start = [9, 8]) {
  const bots = Array.from({ length: botCount }, (_, id) => ({
    id,
    position: [...start],
    inventory: [],
  }));
  return writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: {
        score: 0,
        bots,
        items: oracle.items,
        orders: [],
      },
      actions_sent: bots.map((bot) => ({ bot: bot.id, action: 'wait' })),
      sanitizer_overrides: [],
    },
  ]);
}

test('opening-capacity generator releases stacked bots in pairs and records opening metadata', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeStackedStartReplay(oracle, 4);
  const script = generateOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    options: {
      openingCapacityV1: true,
      openingPairReleaseCadence: 'wait_turn',
      openingAlignmentTarget: 'bottom_row',
      openingTeamSplit: [3, 3, 2, 2],
      openingFutureOrderDepth: 2,
      openingFutureOrderBotCaps: [3, 2],
      maxActiveBots: 4,
      closeNowBotCap: 3,
      stageBotCap: 1,
      stageHiddenKnownOrders: true,
      knownOrderDepth: 2,
      futureOrderBotCap: 2,
      futureOrderItemCap: 2,
      futureOrderPerOrderItemCap: 1,
      targetCutoffTick: 60,
    },
  });

  assert.equal(script.evaluation.valid, true);
  assert.equal(script.opening_strategy.family, 'opening_capacity_v1');
  assert.ok(script.opening_strategy.steps.some((step) => step.phase === 'release_pairs'));
  assert.ok(script.per_order_estimates[0].close_now_bot_ids.length > 0);
  assert.deepEqual(script.per_order_estimates[0].future_order_bot_caps, [3, 2]);
  const firstTickActions = script.ticks[0].actions.map((action) => action.action);
  assert.ok(firstTickActions.includes('move_up'));
  assert.ok(firstTickActions.includes('move_left'));
});
