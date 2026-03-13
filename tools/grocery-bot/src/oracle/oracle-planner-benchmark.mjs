import { encodeCoord } from '../utils/coords.mjs';
import { sanitizeActionsForStateDetailed } from '../client/game-client-sanitizer.mjs';
import { buildOracleScriptWorld, normalizeOracle } from './oracle-script-world.mjs';

function buildOrders(oracle) {
  return oracle.known_orders.map((order) => ({
    id: order.id,
    releaseTick: order.first_seen_tick,
    items_required: [...order.items_required],
    items_delivered: [],
    complete: false,
    completionTick: null,
  }));
}

function buildPlannerState({ tick, world, bots, orders, pickedItems, score }) {
  const visibleOrders = orders
    .filter((order) => order.releaseTick <= tick && !order.complete)
    .map((order, index) => ({
      id: order.id,
      items_required: [...order.items_required],
      items_delivered: [...order.items_delivered],
      status: index === 0 ? 'active' : index === 1 ? 'preview' : 'queued',
      complete: false,
    }));

  const items = [];
  for (const item of world.oracleItemsById.values()) {
    if (!pickedItems.has(item.id)) {
      items.push({ ...item, position: [...item.position] });
    }
  }

  return {
    type: 'game_state',
    round: tick,
    max_rounds: world.maxRounds,
    grid: world.grid,
    bots: bots.map((bot) => ({
      id: bot.id,
      position: [...bot.position],
      inventory: [...bot.inventory],
    })),
    items,
    orders: visibleOrders,
    drop_off: world.dropOff,
    drop_offs: world.dropOffs,
    score,
  };
}

function consumeInventoryAgainstOrder(inventory, orderState) {
  let deliveredCount = 0;
  const remainingInventory = [];

  for (const type of inventory) {
    const requiredCount = orderState.items_required.filter((itemType) => itemType === type).length;
    const deliveredCountForType = orderState.items_delivered.filter((itemType) => itemType === type).length;
    if (deliveredCountForType < requiredCount) {
      orderState.items_delivered.push(type);
      deliveredCount += 1;
    } else {
      remainingInventory.push(type);
    }
  }

  return { deliveredCount, remainingInventory };
}

function isOrderComplete(orderState) {
  return orderState.items_delivered.length >= orderState.items_required.length;
}

function buildActionMap(actions, botCount) {
  const actionMap = new Map();
  for (let botId = 0; botId < botCount; botId += 1) {
    actionMap.set(botId, { bot: botId, action: 'wait' });
  }
  for (const action of actions || []) {
    actionMap.set(action.bot, action);
  }
  return [...actionMap.values()];
}

