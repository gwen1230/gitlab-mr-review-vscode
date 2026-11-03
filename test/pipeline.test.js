// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration, groupJobsByStage } = require('../src/pipeline');

/**
 * @param {number} id @param {string} stage @param {string} name @param {string} status
 * @param {boolean} [allowFailure]
 */
const job = (id, stage, name, status, allowFailure = false) => ({
  id,
  stage,
  name,
  status,
  allow_failure: allowFailure,
});

test('groupJobsByStage suit l’ordre de création des stages et trie les jobs par nom', () => {
  const stages = groupJobsByStage([
    job(5, 'test', 'unit 10', 'success'),
    job(4, 'test', 'unit 2', 'success'),
    job(1, 'build', 'build', 'success'),
  ]);
  assert.deepEqual(
    stages.map((stage) => [stage.name, stage.jobs.map((stageJob) => stageJob.name)]),
    [
      ['build', ['build']],
      ['test', ['unit 2', 'unit 10']],
    ]
  );
});

test('groupJobsByStage : un échec autorisé ou un job manuel ne fait pas échouer le stage', () => {
  const [lint, testStage, deploy] = groupJobsByStage([
    job(1, 'lint', 'oxlint', 'failed', true),
    job(2, 'lint', 'eslint', 'success'),
    job(3, 'test', 'unit', 'running'),
    job(4, 'test', 'e2e', 'failed'),
    job(5, 'deploy', 'recette', 'manual'),
    job(6, 'deploy', 'build image', 'success'),
  ]);
  assert.equal(lint.status, 'success');
  assert.equal(testStage.status, 'failed');
  assert.equal(deploy.status, 'success');
});

test('formatDuration', () => {
  assert.equal(formatDuration(42.4), '42 s');
  assert.equal(formatDuration(185), '3 min 05 s');
});
