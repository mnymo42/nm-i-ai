import { compressOracleReplayScript } from './oracle-script-compressor.mjs';
import { extractLayout, parseJsonl, rebuildSnapshot } from '../replay/replay-io.mjs';

function buildTickRows(replayPath) {
  const rows = parseJsonl(replayPath);
  const layout = extractLayout(rows);
  return rows
    .filter((row) => row.type === 'tick')
    .map((row) => ({
      ...row,
      state_snapshot: rebuildSnapshot(row.state_snapshot, layout),
    }));
}

function firstTickMatching(rows, predicate) {
  const match = rows.find(predicate);
  return match ? {
    tick: match.tick,
    score: match.state_snapshot?.score ?? 0,
    state_snapshot: match.state_snapshot,
  } : null;
}

function countPickups(row) {
  return (row.actions_sent || row.actions_planned || []).filter((action) => action.action === 'pick_up').length;
}

export function extractReplayCheckpoints({
  replayPath,
  maxTick = 100,
  scoreTargets = [20, 40, 60, 80, 90],
}) {
  const rows = buildTickRows(replayPath).filter((row) => row.tick <= maxTick);
  const checkpoints = [];
  const firstTick = rows[0] || null;
  if (firstTick) {
    checkpoints.push({
      name: 'start',
      tick: firstTick.tick,
      score: firstTick.state_snapshot?.score ?? 0,
      state_snapshot: firstTick.state_snapshot,
    });
  }

  const pickupWave = firstTickMatching(rows, (row) => countPickups(row) >= 2 || countPickups(row) > 0);
  if (pickupWave) {
    checkpoints.push({ name: 'first_pickup_wave', ...pickupWave });
  }

  const firstScore = firstTickMatching(rows, (row) => (row.state_snapshot?.score ?? 0) > 0);
  if (firstScore) {
    checkpoints.push({ name: 'first_score_event', ...firstScore });
  }

  for (const target of scoreTargets) {
    const hit = firstTickMatching(rows, (row) => (row.state_snapshot?.score ?? 0) >= target);
    if (hit) {
      checkpoints.push({ name: `score_${target}`, target_score: target, ...hit });
    }
  }

  return checkpoints
    .sort((left, right) => left.tick - right.tick || left.name.localeCompare(right.name))
    .filter((checkpoint, index, array) => index === 0
      || checkpoint.name !== array[index - 1].name);
}

export function buildCheckpointRewriteCandidates({
  oracle,
  replayPath,
  maxTick = 100,
  scoreTargets = [20, 40, 60, 80, 90],
}) {
  const checkpoints = extractReplayCheckpoints({ replayPath, maxTick, scoreTargets });
  const candidates = [];

  for (const checkpoint of checkpoints) {
    if (!Number.isFinite(checkpoint.tick) || checkpoint.tick <= 0) {
      continue;
    }
    if (!Number.isFinite(checkpoint.score) || checkpoint.score <= 0) {
      continue;
    }
    const preserve = compressOracleReplayScript({
      oracle,
      replayPath,
      stopTick: checkpoint.tick,
      targetScore: checkpoint.score,
      mode: 'preserve_score',
    });
    candidates.push({
      family: 'checkpoint_rewriter',
      milestone: checkpoint.name,
      scoreTarget: checkpoint.score,
      stopTick: checkpoint.tick,
      rewindTicks: 0,
      script: {
        ...preserve,
        strategy: 'checkpoint_rewriter',
        settings: {
          checkpointName: checkpoint.name,
          checkpointTick: checkpoint.tick,
          targetScore: checkpoint.score,
          stopTick: checkpoint.tick,
          mode: 'preserve_score',
          rewindTicks: 0,
        },
        checkpoint_rewriter_meta: {
          milestone: checkpoint.name,
          start_tick: 0,
          stop_tick: checkpoint.tick,
          target_score: checkpoint.score,
          state_snapshot: checkpoint.state_snapshot,
        },
      },
    });

    for (const rewindTicks of [4, 8, 12]) {
      const rewound = compressOracleReplayScript({
        oracle,
        replayPath,
        stopTick: checkpoint.tick,
        targetScore: checkpoint.score,
        mode: 'handoff_early',
        rewindTicks,
      });
      candidates.push({
        family: 'checkpoint_rewriter',
        milestone: checkpoint.name,
        scoreTarget: checkpoint.score,
        stopTick: checkpoint.tick,
        rewindTicks,
        script: {
          ...rewound,
          strategy: 'checkpoint_rewriter',
          settings: {
            checkpointName: checkpoint.name,
            checkpointTick: checkpoint.tick,
            targetScore: checkpoint.score,
            stopTick: checkpoint.tick,
            mode: 'handoff_early',
            rewindTicks,
          },
          checkpoint_rewriter_meta: {
            milestone: checkpoint.name,
            start_tick: 0,
            stop_tick: checkpoint.tick,
            target_score: checkpoint.score,
            state_snapshot: checkpoint.state_snapshot,
          },
        },
      });
    }
  }

  return candidates;
}

