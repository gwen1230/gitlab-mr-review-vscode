// @ts-check
const { isBlockingCheck } = require('./triage');
const { t } = require('./l10n');

/**
 * MR de la liste de l'API GitLab, champs utiles à la vue « MR du projet ».
 * @typedef {object} ListedMergeRequest
 * @property {number} iid
 * @property {number} project_id
 * @property {number} source_project_id
 * @property {string} title
 * @property {string} web_url
 * @property {string} sha dernier commit
 * @property {string} source_branch
 * @property {string} target_branch
 * @property {string} updated_at
 * @property {string} state
 * @property {boolean} [draft]
 * @property {string} [detailed_merge_status]
 * @property {{ id: number, name: string, username: string }} author
 * @property {{ id: number }[]} [reviewers]
 */

/**
 * @typedef {'review' | 'mine' | 'others'} MergeRequestGroup
 */

/** Groupes de la vue, dans l'ordre d'affichage. */
const MERGE_REQUEST_GROUPS = /** @type {const} */ ([
  { group: 'review', label: t('👀 To review by me'), isExpanded: true },
  { group: 'mine', label: t('✍ My MRs'), isExpanded: true },
  { group: 'others', label: t('📂 Others'), isExpanded: false },
]);

/**
 * Groupe d'une MR pour l'utilisateur : relecteur d'abord, auteur ensuite, sinon les autres.
 * @param {ListedMergeRequest} mr
 * @param {number} userId
 * @returns {MergeRequestGroup}
 */
function getMergeRequestGroup(mr, userId) {
  if ((mr.reviewers ?? []).some((reviewer) => reviewer.id === userId)) {
    return 'review';
  }
  return mr.author.id === userId ? 'mine' : 'others';
}

/**
 * MR retenue par le filtre de la vue : tous les termes (séparés par des espaces) dans le titre, la
 * branche source, l'auteur ou `!iid`.
 * @param {ListedMergeRequest} mr
 * @param {{ filterText: string, isDraftHidden: boolean }} filter
 */
function isMergeRequestShown(mr, { filterText, isDraftHidden }) {
  if (isDraftHidden && mr.draft) {
    return false;
  }
  const searchable = [mr.title, mr.source_branch, mr.author.name, mr.author.username, `!${mr.iid}`]
    .join(' ')
    .toLowerCase();
  return filterText
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => searchable.includes(term));
}

/**
 * Âge relatif d'une date : « il y a 5 min », « il y a 3 h », « il y a 2 j ».
 * @param {string} isoDate
 * @param {Date} now
 */
function formatAge(isoDate, now) {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(isoDate).getTime()) / 60_000));
  if (minutes < 60) {
    return t('{0} min ago', minutes);
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('{0} h ago', hours) : t('{0} d ago', Math.floor(hours / 24));
}

/**
 * @typedef {{ kind: 'running' } | { kind: 'none' }
 *   | { kind: 'current' | 'stale', head: string, red: number, orange: number, green: number, blocking: number }} TriageState
 */

/**
 * État du triage d'une MR : en cours, absent, à jour (fait sur son dernier commit) ou périmé.
 * @param {import('./triage').Triage | undefined} triage
 * @param {string} headSha dernier commit de la MR
 * @param {boolean} isRunning
 * @returns {TriageState}
 */
function getTriageState(triage, headSha, isRunning) {
  if (isRunning) {
    return { kind: 'running' };
  }
  if (!triage) {
    return { kind: 'none' };
  }
  /** @param {string} level */
  const countLevel = (level) => triage.files.filter((file) => file.level === level).length;
  return {
    kind: triage.head === headSha ? 'current' : 'stale',
    head: triage.head,
    red: countLevel('red'),
    orange: countLevel('orange'),
    green: countLevel('green'),
    blocking: triage.files.flatMap((file) => file.checks ?? []).filter(isBlockingCheck).length,
  };
}

module.exports = {
  MERGE_REQUEST_GROUPS,
  formatAge,
  getMergeRequestGroup,
  getTriageState,
  isMergeRequestShown,
};
