// @ts-check
const { t } = require('./l10n');

/**
 * @typedef {{ icon: string, color?: string, label: string }} MergeStatus icône codicon, couleur de
 *   thème éventuelle et libellé précis
 * @typedef {{ state: string, draft?: boolean, detailed_merge_status?: string }} MergeableRequest
 */

/**
 * Peu d'icônes, du point de vue du relecteur : prête à merger, bloquée par l'auteur (à corriger de son
 * côté), draft, ou rien de particulier (en relecture, en attente de GitLab ou du pipeline). Le libellé
 * donne le détail.
 */
const READY = { icon: 'git-merge', color: 'charts.green' };
const BLOCKED = { icon: 'git-pull-request', color: 'charts.red' };
const NEUTRAL = { icon: 'git-pull-request' };
const DRAFT = { icon: 'git-pull-request-draft' };

/** États pas encore calculés par GitLab : ils se résolvent seuls après une demande de recalcul. */
const PENDING_MERGE_STATUSES = ['unchecked', 'checking', 'preparing', 'approvals_syncing'];

/** Par valeur de `detailed_merge_status`. @type {Record<string, MergeStatus>} */
const MERGE_STATUSES = {
  mergeable: { ...READY, label: t('Ready to merge') },
  conflict: { ...BLOCKED, label: t('Conflicts with the target branch') },
  need_rebase: { ...BLOCKED, label: t('Needs a rebase on the target branch') },
  ci_must_pass: { ...BLOCKED, label: t('Pipeline must pass') },
  requested_changes: { ...BLOCKED, label: t('Changes requested') },
  blocked_status: { ...BLOCKED, label: t('Blocked by another MR') },
  merge_request_blocked: { ...BLOCKED, label: t('Blocked by another MR') },
  draft_status: { ...DRAFT, label: t('Draft MR') },
  discussions_not_resolved: { ...NEUTRAL, label: t('Threads to resolve before merging') },
  not_approved: { ...NEUTRAL, label: t('Approvals missing') },
  ci_still_running: { ...NEUTRAL, label: t('Pipeline running') },
  ...Object.fromEntries(
    PENDING_MERGE_STATUSES.map((status) => [
      status,
      { ...NEUTRAL, label: t('GitLab is checking') },
    ])
  ),
};

/**
 * État de merge d'une MR, tel que GitLab l'affiche sous le bouton « Merge ».
 * @param {MergeableRequest} mr
 * @returns {MergeStatus}
 */
function describeMergeStatus(mr) {
  if (mr.state === 'merged') {
    return { icon: 'git-merge', label: t('Merged') };
  }
  if (mr.state === 'closed') {
    return { icon: 'git-pull-request-closed', label: t('Closed') };
  }
  if (mr.draft) {
    return MERGE_STATUSES.draft_status;
  }
  const status = mr.detailed_merge_status ?? 'unchecked';
  return MERGE_STATUSES[status] ?? { ...BLOCKED, label: t('Not mergeable ({0})', status) };
}

/**
 * État de merge d'une MR ouverte que GitLab n'a pas encore calculé.
 * @param {MergeableRequest} mr
 */
function isMergeStatusPending(mr) {
  return (
    mr.state === 'opened' &&
    PENDING_MERGE_STATUSES.includes(mr.detailed_merge_status ?? 'unchecked')
  );
}

module.exports = { describeMergeStatus, isMergeStatusPending };
