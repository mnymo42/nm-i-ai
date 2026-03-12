import path from 'node:path';

export function normalizeTokenInput(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) {
    return trimmed;
  }

  let parsed = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const token = parsed.searchParams.get('token');
  return token || trimmed;
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);

  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function inferDifficultyFromToken(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  const payloadJson = decodeBase64Url(parts[1]);
  if (!payloadJson) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadJson);
    return typeof payload?.difficulty === 'string' ? payload.difficulty : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    token: null,
    difficulty: 'easy',
    profile: null,
    outDir: path.resolve(process.cwd(), 'tools/grocery-bot/out'),
    configPath: path.resolve(process.cwd(), 'tools/grocery-bot/config/profiles.json'),
    mode: 'play',
    replay: null,
    randomSeeds: 32,
    limit: 10,
    oracle: null,
    script: null,
    maxTick: 120,
  };
  let difficultyExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key.startsWith('--')) {
      continue;
    }

    if (['--token', '--difficulty', '--profile', '--out-dir', '--config', '--mode', '--replay', '--seeds', '--limit', '--oracle', '--script', '--max-tick'].includes(key)) {
      if (value === undefined) {
        throw new Error(`Missing value for ${key}`);
      }

      index += 1;
    }

    switch (key) {
      case '--token':
        args.token = normalizeTokenInput(value);
        break;
      case '--difficulty':
        args.difficulty = value;
        difficultyExplicit = true;
        break;
      case '--profile':
        args.profile = value;
        break;
      case '--out-dir':
        args.outDir = path.resolve(process.cwd(), value);
        break;
      case '--config':
        args.configPath = path.resolve(process.cwd(), value);
        break;
      case '--mode':
        args.mode = value;
        break;
      case '--replay':
        args.replay = path.resolve(process.cwd(), value);
        break;
      case '--seeds':
        args.randomSeeds = Number(value);
        break;
      case '--limit':
        args.limit = Number(value);
        break;
      case '--oracle':
        args.oracle = path.resolve(process.cwd(), value);
        break;
      case '--script':
        args.script = path.resolve(process.cwd(), value);
        break;
      case '--max-tick':
        args.maxTick = Number(value);
        break;
      default:
        break;
    }
  }

  if (!difficultyExplicit && args.mode === 'play' && args.token) {
    args.difficulty = inferDifficultyFromToken(args.token) || args.difficulty;
  }

  return args;
}

export function parseCliArguments(argv) {
  const args = parseArgs(argv);

  const validDifficulties = new Set(['easy', 'medium', 'hard', 'expert', 'nightmare']);
  if (!validDifficulties.has(args.difficulty)) {
    throw new Error(`Invalid difficulty: ${args.difficulty}`);
  }

  const validModes = new Set(['play', 'summarize', 'simulate', 'tune', 'benchmark', 'runs', 'analyze', 'script-info', 'opening-audit']);
  validModes.add('estimate-max');
  if (!validModes.has(args.mode)) {
    throw new Error(`Invalid mode: ${args.mode}`);
  }

  if (args.mode === 'play' && !args.token) {
    throw new Error('Missing required --token for play mode');
  }

  if (['summarize', 'simulate', 'tune', 'estimate-max', 'benchmark'].includes(args.mode) && !args.replay) {
    throw new Error(`--replay is required for mode=${args.mode}`);
  }

  if (args.mode === 'analyze' && !args.replay) {
    throw new Error('--replay is required for mode=analyze');
  }

  if (args.mode === 'script-info' && !args.script) {
    throw new Error('--script is required for mode=script-info');
  }
  if (args.mode === 'opening-audit' && (!args.script || !args.oracle || !args.replay)) {
    throw new Error('--script, --oracle, and --replay are required for mode=opening-audit');
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error(`Invalid --limit: ${args.limit}`);
  }
  if (!Number.isFinite(args.maxTick) || args.maxTick <= 0) {
    throw new Error(`Invalid --max-tick: ${args.maxTick}`);
  }

  return args;
}
