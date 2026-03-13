import test from 'node:test';
import assert from 'node:assert/strict';

import { inferDifficultyFromToken, normalizeTokenInput, parseCliArguments } from '../src/utils/cli.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';

const hardToken = 'eyJhbGciOiJIUzI1NiJ9.eyJkaWZmaWN1bHR5IjoiaGFyZCJ9.sig';

test('normalizeTokenInput keeps raw JWT tokens unchanged', () => {
  const token = 'header.payload.signature';
  assert.equal(normalizeTokenInput(token), token);
});

test('normalizeTokenInput extracts token from full websocket URL', () => {
  const url = 'wss://game.ainm.no/ws?token=header.payload.signature';
  assert.equal(normalizeTokenInput(url), 'header.payload.signature');
});

test('parseCliArguments accepts full websocket URL for --token', () => {
  const args = parseCliArguments([
    '--token', 'wss://game.ainm.no/ws?token=header.payload.signature',
    '--difficulty', 'medium',
  ]);

  assert.equal(args.token, 'header.payload.signature');
  assert.equal(args.difficulty, 'medium');
});

test('inferDifficultyFromToken reads the JWT payload difficulty', () => {
  assert.equal(inferDifficultyFromToken(hardToken), 'hard');
});

test('parseCliArguments infers difficulty from token when not explicitly set', () => {
  const args = parseCliArguments([
    '--token', hardToken,
  ]);

  assert.equal(args.difficulty, 'hard');
});

test('parseCliArguments infers difficulty from websocket token URL when not explicitly set', () => {
  const args = parseCliArguments([
    '--token', `wss://game.ainm.no/ws?token=${hardToken}`,
  ]);

  assert.equal(args.difficulty, 'hard');
});

test('parseCliArguments accepts benchmark mode with replay path', () => {
  const args = parseCliArguments([
    '--mode', 'benchmark',
    '--difficulty', 'medium',
    '--replay', 'tools/grocery-bot/out',
  ]);

  assert.equal(args.mode, 'benchmark');
  assert.equal(args.difficulty, 'medium');
  assert.match(args.replay, /tools\/grocery-bot\/out$/);
});

test('parseCliArguments accepts oracle-benchmark mode with oracle, runs, variants, and report', () => {
  const args = parseCliArguments([
    '--mode', 'oracle-benchmark',
    '--difficulty', 'expert',
    '--oracle', 'tools/grocery-bot/config/oracle-expert.json',
    '--runs', '3',
    '--variants', 'v3,v4',
    '--report', 'tools/grocery-bot/out/oracle-report.json',
  ]);

  assert.equal(args.mode, 'oracle-benchmark');
  assert.equal(args.runs, 3);
  assert.equal(args.variants, 'v3,v4');
  assert.match(args.oracle, /tools\/grocery-bot\/config\/oracle-expert\.json$/);
  assert.match(args.report, /tools\/grocery-bot\/out\/oracle-report\.json$/);
});

test('parseCliArguments accepts runs mode with limit', () => {
  const args = parseCliArguments([
    '--mode', 'runs',
    '--difficulty', 'expert',
    '--limit', '5',
  ]);

  assert.equal(args.mode, 'runs');
  assert.equal(args.limit, 5);
  assert.equal(args.difficulty, 'expert');
});

test('parseCliArguments accepts analyze mode with a replay target', () => {
  const args = parseCliArguments([
    '--mode', 'analyze',
    '--difficulty', 'expert',
    '--replay', 'tools/grocery-bot/out/example/replay.jsonl',
  ]);

  assert.equal(args.mode, 'analyze');
  assert.match(args.replay, /tools\/grocery-bot\/out\/example\/replay\.jsonl$/);
});

test('parseCliArguments requires --script for script-info mode', () => {
  assert.throws(
    () => parseCliArguments(['--mode', 'script-info', '--difficulty', 'expert']),
    /--script is required for mode=script-info/,
  );
});

test('parseCliArguments accepts opening-audit mode with replay, oracle, script, and max tick', () => {
  const args = parseCliArguments([
    '--mode', 'opening-audit',
    '--difficulty', 'expert',
    '--replay', 'tools/grocery-bot/out/example/replay.jsonl',
    '--oracle', 'tools/grocery-bot/config/oracle-expert.json',
    '--script', 'tools/grocery-bot/config/script-expert.json',
    '--max-tick', '90',
  ]);

  assert.equal(args.mode, 'opening-audit');
  assert.equal(args.maxTick, 90);
  assert.match(args.replay, /tools\/grocery-bot\/out\/example\/replay\.jsonl$/);
});

test('nightmare difficulty is accepted and has a default profile', () => {
  const args = parseCliArguments([
    '--token', 'header.payload.signature',
    '--difficulty', 'nightmare',
  ]);

  assert.equal(args.difficulty, 'nightmare');
  assert.equal(defaultProfiles.nightmare.runtime.multi_bot_strategy, 'warehouse_v1');
});

test('parseCliArguments resolves --oracle and --script paths', () => {
  const args = parseCliArguments([
    '--token', 'header.payload.signature',
    '--oracle', 'tools/grocery-bot/config/oracle-expert.json',
    '--script', 'tools/grocery-bot/config/script-expert.json',
  ]);

  assert.match(args.oracle, /tools\/grocery-bot\/config\/oracle-expert\.json$/);
  assert.match(args.script, /tools\/grocery-bot\/config\/script-expert\.json$/);
});

test('expert_replay_handoff profile is frozen as a copy of expert', () => {
  assert.deepEqual(defaultProfiles.expert_replay_handoff, defaultProfiles.expert);
});
