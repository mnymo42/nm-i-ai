import { extractLayout, parseJsonl, rebuildSnapshot } from '../replay/replay-io.mjs';
import { manhattanDistance } from '../utils/coords.mjs';
import fs from 'node:fs';

function lastEntryAtOrBefore(entries, tick, key = 'score', fallback = 0) {
  let value = fallback;
  for (const entry of entries || []) {
    if ((entry.tick ?? Number.POSITIVE_INFINITY) > tick) {
      break;
    }
    value = entry[key] ?? value;
  }
  return value;
}

function buildTimelineFromExpectedState(script) {
  const timeline = [];
  for (const tick of script.ticks || []) {
    const score = tick.expected_state?.score;
    if (Number.isFinite(score)) {
      timeline.push({ tick: tick.tick, score });
    }
  }
  return timeline;
}

function buildTimelineFromReplay(replayPath, maxTick = 100) {
  const rows = parseJsonl(replayPath);
  const layout = extractLayout(rows);
  return rows
    .filter((row) => row.type === 'tick' && row.tick <= maxTick)
    .map((row) => {
      const snapshot = rebuildSnapshot(row.state_snapshot, layout);
      const actions = row.actions_sent || row.actions_planned || [];
      return { tick: row.tick, score: snapshot?.score ?? 0 };
    });
}

function longestDeadWindow(timeline, maxTick = 100) {
  let previousScore = null;
  let currentStart = null;
  let longest = 0;
  for (const entry of timeline.filter((item) => item.tick <= maxTick)) {
    if (previousScore === null) {
      previousScore = entry.score;
      currentStart = entry.tick;
      continue;
    }
    if (entry.score === previousScore) {
      longest = Math.max(longest, entry.tick - currentStart + 1);
    } else {
      previousScore = entry.score;
      currentStart = entry.tick;
    }
  }
  return longest;
}

