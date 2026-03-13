import {
  buildBotTooltipData,
  buildQueueEntries,
  buildTeamLegendEntries,
  getTeamVisual,
} from './view-model.mjs';

const state = {
  runs: [],
  selectedRunPath: null,
  runData: null,
  currentTickIndex: 0,
  playing: false,
  timer: null,
  markers: null,
  showZones: false,
  showRoads: false,
};

const elements = {
  difficultyFilter: document.querySelector('#difficulty-filter'),
  profileFilter: document.querySelector('#profile-filter'),
  refreshRuns: document.querySelector('#refresh-runs'),
  runList: document.querySelector('#run-list'),
  runHeader: document.querySelector('#run-header'),
  playToggle: document.querySelector('#play-toggle'),
  prevTick: document.querySelector('#prev-tick'),
  nextTick: document.querySelector('#next-tick'),
  tickSlider: document.querySelector('#tick-slider'),
  tickLabel: document.querySelector('#tick-label'),
  board: document.querySelector('#board'),
  queueView: document.querySelector('#queue-view'),
  teamLegendView: document.querySelector('#team-legend-view'),
  rotationView: document.querySelector('#rotation-view'),
  summaryView: document.querySelector('#summary-view'),
  tickView: document.querySelector('#tick-view'),
  plannerView: document.querySelector('#planner-view'),
  ordersView: document.querySelector('#orders-view'),
  botsView: document.querySelector('#bots-view'),
  jumpButtons: [...document.querySelectorAll('[data-jump]')],
  zoneToggle: document.querySelector('#zone-toggle'),
  roadsToggle: document.querySelector('#roads-toggle'),
};

// Shared constants (single definition)
const ITEM_EMOJIS = {
  apples: '🍎', eggs: '🥚', flour: '🌾', bananas: '🍌', cheese: '🧀', cream: '🥛',
  cereal: '🥣', rice: '🍚', pasta: '🍝', oats: '🌾', butter: '🧈', bread: '🍞',
  onions: '🧅', milk: '🐮', tomatoes: '🍅', yogurt: '🍦', default: '🛒',
};

const TASK_COLORS = {
  item: '#2a9d8f', pick_up: '#2a9d8f', pickup_active: '#2a9d8f', pickup_preview: '#457b9d',
  drop_off: '#e76f51', drop_active: '#e76f51',
  parking: '#6c757d', none: '#6c757d', single: '#2a9d8f',
  fallback: '#bc6c25', anti_deadlock: '#d62828', warehouse_fallback: '#d62828',
  idle_reposition: '#6c757d', reposition_zone: '#6c757d', queue_service_bay: '#457b9d',
  prefetch_item: '#457b9d', prefetch_position: '#6a4c93', prefetch_idle: '#6c757d',
  idle_parking: '#6c757d', forced_wait: '#d62828',
};

const TEAM_COLORS = [
  '#2a9d8f', '#e76f51', '#457b9d', '#bc6c25', '#6a4c93',
  '#26a65b', '#d62828', '#6495ed', '#ffa500', '#808000',
];

const DIR_ARROWS = { up: '↑', down: '↓', left: '←', right: '→' };

function buildDirectionalPreference(width, height, wallSet) {
  const pref = new Map();

  // Identify shelf wall columns: columns with >= 5 walls in y=2..8
  const shelfXs = [];
  for (let x = 0; x < width; x++) {
    let wallCount = 0;
    for (let y = 2; y <= 8; y++) {
      if (wallSet.has(`${x},${y}`)) wallCount++;
    }
    if (wallCount >= 5) shelfXs.push(x);
  }

  // Aisle lanes: left-half DOWN, right-half UP
  for (let i = 0; i < shelfXs.length - 1; i++) {
    const leftWall = shelfXs[i];
    const rightWall = shelfXs[i + 1];
    const aisleWidth = rightWall - leftWall - 1;
    if (aisleWidth < 2) continue;
    const mid = leftWall + 1 + Math.floor(aisleWidth / 2);
    for (let x = leftWall + 1; x < rightWall; x++) {
      for (let y = 0; y < height; y++) {
        const key = `${x},${y}`;
        if (wallSet.has(key)) continue;
        pref.set(key, x < mid ? 'down' : 'up');
      }
    }
  }

  // Horizontal corridors: top rows RIGHT, bottom rows LEFT
  for (let x = 0; x < width; x++) {
    for (const y of [0, 1]) {
      const key = `${x},${y}`;
      if (!wallSet.has(key)) pref.set(key, 'right');
    }
    for (const y of [height - 2, height - 1]) {
      const key = `${x},${y}`;
      if (!wallSet.has(key)) pref.set(key, 'left');
    }
  }

  return pref;
}

