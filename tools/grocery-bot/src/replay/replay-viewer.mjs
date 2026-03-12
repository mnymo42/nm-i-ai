import fs from 'node:fs';
import path from 'node:path';

import {
  collectReplayPaths,
  extractLayout,
  parseJsonl,
  rebuildSnapshot,
} from './replay-io.mjs';
import { generateAnalysis, summarizeReplay } from './replay.mjs';

function toPosix(value) {
  return value.replaceAll(path.sep, '/');
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
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

export function listReplayRuns(outDir, filters = {}) {
  const replayPaths = collectReplayPaths(outDir, filters.difficulty || null);
  const runs = [];

  for (const replayPath of replayPaths) {
    const runDir = path.dirname(replayPath);
    const summaryPath = path.join(runDir, 'summary.json');
    const analysisPath = path.join(runDir, 'analysis.json');
    const inferred = inferRunMetadata(runDir);
    const summary = safeReadJson(summaryPath);
    const analysis = safeReadJson(analysisPath);
    const stats = fs.statSync(replayPath);

    const run = {
      runId: summary?.runId || inferred.runId,
      path: runDir,
      relativePath: toPosix(path.relative(outDir, runDir)),
      replayPath,
      difficulty: summary?.difficulty || inferred.difficulty,
      profile: summary?.profile || inferred.profile,
      finalScore: summary?.finalScore ?? null,
      finalOrders: summary?.finalOrders ?? summary?.metrics?.ordersCompleted ?? null,
      finalItems: summary?.finalItems ?? summary?.metrics?.itemsDelivered ?? null,
      ticks: summary?.metrics?.ticks ?? null,
      totalStalls: summary?.metrics?.totalStalls ?? analysis?.multiBotCoordination?.totalStalls ?? null,
      modifiedAt: stats.mtime.toISOString(),
    };

    if (filters.profile && run.profile !== filters.profile) {
      continue;
    }

    runs.push(run);
  }

  runs.sort((left, right) => right.runId.localeCompare(left.runId));
  return runs;
}

export function resolveRunDirectory(runDir, outDir) {
  const resolvedOutDir = path.resolve(outDir);
  const resolvedRunDir = path.resolve(runDir);
  const relative = path.relative(resolvedOutDir, resolvedRunDir);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Run path is outside the replay output directory');
  }

  return resolvedRunDir;
}

export function loadReplayRun(runDir, outDir) {
  const safeRunDir = resolveRunDirectory(runDir, outDir);
  const replayPath = path.join(safeRunDir, 'replay.jsonl');
  if (!fs.existsSync(replayPath)) {
    throw new Error('Replay file not found');
  }

  const rows = parseJsonl(replayPath);
  const layout = extractLayout(rows);
  const summary = safeReadJson(path.join(safeRunDir, 'summary.json')) || summarizeReplay(replayPath);
  const analysis = safeReadJson(path.join(safeRunDir, 'analysis.json')) || generateAnalysis(replayPath);
  const ticks = rows
    .filter((row) => row.type === 'tick')
    .map((row) => ({
      ...row,
      state_snapshot: rebuildSnapshot(row.state_snapshot, layout),
    }));

  return {
    run: {
      ...inferRunMetadata(safeRunDir),
      path: safeRunDir,
      relativePath: toPosix(path.relative(path.resolve(outDir), safeRunDir)),
    },
    layout,
    summary,
    analysis,
    ticks,
  };
}
