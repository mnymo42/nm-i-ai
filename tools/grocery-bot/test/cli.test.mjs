import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTokenInput, parseCliArguments } from '../src/cli.mjs';

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
