// node --test test/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  countUnresolvedByFile,
  extractSnippet,
  getExcerpt,
  getDocumentEntries,
  getEntryKey,
  getEntryPosition,
  getGeneralDiscussions,
  getSnippetSource,
  layoutDiscussionsDocument,
  locatePosition,
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
  assert.deepEqual(entries.map(getEntryKey), ['general', outdated.id, 'draft:1', 'draft:4']);
  assert.equal(
    layoutDiscussionsDocument(entries).text,
    [
      '● Alice · 2026-10-26 — Pourquoi ce choix ?',
      '● a.ts:12 (previous version) · Alice · 2026-10-27 — x',
      '✎ Draft — brouillon général',
      '✎ Draft — a.ts:5 (previous version) · sur une ligne retouchée depuis',
      '+ New general comment: click in the margin of this line.',
    ].join('\n')
  );
});

test('getEntryPosition : position des fils et brouillons de code, rien pour une discussion générale', () => {
  const outdated = diffNote({ new_path: 'a.ts', old_path: 'a.ts' }, false, 'ancien-head');
  const draft = {
    id: 4,
    note: 'x',
    discussion_id: null,
    position: { new_path: 'a.ts', new_line: 5 },
  };
  assert.equal(getEntryPosition({ kind: 'discussion', discussion: outdated }).new_line, 12);
  assert.equal(getEntryPosition({ kind: 'draft', draft }).new_line, 5);
  assert.equal(getEntryPosition({ kind: 'discussion', discussion: generalNote }), undefined);
  assert.equal(
    getEntryPosition({ kind: 'draft', draft: { id: 1, note: 'x', position: null } }),
    undefined
  );
});

test('getSnippetSource : commit et chemin du côté de la position, plage de lignes', () => {
  assert.deepEqual(
    getSnippetSource({
      base_sha: 'base',
      head_sha: 'head',
      old_path: 'old/b.ts',
      new_path: 'new/b.ts',
      new_line: 12,
      line_range: { start: { new_line: 10 }, end: { new_line: 12 } },
    }),
    { sha: 'head', path: 'new/b.ts', startLine: 10, endLine: 12 }
  );
  assert.deepEqual(
    getSnippetSource({
      base_sha: 'base',
      head_sha: 'head',
      old_path: 'old/b.ts',
      new_path: 'new/b.ts',
      old_line: 7,
      new_line: null,
    }),
    { sha: 'base', path: 'old/b.ts', startLine: 7, endLine: 7 }
  );
  assert.equal(getSnippetSource({ new_path: 'a.ts', new_line: 3 }), undefined);
});

test('extractSnippet : contexte au-dessus des lignes commentées, plafonné', () => {
  const content = Array.from({ length: 40 }, (_, index) => `ligne ${index + 1}`).join('\r\n');
  assert.deepEqual(
    extractSnippet(content, { sha: 's', path: 'src/App.TSX', startLine: 5, endLine: 6 }),
    {
      language: 'tsx',
      lines: ['ligne 2', 'ligne 3', 'ligne 4', 'ligne 5', 'ligne 6'],
      commentedFrom: 3,
      commentedTo: 4,
    }
  );
  // Début du fichier : moins de contexte.
  assert.deepEqual(
    extractSnippet(content, { sha: 's', path: 'Dockerfile', startLine: 1, endLine: 1 }),
    { language: 'dockerfile', lines: ['ligne 1'], commentedFrom: 0, commentedTo: 0 }
  );
  // Plage longue : les 20 dernières lignes, toutes commentées.
  const long = extractSnippet(content, { sha: 's', path: 'a', startLine: 2, endLine: 30 });
  assert.equal(long?.lines.length, 20);
  assert.equal(long?.lines[0], 'ligne 11');
  assert.deepEqual([long?.commentedFrom, long?.commentedTo, long?.language], [0, 19, '']);
  assert.equal(
    extractSnippet(content, { sha: 's', path: 'a', startLine: 41, endLine: 41 }),
    undefined
  );
});

test('layoutDiscussionsDocument : extrait de code sous un fil sur une version précédente', () => {
  const outdated = diffNote({ new_path: 'a.md', old_path: 'a.md' }, false, 'ancien-head');
  const layout = layoutDiscussionsDocument([
    { kind: 'discussion', discussion: generalNote },
    {
      kind: 'discussion',
      discussion: outdated,
      snippet: {
        language: 'md',
        lines: ['avant', '```js', 'commenté'],
        commentedFrom: 2,
        commentedTo: 2,
      },
    },
    { kind: 'draft', draft: { id: 1, note: 'brouillon général', position: null } },
  ]);
  assert.equal(
    layout.text,
    [
      '● Alice · 2026-10-26 — Pourquoi ce choix ?',
      '● a.md:12 (previous version) · Alice · 2026-10-27 — x',
      '````md',
      'avant',
      '```js',
      'commenté',
      '````',
      '✎ Draft — brouillon général',
      '+ New general comment: click in the margin of this line.',
    ].join('\n')
  );
  assert.deepEqual(layout.entryRanges, [
    { startLine: 1, endLine: 1 },
    { startLine: 2, endLine: 7, commented: { startLine: 6, endLine: 6 } },
    { startLine: 8, endLine: 8 },
  ]);
  assert.equal(layout.newCommentLine, 9);
});

test('getExcerpt tronque la première ligne non vide', () => {
  assert.equal(getExcerpt('a'.repeat(100)), `${'a'.repeat(89)}…`);
});
