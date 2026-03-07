import { manhattanDistance } from './coords.mjs';

function isCoordPair(value) {
  return Array.isArray(value)
    && value.length === 2
    && Number.isFinite(value[0])
    && Number.isFinite(value[1]);
}

export function normalizeDropOffs(payload) {
  const candidates = [
    payload?.drop_offs,
    payload?.drop_zones,
    payload?.dropZones,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every(isCoordPair)) {
      return candidate.map((coord) => [...coord]);
    }
  }

  if (Array.isArray(payload?.drop_off) && payload.drop_off.every(isCoordPair)) {
    return payload.drop_off.map((coord) => [...coord]);
  }

  if (isCoordPair(payload?.drop_off)) {
    return [[...payload.drop_off]];
  }

  return [[0, 0]];
}

export function getDropOffs(state) {
  if (Array.isArray(state?.drop_offs) && state.drop_offs.every(isCoordPair)) {
    return state.drop_offs.map((coord) => [...coord]);
  }

  return normalizeDropOffs(state);
}

export function primaryDropOff(state) {
  return getDropOffs(state)[0] || [0, 0];
}

export function nearestDropOff(position, stateOrDropOffs) {
  const dropOffs = Array.isArray(stateOrDropOffs)
    ? (isCoordPair(stateOrDropOffs)
      ? [[...stateOrDropOffs]]
      : normalizeDropOffs({ drop_offs: stateOrDropOffs }))
    : getDropOffs(stateOrDropOffs);

  let best = dropOffs[0] || [0, 0];
  let bestDistance = manhattanDistance(position, best);

  for (const dropOff of dropOffs.slice(1)) {
    const distance = manhattanDistance(position, dropOff);
    if (distance < bestDistance) {
      best = dropOff;
      bestDistance = distance;
    }
  }

  return [...best];
}

export function isAtAnyDropOff(position, stateOrDropOffs) {
  const normalized = Array.isArray(stateOrDropOffs)
    ? (isCoordPair(stateOrDropOffs) ? [stateOrDropOffs] : stateOrDropOffs)
    : stateOrDropOffs;
  return getDropOffs(Array.isArray(normalized) ? { drop_offs: normalized } : normalized)
    .some((dropOff) => dropOff[0] === position[0] && dropOff[1] === position[1]);
}

export function estimateDistanceToNearestDropOff(positionOrItem, stateOrDropOffs) {
  const position = positionOrItem?.position || positionOrItem;
  const target = nearestDropOff(position, stateOrDropOffs);
  return Math.max(1, manhattanDistance(position, target) - 1);
}
