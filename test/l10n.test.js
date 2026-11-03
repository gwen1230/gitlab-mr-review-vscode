const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sources = ['extension.js', ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`)];

/** Messages passés à `t(...)` / `l10n.t(...)`, avec le fichier où ils apparaissent. */
function messages() {
  const found = [];
  for (const file of sources) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g)) {
      const [, quote, raw] = match;
      const message = quote === '`' && raw.includes('${') ? raw : eval(quote + raw + quote);
      found.push({ file, quote, message });
    }
  }
  return found;
}

test('chaque message du code a sa traduction française', () => {
  const fr = JSON.parse(read('l10n/bundle.l10n.fr.json'));
  const missing = messages()
    .filter(({ message }) => !(message in fr))
    .map(({ file, message }) => `${file}: ${message}`);
  assert.deepStrictEqual([...new Set(missing)], []);
});

test('aucun message traduit en template literal interpolé', () => {
  const interpolated = messages().filter(({ quote, message }) => quote === '`' && message.includes('${'));
  assert.deepStrictEqual(interpolated, []);
});

test('aucune traduction française orpheline', () => {
  const fr = JSON.parse(read('l10n/bundle.l10n.fr.json'));
  const used = new Set(messages().map(({ message }) => message));
  assert.deepStrictEqual(Object.keys(fr).filter((key) => !used.has(key)), []);
});

test('chaque clé %…% du manifeste existe en anglais et en français', () => {
  const manifest = read('package.json');
  const keys = [...new Set([...manifest.matchAll(/"%([^"%]+)%"/g)].map((match) => match[1]))];
  for (const file of ['package.nls.json', 'package.nls.fr.json']) {
    const nls = JSON.parse(read(file));
    assert.deepStrictEqual(keys.filter((key) => !(key in nls)), [], file);
    assert.deepStrictEqual(Object.keys(nls).filter((key) => !keys.includes(key)), [], file);
  }
});
