// node --test test/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  countUnresolvedByFile,
  getExcerpt,
  getDocumentEntries,
  getGeneralDiscussions,
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
  diffNote({ new_path: 'old/b.ts', old_path: 'old/b.ts' }, false),
  generalNote,
  systemOnly,
];
const files = new Map([
  ['a.ts', { status: 'M', oldPath: 'a.ts', blob: '1' }],
  ['new/b.ts', { status: 'R', oldPath: 'old/b.ts', blob: '2' }],
]);

test('countUnresolvedByFile compte les fils non résolus, renommages compris', () => {
  assert.deepEqual(Object.fromEntries(countUnresolvedByFile(discussions, files)), {
    'a.ts': 1,
    'new/b.ts': 1,
  });
});

test('getGeneralDiscussions écarte les fils de code et les notes système', () => {
  assert.deepEqual(
    getGeneralDiscussions(discussions).map((discussion) => discussion.id),
    ['general']
  );
});

test('getDocumentEntries : discussions générales, fils sur une version précédente, brouillons généraux', () => {
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
  ];
  const entries = getDocumentEntries([...discussions, outdated], drafts, HEAD);
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === 'draft' ? `draft:${entry.draft.id}` : entry.discussion.id
    ),
    ['general', outdated.id, 'draft:1']
  );
  assert.equal(
    renderDiscussionsDocument(entries),
    [
      '● Alice · 2026-10-26 — Pourquoi ce choix ?',
      '● a.ts:12 (version précédente) · Alice · 2026-10-27 — x',
      '✎ Brouillon — brouillon général',
      '+ Nouveau commentaire général : cliquez dans la marge de cette ligne.',
    ].join('\n')
  );
});

test('getExcerpt tronque la première ligne non vide', () => {
  assert.equal(getExcerpt('a'.repeat(100)), `${'a'.repeat(89)}…`);
});
