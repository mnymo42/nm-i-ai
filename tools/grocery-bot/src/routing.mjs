import { encodeCoord, manhattanDistance } from './coords.mjs';

function reservationHas(map, time, coordKey) {
  const bucket = map.get(time);
  return Boolean(bucket && bucket.has(coordKey));
}

function edgeReservationHas(map, time, fromKey, toKey) {
  const bucket = map.get(time);
  return Boolean(bucket && bucket.has(`${fromKey}>${toKey}`));
}

function stateKey(coord, time) {
  return `${coord[0]},${coord[1]}@${time}`;
}

export function findTimeAwarePath({
  graph,
  start,
  goal,
  reservations,
  edgeReservations = new Map(),
  startTime = 0,
  horizon = 16,
}) {
  if (!graph.isWalkable(start) || !graph.isWalkable(goal)) {
    return null;
  }

  const open = [{ coord: start, time: startTime, g: 0, f: manhattanDistance(start, goal) }];
  const cameFrom = new Map();
  const best = new Map([[stateKey(start, startTime), 0]]);

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f || a.g - b.g);
    const current = open.shift();

    if (current.coord[0] === goal[0] && current.coord[1] === goal[1]) {
      const path = [];
      let key = stateKey(current.coord, current.time);

      while (key) {
        const [coordStr] = key.split('@');
        const [x, y] = coordStr.split(',').map(Number);
        path.push([x, y]);
        key = cameFrom.get(key);
      }

      path.reverse();
      return path;
    }

    if (current.g >= horizon) {
      continue;
    }

    const currentKey = encodeCoord(current.coord);
    const options = [current.coord, ...graph.neighbors(current.coord)];

    for (const nextCoord of options) {
      const nextTime = current.time + 1;
      const nextCoordKey = encodeCoord(nextCoord);

      if (reservationHas(reservations, nextTime, nextCoordKey)) {
        continue;
      }

      if (edgeReservationHas(edgeReservations, nextTime, nextCoordKey, currentKey)) {
        continue;
      }

      const nextG = current.g + 1;
      const nextF = nextG + manhattanDistance(nextCoord, goal);
      const nextStateKey = stateKey(nextCoord, nextTime);
      const previousBest = best.get(nextStateKey);

      if (previousBest !== undefined && previousBest <= nextG) {
        continue;
      }

      best.set(nextStateKey, nextG);
      cameFrom.set(nextStateKey, stateKey(current.coord, current.time));
      open.push({ coord: nextCoord, time: nextTime, g: nextG, f: nextF });
    }
  }

  return null;
}

export function reservePath({
  path,
  startTime,
  reservations,
  edgeReservations,
  horizon,
  holdAtGoal = true,
}) {
  if (!path || path.length === 0) {
    return;
  }

  for (let index = 1; index < path.length; index += 1) {
    const time = startTime + index;
    const fromKey = encodeCoord(path[index - 1]);
    const toKey = encodeCoord(path[index]);

    if (!reservations.has(time)) {
      reservations.set(time, new Set());
    }

    reservations.get(time).add(toKey);

    if (!edgeReservations.has(time)) {
      edgeReservations.set(time, new Set());
    }

    edgeReservations.get(time).add(`${fromKey}>${toKey}`);
  }

  if (holdAtGoal) {
    const goalKey = encodeCoord(path[path.length - 1]);
    const baseTime = startTime + path.length - 1;

    for (let offset = 1; offset <= horizon; offset += 1) {
      const holdTime = baseTime + offset;
      if (!reservations.has(holdTime)) {
        reservations.set(holdTime, new Set());
      }

      reservations.get(holdTime).add(goalKey);
    }
  }
}
