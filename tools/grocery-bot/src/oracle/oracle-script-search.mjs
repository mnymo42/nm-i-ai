/**
 * Oracle script search: batch generation, optimization, and promotion pipeline.
 * Coordinates replay-seeded generation, compression, and scoring.
 */
import { buildCheckpointRewriteCandidates } from './oracle-script-checkpoints.mjs';
import { compressOracleReplayScript } from './oracle-script-compressor.mjs';
import { buildLegacyOracleScript } from './oracle-script-legacy.mjs';
import { assessScriptPromotion, extractReplayBaselineMetrics, getScriptMilestoneMetrics } from './oracle-script-metrics.mjs';
import { generateOracleScript } from './oracle-script-optimizer.mjs';
import {
  buildReplaySeededAislePartitionOptions,
  buildReplaySeededBucketOptions,
  buildReplaySeededDropLaneOptions,
  buildReplaySeededHandoffOptions,
  buildReplaySeededOpeningCapacityOptions,
  buildReplaySeededModularOptions,
  buildReplaySeededOpeningBucketOptions,
  buildReplaySeededRewindTicks,
  buildReplaySeededScoreTargets,
  buildReplaySeededWaveOptions,
  extractReplaySeedSkeleton,
} from './oracle-script-replay-seed.mjs';

function scoreScript(script) {
  const remainingTicks = Math.max(0, 300 - (script.last_scripted_tick ?? 300));
  const milestones = getScriptMilestoneMetrics(script);
  return {
    ordersCovered: script.orders_covered || 0,
    estimatedScore: script.estimated_score || 0,
    lastScriptedTick: script.last_scripted_tick ?? Number.POSITIVE_INFINITY,
    waits: script.aggregate_efficiency?.total_waits || 0,
    remainingTicks,
    milestones,
  };
}

function scoreBucket(estimatedScore) {
  if (estimatedScore >= 70) {
    return 2;
  }
  if (estimatedScore >= 50) {
    return 1;
  }
  return 0;
}

function triageBias(script) {
  const triage = script?.search_meta?.triage;
  if (!triage) {
    return 0;
  }
  if (triage.promotable) {
    return -10;
  }
  if (triage.baseline_match) {
    return 0;
  }
  return 10 + triage.penalties.length;
}

