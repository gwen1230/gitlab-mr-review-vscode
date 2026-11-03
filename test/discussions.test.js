// node --test test/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  countUnresolvedByFile,
  getExcerpt,
  getDocumentEntries,
  getGeneralDiscussions,
  locatePosition,
  renderDiscussionsDocument,
} = require('../src/discussions');

const HEAD = 'head-actuel';
const author = { name: 'Alice' };
const diffNote = (position, resolved, headSha = HEAD) => ({
  id: `diff-${position.new_path}-${resolved}-${headSha}`,
  notes: [
    {
      type: 'DiffNote',
      position: { ...position, head_sha: headSha, new_line: 12 },
      resolvable: true,
      resolved,
      author,
      body: 'x',
      created_at: '2026-10-27T10:00:00Z',
    },
  ],
});
const generalNote = {
  id: 'general',
  notes: [
    {
      type: null,
      resolvable: true,
      resolved: false,
      author,
      body: '\n  Pourquoi ce choix ?\nDétail',
      created_at: '2026-10-26T09:00:00Z',
    },
  ],
};
const systemOnly = {
  id: 'system',
  notes: [
    {
      type: null,
      system: true,
      author,
      body: 'a ajouté 2 commits',
      created_at: '2026-10-26T09:00:00Z',
    },
  ],
};
const discussions = [
  diffNote({ new_path: 'a.ts', old_path: 'a.ts' }, false),
  diffNote({ new_path: 'a.ts', old_path: 'a.ts' }, true),
  diffNote({ new_path: 'new/b.ts', old_path: 'old/b.ts' }, false),
  generalNote,
  systemOnly,
];
const files = new Map([
  ['a.ts', { status: 'M', oldPath: 'a.ts', blob: '1' }],
  ['new/b.ts', { status: 'R', oldPath: 'old/b.ts', blob: '2' }],
]);

/** Emplacements des fils de la version courante ; ceux d'une version précédente n'en ont pas. */
const locate = (discussionList) => ({
  discussions: new Map(
    discussionList
      .filter((discussion) => discussion.notes[0].position?.head_sha === HEAD)
      .map((discussion) => [discussion.id, locatePosition(discussion.notes[0].position, files)])
  ),
  drafts: new Map(),
});

test('countUnresolvedByFile compte les fils non résolus affichés sur le code', () => {
  const outdated = diffNote({ new_path: 'a.ts', old_path: 'a.ts' }, false, 'ancien-head');
  const allDiscussions = [...discussions, outdated];
  assert.deepEqual(
    Object.fromEntries(countUnresolvedByFile(allDiscussions, locate(allDiscussions))),
    { 'a.ts': 1, 'new/b.ts': 1 }
  );
});

test('locatePosition : version courante, renommage, ligne de base', () => {
  assert.deepEqual(locatePosition({ new_path: 'a.ts', old_path: 'a.ts', new_line: 12 }, files), {
    path: 'a.ts',
    side: 'new',
    startLine: 12,
    endLine: 12,
  });
  assert.deepEqual(
    locatePosition(
      {
        new_path: 'new/b.ts',
        old_path: 'old/b.ts',
        old_line: 7,
        line_range: { start: { old_line: 5 }, end: { old_line: 7 } },
      },
      files
    ),
    { path: 'new/b.ts', side: 'old', startLine: 5, endLine: 7 }
  );
  assert.equal(locatePosition({ new_path: 'absent.ts', new_line: 3 }, files), undefined);
});

test('locatePosition suit une ligne inchangée depuis la version du fil, pas une ligne retouchée', () => {
  const position = {
    new_path: 'a.ts',
    old_path: 'a.ts',
    new_line: 20,
    line_range: { start: { new_line: 18 }, end: { new_line: 20 } },
  };
  // Depuis : 2 lignes ajoutées après la ligne 3, la ligne 30 remplacée.
  const hunks = [
    { oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 },
    { oldStart: 30, oldCount: 1, newStart: 32, newCount: 1 },
  ];
  assert.deepEqual(locatePosition(position, files, hunks), {
    path: 'a.ts',
    side: 'new',
    startLine: 20,
    endLine: 22,
  });
  assert.equal(locatePosition({ ...position, new_line: 30 }, files, hunks), undefined);
});

test('getGeneralDiscussions écarte les fils de code et les notes système', () => {
  assert.deepEqual(
    getGeneralDiscussions(discussions).map((discussion) => discussion.id),
    ['general']
  );
});

test('getDocumentEntries : discussions générales, fils et brouillons sans emplacement, brouillons généraux', () => {
  const outdated = diffNote({ new_path: 'a.ts', old_path: 'a.ts' }, false, 'ancien-head');
  const drafts = [
    { id: 1, note: 'brouillon général', discussion_id: null, position: null },
    { id: 2, note: 'réponse', discussion_id: 'general', position: null },
    {
      id: 3,
      note: 'sur une ligne',
      discussion_id: null,
      position: { new_path: 'a.ts', new_line: 3 },
    },
    {
      id: 4,
      note: 'sur une ligne retouchée depuis',
      discussion_id: null,
      position: { new_path: 'a.ts', new_line: 5 },
    },
  ];
  const allDiscussions = [...discussions, outdated];
  const locations = locate(allDiscussions);
  locations.drafts.set(3, { path: 'a.ts', side: 'new', startLine: 3, endLine: 3 });
  const entries = getDocumentEntries(allDiscussions, drafts, locations);
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === 'draft' ? `draft:${entry.draft.id}` : entry.discussion.id
    ),
    ['general', outdated.id, 'draft:1', 'draft:4']
  );
  assert.equal(
    renderDiscussionsDocument(entries),
    [
      '● Alice · 2026-10-26 — Pourquoi ce choix ?',
      '● a.ts:12 (previous version) · Alice · 2026-10-27 — x',
      '✎ Draft — brouillon général',
      '✎ Draft — a.ts:5 (previous version) · sur une ligne retouchée depuis',
      '+ New general comment: click in the margin of this line.',
    ].join('\n')
  );
});

test('getExcerpt tronque la première ligne non vide', () => {
  assert.equal(getExcerpt('a'.repeat(100)), `${'a'.repeat(89)}…`);
});
