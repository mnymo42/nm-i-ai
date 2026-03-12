import fs from 'node:fs';
import path from 'node:path';

import { buildOpeningAuditReport } from '../replay/opening-audit.mjs';
import { loadOracleFile, loadScriptFile } from '../oracle/oracle-script-io.mjs';
import { generateAnalysis, summarizeReplay } from '../replay/replay.mjs';
import { listReplayRuns } from '../replay/replay-viewer.mjs';

function safeReadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function inferRunMetadata(runDir) {
  const basename = path.basename(runDir);
  const match = basename.match(/^(?<stamp>.+)-(?<difficulty>easy|medium|hard|expert|nightmare)-(?<profile>.+)$/);
  if (!match?.groups) {
    return {
      runId: basename,
      difficulty: null,
      profile: null,
    };
  }

  return {
    runId: basename,
    difficulty: match.groups.difficulty,
    profile: match.groups.profile,
  };
}

export function buildRunListing({ outDir, difficulty = null, profile = null, limit = 10 }) {
  const runs = listReplayRuns(outDir, { difficulty, profile });
  return {
    outDir,
    count: Math.min(runs.length, limit),
    totalAvailable: runs.length,
    runs: runs.slice(0, limit).map((run) => ({
      runId: run.runId,
      difficulty: run.difficulty,
      profile: run.profile,
      finalScore: run.finalScore,
      finalOrders: run.finalOrders,
      finalItems: run.finalItems,
      totalStalls: run.totalStalls,
      modifiedAt: run.modifiedAt,
      relativePath: run.relativePath,
    })),
  };
}

export function resolveReplayArtifact(targetPath) {
  const resolved = path.resolve(targetPath);
  const stats = fs.statSync(resolved);

  if (stats.isDirectory()) {
    const replayPath = path.join(resolved, 'replay.jsonl');
    if (!fs.existsSync(replayPath)) {
      throw new Error(`Replay file not found in run directory: ${resolved}`);
    }

    return {
      runDir: resolved,
      replayPath,
    };
  }

  if (path.basename(resolved) !== 'replay.jsonl') {
    throw new Error(`Expected a replay.jsonl file or run directory: ${resolved}`);
  }

  return {
    runDir: path.dirname(resolved),
    replayPath: resolved,
  };
}

export function buildReplayAnalysisReport(targetPath) {
  const { runDir, replayPath } = resolveReplayArtifact(targetPath);
  const inferred = inferRunMetadata(runDir);
  const summary = safeReadJson(path.join(runDir, 'summary.json')) || summarizeReplay(replayPath);
  const analysis = safeReadJson(path.join(runDir, 'analysis.json')) || generateAnalysis(replayPath);

  return {
    runId: summary.runId || inferred.runId,
    difficulty: summary.difficulty || inferred.difficulty,
    profile: summary.profile || inferred.profile,
    replayPath,
    summary: {
      finalScore: summary.finalScore ?? summary.metrics?.finalScore ?? analysis.finalScore ?? null,
      finalOrders: summary.finalOrders ?? summary.metrics?.ordersCompleted ?? analysis.ordersCompleted ?? null,
      finalItems: summary.finalItems ?? summary.metrics?.itemsDelivered ?? analysis.itemsDelivered ?? null,
      ticks: summary.metrics?.ticks ?? analysis.totalTicks ?? null,
      totalStalls: summary.metrics?.totalStalls ?? analysis.multiBotCoordination?.totalStalls ?? null,
    },
    keyMetrics: {
      waitActions: analysis.actionEfficiency?.waitActions ?? null,
      nonScoringDropoffs: analysis.actionEfficiency?.nonScoringDropoffs ?? null,
      sanitizerOverrides: analysis.actionEfficiency?.sanitizerOverrides?.total ?? null,
      failedPickups: analysis.failedPickups?.total ?? null,
      maxStalledBots: analysis.multiBotCoordination?.maxStalledBots ?? null,
      forcedWaitActions: analysis.multiBotCoordination?.forcedWaitActions ?? null,
    },
    scoreByWindow: analysis.scoreByWindow || [],
    stagnationWindows: analysis.stagnationWindows || [],
    wastedInventoryAtEnd: analysis.wastedInventoryAtEnd || [],
  };
}

export function buildScriptInfoReport({ scriptPath, oraclePath = null }) {
  const scriptLoad = loadScriptFile(scriptPath);
  if (!scriptLoad?.ok || !scriptLoad.data) {
    throw new Error(scriptLoad?.message || `Failed to load script: ${scriptPath}`);
  }

  const oracleLoad = oraclePath ? loadOracleFile(oraclePath) : null;
  if (oraclePath && (!oracleLoad?.ok || !oracleLoad.data)) {
    throw new Error(oracleLoad?.message || `Failed to load oracle: ${oraclePath}`);
  }

  const script = scriptLoad.data;
  const firstTick = script.ticks?.[0] || null;
  const lastTick = script.ticks?.at(-1) || null;
  const report = {
    scriptPath,
    strategy: script.strategy || null,
    totalTicks: script.ticks?.length || 0,
    lastScriptedTick: script.last_scripted_tick ?? null,
    estimatedScore: script.estimated_score ?? null,
    ordersCovered: script.orders_covered ?? null,
    cutoffReason: script.cutoff_reason ?? null,
    evaluation: script.evaluation ? {
      valid: script.evaluation.valid ?? null,
      score: script.evaluation.score ?? null,
      lastScriptedTick: script.evaluation.lastScriptedTick ?? null,
      errors: script.evaluation.errors || [],
    } : null,
    replayTarget: script.replay_target_meta || null,
    aggregateEfficiency: script.aggregate_efficiency || null,
    search: script.search ? {
      topCandidates: script.search.top_candidates?.length || 0,
      bestStrategy: script.search.best_strategy || null,
    } : null,
    firstTick: firstTick ? {
      tick: firstTick.tick,
      actionCount: firstTick.actions?.length || 0,
    } : null,
    lastTick: lastTick ? {
      tick: lastTick.tick,
      actionCount: lastTick.actions?.length || 0,
    } : null,
  };

  if (oracleLoad?.data) {
    report.oracle = {
      oraclePath,
      difficulty: oracleLoad.data.difficulty || null,
      mapSeed: oracleLoad.data.map_seed || null,
      knownOrders: oracleLoad.data.known_orders?.length || 0,
      items: oracleLoad.data.items?.length || 0,
      botCount: oracleLoad.data.bot_count || null,
    };
  }

  return report;
}

export function buildOpeningAuditWorkflowReport({ oraclePath, replayPath, scriptPath, maxTick = 120 }) {
  return buildOpeningAuditReport({
    oraclePath,
    replayPath,
    scriptPath,
    maxTick,
  });
}
