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

function findShelfColumns(graph) {
  const shelfXs = [];
  const shelfBandTop = Math.max(1, Math.floor(graph.height * 0.15));
  const shelfBandBottom = Math.min(graph.height - 2, graph.height - 4);
  for (let x = 0; x < graph.width; x += 1) {
    let wallCount = 0;
    for (let y = shelfBandTop; y <= shelfBandBottom; y += 1) {
      if (graph.isWall([x, y])) wallCount += 1;
    }
    if (wallCount >= Math.max(3, shelfBandBottom - shelfBandTop - 1)) {
      shelfXs.push(x);
    }
  }
  return shelfXs;
}

export function buildLaneMapV2(graph, dropOffs = []) {
  const oneWayRoads = {};
  const directionalPreference = new Map();
  const trafficLaneCells = new Set();
  const dropSideX = dropOffs.length > 0
    ? Math.round(dropOffs.reduce((sum, coord) => sum + coord[0], 0) / dropOffs.length)
    : 0;
  const centerRow = Math.floor(graph.height / 2);
  const shelfXs = findShelfColumns(graph);

  for (let x = 1; x < graph.width - 1; x += 1) {
    const top = [x, 1];
    const bottom = [x, graph.height - 2];
    if (graph.isWalkable(top)) {
      oneWayRoads[encodeCoord(top)] = ['right'];
      directionalPreference.set(encodeCoord(top), 'right');
      trafficLaneCells.add(encodeCoord(top));
    }
    if (graph.isWalkable(bottom)) {
      oneWayRoads[encodeCoord(bottom)] = ['left'];
      directionalPreference.set(encodeCoord(bottom), 'left');
      trafficLaneCells.add(encodeCoord(bottom));
    }
  }

  for (let y = 1; y < graph.height - 1; y += 1) {
    const left = [1, y];
    const right = [graph.width - 2, y];
    if (graph.isWalkable(left)) {
      oneWayRoads[encodeCoord(left)] = ['down'];
      directionalPreference.set(encodeCoord(left), 'down');
      trafficLaneCells.add(encodeCoord(left));
    }
    if (graph.isWalkable(right)) {
      oneWayRoads[encodeCoord(right)] = ['up'];
      directionalPreference.set(encodeCoord(right), 'up');
      trafficLaneCells.add(encodeCoord(right));
    }
  }

  for (let x = 1; x < graph.width - 1; x += 1) {
    const coord = [x, centerRow];
    if (!graph.isWalkable(coord)) continue;
    const dir = x <= dropSideX ? 'right' : 'left';
    oneWayRoads[encodeCoord(coord)] = [dir];
    directionalPreference.set(encodeCoord(coord), dir);
    trafficLaneCells.add(encodeCoord(coord));
  }

  for (let i = 0; i < shelfXs.length - 1; i += 1) {
    const leftWall = shelfXs[i];
    const rightWall = shelfXs[i + 1];
    const aisleCols = [];
    for (let x = leftWall + 1; x < rightWall; x += 1) {
      if (graph.isWalkable([x, centerRow])) aisleCols.push(x);
    }
    if (aisleCols.length === 0) continue;
    for (const x of aisleCols) {
      for (let y = 1; y < graph.height - 1; y += 1) {
        const coord = [x, y];
        if (!graph.isWalkable(coord)) continue;
        oneWayRoads[encodeCoord(coord)] = ['down'];
        directionalPreference.set(encodeCoord(coord), 'down');
        trafficLaneCells.add(encodeCoord(coord));
      }
    }
  }

  return {
    oneWayRoads,
    directionalPreference,
    trafficLaneCells,
    centerRow,
  };
}

