import { normalizeDropOffs } from './drop-zones.mjs';

const ACTIONS = new Set([
  'move_up',
  'move_down',
  'move_left',
  'move_right',
  'pick_up',
  'drop_off',
  'wait',
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeGameState(payload) {
  assert(typeof payload.round === 'number', 'game_state.round is required');
  assert(payload.grid && typeof payload.grid.width === 'number' && typeof payload.grid.height === 'number', 'game_state.grid is invalid');
  const dropOffs = normalizeDropOffs(payload);

  return {
    type: 'game_state',
    round: payload.round,
    max_rounds: payload.max_rounds ?? 300,
    grid: {
      width: payload.grid.width,
      height: payload.grid.height,
      walls: payload.grid.walls || [],
    },
    bots: payload.bots || [],
    items: payload.items || [],
    orders: payload.orders || [],
    drop_off: dropOffs[0] || [0, 0],
    drop_offs: dropOffs,
    score: payload.score ?? 0,
  };
}

export function parseServerMessage(raw) {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert(payload && typeof payload === 'object', 'Server message must be an object');
  assert(typeof payload.type === 'string', 'Server message type is required');

  if (payload.type === 'game_state') {
    return normalizeGameState(payload);
  }

  if (payload.type === 'game_over') {
    return {
      type: 'game_over',
      score: payload.score ?? 0,
      items: payload.items ?? null,
      orders: payload.orders ?? null,
      reason: payload.reason ?? null,
    };
  }

  throw new Error(`Unsupported message type: ${payload.type}`);
}

function validateAction(action) {
  assert(action && typeof action === 'object', 'Action must be an object');
  assert(typeof action.bot === 'number', 'Action.bot must be a number');
  assert(ACTIONS.has(action.action), `Unsupported action: ${action.action}`);

  if (action.action === 'pick_up') {
    assert(typeof action.item_id === 'string' && action.item_id.length > 0, 'pick_up action requires item_id');
  }

  if (action.action !== 'pick_up' && Object.hasOwn(action, 'item_id')) {
    const { item_id, ...rest } = action;
    return rest;
  }

  return action;
}

export function buildActionEnvelope(actions) {
  assert(Array.isArray(actions), 'actions must be an array');
  const sanitized = actions.map(validateAction);
  return JSON.stringify({ actions: sanitized });
}
