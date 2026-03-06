import test from 'node:test';
import assert from 'node:assert/strict';

import { parseServerMessage, buildActionEnvelope } from '../src/protocol.mjs';

test('parseServerMessage accepts game_state and normalizes structure', () => {
  const parsed = parseServerMessage(JSON.stringify({
    type: 'game_state',
    round: 1,
    max_rounds: 300,
    grid: { width: 3, height: 3, walls: [] },
    bots: [],
    items: [],
    orders: [],
    drop_off: [0, 0],
    score: 0,
  }));

  assert.equal(parsed.type, 'game_state');
  assert.equal(parsed.round, 1);
});

test('parseServerMessage accepts game_over', () => {
  const parsed = parseServerMessage(JSON.stringify({ type: 'game_over', score: 7 }));
  assert.equal(parsed.type, 'game_over');
  assert.equal(parsed.score, 7);
});

test('buildActionEnvelope returns valid JSON payload shape', () => {
  const payload = buildActionEnvelope([{ bot: 0, action: 'wait' }]);
  assert.equal(payload, '{"actions":[{"bot":0,"action":"wait"}]}');
});
