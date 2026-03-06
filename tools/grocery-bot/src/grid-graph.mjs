import { encodeCoord } from './coords.mjs';

const STEP_OFFSETS = [
  [1, 0],
  [0, 1],
  [0, -1],
  [-1, 0],
];

export class GridGraph {
  constructor({ width, height, walls }) {
    this.width = width;
    this.height = height;
    this.wallSet = new Set((walls || []).map((wall) => encodeCoord(wall)));
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

    for (const [dx, dy] of STEP_OFFSETS) {
      const candidate = [x + dx, y + dy];
      if (this.isWalkable(candidate)) {
        neighbors.push(candidate);
      }
    }

    return neighbors;
  }

  adjacentWalkableCells(target) {
    return this.neighbors(target);
  }
}
