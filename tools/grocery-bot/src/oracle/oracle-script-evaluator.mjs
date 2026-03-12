import { adjacentManhattan, encodeCoord } from '../utils/coords.mjs';
import { sanitizeActionsForStateDetailed } from '../client/game-client-sanitizer.mjs';
import { buildOracleScriptWorld, normalizeOracle } from './oracle-script-world.mjs';

function buildEmptyActions(botCount) {
  return Array.from({ length: botCount }, (_, botId) => ({ bot: botId, action: 'wait' }));
}

function buildDropSet(world) {
  return new Set((world.dropOffs || [world.dropOff]).map((coord) => encodeCoord(coord)));
}

function buildOrders(oracle) {
  return oracle.known_orders.map((order) => ({
    id: order.id,
    releaseTick: order.first_seen_tick,
    remaining: new Map(order.itemCounts),
    complete: false,
    completionTick: null,
  }));
}

function consumeInventoryAgainstOrder(inventory, orderState) {
  let deliveredCount = 0;
  const remainingInventory = [];

  for (const type of inventory) {
    const remainingCount = orderState.remaining.get(type) || 0;
    if (remainingCount > 0) {
      orderState.remaining.set(type, remainingCount - 1);
      deliveredCount += 1;
      continue;
    }
    remainingInventory.push(type);
  }

  return { deliveredCount, remainingInventory };
}

function isOrderComplete(orderState) {
  for (const count of orderState.remaining.values()) {
    if (count > 0) {
      return false;
    }
  }
  return true;
}

function getActiveOrder(orders, tick) {
  return orders.find((order) => order.releaseTick <= tick && !order.complete) || null;
}

function countDeliverableInventory(inventory, activeOrder) {
  if (!activeOrder) {
    return 0;
  }
  const remaining = new Map(activeOrder.remaining);
  let deliverable = 0;
  for (const type of inventory) {
    const count = remaining.get(type) || 0;
    if (count > 0) {
      remaining.set(type, count - 1);
      deliverable += 1;
    }
  }
  return deliverable;
}

