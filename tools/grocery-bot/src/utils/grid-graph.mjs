import { encodeCoord } from './coords.mjs';

const STEP_OFFSETS = [
  [1, 0],
  [0, 1],
  [0, -1],
  [-1, 0],
];


export class GridGraph {
  constructor({ width, height, walls, oneWayRoads = null }) {
    this.width = width;
    this.height = height;
    this.wallSet = new Set((walls || []).map((wall) => encodeCoord(wall)));
    // oneWayRoads: Map from cell key to allowed directions (e.g. { '3,5': ['right'] })
    this.oneWayRoads = oneWayRoads;
  }

  inBounds([x, y]) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  isWall(coord) {
    return this.wallSet.has(encodeCoord(coord));
  }

  isWalkable(coord) {
    return this.inBounds(coord) && !this.isWall(coord);
  }

  neighbors(coord) {
    const [x, y] = coord;
    const neighbors = [];
    let allowedDirs = null;
    if (this.oneWayRoads) {
      allowedDirs = this.oneWayRoads[encodeCoord(coord)] || null;
    }
    for (let i = 0; i < STEP_OFFSETS.length; ++i) {
      const [dx, dy] = STEP_OFFSETS[i];
      const candidate = [x + dx, y + dy];
      let dir = null;
      if (dx === 1 && dy === 0) dir = 'right';
      else if (dx === -1 && dy === 0) dir = 'left';
      else if (dx === 0 && dy === 1) dir = 'down';
      else if (dx === 0 && dy === -1) dir = 'up';
      if (this.isWalkable(candidate)) {
        if (!allowedDirs || allowedDirs.includes(dir)) {
          neighbors.push(candidate);
        }
      }
    }
    return neighbors;
  }

  adjacentWalkableCells(target) {
    return this.neighbors(target);
  }
}
