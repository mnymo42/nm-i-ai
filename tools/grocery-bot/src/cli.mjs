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
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key.startsWith('--')) {
      continue;
    }

    if (['--token', '--difficulty', '--profile', '--out-dir', '--config', '--mode', '--replay', '--seeds'].includes(key)) {
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
      default:
        break;
    }
  }

  return args;
}

export function parseCliArguments(argv) {
  const args = parseArgs(argv);

  const validDifficulties = new Set(['easy', 'medium', 'hard', 'expert', 'nightmare']);
  if (!validDifficulties.has(args.difficulty)) {
    throw new Error(`Invalid difficulty: ${args.difficulty}`);
  }

  const validModes = new Set(['play', 'summarize', 'simulate', 'tune', 'benchmark']);
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

  return args;
}
