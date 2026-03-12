import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOracleScript } from '../src/oracle/oracle-script-evaluator.mjs';
import {
  compressOracleReplayScript,
  extractScriptFromReplay,
  findLongestMatchingReplayTick,
} from '../src/oracle/oracle-script-compressor.mjs';
import { loadOracleFile, loadScriptFile } from '../src/oracle/oracle-script-io.mjs';
import { buildLegacyOracleScript } from '../src/oracle/oracle-script-legacy.mjs';
import { assessScriptPromotion } from '../src/oracle/oracle-script-metrics.mjs';
import {
  buildOracleSearchReport,
  compareGeneratedScripts,
  generateBestOracleScript,
  generateOracleScriptCandidates,
} from '../src/oracle/oracle-script-search.mjs';
import {
  buildReplaySeededAislePartitionOptions,
  buildReplaySeededBucketOptions,
  buildReplaySeededDropLaneOptions,
  buildReplaySeededHandoffOptions,
  buildReplaySeededModularOptions,
  buildReplaySeededOpeningCapacityOptions,
  buildReplaySeededOpeningBucketOptions,
  buildReplaySeededRewindTicks,
  buildReplaySeededScoreTargets,
  buildReplaySeededWaveOptions,
  extractReplaySeedSkeleton,
} from '../src/oracle/oracle-script-replay-seed.mjs';
import { buildOracleScriptWorld, normalizeOracle } from '../src/oracle/oracle-script-world.mjs';
import { buildOrderAssignments, generateOracleScript } from '../src/oracle/oracle-script-optimizer.mjs';

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

test('shelf allocation uses each shelf at most once within a single order', () => {
  const oraclePath = path.resolve(process.cwd(), 'tools/grocery-bot/config/oracle-expert.json');
  const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
  const normalized = normalizeOracle(oracle);
  const world = buildOracleScriptWorld({ oracle: normalized });
  const allocations = buildOrderAssignments(normalized, world.itemsByType, world.dropOff);

  for (const order of allocations) {
    const usedInOrder = new Set();
    for (const allocation of order.allocations) {
      assert.equal(usedInOrder.has(allocation.itemId), false,
        `duplicate item within order ${order.orderId}: ${allocation.itemId}`);
      usedInOrder.add(allocation.itemId);
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
  const order0 = script.per_order_estimates.find((entry) => entry.order_id === 'order_0');
  assert.equal(order0.stage_hidden_known_orders, false);
  assert.deepEqual(order0.visible_future_orders, ['order_1']);
});

test('generator exposes hidden known orders to bucket scheduling when oracle-wide staging is enabled', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const script = generateOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    options: {
      targetCutoffTick: 40,
      maxActiveBots: 3,
      closeNowBotCap: 1,
      stageBotCap: 2,
      knownOrderDepth: 2,
      stageHiddenKnownOrders: true,
      futureOrderBotCap: 2,
      futureOrderItemCap: 2,
      futureOrderPerOrderItemCap: 1,
      closeOrderReserveBots: 1,
      validate: false,
    },
  });

  const order0 = script.per_order_estimates.find((entry) => entry.order_id === 'order_0');
  assert.equal(order0.stage_hidden_known_orders, true);
  assert.deepEqual(order0.visible_future_orders, ['order_1', 'order_2']);
});

