import { buildActionEnvelope } from '../client/protocol.mjs';
import { parseJsonl } from './replay-io.mjs';

function normalizeCoord(coord) {
  return Array.isArray(coord) ? [...coord] : coord;
}

function sortStrings(values = []) {
  return [...values].sort();
}

export function buildComparableReplayState(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    type: snapshot.type ?? null,
    round: snapshot.round ?? null,
    max_rounds: snapshot.max_rounds ?? null,
    score: snapshot.score ?? 0,
    drop_off: normalizeCoord(snapshot.drop_off ?? null),
    drop_offs: [...(snapshot.drop_offs || (snapshot.drop_off ? [snapshot.drop_off] : []))]
      .map(normalizeCoord)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    bots: [...(snapshot.bots || [])]
      .map((bot) => ({
        id: bot.id,
        position: normalizeCoord(bot.position),
        inventory: sortStrings(bot.inventory || []),
      }))
      .sort((left, right) => left.id - right.id),
    items: [...(snapshot.items || [])]
      .map((item) => ({
        id: item.id,
        type: item.type,
        position: normalizeCoord(item.position),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    orders: [...(snapshot.orders || [])]
      .map((order) => ({
        id: order.id,
        status: order.status ?? null,
        complete: Boolean(order.complete),
        items_required: sortStrings(order.items_required || []),
        items_delivered: sortStrings(order.items_delivered || []),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function buildExpectedScriptState(snapshot) {
  return buildComparableReplayState(snapshot);
}

export function buildComparableActionList(actions = []) {
  return actions.map((action) => ({ ...action }));
}

export function diffComparableReplayValues(left, right, path = '$', diffs = []) {
  if (Object.is(left, right)) {
    return diffs;
  }

  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray || rightIsArray) {
    if (!leftIsArray || !rightIsArray) {
      diffs.push({ path, left, right });
      return diffs;
    }
    if (left.length !== right.length) {
      diffs.push({ path: `${path}.length`, left: left.length, right: right.length });
    }
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
      if (index >= left.length || index >= right.length) {
        diffs.push({ path: `${path}[${index}]`, left: left[index], right: right[index] });
        continue;
      }
      diffComparableReplayValues(left[index], right[index], `${path}[${index}]`, diffs);
      if (diffs.length >= 25) {
        return diffs;
      }
    }
    return diffs;
  }

  const leftIsObject = left && typeof left === 'object';
  const rightIsObject = right && typeof right === 'object';
  if (leftIsObject || rightIsObject) {
    if (!leftIsObject || !rightIsObject) {
      diffs.push({ path, left, right });
      return diffs;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (!(key in left) || !(key in right)) {
        diffs.push({ path: `${path}.${key}`, left: left[key], right: right[key] });
        continue;
      }
      diffComparableReplayValues(left[key], right[key], `${path}.${key}`, diffs);
      if (diffs.length >= 25) {
        return diffs;
      }
    }
    return diffs;
  }

  diffs.push({ path, left, right });
  return diffs;
}

function firstDiffPath(diffs) {
  return diffs[0]?.path ?? null;
}

function buildTickMap(replayPath) {
  return new Map(
    parseJsonl(replayPath)
      .filter((row) => row.type === 'tick')
      .map((row) => [row.tick, row]),
  );
}

export function compareReplayTransitionAtTick({ sourceReplayPath, validationReplayPath, tick }) {
  const sourceMap = buildTickMap(sourceReplayPath);
  const validationMap = buildTickMap(validationReplayPath);
  const sourceRow = sourceMap.get(tick) || null;
  const validationRow = validationMap.get(tick) || null;
  const sourceNextRow = sourceMap.get(tick + 1) || null;
  const validationNextRow = validationMap.get(tick + 1) || null;

  const sourceState = buildComparableReplayState(sourceRow?.state_snapshot);
  const validationState = buildComparableReplayState(validationRow?.state_snapshot);
  const sourceActions = buildComparableActionList(sourceRow?.actions_sent || []);
  const validationActions = buildComparableActionList(validationRow?.actions_sent || []);
  const sourceEnvelope = sourceRow ? buildActionEnvelope(sourceActions) : null;
  const validationEnvelope = validationRow ? buildActionEnvelope(validationActions) : null;
  const sourceNextState = buildComparableReplayState(sourceNextRow?.state_snapshot);
  const validationNextState = buildComparableReplayState(validationNextRow?.state_snapshot);

  const preStateDiffs = diffComparableReplayValues(sourceState, validationState);
  const actionDiffs = diffComparableReplayValues(sourceActions, validationActions);
  const nextStateDiffs = diffComparableReplayValues(sourceNextState, validationNextState);

  const preStateEqual = preStateDiffs.length === 0;
  const actionsEqual = actionDiffs.length === 0;
  const actionEnvelopeEqual = sourceEnvelope === validationEnvelope;
  const nextStateEqual = nextStateDiffs.length === 0;

  let firstDifference = null;
  if (!preStateEqual) {
    firstDifference = { phase: 'pre_state', path: firstDiffPath(preStateDiffs) };
  } else if (!actionsEqual || !actionEnvelopeEqual) {
    firstDifference = {
      phase: 'actions',
      path: !actionsEqual ? firstDiffPath(actionDiffs) : '$.action_envelope',
    };
  } else if (!nextStateEqual) {
    firstDifference = { phase: 'next_state', path: firstDiffPath(nextStateDiffs) };
  }

  return {
    tick,
    preStateEqual,
    actionsEqual,
    actionEnvelopeEqual,
    nextStateEqual,
    firstDifference,
    sourceActionEnvelope: sourceEnvelope,
    validationActionEnvelope: validationEnvelope,
    preStateDiffs,
    actionDiffs,
    nextStateDiffs,
  };
}

export function findFirstReplayTransitionMismatch({ sourceReplayPath, validationReplayPath }) {
  const sourceMap = buildTickMap(sourceReplayPath);
  const validationMap = buildTickMap(validationReplayPath);
  const maxTick = Math.min(
    Math.max(...sourceMap.keys()),
    Math.max(...validationMap.keys()) - 1,
  );

  for (let tick = 0; tick <= maxTick; tick += 1) {
    const comparison = compareReplayTransitionAtTick({
      sourceReplayPath,
      validationReplayPath,
      tick,
    });
    if (!comparison.preStateEqual || !comparison.actionsEqual || !comparison.actionEnvelopeEqual || !comparison.nextStateEqual) {
      return comparison;
    }
  }

  return null;
}
