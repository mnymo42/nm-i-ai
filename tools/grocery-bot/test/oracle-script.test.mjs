import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOracleScript } from '../src/oracle-script-evaluator.mjs';
import { loadOracleFile, loadScriptFile } from '../src/oracle-script-io.mjs';
import { buildOracleScriptWorld, normalizeOracle } from '../src/oracle-script-world.mjs';
import { buildOrderAssignments, generateOracleScript } from '../src/oracle-script-optimizer.mjs';

function buildFixtureOracle() {
  return {
    map_seed: 7004,
    difficulty: 'expert',
    grid: { width: 12, height: 10 },
    drop_off: [1, 8],
    bot_count: 3,
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

function writeFixtureReplay(oracle) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-replay-'));
  const replayPath = path.join(tempRoot, 'replay.jsonl');
  const rows = [
    {
      type: 'layout',
      grid: { width: oracle.grid.width, height: oracle.grid.height, walls: [] },
      drop_off: oracle.drop_off,
      max_rounds: 300,
    },
    {
      type: 'tick',
      tick: 0,
      state_snapshot: {
        bots: [
          { id: 0, position: [9, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [],
      },
    },
  ];
  fs.writeFileSync(replayPath, rows.map((row) => JSON.stringify(row)).join('\n'));
  return replayPath;
}

test('global shelf allocation uses each shelf at most once on real oracle fixture', () => {
  const oraclePath = path.resolve(process.cwd(), 'tools/grocery-bot/config/oracle-expert.json');
  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
  const normalized = normalizeOracle(oracle);
  const world = buildOracleScriptWorld({ oracle: normalized });
  const allocations = buildOrderAssignments(normalized, world.itemsByType, world.dropOff);
  const used = new Set();

  for (const order of allocations) {
    for (const allocation of order.allocations) {
      assert.equal(used.has(allocation.itemId), false, `duplicate item allocation: ${allocation.itemId}`);
      used.add(allocation.itemId);
    }
  }
});

test('generated script is valid, staggered at drop-off, and reports actual cutoff', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const script = generateOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    options: { targetCutoffTick: 40 },
  });

  assert.ok(script.orders_covered >= 2);
  assert.equal(script.last_scripted_tick, Math.max(...script.ticks.map((tick) => tick.tick)));
  assert.equal(typeof script.cutoff_reason, 'string');
  assert.ok(Array.isArray(script.per_order_estimates));
  assert.ok(script.aggregate_efficiency.total_picks > 0);
  assert.ok(script.aggregate_efficiency.total_drops > 0);

  const dropsByTick = new Map();
  for (const tick of script.ticks) {
    const dropCount = tick.actions.filter((action) => action.action === 'drop_off').length;
    dropsByTick.set(tick.tick, dropCount);
  }
  for (const dropCount of dropsByTick.values()) {
    assert.ok(dropCount <= 1, 'drop-off should be a unary resource');
  }

  const evaluation = evaluateOracleScript({ oracle, script, replayPath, maxTripItems: 2 });
  assert.equal(evaluation.valid, true);
  assert.equal(evaluation.lastScriptedTick, script.last_scripted_tick);
});

test('generator schedules visible next-order work and never pre-picks hidden future orders', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const script = generateOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    options: { targetCutoffTick: 40 },
  });

  const itemToOrder = new Map(script.per_order_estimates.map((entry) => [entry.order_id, new Set(entry.assigned_shelf_ids)]));
  const order1Items = itemToOrder.get('order_1');
  const order2Items = itemToOrder.get('order_2') || new Set();
  let order1FirstPickTick = null;

  for (const tick of script.ticks) {
    for (const action of tick.actions) {
      if (action.action !== 'pick_up') {
        continue;
      }
      if (order1Items.has(action.item_id) && order1FirstPickTick === null) {
        order1FirstPickTick = tick.tick;
      }
      if (order2Items.has(action.item_id)) {
        assert.ok(tick.tick >= 20, 'hidden future order item was picked before release');
      }
    }
  }

  assert.notEqual(order1FirstPickTick, null);
  assert.ok(order1FirstPickTick >= 0, 'next visible order should receive scripted pickup work');
});

test('oracle/script file loaders expose parsed oracle and tickMap data', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-script-'));
  const oraclePath = path.join(tempRoot, 'oracle.json');
  const scriptPath = path.join(tempRoot, 'script.json');
  const oracle = buildFixtureOracle();
  const script = {
    last_scripted_tick: 1,
    ticks: [
      { tick: 0, actions: [{ bot: 0, action: 'wait' }] },
      { tick: 1, actions: [{ bot: 0, action: 'drop_off' }] },
    ],
  };
  fs.writeFileSync(oraclePath, JSON.stringify(oracle));
  fs.writeFileSync(scriptPath, JSON.stringify(script));

  const loadedOracle = loadOracleFile(oraclePath);
  const loadedScript = loadScriptFile(scriptPath);

  assert.equal(loadedOracle.ok, true);
  assert.equal(loadedOracle.data.known_orders.length, 3);
  assert.equal(loadedScript.ok, true);
  assert.deepEqual(loadedScript.data.tickMap.get(1), [{ bot: 0, action: 'drop_off' }]);
});

test('oracle evaluator allows stacked starting bots to wait on the same cell', () => {
  const oracle = buildFixtureOracle();
  const script = {
    ticks: [
      {
        tick: 0,
        actions: [
          { bot: 0, action: 'wait' },
          { bot: 1, action: 'wait' },
          { bot: 2, action: 'wait' },
        ],
      },
    ],
  };

  const evaluation = evaluateOracleScript({ oracle, script, maxTripItems: 2 });
  assert.equal(evaluation.valid, true);
});