test('generator can stage multiple visible future orders without skipping the active close', () => {
  const oracle = {
    ...buildFixtureOracle(),
    known_orders: [
      { id: 'order_0', items_required: ['oats'], first_seen_tick: 0 },
      { id: 'order_1', items_required: ['milk'], first_seen_tick: 0 },
      { id: 'order_2', items_required: ['eggs'], first_seen_tick: 0 },
    ],
  };
  const replayPath = writeFixtureReplay(oracle);
  const script = generateOracleScript({
    oracle,
    replayPath,
    oracleSource: 'fixture',
    options: {
      targetCutoffTick: 60,
      maxActiveBots: 2,
      visibleOrderDepth: 3,
      futureOrderBotCap: 1,
      futureOrderItemCap: 2,
      futureOrderPerOrderItemCap: 1,
      closeOrderReserveBots: 2,
      validate: false,
    },
  });

  const order0 = script.per_order_estimates.find((entry) => entry.order_id === 'order_0');
  assert.deepEqual(order0.visible_future_orders, ['order_1', 'order_2']);
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
    top: 20,
  });

  assert.ok(candidates.length > 0);
  assert.ok(best.orders_covered >= 0);
  assert.equal(report.candidates_tested, candidates.length);
  assert.equal(report.score_to_beat, 10);
  assert.equal(report.tick_to_beat, 35);
  assert.equal(report.objective, 'score_first');
  assert.ok(report.top_candidates.length <= 20);
  assert.equal(typeof report.best_candidate.beats_score_target, 'boolean');
  assert.equal(typeof report.top_candidates[0].score_at_tick_100, 'number');
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

test('handoff-value objective prefers higher score before earlier cutoff', () => {
  const earlyLow = {
    orders_covered: 2,
    estimated_score: 20,
    last_scripted_tick: 150,
    aggregate_efficiency: { total_waits: 50 },
  };
  const lateHigh = {
    orders_covered: 2,
    estimated_score: 24,
    last_scripted_tick: 180,
    aggregate_efficiency: { total_waits: 80 },
  };

  assert.equal(compareGeneratedScripts(earlyLow, lateHigh, 'handoff_value') > 0, true);
});

test('score-by-tick-100 objective prefers stronger early score over later total score', () => {
  const earlyStrong = {
    estimated_score: 70,
    last_scripted_tick: 90,
    aggregate_efficiency: { total_waits: 100 },
    replay_target_meta: {
      score_timeline: [{ tick: 90, score: 70 }],
    },
  };
  const lateHigher = {
    estimated_score: 89,
    last_scripted_tick: 298,
    aggregate_efficiency: { total_waits: 50 },
    replay_target_meta: {
      score_timeline: [{ tick: 100, score: 20 }, { tick: 298, score: 89 }],
    },
  };

  assert.equal(compareGeneratedScripts(earlyStrong, lateHigher, 'score_by_tick_100') < 0, true);
});

test('score-by-tick-100 objective penalizes non-promotable late-score candidates', () => {
  const promotable = {
    estimated_score: 22,
    last_scripted_tick: 103,
    aggregate_efficiency: { total_waits: 100 },
    replay_target_meta: { score_timeline: [{ tick: 100, score: 22 }] },
    search_meta: { triage: { promotable: true, baseline_match: false, baseline_beat: true, penalties: [] } },
  };
  const nonPromotable = {
    estimated_score: 89,
    last_scripted_tick: 298,
    aggregate_efficiency: { total_waits: 50 },
    replay_target_meta: { score_timeline: [{ tick: 100, score: 22 }, { tick: 298, score: 89 }] },
    search_meta: { triage: { promotable: false, baseline_match: true, baseline_beat: false, penalties: ['drop_lane_congestion'] } },
  };

  assert.equal(compareGeneratedScripts(promotable, nonPromotable, 'score_by_tick_100') < 0, true);
});

test('promotion triage rejects candidates that tie early score but regress on productive bot ticks', () => {
  const report = assessScriptPromotion({
    replay_target_meta: { score_timeline: [{ tick: 100, score: 22 }] },
    evaluation: {
      tickProfiles: [
        { productive_bot_ticks: 4, waiting_bot_ticks: 6, blocked_bot_ticks: 0 },
        { productive_bot_ticks: 4, waiting_bot_ticks: 6, blocked_bot_ticks: 0 },
      ],
      finalBots: [],
      dropOff: [1, 8],
    },
  }, {
    score_at_tick_100: 22,
    dead_opening_ticks: 101,
    productive_bot_ticks: 20,
  });

  assert.equal(report.baseline_match, true);
  assert.equal(report.promotable, false);
  assert.ok(report.penalties.includes('productive_bot_tick_regression'));
});

