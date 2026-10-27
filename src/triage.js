// @ts-check
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Triage écrit par le skill `triage-mr` dans `<dossier>/<branche>.json`, fichiers dans l'ordre de lecture.
 * @typedef {object} Triage
 * @property {string} head commit trié
 * @property {TriageFile[]} files
 */

/**
 * @typedef {object} TriageFile
 * @property {string} path chemin relatif au repo
 * @property {'rouge' | 'orange' | 'vert'} level niveau final, après reclassement
 * @property {number} [line] ligne à ouvrir
 * @property {string} [reasons]
 * @property {TriageCheck[]} [checks] points à vérifier
 */

/**
 * Point à vérifier du triage, sur une ligne de la version triée (`head`).
 * @typedef {object} TriageCheck
 * @property {number} [line]
 * @property {string} question
 */

/** @param {string} directory réglage `mrReview.triageDirectory`, `~` accepté */
function resolveTriageDirectory(directory) {
  return directory.replace(/^~(?=$|\/)/, os.homedir());
}

/**
 * Même règle que le skill : les `/` de la branche deviennent des `-`.
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
    return JSON.parse(await fs.readFile(triagePath, 'utf8'));
  } catch (caught) {
    const error = /** @type {NodeJS.ErrnoException} */ (caught);
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`triage illisible (${triagePath}) : ${error.message}`);
  }
}

module.exports = { getTriagePath, readTriage, resolveTriageDirectory };
