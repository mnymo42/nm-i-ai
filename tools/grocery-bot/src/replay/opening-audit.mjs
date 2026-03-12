import fs from 'node:fs';
import path from 'node:path';

import { manhattanDistance } from '../utils/coords.mjs';
import { loadOracleFile, loadScriptFile } from '../oracle/oracle-script-io.mjs';
import { evaluateOracleScript } from '../oracle/oracle-script-evaluator.mjs';
import { extractLayout, parseJsonl, rebuildSnapshot } from './replay-io.mjs';

function loadReplayTicks(replayPath, maxTick = 120) {
  const rows = parseJsonl(replayPath);
  const layout = extractLayout(rows);
  return rows
    .filter((row) => row.type === 'tick' && row.tick <= maxTick)
    .map((row) => ({
      ...row,
      state_snapshot: rebuildSnapshot(row.state_snapshot, layout),
    }));
}

function countDeliverableInventory(inventory, activeOrder) {
  if (!activeOrder) {
    return 0;
  }
  const remaining = new Map();
  for (const type of activeOrder.items_required || []) {
    remaining.set(type, (remaining.get(type) || 0) + 1);
  }
  for (const delivered of activeOrder.items_delivered || []) {
    remaining.set(delivered, Math.max(0, (remaining.get(delivered) || 0) - 1));
  }
  let deliverable = 0;
  for (const type of inventory || []) {
    const count = remaining.get(type) || 0;
    if (count > 0) {
      remaining.set(type, count - 1);
      deliverable += 1;
    }
  }
  return deliverable;
}

function getActiveOrder(snapshot) {
  return (snapshot?.orders || []).find((order) => !(order.complete || order.status === 'complete')) || null;
}

function buildReplayOpeningProfile(replayPath, maxTick = 120) {
  const ticks = loadReplayTicks(replayPath, maxTick);
  const perTick = ticks.map((row) => {
    const snapshot = row.state_snapshot || {};
    const activeOrder = getActiveOrder(snapshot);
    const bots = snapshot.bots || [];
    const actions = row.actions_sent || row.actions_planned || [];
    const productiveBotTicks = actions.filter((action) => action.action !== 'wait').length;
    const waitingBotTicks = Math.max(0, bots.length - productiveBotTicks);
    const carryingDeliverableBots = bots.filter((bot) => countDeliverableInventory(bot.inventory, activeOrder) > 0).length;
    const stagedFutureBots = bots.filter((bot) => (bot.inventory || []).length > 0 && countDeliverableInventory(bot.inventory, activeOrder) === 0).length;
    const sanitizerOverrides = row.sanitizer_overrides?.length || 0;
    const pickupActions = actions.filter((action) => action.action === 'pick_up').length;
    const dropActions = actions.filter((action) => action.action === 'drop_off').length;
    return {
      tick: row.tick,
      score: snapshot.score ?? 0,
      productive_bot_ticks: productiveBotTicks,
      waiting_bot_ticks: waitingBotTicks,
      blocked_bot_ticks: sanitizerOverrides,
      carrying_deliverable_bots: carryingDeliverableBots,
      staged_future_bots: stagedFutureBots,
      pickup_actions: pickupActions,
      drop_actions: dropActions,
      drop_lane_occupied: dropActions > 0,
      active_order_id: activeOrder?.id || null,
    };
  });
  const lastSnapshot = ticks.at(-1)?.state_snapshot || {};
  const dropOff = ticks.at(0)?.drop_off || null;
  return {
    ...summarizeOpeningProfile(perTick, maxTick),
    handoff_readiness: {
      stranded_inventory: (lastSnapshot.bots || []).reduce((sum, bot) => sum + ((bot.inventory || []).length), 0),
      bots_near_drop: dropOff ? (lastSnapshot.bots || []).filter((bot) => manhattanDistance(bot.position, dropOff) <= 2).length : 0,
      staged_future_bots: perTick.at(-1)?.staged_future_bots ?? 0,
    },
  };
}