function averageBotSpread(finalBots) {
  if (!finalBots || finalBots.length <= 1) {
    return 0;
  }
  let total = 0;
  let pairs = 0;
  for (let index = 0; index < finalBots.length; index += 1) {
    for (let other = index + 1; other < finalBots.length; other += 1) {
      total += manhattanDistance(finalBots[index].position, finalBots[other].position);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : Number((total / pairs).toFixed(2));
}

function botsNearDrop(finalBots, dropOff, radius = 2) {
  if (!dropOff) {
    return 0;
  }
  return (finalBots || []).filter((bot) => manhattanDistance(bot.position, dropOff) <= radius).length;
}

export function getScriptScoreTimeline(script) {
  if (script?.evaluation?.scoreTimeline?.length) {
    return script.evaluation.scoreTimeline;
  }
  if (script?.replay_target_meta?.score_timeline?.length) {
    return script.replay_target_meta.score_timeline;
  }
  const fromExpectedState = buildTimelineFromExpectedState(script);
  if (fromExpectedState.length > 0) {
    return fromExpectedState;
  }
  if (Number.isFinite(script?.last_scripted_tick) && Number.isFinite(script?.estimated_score)) {
    return [{ tick: script.last_scripted_tick, score: script.estimated_score }];
  }
  return [];
}

export function getScriptMilestoneMetrics(script, options = {}) {
  const {
    scoreTick = 100,
    scoreTargets = [40, 60, 80],
  } = options;
  const timeline = getScriptScoreTimeline(script);
  const scoreAtTick = lastEntryAtOrBefore(timeline, scoreTick, 'score', 0);
  const tickToScore = Object.fromEntries(scoreTargets.map((target) => {
    const hit = timeline.find((entry) => entry.score >= target);
    return [target, hit?.tick ?? null];
  }));
  const finalBots = script?.evaluation?.finalBots
    || script?.ticks?.at(-1)?.expected_state?.bots
    || [];
  const dropOff = script?.evaluation?.dropOff
    || script?.ticks?.at(-1)?.expected_state?.drop_off
    || null;
  const strandedInventory = finalBots.reduce((sum, bot) => sum + ((bot.inventory || []).length), 0);
  const tickProfiles = script?.evaluation?.tickProfiles || [];
  const productiveBotTicks = tickProfiles.reduce((sum, tick) => sum + (tick.productive_bot_ticks || 0), 0);
  const wastedBotTicks = tickProfiles.reduce((sum, tick) => sum + (tick.waiting_bot_ticks || 0) + (tick.blocked_bot_ticks || 0), 0);
  const productiveRatio = productiveBotTicks + wastedBotTicks === 0
    ? null
    : Number((productiveBotTicks / (productiveBotTicks + wastedBotTicks)).toFixed(4));

  return {
    score_at_tick_100: scoreAtTick,
    tick_to_40: tickToScore[40],
    tick_to_60: tickToScore[60],
    tick_to_80: tickToScore[80],
    tick_to_targets: tickToScore,
    stranded_inventory: strandedInventory,
    bots_near_drop: botsNearDrop(finalBots, dropOff),
    average_bot_spread: averageBotSpread(finalBots),
    dead_opening_ticks: longestDeadWindow(timeline, scoreTick),
    productive_bot_ticks: productiveBotTicks,
    wasted_bot_ticks: wastedBotTicks,
    productive_bot_tick_ratio: productiveRatio,
  };
}

export function extractReplayBaselineMetrics(replayPath, options = {}) {
  if (!replayPath || !fs.existsSync(replayPath)) {
    return null;
  }
  const {
    scoreTick = 100,
    scoreTargets = [40, 60, 80],
  } = options;
  const rows = parseJsonl(replayPath)
    .filter((row) => row.type === 'tick' && row.tick <= scoreTick);
  const timeline = rows.map((row) => ({ tick: row.tick, score: row.state_snapshot?.score ?? 0 }));
  const scoreAtTick = lastEntryAtOrBefore(timeline, scoreTick, 'score', 0);
  const tickToScore = Object.fromEntries(scoreTargets.map((target) => {
    const hit = timeline.find((entry) => entry.score >= target);
    return [target, hit?.tick ?? null];
  }));
  return {
    score_at_tick_100: scoreAtTick,
    tick_to_40: tickToScore[40],
    tick_to_60: tickToScore[60],
    tick_to_80: tickToScore[80],
    tick_to_targets: tickToScore,
    dead_opening_ticks: longestDeadWindow(timeline, scoreTick),
    productive_bot_ticks: rows.reduce((sum, row) => sum + ((row.actions_sent || row.actions_planned || []).filter((action) => action.action !== 'wait').length), 0),
    wasted_bot_ticks: rows.reduce((sum, row) => {
      const actions = row.actions_sent || row.actions_planned || [];
      const botCount = row.state_snapshot?.bots?.length || actions.length;
      const productive = actions.filter((action) => action.action !== 'wait').length;
      const blocked = row.sanitizer_overrides?.length || 0;
      return sum + Math.max(0, botCount - productive) + blocked;
    }, 0),
  };
}

export function assessScriptPromotion(script, baselineMetrics, options = {}) {
  const {
    maxStrandedInventory = 4,
    maxBotsNearDrop = 3,
  } = options;
  const metrics = getScriptMilestoneMetrics(script);
  const penalties = [];
  const baselineBeat = metrics.score_at_tick_100 > (baselineMetrics?.score_at_tick_100 ?? -1);
  const baselineMatch = metrics.score_at_tick_100 === (baselineMetrics?.score_at_tick_100 ?? -1);
  if (metrics.score_at_tick_100 < (baselineMetrics?.score_at_tick_100 ?? 0)) {
    penalties.push('below_baseline_score_100');
  }
  if (metrics.stranded_inventory > maxStrandedInventory) {
    penalties.push('excess_stranded_inventory');
  }
  if (metrics.bots_near_drop > maxBotsNearDrop) {
    penalties.push('drop_lane_congestion');
  }
  if (metrics.dead_opening_ticks > (baselineMetrics?.dead_opening_ticks ?? Number.POSITIVE_INFINITY)) {
    penalties.push('dead_opening_regression');
  }
  if (baselineMetrics?.productive_bot_ticks && metrics.productive_bot_ticks && metrics.productive_bot_ticks < baselineMetrics.productive_bot_ticks) {
    penalties.push('productive_bot_tick_regression');
  }
  if ((baselineMetrics?.tick_to_40 ?? null) !== null && metrics.tick_to_40 === null) {
    penalties.push('missed_milestone_40');
  }
  const promotable = baselineBeat && penalties.length === 0;
  return {
    baseline_match: baselineMatch,
    baseline_beat: baselineBeat,
    promotable,
    penalties,
    metrics,
  };
}
