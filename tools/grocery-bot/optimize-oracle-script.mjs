#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
  buildOracleSearchReport,
  generateBestOracleScript,
} from './src/oracle/oracle-script-search.mjs';

function parseArgs(argv) {
  const args = {
    oracle: null,
    replay: null,
    outScript: null,
    outReport: null,
    strategy: 'auto',
    objective: 'score_by_tick_100',
    iterations: 1000,
    scoreToBeat: null,
    ticksToBeat: null,
    seed: 7004,
    top: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--oracle') {
      args.oracle = value;
      index += 1;
    } else if (key === '--replay') {
      args.replay = value;
      index += 1;
    } else if (key === '--out-script') {
      args.outScript = value;
      index += 1;
    } else if (key === '--out-report') {
      args.outReport = value;
      index += 1;
    } else if (key === '--strategy') {
      args.strategy = value;
      index += 1;
    } else if (key === '--objective') {
      args.objective = value;
      index += 1;
    } else if (key === '--iterations') {
      args.iterations = Number.parseInt(value, 10);
      index += 1;
    } else if (key === '--score-to-beat') {
      args.scoreToBeat = Number.parseInt(value, 10);
      index += 1;
    } else if (key === '--ticks-to-beat') {
      args.ticksToBeat = Number.parseInt(value, 10);
      index += 1;
    } else if (key === '--seed') {
      args.seed = Number.parseInt(value, 10);
      index += 1;
    } else if (key === '--top') {
      args.top = Number.parseInt(value, 10);
      index += 1;
    }
  }

  if (!args.oracle) {
    throw new Error('--oracle required');
  }
  if (!args.outScript) {
    throw new Error('--out-script required');
  }
  if (!args.outReport) {
    throw new Error('--out-report required');
  }

  return {
    oracle: path.resolve(process.cwd(), args.oracle),
    replay: args.replay ? path.resolve(process.cwd(), args.replay) : null,
    outScript: path.resolve(process.cwd(), args.outScript),
    outReport: path.resolve(process.cwd(), args.outReport),
    strategy: args.strategy,
    objective: args.objective,
    iterations: Number.isFinite(args.iterations) ? Math.max(1, args.iterations) : 1000,
    scoreToBeat: Number.isFinite(args.scoreToBeat) ? args.scoreToBeat : null,
    ticksToBeat: Number.isFinite(args.ticksToBeat) ? args.ticksToBeat : null,
    seed: Number.isFinite(args.seed) ? args.seed : 7004,
    top: Number.isFinite(args.top) ? Math.max(1, args.top) : 20,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const oracle = JSON.parse(fs.readFileSync(args.oracle, 'utf8'));
  const startedAt = Date.now();
  let lastProgressPrinted = 0;

  function reportProgress({ completed, total, latestStrategy, candidatesKept, best }) {
    const shouldPrint = completed <= 5 || completed - lastProgressPrinted >= 25 || completed === total;
    if (!shouldPrint) {
      return;
    }
    lastProgressPrinted = completed;
    const bestText = best
      ? ` best=${best.strategy}:${best.ordersCovered}o/${best.estimatedScore}s@${best.lastScriptedTick}`
      : '';
    console.error(
      `[progress] ${completed}/${total} evaluated (${latestStrategy}), valid=${candidatesKept}${bestText}`,
    );
  }

  const { best, candidates } = generateBestOracleScript({
    oracle,
    replayPath: args.replay,
    oracleSource: args.oracle,
    strategy: args.strategy,
    objective: args.objective,
    candidateLimit: args.iterations,
    seed: args.seed,
    searchSpace: 'wide',
    onProgress: reportProgress,
  });

  const report = {
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    oracle_source: args.oracle,
    replay: args.replay,
    strategy: args.strategy,
    objective: args.objective,
    iterations_requested: args.iterations,
    seed: args.seed,
    ...buildOracleSearchReport({
      candidates,
      scoreToBeat: args.scoreToBeat,
      tickToBeat: args.ticksToBeat,
      top: args.top,
      objective: args.objective,
    }),
  };

  const bestScript = {
    ...best,
    optimization_meta: {
      optimizer: 'optimize-oracle-script',
      strategy: args.strategy,
      objective: args.objective,
      iterations_requested: args.iterations,
      candidates_tested: candidates.length,
      score_to_beat: args.scoreToBeat,
      ticks_to_beat: args.ticksToBeat,
      seed: args.seed,
      elapsed_ms: report.elapsed_ms,
      rank: 1,
      top_candidates: report.top_candidates.slice(0, Math.min(10, report.top_candidates.length)),
    },
  };

  fs.writeFileSync(args.outScript, `${JSON.stringify(bestScript, null, 2)}\n`);
  fs.writeFileSync(args.outReport, `${JSON.stringify(report, null, 2)}\n`);

  console.error(`Strategy: ${args.strategy}`);
  console.error(`Objective: ${args.objective}`);
  console.error(`Iterations requested: ${args.iterations}`);
  console.error(`Candidates tested: ${candidates.length}`);
  console.error(`Best strategy: ${bestScript.strategy}`);
  console.error(`Orders covered: ${bestScript.orders_covered}`);
  console.error(`Estimated score: ${bestScript.estimated_score}`);
  console.error(`Last scripted tick: ${bestScript.last_scripted_tick}`);
  if (args.scoreToBeat !== null) {
    console.error(`Score target beaten: ${bestScript.estimated_score > args.scoreToBeat}`);
  }
  if (args.ticksToBeat !== null) {
    console.error(`Tick target beaten: ${bestScript.last_scripted_tick < args.ticksToBeat}`);
  }
  console.error(`Best script: ${args.outScript}`);
  console.error(`Report: ${args.outReport}`);
}

main();
