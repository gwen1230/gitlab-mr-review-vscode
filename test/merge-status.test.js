// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeMergeStatus, isMergeStatusPending } = require('../src/merge-status');

test('isMergeStatusPending : état pas encore calculé, sur une MR ouverte seulement', () => {
  assert.equal(isMergeStatusPending({ state: 'opened', detailed_merge_status: 'unchecked' }), true);
  assert.equal(isMergeStatusPending({ state: 'opened', detailed_merge_status: 'checking' }), true);
  assert.equal(isMergeStatusPending({ state: 'opened' }), true);
  assert.equal(
    isMergeStatusPending({ state: 'opened', detailed_merge_status: 'mergeable' }),
    false
  );
  assert.equal(
    isMergeStatusPending({ state: 'merged', detailed_merge_status: 'unchecked' }),
    false
  );
});

test('describeMergeStatus : MR fermée, mergée ou draft avant le statut détaillé', () => {
  assert.equal(describeMergeStatus({ state: 'merged' }).label, 'Merged');
  assert.equal(describeMergeStatus({ state: 'closed' }).label, 'Closed');
  assert.equal(
    describeMergeStatus({ state: 'opened', draft: true, detailed_merge_status: 'conflict' }).label,
    'Draft MR'
  );
});

test('describeMergeStatus : libellé précis, icône prête / bloquée par l’auteur / neutre', () => {
  /** @param {string} status */
  const describe = (status) =>
    describeMergeStatus({ state: 'opened', detailed_merge_status: status });
  assert.deepEqual(describe('mergeable'), {
    icon: 'git-merge',
    color: 'charts.green',
    label: 'Ready to merge',
  });
  assert.deepEqual(describe('need_rebase'), {
    icon: 'git-pull-request',
    color: 'charts.red',
    label: 'Needs a rebase on the target branch',
  });
  assert.deepEqual(describe('not_approved'), {
    icon: 'git-pull-request',
    label: 'Approvals missing',
  });
  assert.equal(describe('nouveau_statut').label, 'Not mergeable (nouveau_statut)');
  assert.equal(describe('nouveau_statut').color, 'charts.red');
  assert.equal(describeMergeStatus({ state: 'opened' }).label, 'GitLab is checking');
});
