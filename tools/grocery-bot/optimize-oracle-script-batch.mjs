#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  buildBatchReport,
  buildOptimizationJobs,
  compareOptimizationResults,
} from './src/oracle/oracle-script-batch.mjs';

function parseArgs(argv) {
  const args = {
    oracle: null,
    replay: null,
    outScript: null,
    outReport: null,
    strategy: 'auto',
    objective: 'score_by_tick_100',
    iterations: 150,
    runs: 16,
    parallel: Math.min(os.cpus().length, 8),
    seed: 7004,
    objectives: ['score_by_tick_100', 'throughput_frontier', 'tick_to_score'],
    preset: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (['--oracle', '--replay', '--out-script', '--out-report', '--strategy', '--objective', '--iterations', '--runs', '--parallel', '--seed', '--objectives', '--preset'].includes(key)) {
      if (value === undefined) {
        throw new Error(`Missing value for ${key}`);
      }
      index += 1;
    }
    switch (key) {
      case '--oracle':
        args.oracle = path.resolve(process.cwd(), value);
        break;
      case '--replay':
        args.replay = path.resolve(process.cwd(), value);
        break;
      case '--out-script':
        args.outScript = path.resolve(process.cwd(), value);
        break;
      case '--out-report':
        args.outReport = path.resolve(process.cwd(), value);
        break;
      case '--strategy':
        args.strategy = value;
        break;
      case '--objective':
        args.objective = value;
        break;
      case '--iterations':
        args.iterations = Number.parseInt(value, 10);
        break;
      case '--runs':
        args.runs = Number.parseInt(value, 10);
        break;
      case '--parallel':
        args.parallel = Number.parseInt(value, 10);
        break;
      case '--seed':
        args.seed = Number.parseInt(value, 10);
        break;
      case '--objectives':
        args.objectives = value.split(',').map((entry) => entry.trim()).filter(Boolean);
        break;
      case '--preset':
        args.preset = value;
        break;
      default:
        break;
    }
  }

  if (args.preset) {
    const presets = {
      opening_100: {
        objective: 'score_by_tick_100',
        objectives: ['score_by_tick_100', 'throughput_frontier'],
        iterations: 220,
        strategy: 'auto',
      },
      tick_to_40: {
        objective: 'tick_to_score',
        objectives: ['tick_to_score'],
        iterations: 180,
        strategy: 'auto',
      },
      tick_to_60: {
        objective: 'tick_to_score',
        objectives: ['tick_to_score', 'throughput_frontier'],
        iterations: 220,
        strategy: 'auto',
      },
      tick_to_80: {
        objective: 'throughput_frontier',
        objectives: ['throughput_frontier', 'tick_to_score'],
        iterations: 260,
        strategy: 'auto',
      },
    };
    const preset = presets[args.preset];
    if (!preset) {
      throw new Error(`Unknown preset: ${args.preset}`);
    }
    args.objective = preset.objective;
    args.objectives = preset.objectives;
    args.iterations = preset.iterations;
    args.strategy = preset.strategy;
  }

  if (!args.oracle) throw new Error('--oracle required');
  if (!args.replay) throw new Error('--replay required');
  if (!args.outScript) throw new Error('--out-script required');
  if (!args.outReport) throw new Error('--out-report required');
  return args;
}

function runJob({ job, args, tempDir }) {
  const outScript = path.join(tempDir, `script-${job.id}.json`);
  const outReport = path.join(tempDir, `report-${job.id}.json`);
  const childArgs = [
    'tools/grocery-bot/optimize-oracle-script.mjs',
    '--oracle', args.oracle,
    '--replay', args.replay,
    '--out-script', outScript,
    '--out-report', outReport,
    '--strategy', job.strategy,
    '--objective', job.objective,
    '--iterations', String(job.iterations),
    '--seed', String(job.seed),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('node', childArgs, {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`job ${job.id} failed: ${stderr}`));
        return;
      }
      const script = JSON.parse(fs.readFileSync(outScript, 'utf8'));
      const report = JSON.parse(fs.readFileSync(outReport, 'utf8'));
      resolve({
        job,
        script,
        report,
        paths: { outScript, outReport },
        stderr,
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-batch-'));
  const jobs = buildOptimizationJobs({
    runs: args.runs,
    seed: args.seed,
    objectives: args.objectives,
    strategy: args.strategy,
    iterations: args.iterations,
  });
  const startedAt = Date.now();
  const pending = [...jobs];
  const running = new Set();
  const results = [];

  async function startNext() {
    const job = pending.shift();
    if (!job) {
      return;
    }
    const promise = runJob({ job, args, tempDir })
      .then((result) => {
        results.push(result);
        const currentBest = [...results].sort((left, right) => compareOptimizationResults(left, right, args.objective))[0];
        console.error(
          `[batch] completed job=${job.id} seed=${job.seed} objective=${job.objective} best=${currentBest.script.strategy}:${currentBest.script.estimated_score}s@${currentBest.script.last_scripted_tick}`,
        );
      })
      .finally(() => {
        running.delete(promise);
      });
    running.add(promise);
  }

  while (pending.length > 0 || running.size > 0) {
    while (pending.length > 0 && running.size < args.parallel) {
      await startNext();
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  if (results.length === 0) {
    throw new Error('No completed optimization jobs');
  }

  const best = [...results].sort((left, right) => compareOptimizationResults(left, right, args.objective))[0];
  fs.writeFileSync(args.outScript, `${JSON.stringify(best.script, null, 2)}\n`);

  const batchReport = buildBatchReport({
    oraclePath: args.oracle,
    replayPath: args.replay,
    objective: args.objective,
    parallel: args.parallel,
    jobs,
    results,
    elapsedMs: Date.now() - startedAt,
  });
  fs.writeFileSync(args.outReport, `${JSON.stringify(batchReport, null, 2)}\n`);

  console.error(`Batch jobs: ${jobs.length}`);
  console.error(`Parallel workers: ${args.parallel}`);
  console.error(`Best strategy: ${best.script.strategy}`);
  console.error(`Best score: ${best.script.estimated_score}`);
  console.error(`Best tick: ${best.script.last_scripted_tick}`);
  console.error(`Best script: ${args.outScript}`);
  console.error(`Batch report: ${args.outReport}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
