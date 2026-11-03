// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatAge,
  getMergeRequestGroup,
  getTriageState,
  isMergeRequestShown,
} = require('../src/merge-requests');
const { parseWorktrees } = require('../src/git');

const ME = 1;
/** @param {Partial<import('../src/merge-requests').ListedMergeRequest>} fields */
const mergeRequest = (fields) => ({
  iid: 12,
  project_id: 5,
  source_project_id: 5,
  title: 'Codification des heures',
  web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
  sha: 'head',
  source_branch: 'feature/timesheet',
  target_branch: 'develop',
  updated_at: '2026-10-28T10:00:00Z',
  state: 'opened',
  author: { id: 2, name: 'Carol Smith', username: 'carl' },
  reviewers: [],
  ...fields,
});

test('getMergeRequestGroup : relecteur avant auteur, sinon autres', () => {
  assert.equal(
    getMergeRequestGroup(
      mergeRequest({ author: { id: ME, name: 'Moi', username: 'moi' }, reviewers: [{ id: ME }] }),
      ME
    ),
    'review'
  );
  assert.equal(
    getMergeRequestGroup(mergeRequest({ author: { id: ME, name: 'Moi', username: 'moi' } }), ME),
    'mine'
  );
  assert.equal(getMergeRequestGroup(mergeRequest({}), ME), 'others');
});

test('isMergeRequestShown : tous les termes, sur titre, branche, auteur ou !iid ; drafts masquables', () => {
  const filter = (filterText, isDraftHidden = false) =>
    isMergeRequestShown(mergeRequest({ draft: true }), { filterText, isDraftHidden });
  assert.equal(filter(''), true);
  assert.equal(filter('carol timesheet'), true);
  assert.equal(filter('!12 feature/'), true);
  assert.equal(filter('carol holidays'), false);
  assert.equal(filter('', true), false);
});

test('formatAge en minutes, heures puis jours', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  assert.equal(formatAge('2026-10-28T11:55:00Z', now), '5 min ago');
  assert.equal(formatAge('2026-10-28T09:00:00Z', now), '3 h ago');
  assert.equal(formatAge('2026-10-26T09:00:00Z', now), '2 d ago');
});

test('getTriageState : en cours, absent, à jour ou périmé, avec ses compteurs', () => {
  /** @type {import('../src/triage').Triage} */
  const triage = {
    head: 'head',
    files: [
      { path: 'a.ts', level: 'red', checks: [{ severity: 'blocking', question: 'Q' }] },
      { path: 'b.ts', level: 'green' },
    ],
  };
  assert.deepEqual(getTriageState(triage, 'head', true), { kind: 'running' });
  assert.deepEqual(getTriageState(undefined, 'head', false), { kind: 'none' });
  assert.deepEqual(getTriageState(triage, 'head', false), {
    kind: 'current',
    head: 'head',
    red: 1,
    orange: 0,
    green: 1,
    blocking: 1,
  });
  assert.equal(getTriageState(triage, 'nouveau-head', false).kind, 'stale');
});

test('parseWorktrees lit chemin et branche, HEAD détaché compris', () => {
  assert.deepEqual(
    parseWorktrees(
      [
        'worktree /repo',
        'HEAD abc',
        'branch refs/heads/develop',
        '',
        'worktree /repo.worktrees/review',
        'HEAD def',
        'branch refs/heads/feature/x',
        '',
        'worktree /tmp/detache',
        'HEAD 123',
        'detached',
        '',
      ].join('\n')
    ),
    [
      { path: '/repo', branch: 'develop' },
      { path: '/repo.worktrees/review', branch: 'feature/x' },
      { path: '/tmp/detache' },
    ]
  );
});
