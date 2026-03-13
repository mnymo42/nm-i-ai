export const TEAM_SHAPES = ['pill', 'circle', 'square', 'diamond', 'hex'];

export function getTeamShape(teamId) {
  if (teamId == null || Number.isNaN(Number(teamId))) {
    return 'pill';
  }
  const normalized = Math.abs(Number(teamId));
  return TEAM_SHAPES[normalized % TEAM_SHAPES.length];
}

export function getTeamVisual(detail, teamColors) {
  const teamId = detail?.teamId ?? null;
  return {
    teamId,
    teamColor: teamId != null ? teamColors[teamId % teamColors.length] : null,
    teamShape: getTeamShape(teamId),
  };
}

export function buildQueueEntries(snapshotOrders = [], plannerMetrics = {}) {
  const teams = Array.isArray(plannerMetrics?.teams) ? plannerMetrics.teams : [];
  const orderMap = new Map(snapshotOrders.map((order) => [order.id, order]));
  const queueOrderIds = Array.isArray(plannerMetrics?.queueOrderIds) ? plannerMetrics.queueOrderIds : [];
  const queueEntries = [];
  const seenOrderIds = new Set();

  for (const team of [...teams].sort((left, right) => (left.slotIndex ?? 999) - (right.slotIndex ?? 999))) {
    if (team?.orderId == null) continue;
    const order = orderMap.get(team.orderId) || null;
    queueEntries.push({
      orderId: team.orderId,
      slotIndex: team.slotIndex ?? null,
      teamId: team.teamId ?? null,
      teamRole: team.role ?? null,
      botIds: Array.isArray(team.botIds) ? team.botIds : [],
      teamDistanceRank: team.teamDistanceRank ?? team.goalBand ?? null,
      status: order?.status ?? 'queued',
      complete: Boolean(order?.complete),
      requiredItems: Array.isArray(order?.items_required) ? order.items_required : [],
      deliveredItems: Array.isArray(order?.items_delivered) ? order.items_delivered : [],
      isFront: (team.slotIndex ?? -1) === 0,
      isVisible: Boolean(order),
    });
    seenOrderIds.add(team.orderId);
  }

  for (const orderId of queueOrderIds) {
    if (seenOrderIds.has(orderId)) continue;
    const order = orderMap.get(orderId) || null;
    queueEntries.push({
      orderId,
      slotIndex: null,
      teamId: null,
      teamRole: null,
      botIds: [],
      teamDistanceRank: null,
      status: order?.status ?? 'queued',
      complete: Boolean(order?.complete),
      requiredItems: Array.isArray(order?.items_required) ? order.items_required : [],
      deliveredItems: Array.isArray(order?.items_delivered) ? order.items_delivered : [],
      isFront: false,
      isVisible: Boolean(order),
    });
    seenOrderIds.add(orderId);
  }

  return queueEntries;
}

export function buildTeamLegendEntries(plannerMetrics = {}) {
  const teams = Array.isArray(plannerMetrics?.teams) ? plannerMetrics.teams : [];
  return [...teams]
    .filter((team) => team?.teamId != null)
    .sort((left, right) => (left.slotIndex ?? 999) - (right.slotIndex ?? 999) || left.teamId - right.teamId)
    .map((team) => ({
      teamId: team.teamId,
      orderId: team.orderId ?? null,
      slotIndex: team.slotIndex ?? null,
      role: team.role ?? null,
      botCount: Array.isArray(team.botIds) ? team.botIds.length : 0,
      botIds: Array.isArray(team.botIds) ? team.botIds : [],
      isFront: (team.slotIndex ?? -1) === 0,
      teamShape: getTeamShape(team.teamId),
    }));
}

export function buildBotTooltipData(bots = [], botDetailsMap = {}) {
  return bots.map((bot) => {
    const detail = botDetailsMap[bot.id] || {};
    const inventory = (bot.inventory || []).map((item) => item.type || item);
    return {
      botId: bot.id,
      teamId: detail.teamId ?? null,
      slotIndex: detail.slotIndex ?? null,
      orderId: detail.orderId ?? null,
      taskType: detail.taskType || 'none',
      inventory,
      target: detail.target || null,
    };
  });
}

