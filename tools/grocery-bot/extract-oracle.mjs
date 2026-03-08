#!/usr/bin/env node
import path from 'node:path';

import { extractOracleFromReplayCorpus } from './src/oracle-extract.mjs';

function parseArgs(argv) {
  const args = {
    outDir: path.resolve(process.cwd(), 'tools/grocery-bot/out'),
    out: path.resolve(process.cwd(), 'tools/grocery-bot/config/oracle-expert.json'),
    difficulty: 'expert',
    profile: 'expert',
    mapSeed: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--')) {
      continue;
    }
    if (['--out-dir', '--out', '--difficulty', '--profile', '--map-seed'].includes(key)) {
      if (value === undefined) {
        throw new Error(`Missing value for ${key}`);
      }
      index += 1;
    }

    switch (key) {
      case '--out-dir':
        args.outDir = path.resolve(process.cwd(), value);
        break;
      case '--out':
        args.out = path.resolve(process.cwd(), value);
        break;
      case '--difficulty':
        args.difficulty = value;
        break;
      case '--profile':
        args.profile = value;
        break;
      case '--map-seed':
        args.mapSeed = Number(value);
        break;
      default:
        break;
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { oracle, sources } = extractOracleFromReplayCorpus({
    outDir: args.outDir,
    outputPath: args.out,
    difficulty: args.difficulty,
    profile: args.profile,
    mapSeed: args.mapSeed,
  });

  console.error(`Wrote ${args.out}: ${oracle.known_orders.length} orders from ${sources.length} replays`);
  for (const order of oracle.known_orders) {
    console.error(`  ${order.id}: [${order.items_required.join(', ')}] (tick ${order.first_seen_tick})`);
  }
}

main();