test('throughput-frontier objective prefers candidates that hit milestones earlier', () => {
  const slower = {
    estimated_score: 80,
    last_scripted_tick: 100,
    aggregate_efficiency: { total_waits: 100 },
    replay_target_meta: {
      score_timeline: [{ tick: 40, score: 40 }, { tick: 70, score: 60 }, { tick: 100, score: 80 }],
    },
  };
  const faster = {
    estimated_score: 75,
    last_scripted_tick: 95,
    aggregate_efficiency: { total_waits: 100 },
    replay_target_meta: {
      score_timeline: [{ tick: 20, score: 40 }, { tick: 45, score: 60 }, { tick: 80, score: 75 }],
    },
  };

  assert.equal(compareGeneratedScripts(slower, faster, 'throughput_frontier') > 0, true);
});

test('live-worthy objective prefers strong middle handoff over late preserve script', () => {
  const middleStrong = {
    orders_covered: 6,
    estimated_score: 75,
    last_scripted_tick: 260,
    aggregate_efficiency: { total_waits: 400 },
  };
  const lateHigher = {
    orders_covered: 7,
    estimated_score: 85,
    last_scripted_tick: 276,
    aggregate_efficiency: { total_waits: 350 },
  };
  const tooEarlyWeak = {
    orders_covered: 4,
    estimated_score: 50,
    last_scripted_tick: 194,
    aggregate_efficiency: { total_waits: 250 },
  };

  assert.equal(compareGeneratedScripts(middleStrong, lateHigher, 'live_worthy') < 0, true);
  assert.equal(compareGeneratedScripts(middleStrong, tooEarlyWeak, 'live_worthy') < 0, true);
});

test('replay seed skeleton extracts stable completion cadence from replay', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: {
        score: 0,
        bots: [
          { id: 0, position: [9, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [
          { id: 'order_0', items_required: ['oats'], items_delivered: [], status: 'active', complete: false },
        ],
      },
      actions_sent: [{ bot: 0, action: 'wait' }],
    },
    {
      type: 'tick',
      tick: 5,
      state_snapshot: {
        score: 6,
        bots: [
          { id: 0, position: [1, 8], inventory: [] },
          { id: 1, position: [8, 8], inventory: [] },
          { id: 2, position: [7, 8], inventory: [] },
        ],
        items: oracle.items,
        orders: [
          { id: 'order_0', items_required: ['oats'], items_delivered: ['oats'], status: 'complete', complete: true },
          { id: 'order_1', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
        ],
      },
      actions_sent: [{ bot: 0, action: 'drop_off' }],
    },
  ]);

  const skeleton = extractReplaySeedSkeleton({ replayPath, oracle });
  assert.equal(skeleton.completionSequence.length, 1);
  assert.equal(skeleton.completionSequence[0].orderId, 'order_0');
  assert.equal(skeleton.completionSequence[0].completionTick, 5);
});

test('replay-seeded option builders are deterministic for the same replay', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeFixtureReplay(oracle);
  const first = extractReplaySeedSkeleton({ replayPath, oracle });
  const second = extractReplaySeedSkeleton({ replayPath, oracle });

  assert.deepEqual(first, second);
  assert.deepEqual(buildReplaySeededModularOptions({ skeleton: first }), buildReplaySeededModularOptions({ skeleton: second }));
  assert.deepEqual(buildReplaySeededWaveOptions({ skeleton: first }), buildReplaySeededWaveOptions({ skeleton: second }));
  const firstBucket = buildReplaySeededBucketOptions({ skeleton: first });
  const secondBucket = buildReplaySeededBucketOptions({ skeleton: second });
  assert.deepEqual(firstBucket, secondBucket);
  assert.ok(firstBucket.length > 0);
  assert.ok(firstBucket.every((options) => options.stageHiddenKnownOrders === true));
  assert.ok(firstBucket.every((options) => options.knownOrderDepth >= options.visibleOrderDepth));
  const openingBucket = buildReplaySeededOpeningBucketOptions({ skeleton: first });
  assert.ok(openingBucket.every((options) => options.openingFocus === true));
  const openingCapacity = buildReplaySeededOpeningCapacityOptions({ skeleton: first });
  assert.ok(openingCapacity.every((options) => options.openingCapacityV1 === true));
  assert.ok(openingCapacity.every((options) => Array.isArray(options.openingTeamSplit)));
  const dropLane = buildReplaySeededDropLaneOptions({ skeleton: first });
  assert.ok(dropLane.every((options) => options.dropLaneScheduler === true));
  const aislePartition = buildReplaySeededAislePartitionOptions({ skeleton: first });
  assert.ok(aislePartition.every((options) => options.aislePartitionWeight > 0));
  assert.deepEqual(buildReplaySeededHandoffOptions({ skeleton: first }), buildReplaySeededHandoffOptions({ skeleton: second }));
});

