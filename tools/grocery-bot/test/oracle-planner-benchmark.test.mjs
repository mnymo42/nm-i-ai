import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner/planner.mjs';
import { benchmarkPlannerAgainstOracleEnvironment } from '../src/oracle/oracle-planner-benchmark.mjs';
import { defaultProfiles } from '../src/utils/profile.mjs';

function buildProfile(laneMapVersion) {
  const profile = structuredClone(defaultProfiles.expert);
  profile.opener.enabled = false;
  profile.routing.lane_map_version = laneMapVersion;
  return profile;
}

function buildOracle() {
  return {
    difficulty: 'expert',
    map_seed: 7004,
    grid: { width: 8, height: 6 },
    drop_off: [1, 4],
    bot_count: 1,
    items: [
      { id: 'item_0', type: 'milk', position: [2, 3] },
    ],
    known_orders: [
      { id: 'order_0', items_required: ['milk'], first_seen_tick: 0 },
    ],
  };
}

test('oracle planner benchmark is deterministic and ranks variants', () => {
  const oracle = buildOracle();
  const report = benchmarkPlannerAgainstOracleEnvironment({
    oracle,
    runs: 2,
    plannerFactoryByVariant: {
      v2: () => new GroceryPlanner(buildProfile('v2'), { oracle }),
      v4: () => new GroceryPlanner(buildProfile('v4'), { oracle }),
    },
  });

  assert.equal(report.variantCount, 2);
  assert.equal(report.runCountPerVariant, 2);
  for (const variant of report.variants) {
    assert.equal(variant.runs.length, 2);
    assert.deepEqual(variant.runs[0], variant.runs[1]);
    assert.equal(typeof variant.averages.finalScore, 'number');
  }
});
