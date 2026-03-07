import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunProvenance } from '../src/run-provenance.mjs';

test('buildRunProvenance includes stable hashes and script/oracle metadata', () => {
  const profile = { runtime: { multi_bot_strategy: 'warehouse_v1' } };
  const oracle = {
    generated_at: '2026-03-07T20:00:00.000Z',
    known_orders: [{ id: 'order_0' }, { id: 'order_1' }],
    items: [{ id: 'item_0', type: 'oats' }],
  };
  const script = {
    generated_at: '2026-03-07T21:00:00.000Z',
    strategy: 'replay_rewind_preserve_v1',
    last_scripted_tick: 51,
    ticks: [{ tick: 0, actions: [{ bot: 0, action: 'wait' }] }],
    replay_target_meta: {
      source_replay: '/tmp/source.jsonl',
      validation_replay: '/tmp/validation.jsonl',
    },
  };

  const provenance = buildRunProvenance({
    difficulty: 'expert',
    profileName: 'expert_replay_handoff',
    profile,
    oraclePath: '/tmp/oracle.json',
    oracle,
    scriptPath: '/tmp/script.json',
    script,
  });

  assert.equal(provenance.difficulty, 'expert');
  assert.equal(provenance.profileName, 'expert_replay_handoff');
  assert.equal(typeof provenance.profileHash, 'string');
  assert.equal(provenance.oracle.path, '/tmp/oracle.json');
  assert.equal(provenance.oracle.knownOrders, 2);
  assert.equal(provenance.script.path, '/tmp/script.json');
  assert.equal(provenance.script.strategy, 'replay_rewind_preserve_v1');
  assert.equal(provenance.script.lastScriptedTick, 51);
  assert.equal(provenance.script.sourceReplay, '/tmp/source.jsonl');
  assert.equal(provenance.script.validationReplay, '/tmp/validation.jsonl');
  assert.equal(typeof provenance.oracle.hash, 'string');
  assert.equal(typeof provenance.script.hash, 'string');
  assert.equal(typeof provenance.git.dirty, 'boolean');
});
