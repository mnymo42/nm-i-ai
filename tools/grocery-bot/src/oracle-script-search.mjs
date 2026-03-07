import { buildLegacyOracleScript } from './oracle-script-legacy.mjs';
import { generateOracleScript } from './oracle-script-optimizer.mjs';

function scoreScript(script) {
  return {
    ordersCovered: script.orders_covered || 0,
    estimatedScore: script.estimated_score || 0,
    lastScriptedTick: script.last_scripted_tick ?? Number.POSITIVE_INFINITY,
    waits: script.aggregate_efficiency?.total_waits || 0,
  };
}

export function compareGeneratedScripts(left, right) {
  const leftScore = scoreScript(left);
  const rightScore = scoreScript(right);
  if (rightScore.ordersCovered !== leftScore.ordersCovered) {
    return rightScore.ordersCovered - leftScore.ordersCovered;
  }
  if (rightScore.estimatedScore !== leftScore.estimatedScore) {
    return rightScore.estimatedScore - leftScore.estimatedScore;
  }
  if (leftScore.lastScriptedTick !== rightScore.lastScriptedTick) {
    return leftScore.lastScriptedTick - rightScore.lastScriptedTick;
  }
  return leftScore.waits - rightScore.waits;
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
  const totalPlanned = modularOptionsToRun.length + legacyOptionsToRun.length;

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
        candidates.push({
          strategy: 'modular',
          options: merged,
          script: { ...script, strategy: 'modular', settings: merged },
        });
        if (!bestSoFar || compareGeneratedScripts(bestSoFar, script) > 0) {
          bestSoFar = { ...script, strategy: 'modular', settings: merged };
        }
      } catch {
        // Invalid candidates are expected during search; keep the sweep robust.
      } finally {
        progressCompleted += 1;
        emitProgress('modular');
      }
    }
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
        candidates.push({
          strategy: 'legacy',
          options: merged,
          script: { ...script, strategy: 'legacy', settings: merged },
        });
        if (!bestSoFar || compareGeneratedScripts(bestSoFar, script) > 0) {
          bestSoFar = { ...script, strategy: 'legacy', settings: merged };
        }
      } catch {
        // Legacy candidates can also dead-end; skip them.
      } finally {
        progressCompleted += 1;
        emitProgress('legacy');
      }
    }
  }

  return candidates.sort((left, right) => compareGeneratedScripts(left.script, right.script));
}

export function buildOracleSearchReport({
  candidates,
  scoreToBeat = null,
  tickToBeat = null,
  top = 10,
}) {
  const best = candidates[0]?.script || null;
  return {
    candidates_tested: candidates.length,
    score_to_beat: scoreToBeat,
    tick_to_beat: tickToBeat,
    best_candidate: best ? {
      strategy: best.strategy,
      settings: best.settings,
      orders_covered: best.orders_covered,
      estimated_score: best.estimated_score,
      last_scripted_tick: best.last_scripted_tick,
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
  });
  if (candidates.length === 0) {
    throw new Error(`No valid oracle script candidates for strategy=${strategy}`);
  }
  return {
    best: candidates[0].script,
    candidates,
  };
}
