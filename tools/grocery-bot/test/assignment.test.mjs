import test from 'node:test';
import assert from 'node:assert/strict';

import { solveMinCostAssignment } from '../src/routing/assignment.mjs';

test('solveMinCostAssignment finds global minimum for square matrix', () => {
  const costs = [
    [4, 1, 3],
    [2, 0, 5],
    [3, 2, 2],
  ];

  const result = solveMinCostAssignment(costs);

  assert.deepEqual(result.assignment, [1, 0, 2]);
  assert.equal(result.totalCost, 5);
});

test('solveMinCostAssignment supports rectangular matrix with more tasks than workers', () => {
  const costs = [
    [7, 1, 5],
    [2, 3, 4],
  ];

  const result = solveMinCostAssignment(costs);

  assert.deepEqual(result.assignment, [1, 0]);
  assert.equal(result.totalCost, 3);
});
