export function encodeCoord(coord) {
  return `${coord[0]},${coord[1]}`;
}

export function decodeCoord(key) {
  const [x, y] = key.split(',').map(Number);
  return [x, y];
}

export function manhattanDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

export function adjacentManhattan(a, b) {
  return manhattanDistance(a, b) === 1;
}

export function moveToAction(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];

  if (dx === 1 && dy === 0) {
    return 'move_right';
  }

  if (dx === -1 && dy === 0) {
    return 'move_left';
  }

  if (dx === 0 && dy === 1) {
    return 'move_down';
  }

  if (dx === 0 && dy === -1) {
    return 'move_up';
  }

  return 'wait';
}