export function compareGeneratedScripts(left, right, objective = 'score_first') {
  const leftScore = scoreScript(left);
  const rightScore = scoreScript(right);
  if (objective === 'score_by_tick_100') {
    const triageDelta = triageBias(left) - triageBias(right);
    if (triageDelta !== 0) {
      return triageDelta;
    }
    if (rightScore.milestones.score_at_tick_100 !== leftScore.milestones.score_at_tick_100) {
      return rightScore.milestones.score_at_tick_100 - leftScore.milestones.score_at_tick_100;
    }
    if (leftScore.lastScriptedTick !== rightScore.lastScriptedTick) {
      return leftScore.lastScriptedTick - rightScore.lastScriptedTick;
    }
    if (leftScore.milestones.stranded_inventory !== rightScore.milestones.stranded_inventory) {
      return leftScore.milestones.stranded_inventory - rightScore.milestones.stranded_inventory;
    }
    if (leftScore.milestones.bots_near_drop !== rightScore.milestones.bots_near_drop) {
      return leftScore.milestones.bots_near_drop - rightScore.milestones.bots_near_drop;
    }
    return rightScore.milestones.average_bot_spread - leftScore.milestones.average_bot_spread;
  }
  if (objective === 'tick_to_score') {
    const triageDelta = triageBias(left) - triageBias(right);
    if (triageDelta !== 0) {
      return triageDelta;
    }
    for (const target of [80, 60, 40]) {
      const leftTick = leftScore.milestones.tick_to_targets[target] ?? Number.POSITIVE_INFINITY;
      const rightTick = rightScore.milestones.tick_to_targets[target] ?? Number.POSITIVE_INFINITY;
      if (leftTick !== rightTick) {
        return leftTick - rightTick;
      }
    }
    if (rightScore.milestones.score_at_tick_100 !== leftScore.milestones.score_at_tick_100) {
      return rightScore.milestones.score_at_tick_100 - leftScore.milestones.score_at_tick_100;
    }
    return leftScore.waits - rightScore.waits;
  }
  if (objective === 'throughput_frontier') {
    const triageDelta = triageBias(left) - triageBias(right);
    if (triageDelta !== 0) {
      return triageDelta;
    }
    const leftComposite = leftScore.milestones.score_at_tick_100
      + (leftScore.milestones.tick_to_40 === null ? 0 : Math.max(0, 100 - leftScore.milestones.tick_to_40))
      + (leftScore.milestones.tick_to_60 === null ? 0 : Math.max(0, 100 - leftScore.milestones.tick_to_60))
      + (leftScore.milestones.tick_to_80 === null ? 0 : Math.max(0, 100 - leftScore.milestones.tick_to_80));
    const rightComposite = rightScore.milestones.score_at_tick_100
      + (rightScore.milestones.tick_to_40 === null ? 0 : Math.max(0, 100 - rightScore.milestones.tick_to_40))
      + (rightScore.milestones.tick_to_60 === null ? 0 : Math.max(0, 100 - rightScore.milestones.tick_to_60))
      + (rightScore.milestones.tick_to_80 === null ? 0 : Math.max(0, 100 - rightScore.milestones.tick_to_80));
    if (rightComposite !== leftComposite) {
      return rightComposite - leftComposite;
    }
    if (rightScore.milestones.score_at_tick_100 !== leftScore.milestones.score_at_tick_100) {
      return rightScore.milestones.score_at_tick_100 - leftScore.milestones.score_at_tick_100;
    }
    if (leftScore.milestones.stranded_inventory !== rightScore.milestones.stranded_inventory) {
      return leftScore.milestones.stranded_inventory - rightScore.milestones.stranded_inventory;
    }
    return leftScore.milestones.bots_near_drop - rightScore.milestones.bots_near_drop;
  }
  if (objective === 'live_worthy') {
    const leftBucket = scoreBucket(leftScore.estimatedScore);
    const rightBucket = scoreBucket(rightScore.estimatedScore);
    if (rightBucket !== leftBucket) {
      return rightBucket - leftBucket;
    }
    const leftComposite = leftScore.estimatedScore + leftScore.remainingTicks;
    const rightComposite = rightScore.estimatedScore + rightScore.remainingTicks;
    if (rightComposite !== leftComposite) {
      return rightComposite - leftComposite;
    }
    if (rightScore.estimatedScore !== leftScore.estimatedScore) {
      return rightScore.estimatedScore - leftScore.estimatedScore;
    }
    if (leftScore.lastScriptedTick !== rightScore.lastScriptedTick) {
      return leftScore.lastScriptedTick - rightScore.lastScriptedTick;
    }
    return leftScore.waits - rightScore.waits;
  }
  if (objective === 'handoff_value') {
    if (rightScore.estimatedScore !== leftScore.estimatedScore) {
      return rightScore.estimatedScore - leftScore.estimatedScore;
    }
    if (leftScore.lastScriptedTick !== rightScore.lastScriptedTick) {
      return leftScore.lastScriptedTick - rightScore.lastScriptedTick;
    }
    if (rightScore.ordersCovered !== leftScore.ordersCovered) {
      return rightScore.ordersCovered - leftScore.ordersCovered;
    }
    return leftScore.waits - rightScore.waits;
  }
  if (rightScore.ordersCovered !== leftScore.ordersCovered) {
    return rightScore.ordersCovered - leftScore.ordersCovered;
  }
  if (objective === 'handoff_first') {
    if (leftScore.lastScriptedTick !== rightScore.lastScriptedTick) {
      return leftScore.lastScriptedTick - rightScore.lastScriptedTick;
    }
    if (rightScore.estimatedScore !== leftScore.estimatedScore) {
      return rightScore.estimatedScore - leftScore.estimatedScore;
    }
  } else {
    if (rightScore.estimatedScore !== leftScore.estimatedScore) {
      return rightScore.estimatedScore - leftScore.estimatedScore;
    }
    if (leftScore.lastScriptedTick !== rightScore.lastScriptedTick) {
      return leftScore.lastScriptedTick - rightScore.lastScriptedTick;
    }
  }
  return leftScore.waits - rightScore.waits;
}