function summarizeOpeningProfile(perTick, maxTick = 120) {
  function scoreAtTick(targetTick) {
    let score = 0;
    for (const tick of perTick) {
      if (tick.tick > targetTick) {
        break;
      }
      score = tick.score;
    }
    return score;
  }

  const firstPickupTick = perTick.find((tick) => tick.pickup_actions > 0)?.tick ?? null;
  const firstDropTick = perTick.find((tick) => tick.drop_actions > 0)?.tick ?? null;
  const firstScoreTick = perTick.find((tick) => tick.score > 0)?.tick ?? null;
  const finalScore = perTick.at(-1)?.score ?? 0;
  return {
    max_tick: maxTick,
    first_pickup_tick: firstPickupTick,
    first_drop_tick: firstDropTick,
    first_score_tick: firstScoreTick,
    final_score: finalScore,
    score_at_tick_60: scoreAtTick(60),
    score_at_tick_80: scoreAtTick(80),
    score_at_tick_100: scoreAtTick(100),
    score_at_tick_120: scoreAtTick(120),
    productive_bot_ticks: perTick.reduce((sum, tick) => sum + tick.productive_bot_ticks, 0),
    wasted_bot_ticks: perTick.reduce((sum, tick) => sum + tick.waiting_bot_ticks + tick.blocked_bot_ticks, 0),
    pickup_saturation: perTick.reduce((sum, tick) => sum + tick.pickup_actions, 0),
    drop_off_saturation: perTick.filter((tick) => tick.drop_lane_occupied).length,
    per_tick: perTick,
  };
}

function buildScriptOpeningProfile({ oraclePath, scriptPath, maxTick = 120 }) {
  const oracleLoad = loadOracleFile(oraclePath);
  const scriptLoad = loadScriptFile(scriptPath);
  if (!oracleLoad?.ok || !scriptLoad?.ok) {
    throw new Error('Audit requires valid --oracle and --script');
  }
  const evaluated = evaluateOracleScript({
    oracle: oracleLoad.data,
    script: scriptLoad.data,
    maxTripItems: 2,
  });
  const perTick = (evaluated.tickProfiles || []).filter((tick) => tick.tick <= maxTick);
  return {
    script_strategy: scriptLoad.data.strategy || null,
    ...summarizeOpeningProfile(perTick, maxTick),
    handoff_readiness: {
      stranded_inventory: (evaluated.finalBots || []).reduce((sum, bot) => sum + ((bot.inventory || []).length), 0),
      bots_near_drop: (evaluated.finalBots || []).filter((bot) => manhattanDistance(bot.position, evaluated.dropOff || [0, 0]) <= 2).length,
      staged_future_bots: perTick.at(-1)?.staged_future_bots ?? 0,
    },
  };
}

function detectFirstDivergence(baseline, candidate) {
  const baselineTicks = baseline.per_tick || [];
  const candidateTicks = candidate.per_tick || [];
  const max = Math.min(baselineTicks.length, candidateTicks.length);
  for (let index = 0; index < max; index += 1) {
    const left = baselineTicks[index];
    const right = candidateTicks[index];
    const differences = [];
    for (const key of [
      'score',
      'productive_bot_ticks',
      'waiting_bot_ticks',
      'blocked_bot_ticks',
      'carrying_deliverable_bots',
      'staged_future_bots',
      'pickup_actions',
      'drop_actions',
    ]) {
      if (left[key] !== right[key]) {
        differences.push(key);
      }
    }
    if (differences.length > 0) {
      let cause = 'mixed_divergence';
      if (differences.includes('productive_bot_ticks') || differences.includes('waiting_bot_ticks')) {
        cause = 'idle_or_work_release_gap';
      } else if (differences.includes('blocked_bot_ticks') || differences.includes('drop_actions')) {
        cause = 'drop_lane_or_congestion_gap';
      } else if (differences.includes('staged_future_bots')) {
        cause = 'staging_policy_gap';
      } else if (differences.includes('score')) {
        cause = 'delivery_cadence_gap';
      }
      return {
        tick: left.tick,
        cause,
        differences,
        baseline: left,
        candidate: right,
      };
    }
  }
  if (candidateTicks.length < baselineTicks.length) {
    return {
      tick: candidateTicks.at(-1)?.tick ?? null,
      cause: 'script_ends_before_baseline_progress',
      differences: ['script_end'],
      baseline: baselineTicks[candidateTicks.length] || null,
      candidate: candidateTicks.at(-1) || null,
    };
  }
  return null;
}

export function buildOpeningAuditReport({
  oraclePath,
  replayPath,
  scriptPath,
  maxTick = 120,
}) {
  const baseline = buildReplayOpeningProfile(replayPath, maxTick);
  const candidate = buildScriptOpeningProfile({ oraclePath, scriptPath, maxTick });
  const firstDivergence = detectFirstDivergence(baseline, candidate);
  return {
    generated_at: new Date().toISOString(),
    oracle_source: oraclePath,
    replay: replayPath,
    script: scriptPath,
    max_tick: maxTick,
    opening_baseline: baseline,
    opening_profile: candidate,
    first_divergence_tick: firstDivergence?.tick ?? null,
    first_divergence: firstDivergence,
    promotable: false,
  };
}

export function writeOpeningAuditReport({ oraclePath, replayPath, scriptPath, outPath, maxTick = 120 }) {
  const report = buildOpeningAuditReport({ oraclePath, replayPath, scriptPath, maxTick });
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
