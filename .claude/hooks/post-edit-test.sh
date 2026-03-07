#!/usr/bin/env bash
# Runs the test suite when grocery-bot code, oracle, or script files are edited.
# Receives Claude Code PostToolUse JSON payload on stdin.

REPO=/home/magnus/prog/nm-i-ai

# Parse file_path from stdin JSON using node
FILE=$(node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(d);
      const fp = (payload.tool_input || {}).file_path || '';
      process.stdout.write(fp);
    } catch (_) {}
  });
")

# Run tests for planner/client/src changes, optimizer changes, oracle/script configs, and tests.
case "$FILE" in
  *grocery-bot/src/*|\
  *grocery-bot/test/*|\
  *grocery-bot/generate-script.mjs|\
  *grocery-bot/config/oracle-expert.json|\
  *grocery-bot/config/script-expert.json)
    echo ""
    echo "--- Tests triggered by: $FILE ---"
    cd "$REPO" && node --test tools/grocery-bot/test/*.test.mjs 2>&1
    echo "---"
    ;;
esac
