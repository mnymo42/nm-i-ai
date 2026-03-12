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

/**
 * Build a directional-preference map for corridor traffic flow.
 * Returns Map<coordKey, preferredDirection> where preferredDirection is 'up'|'down'|'left'|'right'.
 * Moving against the preference incurs a soft cost penalty in A*.
 *
 * Layout: vertical shelf walls at x=2,6,10,14,18,22 create 4-cell-wide aisles.
 * Within each aisle pair of walkable columns:
 *   - Left column prefers DOWN
 *   - Right column prefers UP
 * Horizontal corridors (top/bottom):
 *   - Top rows prefer RIGHT (toward drop-off side)
 *   - Bottom rows prefer LEFT (away from drop-off)
 */
export function buildDirectionalPreference(graph) {
  const pref = new Map();
  const { width, height } = graph;

  // Identify shelf wall x-positions by scanning for wall columns
  const shelfXs = [];
  for (let x = 0; x < width; x++) {
    // Check if this column has walls in the shelf region (y=2..8)
    let wallCount = 0;
    for (let y = 2; y <= 8; y++) {
      if (graph.isWall([x, y])) wallCount++;
    }
    if (wallCount >= 5) shelfXs.push(x);
  }

  // For each pair of adjacent shelf walls, the columns between them form an aisle
  // Assign left-half columns DOWN, right-half columns UP
  for (let i = 0; i < shelfXs.length - 1; i++) {
    const leftWall = shelfXs[i];
    const rightWall = shelfXs[i + 1];
    const aisleWidth = rightWall - leftWall - 1;
    if (aisleWidth < 2) continue;

    const mid = leftWall + 1 + Math.floor(aisleWidth / 2);
    for (let x = leftWall + 1; x < rightWall; x++) {
      for (let y = 0; y < height; y++) {
        if (!graph.isWalkable([x, y])) continue;
        const dir = x < mid ? 'down' : 'up';
        pref.set(encodeCoord([x, y]), dir);
      }
    }
  }

  // Horizontal corridors: y=0,1 prefer right; y=height-2,height-1 prefer left
  for (let x = 0; x < width; x++) {
    for (const y of [0, 1]) {
      if (graph.isWalkable([x, y])) {
        pref.set(encodeCoord([x, y]), 'right');
      }
    }
    for (const y of [height - 2, height - 1]) {
      if (graph.isWalkable([x, y])) {
        pref.set(encodeCoord([x, y]), 'left');
      }
    }
  }

  return pref;
}
