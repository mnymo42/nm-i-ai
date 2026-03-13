import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBotTooltipData,
  buildQueueEntries,
  buildTeamLegendEntries,
  getTeamShape,
} from '../viewer/public/view-model.mjs';

test('team shapes stay stable for the same team identity', () => {
  assert.equal(getTeamShape(1), getTeamShape(1));
  assert.notEqual(getTeamShape(1), getTeamShape(2));
});

test('queue entries are listed in slot order with hidden future orders preserved', () => {
  const snapshotOrders = [
    { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    { id: 'o1', items_required: ['bread'], items_delivered: [], status: 'preview', complete: false },
  ];
  const plannerMetrics = {
    queueOrderIds: ['o0', 'o1', 'o2'],
    teams: [
      { teamId: 4, orderId: 'o1', slotIndex: 1, role: 'prefetch', botIds: [3, 4] },
      { teamId: 2, orderId: 'o0', slotIndex: 0, role: 'active', botIds: [0, 1, 2] },
      { teamId: 7, orderId: 'o2', slotIndex: 2, role: 'prefetch', botIds: [5] },
    ],
  };

  const entries = buildQueueEntries(snapshotOrders, plannerMetrics);

  assert.deepEqual(entries.map((entry) => entry.orderId), ['o0', 'o1', 'o2']);
  assert.equal(entries[0].isFront, true);
  assert.equal(entries[2].isVisible, false);
  assert.deepEqual(entries[2].requiredItems, []);
});

test('queue entries preserve assigned and unassigned oracle-known order metadata', () => {
  const entries = buildQueueEntries(
    [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
    ],
    {
      queueOrderIds: ['o0', 'o1', 'o2'],
      queueOrders: [
        { orderId: 'o0', requiredItems: ['milk'], assigned: true, slotIndex: 0, teamId: 2 },
        { orderId: 'o1', requiredItems: ['bread', 'eggs'], assigned: false, slotIndex: null, teamId: null },
        { orderId: 'o2', requiredItems: ['apples'], assigned: false, slotIndex: null, teamId: null },
      ],
      teams: [
        { teamId: 2, orderId: 'o0', slotIndex: 0, role: 'active', botIds: [0, 1] },
      ],
    },
  );

  assert.equal(entries[0].assigned, true);
  assert.equal(entries[1].assigned, false);
  assert.deepEqual(entries[1].requiredItems, ['bread', 'eggs']);
  assert.equal(entries[1].isVisible, false);
});

test('team legend entries expose slot and order assignments', () => {
  const entries = buildTeamLegendEntries({
    teams: [
      { teamId: 8, orderId: 'o3', slotIndex: 2, role: 'prefetch', botIds: [8, 9] },
      { teamId: 1, orderId: 'o1', slotIndex: 0, role: 'active', botIds: [0, 1] },
    ],
  });

  assert.deepEqual(entries.map((entry) => entry.teamId), [1, 8]);
  assert.equal(entries[0].isFront, true);
  assert.equal(entries[1].teamShape, getTeamShape(8));
});

test('bot tooltip data includes team and target metadata for hover cards', () => {
  const data = buildBotTooltipData(
    [
      { id: 3, position: [4, 4], inventory: ['milk', 'bread'] },
      { id: 4, position: [4, 4], inventory: [] },
    ],
    {
      3: { teamId: 2, slotIndex: 1, orderId: 'o1', taskType: 'future_item', queuePosture: 'future_collect', target: [6, 3] },
      4: { teamId: 2, slotIndex: 1, orderId: 'o1', taskType: 'future_ready', queuePosture: 'future_ready', target: [5, 7] },
    },
  );

  assert.equal(data.length, 2);
  assert.deepEqual(data[0].inventory, ['milk', 'bread']);
  assert.equal(data[0].teamId, 2);
  assert.equal(data[0].queuePosture, 'future_collect');
  assert.deepEqual(data[1].target, [5, 7]);
  assert.equal(data[1].queuePosture, 'future_ready');
});