function buildReplaySeededCandidateOptions({ oracle, replayPath }) {
  if (!replayPath) {
    return { modularFamilies: [], replayFamilies: [], checkpointFamilies: [], baselineMetrics: null };
  }
  const skeleton = extractReplaySeedSkeleton({ replayPath, oracle });
  const modularFamilies = [
    ...buildReplaySeededModularOptions({ skeleton }).map((options) => ({
      family: 'replay_seeded_modular',
      options,
    })),
    ...buildReplaySeededWaveOptions({ skeleton }).map((options) => ({
      family: 'replay_seeded_wave',
      options,
    })),
    ...buildReplaySeededBucketOptions({ skeleton }).map((options) => ({
      family: 'replay_seeded_bucket',
      options,
    })),
    ...buildReplaySeededOpeningBucketOptions({ skeleton }).map((options) => ({
      family: 'opening_bucket_v2',
      options,
    })),
    ...buildReplaySeededDropLaneOptions({ skeleton }).map((options) => ({
      family: 'drop_lane_scheduler',
      options,
    })),
    ...buildReplaySeededAislePartitionOptions({ skeleton }).map((options) => ({
      family: 'opening_aisle_partition',
      options,
    })),
    ...buildReplaySeededOpeningCapacityOptions({ skeleton }).map((options) => ({
      family: 'opening_capacity_v1',
      options,
    })),
    ...buildReplaySeededHandoffOptions({ skeleton }).map((options) => ({
      family: 'replay_seeded_handoff',
      options,
    })),
  ];
  const replayFamilies = buildReplaySeededScoreTargets({ replayPath }).flatMap((targetScore) => ([
    {
      family: 'replay_seeded_preserve',
      targetScore,
      mode: 'preserve_score',
      rewindTicks: 0,
    },
    ...buildReplaySeededRewindTicks({ targetScore }).map((rewindTicks) => ({
      family: 'replay_seeded_handoff_rewind',
      targetScore,
      mode: 'handoff_early',
      rewindTicks,
    })),
  ]));
  const checkpointFamilies = buildCheckpointRewriteCandidates({ oracle, replayPath });
  const baselineMetrics = extractReplayBaselineMetrics(replayPath);
  return { modularFamilies, replayFamilies, checkpointFamilies, baselineMetrics };
}

function cartesianProduct(valuesByKey) {
  const entries = Object.entries(valuesByKey);
  const results = [];

  function build(index, current) {
    if (index >= entries.length) {
      results.push({ ...current });
      return;
    }
    const [key, values] = entries[index];
    for (const value of values) {
      current[key] = value;
      build(index + 1, current);
    }
  }

  build(0, {});
  return results;
}

function createPrng(seed = 1) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0x100000000);
  };
}

