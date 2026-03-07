import fs from 'node:fs';
import path from 'node:path';

import { GroceryPlanner } from './planner.mjs';
import { simulateReplayAgainstObserved } from './replay.mjs';

function jitter(value, scale, random) {
  const delta = (random() * 2 - 1) * scale;
  return Math.max(0, value * (1 + delta));
}

function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function mutateProfile(profile, random) {
  return {
    ...profile,
    assignment: {
      ...profile.assignment,
      congestion_penalty: jitter(profile.assignment.congestion_penalty, 0.25, random),
      contention_penalty: jitter(profile.assignment.contention_penalty, 0.25, random),
      urgency_bonus: jitter(profile.assignment.urgency_bonus, 0.2, random),
      remaining_demand_priority: jitter(profile.assignment.remaining_demand_priority, 0.2, random),
      preview_item_weight: jitter(profile.assignment.preview_item_weight, 0.2, random),
    },
    routing: {
      ...profile.routing,
      horizon: Math.max(8, Math.round(jitter(profile.routing.horizon, 0.15, random))),
    },
  };
}

export function tuneProfileFromReplay({
  replayPath,
  profile,
  difficulty,
  seeds,
  outputDir,
}) {
  let bestProfile = profile;
  let bestEval = simulateReplayAgainstObserved(replayPath, new GroceryPlanner(profile));

  for (let seed = 1; seed <= seeds; seed += 1) {
    const random = createSeededRandom(seed * 7919);
    const candidateProfile = mutateProfile(profile, random);
    const candidateEval = simulateReplayAgainstObserved(replayPath, new GroceryPlanner(candidateProfile));

    const score = (e) => e.matchRatio - e.waitRatio;
    if (score(candidateEval) > score(bestEval)) {
      bestProfile = candidateProfile;
      bestEval = candidateEval;
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const filePath = path.join(outputDir, `tuned-${difficulty}.json`);
  fs.writeFileSync(filePath, JSON.stringify(bestProfile, null, 2));

  return {
    outputPath: filePath,
    evaluation: bestEval,
    profile: bestProfile,
  };
}
