import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOracleScript } from '../src/oracle-script-evaluator.mjs';
import {
  compressOracleReplayScript,
  extractScriptFromReplay,
  findLongestMatchingReplayTick,
} from '../src/oracle-script-compressor.mjs';
import { loadOracleFile, loadScriptFile } from '../src/oracle-script-io.mjs';
import { buildLegacyOracleScript } from '../src/oracle-script-legacy.mjs';
import {
  buildOracleSearchReport,
  compareGeneratedScripts,
  generateBestOracleScript,
  generateOracleScriptCandidates,
} from '../src/oracle-script-search.mjs';
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

function writeReplayWithActions(oracle, tickRows) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-replay-actions-'));
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

test('legacy oracle generator produces a valid script on the fixture', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const script = buildLegacyOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    options: { maxTripItems: 1, prefetchDepth: 1, targetCutoffTick: 40 },
  });

  assert.equal(script.strategy, 'legacy');
  assert.equal(script.evaluation.valid, true);
  assert.ok(script.last_scripted_tick <= 40);
});

test('oracle search returns ranked candidates and a best script', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const candidates = generateOracleScriptCandidates({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    strategy: 'auto',
  });

  assert.ok(candidates.length > 0);
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1].script;
    const current = candidates[index].script;
    assert.ok(
      previous.orders_covered > current.orders_covered
        || (previous.orders_covered === current.orders_covered && previous.estimated_score >= current.estimated_score),
    );
  }

  const { best } = generateBestOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    strategy: 'auto',
  });
  assert.ok(best.orders_covered >= candidates[0].script.orders_covered);
});

test('wide oracle search report includes target metadata and ranked candidates', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const { best, candidates } = generateBestOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    strategy: 'auto',
    candidateLimit: 12,
    seed: 123,
    searchSpace: 'wide',
  });
  const report = buildOracleSearchReport({
    candidates,
    scoreToBeat: 10,
    tickToBeat: 35,
    top: 5,
  });

  assert.ok(candidates.length > 0);
  assert.ok(best.orders_covered >= 0);
  assert.equal(report.candidates_tested, candidates.length);
  assert.equal(report.score_to_beat, 10);
  assert.equal(report.tick_to_beat, 35);
  assert.equal(report.objective, 'score_first');
  assert.ok(report.top_candidates.length <= 5);
  assert.equal(typeof report.best_candidate.beats_score_target, 'boolean');
});

test('oracle search progress callback includes current best candidate summary', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const progressEvents = [];

  generateOracleScriptCandidates({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    strategy: 'auto',
    candidateLimit: 6,
    seed: 123,
    searchSpace: 'wide',
    onProgress(event) {
      progressEvents.push(event);
    },
  });

  assert.ok(progressEvents.length > 0);
  const last = progressEvents.at(-1);
  assert.equal(last.completed, last.total);
  assert.ok(last.best);
  assert.equal(typeof last.best.ordersCovered, 'number');
  assert.equal(typeof last.best.estimatedScore, 'number');
  assert.equal(typeof last.best.lastScriptedTick, 'number');
});

test('handoff-first objective prefers earlier script cutoff over slightly higher score', () => {
  const early = {
    orders_covered: 2,
    estimated_score: 20,
    last_scripted_tick: 180,
    aggregate_efficiency: { total_waits: 100 },
  };
  const late = {
    orders_covered: 2,
    estimated_score: 22,
    last_scripted_tick: 260,
    aggregate_efficiency: { total_waits: 80 },
  };

  const scoreFirst = generateOracleScriptCandidates;
  assert.equal(
    // late wins on score-first
    compareGeneratedScripts(early, late, 'score_first') > 0,
    true,
  );
  assert.equal(
    // early wins on handoff-first
    compareGeneratedScripts(early, late, 'handoff_first') < 0,
    true,
  );
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
  assert.equal(loadedScript.data.entryMap.get(1).tick, 1);
});

test('replay compression preserves expected state and reports actual script-end score', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      actions_sent: [{ bot: 0, action: 'move_left' }],
      state_snapshot: {
        score: 0,
        bots: [{ id: 0, position: [9, 8], inventory: [] }],
      },
    },
    {
      type: 'tick',
      tick: 1,
      actions_sent: [{ bot: 0, action: 'drop_off' }],
      state_snapshot: {
        score: 5,
        bots: [{ id: 0, position: [1, 8], inventory: ['oats'] }],
      },
    },
  ]);

  const script = compressOracleReplayScript({
    oracle,
    replayPath,
    targetScore: 5,
    mode: 'handoff_early',
  });

  assert.equal(script.last_scripted_tick, 0);
  assert.equal(script.estimated_score, 0);
  assert.equal(script.replay_target_meta.target_score, 5);
  assert.equal(script.replay_target_meta.target_reachable_within_prefix, true);
  assert.equal(script.replay_target_meta.score_at_script_end, 0);
  assert.equal(script.replay_target_meta.compression_mode, 'handoff_early');
  assert.deepEqual(script.ticks[0].expected_state, {
    score: 0,
    bots: [{ id: 0, position: [9, 8], inventory: [] }],
  });
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

