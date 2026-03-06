export function buildDemand(order) {
  const demand = new Map();
  for (const itemType of order?.items_required || []) {
    demand.set(itemType, (demand.get(itemType) || 0) + 1);
  }

  for (const delivered of order?.items_delivered || []) {
    demand.set(delivered, Math.max(0, (demand.get(delivered) || 0) - 1));
  }

  return demand;
}

export function buildWorldContext(state) {
  const activeOrder = state.orders.find((order) => order.status === 'active' && !order.complete) || null;
  const previewOrder = state.orders.find((order) => order.status === 'preview' && !order.complete) || null;

  const activeDemand = buildDemand(activeOrder);
  const previewDemand = buildDemand(previewOrder);

  const itemsByType = new Map();
  for (const item of state.items) {
    const list = itemsByType.get(item.type) || [];
    list.push(item);
    itemsByType.set(item.type, list);
  }

  return {
    activeOrder,
    previewOrder,
    activeDemand,
    previewDemand,
    itemsByType,
  };
}

export function countInventoryByType(bots) {
  const counts = new Map();
  for (const bot of bots) {
    for (const itemType of bot.inventory || []) {
      counts.set(itemType, (counts.get(itemType) || 0) + 1);
    }
  }

  return counts;
}

export function activeRemainingDemand(state) {
  const { activeDemand } = buildWorldContext(state);
  const inventory = countInventoryByType(state.bots);

  const remaining = new Map(activeDemand);
  for (const [type, count] of inventory.entries()) {
    if (remaining.has(type)) {
      remaining.set(type, Math.max(0, remaining.get(type) - count));
    }
  }

  return remaining;
}
