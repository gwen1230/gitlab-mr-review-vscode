// @ts-check
const crypto = require('node:crypto');

/** @typedef {{ oldStart: number, oldCount: number, newStart: number, newCount: number }} Hunk */
/**
 * @typedef {object} ChangedFile
 * @property {string} status `A`, `M`, `D`, `R`…
 * @property {string} oldPath
 * @property {string} blob empreinte du contenu côté branche (côté base pour un fichier supprimé) :
 *   elle change dès qu'un commit retouche le fichier
 * @property {LineStats} [stats] absentes pour un fichier binaire
 */

/** @typedef {{ added: number, deleted: number }} LineStats */

/**
 * Lit la sortie de `git diff --numstat -z -M` : lignes ajoutées et supprimées par nouveau chemin. Un
 * renommage s'écrit `<ajouts>\t<suppressions>\t\0<ancien>\0<nouveau>\0`, un fichier binaire `-\t-`.
 * @param {string} output
 * @returns {Map<string, LineStats>}
 */
function parseNumstat(output) {
  /** @type {Map<string, LineStats>} */
  const stats = new Map();
  const fields = output.split('\0');
  for (let index = 0; fields[index];) {
    const [added, deleted, filePath] = fields[index].split('\t');
    const newPath = filePath || fields[index + 2];
    if (added !== '-') {
      stats.set(newPath, { added: Number(added), deleted: Number(deleted) });
    }
    index += filePath ? 1 : 3;
  }
  return stats;
}

/**
 * Lit la sortie de `git diff --raw -z -M --no-abbrev` : fichiers modifiés indexés par leur nouveau chemin.
 * @param {string} output
 * @returns {Map<string, ChangedFile>}
 */
function parseRawDiff(output) {
  /** @type {Map<string, ChangedFile>} */
  const files = new Map();
  const fields = output.split('\0');
  for (let index = 0; fields[index];) {
    // `:<mode> <mode> <blob base> <blob branche> <statut>`, puis le ou les chemins.
    const [, , oldBlob, newBlob, statusWithScore] = fields[index].slice(1).split(' ');
    const status = statusWithScore.charAt(0);
    if (status === 'R' || status === 'C') {
      files.set(fields[index + 2], { status, oldPath: fields[index + 1], blob: newBlob });
      index += 3;
    } else {
      const blob = status === 'D' ? oldBlob : newBlob;
      files.set(fields[index + 1], { status, oldPath: fields[index + 1], blob });
      index += 2;
    }
  }
  return files;
}

/**
 * Lit les en-têtes de hunks d'un `git diff -U0`.
 * @param {string} diffText
 * @returns {Hunk[]}
 */
function parseHunks(diffText) {
  return [...diffText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  }));
}

/**
 * Traduit une ligne (1-based) d'un côté du diff en lignes de position GitLab : une ligne ajoutée n'a
 * que `new_line`, une ligne supprimée que `old_line`, une ligne inchangée porte les deux.
 * @param {Hunk[]} hunks hunks `-U0`, triés
 * @param {'old' | 'new'} side
 * @param {number} line
 * @returns {{ old_line?: number, new_line?: number }}
 */
function toPositionLines(hunks, side, line) {
  let delta = 0;
  for (const hunk of hunks) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart;
    const count = side === 'new' ? hunk.newCount : hunk.oldCount;
    if (count > 0 && line >= start && line < start + count) {
      return side === 'new' ? { new_line: line } : { old_line: line };
    }
    // Un hunk vide de ce côté (`+12,0`) se situe juste après la ligne 12.
    const isBeforeLine = count === 0 ? start < line : start + count - 1 < line;
    if (isBeforeLine) {
      delta += side === 'new' ? hunk.oldCount - hunk.newCount : hunk.newCount - hunk.oldCount;
    }
  }
  return side === 'new'
    ? { old_line: line + delta, new_line: line }
    : { old_line: line, new_line: line + delta };
}

/**
 * Borne d'un `line_range` GitLab (commentaire sur plusieurs lignes). Le `line_code` vaut
 * `sha1(chemin)_<compteur base>_<compteur branche>` : une ligne ajoutée ou supprimée porte aussi le
 * compteur de l'autre côté, là où elle s'insère dans le diff unifié.
 * @param {Hunk[]} hunks hunks `-U0`, triés
 * @param {'old' | 'new'} side
 * @param {number} line
 * @param {string} filePath nouveau chemin (ancien pour un fichier supprimé)
 */
function toLineRangeEntry(hunks, side, line, filePath) {
  const lines = toPositionLines(hunks, side, line);
  let oldCounter = lines.old_line;
  let newCounter = lines.new_line;
  const hunk = hunks.find((candidate) =>
    side === 'new'
      ? line >= candidate.newStart && line < candidate.newStart + candidate.newCount
      : line >= candidate.oldStart && line < candidate.oldStart + candidate.oldCount
  );
  if (hunk) {
    // Le diff unifié liste les suppressions d'un hunk avant ses ajouts.
    oldCounter ??= hunk.oldCount > 0 ? hunk.oldStart + hunk.oldCount : hunk.oldStart + 1;
    newCounter ??= hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
  }
  return {
    line_code: `${crypto.createHash('sha1').update(filePath).digest('hex')}_${oldCounter}_${newCounter}`,
    type: lines.new_line === undefined ? 'old' : lines.old_line === undefined ? 'new' : null,
    old_line: lines.old_line ?? null,
    new_line: lines.new_line ?? null,
  };
}

module.exports = { parseNumstat, parseRawDiff, parseHunks, toLineRangeEntry, toPositionLines };
