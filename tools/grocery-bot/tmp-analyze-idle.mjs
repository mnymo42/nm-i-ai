import fs from 'fs';
const lines = fs.readFileSync('tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl','utf8').split('\n').filter(Boolean);

let windowWaits = 0;
let windowMoves = 0;
let windowPickups = 0;
let windowDrops = 0;

for (const line of lines) {
  const row = JSON.parse(line);
  if (row.type !== 'tick') continue;
  const actions = row.actions_sent || [];
  for (const a of actions) {
    if (a.action === 'wait') windowWaits++;
    else if (a.action.startsWith('move_')) windowMoves++;
    else if (a.action === 'pick_up') windowPickups++;
    else if (a.action === 'drop_off') windowDrops++;
  }
  if (row.tick % 50 === 49 || row.tick === 299) {
    const start = row.tick - (row.tick % 50);
    const total = (row.tick % 50 + 1) * 10;
    console.log(`tick ${String(start).padStart(3)}-${String(row.tick).padStart(3)}: ${String(windowWaits).padStart(3)} waits, ${String(windowMoves).padStart(3)} moves, ${String(windowPickups).padStart(2)} picks, ${String(windowDrops).padStart(2)} drops  (${Math.round(windowWaits/total*100)}% idle)`);
    windowWaits = windowMoves = windowPickups = windowDrops = 0;
  }
}
