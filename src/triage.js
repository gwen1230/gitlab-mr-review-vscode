// @ts-check
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { t } = require('./l10n');

/**
 * Triage écrit par un outil externe dans `<dossier>/<branche>.json`, fichiers dans l'ordre de lecture
 * (format décrit dans le README).
 * @typedef {object} Triage
 * @property {string} head commit trié
 * @property {string} [target] branche cible triée, non contrôlée si absente
 * @property {TriageFile[]} files
 */

/**
 * @typedef {object} TriageFile
 * @property {string} path chemin relatif au repo
 * @property {'red' | 'orange' | 'green'} level
 * @property {number} [line] ligne à ouvrir
 * @property {string} [reasons]
 * @property {TriageCheck[]} [checks] points à vérifier
 */

/**
 * Point à vérifier du triage, sur une ligne de la version triée (`head`).
 * @typedef {object} TriageCheck
 * @property {number} [line]
 * @property {'blocking' | 'check'} [severity] `check` si absente
 * @property {string} question
 */

const LEVELS = ['red', 'orange', 'green'];
const SEVERITIES = ['blocking', 'check'];
/** Valeurs françaises des premiers triages, acceptées et ramenées aux valeurs anglaises. */
/** @type {Record<string, string>} */
const LEVEL_ALIASES = { rouge: 'red', vert: 'green' };
/** @type {Record<string, string>} */
const SEVERITY_ALIASES = { bloquant: 'blocking', 'à vérifier': 'check' };
/** Au-delà, une liste de chemins est tronquée dans les messages. */
const LISTED_PATHS = 5;

/** @param {TriageCheck} check */
function isBlockingCheck(check) {
  return check.severity === 'blocking';
}

/**
 * Contrôle un triage écrit par la commande de triage. Erreurs : JSON que la vue ne saurait pas lire, ou
 * triage d'un autre commit que la MR. Avertissements : cible ou fichiers différents de ceux de la MR,
 * que la vue sait afficher (fichiers « hors triage »).
 * @param {any} triage contenu du JSON
 * @param {{ head: string, target: string, paths: string[] }} expected
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateTriage(triage, expected) {
  triage = normalizeTriage(triage);
  if (typeof triage !== 'object' || triage === null || !Array.isArray(triage.files)) {
    return { errors: [t('no `files` list.')], warnings: [] };
  }
  /** @type {string[]} */
  const errors = [];
  if (triage.head !== expected.head) {
    errors.push(
      t(
        'triage of commit {0}, the MR is at {1}.',
        String(triage.head).slice(0, 11),
        expected.head.slice(0, 11)
      )
    );
  }
  triage.files.forEach((/** @type {any} */ file, /** @type {number} */ index) => {
    const label = typeof file?.path === 'string' ? file.path : `files[${index}]`;
    if (typeof file?.path !== 'string') {
      errors.push(t('{0}: no path.', label));
    }
    if (!LEVELS.includes(file?.level)) {
      errors.push(t('{0}: unknown level "{1}".', label, String(file?.level)));
    }
    if (file?.line !== undefined && !Number.isInteger(file.line)) {
      errors.push(t('{0}: invalid line "{1}".', label, String(file.line)));
    }
    if (file?.checks !== undefined && !Array.isArray(file.checks)) {
      errors.push(t('{0}: `checks` is not a list.', label));
    }
    for (const check of Array.isArray(file?.checks) ? file.checks : []) {
      if (typeof check?.question !== 'string') {
        errors.push(t('{0}: check without a question.', label));
      }
      if (check?.severity !== undefined && !SEVERITIES.includes(check.severity)) {
        errors.push(t('{0}: unknown severity "{1}".', label, String(check.severity)));
      }
      if (check?.line !== undefined && !Number.isInteger(check.line)) {
        errors.push(t('{0}: invalid line "{1}" on a check.', label, String(check.line)));
      }
    }
  });

  /** @type {string[]} */
  const warnings = [];
  if (triage.target !== undefined && triage.target !== expected.target) {
    warnings.push(
      t('triage made against {0}, the MR targets {1}.', triage.target, expected.target)
    );
  }
  const triagedPaths = new Set(triage.files.map((/** @type {any} */ file) => file?.path));
  const expectedPaths = new Set(expected.paths);
  /** @param {string[]} paths */
  const listPaths = (paths) =>
    paths.slice(0, LISTED_PATHS).join(', ') + (paths.length > LISTED_PATHS ? '…' : '');
  const missingPaths = expected.paths.filter((filePath) => !triagedPaths.has(filePath));
  if (missingPaths.length > 0) {
    warnings.push(
      t(
        '{0} MR file(s) missing from the triage: {1}.',
        missingPaths.length,
        listPaths(missingPaths)
      )
    );
  }
  const extraPaths = [...triagedPaths].filter(
    (filePath) => typeof filePath === 'string' && !expectedPaths.has(filePath)
  );
  if (extraPaths.length > 0) {
    warnings.push(
      t('{0} triage file(s) not in the MR: {1}.', extraPaths.length, listPaths(extraPaths))
    );
  }
  return { errors, warnings };
}

/**
 * Ramène les valeurs françaises de `level` et `severity` aux valeurs anglaises ; le reste tel quel.
 * @param {any} triage contenu du JSON
 */
function normalizeTriage(triage) {
  if (typeof triage !== 'object' || triage === null || !Array.isArray(triage.files)) {
    return triage;
  }
  return {
    ...triage,
    files: triage.files.map((/** @type {any} */ file) =>
      typeof file !== 'object' || file === null
        ? file
        : {
            ...file,
            level: LEVEL_ALIASES[file.level] ?? file.level,
            ...(Array.isArray(file.checks) && {
              checks: file.checks.map((/** @type {any} */ check) =>
                typeof check !== 'object' || check === null
                  ? check
                  : { ...check, severity: SEVERITY_ALIASES[check.severity] ?? check.severity }
              ),
            }),
          }
    ),
  };
}

/** @param {string} directory réglage `mrReview.triageDirectory`, `~` accepté */
function resolveTriageDirectory(directory) {
  return directory.replace(/^~(?=$|\/)/, os.homedir());
}

/**
 * Les `/` de la branche deviennent des `-`.
 * @param {string} directory
 * @param {string} branch
 */
function getTriagePath(directory, branch) {
  return path.join(directory, `${branch.replaceAll('/', '-')}.json`);
}

/**
 * @param {string} triagePath
 * @returns {Promise<Triage | undefined>} `undefined` si la branche n'a pas été triée
 */
async function readTriage(triagePath) {
  try {
    return normalizeTriage(JSON.parse(await fs.readFile(triagePath, 'utf8')));
  } catch (caught) {
    const error = /** @type {NodeJS.ErrnoException} */ (caught);
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(t('unreadable triage ({0}): {1}', triagePath, error.message));
  }
}

module.exports = {
  getTriagePath,
  isBlockingCheck,
  readTriage,
  resolveTriageDirectory,
  validateTriage,
};
