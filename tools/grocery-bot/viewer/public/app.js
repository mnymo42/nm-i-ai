const state = {
  runs: [],
  selectedRunPath: null,
  runData: null,
  currentTickIndex: 0,
  playing: false,
  timer: null,
  markers: null,
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
  summaryView: document.querySelector('#summary-view'),
  tickView: document.querySelector('#tick-view'),
  plannerView: document.querySelector('#planner-view'),
  ordersView: document.querySelector('#orders-view'),
  botsView: document.querySelector('#bots-view'),
  jumpButtons: [...document.querySelectorAll('[data-jump]')],
};

function formatJson(value) {
  return JSON.stringify(value, null, 2);
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
  elements.board.style.gridTemplateColumns = `repeat(${width}, 28px)`;

  const walls = new Set((layout.grid.walls || []).map(([x, y]) => `${x},${y}`));
  const drops = new Set((layout.drop_offs || []).map(([x, y]) => `${x},${y}`));
  // Emoji mapping based on CURRENT game specification (March 2026)
  // Current game item types from live replay: apples, eggs, flour, bananas, cheese, cream,
  // cereal, rice, pasta, oats, butter, bread, onions, milk, tomatoes, yogurt
  const ITEM_EMOJIS = {
    // Core items from current game (verified in replay data)
    apples: '🍎',     // plural form used in game
    eggs: '🥚',       // plural form used in game
    flour: '🌾',      // flour for baking
    bananas: '🍌',    // plural form used in game
    cheese: '🧀',     // cheese blocks
    cream: '🥛',      // heavy cream (different from milk)
    cereal: '🥣',     // breakfast cereal
    rice: '🍚',       // cooked rice
    pasta: '🍝',      // pasta noodles
    oats: '🌾',       // oat grains (using grain emoji)
    butter: '🧈',     // butter spread
    bread: '🍞',      // bread loaf  
    onions: '🧅',     // plural form used in game 
    milk: '🐮',       // milk carton
    tomatoes: '🍅',   // plural form used in game
    yogurt: '🍦',     // yogurt container
    
    // fallback for unknown types
    default: '🛒',
  };
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

  // Color palette for zones - softer, more distinct colors  
  const ZONE_COLORS = ['#ffcccb', '#add8e6', '#90ee90', '#ffffe0', '#dda0dd', '#f0e68c', '#afeeee', '#d3d3d3', '#ffb6c1', '#98fb98'];

  // Smart zone assignment based on store layout
  function getOptimalZone(x, y, width, height, numBots) {
    // Create zones based on store quadrants and sections
    const zonesPerRow = Math.ceil(Math.sqrt(numBots));
    const zonesPerCol = Math.ceil(numBots / zonesPerRow);
    
    const zoneWidth = Math.floor(width / zonesPerRow);
    const zoneHeight = Math.floor(height / zonesPerCol);
    
    const zoneX = Math.min(Math.floor(x / zoneWidth), zonesPerRow - 1);
    const zoneY = Math.min(Math.floor(y / zoneHeight), zonesPerCol - 1);
    
    return zoneY * zonesPerRow + zoneX;
  }

  // Smart road/conveyor belt system for optimal bot flow
  function getRoadDirection(x, y, width, height) {
    // Create main arteries and local roads
    const isMainArtery = (x % 6 === 0) || (y % 4 === 0);
    const isLocalRoad = (x % 3 === 1) || (y % 3 === 2);
    
    if (isMainArtery) {
      // Main arteries: create circular flow pattern
      if (x % 6 === 0 && y > 1 && y < height - 2) {
        // Vertical main roads - alternate direction
        return (x % 12 === 0) ? '⬇️' : '⬆️';
      }
      if (y % 4 === 0 && x > 1 && x < width - 2) {
        // Horizontal main roads - create flow toward drop-off
        return (y < height / 2) ? '➡️' : '⬅️';
      }
    } else if (isLocalRoad && !isMainArtery) {
      // Local feeder roads between shelf aisles
      if (x % 3 === 1) {
        // Vertical feeders
        return ((x + y) % 4 < 2) ? '⬆️' : '⬇️';
      }
      if (y % 3 === 2) {
        // Horizontal feeders
        return ((x + y) % 4 < 2) ? '➡️' : '⬅️';
      }
    }
    return '';
  }

  // Get bot assignments from planner or default
  const zoneByBot = (plannerMetrics && plannerMetrics.zoneAssignmentByBot) || {};
  const numBots = Object.keys(zoneByBot).length || snapshot?.bots?.length || 3;

  // --- Enhanced zone, road and item rendering ---
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${x},${y}`;
      const cell = document.createElement('div');
      cell.className = 'cell';
      
      // Intelligent zoning
      const zoneIdx = getOptimalZone(x, y, width, height, numBots);
      
      if (walls.has(key)) {
        cell.classList.add('wall');
        cell.style.background = '#444';
      } else {
        // Zone background with low opacity to not interfere with items
        cell.style.background = ZONE_COLORS[zoneIdx % ZONE_COLORS.length] + '20';
        if (drops.has(key)) {
          cell.classList.add('drop');
          cell.style.background = '#ffd700' + '60'; // Gold for drop-off areas
        }
      }

      // Smart road system for optimal traffic flow
      const roadArrow = getRoadDirection(x, y, width, height);
      if (roadArrow && !walls.has(key)) {
        const arrowEl = document.createElement('div');
        arrowEl.className = 'road-arrow';
        arrowEl.textContent = roadArrow;
        arrowEl.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 10px; opacity: 0.6; z-index: 1; pointer-events: none;';
        cell.appendChild(arrowEl);
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
        botEl.className = 'bot';
        botEl.textContent = bots.map((bot) => {
          const zone = (zoneByBot && typeof zoneByBot[bot.id] !== 'undefined') ? zoneByBot[bot.id] : bot.id;
          return `🤖${bot.id}`;
        }).join(' ');
        // Color bots by zone
        const zone = (zoneByBot && typeof zoneByBot[bots[0]?.id] !== 'undefined') ? zoneByBot[bots[0]?.id] : bots[0]?.id;
        botEl.style.background = ZONE_COLORS[zone % ZONE_COLORS.length];
        cell.appendChild(botEl);
        if (bots.length > 1) {
          const stackEl = document.createElement('div');
          stackEl.className = 'stack';
          stackEl.textContent = `x${bots.length}`;
          cell.appendChild(stackEl);
        }
      }

      elements.board.appendChild(cell);
    }
  }
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
  // Render order boxes with active/assigned bots
  const orders = tick.state_snapshot?.orders || [];
  const bots = tick.state_snapshot?.bots || [];
  const missionByBot = tick.planner_metrics?.missionTypeByBot || {};
  const zoneByBot = tick.planner_metrics?.zoneAssignmentByBot || {};
  elements.ordersView.innerHTML = orders.map((order) => {
    const isActive = order.status === 'active' && !order.complete;
    const assignedBots = bots.filter((bot) => missionByBot[bot.id]?.includes(order.id));
    const requiredItems = order.items_required || [];
    const deliveredItems = order.items_delivered || [];
    const progress = deliveredItems.length;
    const total = requiredItems.length;
    return `<div style="border:1px solid #888;padding:4px;margin-bottom:2px;background:${isActive ? '#fffde7' : '#ececec'}">
      <b>Order ${order.id}</b> ${isActive ? '🟢' : '⚪'} (${progress}/${total})<br>
      Required: ${requiredItems.map((it) => (ITEM_EMOJIS[it] || ITEM_EMOJIS.default)).join(' ')}<br>
      Delivered: ${deliveredItems.map((it) => (ITEM_EMOJIS[it] || ITEM_EMOJIS.default)).join(' ')}<br>
      Bots: ${assignedBots.map((b) => `🤖${b.id}`).join(' ')}
    </div>`;
  }).join('');
  // Render bots with zone and mission info
  elements.botsView.innerHTML = bots.map((bot) => {
    const zone = zoneByBot[bot.id] ?? bot.id;
    const color = ZONE_COLORS[zone % ZONE_COLORS.length];
    const mission = missionByBot[bot.id] || '';
    return `<div style="border-left:6px solid ${color};margin-bottom:2px;padding-left:4px;">
      🤖<b>${bot.id}</b> @ [${bot.position.join(',')}]<br>
      Inv: ${bot.inventory.map((it) => (ITEM_EMOJIS[it.type] || ITEM_EMOJIS.default)).join(' ')}<br>
      Zone: <span style="color:${color}">${zone}</span> | Mission: ${mission}
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

loadRuns().catch((error) => {
  elements.runHeader.textContent = `Failed to load runs: ${error.message}`;
});
