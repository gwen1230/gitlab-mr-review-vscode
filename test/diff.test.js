// node --test test/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  parseHunks,
  parseNumstat,
  parseRawDiff,
  toLineRangeEntry,
  toPositionLines,
} = require('../src/diff');

const hunks = parseHunks(
  ['@@ -3,0 +4,2 @@ ajout', '@@ -10,3 +12 @@ remplacement', '@@ -20 +19,0 @@ suppression'].join(
    '\n'
  )
);

test('parseHunks lit les compteurs implicites', () => {
  assert.deepEqual(hunks, [
    { oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 },
    { oldStart: 10, oldCount: 3, newStart: 12, newCount: 1 },
    { oldStart: 20, oldCount: 1, newStart: 19, newCount: 0 },
  ]);
});

test('côté branche : lignes ajoutées et inchangées', () => {
  assert.deepEqual(toPositionLines(hunks, 'new', 2), { old_line: 2, new_line: 2 });
  assert.deepEqual(toPositionLines(hunks, 'new', 4), { new_line: 4 });
  assert.deepEqual(toPositionLines(hunks, 'new', 6), { old_line: 4, new_line: 6 });
  assert.deepEqual(toPositionLines(hunks, 'new', 12), { new_line: 12 });
  assert.deepEqual(toPositionLines(hunks, 'new', 13), { old_line: 13, new_line: 13 });
  assert.deepEqual(toPositionLines(hunks, 'new', 19), { old_line: 19, new_line: 19 });
  assert.deepEqual(toPositionLines(hunks, 'new', 20), { old_line: 21, new_line: 20 });
});

test('côté base : lignes supprimées et inchangées', () => {
  assert.deepEqual(toPositionLines(hunks, 'old', 3), { old_line: 3, new_line: 3 });
  assert.deepEqual(toPositionLines(hunks, 'old', 4), { old_line: 4, new_line: 6 });
  assert.deepEqual(toPositionLines(hunks, 'old', 11), { old_line: 11 });
  assert.deepEqual(toPositionLines(hunks, 'old', 13), { old_line: 13, new_line: 13 });
  assert.deepEqual(toPositionLines(hunks, 'old', 20), { old_line: 20 });
  assert.deepEqual(toPositionLines(hunks, 'old', 21), { old_line: 21, new_line: 20 });
});

test('parseRawDiff suit les renommages et garde le blob côté branche', () => {
  const files = parseRawDiff(
    [
      ':100644 100644 a1 a2 M',
      'a.ts',
      ':100644 100644 b1 b2 R087',
      'old/b.ts',
      'new/b.ts',
      ':000000 100644 0000 c2 A',
      'c.ts',
      ':100644 000000 d1 0000 D',
      'd.ts',
      '',
    ].join('\0')
  );
  assert.deepEqual(Object.fromEntries(files), {
    'a.ts': { status: 'M', oldPath: 'a.ts', blob: 'a2' },
    'new/b.ts': { status: 'R', oldPath: 'old/b.ts', blob: 'b2' },
    'c.ts': { status: 'A', oldPath: 'c.ts', blob: 'c2' },
    'd.ts': { status: 'D', oldPath: 'd.ts', blob: 'd1' },
  });
});

test('toLineRangeEntry porte les deux compteurs, même sur une ligne ajoutée ou supprimée', () => {
  const sha1 = crypto.createHash('sha1').update('a.ts').digest('hex');
  assert.deepEqual(toLineRangeEntry(hunks, 'new', 4, 'a.ts'), {
    line_code: `${sha1}_4_4`,
    type: 'new',
    old_line: null,
    new_line: 4,
  });
  assert.deepEqual(toLineRangeEntry(hunks, 'new', 12, 'a.ts'), {
    line_code: `${sha1}_13_12`,
    type: 'new',
    old_line: null,
    new_line: 12,
  });
  assert.deepEqual(toLineRangeEntry(hunks, 'old', 11, 'a.ts'), {
    line_code: `${sha1}_11_12`,
    type: 'old',
    old_line: 11,
    new_line: null,
  });
  assert.deepEqual(toLineRangeEntry(hunks, 'old', 20, 'a.ts'), {
    line_code: `${sha1}_20_20`,
    type: 'old',
    old_line: 20,
    new_line: null,
  });
  assert.deepEqual(toLineRangeEntry(hunks, 'new', 6, 'a.ts'), {
    line_code: `${sha1}_4_6`,
    type: null,
    old_line: 4,
    new_line: 6,
  });
});

test('parseNumstat lit renommages et fichiers binaires', () => {
  const stats = parseNumstat(
    ['12\t3\ta.ts', '5\t1\t', 'old/b.ts', 'new/b.ts', '-\t-\timage.png', ''].join('\0')
  );
  assert.deepEqual(Object.fromEntries(stats), {
    'a.ts': { added: 12, deleted: 3 },
    'new/b.ts': { added: 5, deleted: 1 },
  });
});
