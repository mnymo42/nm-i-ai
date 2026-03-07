import test from 'node:test';
import assert from 'node:assert/strict';

import { inferDifficultyFromToken, normalizeTokenInput, parseCliArguments } from '../src/cli.mjs';
import { defaultProfiles } from '../src/profile.mjs';

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

test('nightmare difficulty is accepted and has a default profile', () => {
  const args = parseCliArguments([
    '--token', 'header.payload.signature',
    '--difficulty', 'nightmare',
  ]);

  assert.equal(args.difficulty, 'nightmare');
  assert.equal(defaultProfiles.nightmare.runtime.multi_bot_strategy, 'warehouse_v1');
});
