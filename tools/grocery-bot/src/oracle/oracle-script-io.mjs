import fs from 'node:fs';

export function loadOracleFile(oraclePath) {
  if (!oraclePath) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));
    return {
      ok: true,
      data,
      message: `Oracle loaded: ${data.known_orders?.length || 0} known orders from ${oraclePath}`,
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      message: `Warning: failed to load oracle from ${oraclePath}: ${error.message}`,
    };
  }
}

export function loadScriptFile(scriptPath) {
  if (!scriptPath) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    const tickMap = new Map();
    const entryMap = new Map();
    for (const entry of data.ticks || []) {
      tickMap.set(entry.tick, entry.actions);
      entryMap.set(entry.tick, entry);
    }

    return {
      ok: true,
      data: { ...data, tickMap, entryMap },
      message: `Script loaded: ${tickMap.size} ticks (0-${data.last_scripted_tick}) from ${scriptPath}`,
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      message: `Warning: failed to load script from ${scriptPath}: ${error.message}`,
    };
  }
}
