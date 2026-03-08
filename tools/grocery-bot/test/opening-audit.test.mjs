import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpeningAuditReport } from '../src/opening-audit.mjs';
import { buildOpeningAuditWorkflowReport } from '../src/workflow-tools.mjs';

function writeAuditFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-audit-'));
  const oraclePath = path.join(root, 'oracle.json');
  const scriptPath = path.join(root, 'script.json');
  const replayPath = path.join(root, 'replay.jsonl');

  fs.writeFileSync(oraclePath, JSON.stringify({
    map_seed: 7004,
    difficulty: 'expert',
    grid: { width: 5, height: 5 },
    drop_off: [1, 3],
    bot_count: 1,
    known_orders: [
      { id: 'order_0', items_required: ['milk'], first_seen_tick: 0 },
    ],
    items: [
      { id: 'item_0', type: 'milk', position: [1, 1] },
    ],
  }, null, 2));

  fs.writeFileSync(scriptPath, JSON.stringify({
    strategy: 'wait_only',
    last_scripted_tick: 1,
    ticks: [
      { tick: 0, actions: [{ bot: 0, action: 'wait' }] },
      { tick: 1, actions: [{ bot: 0, action: 'wait' }] },
    ],
  }, null, 2));

  fs.writeFileSync(replayPath, [
    JSON.stringify({
      type: 'layout',
      grid: { width: 5, height: 5, walls: [] },
      drop_off: [1, 3],
      max_rounds: 300,
    }),
    JSON.stringify({
      type: 'tick',
      tick: 0,
      state_snapshot: {
        score: 0,
        bots: [{ id: 0, position: [1, 1], inventory: [] }],
        items: [{ id: 'item_0', type: 'milk', position: [1, 1] }],
        orders: [{ id: 'order_0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
      },
      actions_sent: [{ bot: 0, action: 'pick_up', item_id: 'item_0' }],
      sanitizer_overrides: [],
    }),
    JSON.stringify({
      type: 'tick',
      tick: 1,
      state_snapshot: {
        score: 4,
        bots: [{ id: 0, position: [1, 3], inventory: [] }],
        items: [],
        orders: [{ id: 'order_0', items_required: ['milk'], items_delivered: ['milk'], status: 'complete', complete: true }],
      },
      actions_sent: [{ bot: 0, action: 'drop_off' }],
      sanitizer_overrides: [],
    }),
  ].join('\n'));

  return { oraclePath, scriptPath, replayPath };
}

test('opening audit extracts deterministic replay baseline metrics', () => {
  const fixture = writeAuditFixture();

  const first = buildOpeningAuditReport({ ...fixture, maxTick: 5 });
  const second = buildOpeningAuditReport({ ...fixture, maxTick: 5 });

  assert.equal(first.opening_baseline.first_pickup_tick, 0);
  assert.equal(first.opening_baseline.first_drop_tick, 1);
  assert.equal(first.opening_baseline.first_score_tick, 1);
  assert.equal(first.opening_baseline.final_score, 4);
  assert.equal(first.opening_baseline.score_at_tick_60, 4);
  assert.equal(first.opening_baseline.handoff_readiness.stranded_inventory, 0);
  assert.deepEqual(first.opening_baseline, second.opening_baseline);
});

test('opening audit finds earliest divergence against weaker candidate', () => {
  const fixture = writeAuditFixture();

  const report = buildOpeningAuditReport({ ...fixture, maxTick: 5 });

  assert.equal(report.first_divergence_tick, 0);
  assert.equal(report.first_divergence.cause, 'idle_or_work_release_gap');
  assert.ok(report.first_divergence.differences.includes('productive_bot_ticks'));
  assert.equal(report.opening_profile.first_pickup_tick, null);
  assert.equal(report.opening_profile.score_at_tick_100, 0);
  assert.equal(report.opening_profile.handoff_readiness.stranded_inventory, 0);
});

test('workflow opening audit wrapper returns the same divergence summary', () => {
  const fixture = writeAuditFixture();

  const report = buildOpeningAuditWorkflowReport({ ...fixture, maxTick: 5 });

  assert.equal(report.first_divergence_tick, 0);
  assert.equal(report.opening_profile.final_score, 0);
});
