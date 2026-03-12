import fs from 'node:fs';
import path from 'node:path';

export function parseJsonl(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function extractLayout(rows) {
  const layoutRow = rows.find((row) => row.type === 'layout');
  if (layoutRow) {
    return {
      grid: layoutRow.grid,
      drop_off: layoutRow.drop_off,
      drop_offs: layoutRow.drop_offs || (layoutRow.drop_off ? [layoutRow.drop_off] : undefined),
      max_rounds: layoutRow.max_rounds,
    };
  }

  const firstTick = rows.find((row) => row.type === 'tick' && row.state_snapshot?.grid);
  if (!firstTick) {
    return null;
  }

  const snapshot = firstTick.state_snapshot;
  return {
    grid: snapshot.grid,
    drop_off: snapshot.drop_off,
    drop_offs: snapshot.drop_offs || (snapshot.drop_off ? [snapshot.drop_off] : undefined),
    max_rounds: snapshot.max_rounds,
  };
}

export function rebuildSnapshot(snapshot, layout) {
  if (!layout || !snapshot || snapshot.grid) {
    return snapshot;
  }

  return {
    ...snapshot,
    grid: layout.grid,
    drop_off: layout.drop_off,
    drop_offs: layout.drop_offs || (layout.drop_off ? [layout.drop_off] : undefined),
    max_rounds: layout.max_rounds,
  };
}

function collectReplayFilesFromDirectory(directoryPath, results) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectReplayFilesFromDirectory(entryPath, results);
      continue;
    }

    if (entry.isFile() && entry.name === 'replay.jsonl') {
      results.push(entryPath);
    }
  }
}

export function collectReplayPaths(targetPath, difficulty = null) {
  const stats = fs.statSync(targetPath);
  const replayPaths = [];

  if (stats.isDirectory()) {
    collectReplayFilesFromDirectory(targetPath, replayPaths);
  } else {
    replayPaths.push(targetPath);
  }

  const filtered = replayPaths.filter((replayPath) => {
    if (!difficulty) {
      return true;
    }

    const normalized = replayPath.replaceAll(path.sep, '/');
    return normalized.includes(`-${difficulty}-`);
  });

  return filtered.sort((left, right) => left.localeCompare(right));
}
