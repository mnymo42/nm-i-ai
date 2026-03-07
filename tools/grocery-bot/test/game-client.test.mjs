import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryGameClient, sanitizeActionsForState } from '../src/game-client.mjs';

function nextPosition(position, action) {
  const [x, y] = position;
  switch (action) {
    case 'move_up':
      return [x, y - 1];
    case 'move_down':
      return [x, y + 1];
    case 'move_left':
      return [x - 1, y];
    case 'move_right':
      return [x + 1, y];
    default:
      return position;
  }
}

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

test('sanitizeActionsForState keeps valid adjacent pick_up', () => {
  const state = baseState();
  const actions = sanitizeActionsForState([{ bot: 0, action: 'pick_up', item_id: 'item_0' }], state);
  assert.deepEqual(actions, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
});

test('sanitizeActionsForState nudges full-inventory pick_up to a legal move', () => {
  const state = baseState({
    bots: [{ id: 0, position: [1, 1], inventory: ['milk', 'cheese', 'butter'] }],
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'pick_up', item_id: 'item_0' }], state);
  assert.equal(actions[0].bot, 0);
  assert.equal(actions[0].action.startsWith('move_'), true);
});

test('sanitizeActionsForState nudges non-dropoff drop_off to a legal move', () => {
  const state = baseState({
    bots: [{ id: 0, position: [1, 1], inventory: ['milk'] }],
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'drop_off' }], state);
  assert.equal(actions[0].bot, 0);
  assert.equal(actions[0].action.startsWith('move_'), true);
});

test('sanitizeActionsForState nudges blocked move to an alternative legal move', () => {
  const state = baseState({
    grid: { width: 6, height: 6, walls: [[2, 1]] },
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'move_right' }], state);
  assert.equal(actions[0].bot, 0);
  assert.equal(actions[0].action.startsWith('move_'), true);
  assert.notEqual(actions[0].action, 'move_right');
});

test('sanitizeActionsForState fills missing bot action with a legal fallback action', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [3, 3], inventory: [] },
    ],
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'move_left' }], state);
  assert.deepEqual(actions[0], { bot: 0, action: 'move_left' });
  assert.equal(actions[1].bot, 1);
  assert.equal(actions[1].action.startsWith('move_') || actions[1].action === 'wait', true);
});

test('sanitizeActionsForState keeps valid planned wait when nudge_planned_waits is false', () => {
  const state = baseState({
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'item_0', type: 'milk', position: [3, 1] }],
    drop_off: [0, 0],
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'wait' }], state);
  assert.deepEqual(actions, [{ bot: 0, action: 'wait' }]);
});

test('sanitizeActionsForState nudges explicit wait when nudge_planned_waits is true', () => {
  const state = baseState({
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'item_0', type: 'milk', position: [3, 1] }],
    drop_off: [0, 0],
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'wait' }], state, {
    nudge_invalid_only: true,
    nudge_planned_waits: true,
  });
  assert.deepEqual(actions, [{ bot: 0, action: 'move_right' }]);
});

test('sanitizeActionsForState keeps wait when no movement is possible', () => {
  const state = baseState({
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    grid: {
      width: 3,
      height: 3,
      walls: [[0, 1], [2, 1], [1, 0], [1, 2]],
    },
    items: [],
  });
  const actions = sanitizeActionsForState([{ bot: 0, action: 'wait' }], state);
  assert.deepEqual(actions, [{ bot: 0, action: 'wait' }]);
});

test('sanitizeActionsForState prevents two bots from targeting the same cell', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [3, 1], inventory: [] },
    ],
    items: [],
  });

  const actions = sanitizeActionsForState([
    { bot: 0, action: 'move_right' },
    { bot: 1, action: 'move_left' },
  ], state);

  const targets = actions.map((action, index) => nextPosition(state.bots[index].position, action.action));
  assert.notDeepEqual(targets[0], targets[1]);
});

test('sanitizeActionsForState prevents head-on swap moves', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [2, 1], inventory: [] },
    ],
    items: [],
  });

  const actions = sanitizeActionsForState([
    { bot: 0, action: 'move_right' },
    { bot: 1, action: 'move_left' },
  ], state);

  assert.notDeepEqual(actions, [
    { bot: 0, action: 'move_right' },
    { bot: 1, action: 'move_left' },
  ]);
});

test('sanitizeActionsForState prevents moving into a cell occupied by a stationary bot', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [2, 1], inventory: [] },
    ],
    items: [],
  });

  const actions = sanitizeActionsForState([
    { bot: 0, action: 'move_right' },
    { bot: 1, action: 'wait' },
  ], state);

  assert.notEqual(actions[0].action, 'move_right');
});

test('sanitizeActionsForState preserves drop_off for bot already occupying drop-off cell', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [0, 0], inventory: ['milk'] },
      { id: 1, position: [1, 0], inventory: ['bread'] },
    ],
    items: [],
    drop_off: [0, 0],
  });

  const actions = sanitizeActionsForState([
    { bot: 0, action: 'drop_off' },
    { bot: 1, action: 'move_left' },
  ], state);

  const byBot = new Map(actions.map((action) => [action.bot, action]));
  assert.deepEqual(byBot.get(0), { bot: 0, action: 'drop_off' });
  assert.notEqual(byBot.get(1).action, 'move_left');
});

test('game client sends at most one payload per round', async () => {
  const sent = [];
  const client = new GroceryGameClient({ token: 'test-token', minRoundSendIntervalMs: 0 });
  client.ws = {
    readyState: 1,
    send(payload) {
      sent.push(payload);
    },
  };

  const first = await client.sendActionsForRound([{ bot: 0, action: 'wait' }], 12);
  assert.equal(typeof first, 'string');
  assert.equal(sent.length, 1);

  await assert.rejects(
    () => client.sendActionsForRound([{ bot: 0, action: 'wait' }], 12),
    /already sent for round 12/,
  );
  assert.equal(sent.length, 1);
});

test('game client allows sends for new rounds after the hard limit guard', async () => {
  const sent = [];
  const client = new GroceryGameClient({ token: 'test-token', minRoundSendIntervalMs: 0 });
  client.ws = {
    readyState: 1,
    send(payload) {
      sent.push(payload);
    },
  };

  await client.sendActionsForRound([{ bot: 0, action: 'wait' }], 12);
  await client.sendActionsForRound([{ bot: 0, action: 'move_right' }], 13);

  assert.equal(sent.length, 2);
});

test('game client enforces a minimum 20ms interval between round sends', async () => {
  const sent = [];
  const client = new GroceryGameClient({ token: 'test-token', minRoundSendIntervalMs: 20 });
  client.ws = {
    readyState: 1,
    send(payload) {
      sent.push({ payload, sentAt: Date.now() });
    },
  };

  await client.sendActionsForRound([{ bot: 0, action: 'wait' }], 12);
  await client.sendActionsForRound([{ bot: 0, action: 'move_right' }], 13);

  assert.equal(sent.length, 2);
  assert.equal(sent[1].sentAt - sent[0].sentAt >= 15, true);
  assert.equal(client.lastSendDelayMs >= 0, true);
});
