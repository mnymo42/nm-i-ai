import { parseJsonl } from './replay-io.mjs';
import { buildExpectedScriptState } from './replay-transition-diff.mjs';

function cloneTick(tick) {
  return {
    tick: tick.tick,
    actions: tick.actions.map((action) => ({ ...action })),
    expected_state: tick.expected_state ? {
      score: tick.expected_state.score,
      bots: tick.expected_state.bots.map((bot) => ({
        id: bot.id,
        position: [...bot.position],
        inventory: [...bot.inventory],
      })),
    } : undefined,
  };
}

function buildTickRows(replayPath) {
  return parseJsonl(replayPath).filter((row) => row.type === 'tick');
}

function normalizeBotState(bot) {
  return {
    id: bot.id,
    position: [...bot.position],
    inventory: [...(bot.inventory || [])].sort(),
  };
}

function statesMatch(sourceRow, validationRow) {
  if (!sourceRow || !validationRow) {
    return false;
  }

  const sourceSnapshot = sourceRow.state_snapshot || {};
  const validationSnapshot = validationRow.state_snapshot || {};
  if ((sourceSnapshot.score ?? 0) !== (validationSnapshot.score ?? 0)) {
    return false;
  }

  const sourceBots = new Map((sourceSnapshot.bots || []).map((bot) => [bot.id, normalizeBotState(bot)]));
  const validationBots = new Map((validationSnapshot.bots || []).map((bot) => [bot.id, normalizeBotState(bot)]));
  if (sourceBots.size !== validationBots.size) {
    return false;
  }

  for (const [botId, sourceBot] of sourceBots.entries()) {
    const validationBot = validationBots.get(botId);
    if (!validationBot) {
      return false;
    }

    if (JSON.stringify(sourceBot.position) !== JSON.stringify(validationBot.position)) {
      return false;
    }

    if (sourceBot.inventory.join('|') !== validationBot.inventory.join('|')) {
      return false;
    }
  }

  return true;
}

export function findLongestMatchingReplayTick(sourceReplayPath, validationReplayPath) {
  const sourceRows = buildTickRows(sourceReplayPath);
  const validationRows = buildTickRows(validationReplayPath);
  const validationByTick = new Map(validationRows.map((row) => [row.tick, row]));
  let lastMatchingTick = -1;

  for (const sourceRow of sourceRows) {
    const validationRow = validationByTick.get(sourceRow.tick);
    if (!statesMatch(sourceRow, validationRow)) {
      break;
    }
    lastMatchingTick = sourceRow.tick;
  }

  return lastMatchingTick;
}

export function extractScriptFromReplay(replayPath, stopTick = null) {
  const tickRows = buildTickRows(replayPath);
  const ticks = [];

  for (const row of tickRows) {
    if (stopTick !== null && row.tick > stopTick) {
      break;
    }
    ticks.push({
      tick: row.tick,
      actions: (row.actions_sent || row.actions_planned || []).map((action) => ({ ...action })),
      expected_state: buildExpectedScriptState(row.state_snapshot),
    });
  }

  return {
    ticks,
    last_scripted_tick: ticks.at(-1)?.tick ?? -1,
  };
}

function summarizeReplayProgress(tickRows) {
  const scoreTimeline = tickRows.map((row) => ({
    tick: row.tick,
    score: row.state_snapshot?.score ?? 0,
  }));
  const finalScore = scoreTimeline.at(-1)?.score ?? 0;
  return {
    scoreTimeline,
    finalScore,
  };
}

function earliestTickMeetingScore(scoreTimeline, targetScore) {
  const hit = scoreTimeline.find((entry) => entry.score >= targetScore);
  return hit?.tick ?? scoreTimeline.at(-1)?.tick ?? -1;
}

function scoreAtOrBeforeTick(scoreTimeline, targetTick) {
  let score = 0;
  for (const entry of scoreTimeline) {
    if (entry.tick > targetTick) {
      break;
    }
    score = entry.score;
  }
  return score;
}

export function compressOracleReplayScript({
  oracle,
  replayPath,
  stopTick = null,
  validationReplayPath = null,
  targetOrdersCovered = null,
  targetScore = null,
  mode = 'preserve_score',
}) {
  const tickRows = buildTickRows(replayPath);
  const { scoreTimeline, finalScore } = summarizeReplayProgress(tickRows);
  const requiredScore = targetScore ?? finalScore;
  const replayLastTick = tickRows.at(-1)?.tick ?? -1;
  const stablePrefixTick = validationReplayPath
    ? findLongestMatchingReplayTick(replayPath, validationReplayPath)
    : null;
  const baselineLastTick = Math.min(
    stopTick ?? replayLastTick,
    stablePrefixTick ?? replayLastTick,
  );
  const fullReplayTargetTick = earliestTickMeetingScore(scoreTimeline, requiredScore);
  const targetReachableWithinPrefix = fullReplayTargetTick <= baselineLastTick;
  const scoreSeenTick = targetReachableWithinPrefix
    ? fullReplayTargetTick
    : baselineLastTick;
  const targetTick = mode === 'handoff_early'
    ? Math.max(0, scoreSeenTick - 1)
    : scoreSeenTick;
  const scoreAtScriptEnd = scoreAtOrBeforeTick(scoreTimeline, targetTick);

  const extracted = extractScriptFromReplay(replayPath, targetTick);

  return {
    description: `Compressed replay-derived script for ${oracle?.difficulty || 'unknown'}`,
    strategy: mode === 'handoff_early' ? 'replay_rewind_handoff_v1' : 'replay_rewind_preserve_v1',
    generated_at: new Date().toISOString(),
    oracle_source: null,
    orders_covered: targetOrdersCovered,
    estimated_score: scoreAtScriptEnd,
    last_scripted_tick: extracted.last_scripted_tick,
    cutoff_reason: mode === 'handoff_early'
      ? 'handoff_before_replay_target_score_tick'
      : 'preserve_replay_target_score_tick',
    per_order_estimates: [],
    aggregate_efficiency: {
      total_waits: extracted.ticks.flatMap((tick) => tick.actions).filter((action) => action.action === 'wait').length,
      total_picks: extracted.ticks.flatMap((tick) => tick.actions).filter((action) => action.action === 'pick_up').length,
      total_drops: extracted.ticks.flatMap((tick) => tick.actions).filter((action) => action.action === 'drop_off').length,
      average_items_per_trip: 0,
    },
    replay_target_meta: {
      source_replay: replayPath,
      validation_replay: validationReplayPath,
      baseline_score: finalScore,
      baseline_last_tick: replayLastTick,
      safe_prefix_tick: stablePrefixTick,
      compression_mode: mode,
      target_score: requiredScore,
      target_tick: targetReachableWithinPrefix ? fullReplayTargetTick : null,
      target_reachable_within_prefix: targetReachableWithinPrefix,
      score_at_script_end: scoreAtScriptEnd,
      script_cutoff_tick: targetTick,
      final_tick_delta: baselineLastTick - extracted.last_scripted_tick,
    },
    ticks: extracted.ticks.map(cloneTick),
  };
}