function lanePreferenceForLayout(layout) {
  const lanePref = layout?.laneMap?.directionalPreference || null;
  if (lanePref) {
    return new Map(Object.entries(lanePref));
  }

  const width = layout?.grid?.width || 0;
  const height = layout?.grid?.height || 0;
  const wallSet = new Set((layout?.grid?.walls || []).map(([x, y]) => `${x},${y}`));
  return buildDirectionalPreference(width, height, wallSet);
}

function laneRoadsForLayout(layout) {
  const oneWayRoads = layout?.laneMap?.oneWayRoads || null;
  if (oneWayRoads) {
    return new Map(
      Object.entries(oneWayRoads)
        .filter(([, dirs]) => Array.isArray(dirs) && dirs.length > 0)
        .map(([key, dirs]) => [key, dirs[0]]),
    );
  }

  return lanePreferenceForLayout(layout);
}

const ZONE_COLORS = [
  'rgba(42,157,143,0.18)',   // teal
  'rgba(231,111,81,0.18)',   // coral
  'rgba(69,123,157,0.18)',   // blue
  'rgba(188,108,37,0.18)',   // amber
  'rgba(106,76,147,0.18)',   // purple
  'rgba(38,166,91,0.18)',    // green
  'rgba(214,40,40,0.18)',    // red
  'rgba(100,149,237,0.18)',  // cornflower
  'rgba(255,165,0,0.18)',    // orange
  'rgba(128,128,0,0.18)',    // olive
];

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderShapeChip(label, detailOrTeamId, extraClass = '') {
  const detail = typeof detailOrTeamId === 'object'
    ? detailOrTeamId
    : { teamId: detailOrTeamId };
  const { teamColor, teamShape } = getTeamVisual(detail, TEAM_COLORS);
  const classes = ['team-shape-chip', `shape-${teamShape}`];
  if (extraClass) classes.push(extraClass);
  return `<span class="${classes.join(' ')}" style="background:${teamColor || TASK_COLORS.none}">${escapeHtml(label)}</span>`;
}

function renderItemEmojiList(items) {
  if (!items?.length) return '<span class="muted">unknown</span>';
  return items.map((item) => ITEM_EMOJIS[item] || ITEM_EMOJIS.default).join(' ');
}

function formatTooltipRow(row) {
  const inventory = row.inventory.length > 0 ? row.inventory.map((item) => ITEM_EMOJIS[item] || ITEM_EMOJIS.default).join(' ') : 'empty';
  const slot = row.slotIndex != null ? row.slotIndex : '-';
  const order = row.orderId ?? '-';
  const target = row.target ? `[${row.target.join(',')}]` : '-';
  return `<div class="bot-tooltip-row">
    <div><b>B${row.botId}</b> · T${row.teamId ?? '-'} · slot ${slot}</div>
    <div>Order: ${escapeHtml(order)}</div>
    <div>Task: ${escapeHtml(row.taskType)}</div>
    <div>Inv: ${inventory}</div>
    <div>Target: ${escapeHtml(target)}</div>
  </div>`;
}

function renderTeamLegend(plannerMetrics) {
  const legendEntries = buildTeamLegendEntries(plannerMetrics);
  if (legendEntries.length === 0) {
    elements.teamLegendView.innerHTML = '<div class="muted">No team assignments on this tick.</div>';
    return;
  }

  elements.teamLegendView.innerHTML = legendEntries.map((entry) => {
    return `<div class="team-legend-chip${entry.isFront ? ' front-team' : ''}">
      ${renderShapeChip(`T${entry.teamId}`, entry.teamId)}
      <span>slot ${entry.slotIndex ?? '-'}</span>
      <span>ord ${escapeHtml(entry.orderId ?? '-')}</span>
      <span>${entry.botCount} bots</span>
    </div>`;
  }).join('');
}