export function buildLaneMapV3(graph, dropOffs = []) {
  const laneMap = buildLaneMapV2(graph, dropOffs);
  const dropSideX = dropOffs.length > 0
    ? Math.round(dropOffs.reduce((sum, coord) => sum + coord[0], 0) / dropOffs.length)
    : 0;
  const returnRow = Math.max(1, graph.height - 3);
  const feederCol = Math.min(graph.width - 2, Math.max(2, dropSideX + 1));
  const returnCol = Math.min(graph.width - 2, Math.max(feederCol + 2, graph.width - 3));

  for (let x = 1; x < graph.width - 1; x += 1) {
    const coord = [x, returnRow];
    if (!graph.isWalkable(coord)) continue;
    laneMap.oneWayRoads[encodeCoord(coord)] = ['right'];
    laneMap.directionalPreference.set(encodeCoord(coord), 'right');
    laneMap.trafficLaneCells.add(encodeCoord(coord));
  }

  for (let y = 1; y < graph.height - 1; y += 1) {
    const feederCoord = [feederCol, y];
    if (graph.isWalkable(feederCoord)) {
      laneMap.oneWayRoads[encodeCoord(feederCoord)] = ['down'];
      laneMap.directionalPreference.set(encodeCoord(feederCoord), 'down');
      laneMap.trafficLaneCells.add(encodeCoord(feederCoord));
    }
    const returnCoord = [returnCol, y];
    if (graph.isWalkable(returnCoord)) {
      laneMap.oneWayRoads[encodeCoord(returnCoord)] = ['up'];
      laneMap.directionalPreference.set(encodeCoord(returnCoord), 'up');
      laneMap.trafficLaneCells.add(encodeCoord(returnCoord));
    }
  }

  laneMap.returnRow = returnRow;
  laneMap.feederCol = feederCol;
  laneMap.returnCol = returnCol;
  return laneMap;
}

export function buildLaneMapV4(graph, dropOffs = []) {
  const oneWayRoads = {};
  const directionalPreference = new Map();
  const trafficLaneCells = new Set();
  const roadGroups = {
    topBackbone: [],
    middleBackbone: [],
    bottomBackbone: [],
    leftTravel: [],
    rightReturn: [],
    verticalSpines: [],
  };
  const topRow = 1;
  const middleRow = Math.floor(graph.height / 2);
  const bottomRow = Math.max(1, graph.height - 2);
  const leftCol = 1;
  const rightCol = Math.max(1, graph.width - 2);
  const shelfXs = findShelfColumns(graph);

  function addRoad(coord, dir, groupName, groupIndex = null) {
    if (!graph.isWalkable(coord)) return;
    const key = encodeCoord(coord);
    oneWayRoads[key] = [dir];
    directionalPreference.set(key, dir);
    trafficLaneCells.add(key);
    if (groupName === 'verticalSpines') {
      roadGroups.verticalSpines[groupIndex] ||= [];
      roadGroups.verticalSpines[groupIndex].push(key);
      return;
    }
    roadGroups[groupName].push(key);
  }

  for (let x = 1; x < graph.width - 1; x += 1) {
    addRoad([x, topRow], 'right', 'topBackbone');
    addRoad([x, middleRow], 'right', 'middleBackbone');
    addRoad([x, bottomRow], 'left', 'bottomBackbone');
  }

  for (let y = 1; y < graph.height - 1; y += 1) {
    addRoad([leftCol, y], 'up', 'leftTravel');
    addRoad([rightCol, y], 'up', 'rightReturn');
  }

  const gaps = [];
  if (shelfXs.length > 0) {
    for (let i = 0; i < shelfXs.length - 1; i += 1) {
      gaps.push([shelfXs[i] + 1, shelfXs[i + 1] - 1]);
    }
    gaps.push([shelfXs[shelfXs.length - 1] + 1, graph.width - 2]);
  }

  gaps.forEach(([startX, endX], index) => {
    const walkableCols = [];
    for (let x = startX; x <= endX; x += 1) {
      if (graph.isWalkable([x, middleRow])) {
        walkableCols.push(x);
      }
    }
    if (walkableCols.length === 0) return;
    const spineX = walkableCols[Math.floor((walkableCols.length - 1) / 2)];
    const dir = index % 2 === 0 ? 'down' : 'up';
    for (let y = 1; y < graph.height - 1; y += 1) {
      addRoad([spineX, y], dir, 'verticalSpines', index);
    }
  });

  return {
    oneWayRoads,
    directionalPreference,
    trafficLaneCells,
    centerRow: middleRow,
    returnRow: bottomRow,
    feederCol: leftCol,
    returnCol: rightCol,
    roadGroups,
    version: 'v4',
  };
}

export function serializeLaneMap(laneMap) {
  if (!laneMap) {
    return null;
  }

  return {
    oneWayRoads: laneMap.oneWayRoads,
    directionalPreference: Object.fromEntries(laneMap.directionalPreference || new Map()),
    trafficLaneCells: Array.from(laneMap.trafficLaneCells || []),
    centerRow: laneMap.centerRow ?? null,
    returnRow: laneMap.returnRow ?? null,
    feederCol: laneMap.feederCol ?? null,
    returnCol: laneMap.returnCol ?? null,
    roadGroups: laneMap.roadGroups ?? null,
    version: laneMap.version ?? null,
  };
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
  const shelfXs = findShelfColumns(graph);

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
