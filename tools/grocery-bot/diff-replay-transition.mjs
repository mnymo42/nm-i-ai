#!/usr/bin/env node

import path from 'node:path';

import {
  compareReplayTransitionAtTick,
  findFirstReplayTransitionMismatch,
} from './src/replay/replay-transition-diff.mjs';

function parseArgs(argv) {
  const args = {
    sourceReplay: null,
    validationReplay: null,
    tick: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--source-replay') {
      args.sourceReplay = value;
      index += 1;
    } else if (key === '--validation-replay') {
      args.validationReplay = value;
      index += 1;
    } else if (key === '--tick') {
      args.tick = Number.parseInt(value, 10);
      index += 1;
    }
  }

  if (!args.sourceReplay) throw new Error('--source-replay required');
  if (!args.validationReplay) throw new Error('--validation-replay required');

  return {
    sourceReplay: path.resolve(process.cwd(), args.sourceReplay),
    validationReplay: path.resolve(process.cwd(), args.validationReplay),
    tick: Number.isFinite(args.tick) ? args.tick : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.tick === null
    ? findFirstReplayTransitionMismatch({
      sourceReplayPath: args.sourceReplay,
      validationReplayPath: args.validationReplay,
    })
    : compareReplayTransitionAtTick({
      sourceReplayPath: args.sourceReplay,
      validationReplayPath: args.validationReplay,
      tick: args.tick,
    });

  console.log(JSON.stringify(result, null, 2));
}

main();
