const LARGE_COST = 1e9;

function normalizeMatrix(costMatrix) {
  const rows = costMatrix.length;
  const columns = rows === 0 ? 0 : Math.max(...costMatrix.map((row) => row.length));
  const size = Math.max(rows, columns);

  const matrix = Array.from({ length: size }, (_, rowIndex) => (
    Array.from({ length: size }, (_, columnIndex) => {
      if (rowIndex < rows && columnIndex < (costMatrix[rowIndex] || []).length) {
        const value = costMatrix[rowIndex][columnIndex];
        if (Number.isFinite(value)) {
          return value;
        }
      }

      return LARGE_COST;
    })
  ));

  return { matrix, rows, columns };
}

export function solveMinCostAssignment(costMatrix) {
  if (!Array.isArray(costMatrix) || costMatrix.length === 0) {
    return { assignment: [], totalCost: 0 };
  }

  const { matrix, rows } = normalizeMatrix(costMatrix);
  const n = matrix.length;
  const u = Array(n + 1).fill(0);
  const v = Array(n + 1).fill(0);
  const p = Array(n + 1).fill(0);
  const way = Array(n + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(n + 1).fill(Infinity);
    const used = Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= n; j += 1) {
        if (used[j]) {
          continue;
        }

        const cur = matrix[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }

        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignmentByRow = Array(n).fill(-1);
  for (let j = 1; j <= n; j += 1) {
    if (p[j] > 0) {
      assignmentByRow[p[j] - 1] = j - 1;
    }
  }

  const assignment = assignmentByRow.slice(0, rows).map((taskIndex, rowIndex) => {
    if (taskIndex < 0 || taskIndex >= costMatrix[rowIndex].length || costMatrix[rowIndex][taskIndex] >= LARGE_COST) {
      return -1;
    }

    return taskIndex;
  });

  const totalCost = assignment.reduce((sum, taskIndex, rowIndex) => {
    if (taskIndex < 0) {
      return sum;
    }

    return sum + costMatrix[rowIndex][taskIndex];
  }, 0);

  return { assignment, totalCost };
}
