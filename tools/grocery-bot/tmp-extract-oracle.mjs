import fs from 'fs';

const replayDirs = fs.readdirSync('tools/grocery-bot/out')
  .filter(d => d.includes('expert-expert'))
  .sort();

const allOrders = new Map();
let layoutData = null;
let itemsData = null;

for (const dir of replayDirs) {
  const replayPath = `tools/grocery-bot/out/${dir}/replay.jsonl`;
  if (!fs.existsSync(replayPath)) continue;

  try {
    const lines = fs.readFileSync(replayPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const layout = JSON.parse(lines[0]);
    if (!layout.grid) continue;

    const firstTick = JSON.parse(lines[1]);
    if (!firstTick.state_snapshot) continue;

    if (!layoutData) {
      layoutData = layout;
      itemsData = firstTick.state_snapshot.items;
    }

    const ticks = lines.slice(1).map(l => JSON.parse(l)).filter(l => l.type === 'tick');
    for (const t of ticks) {
      for (const o of (t.state_snapshot.orders || [])) {
        if (!allOrders.has(o.id)) {
          allOrders.set(o.id, {
            id: o.id,
            items_required: o.items_required,
            first_seen_tick: t.tick,
          });
        }
      }
    }
    console.error(`  ${dir}: ${ticks.length} ticks, found ${allOrders.size} orders so far`);
  } catch (e) {
    console.error(`  ${dir}: SKIP (${e.message})`);
  }
}

const orders = [...allOrders.values()].sort((a, b) => {
  return parseInt(a.id.split('_')[1]) - parseInt(b.id.split('_')[1]);
});

const items = (itemsData || []).map(i => ({ id: i.id, type: i.type, position: i.position }));

const oracle = {
  map_seed: 7004,
  difficulty: 'expert',
  grid: { width: layoutData.grid.width, height: layoutData.grid.height },
  drop_off: layoutData.drop_off,
  bot_count: 10,
  known_orders: orders,
  items,
};

const outPath = 'tools/grocery-bot/config/oracle-expert.json';
fs.writeFileSync(outPath, JSON.stringify(oracle, null, 2));
console.error(`\nWrote ${outPath}: ${orders.length} orders`);
orders.forEach(o => console.error(`  ${o.id}: [${o.items_required.join(', ')}] (tick ${o.first_seen_tick})`));
