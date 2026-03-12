#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { generateOracleScriptCandidates } from './src/oracle/oracle-script-search.mjs';

function parseArgs(argv) {
  const args = { oracle: null, replay: null, out: null, strategy: 'auto', top: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--oracle') {
      args.oracle = value;
      index += 1;
    } else if (key === '--replay') {
      args.replay = value;
      index += 1;
    } else if (key === '--out') {
      args.out = value;
      index += 1;
    } else if (key === '--strategy') {
      args.strategy = value;
      index += 1;
    } else if (key === '--top') {
      args.top = Number.parseInt(value, 10);
      index += 1;
    }
  }

  if (!args.oracle) {
    throw new Error('--oracle required');
  }

  return {
    oracle: path.resolve(process.cwd(), args.oracle),
    replay: args.replay ? path.resolve(process.cwd(), args.replay) : null,
    out: args.out ? path.resolve(process.cwd(), args.out) : null,
    strategy: args.strategy,
    top: Number.isFinite(args.top) ? Math.max(1, args.top) : 10,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const oracle = JSON.parse(fs.readFileSync(args.oracle, 'utf8'));
  const candidates = generateOracleScriptCandidates({
    oracle,
    replayPath: args.replay,
    oracleSource: args.oracle,
    strategy: args.strategy,
  });

  const summary = {
    generated_at: new Date().toISOString(),
    oracle_source: args.oracle,
    replay: args.replay,
    strategy: args.strategy,
    candidates_tested: candidates.length,
    top_candidates: candidates.slice(0, args.top).map((candidate) => ({
      strategy: candidate.strategy,
      settings: candidate.script.settings,
      orders_covered: candidate.script.orders_covered,
      estimated_score: candidate.script.estimated_score,
      last_scripted_tick: candidate.script.last_scripted_tick,
      total_waits: candidate.script.aggregate_efficiency?.total_waits || 0,
    })),
  };

  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  }

  console.error(`Strategy: ${args.strategy}`);
  console.error(`Candidates tested: ${summary.candidates_tested}`);
  for (const [index, candidate] of summary.top_candidates.entries()) {
    console.error(
      `#${index + 1} ${candidate.strategy} orders=${candidate.orders_covered} score=${candidate.estimated_score} tick=${candidate.last_scripted_tick} waits=${candidate.total_waits}`,
    );
  }
  if (args.out) {
    console.error(`Output: ${args.out}`);
  }
}

main();
