import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function sha1Json(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function safeGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function getGitProvenance() {
  const commit = safeGit(['rev-parse', 'HEAD']);
  const shortCommit = safeGit(['rev-parse', '--short', 'HEAD']);
  const status = safeGit(['status', '--porcelain']);
  return {
    commit,
    shortCommit,
    dirty: Boolean(status && status.length > 0),
  };
}

export function buildRunProvenance({
  difficulty,
  profileName,
  profile,
  oraclePath = null,
  oracle = null,
  scriptPath = null,
  script = null,
}) {
  const git = getGitProvenance();
  return {
    difficulty,
    profileName,
    git,
    profileHash: sha1Json(profile),
    oracle: oracle ? {
      path: oraclePath,
      knownOrders: oracle.known_orders?.length || 0,
      itemCount: oracle.items?.length || 0,
      hash: sha1Json(oracle),
      generatedAt: oracle.generated_at || null,
    } : null,
    script: script ? {
      path: scriptPath,
      strategy: script.strategy || null,
      lastScriptedTick: script.last_scripted_tick ?? null,
      hash: sha1Json({
        strategy: script.strategy,
        last_scripted_tick: script.last_scripted_tick,
        ticks: script.ticks,
      }),
      generatedAt: script.generated_at || null,
      sourceReplay: script.replay_target_meta?.source_replay || null,
      validationReplay: script.replay_target_meta?.validation_replay || null,
    } : null,
  };
}
