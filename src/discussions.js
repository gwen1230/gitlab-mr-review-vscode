// @ts-check
const { toPositionLines } = require('./diff');
const { t } = require('./l10n');

/** Longueur maximale d'un extrait de commentaire affiché sur une ligne. */
const EXCERPT_LENGTH = 90;

/**
 * Emplacement d'un fil dans le diff courant : nouveau chemin du fichier, côté du diff, lignes 1-based.
 * @typedef {{ path: string, side: 'old' | 'new', startLine: number, endLine: number }} ThreadLocation
 * @typedef {{ discussions: Map<string, ThreadLocation>, drafts: Map<number, ThreadLocation> }} ThreadLocations
 */

/** @type {ThreadLocations} */
const NO_LOCATIONS = { discussions: new Map(), drafts: new Map() };

/** @param {any} discussion */
function isResolvable(discussion) {
  return Boolean(discussion.notes[0]?.resolvable);
}

/** @param {any} discussion */
function isUnresolved(discussion) {
  return isResolvable(discussion) && !discussion.notes[0].resolved;
}

/** @param {any} discussion */
function isDiffDiscussion(discussion) {
  return discussion.notes[0]?.type === 'DiffNote' && Boolean(discussion.notes[0].position);
}

/**
 * Discussions de la MR qui ne portent pas sur une ligne de code, sans celles faites uniquement de notes
 * système (« a ajouté 2 commits »…).
 * @param {any[]} discussions
 */
function getGeneralDiscussions(discussions) {
  return discussions.filter(
    (discussion) =>
      !isDiffDiscussion(discussion) &&
      discussion.notes.some((/** @type {any} */ note) => !note.system)
  );
}

/**
 * Côté du diff où s'affiche une position : une ligne inchangée porte `old_line` et `new_line`, elle
 * s'affiche côté branche.
 * @param {any} position
 * @returns {'old' | 'new'}
 */
function getPositionSide(position) {
  return position.new_line ? 'new' : 'old';
}

/**
 * Emplacement d'une position GitLab dans le diff courant. Comme dans GitLab, une position d'une
 * version précédente suit sa ligne tant que les commits suivants ne l'ont pas touchée.
 * @param {any} position
 * @param {Map<string, import('./diff').ChangedFile>} files fichiers du diff courant
 * @param {import('./diff').Hunk[]} [hunks] diff `-U0` du fichier entre la version de la position et la
 *   version courante, du côté de la position (branche ou base) ; absent pour la version courante
 * @returns {ThreadLocation | undefined} absent si le fichier n'est plus dans la MR ou si la ligne a
 *   changé depuis
 */
function locatePosition(position, files, hunks) {
  const side = getPositionSide(position);
  const filePath =
    side === 'new'
      ? position.new_path
      : [...files].find(([, file]) => file.oldPath === position.old_path)?.[0];
  /** @type {number | undefined} */
  const endLine = position[`${side}_line`];
  if (!filePath || !files.has(filePath) || !endLine) {
    return undefined;
  }
  const startLine = position.line_range?.start?.[`${side}_line`] ?? endLine;
  if (!hunks) {
    return { path: filePath, side, startLine, endLine };
  }
  /** @param {number} line */
  const shiftLine = (line) => toPositionLines(hunks, 'old', line).new_line;
  const shiftedEndLine = shiftLine(endLine);
  if (!shiftedEndLine) {
    return undefined;
  }
  return {
    path: filePath,
    side,
    startLine: shiftLine(startLine) ?? shiftedEndLine,
    endLine: shiftedEndLine,
  };
}

/** @param {any} draft brouillon de review (`draft_notes`) */
function isDiffDraft(draft) {
  return Boolean(draft.position?.new_path || draft.position?.old_path);
}

/** @param {any} draft */
function isGeneralDraft(draft) {
  return !draft.discussion_id && !isDiffDraft(draft);
}

