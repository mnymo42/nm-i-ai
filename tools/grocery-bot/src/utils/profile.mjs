import fs from 'node:fs';

export const defaultProfiles = {
  easy: {
    assignment: {
      travel_to_item: 1.0,
      travel_item_to_dropoff: 0.7,
      congestion_penalty: 0.15,
      contention_penalty: 0.1,
      urgency_bonus: 0.3,
      remaining_demand_priority: 1.0,
      preview_item_weight: 0.2,
    },
    routing: {
      horizon: 12,
      hold_goal_steps: 3,
    },
    anti_deadlock: {
      stall_threshold: 2,
      forced_wait_rounds: 1,
    },
    phase_switch: {
      endgame_round_ratio: 0.82,
      hard_cutoff_round_ratio: 0.93,
    },
    recovery: {
      no_progress_rounds: 15,
      mid_no_progress_rounds: 10,
      late_no_progress_rounds: 6,
      late_rounds_window: 60,
      burst_rounds: 8,
      partial_drop_no_progress_rounds: 24,
      loop_break_rounds: 5,
    },
    runtime: {
      nudge_invalid_only: true,
      nudge_planned_waits: false,
      max_consecutive_pick_failures_before_forbid: 2,
      approach_forbid_ttl: 40,
      pick_failure_spiral_window: 10,
      pick_failure_spiral_threshold: 3,
      target_lock_stall_rounds: 12,
      target_lock_forbid_ttl: 30,
      order_stall_bailout_rounds: 20,
    },
  },
  medium: {
    assignment: {
      travel_to_item: 1.0,
      travel_item_to_dropoff: 0.8,
      congestion_penalty: 0.28,
      contention_penalty: 0.2,
      urgency_bonus: 0.35,
      remaining_demand_priority: 1.2,
      preview_item_weight: 0.25,
      preview_mission_concurrency: 1,
      active_cross_zone_penalty: 0.3,
      preview_cross_zone_penalty: 1.6,
    },
    routing: {
      horizon: 16,
      hold_goal_steps: 4,
    },
    anti_deadlock: {
      stall_threshold: 2,
      forced_wait_rounds: 1,
    },
    phase_switch: {
      endgame_round_ratio: 0.8,
      hard_cutoff_round_ratio: 0.92,
    },
    recovery: {
      no_progress_rounds: 18,
      mid_no_progress_rounds: 12,
      late_no_progress_rounds: 7,
      late_rounds_window: 60,
      burst_rounds: 8,
      partial_drop_no_progress_rounds: 28,
      loop_break_rounds: 6,
    },
    runtime: {
      multi_bot_strategy: 'assignment_v1',
      nudge_invalid_only: true,
      nudge_planned_waits: false,
      max_consecutive_pick_failures_before_forbid: 2,
      approach_forbid_ttl: 40,
      pick_failure_spiral_window: 10,
      pick_failure_spiral_threshold: 3,
      target_lock_stall_rounds: 12,
      target_lock_forbid_ttl: 30,
      order_stall_bailout_rounds: 20,
      mission_ttl_rounds: 6,
      mission_stall_rounds: 4,
      no_path_reassign_rounds: 2,
      endgame_preview_disable_rounds: 40,
      endgame_disable_preview_rounds: 40,
      drop_commit_min_deliverable: 2,
      preview_wip_cap_items: 2,
      preview_runner_cap: 1,
      close_active_eta_threshold: 9,
      close_active_remaining_threshold: 2,
      service_bay_queue_depth: 1,
    },
  },
  hard: {
    assignment: {
      travel_to_item: 1.0,
      travel_item_to_dropoff: 1.3,
      congestion_penalty: 0.4,
      contention_penalty: 0.35,
      urgency_bonus: 0.5,
      remaining_demand_priority: 1.25,
      preview_item_weight: 0.3,
    },
    routing: {
      horizon: 35,
      hold_goal_steps: 5,
    },
    anti_deadlock: {
      stall_threshold: 2,
      forced_wait_rounds: 2,
    },
    phase_switch: {
      endgame_round_ratio: 0.78,
      hard_cutoff_round_ratio: 0.9,
    },
    recovery: {
      no_progress_rounds: 20,
      mid_no_progress_rounds: 14,
      late_no_progress_rounds: 8,
      late_rounds_window: 60,
      burst_rounds: 10,
      partial_drop_no_progress_rounds: 30,
      loop_break_rounds: 6,
    },
    runtime: {
      multi_bot_strategy: 'assignment_v1',
      nudge_invalid_only: true,
      nudge_planned_waits: false,
      max_consecutive_pick_failures_before_forbid: 2,
      approach_forbid_ttl: 40,
      pick_failure_spiral_window: 10,
      pick_failure_spiral_threshold: 3,
      target_lock_stall_rounds: 12,
      target_lock_forbid_ttl: 30,
      order_stall_bailout_rounds: 20,
      mission_ttl_rounds: 8,
      mission_stall_rounds: 5,
      no_path_reassign_rounds: 2,
      endgame_disable_preview_rounds: 45,
      preview_wip_cap_items: 2,
      preview_runner_cap: 1,
      active_mission_buffer: 1,
      active_runner_cap: 2,
      close_active_eta_threshold: 12,
      close_active_remaining_threshold: 2,
      service_bay_queue_depth: 2,
    },
  },
  expert: {
    teams: {
      prefetch_enable_remaining_threshold: 2,
      prefetch_require_active_coverage: true,
      wave_order_count: 3,
      prefetch_lookahead_ticks: 80,
      opener_breakout_ticks: 8,
      opener_breakout_active_cap: 3,
      zone_count: 3,
      zone_strategy: 'x_bands',
      active_cross_zone_cap: 2,
    },
    opener: {
      enabled: true,
      max_ticks: 20,
      release_mode: 'sequential_compact',
    },
    assignment: {
      travel_to_item: 1.0,
      travel_item_to_dropoff: 1.5,
      congestion_penalty: 0.55,
      contention_penalty: 0.5,
      urgency_bonus: 0.7,
      remaining_demand_priority: 1.3,
      preview_item_weight: 0.35,
    },
    routing: {
      horizon: 45,
      hold_goal_steps: 6,
      lane_map_version: 'v4',
      lane_map_handoff_relax_ticks: 24,
    },
    anti_deadlock: {
      stall_threshold: 2,
      forced_wait_rounds: 2,
    },
    phase_switch: {
      endgame_round_ratio: 0.75,
      hard_cutoff_round_ratio: 0.88,
    },
    recovery: {
      no_progress_rounds: 20,
      mid_no_progress_rounds: 14,
      late_no_progress_rounds: 8,
      late_rounds_window: 60,
      burst_rounds: 10,
      partial_drop_no_progress_rounds: 30,
      loop_break_rounds: 6,
    },
    runtime: {
      multi_bot_strategy: 'assignment_v1',
      nudge_invalid_only: true,
      nudge_planned_waits: false,
      max_consecutive_pick_failures_before_forbid: 2,
      approach_forbid_ttl: 40,
      pick_failure_spiral_window: 10,
      pick_failure_spiral_threshold: 3,
      target_lock_stall_rounds: 12,
      target_lock_forbid_ttl: 30,
      order_stall_bailout_rounds: 20,
      mission_ttl_rounds: 8,
      mission_stall_rounds: 5,
      no_path_reassign_rounds: 2,
      endgame_disable_preview_rounds: 60,
      preview_wip_cap_items: 2,
      preview_runner_cap: 1,
      active_mission_buffer: 2,
      active_runner_cap: 3,
      close_mode_active_runner_cap: 5,
      close_active_eta_threshold: 16,
      close_active_remaining_threshold: 3,
      service_bay_queue_depth: 2,
      allow_pickup_queue_in_close_mode: false,
    },
  },
};

