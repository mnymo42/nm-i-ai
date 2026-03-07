#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { parseCliArguments } from './src/cli.mjs';
import { GroceryGameClient } from './src/game-client.mjs';
import { estimateMaxScoreFromReplay } from './src/max-score-estimator.mjs';
import { tuneProfileFromReplay } from './src/optimizer.mjs';
import { loadOracleFile, loadScriptFile } from './src/oracle-script-io.mjs';
import { GroceryPlanner } from './src/planner.mjs';
import { loadProfiles, resolveProfile } from './src/profile.mjs';
import { buildRunProvenance } from './src/run-provenance.mjs';
import {
  ReplayLogger,
  summarizeReplay,
  simulateReplayAgainstObserved,
  generateAnalysis,
  benchmarkReplayCorpus,
} from './src/replay.mjs';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runId({ difficulty, profileName }) {
  return `${nowStamp()}-${difficulty}-${profileName}`;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

async function runPlayMode(args) {
  const profiles = loadProfiles(args.configPath);
  const selectedProfile = resolveProfile(profiles, args.difficulty, args.profile);
  const profileName = args.profile || args.difficulty;

  const id = runId({ difficulty: args.difficulty, profileName });
  const outPath = path.join(args.outDir, id);
  ensureDirectory(outPath);

  const replayPath = path.join(outPath, 'replay.jsonl');
  const logger = new ReplayLogger(replayPath);
  const oracleLoad = loadOracleFile(args.oracle);
  const scriptLoad = loadScriptFile(args.script);
  if (oracleLoad?.message) {
    (oracleLoad.ok ? console.log : console.error)(oracleLoad.message);
  }
  if (scriptLoad?.message) {
    (scriptLoad.ok ? console.log : console.error)(scriptLoad.message);
  }
  const oracle = oracleLoad?.data || null;
  const script = scriptLoad?.data || null;
  const provenance = buildRunProvenance({
    difficulty: args.difficulty,
    profileName,
    profile: selectedProfile,
    oraclePath: args.oracle,
    oracle,
    scriptPath: args.script,
    script,
  });
  const planner = new GroceryPlanner(selectedProfile, { oracle, script });

  logger.log({
    type: 'run_meta',
    difficulty: args.difficulty,
    profile: profileName,
    provenance,
  });

  let final = null;
  try {
    const client = new GroceryGameClient({ token: args.token });
    final = await client.run({
      planner,
      replayLogger: logger,
      difficulty: args.difficulty,
      profileName,
    });
  } finally {
    logger.close();
  }

  const replaySummary = summarizeReplay(replayPath);
  const summary = {
    runId: id,
    difficulty: args.difficulty,
    profile: profileName,
    finalScore: final?.score ?? replaySummary.finalScore,
    finalItems: final?.items ?? replaySummary.itemsDelivered,
    finalOrders: final?.orders ?? replaySummary.ordersCompleted,
    replay: replayPath,
    provenance,
    metrics: replaySummary,
  };

  const summaryPath = path.join(outPath, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const analysis = generateAnalysis(replayPath);
  const analysisPath = path.join(outPath, 'analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

  console.log(`Run completed. Score=${summary.finalScore}`);
  console.log(`Replay: ${replayPath}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Analysis: ${analysisPath}`);
}

function runSummaryMode(args) {
  const summary = summarizeReplay(args.replay);
  console.log(JSON.stringify(summary, null, 2));
}

function runSimulationMode(args) {
  const profiles = loadProfiles(args.configPath);
  const selectedProfile = resolveProfile(profiles, args.difficulty, args.profile);
  const planner = new GroceryPlanner(selectedProfile);
  const simulation = simulateReplayAgainstObserved(args.replay, planner);
  console.log(JSON.stringify(simulation, null, 2));
}

function runTuningMode(args) {
  const profiles = loadProfiles(args.configPath);
  const selectedProfile = resolveProfile(profiles, args.difficulty, args.profile);
  const tuning = tuneProfileFromReplay({
    replayPath: args.replay,
    profile: selectedProfile,
    difficulty: args.difficulty,
    seeds: args.randomSeeds,
    outputDir: args.outDir,
  });

  console.log(JSON.stringify({
    outputPath: tuning.outputPath,
    evaluation: tuning.evaluation,
  }, null, 2));
}

function runEstimateMaxMode(args) {
  const estimate = estimateMaxScoreFromReplay(args.replay);
  console.log(JSON.stringify(estimate, null, 2));
}

function runBenchmarkMode(args) {
  const profiles = loadProfiles(args.configPath);
  const selectedProfile = resolveProfile(profiles, args.difficulty, args.profile);
  const benchmark = benchmarkReplayCorpus({
    targetPath: args.replay,
    difficulty: args.difficulty,
    plannerFactory: () => new GroceryPlanner(selectedProfile),
  });

  console.log(JSON.stringify(benchmark, null, 2));
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));

  if (args.mode === 'play') {
    await runPlayMode(args);
    return;
  }

  if (args.mode === 'summarize') {
    runSummaryMode(args);
    return;
  }

  if (args.mode === 'simulate') {
    runSimulationMode(args);
    return;
  }

  if (args.mode === 'tune') {
    runTuningMode(args);
    return;
  }

  if (args.mode === 'estimate-max') {
    runEstimateMaxMode(args);
    return;
  }

  if (args.mode === 'benchmark') {
    runBenchmarkMode(args);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