test('extractScriptFromReplay preserves tick actions up to stop tick', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplayWithActions(oracle, [
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
      actions_sent: [
        { bot: 0, action: 'move_left' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: {
        bots: [
          { id: 0, position: [8, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'wait' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
  ]);

  const script = extractScriptFromReplay(replayPath, 0);
  assert.equal(script.ticks.length, 1);
  assert.deepEqual(script.ticks[0].actions[0], { bot: 0, action: 'move_left' });
});

test('replay compressor rewinds to earliest tick that reaches the target score', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_up' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 7], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'wait' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 2,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 7], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_up' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 3,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 6], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'pick_up', item_id: 'item_oats_0' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 4,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 6], inventory: ['oats'] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_down' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 5,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 7], inventory: ['oats'] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_down' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 6,
      state_snapshot: {
        bots: [
          { id: 0, position: [4, 8], inventory: ['oats'] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_left' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 7,
      state_snapshot: {
        bots: [
          { id: 0, position: [3, 8], inventory: ['oats'] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_left' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 8,
      state_snapshot: {
        bots: [
          { id: 0, position: [2, 8], inventory: ['oats'] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'move_left' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 9,
      state_snapshot: {
        bots: [
          { id: 0, position: [1, 8], inventory: ['oats'] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
      },
      actions_sent: [
        { bot: 0, action: 'drop_off' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
    {
      type: 'tick',
      tick: 10,
      state_snapshot: {
        bots: [
          { id: 0, position: [1, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items.filter((item) => item.id !== 'item_oats_0'),
        orders: [],
        score: 6,
      },
      actions_sent: [
        { bot: 0, action: 'wait' },
        { bot: 1, action: 'wait' },
        { bot: 2, action: 'wait' },
      ],
    },
  ]);

  const compressed = compressOracleReplayScript({
    oracle,
    replayPath,
  });

  assert.equal(compressed.estimated_score, 6);
  assert.equal(compressed.replay_target_meta.target_score, 6);
  assert.equal(compressed.replay_target_meta.target_reachable_within_prefix, true);
  assert.equal(compressed.replay_target_meta.score_at_script_end, 6);
  assert.equal(compressed.replay_target_meta.compression_mode, 'preserve_score');
  assert.equal(compressed.last_scripted_tick, 10);
  assert.equal(compressed.replay_target_meta.final_tick_delta, 0);
  assert.deepEqual(compressed.ticks[0].expected_state, {
    score: 0,
    bots: [
      { id: 0, position: [4, 8], inventory: [] },
      { id: 1, position: [8, 8], inventory: [] },
      { id: 2, position: [7, 8], inventory: [] },
    ],
  });
});

test('replay compressor supports explicit handoff_early mode', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: { bots: [{ id: 0, position: [1, 1], inventory: [] }], score: 0 },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: { bots: [{ id: 0, position: [1, 1], inventory: [] }], score: 5 },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
  ]);

  const compressed = compressOracleReplayScript({
    oracle,
    replayPath,
    targetScore: 5,
    mode: 'handoff_early',
  });

  assert.equal(compressed.strategy, 'replay_rewind_handoff_v1');
  assert.equal(compressed.estimated_score, 0);
  assert.equal(compressed.last_scripted_tick, 0);
  assert.equal(compressed.replay_target_meta.final_tick_delta, 1);
  assert.equal(compressed.replay_target_meta.target_reachable_within_prefix, true);
});

test('findLongestMatchingReplayTick returns the last replay-stable tick', () => {
  const oracle = buildFixtureOracle();
  const sourceReplayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 2], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'move_down' }],
    },
    {
      type: 'tick',
      tick: 2,
      state_snapshot: { score: 1, bots: [{ id: 0, position: [1, 2], inventory: ['oats'] }] },
      actions_sent: [{ bot: 0, action: 'pick_up', item_id: 'item_oats_0' }],
    },
  ]);
  const validationReplayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 2], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'move_down' }],
    },
    {
      type: 'tick',
      tick: 2,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [2, 2], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'move_right' }],
    },
  ]);

  assert.equal(findLongestMatchingReplayTick(sourceReplayPath, validationReplayPath), 1);
});

test('replay compressor can cap output to the validated safe prefix', () => {
  const oracle = buildFixtureOracle();
  const sourceReplayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: { score: 2, bots: [{ id: 0, position: [1, 2], inventory: ['oats'] }] },
      actions_sent: [{ bot: 0, action: 'drop_off' }],
    },
    {
      type: 'tick',
      tick: 2,
      state_snapshot: { score: 5, bots: [{ id: 0, position: [1, 2], inventory: ['oats'] }] },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
  ]);
  const validationReplayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [1, 1], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
    {
      type: 'tick',
      tick: 1,
      state_snapshot: { score: 2, bots: [{ id: 0, position: [1, 2], inventory: ['oats'] }] },
      actions_sent: [{ bot: 0, action: 'drop_off' }],
    },
    {
      type: 'tick',
      tick: 2,
      state_snapshot: { score: 0, bots: [{ id: 0, position: [2, 2], inventory: [] }] },
      actions_sent: [{ bot: 0, action: 'move_right' }],
    },
  ]);

  const compressed = compressOracleReplayScript({
    oracle,
    replayPath: sourceReplayPath,
    validationReplayPath,
    targetScore: 5,
    mode: 'preserve_score',
  });

  assert.equal(compressed.last_scripted_tick, 1);
  assert.equal(compressed.estimated_score, 2);
  assert.equal(compressed.replay_target_meta.safe_prefix_tick, 1);
  assert.equal(compressed.replay_target_meta.target_reachable_within_prefix, false);
  assert.equal(compressed.replay_target_meta.target_tick, null);
});