function shuffleDeterministic(items, seed) {
  const random = createPrng(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function* buildLegacyCandidateOptions() {
  for (const maxTripItems of [1, 2, 3]) {
    for (const prefetchDepth of [1, 2]) {
      for (const pathHorizon of [60, 90]) {
        for (const pickupHoldTicks of [1, 2, 3]) {
          yield {
            maxTripItems,
            prefetchDepth,
            pathHorizon,
            pickupHoldTicks,
            dropHoldTicks: 1,
          };
        }
      }
    }
  }
}

function* buildModularCandidateOptions() {
  for (const maxActiveBots of [1, 2]) {
    for (const maxTripItems of [1, 2]) {
      for (const previewRunnerCap of [1, 2]) {
        for (const previewItemCap of [2, 4]) {
          yield {
            maxActiveBots,
            maxTripItems,
            previewRunnerCap,
            previewItemCap,
          };
        }
      }
    }
  }
}

function buildLegacySearchSpace() {
  return cartesianProduct({
    maxTripItems: [1, 2, 3],
    prefetchDepth: [1, 2, 3, 4],
    pathHorizon: [45, 60, 90, 120],
    pickupHoldTicks: [0, 1, 2, 3],
    dropHoldTicks: [0, 1, 2],
    targetCutoffTick: [160, 180, 200, 220, 240, 260, 299],
  });
}

function buildModularSearchSpace() {
  return cartesianProduct({
    maxActiveBots: [1, 2, 3, 4],
    maxTripItems: [1, 2, 3],
    previewRunnerCap: [0, 1, 2, 3],
    previewItemCap: [0, 2, 4, 6],
    targetCutoffTick: [160, 180, 200, 220, 240, 260, 299],
  });
}

export function generateOracleScriptCandidates({
  oracle,
  replayPath = null,
  oracleSource = null,
  strategy = 'auto',
  modularOptions = {},
  legacyOptions = {},
  candidateLimit = null,
  seed = 7004,
  searchSpace = 'compact',
  onProgress = null,
  objective = 'score_first',
}) {
  const candidates = [];
  let progressCompleted = 0;
  let bestSoFar = null;

  const modularBaseOptions = strategy === 'auto' || strategy === 'modular'
    ? (searchSpace === 'wide'
      ? shuffleDeterministic(buildModularSearchSpace(), seed ^ 0x51f15e)
      : [...buildModularCandidateOptions()])
    : [];
  const modularOptionsToRun = (strategy === 'auto' || strategy === 'modular')
    ? (candidateLimit && searchSpace === 'wide'
      ? modularBaseOptions.slice(0, Math.ceil(candidateLimit / (strategy === 'auto' ? 2 : 1)))
      : modularBaseOptions)
    : [];
  const legacyBaseOptions = strategy === 'auto' || strategy === 'legacy'
    ? (searchSpace === 'wide'
      ? shuffleDeterministic(buildLegacySearchSpace(), seed ^ 0xa91e11)
      : [...buildLegacyCandidateOptions()])
    : [];
  const legacyOptionsToRun = (strategy === 'auto' || strategy === 'legacy')
    ? (candidateLimit && searchSpace === 'wide'
      ? legacyBaseOptions.slice(0, Math.ceil(candidateLimit / (strategy === 'auto' ? 2 : 1)))
      : legacyBaseOptions)
    : [];
  const replaySeeded = (strategy === 'auto' || strategy === 'modular' || strategy === 'checkpoint_rewriter') && replayPath
    ? buildReplaySeededCandidateOptions({ oracle, replayPath })
    : { modularFamilies: [], replayFamilies: [], checkpointFamilies: [], baselineMetrics: null };
  const totalPlanned = modularOptionsToRun.length
    + legacyOptionsToRun.length
    + replaySeeded.modularFamilies.length
    + replaySeeded.replayFamilies.length
    + replaySeeded.checkpointFamilies.length;

  function decorateScript(script) {
    if (!replaySeeded.baselineMetrics) {
      return script;
    }
    return {
      ...script,
      search_meta: {
        ...(script.search_meta || {}),
        baseline_metrics: replaySeeded.baselineMetrics,
        triage: assessScriptPromotion(script, replaySeeded.baselineMetrics),
      },
    };
  }

  function emitProgress(latestStrategy) {
    const bestScore = bestSoFar ? {
      strategy: bestSoFar.strategy,
      ordersCovered: bestSoFar.orders_covered || 0,
      estimatedScore: bestSoFar.estimated_score || 0,
      lastScriptedTick: bestSoFar.last_scripted_tick ?? Number.POSITIVE_INFINITY,
      waits: bestSoFar.aggregate_efficiency?.total_waits || 0,
      settings: bestSoFar.settings || null,
    } : null;
    onProgress?.({
      completed: progressCompleted,
      total: totalPlanned,
      latestStrategy,
      candidatesKept: candidates.length,
      best: bestScore,
    });
  }

  if (strategy === 'auto' || strategy === 'modular') {
    for (const options of modularOptionsToRun) {
      const merged = { ...options, ...modularOptions };
      try {
        const script = generateOracleScript({
          oracle,
          replayPath,
          oracleSource,
          options: merged,
        });
        const decorated = decorateScript({ ...script, strategy: 'modular', settings: merged });
        candidates.push({
          strategy: 'modular',
          options: merged,
          script: decorated,
        });
        if (!bestSoFar || compareGeneratedScripts(bestSoFar, decorated, objective) > 0) {
          bestSoFar = decorated;
        }
      } catch {
        // Invalid candidates are expected during search; keep the sweep robust.
      } finally {
        progressCompleted += 1;
        emitProgress('modular');
      }
    }
  }

  for (const seeded of replaySeeded.modularFamilies) {
    const merged = { ...seeded.options, ...modularOptions };
    try {
      const script = generateOracleScript({
        oracle,
        replayPath,
        oracleSource,
        options: merged,
      });
      const decorated = decorateScript({ ...script, strategy: seeded.family, settings: merged });
      candidates.push({
        strategy: seeded.family,
        options: merged,
        script: decorated,
      });
      if (!bestSoFar || compareGeneratedScripts(bestSoFar, decorated, objective) > 0) {
        bestSoFar = decorated;
      }
    } catch {
      // Replay-seeded candidates are opportunistic.
    } finally {
      progressCompleted += 1;
      emitProgress(seeded.family);
    }
  }

  for (const seeded of replaySeeded.replayFamilies) {
    try {
      const script = compressOracleReplayScript({
        oracle,
        replayPath,
        targetScore: seeded.targetScore,
        mode: seeded.mode,
        rewindTicks: seeded.rewindTicks,
      });
      const decorated = decorateScript({
        ...script,
        strategy: seeded.family,
        settings: { targetScore: seeded.targetScore, mode: seeded.mode, rewindTicks: seeded.rewindTicks },
      });
      candidates.push({
        strategy: seeded.family,
        options: { targetScore: seeded.targetScore, mode: seeded.mode, rewindTicks: seeded.rewindTicks },
        script: decorated,
      });
      if (!bestSoFar || compareGeneratedScripts(bestSoFar, decorated, objective) > 0) {
        bestSoFar = decorated;
      }
    } catch {
      // Replay-derived seeds should never block the wider search.
    } finally {
      progressCompleted += 1;
      emitProgress(seeded.family);
    }
  }

  for (const seeded of replaySeeded.checkpointFamilies) {
    const decorated = decorateScript(seeded.script);
    candidates.push({
      strategy: seeded.family,
      options: decorated.settings,
      script: decorated,
    });
    if (!bestSoFar || compareGeneratedScripts(bestSoFar, decorated, objective) > 0) {
      bestSoFar = decorated;
    }
    progressCompleted += 1;
    emitProgress(seeded.family);
  }

  if (strategy === 'auto' || strategy === 'legacy') {
    for (const options of legacyOptionsToRun) {
      const merged = { ...options, ...legacyOptions };
      try {
        const script = buildLegacyOracleScript({
          oracle,
          replayPath,
          oracleSource,
          options: merged,
        });
        const decorated = decorateScript({ ...script, strategy: 'legacy', settings: merged });
        candidates.push({
          strategy: 'legacy',
          options: merged,
          script: decorated,
        });
        if (!bestSoFar || compareGeneratedScripts(bestSoFar, decorated, objective) > 0) {
          bestSoFar = decorated;
        }
      } catch {
        // Legacy candidates can also dead-end; skip them.
      } finally {
        progressCompleted += 1;
        emitProgress('legacy');
      }
    }
  }

  return candidates.sort((left, right) => compareGeneratedScripts(left.script, right.script, objective));
}

export function buildOracleSearchReport({
  candidates,
  scoreToBeat = null,
  tickToBeat = null,
  top = 10,
  objective = 'score_first',
}) {
  const best = candidates[0]?.script || null;
  return {
    candidates_tested: candidates.length,
    score_to_beat: scoreToBeat,
    tick_to_beat: tickToBeat,
    objective,
    best_candidate: best ? {
      strategy: best.strategy,
      settings: best.settings,
      orders_covered: best.orders_covered,
      estimated_score: best.estimated_score,
      last_scripted_tick: best.last_scripted_tick,
      search_meta: best.search_meta || null,
      beats_score_target: scoreToBeat === null ? null : best.estimated_score > scoreToBeat,
      beats_tick_target: tickToBeat === null ? null : best.last_scripted_tick < tickToBeat,
    } : null,
    top_candidates: candidates.slice(0, top).map((candidate, index) => ({
      rank: index + 1,
      strategy: candidate.script.strategy,
      settings: candidate.script.settings,
      orders_covered: candidate.script.orders_covered,
      estimated_score: candidate.script.estimated_score,
      last_scripted_tick: candidate.script.last_scripted_tick,
      score_at_tick_100: getScriptMilestoneMetrics(candidate.script).score_at_tick_100,
      tick_to_40: getScriptMilestoneMetrics(candidate.script).tick_to_40,
      tick_to_60: getScriptMilestoneMetrics(candidate.script).tick_to_60,
      tick_to_80: getScriptMilestoneMetrics(candidate.script).tick_to_80,
      triage: candidate.script.search_meta?.triage || null,
      total_waits: candidate.script.aggregate_efficiency?.total_waits || 0,
    })),
  };
}

export function generateBestOracleScript({
  oracle,
  replayPath = null,
  oracleSource = null,
  strategy = 'auto',
  modularOptions = {},
  legacyOptions = {},
  candidateLimit = null,
  seed = 7004,
  searchSpace = 'compact',
  onProgress = null,
  objective = 'score_first',
}) {
  const candidates = generateOracleScriptCandidates({
    oracle,
    replayPath,
    oracleSource,
    strategy,
    modularOptions,
    legacyOptions,
    candidateLimit,
    seed,
    searchSpace,
    onProgress,
    objective,
  });
  if (candidates.length === 0) {
    throw new Error(`No valid oracle script candidates for strategy=${strategy}`);
  }
  return {
    best: candidates[0].script,
    candidates,
  };
}
