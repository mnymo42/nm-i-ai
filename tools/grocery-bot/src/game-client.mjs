import { buildActionEnvelope, parseServerMessage } from './protocol.mjs';
import NodeWebSocket from 'ws';

const WebSocketImpl = globalThis.WebSocket || NodeWebSocket;
const WS_OPEN_READY_STATE = 1;

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function wsEventPromise(ws, eventName) {
  return new Promise((resolve) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener(eventName, resolve, { once: true });
      return;
    }

    if (typeof ws.once === 'function') {
      ws.once(eventName, resolve);
      return;
    }

    ws.on(eventName, resolve);
  });
}

function bindWsEvent(ws, eventName, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(eventName, handler);
    return;
  }

  ws.on(eventName, handler);
}

function normalizeMessagePayload(event) {
  if (typeof event === 'string') {
    return event;
  }

  if (event && typeof event.data === 'string') {
    return event.data;
  }

  const candidate = event?.data ?? event;
  if (typeof candidate === 'string') {
    return candidate;
  }

  if (Buffer.isBuffer(candidate)) {
    return candidate.toString('utf8');
  }

  return String(candidate);
}

function isSameCell(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function nextPositionForMove(position, action) {
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

function isInBounds([x, y], grid) {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

function toWallSet(state) {
  const set = new Set();
  for (const wall of state.grid.walls || []) {
    set.add(`${wall[0]},${wall[1]}`);
  }
  for (const item of state.items || []) {
    set.add(`${item.position[0]},${item.position[1]}`);
  }
  return set;
}

function isWalkable(position, state, wallSet) {
  if (!isInBounds(position, state.grid)) {
    return false;
  }

  return !wallSet.has(`${position[0]},${position[1]}`);
}

function isAdjacent(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
}

function actionTargetPosition(bot, actionName) {
  if (['move_up', 'move_down', 'move_left', 'move_right'].includes(actionName)) {
    return nextPositionForMove(bot.position, actionName);
  }

  return bot.position;
}

function isMoveAction(actionName) {
  return ['move_up', 'move_down', 'move_left', 'move_right'].includes(actionName);
}

function buildActiveDemand(state) {
  const activeOrder = (state.orders || []).find((order) => order.status === 'active' && !order.complete);
  const demand = new Map();
  if (!activeOrder) {
    return demand;
  }

  for (const type of activeOrder.items_required || []) {
    demand.set(type, (demand.get(type) || 0) + 1);
  }
  for (const type of activeOrder.items_delivered || []) {
    const current = demand.get(type) || 0;
    if (current > 0) {
      demand.set(type, current - 1);
    }
  }

  return demand;
}

function hasDeliverableInventory(bot, activeDemand) {
  if ((bot.inventory || []).length === 0 || activeDemand.size === 0) {
    return false;
  }

  const localDemand = new Map(activeDemand);
  for (const type of bot.inventory || []) {
    const remaining = localDemand.get(type) || 0;
    if (remaining <= 0) {
      continue;
    }
    return true;
  }

  return false;
}

function chooseFallbackTarget(bot, state) {
  const activeDemand = buildActiveDemand(state);
  if (hasDeliverableInventory(bot, activeDemand)) {
    return state.drop_off;
  }

  const neededTypes = new Set();
  for (const [type, count] of activeDemand.entries()) {
    if (count > 0) {
      neededTypes.add(type);
    }
  }

  let best = null;
  for (const item of state.items || []) {
    if (neededTypes.size > 0 && !neededTypes.has(item.type)) {
      continue;
    }

    const distance = Math.abs(bot.position[0] - item.position[0]) + Math.abs(bot.position[1] - item.position[1]);
    if (!best || distance < best.distance) {
      best = { position: item.position, distance };
    }
  }

  if (best) {
    return best.position;
  }

  return state.drop_off;
}

function chooseNudgeAction({
  bot,
  state,
  wallSet,
  reservedTargets,
  occupiedNow,
}) {
  const target = chooseFallbackTarget(bot, state);
  const moves = ['move_up', 'move_down', 'move_left', 'move_right'];
  const candidates = [];

  for (const move of moves) {
    const next = nextPositionForMove(bot.position, move);
    if (!isWalkable(next, state, wallSet)) {
      continue;
    }

    const key = `${next[0]},${next[1]}`;
    const selfKey = `${bot.position[0]},${bot.position[1]}`;
    if (key !== selfKey && occupiedNow.has(key)) {
      continue;
    }
    if (reservedTargets.has(key)) {
      continue;
    }

    const distanceToTarget = Math.abs(next[0] - target[0]) + Math.abs(next[1] - target[1]);
    candidates.push({ move, distanceToTarget, key });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.distanceToTarget - b.distanceToTarget);
  return candidates[0].move;
}

function sanitizeBotActionDetailed({ bot, action, state, wallSet }) {
  const fallback = { bot: bot.id, action: 'wait' };
  if (!action || typeof action !== 'object' || action.bot !== bot.id) {
    return { action: fallback, overrideReason: 'invalid_action_shape', hadPlannedAction: Boolean(action) };
  }

  if (action.action === 'wait') {
    return { action: fallback, overrideReason: null, hadPlannedAction: true };
  }

  if (['move_up', 'move_down', 'move_left', 'move_right'].includes(action.action)) {
    const candidate = nextPositionForMove(bot.position, action.action);
    if (isWalkable(candidate, state, wallSet)) {
      return { action: { bot: bot.id, action: action.action }, overrideReason: null, hadPlannedAction: true };
    }
    return { action: fallback, overrideReason: 'invalid_move_blocked', hadPlannedAction: true };
  }

  if (action.action === 'drop_off') {
    if (isSameCell(bot.position, state.drop_off)) {
      return { action: { bot: bot.id, action: 'drop_off' }, overrideReason: null, hadPlannedAction: true };
    }
    return { action: fallback, overrideReason: 'invalid_drop_position', hadPlannedAction: true };
  }

  if (action.action === 'pick_up') {
    if ((bot.inventory || []).length >= 3) {
      return { action: fallback, overrideReason: 'invalid_pick_full', hadPlannedAction: true };
    }

    const item = (state.items || []).find((candidate) => candidate.id === action.item_id);
    if (!item) {
      return { action: fallback, overrideReason: 'invalid_pick_item_missing', hadPlannedAction: true };
    }

    if (!isAdjacent(bot.position, item.position)) {
      return { action: fallback, overrideReason: 'invalid_pick_not_adjacent', hadPlannedAction: true };
    }

    return { action: { bot: bot.id, action: 'pick_up', item_id: action.item_id }, overrideReason: null, hadPlannedAction: true };
  }

  return { action: fallback, overrideReason: 'invalid_action_name', hadPlannedAction: true };
}

export function sanitizeActionsForStateDetailed(actions, state, runtime = {}) {
  const byBot = new Map();
  for (const action of actions || []) {
    if (action && typeof action.bot === 'number' && !byBot.has(action.bot)) {
      byBot.set(action.bot, action);
    }
  }

  const wallSet = toWallSet(state);
  const occupiedNow = new Set((state.bots || []).map((bot) => `${bot.position[0]},${bot.position[1]}`));
  const reservedTargets = new Set();
  const result = [];
  const sanitizerOverrides = [];

  const nudgeInvalidOnly = runtime.nudge_invalid_only !== false;
  const nudgePlannedWaits = runtime.nudge_planned_waits === true;
  const plannedStates = [];

  for (const bot of (state.bots || [])) {
    const plannedAction = byBot.get(bot.id);
    const sanitizedResult = sanitizeBotActionDetailed({
      bot,
      action: plannedAction,
      state,
      wallSet,
    });
    let sanitized = sanitizedResult.action;
    let overrideReason = sanitizedResult.overrideReason;

    const plannedActionName = plannedAction?.action || null;
    const isValidPlannedWait = plannedActionName === 'wait' && !overrideReason;
    const shouldNudgePlannedWait = isValidPlannedWait && nudgePlannedWaits;
    const shouldNudgeInvalid = overrideReason && nudgeInvalidOnly;
    const shouldNudgeAnyWait = !nudgeInvalidOnly && plannedAction;

    if (sanitized.action === 'wait' && (shouldNudgePlannedWait || shouldNudgeInvalid || shouldNudgeAnyWait)) {
      const nudge = chooseNudgeAction({
        bot,
        state,
        wallSet,
        reservedTargets,
        occupiedNow,
      });
      if (nudge) {
        sanitized = { bot: bot.id, action: nudge };
        overrideReason = shouldNudgePlannedWait ? 'wait_nudged' : (overrideReason || 'wait_nudged');
      }
    }

    const target = actionTargetPosition(bot, sanitized.action);
    plannedStates.push({
      bot,
      plannedAction,
      sanitized,
      overrideReason,
      target,
    });

    if (!plannedAction) {
      continue;
    }

    const changed = plannedAction.action !== sanitized.action || plannedAction.item_id !== sanitized.item_id;
    if (changed) {
      sanitizerOverrides.push({
        bot: bot.id,
        planned_action: plannedAction.action,
        sent_action: sanitized.action,
        reason: overrideReason || 'sanitized',
      });
    }
  }

  const currentByBot = new Map((state.bots || []).map((bot) => [bot.id, bot.position]));
  const targetGroups = new Map();
  for (const entry of plannedStates) {
    const key = `${entry.target[0]},${entry.target[1]}`;
    const list = targetGroups.get(key) || [];
    list.push(entry);
    targetGroups.set(key, list);
  }

  const conflictReasons = new Map();
  for (const group of targetGroups.values()) {
    if (group.length <= 1) {
      continue;
    }

    for (const entry of group) {
      conflictReasons.set(entry.bot.id, 'conflict_same_target');
    }
  }

  for (const entry of plannedStates) {
    if (!isMoveAction(entry.sanitized.action)) {
      continue;
    }

    for (const other of plannedStates) {
      if (other.bot.id === entry.bot.id) {
        continue;
      }

      const otherCurrent = currentByBot.get(other.bot.id);
      const entryCurrent = currentByBot.get(entry.bot.id);
      const otherTarget = other.target;

      if (isSameCell(entry.target, otherCurrent) && isSameCell(otherTarget, otherCurrent)) {
        conflictReasons.set(entry.bot.id, 'conflict_stationary_occupant');
      }

      if (
        isMoveAction(other.sanitized.action)
        && isSameCell(entry.target, otherCurrent)
        && isSameCell(otherTarget, entryCurrent)
      ) {
        conflictReasons.set(entry.bot.id, 'conflict_swap');
      }
    }
  }

  reservedTargets.clear();
  for (const entry of plannedStates) {
    const conflictReason = conflictReasons.get(entry.bot.id) || null;
    let finalAction = entry.sanitized;
    let finalReason = entry.overrideReason;

    if (conflictReason) {
      const nudge = chooseNudgeAction({
        bot: entry.bot,
        state,
        wallSet,
        reservedTargets,
        occupiedNow,
      });
      if (nudge) {
        finalAction = { bot: entry.bot.id, action: nudge };
        finalReason = conflictReason;
      } else {
        finalAction = { bot: entry.bot.id, action: 'wait' };
        finalReason = conflictReason;
      }
    }

    const finalTarget = actionTargetPosition(entry.bot, finalAction.action);
    reservedTargets.add(`${finalTarget[0]},${finalTarget[1]}`);
    result.push(finalAction);

    if (!entry.plannedAction) {
      continue;
    }

    const changed = entry.plannedAction.action !== finalAction.action || entry.plannedAction.item_id !== finalAction.item_id;
    if (changed && !sanitizerOverrides.some((override) => override.bot === entry.bot.id)) {
      sanitizerOverrides.push({
        bot: entry.bot.id,
        planned_action: entry.plannedAction.action,
        sent_action: finalAction.action,
        reason: finalReason || 'sanitized',
      });
    }
  }

  return {
    actions: result,
    sanitizerOverrides,
  };
}

export function sanitizeActionsForState(actions, state, runtime = {}) {
  return sanitizeActionsForStateDetailed(actions, state, runtime).actions;
}

export class GroceryGameClient {
  constructor({
    token,
    urlBase = 'wss://game.ainm.no/ws',
    idleTimeoutMs = 15_000,
    minRoundSendIntervalMs = 0,
  }) {
    this.url = `${urlBase}?token=${encodeURIComponent(token)}`;
    this.idleTimeoutMs = idleTimeoutMs;
    this.minRoundSendIntervalMs = minRoundSendIntervalMs;
    this.ws = null;
    this.queue = [];
    this.pending = [];
    this.closed = false;
    this.closeReason = null;
    this.lastSentRound = null;
    this.lastSentPayload = null;
    this.lastSendAt = 0;
    this.lastSendDelayMs = 0;
  }

  async connect() {
    this.ws = new WebSocketImpl(this.url);

    bindWsEvent(this.ws, 'message', (event) => {
      const payload = normalizeMessagePayload(event);
      if (this.pending.length > 0) {
        const resolver = this.pending.shift();
        resolver(payload);
      } else {
        this.queue.push(payload);
      }
    });

    bindWsEvent(this.ws, 'close', (event, reason) => {
      const closeCode = typeof event?.code === 'number' ? event.code : event;
      this.closed = true;
      this.closeReason = `WebSocket closed (${closeCode ?? 'unknown'})`;
      if (reason && !String(reason).startsWith('[object')) {
        this.closeReason += `: ${String(reason)}`;
      }
      while (this.pending.length > 0) {
        const resolver = this.pending.shift();
        resolver(null);
      }
    });

    bindWsEvent(this.ws, 'error', () => {
      this.closeReason = 'WebSocket error';
    });

    await withTimeout(wsEventPromise(this.ws, 'open'), 10_000, 'WebSocket connect timeout');
  }

  async recv() {
    if (this.queue.length > 0) {
      return this.queue.shift();
    }

    if (this.closed) {
      return null;
    }

    return withTimeout(new Promise((resolve) => this.pending.push(resolve)), this.idleTimeoutMs, 'Server idle timeout');
  }

  async sendActions(actions) {
    return this.sendActionsForRound(actions, null);
  }

  async sendActionsForRound(actions, round = null) {
    if (!this.ws || this.ws.readyState !== WS_OPEN_READY_STATE) {
      throw new Error('WebSocket is not open');
    }

    if (typeof round === 'number' && this.lastSentRound === round) {
      throw new Error(`Action payload already sent for round ${round}`);
    }

    const now = Date.now();
    const elapsedSinceLastSend = now - this.lastSendAt;
    const sendDelayMs = Math.max(0, this.minRoundSendIntervalMs - elapsedSinceLastSend);
    if (sendDelayMs > 0) {
      await sleep(sendDelayMs);
    }

    const payload = buildActionEnvelope(actions);
    this.ws.send(payload);
    this.lastSendAt = Date.now();
    this.lastSendDelayMs = sendDelayMs;
    if (typeof round === 'number') {
      this.lastSentRound = round;
      this.lastSentPayload = payload;
    }
    return payload;
  }

  close() {
    if (this.ws && this.ws.readyState <= WS_OPEN_READY_STATE) {
      this.ws.close();
    }
  }

  async run({ planner, replayLogger, difficulty, profileName }) {
    await this.connect();

    let finalResult = null;
    let previousState = null;
    let previousActionsByBot = new Map();
    const overrideHistory = [];
    const failedPickupHistory = [];
    const rollingWindow = 20;
    const runtime = planner?.profile?.runtime || {};
    let layoutLogged = false;

    try {
      while (true) {
        const raw = await this.recv();

        if (!raw) {
          throw new Error(this.closeReason || 'Connection ended before game_over');
        }

        const message = parseServerMessage(raw);

        if (message.type === 'game_over') {
          finalResult = message;
          replayLogger?.log({
            type: 'game_over',
            difficulty,
            profile: profileName,
            final_score: message.score,
            items_delivered: message.items,
            orders_completed: message.orders,
            reason: message.reason,
          });
          break;
        }

        const pickupResults = [];
        if (previousState) {
          const previousBotsById = new Map((previousState.bots || []).map((bot) => [bot.id, bot]));
          const currentBotsById = new Map((message.bots || []).map((bot) => [bot.id, bot]));

          for (const [botId, previousAction] of previousActionsByBot.entries()) {
            if (previousAction?.action !== 'pick_up') {
              continue;
            }

            const previousBot = previousBotsById.get(botId);
            const currentBot = currentBotsById.get(botId);
            if (!previousBot || !currentBot) {
              continue;
            }

            const previousInventory = (previousBot.inventory || []).length;
            const currentInventory = (currentBot.inventory || []).length;
            pickupResults.push({
              bot: botId,
              attempted_item_id: previousAction.item_id,
              succeeded: currentInventory > previousInventory,
              approach_cell: [...previousBot.position],
            });
          }
        }

        const loopStartedAt = Date.now();
        const planningStartedAt = loopStartedAt;
        const plannedActions = planner.plan(message);
        const planningFinishedAt = Date.now();
        const { actions, sanitizerOverrides } = sanitizeActionsForStateDetailed(plannedActions, message, runtime);
        const sanitizeFinishedAt = Date.now();
        const serialized = await this.sendActionsForRound(actions, message.round);
        const sendFinishedAt = Date.now();

        const failedPickupsThisTick = pickupResults.filter((result) => result.succeeded === false).length;
        failedPickupHistory.push(failedPickupsThisTick);
        if (failedPickupHistory.length > rollingWindow) {
          failedPickupHistory.shift();
        }

        overrideHistory.push(sanitizerOverrides.length);
        if (overrideHistory.length > rollingWindow) {
          overrideHistory.shift();
        }

        const baseMetrics = planner.getLastMetrics() || {};
        const plannerMetrics = {
          ...baseMetrics,
          failedPickupsRolling: failedPickupHistory.reduce((sum, value) => sum + value, 0),
          overrideCountRolling: overrideHistory.reduce((sum, value) => sum + value, 0),
          approachBlacklistSize: baseMetrics.approachBlacklistSize ?? 0,
          orderEtaAtDecision: baseMetrics.orderEtaAtDecision ?? null,
          projectedCompletionFeasible: baseMetrics.projectedCompletionFeasible ?? null,
          planningLatencyMs: planningFinishedAt - planningStartedAt,
          sanitizeLatencyMs: sanitizeFinishedAt - planningFinishedAt,
          sendLatencyMs: sendFinishedAt - sanitizeFinishedAt,
          clientLoopLatencyMs: sendFinishedAt - loopStartedAt,
          sendThrottleDelayMs: this.lastSendDelayMs,
        };

        if (!layoutLogged && replayLogger) {
          replayLogger.log({
            type: 'layout',
            grid: message.grid,
            drop_off: message.drop_off,
            max_rounds: message.max_rounds,
          });
          layoutLogged = true;
        }

        const slimSnapshot = {
          type: message.type,
          round: message.round,
          score: message.score,
          bots: message.bots,
          items: message.items,
          orders: message.orders,
        };

        replayLogger?.log({
          type: 'tick',
          difficulty,
          tick: message.round,
          state_snapshot: slimSnapshot,
          actions_sent: actions,
          actions_planned: plannedActions,
          sanitizer_overrides: sanitizerOverrides,
          pickup_result: pickupResults,
          actions_payload: serialized,
          planner_metrics: plannerMetrics,
        });

        previousState = message;
        previousActionsByBot = new Map(actions.map((action) => [action.bot, action]));
      }
    } finally {
      this.close();
    }

    return finalResult;
  }
}
