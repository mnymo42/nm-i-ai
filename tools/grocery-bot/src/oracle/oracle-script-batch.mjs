import path from 'node:path';

import { buildOpeningAuditReport } from '../replay/opening-audit.mjs';
import { extractReplayBaselineMetrics, getScriptMilestoneMetrics } from './oracle-script-metrics.mjs';
import { compareGeneratedScripts } from './oracle-script-search.mjs';

function buildCandidateOpeningAudit({ oraclePath, replayPath, scriptPath }) {
  if (!oraclePath || !replayPath || !scriptPath) {
    return null;
  }
  try {
    return buildOpeningAuditReport({
      oraclePath,
      replayPath,
      scriptPath,
      maxTick: 120,
    });
  } catch {
    return null;
  }
}

export function buildOptimizationJobs({
  runs = 8,
  seed = 7004,
  objectives = ['score_by_tick_100'],
  strategy = 'auto',
  iterations = 150,
}) {
  const jobs = [];
  const normalizedObjectives = objectives.length > 0 ? objectives : ['handoff_value'];
  for (let index = 0; index < runs; index += 1) {
    jobs.push({
      id: index,
      seed: seed + index,
      objective: normalizedObjectives[index % normalizedObjectives.length],
      strategy,
      iterations,
    });
  }
  return jobs;
}

export function compareOptimizationResults(left, right, objective = 'handoff_value') {
  return compareGeneratedScripts(left.script, right.script, objective);
}

export function buildBatchReport({
  oraclePath,
  replayPath,
  objective,
  parallel,
  jobs,
  results,
  elapsedMs,
}) {
  const sorted = [...results].sort((left, right) => compareOptimizationResults(left, right, objective));
  const best = sorted[0] || null;
  const baseline = replayPath ? extractReplayBaselineMetrics(replayPath) : null;
  const bestAudit = best ? buildCandidateOpeningAudit({
    oraclePath,
    replayPath,
    scriptPath: best.paths.outScript,
  }) : null;
  const frontier = {
    best_score_by_tick_100: null,
    best_tick_to_40: null,
    best_tick_to_60: null,
    best_tick_to_80: null,
  };
  const bestByObjective = [...new Set(results.map((result) => result.job.objective))].map((resultObjective) => {
    const ranked = [...results]
      .filter((result) => result.job.objective === resultObjective)
      .sort((left, right) => compareOptimizationResults(left, right, resultObjective));
    const top = ranked[0];
    return top ? {
      objective: resultObjective,
      id: top.job.id,
      seed: top.job.seed,
      strategy: top.script.strategy,
      estimated_score: top.script.estimated_score,
      last_scripted_tick: top.script.last_scripted_tick,
    } : null;
  }).filter(Boolean);

  for (const result of results) {
    const milestones = getScriptMilestoneMetrics(result.script);
    if (!frontier.best_score_by_tick_100 || milestones.score_at_tick_100 > frontier.best_score_by_tick_100.score_at_tick_100) {
      frontier.best_score_by_tick_100 = {
        id: result.job.id,
        seed: result.job.seed,
        objective: result.job.objective,
        strategy: result.script.strategy,
        score_at_tick_100: milestones.score_at_tick_100,
        last_scripted_tick: result.script.last_scripted_tick,
      };
    }
    for (const [label, key] of [['best_tick_to_40', 'tick_to_40'], ['best_tick_to_60', 'tick_to_60'], ['best_tick_to_80', 'tick_to_80']]) {
      const tick = milestones[key];
      if (tick === null) {
        continue;
      }
      if (!frontier[label] || tick < frontier[label][key]) {
        frontier[label] = {
          id: result.job.id,
          seed: result.job.seed,
          objective: result.job.objective,
          strategy: result.script.strategy,
          [key]: tick,
          score_at_tick_100: milestones.score_at_tick_100,
        };
      }
    }
  }
  const promotableShortlist = sorted
    .filter((result) => result.script.search_meta?.triage?.promotable)
    .slice(0, 10)
    .map((result, index) => ({
      rank: index + 1,
      id: result.job.id,
      seed: result.job.seed,
      objective: result.job.objective,
      strategy: result.script.strategy,
      score_at_tick_100: getScriptMilestoneMetrics(result.script).score_at_tick_100,
      last_scripted_tick: result.script.last_scripted_tick,
      triage: result.script.search_meta?.triage || null,
    }));
  return {
    generated_at: new Date().toISOString(),
    oracle_source: oraclePath,
    replay: replayPath,
    baseline,
    opening_baseline: bestAudit?.opening_baseline || null,
    opening_profile: bestAudit?.opening_profile || null,
    first_divergence_tick: bestAudit?.first_divergence_tick ?? null,
    first_divergence: bestAudit?.first_divergence || null,
    objective,
    parallel,
    jobs_requested: jobs.length,
    jobs_completed: results.length,
    elapsed_ms: elapsedMs,
    best_job: best ? {
      id: best.job.id,
      seed: best.job.seed,
      objective: best.job.objective,
      strategy: best.script.strategy,
      estimated_score: best.script.estimated_score,
      last_scripted_tick: best.script.last_scripted_tick,
      out_script: best.paths.outScript,
      out_report: best.paths.outReport,
    } : null,
    best_by_objective: bestByObjective,
    frontier,
    promotable_shortlist: promotableShortlist,
    top_results: sorted.slice(0, 20).map((result, index) => {
      const audit = buildCandidateOpeningAudit({
        oraclePath,
        replayPath,
        scriptPath: result.paths.outScript,
      });
      return {
        ...getScriptMilestoneMetrics(result.script),
        rank: index + 1,
        id: result.job.id,
        seed: result.job.seed,
        objective: result.job.objective,
        strategy: result.script.strategy,
        estimated_score: result.script.estimated_score,
        last_scripted_tick: result.script.last_scripted_tick,
        baseline_match: result.script.search_meta?.triage?.baseline_match || false,
        baseline_beat: result.script.search_meta?.triage?.baseline_beat || false,
        promotable: result.script.search_meta?.triage?.promotable || false,
        first_divergence_tick: audit?.first_divergence_tick ?? null,
        first_divergence: audit?.first_divergence || null,
        triage: result.script.search_meta?.triage || null,
        total_waits: result.script.aggregate_efficiency?.total_waits || 0,
        out_script: path.basename(result.paths.outScript),
        out_report: path.basename(result.paths.outReport),
      };
    }),
  };
}
