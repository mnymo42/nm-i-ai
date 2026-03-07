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
      multi_bot_strategy: 'mission_v1',
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
      drop_commit_min_deliverable: 2,
    },
  },
  hard: {
    assignment: {
      travel_to_item: 1.0,
      travel_item_to_dropoff: 0.85,
      congestion_penalty: 0.4,
      contention_penalty: 0.35,
      urgency_bonus: 0.5,
      remaining_demand_priority: 1.25,
      preview_item_weight: 0.3,
    },
    routing: {
      horizon: 20,
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
  expert: {
    assignment: {
      travel_to_item: 1.0,
      travel_item_to_dropoff: 0.9,
      congestion_penalty: 0.55,
      contention_penalty: 0.5,
      urgency_bonus: 0.7,
      remaining_demand_priority: 1.3,
      preview_item_weight: 0.35,
    },
    routing: {
      horizon: 24,
      hold_goal_steps: 6,
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
};

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
    return defaultProfiles;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  const profiles = { ...defaultProfiles };
  for (const [difficulty, profile] of Object.entries(parsed)) {
    profiles[difficulty] = deepMerge(defaultProfiles[difficulty] || {}, profile);
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
