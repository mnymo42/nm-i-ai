import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner.mjs';
import { defaultProfiles } from '../src/profile.mjs';

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 6, height: 6, walls: [] },
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [0, 0],
    score: 0,
    ...overrides,
  };
}

test('planner replays scripted tick verbatim and hands off to live planner afterward', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, { tick: 0, actions: [{ bot: 0, action: 'wait' }] }],
      ]),
    },
  });

  const scripted = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(scripted, [{ bot: 0, action: 'wait' }]);
  assert.equal(planner.getLastMetrics().scripted, true);

  const live = planner.plan(baseState({ round: 1 }));
  assert.deepEqual(live, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.notEqual(planner.getLastMetrics().scripted, true);
});

test('planner trusts replay-derived scripted tick when expected state matches', () => {
  const state = baseState({ round: 0 });
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, {
          tick: 0,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            type: 'game_state',
            round: 0,
            max_rounds: 300,
            score: 0,
            drop_off: [0, 0],
            drop_offs: [[0, 0]],
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
            items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
            orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['milk'], items_delivered: [] }],
          },
        }],
      ]),
    },
  });

  const scripted = planner.plan(state);
  assert.deepEqual(scripted, [{ bot: 0, action: 'wait' }]);
  assert.equal(planner.getLastMetrics().scripted, true);
  assert.equal(planner.getLastMetrics().scriptTrusted, true);
  assert.equal(planner.getLastMetrics().scriptExpectedStateMatched, true);
});

test('planner disables script and falls back to live planning on expected-state divergence', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
        [1, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, {
          tick: 0,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            type: 'game_state',
            round: 0,
            max_rounds: 300,
            score: 1,
            drop_off: [0, 0],
            drop_offs: [[0, 0]],
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
            items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
            orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['milk'], items_delivered: [] }],
          },
        }],
        [1, {
          tick: 1,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            type: 'game_state',
            round: 1,
            max_rounds: 300,
            score: 0,
            drop_off: [0, 0],
            drop_offs: [[0, 0]],
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
            items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
            orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['milk'], items_delivered: [] }],
          },
        }],
      ]),
    },
  });

  const first = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(first, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.equal(planner.getLastMetrics().scriptDiverged, true);
  assert.equal(planner.getLastMetrics().scriptDivergedAtRound, 0);

  const second = planner.plan(baseState({ round: 1 }));
  assert.notEqual(planner.getLastMetrics().scripted, true);
  assert.deepEqual(second, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
});

test('planner disables oracle and script on stale oracle item typing mismatch', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    oracle: {
      items: [{ id: 'item_0', type: 'bread', position: [2, 1] }],
    },
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, {
          tick: 0,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            score: 0,
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
          },
        }],
      ]),
    },
  });

  const first = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(first, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.equal(planner.getLastMetrics().scripted, undefined);
  assert.equal(planner.getLastMetrics().oracleDisabled, true);
  assert.equal(planner.getLastMetrics().scriptDisabled, true);
  assert.equal(planner.getLastMetrics().assumptionMismatch.reason, 'oracle_item_rotation_mismatch');
  assert.equal(planner.getLastMetrics().assumptionMismatch.mismatchCount, 1);
});

test('planner disables script when expected order state does not match exactly', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([[0, [{ bot: 0, action: 'wait' }]]]),
      entryMap: new Map([[0, {
        tick: 0,
        actions: [{ bot: 0, action: 'wait' }],
        expected_state: {
          type: 'game_state',
          round: 0,
          max_rounds: 300,
          score: 0,
          drop_off: [0, 0],
          drop_offs: [[0, 0]],
          bots: [{ id: 0, position: [1, 1], inventory: [] }],
          items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
          orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['bread'], items_delivered: [] }],
        },
      }]]),
    },
  });

  const first = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(first, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.equal(planner.getLastMetrics().scriptDiverged, true);
});

test('planner disables script when expected remaining shelf items do not match exactly', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([[0, [{ bot: 0, action: 'wait' }]]]),
      entryMap: new Map([[0, {
        tick: 0,
        actions: [{ bot: 0, action: 'wait' }],
        expected_state: {
          type: 'game_state',
          round: 0,
          max_rounds: 300,
          score: 0,
          drop_off: [0, 0],
          drop_offs: [[0, 0]],
          bots: [{ id: 0, position: [1, 1], inventory: [] }],
          items: [{ id: 'item_0', type: 'bread', position: [2, 1] }],
          orders: [{ id: 'o0', status: 'active', complete: false, items_required: ['milk'], items_delivered: [] }],
        },
      }]]),
    },
  });

  const first = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(first, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.equal(planner.getLastMetrics().scriptDiverged, true);
});
