// @ts-check
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderDescriptionDocument } = require('../src/description');

const PROJECT_URL = 'https://gitlab.com/groupe/projet';
/** @param {string | null} description */
const mergeRequest = (description) => ({
  iid: 7,
  title: 'Titre',
  web_url: `${PROJECT_URL}/-/merge_requests/7`,
  description,
  author: { name: 'Alice', username: 'alice', web_url: 'https://gitlab.com/alice' },
  source_branch: 'feature',
  target_branch: 'develop',
  state: 'opened',
  detailed_merge_status: 'conflict',
});

test('renderDescriptionDocument affiche auteur, approbations, état et branches', () => {
  const document = renderDescriptionDocument(mergeRequest(null), [
    { name: 'Bob', username: 'bob' },
  ]);
  assert.match(document, /\*\*Author\*\*: \[Alice\]\(https:\/\/gitlab\.com\/alice\)/);
  assert.match(document, /\*\*Approved by\*\*: Bob/);
  assert.match(document, /\*\*Status\*\*: Conflicts with the target branch/);
  assert.match(document, /`feature` → `develop`/);
  assert.match(document, /_No description\._/);
});

test('renderDescriptionDocument met en lien tickets, MR et pièces jointes, hors code', () => {
  const document = renderDescriptionDocument(
    mergeRequest(
      [
        'Corrige #12 et suit !34. ![capture](/uploads/abc/image.png)',
        'Ni `#56`, ni &#123;, ni https://exemple.fr/page#78, ni [#90](lien).',
        '```',
        'git log !99',
        '```',
      ].join('\n')
    ),
    []
  );
  assert.match(document, /\[#12\]\(https:\/\/gitlab\.com\/groupe\/projet\/-\/issues\/12\)/);
  assert.match(document, /\[!34\]\(https:\/\/gitlab\.com\/groupe\/projet\/-\/merge_requests\/34\)/);
  assert.match(document, /\(https:\/\/gitlab\.com\/groupe\/projet\/uploads\/abc\/image\.png\)/);
  assert.match(
    document,
    /Ni `#56`, ni &#123;, ni https:\/\/exemple\.fr\/page#78, ni \[#90\]\(lien\)\./
  );
  assert.match(document, /git log !99/);
  assert.match(document, /\*\*Approved by\*\*: nobody/);
});
