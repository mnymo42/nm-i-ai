import fs from 'fs';
const lines = fs.readFileSync('tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl','utf8').split('\n').filter(Boolean);

let lastScore = 0;
let lastActiveId = null;
let orderStartTick = 0;

for (const line of lines) {
  const row = JSON.parse(line);
  if (row.type !== 'tick') continue;
  const score = row.state_snapshot?.score ?? 0;
  const orders = row.state_snapshot?.orders || [];
  const active = orders.find(o => o.status === 'active');
  const preview = orders.find(o => o.status === 'preview');

  if (active?.id !== lastActiveId) {
    if (lastActiveId) {
      console.log(`  completed at tick ${row.tick} (took ${row.tick - orderStartTick} ticks)`);
    }
    if (active) {
      const remaining = (active.items_required || []).length - (active.items_delivered || []).length;
      console.log(`tick ${String(row.tick).padStart(3)}: active=${active.id} needs ${active.items_required.length} items (${remaining} remaining)` +
        (preview ? `, preview=${preview.id}` : ''));
    }
    lastActiveId = active?.id;
    orderStartTick = row.tick;
  }

  if (score > lastScore) {
    const delta = score - lastScore;
    const delivered = active?.items_delivered?.length ?? 0;
    const required = active?.items_required?.length ?? 0;
    console.log(`  tick ${row.tick}: score +${delta} (total ${score}), delivered ${delivered}/${required}`);
    lastScore = score;
  }
}
console.log(`\nFinal score: ${lastScore} at tick 299`);

// Also count total pickups and unique item types picked
let totalPicks = 0;
const pickedItems = new Set();
for (const line of lines) {
  const row = JSON.parse(line);
  if (row.type !== 'tick') continue;
  for (const a of (row.actions_sent || [])) {
    if (a.action === 'pick_up') {
      totalPicks++;
      pickedItems.add(a.item_id);
    }
  }
}
console.log(`\nTotal pick_up actions: ${totalPicks}, unique items: ${pickedItems.size}`);
