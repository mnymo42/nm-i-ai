export function sumCounts(map) {
  return Array.from(map.values()).reduce((sum, count) => sum + Math.max(0, count), 0);
}

export function reserveInventoryForDemand(inventoryCounts, demand) {
  const remainingDemand = new Map(demand);
  const surplusInventory = new Map(inventoryCounts);

  for (const [type, count] of inventoryCounts.entries()) {
    const required = remainingDemand.get(type) || 0;
    if (required <= 0 || count <= 0) {
      continue;
    }

    const used = Math.min(count, required);
    remainingDemand.set(type, required - used);
    surplusInventory.set(type, count - used);
  }

  return { remainingDemand, surplusInventory };
}

export function zoneIndexForX(x, width, zoneCount) {
  if (zoneCount <= 1 || width <= 0) {
    return 0;
  }

  const normalized = Math.max(0, Math.min(width - 1, x));
  return Math.min(zoneCount - 1, Math.floor((normalized * zoneCount) / width));
}

export function zoneIdForBot(state, botId) {
  const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
  return Math.max(0, botOrder.findIndex((candidate) => candidate.id === botId));
}

export function estimateZonePenalty({ bot, task, state, profile }) {
  if (task?.kind !== 'pick_up' || !task.item || state.bots.length <= 1) {
    return 0;
  }

  const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
  const botIndex = botOrder.findIndex((candidate) => candidate.id === bot.id);
  if (botIndex < 0) {
    return 0;
  }

  const itemX = task.item.position?.[0];
  if (!Number.isFinite(itemX)) {
    return 0;
  }

  const taskZoneIndex = zoneIndexForX(itemX, state.grid.width, botOrder.length);
  const zoneDelta = Math.abs(taskZoneIndex - botIndex);
  if (zoneDelta === 0) {
    return 0;
  }

  const activePenalty = profile.assignment.active_zone_penalty ?? 0.35;
  const previewPenalty = profile.assignment.preview_zone_penalty ?? 1.1;
  const basePenalty = task.sourceOrder === 'preview' ? previewPenalty : activePenalty;

  return zoneDelta * basePenalty;
}