function renderQueuePanel(snapshotOrders, plannerMetrics) {
  const queueEntries = buildQueueEntries(snapshotOrders, plannerMetrics);
  const rotationBits = [];
  if (plannerMetrics?.rotatedThisTick) rotationBits.push('rotated now');
  if (plannerMetrics?.lastRotationTick != null) rotationBits.push(`last rotation ${plannerMetrics.lastRotationTick}`);
  elements.rotationView.textContent = rotationBits.join(' · ');

  if (queueEntries.length === 0) {
    elements.queueView.innerHTML = '<div class="muted">No queued orders for this tick.</div>';
    return;
  }

  elements.queueView.innerHTML = queueEntries.map((entry) => {
    const cardClasses = ['queue-card'];
    if (entry.isFront) cardClasses.push('front-slot');
    else if (entry.teamId != null) cardClasses.push('future-slot');
    else cardClasses.push('unassigned-slot');
    const progress = `${entry.deliveredItems.length}/${entry.requiredItems.length || '?'}`;
    const status = entry.complete ? 'completed' : entry.status;
    const botBadges = entry.botIds.map((botId) => {
      const detail = { teamId: entry.teamId };
      return `<span class="queue-pill" style="background:${TEAM_COLORS[(entry.teamId ?? 0) % TEAM_COLORS.length]}">${renderShapeChip(`${botId}`, detail, 'queue-bot-shape')} B${botId}</span>`;
    }).join('');
    const teamLabel = entry.teamId != null ? `Team ${entry.teamId}` : 'Unassigned';
    return `<div class="${cardClasses.join(' ')}">
      <div class="queue-card-header">
        <div>
          <b>Slot ${entry.slotIndex ?? '•'}</b> · Order ${escapeHtml(entry.orderId)}
        </div>
        <div class="queue-status">${escapeHtml(status)}</div>
      </div>
      <div class="order-progress">${progress} · ${entry.isVisible ? 'visible' : 'planner-only'}</div>
      <div>Need: ${renderItemEmojiList(entry.requiredItems)}</div>
      <div>Done: ${renderItemEmojiList(entry.deliveredItems)}</div>
      <div class="queue-meta">
        <span class="queue-pill" style="background:${entry.teamId != null ? TEAM_COLORS[entry.teamId % TEAM_COLORS.length] : TASK_COLORS.none}">
          ${entry.teamId != null ? renderShapeChip(`T${entry.teamId}`, entry.teamId, 'queue-team-shape') : '·'} ${escapeHtml(teamLabel)}
        </span>
        ${entry.botIds.length > 0 ? `<div class="queue-bots">${botBadges}</div>` : '<span class="muted">No assigned bots</span>'}
      </div>
    </div>`;
  }).join('');
}

function stopPlayback() {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
  state.playing = false;
  elements.playToggle.textContent = 'Play';
}

function buildMarkers(runData) {
  const ticks = runData?.ticks || [];
  const markers = {
    score: [],
    pickup: [],
    override: [],
    mode: [],
    stagnation: (runData?.analysis?.stagnationWindows || []).map((window) => window.startTick),
  };

  let previousScore = null;
  let previousMode = null;
  for (const tick of ticks) {
    const score = tick.state_snapshot?.score ?? 0;
    const mode = tick.planner_metrics?.controlMode ?? null;
    if (previousScore !== null && score > previousScore) {
      markers.score.push(tick.tick);
    }
    if ((tick.pickup_result || []).some((result) => result.succeeded === false)) {
      markers.pickup.push(tick.tick);
    }
    if ((tick.sanitizer_overrides || []).length > 0) {
      markers.override.push(tick.tick);
    }
    if (previousMode !== null && mode && mode !== previousMode) {
      markers.mode.push(tick.tick);
    }

    previousScore = score;
    if (mode) {
      previousMode = mode;
    }
  }

  return markers;
}

