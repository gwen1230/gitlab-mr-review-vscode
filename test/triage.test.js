// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTriage } = require('../src/triage');

const HEAD = 'a'.repeat(40);
const expected = { head: HEAD, target: 'release/2.0', paths: ['a.ts', 'b.ts'] };
const triage = {
  head: HEAD,
  target: 'release/2.0',
  files: [
    {
      path: 'a.ts',
      level: 'red',
      line: 12,
      checks: [{ line: 18, severity: 'blocking', question: 'Q?' }],
    },
    { path: 'b.ts', level: 'green' },
  ],
};

test('validateTriage accepte un triage complet de la MR', () => {
  assert.deepEqual(validateTriage(triage, expected), { errors: [], warnings: [] });
});

test('validateTriage accepte les valeurs françaises des premiers triages', () => {
  const frenchTriage = {
    ...triage,
    files: [
      { path: 'a.ts', level: 'rouge', checks: [{ severity: 'bloquant', question: 'Q ?' }] },
      { path: 'b.ts', level: 'vert', checks: [{ severity: 'à vérifier', question: 'Q ?' }] },
    ],
  };
  assert.deepEqual(validateTriage(frenchTriage, expected), { errors: [], warnings: [] });
});

test('validateTriage refuse un JSON sans fichiers, un autre commit ou des valeurs inconnues', () => {
  assert.deepEqual(validateTriage({ head: HEAD }, expected).errors, ['no `files` list.']);
  assert.deepEqual(
    validateTriage(
      {
        ...triage,
        head: 'b'.repeat(40),
        files: [
          { path: 'a.ts', level: 'rouge', checks: [{ severity: 'majeur' }] },
          { level: 'jaune', line: '3' },
        ],
      },
      expected
    ).errors,
    [
      `triage of commit ${'b'.repeat(11)}, the MR is at ${'a'.repeat(11)}.`,
      'a.ts: check without a question.',
      'a.ts: unknown severity "majeur".',
      'files[1]: no path.',
      'files[1]: unknown level "jaune".',
      'files[1]: invalid line "3".',
    ]
  );
});

test('validateTriage avertit d’une autre cible et de fichiers différents de ceux de la MR', () => {
  assert.deepEqual(
    validateTriage(
      { ...triage, target: 'main', files: [triage.files[0], { path: 'c.ts', level: 'green' }] },
      expected
    ),
    {
      errors: [],
      warnings: [
        'triage made against main, the MR targets release/2.0.',
        '1 MR file(s) missing from the triage: b.ts.',
        '1 triage file(s) not in the MR: c.ts.',
      ],
    }
  );
});

test('validateTriage ne contrôle pas la cible d’un triage qui ne la donne pas', () => {
  const { target, ...triageWithoutTarget } = triage;
  assert.deepEqual(validateTriage(triageWithoutTarget, expected), { errors: [], warnings: [] });
});