test('replay score targets and rewind ticks expose a richer handoff frontier', () => {
  const oracle = buildFixtureOracle();
  const replayPath = writeReplayWithActions(oracle, [
    {
      type: 'tick',
      tick: 0,
      state_snapshot: { score: 0, bots: [], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 5,
      state_snapshot: { score: 6, bots: [], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 10,
      state_snapshot: { score: 11, bots: [], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 15,
      state_snapshot: { score: 19, bots: [], items: [], orders: [] },
    },
    {
      type: 'tick',
      tick: 20,
      state_snapshot: { score: 27, bots: [], items: [], orders: [] },
    },
  ]);

  assert.deepEqual(buildReplaySeededScoreTargets({ replayPath }), [6, 11, 19, 27]);
  assert.deepEqual(buildReplaySeededRewindTicks({ targetScore: 85 }), [0, 4, 8, 12, 16, 24]);
  assert.deepEqual(buildReplaySeededRewindTicks({ targetScore: 45 }), [0, 4, 8, 12]);
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
  assert.equal(script.ticks[0].expected_state.type, null);
  assert.equal(script.ticks[0].expected_state.round, null);
  assert.equal(script.ticks[0].expected_state.max_rounds, 300);
  assert.equal(script.ticks[0].expected_state.score, 0);
  assert.deepEqual(script.ticks[0].expected_state.drop_off, oracle.drop_off);
  assert.deepEqual(script.ticks[0].expected_state.drop_offs, [oracle.drop_off]);
  assert.deepEqual(script.ticks[0].expected_state.bots, [
    { id: 0, position: [9, 8], inventory: [] },
  ]);
  assert.deepEqual(script.ticks[0].expected_state.items, []);
  assert.deepEqual(script.ticks[0].expected_state.orders, []);
});

test('replay compression supports wider rewind windows for handoff exploration', () => {
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
      actions_sent: [{ bot: 0, action: 'move_left' }],
      state_snapshot: {
        score: 0,
        bots: [{ id: 0, position: [8, 8], inventory: [] }],
      },
    },
    {
      type: 'tick',
      tick: 2,
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
    rewindTicks: 2,
  });

  assert.equal(script.last_scripted_tick, 0);
  assert.equal(script.replay_target_meta.rewind_ticks, 2);
  assert.equal(script.replay_target_meta.script_cutoff_tick, 0);
  assert.equal(script.replay_target_meta.score_at_tick_100, 0);
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
  assert.equal(compressed.ticks[0].expected_state.type, null);
  assert.equal(compressed.ticks[0].expected_state.round, null);
  assert.equal(compressed.ticks[0].expected_state.max_rounds, 300);
  assert.equal(compressed.ticks[0].expected_state.score, 0);
  assert.deepEqual(compressed.ticks[0].expected_state.drop_off, oracle.drop_off);
  assert.deepEqual(compressed.ticks[0].expected_state.drop_offs, [oracle.drop_off]);
  assert.deepEqual(compressed.ticks[0].expected_state.bots, [
    { id: 0, position: [4, 8], inventory: [] },
    { id: 1, position: [8, 8], inventory: [] },
    { id: 2, position: [7, 8], inventory: [] },
  ]);
  assert.equal(compressed.ticks[0].expected_state.items.length, oracle.items.length);
  assert.deepEqual(compressed.ticks[0].expected_state.orders, []);
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
