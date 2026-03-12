import fs from 'node:fs';
import path from 'node:path';

import { collectReplayPaths, parseJsonl } from '../replay/replay-io.mjs';

function compareOrderIds(left, right) {
  const leftNum = Number.parseInt(String(left.id).split('_')[1], 10);
  const rightNum = Number.parseInt(String(right.id).split('_')[1], 10);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  return String(left.id).localeCompare(String(right.id));
}

export function extractOracleFromReplayCorpus({
  outDir,
  difficulty = 'expert',
  profile = null,
  mapSeed = null,
  outputPath = null,
}) {
  const replayPaths = collectReplayPaths(outDir, difficulty);
  const allOrders = new Map();
  let layoutData = null;
  let itemsData = null;
  let botCount = null;
  const sources = [];

  for (const replayPath of replayPaths) {
    const runDir = path.dirname(replayPath);
    const runId = path.basename(runDir);
    if (profile && !runId.endsWith(`-${profile}`)) {
      continue;
    }

    const rows = parseJsonl(replayPath);
    if (rows.length < 2) {
      continue;
    }

    const layout = rows[0];
    const firstTick = rows.find((row) => row.type === 'tick');
    if (!layout?.grid || !firstTick?.state_snapshot) {
      continue;
    }

    if (!layoutData) {
      layoutData = layout;
      itemsData = firstTick.state_snapshot.items || [];
      botCount = firstTick.state_snapshot.bots?.length || null;
    }

    sources.push({ runId, replayPath });

    for (const row of rows) {
      if (row.type !== 'tick') {
        continue;
      }

      for (const order of row.state_snapshot?.orders || []) {
        if (!allOrders.has(order.id)) {
          allOrders.set(order.id, {
            id: order.id,
            items_required: order.items_required,
            first_seen_tick: row.tick,
          });
        }
      }
    }
  }

  if (!layoutData || !itemsData) {
    throw new Error(`No ${difficulty} replay data found in ${outDir}`);
  }

  const oracle = {
    map_seed: mapSeed ?? layoutData.map_seed ?? 7004,
    difficulty,
    grid: { width: layoutData.grid.width, height: layoutData.grid.height },
    drop_off: layoutData.drop_off,
    bot_count: botCount,
    known_orders: [...allOrders.values()].sort(compareOrderIds),
    items: itemsData.map((item) => ({
      id: item.id,
      type: item.type,
      position: item.position,
    })),
  };

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(oracle, null, 2));
  }

  return {
    oracle,
    sources,
  };
}