/**
 * @typedef {{ kind: 'discussion', discussion: any } | { kind: 'draft', draft: any }} DocumentEntry
 */

/**
 * Ce qui n'a pas sa place sur une ligne de code, dans l'ordre du document des discussions : discussions
 * générales, fils et brouillons d'une version précédente dont la ligne a changé depuis, brouillons de
 * commentaire général. L'entrée `i` occupe la ligne `i + 1`.
 * @param {any[]} discussions
 * @param {any[]} drafts
 * @param {ThreadLocations} locations
 * @returns {DocumentEntry[]}
 */
function getDocumentEntries(discussions, drafts, locations) {
  return [
    ...getGeneralDiscussions(discussions),
    ...discussions.filter(
      (discussion) => isDiffDiscussion(discussion) && !locations.discussions.has(discussion.id)
    ),
  ]
    .map((discussion) => /** @type {DocumentEntry} */ ({ kind: 'discussion', discussion }))
    .concat(
      drafts
        .filter(
          (draft) =>
            isGeneralDraft(draft) ||
            (isDiffDraft(draft) && !draft.discussion_id && !locations.drafts.has(draft.id))
        )
        .map((draft) => ({ kind: 'draft', draft }))
    );
}

/**
 * Nombre de fils non résolus par fichier de la MR (nouveau chemin), pour les fils affichés sur le code.
 * @param {any[]} discussions
 * @param {ThreadLocations} locations
 * @returns {Map<string, number>}
 */
function countUnresolvedByFile(discussions, locations) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const discussion of discussions) {
    const location = locations.discussions.get(discussion.id);
    if (location && isUnresolved(discussion)) {
      counts.set(location.path, (counts.get(location.path) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Première ligne non vide d'un commentaire, tronquée.
 * @param {string} body
 */
function getExcerpt(body) {
  const firstLine =
    body
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? '';
  return firstLine.length > EXCERPT_LENGTH
    ? `${firstLine.slice(0, EXCERPT_LENGTH - 1)}…`
    : firstLine;
}

/**
 * Une ligne du document des discussions : état, auteur, date, fichier pour un fil sur une version
 * précédente, extrait.
 * @param {DocumentEntry} entry
 */
function describeEntry(entry) {
  if (entry.kind === 'draft') {
    const location = isDiffDraft(entry.draft) ? describeOutdatedPosition(entry.draft.position) : '';
    return t('✎ Draft — {0}{1}', location, getExcerpt(entry.draft.note));
  }
  const { discussion } = entry;
  const note = discussion.notes.find((/** @type {any} */ candidate) => !candidate.system);
  const marker = isUnresolved(discussion) ? '●' : isResolvable(discussion) ? '✓' : '·';
  const location = isDiffDiscussion(discussion)
    ? describeOutdatedPosition(discussion.notes[0].position)
    : '';
  return `${marker} ${location}${note.author.name} · ${note.created_at.slice(0, 10)} — ${getExcerpt(note.body)}`;
}

/** @param {any} position */
function describeOutdatedPosition(position) {
  return `${t(
    '{0}:{1} (previous version)',
    position.new_path ?? position.old_path,
    position.new_line ?? position.old_line
  )} · `;
}

/**
 * Contenu du document des discussions : une ligne par entrée (son fil s'y accroche), puis une ligne
 * pour ouvrir une nouvelle discussion générale.
 * @param {DocumentEntry[]} entries
 */
function renderDiscussionsDocument(entries) {
  return [
    ...entries.map(describeEntry),
    t('+ New general comment: click in the margin of this line.'),
  ].join('\n');
}

module.exports = {
  NO_LOCATIONS,
  countUnresolvedByFile,
  describeEntry,
  getDocumentEntries,
  getExcerpt,
  getGeneralDiscussions,
  getPositionSide,
  isDiffDiscussion,
  isDiffDraft,
  isResolvable,
  isUnresolved,
  locatePosition,
  renderDiscussionsDocument,
};
