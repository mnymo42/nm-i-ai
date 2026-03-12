#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { generateBestOracleScript } from './src/oracle/oracle-script-search.mjs';

function parseArgs(argv) {
  const args = { oracle: null, out: null, replay: null, strategy: 'auto' };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--oracle') {
      args.oracle = value;
      index += 1;
    } else if (key === '--out') {
      args.out = value;
      index += 1;
    } else if (key === '--replay') {
      args.replay = value;
      index += 1;
    } else if (key === '--strategy') {
      args.strategy = value;
      index += 1;
    }
  }

  if (!args.oracle) {
    throw new Error('--oracle required');
  }
  if (!args.out) {
    throw new Error('--out required');
  }

  return {
    oracle: path.resolve(process.cwd(), args.oracle),
    out: path.resolve(process.cwd(), args.out),
    replay: args.replay ? path.resolve(process.cwd(), args.replay) : null,
    strategy: args.strategy,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const oracle = JSON.parse(fs.readFileSync(args.oracle, 'utf8'));
  const { best, candidates } = generateBestOracleScript({
    oracle,
    replayPath: args.replay,
    oracleSource: args.oracle,
    strategy: args.strategy,
  });
  const script = {
    ...best,
    search: {
      strategy: args.strategy,
      candidates_tested: candidates.length,
      top_candidates: candidates.slice(0, 5).map((candidate) => ({
        strategy: candidate.strategy,
        settings: candidate.script.settings,
        orders_covered: candidate.script.orders_covered,
        estimated_score: candidate.script.estimated_score,
        last_scripted_tick: candidate.script.last_scripted_tick,
      })),
    },
  };

  fs.writeFileSync(args.out, `${JSON.stringify(script, null, 2)}\n`);

  console.error(`Oracle source: ${args.oracle}`);
  console.error(`Strategy: ${script.strategy}`);
  console.error(`Candidates tested: ${candidates.length}`);
  console.error(`Orders covered: ${script.orders_covered}`);
  console.error(`Estimated score: ${script.estimated_score}`);
  console.error(`Last scripted tick: ${script.last_scripted_tick}`);
  console.error(`Cutoff reason: ${script.cutoff_reason}`);
  console.error(`Output: ${args.out}`);
}

main();