export function evaluateOracleScript({ oracle, script, replayPath = null, maxTripItems = 2, sanitize = true }) {
  const normalizedOracle = normalizeOracle(oracle);
  const world = buildOracleScriptWorld({ oracle: normalizedOracle, replayPath });
  const itemById = world.oracleItemsById;
  const bots = world.botStartPositions.map((position, botId) => ({
    id: botId,
    position: [...position],
    inventory: [],
  }));
  const orders = buildOrders(normalizedOracle);
  const drops = buildDropSet(world);
  const pickedItems = new Set();
  const metadata = [];
  let score = 0;
  let waitActions = 0;
  let pickActions = 0;
  let dropActions = 0;
  let invalid = null;
  let maxTickSeen = -1;
  const sanitizedTicks = [];
  let sanitizerOverrideCount = 0;
  const scoreTimeline = [];
  const tickProfiles = [];

  for (const tickEntry of script.ticks || []) {
    const tick = tickEntry.tick;
    maxTickSeen = Math.max(maxTickSeen, tick);
    const plannedActions = buildEmptyActions(bots.length);

    for (const action of tickEntry.actions || []) {
      plannedActions[action.bot] = action;
    }

    const remainingItems = [];
    for (const [itemId, item] of itemById.entries()) {
      if (!pickedItems.has(itemId)) {
        remainingItems.push(item);
      }
    }

    const state = {
      round: tick,
      max_rounds: world.maxRounds,
      grid: world.grid,
      bots: bots.map((bot) => ({
        id: bot.id,
        position: [...bot.position],
        inventory: [...bot.inventory],
      })),
      items: remainingItems,
      drop_off: world.dropOff,
      drop_offs: world.dropOffs,
    };
    const { actions, sanitizerOverrides } = sanitize
      ? sanitizeActionsForStateDetailed(plannedActions, state, {})
      : { actions: plannedActions, sanitizerOverrides: [] };
    sanitizerOverrideCount += sanitizerOverrides.length;
    sanitizedTicks.push({ tick, actions });

    const occupiedStart = new Map(bots.map((bot) => [bot.id, encodeCoord(bot.position)]));
    const proposedEnd = new Map();
    const moves = [];
    let dropCountThisTick = 0;

    for (const action of actions) {
      const bot = bots[action.bot];
      const currentKey = encodeCoord(bot.position);
      let nextPosition = bot.position;

      switch (action.action) {
        case 'wait':
          waitActions += 1;
          break;
        case 'move_up':
          nextPosition = [bot.position[0], bot.position[1] - 1];
          moves.push({ botId: bot.id, from: currentKey, to: encodeCoord(nextPosition) });
          break;
        case 'move_down':
          nextPosition = [bot.position[0], bot.position[1] + 1];
          moves.push({ botId: bot.id, from: currentKey, to: encodeCoord(nextPosition) });
          break;
        case 'move_left':
          nextPosition = [bot.position[0] - 1, bot.position[1]];
          moves.push({ botId: bot.id, from: currentKey, to: encodeCoord(nextPosition) });
          break;
        case 'move_right':
          nextPosition = [bot.position[0] + 1, bot.position[1]];
          moves.push({ botId: bot.id, from: currentKey, to: encodeCoord(nextPosition) });
          break;
        case 'pick_up':
          pickActions += 1;
          break;
        case 'drop_off':
          dropActions += 1;
          dropCountThisTick += 1;
          break;
        default:
          invalid = { tick, reason: `unknown action ${action.action}` };
          break;
      }

      if (invalid) {
        break;
      }

      if (action.action.startsWith('move_')) {
        if (!world.graph.isWalkable(nextPosition)) {
          invalid = { tick, reason: `illegal move by bot ${bot.id}` };
          break;
        }
      }

      proposedEnd.set(bot.id, encodeCoord(nextPosition));
    }

    if (invalid) {
      break;
    }

    const targetGroups = new Map();
    for (const [botId, targetKey] of proposedEnd.entries()) {
      const group = targetGroups.get(targetKey) || [];
      group.push(botId);
      targetGroups.set(targetKey, group);
    }

    for (const [targetKey, botIds] of targetGroups.entries()) {
      if (botIds.length <= 1) {
        continue;
      }

      const startKeys = new Set(botIds.map((botId) => occupiedStart.get(botId)));
      const stackedWait = startKeys.size === 1 && startKeys.has(targetKey);
      if (!stackedWait) {
        invalid = { tick, reason: `two bots target same cell ${targetKey}: [${botIds.join(', ')}]` };
        break;
      }
    }

    if (invalid) {
      break;
    }

    for (let index = 0; index < moves.length; index += 1) {
      const left = moves[index];
      for (let otherIndex = index + 1; otherIndex < moves.length; otherIndex += 1) {
        const right = moves[otherIndex];
        if (left.from === right.to && left.to === right.from) {
          invalid = { tick, reason: 'head-on swap move' };
          break;
        }
      }
      if (invalid) {
        break;
      }
    }

    if (invalid) {
      break;
    }

    if (dropCountThisTick > 1) {
      invalid = { tick, reason: 'drop-off capacity exceeded' };
      break;
    }

    for (const action of actions) {
      const bot = bots[action.bot];
      switch (action.action) {
        case 'move_up':
        case 'move_down':
        case 'move_left':
        case 'move_right':
          bot.position = (() => {
            switch (action.action) {
              case 'move_up': return [bot.position[0], bot.position[1] - 1];
              case 'move_down': return [bot.position[0], bot.position[1] + 1];
              case 'move_left': return [bot.position[0] - 1, bot.position[1]];
              default: return [bot.position[0] + 1, bot.position[1]];
            }
          })();
          break;
        case 'pick_up': {
          const item = itemById.get(action.item_id);
          if (!item) {
            invalid = { tick, reason: `unknown item ${action.item_id}` };
            break;
          }
          if (pickedItems.has(item.id)) {
            invalid = { tick, reason: `item reused ${item.id}` };
            break;
          }
          if (!adjacentManhattan(bot.position, item.position)) {
            invalid = { tick, reason: `illegal pickup ${item.id}` };
            break;
          }
          if (bot.inventory.length >= maxTripItems) {
            invalid = { tick, reason: `inventory capacity exceeded for bot ${bot.id}` };
            break;
          }
          pickedItems.add(item.id);
          bot.inventory.push(item.type);
          break;
        }
        case 'drop_off': {
          if (!drops.has(encodeCoord(bot.position))) {
            invalid = { tick, reason: `bot ${bot.id} dropped outside drop-off` };
            break;
          }
          const activeOrder = getActiveOrder(orders, tick);
          if (!activeOrder) {
            bot.inventory = [];
            break;
          }
          const { deliveredCount, remainingInventory } = consumeInventoryAgainstOrder(bot.inventory, activeOrder);
          score += deliveredCount;
          bot.inventory = [];
          if (deliveredCount < remainingInventory.length) {
            metadata.push({ tick, type: 'non_scoring_drop', bot: bot.id, dropped: remainingInventory });
          }
          if (isOrderComplete(activeOrder) && !activeOrder.complete) {
            activeOrder.complete = true;
            activeOrder.completionTick = tick;
            score += 5;
          }
          break;
        }
        default:
          break;
      }
      if (invalid) {
        break;
      }
    }

    if (invalid) {
      break;
    }

    const activeOrderForTick = getActiveOrder(orders, tick);
    const productiveBotTicks = actions.filter((action) => action.action !== 'wait').length;
    const waitingBotTicks = actions.length - productiveBotTicks;
    const carryingDeliverableBots = bots.filter((bot) => countDeliverableInventory(bot.inventory, activeOrderForTick) > 0).length;
    const stagedFutureBots = bots.filter((bot) => bot.inventory.length > 0 && countDeliverableInventory(bot.inventory, activeOrderForTick) === 0).length;
    const pickupActionsThisTick = actions.filter((action) => action.action === 'pick_up').length;
    const dropActionsThisTick = actions.filter((action) => action.action === 'drop_off').length;
    tickProfiles.push({
      tick,
      score,
      productive_bot_ticks: productiveBotTicks,
      waiting_bot_ticks: waitingBotTicks,
      blocked_bot_ticks: sanitizerOverrides.length,
      carrying_deliverable_bots: carryingDeliverableBots,
      staged_future_bots: stagedFutureBots,
      pickup_actions: pickupActionsThisTick,
      drop_actions: dropActionsThisTick,
      drop_lane_occupied: dropActionsThisTick > 0,
      active_order_id: activeOrderForTick?.id || null,
    });
    scoreTimeline.push({ tick, score });
  }

  const ordersCovered = orders.filter((order) => order.complete).length;
  const perOrder = orders.map((order) => ({
    id: order.id,
    completionTick: order.completionTick,
    complete: order.complete,
  }));
  const finalBots = bots.map((bot) => ({
    id: bot.id,
    position: [...bot.position],
    inventory: [...bot.inventory],
  }));

  return {
    valid: invalid === null,
    invalid,
    finalScore: score,
    ordersCovered,
    lastScriptedTick: maxTickSeen,
    waitActions,
    pickActions,
    dropActions,
    perOrder,
    metadata,
    sanitizedTicks,
    sanitizerOverrideCount,
    scoreTimeline,
    tickProfiles,
    finalBots,
    dropOff: world.dropOff,
  };
}
