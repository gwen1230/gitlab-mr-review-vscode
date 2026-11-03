// @ts-check

/** @type {((message: string, ...args: Array<string | number | boolean>) => string) | undefined} */
let translate;
try {
  translate = require('vscode').l10n.t;
} catch {
  // Hors de VS Code (tests) : message source, en anglais.
}

/**
 * Message traduit dans la langue de VS Code (`l10n/bundle.l10n.<langue>.json`), `{0}`, `{1}`…
 * remplacés par `args`. Le message source, en anglais, sert de clé : toujours une chaîne littérale,
 * pour que `test/l10n.test.js` vérifie sa traduction.
 * @param {string} message
 * @param {...(string | number | boolean)} args
 */
function t(message, ...args) {
  return translate
    ? translate(message, ...args)
    : message.replace(/\{(\d+)\}/g, (match, index) =>
        index < args.length ? String(args[index]) : match
      );
}

module.exports = { t };