function findNextMarker(type) {
  const values = state.markers?.[type] || [];
  return values.find((tick) => tick > state.currentTickIndex) ?? values[0] ?? null;
}

function renderBoard(snapshot, layout, plannerMetrics) {
  elements.board.innerHTML = '';
  if (!layout?.grid) {
    return;
  }

  const width = layout.grid.width;
  const height = layout.grid.height;
  elements.board.style.gridTemplateColumns = `repeat(${width}, 36px)`;

  const walls = new Set((layout.grid.walls || []).map(([x, y]) => `${x},${y}`));
  const drops = new Set((layout.drop_offs || []).map(([x, y]) => `${x},${y}`));

  // Zone assignment overlay data
  const zoneAssignment = plannerMetrics?.zoneAssignment || null;
  const itemsByCell = new Map();
  for (const item of snapshot?.items || []) {
    itemsByCell.set(`${item.position[0]},${item.position[1]}`, item);
  }

  const botsByCell = new Map();
  for (const bot of snapshot?.bots || []) {
    const key = `${bot.position[0]},${bot.position[1]}`;
    const entry = botsByCell.get(key) || [];
    entry.push(bot);
    botsByCell.set(key, entry);
  }

  const botDetails = (plannerMetrics && plannerMetrics.botDetails) || {};

  // Cell size constant (must match CSS .cell width/height)
  const CELL_SIZE = 37; // 36px + 1px gap

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${x},${y}`;
      const cell = document.createElement('div');
      cell.className = 'cell';

      if (walls.has(key)) {
        cell.classList.add('wall');
      } else if (drops.has(key)) {
        cell.classList.add('drop');
      }

      // Zone overlay: color cells by zone assignment
      if (state.showZones && zoneAssignment && !walls.has(key)) {
        const zoneCount = Math.max(1, ...Object.values(zoneAssignment).map(v => v + 1));
        const zoneWidth = Math.ceil(width / zoneCount);
        const zoneIndex = Math.min(Math.floor(x / zoneWidth), zoneCount - 1);
        cell.style.background = ZONE_COLORS[zoneIndex % ZONE_COLORS.length];
      }

      const item = itemsByCell.get(key);
      if (item) {
        const typeKey = (item.type || '').toLowerCase();
        const emoji = ITEM_EMOJIS[typeKey] || ITEM_EMOJIS.default;
        const itemEl = document.createElement('div');
        itemEl.className = 'item';
        itemEl.textContent = emoji;
        cell.appendChild(itemEl);
      }

      const bots = botsByCell.get(key) || [];
      if (bots.length > 0) {
        const botEl = document.createElement('div');
        const firstBotDetail = botDetails[bots[0]?.id] || {};
        const { teamColor, teamShape } = getTeamVisual(firstBotDetail, TEAM_COLORS);
        botEl.className = `bot shape-${teamShape}`;
        const taskType = firstBotDetail?.taskType || 'none';
        botEl.style.background = teamColor || TASK_COLORS[taskType] || TASK_COLORS.none;
        botEl.innerHTML = `<span class="bot-label">${escapeHtml(bots.map((bot) => `${bot.id}`).join(' '))}</span>`;
        cell.appendChild(botEl);
        if (bots.length > 1) {
          const stackEl = document.createElement('div');
          stackEl.className = 'stack';
          stackEl.textContent = `x${bots.length}`;
          cell.appendChild(stackEl);
        }

        const tooltipRows = buildBotTooltipData(bots, botDetails).map(formatTooltipRow).join('');
        const tooltip = document.createElement('div');
        tooltip.className = 'bot-tooltip';
        tooltip.innerHTML = tooltipRows;
        cell.appendChild(tooltip);
      }

      elements.board.appendChild(cell);
    }
  }

  // SVG overlay for bot target lines and paths
  const svgWidth = width * CELL_SIZE;
  const svgHeight = height * CELL_SIZE;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', svgWidth);
  svg.setAttribute('height', svgHeight);
  svg.style.cssText = `position:absolute;top:8px;left:8px;pointer-events:none;z-index:10;`;

  for (const bot of snapshot?.bots || []) {
    const detail = botDetails[bot.id];
    if (!detail) continue;
    const color = TASK_COLORS[detail.taskType] || TASK_COLORS.none;
    const bx = bot.position[0] * CELL_SIZE + CELL_SIZE / 2;
    const by = bot.position[1] * CELL_SIZE + CELL_SIZE / 2;

    // Draw planned path as dotted line
    if (detail.path && detail.path.length > 1) {
      const points = detail.path.map((p) => `${p[0] * CELL_SIZE + CELL_SIZE / 2},${p[1] * CELL_SIZE + CELL_SIZE / 2}`).join(' ');
      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('points', points);
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', color);
      polyline.setAttribute('stroke-width', '2');
      polyline.setAttribute('stroke-dasharray', '4,3');
      polyline.setAttribute('opacity', '0.6');
      svg.appendChild(polyline);
    }

    // Draw target indicator (circle at target)
    if (detail.target) {
      const tx = detail.target[0] * CELL_SIZE + CELL_SIZE / 2;
      const ty = detail.target[1] * CELL_SIZE + CELL_SIZE / 2;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', tx);
      circle.setAttribute('cy', ty);
      circle.setAttribute('r', '5');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('opacity', '0.8');
      svg.appendChild(circle);

      // Direct line from bot to target (if no path)
      if (!detail.path || detail.path.length <= 1) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', bx);
        line.setAttribute('y1', by);
        line.setAttribute('x2', tx);
        line.setAttribute('y2', ty);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '6,4');
        line.setAttribute('opacity', '0.4');
        svg.appendChild(line);
      }
    }

    // Bot ID label at bot position
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', bx);
    label.setAttribute('y', by - 10);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', color);
    label.setAttribute('font-weight', 'bold');
    label.textContent = `B${bot.id}`;
    svg.appendChild(label);
  }

  // Roads overlay: show directional preference lanes as arrows
  if (state.showRoads) {
    const laneRoads = laneRoadsForLayout(layout);
    for (const [key, dir] of laneRoads) {
      const [cx, cy] = key.split(',').map(Number);
      if (walls.has(key) || drops.has(key) || itemsByCell.has(key)) continue;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', cx * CELL_SIZE + CELL_SIZE / 2);
      label.setAttribute('y', cy * CELL_SIZE + CELL_SIZE / 2 + 1);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('fill', 'rgba(42,157,143,0.35)');
      label.setAttribute('font-size', '14');
      label.setAttribute('font-weight', '700');
      label.setAttribute('pointer-events', 'none');
      label.textContent = DIR_ARROWS[dir];
      svg.appendChild(label);
    }
  }

  elements.board.appendChild(svg);
}

function renderTick() {
  const ticks = state.runData?.ticks || [];
  const tick = ticks[state.currentTickIndex];
  if (!tick) {
    return;
  }

  elements.tickSlider.value = String(state.currentTickIndex);
  elements.tickLabel.textContent = `${tick.tick} / ${ticks.at(-1)?.tick ?? 0}`;
  elements.runHeader.textContent = `${state.runData.run.runId} | ${state.runData.summary.finalScore ?? '?'} pts`;

  renderBoard(tick.state_snapshot, state.runData.layout, tick.planner_metrics || {});
  renderTeamLegend(tick.planner_metrics || {});
  renderQueuePanel(tick.state_snapshot?.orders || [], tick.planner_metrics || {});

  elements.summaryView.textContent = formatJson({
    difficulty: state.runData.summary.difficulty ?? state.runData.run.difficulty,
    profile: state.runData.summary.profile ?? state.runData.run.profile,
    finalScore: state.runData.summary.finalScore,
    ordersCompleted: state.runData.summary.finalOrders ?? state.runData.summary.metrics?.ordersCompleted,
    itemsDelivered: state.runData.summary.finalItems ?? state.runData.summary.metrics?.itemsDelivered,
    waits: state.runData.analysis?.actionEfficiency?.waitActions ?? null,
    stalls: state.runData.analysis?.multiBotCoordination?.totalStalls ?? null,
  });
  elements.tickView.textContent = formatJson({
    tick: tick.tick,
    score: tick.state_snapshot?.score,
    actions: tick.actions_sent,
    failedPickups: tick.pickup_result?.filter((result) => result.succeeded === false) || [],
    overrides: tick.sanitizer_overrides || [],
  });
  elements.plannerView.textContent = formatJson(tick.planner_metrics || {});

  // Render orders grouped by status with bot assignment badges
  const orders = tick.state_snapshot?.orders || [];
  const bots = tick.state_snapshot?.bots || [];
  const botDetailsMap = tick.planner_metrics?.botDetails || {};

  // Group orders: active, upcoming (preview), completed
  const activeOrders = orders.filter(o => o.status === 'active' && !o.complete);
  const upcomingOrders = orders.filter(o => o.status === 'preview' || (o.status !== 'active' && !o.complete));
  const completedOrders = orders.filter(o => o.complete);

  function renderOrderCard(order, cssClass) {
    const requiredItems = order.items_required || [];
    const deliveredItems = order.items_delivered || [];
    const progress = deliveredItems.length;
    const total = requiredItems.length;
    const statusLabel = order.complete ? 'done' : order.status;
    return `<div class="order-card ${cssClass}">
      <div class="order-card-header">
        <b>Order ${order.id}</b>
        <span class="queue-status">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="order-progress">${progress}/${total}</div>
      Required: ${requiredItems.map(it => ITEM_EMOJIS[it] || ITEM_EMOJIS.default).join(' ')}<br>
      Delivered: ${deliveredItems.map(it => ITEM_EMOJIS[it] || ITEM_EMOJIS.default).join(' ')}
    </div>`;
  }

  let ordersHtml = '';
  if (activeOrders.length > 0) {
    ordersHtml += `<div class="order-group-label">Active</div>`;
    ordersHtml += activeOrders.map(o => renderOrderCard(o, 'active')).join('');
  }
  if (upcomingOrders.length > 0) {
    ordersHtml += `<div class="order-group-label">Upcoming</div>`;
    ordersHtml += upcomingOrders.map(o => renderOrderCard(o, 'upcoming')).join('');
  }
  if (completedOrders.length > 0) {
    ordersHtml += `<div class="order-group-label">Completed</div>`;
    ordersHtml += completedOrders.map(o => renderOrderCard(o, 'completed')).join('');
  }
  elements.ordersView.innerHTML = ordersHtml;
  // Render bots with task type, target, team, and order assignment
  elements.botsView.innerHTML = bots.map((bot) => {
    const detail = botDetailsMap[bot.id] || {};
    const taskType = detail.taskType || 'none';
    const color = TASK_COLORS[taskType] || TASK_COLORS.none;
    const targetStr = detail.target ? `[${detail.target.join(',')}]` : '-';
    const stallStr = detail.stallCount > 0 ? ` stall:${detail.stallCount}` : '';
    const orderStr = detail.orderId != null ? ` ord:${detail.orderId}` : '';
    const teamStr = detail.teamRole
      ? ` [${detail.teamRole}${detail.teamId != null ? ` T${detail.teamId}` : ''} slot:${detail.slotIndex ?? '-'}]`
      : '';
    const { teamColor } = getTeamVisual(detail, TEAM_COLORS);
    const borderColor = teamColor || color;
    return `<div class="bot-row" style="border-left-color:${borderColor}">
      <div class="bot-row-header">
        ${detail.teamId != null ? renderShapeChip(`T${detail.teamId}`, detail) : ''}
        <b>B${bot.id}</b> @ [${bot.position.join(',')}]${teamStr}
      </div>
      Inv: ${bot.inventory.map((it) => (ITEM_EMOJIS[it.type || it] || ITEM_EMOJIS.default)).join(' ')}<br>
      Task: <span style="color:${color};font-weight:bold">${taskType}</span> → ${targetStr}${stallStr}${orderStr}
    </div>`;
  }).join('');
}

async function loadRuns() {
  const params = new URLSearchParams();
  if (elements.difficultyFilter.value) {
    params.set('difficulty', elements.difficultyFilter.value);
  }
  if (elements.profileFilter.value.trim()) {
    params.set('profile', elements.profileFilter.value.trim());
  }

  const response = await fetch(`/api/runs?${params.toString()}`);
  const payload = await response.json();
  state.runs = payload.runs || [];
  renderRunList();
}

function renderRunList() {
  elements.runList.innerHTML = '';
  for (const run of state.runs) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `run-card${state.selectedRunPath === run.relativePath ? ' active' : ''}`;
    card.innerHTML = `
      <strong>${run.runId}</strong>
      <div>${run.difficulty || 'unknown'} | ${run.profile || 'unknown'}</div>
      <div>score ${run.finalScore ?? '?'} | orders ${run.finalOrders ?? '?'} | items ${run.finalItems ?? '?'}</div>
      <div>stalls ${run.totalStalls ?? '?'} | updated ${run.modifiedAt}</div>
    `;
    card.addEventListener('click', () => openRun(run.relativePath));
    elements.runList.appendChild(card);
  }
}

async function openRun(relativePath) {
  stopPlayback();
  state.selectedRunPath = relativePath;
  const response = await fetch(`/api/run?path=${encodeURIComponent(relativePath)}`);
  const payload = await response.json();
  state.runData = payload;
  state.currentTickIndex = 0;
  state.markers = buildMarkers(payload);

  const tickCount = payload.ticks.length;
  elements.playToggle.disabled = tickCount === 0;
  elements.prevTick.disabled = tickCount === 0;
  elements.nextTick.disabled = tickCount === 0;
  elements.tickSlider.disabled = tickCount === 0;
  elements.tickSlider.max = String(Math.max(0, tickCount - 1));
  renderRunList();
  renderTick();
}

function stepTick(delta) {
  const ticks = state.runData?.ticks || [];
  if (ticks.length === 0) {
    return;
  }

  state.currentTickIndex = Math.max(0, Math.min(ticks.length - 1, state.currentTickIndex + delta));
  renderTick();
}

function togglePlayback() {
  if (!state.runData?.ticks?.length) {
    return;
  }

  if (state.playing) {
    stopPlayback();
    return;
  }

  state.playing = true;
  elements.playToggle.textContent = 'Pause';
  state.timer = window.setInterval(() => {
    if (state.currentTickIndex >= state.runData.ticks.length - 1) {
      stopPlayback();
      return;
    }
    stepTick(1);
  }, 200);
}

elements.refreshRuns.addEventListener('click', () => loadRuns());
elements.playToggle.addEventListener('click', () => togglePlayback());
elements.prevTick.addEventListener('click', () => {
  stopPlayback();
  stepTick(-1);
});
elements.nextTick.addEventListener('click', () => {
  stopPlayback();
  stepTick(1);
});
elements.tickSlider.addEventListener('input', (event) => {
  stopPlayback();
  state.currentTickIndex = Number(event.target.value);
  renderTick();
});
for (const button of elements.jumpButtons) {
  button.addEventListener('click', () => {
    stopPlayback();
    const next = findNextMarker(button.dataset.jump);
    if (next !== null) {
      state.currentTickIndex = next;
      renderTick();
    }
  });
}

elements.zoneToggle.addEventListener('change', (e) => {
  state.showZones = e.target.checked;
  renderTick();
});
elements.roadsToggle.addEventListener('change', (e) => {
  state.showRoads = e.target.checked;
  renderTick();
});

// Debug panel toggle
const debugToggle = document.querySelector('#debug-toggle');
const debugContent = document.querySelector('#debug-content');
if (debugToggle && debugContent) {
  debugToggle.addEventListener('click', () => {
    const hidden = debugContent.hidden;
    debugContent.hidden = !hidden;
    debugToggle.textContent = hidden ? 'Hide debug details' : 'Show debug details';
  });
}

loadRuns().catch((error) => {
  elements.runHeader.textContent = `Failed to load runs: ${error.message}`;
});
