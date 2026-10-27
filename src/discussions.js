// @ts-check

/** Longueur maximale d'un extrait de commentaire affiché sur une ligne. */
const EXCERPT_LENGTH = 90;

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
 * Fils de code posés sur une version précédente de la MR : GitLab ne déplace pas leur position quand
 * la ligne a changé depuis, elle garde donc l'ancien `head_sha`.
 * @param {any[]} discussions
 * @param {string} headSha dernier commit de la MR
 */
function getOutdatedDiscussions(discussions, headSha) {
  return discussions.filter(
    (discussion) =>
      isDiffDiscussion(discussion) && discussion.notes[0].position.head_sha !== headSha
  );
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
 * générales, fils sur une version précédente, brouillons de commentaire général. L'entrée `i` occupe la
 * ligne `i + 1`.
 * @param {any[]} discussions
 * @param {any[]} drafts
 * @param {string} headSha
 * @returns {DocumentEntry[]}
 */
function getDocumentEntries(discussions, drafts, headSha) {
  return [...getGeneralDiscussions(discussions), ...getOutdatedDiscussions(discussions, headSha)]
    .map((discussion) => /** @type {DocumentEntry} */ ({ kind: 'discussion', discussion }))
    .concat(drafts.filter(isGeneralDraft).map((draft) => ({ kind: 'draft', draft })));
}

/**
 * Nombre de fils non résolus par fichier de la MR (nouveau chemin).
 * @param {any[]} discussions
 * @param {Map<string, import('./diff').ChangedFile>} files
 * @returns {Map<string, number>}
 */
function countUnresolvedByFile(discussions, files) {
  const newPathByOldPath = new Map([...files].map(([newPath, file]) => [file.oldPath, newPath]));
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const discussion of discussions) {
    if (!isDiffDiscussion(discussion) || !isUnresolved(discussion)) {
      continue;
    }
    const { position } = discussion.notes[0];
    const filePath = files.has(position.new_path)
      ? position.new_path
      : newPathByOldPath.get(position.old_path);
    if (filePath) {
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
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
    return `✎ Brouillon — ${getExcerpt(entry.draft.note)}`;
  }
  const { discussion } = entry;
  const note = discussion.notes.find((/** @type {any} */ candidate) => !candidate.system);
  const marker = isUnresolved(discussion) ? '●' : isResolvable(discussion) ? '✓' : '·';
  const { position } = discussion.notes[0];
  const location = isDiffDiscussion(discussion)
    ? `${position.new_path ?? position.old_path}:${position.new_line ?? position.old_line} (version précédente) · `
    : '';
  return `${marker} ${location}${note.author.name} · ${note.created_at.slice(0, 10)} — ${getExcerpt(note.body)}`;
}

/**
 * Contenu du document des discussions : une ligne par entrée (son fil s'y accroche), puis une ligne
 * pour ouvrir une nouvelle discussion générale.
 * @param {DocumentEntry[]} entries
 */
function renderDiscussionsDocument(entries) {
  return [
    ...entries.map(describeEntry),
    '+ Nouveau commentaire général : cliquez dans la marge de cette ligne.',
  ].join('\n');
}

module.exports = {
  countUnresolvedByFile,
  describeEntry,
  getDocumentEntries,
  getExcerpt,
  getGeneralDiscussions,
  getOutdatedDiscussions,
  isDiffDiscussion,
  isDiffDraft,
  isResolvable,
  isUnresolved,
  renderDiscussionsDocument,
};
