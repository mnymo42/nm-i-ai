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

function sameTargetConflictLosers(group, currentByBot) {
  if (group.length <= 1) {
    return [];
  }

  const stationary = group.filter((entry) => isSameCell(entry.target, currentByBot.get(entry.bot.id)));
  const dropOffStationary = stationary.filter((entry) => entry.sanitized.action === 'drop_off');
  const winners = dropOffStationary.length > 0 ? dropOffStationary : stationary;

  if (winners.length > 0) {
    const winnerIds = new Set(winners.map((entry) => entry.bot.id));
    return group.filter((entry) => !winnerIds.has(entry.bot.id));
  }

  const [winner] = [...group].sort((a, b) => a.bot.id - b.bot.id);
  return group.filter((entry) => entry.bot.id !== winner.bot.id);
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

    for (const entry of sameTargetConflictLosers(group, currentByBot)) {
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
