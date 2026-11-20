// @ts-check
const path = require('node:path');
const { toPositionLines } = require('./diff');
const { t } = require('./l10n');

/** Longueur maximale d'un extrait de commentaire affiché sur une ligne. */
const EXCERPT_LENGTH = 90;
/** Lignes de contexte affichées au-dessus du code commenté d'un fil sur une version précédente. */
const SNIPPET_CONTEXT_LINES = 3;
/** Nombre maximal de lignes de code affichées pour un fil sur une version précédente. */
const SNIPPET_MAX_LINES = 20;
/** Langage du bloc de code markdown, quand l'extension du fichier ne suffit pas. */
const FENCE_LANGUAGES = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
]);

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
 * Code commenté d'un fil sur une version précédente, tel qu'il était à cette version : quelques lignes
 * de contexte puis les lignes commentées (`commentedFrom` à `commentedTo`, indices dans `lines`).
 * @typedef {{ language: string, lines: string[], commentedFrom: number, commentedTo: number }} Snippet
 * @typedef {({ kind: 'discussion', discussion: any } | { kind: 'draft', draft: any }) & { snippet?: Snippet }} DocumentEntry
 * @typedef {{ sha: string, path: string, startLine: number, endLine: number }} SnippetSource
 */

/**
 * Clé d'une entrée du document des discussions : l'identifiant de la discussion, ou `draft:<id>`.
 * @param {DocumentEntry} entry
 */
function getEntryKey(entry) {
  return entry.kind === 'draft' ? `draft:${entry.draft.id}` : entry.discussion.id;
}

/**
 * Position sur le code d'une entrée du document des discussions, absente pour une discussion générale.
 * @param {DocumentEntry} entry
 */
function getEntryPosition(entry) {
  if (entry.kind === 'draft') {
    return isDiffDraft(entry.draft) ? entry.draft.position : undefined;
  }
  return isDiffDiscussion(entry.discussion) ? entry.discussion.notes[0].position : undefined;
}

/**
 * Version du fichier où lire le code commenté d'une position : commit et chemin de son côté du diff,
 * lignes commentées (1-based).
 * @param {any} position
 * @returns {SnippetSource | undefined}
 */
function getSnippetSource(position) {
  const side = getPositionSide(position);
  const sha = side === 'new' ? position.head_sha : position.base_sha;
  const filePath = side === 'new' ? position.new_path : position.old_path;
  /** @type {number | undefined} */
  const endLine = position[`${side}_line`];
  if (!sha || !filePath || !endLine) {
    return undefined;
  }
  const startLine = Math.min(position.line_range?.start?.[`${side}_line`] ?? endLine, endLine);
  return { sha, path: filePath, startLine, endLine };
}

/**
 * Extrait du fichier autour des lignes commentées : quelques lignes de contexte au-dessus, au plus
 * `SNIPPET_MAX_LINES` lignes en tout (les dernières lignes commentées d'abord).
 * @param {string} content contenu du fichier à la version de la position
 * @param {SnippetSource} source
 * @returns {Snippet | undefined} absent si le fichier n'a pas ces lignes
 */
function extractSnippet(content, source) {
  const fileLines = content.split('\n');
  if (source.endLine > fileLines.length) {
    return undefined;
  }
  const firstLine = Math.max(
    1,
    source.startLine - SNIPPET_CONTEXT_LINES,
    source.endLine - SNIPPET_MAX_LINES + 1
  );
  return {
    language: getFenceLanguage(source.path),
    lines: fileLines.slice(firstLine - 1, source.endLine).map((line) => line.replace(/\r$/, '')),
    commentedFrom: Math.max(source.startLine, firstLine) - firstLine,
    commentedTo: source.endLine - firstLine,
  };
}

/**
 * Langage d'un bloc de code markdown pour un fichier : son extension, que VS Code reconnaît pour les
 * langages courants.
 * @param {string} filePath
 */
function getFenceLanguage(filePath) {
  const basename = path.posix.basename(filePath).toLowerCase();
  return FENCE_LANGUAGES.get(basename) ?? path.posix.extname(basename).slice(1);
}

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
 * Lignes du document des discussions occupées par une entrée (1-based) : sa ligne de description,
 * puis l'extrait de code s'il y en a un. `commented` couvre les lignes commentées de l'extrait.
 * @typedef {{ startLine: number, endLine: number, commented?: { startLine: number, endLine: number } }} EntryRange
 * @typedef {{ text: string, entryRanges: EntryRange[], newCommentLine: number }} DiscussionsLayout
 */

/**
 * Contenu du document des discussions (markdown) : pour chaque entrée, une ligne de description (son
 * fil s'y accroche) suivie, pour un fil sur une version précédente, du code commenté dans un bloc de
 * code ; puis une ligne pour ouvrir une nouvelle discussion générale.
 * @param {DocumentEntry[]} entries
 * @returns {DiscussionsLayout}
 */
function layoutDiscussionsDocument(entries) {
  /** @type {string[]} */
  const lines = [];
  const entryRanges = entries.map((entry) => {
    const startLine = lines.length + 1;
    lines.push(describeEntry(entry));
    const { snippet } = entry;
    if (!snippet) {
      return { startLine, endLine: startLine };
    }
    const fence = getFence(snippet.lines);
    lines.push(`${fence}${snippet.language}`);
    const codeStartLine = lines.length + 1;
    lines.push(...snippet.lines, fence);
    return {
      startLine,
      endLine: lines.length,
      commented: {
        startLine: codeStartLine + snippet.commentedFrom,
        endLine: codeStartLine + snippet.commentedTo,
      },
    };
  });
  lines.push(t('+ New general comment: click in the margin of this line.'));
  return { text: lines.join('\n'), entryRanges, newCommentLine: lines.length };
}

/**
 * Délimiteur d'un bloc de code markdown plus long que toute suite d'accents graves du code.
 * @param {string[]} codeLines
 */
function getFence(codeLines) {
  const longestRun = Math.max(
    0,
    ...codeLines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length))
  );
  return '`'.repeat(Math.max(3, longestRun + 1));
}

module.exports = {
  NO_LOCATIONS,
  countUnresolvedByFile,
  describeEntry,
  extractSnippet,
  getDocumentEntries,
  getEntryKey,
  getEntryPosition,
  getExcerpt,
  getGeneralDiscussions,
  getPositionSide,
  getSnippetSource,
  isDiffDiscussion,
  isDiffDraft,
  isResolvable,
  isUnresolved,
  layoutDiscussionsDocument,
  locatePosition,
};