// Team strategy for expert
defaultProfiles.expert.runtime.multi_bot_strategy = 'team_v1';

defaultProfiles.expert_assignment_v1 = JSON.parse(JSON.stringify(defaultProfiles.expert));
defaultProfiles.expert_assignment_v1.runtime.multi_bot_strategy = 'assignment_v1';

defaultProfiles.nightmare = JSON.parse(JSON.stringify(defaultProfiles.expert));
defaultProfiles.nightmare.runtime.multi_bot_strategy = 'warehouse_v1';
defaultProfiles.nightmare.runtime.endgame_disable_preview_rounds = 80;
defaultProfiles.nightmare.runtime.preview_wip_cap_items = 3;
defaultProfiles.nightmare.runtime.active_mission_buffer = 2;
defaultProfiles.nightmare.runtime.active_runner_cap = 4;
defaultProfiles.nightmare.runtime.close_mode_active_runner_cap = 6;
defaultProfiles.nightmare.runtime.close_active_eta_threshold = 20;
defaultProfiles.nightmare.runtime.close_active_remaining_threshold = 3;
defaultProfiles.nightmare.runtime.service_bay_queue_depth = 3;
defaultProfiles.nightmare.runtime.allow_pickup_queue_in_close_mode = false;
defaultProfiles.medium_warehouse_v1 = JSON.parse(JSON.stringify(defaultProfiles.medium));
defaultProfiles.medium_warehouse_v1.runtime.multi_bot_strategy = 'warehouse_v1';
defaultProfiles.hard_warehouse_v1 = JSON.parse(JSON.stringify(defaultProfiles.hard));
defaultProfiles.expert_warehouse_v1 = JSON.parse(JSON.stringify(defaultProfiles.expert));
defaultProfiles.nightmare_warehouse_v1 = JSON.parse(JSON.stringify(defaultProfiles.nightmare));
defaultProfiles.expert_replay_handoff = JSON.parse(JSON.stringify(defaultProfiles.expert));

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') {
    return base;
  }

  if (!base || typeof base !== 'object') {
    return patch;
  }

  const result = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function loadProfiles(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return {
      ...defaultProfiles,
      expert_replay_handoff: JSON.parse(JSON.stringify(defaultProfiles.expert)),
    };
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  const profiles = { ...defaultProfiles };
  for (const [difficulty, profile] of Object.entries(parsed)) {
    profiles[difficulty] = deepMerge(defaultProfiles[difficulty] || {}, profile);
  }

  if (!Object.hasOwn(parsed, 'expert_replay_handoff')) {
    profiles.expert_replay_handoff = JSON.parse(JSON.stringify(profiles.expert));
  }

  return profiles;
}

export function resolveProfile(profiles, difficulty, profileName) {
  if (profileName && profiles[profileName]) {
    return profiles[profileName];
  }

  if (!profiles[difficulty]) {
    throw new Error(`Unknown difficulty/profile: ${difficulty}`);
  }

  return profiles[difficulty];
}
