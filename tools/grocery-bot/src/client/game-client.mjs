import { buildActionEnvelope, parseServerMessage } from './protocol.mjs';
import {
  sanitizeActionsForStateDetailed,
} from './game-client-sanitizer.mjs';
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

export { sanitizeActionsForStateDetailed, sanitizeActionsForState } from './game-client-sanitizer.mjs';

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
        const plannerMetricsBeforeSanitize = planner.getLastMetrics() || {};
        const trustedScriptReplay = plannerMetricsBeforeSanitize.scriptTrusted === true;
        const { actions, sanitizerOverrides } = trustedScriptReplay
          ? { actions: plannedActions, sanitizerOverrides: [] }
          : sanitizeActionsForStateDetailed(plannedActions, message, runtime);
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
          trustedScriptReplay,
        };

        if (!layoutLogged && replayLogger) {
          replayLogger.log({
            type: 'layout',
            grid: message.grid,
            drop_off: message.drop_off,
            drop_offs: message.drop_offs,
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
