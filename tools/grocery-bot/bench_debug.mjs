import { simulatePlannerAgainstOracleEnvironment } from './src/oracle/oracle-planner-benchmark.mjs';
import { loadOracleFile } from './src/oracle/oracle-script-io.mjs';
import { GroceryPlanner } from './src/planner/planner.mjs';
import { loadProfiles, resolveProfile } from './src/utils/profile.mjs';

const profiles = loadProfiles();
const profile = resolveProfile(profiles, 'expert', 'expert_team_v1');
const oracleLoad = loadOracleFile('/home/magnus/Git/nm-i-ai/tools/grocery-bot/config/oracle-expert.json');

class DebugPlanner extends GroceryPlanner {
  plan(state) {
    const result = super.plan(state);
    const metrics = this.getLastMetrics();
    if (state.round % 25 === 0 || state.round === 299) {
      const teams = metrics?.teams?.map(t => `${t.role}:${t.botCount}`) ?? [];
      console.error(`t=${state.round} sc=${state.score} stl=${metrics?.stalledBots ?? '?'} tsk=${metrics?.taskCount ?? '?'} rec=${metrics?.recoveryMode ?? '?'} noProg=${this.noProgressRounds} teams=[${teams}]`);
    }
    return result;
  }
}

const result = simulatePlannerAgainstOracleEnvironment({
  oracle: oracleLoad.data,
  plannerFactory: () => new DebugPlanner(profile, { oracle: oracleLoad.data }),
});

console.log(JSON.stringify({ finalScore: result.finalScore, ordersCompleted: result.ordersCompleted, stalls: result.totalStalls, waits: result.waitActions, wasted: result.wastedInventoryAtEnd.length }));