export function simulatePlannerAgainstOracleEnvironment({
  oracle,
  plannerFactory,
  replayPath = null,
}) {
  const normalizedOracle = normalizeOracle(oracle);
  const world = buildOracleScriptWorld({ oracle: normalizedOracle, replayPath });
  const planner = plannerFactory();
  const bots = world.botStartPositions.map((position, botId) => ({
    id: botId,
    position: [...position],
    inventory: [],
  }));
  const orders = buildOrders(normalizedOracle);
  const pickedItems = new Set();
  let score = 0;
  let waitActions = 0;
  let sanitizerOverrides = 0;
  let totalStalls = 0;

  for (let tick = 0; tick < world.maxRounds; tick += 1) {
    const state = buildPlannerState({ tick, world, bots, orders, pickedItems, score });
    if (planner.oracle) {
      planner.oracle = {
        ...normalizedOracle,
        items: state.items.map((item) => ({ ...item, position: [...item.position] })),
      };
    }
    const plannedActions = buildActionMap(planner.plan(state), bots.length);
    const sanitized = sanitizeActionsForStateDetailed(plannedActions, state, {});
    sanitizerOverrides += sanitized.sanitizerOverrides.length;
    totalStalls += planner.getLastMetrics()?.stalledBots || 0;

    for (const action of sanitized.actions) {
      const bot = bots[action.bot];
      if (!bot) continue;

      switch (action.action) {
        case 'wait':
          waitActions += 1;
          break;
        case 'move_up':
          bot.position = [bot.position[0], bot.position[1] - 1];
          break;
        case 'move_down':
          bot.position = [bot.position[0], bot.position[1] + 1];
          break;
        case 'move_left':
          bot.position = [bot.position[0] - 1, bot.position[1]];
          break;
        case 'move_right':
          bot.position = [bot.position[0] + 1, bot.position[1]];
          break;
        case 'pick_up': {
          const item = world.oracleItemsById.get(action.item_id);
          if (!item || pickedItems.has(item.id)) break;
          const adjacent = Math.abs(bot.position[0] - item.position[0]) + Math.abs(bot.position[1] - item.position[1]) === 1;
          if (!adjacent || bot.inventory.length >= 3) break;
          pickedItems.add(item.id);
          bot.inventory.push(item.type);
          break;
        }
        case 'drop_off': {
          const onDrop = world.dropOffs.some((drop) => encodeCoord(drop) === encodeCoord(bot.position));
          if (!onDrop) break;
          const activeOrder = orders.find((order) => order.releaseTick <= tick && !order.complete) || null;
          if (!activeOrder) break;
          const delivery = consumeInventoryAgainstOrder(bot.inventory, activeOrder);
          bot.inventory = delivery.remainingInventory;
          score += delivery.deliveredCount;
          if (isOrderComplete(activeOrder)) {
            activeOrder.complete = true;
            activeOrder.completionTick = tick;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const completedOrders = orders.filter((order) => order.complete).length;
  const wastedInventoryAtEnd = bots.flatMap((bot) => bot.inventory);
  return {
    finalScore: score,
    ordersCompleted: completedOrders,
    itemsDelivered: score,
    waitActions,
    sanitizerOverrides,
    totalStalls,
    wastedInventoryAtEnd,
  };
}

export function benchmarkPlannerAgainstOracleEnvironment({
  oracle,
  plannerFactoryByVariant,
  replayPath = null,
  runs = 1,
}) {
  const variants = [];

  for (const [variant, plannerFactory] of Object.entries(plannerFactoryByVariant)) {
    const runResults = [];
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      runResults.push(simulatePlannerAgainstOracleEnvironment({
        oracle,
        plannerFactory,
        replayPath,
      }));
    }

    const totals = runResults.reduce((sum, run) => ({
      finalScore: sum.finalScore + run.finalScore,
      ordersCompleted: sum.ordersCompleted + run.ordersCompleted,
      itemsDelivered: sum.itemsDelivered + run.itemsDelivered,
      waitActions: sum.waitActions + run.waitActions,
      sanitizerOverrides: sum.sanitizerOverrides + run.sanitizerOverrides,
      totalStalls: sum.totalStalls + run.totalStalls,
      wastedInventory: sum.wastedInventory + run.wastedInventoryAtEnd.length,
    }), {
      finalScore: 0,
      ordersCompleted: 0,
      itemsDelivered: 0,
      waitActions: 0,
      sanitizerOverrides: 0,
      totalStalls: 0,
      wastedInventory: 0,
    });

    variants.push({
      variant,
      runs: runResults,
      averages: {
        finalScore: Number((totals.finalScore / runs).toFixed(2)),
        ordersCompleted: Number((totals.ordersCompleted / runs).toFixed(2)),
        itemsDelivered: Number((totals.itemsDelivered / runs).toFixed(2)),
        waitActions: Number((totals.waitActions / runs).toFixed(2)),
        sanitizerOverrides: Number((totals.sanitizerOverrides / runs).toFixed(2)),
        totalStalls: Number((totals.totalStalls / runs).toFixed(2)),
        wastedInventory: Number((totals.wastedInventory / runs).toFixed(2)),
      },
    });
  }

  variants.sort((left, right) =>
    right.averages.finalScore - left.averages.finalScore
    || right.averages.ordersCompleted - left.averages.ordersCompleted
    || left.averages.waitActions - right.averages.waitActions);

  return {
    variantCount: variants.length,
    runCountPerVariant: runs,
    variants,
  };
}
