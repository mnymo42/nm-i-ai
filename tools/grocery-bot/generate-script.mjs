#!/usr/bin/env node
/**
 * Extract an action script from a replay file.
 *
 * Takes a replay.jsonl and outputs a script.json that the planner can replay
 * verbatim in future games. This captures the exact actions that worked in a
 * previous run so they can be replayed deterministically.
 *
 * Usage:
 *   node tools/grocery-bot/generate-script.mjs \
 *     --replay tools/grocery-bot/out/<run-id>/replay.jsonl \
 *     --out tools/grocery-bot/config/script-expert.json \
 *     [--until-tick 150]   # only script up to tick N (rest handled by live planner)
 */

import fs from 'fs';

function parseArgs() {
  const args = { replay: null, out: null, untilTick: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--replay') args.replay = argv[++i];
    if (argv[i] === '--out') args.out = argv[++i];
    if (argv[i] === '--until-tick') args.untilTick = Number(argv[++i]);
  }
  if (!args.replay) throw new Error('--replay required');
  if (!args.out) throw new Error('--out required');
  return args;
}

function main() {
  const args = parseArgs();
  const lines = fs.readFileSync(args.replay, 'utf8').split('\n').filter(Boolean);

  const ticks = [];
  let lastScore = 0;
  let ordersCompleted = 0;

  for (const line of lines) {
    const row = JSON.parse(line);
    if (row.type !== 'tick') continue;

    const tick = row.tick;
    if (args.untilTick !== null && tick > args.untilTick) break;

    const actions = row.actions_sent || [];
    const score = row.state_snapshot?.score ?? lastScore;
    const scoreDelta = score - lastScore;

    if (scoreDelta > 0) {
      const prevActive = row.state_snapshot?.orders?.find(o => o.status === 'active');
      if (scoreDelta >= 5) ordersCompleted++;
    }

    ticks.push({
      tick,
      actions: actions.map(a => {
        const entry = { bot: a.bot, action: a.action };
        if (a.item_id !== undefined) entry.item_id = a.item_id;
        return entry;
      }),
    });

    lastScore = score;
  }

  const output = {
    description: 'Action script extracted from replay',
    source_replay: args.replay,
    generated_at: new Date().toISOString(),
    last_scripted_tick: ticks.length > 0 ? ticks[ticks.length - 1].tick : -1,
    total_ticks: ticks.length,
    final_score_at_cutoff: lastScore,
    ticks,
  };

  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.error(`Script written to ${args.out}`);
  console.error(`  Ticks: ${ticks.length} (0-${output.last_scripted_tick})`);
  console.error(`  Score at cutoff: ${lastScore}`);
}

main();
