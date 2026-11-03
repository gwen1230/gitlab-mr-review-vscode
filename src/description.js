// @ts-check
const { describeMergeStatus } = require('./merge-status');
const { t } = require('./l10n');

/**
 * @typedef {{ name: string, username: string, web_url?: string }} GitLabUser
 * @typedef {{ iid: number, title: string, web_url: string, description?: string | null,
 *   author: GitLabUser, source_branch: string, target_branch: string }
 *   & import('./merge-status').MergeableRequest} DescribedMergeRequest
 */

/** Blocs et extraits de code, laissés tels quels : `#12` y est du code, pas une référence. */
const CODE_PATTERN = /(```[\s\S]*?```|`[^`\n]*`)/;
/** `#12` (ticket) ou `!34` (MR) du projet, hors entité HTML, ancre d'URL ou lien existant. */
const REFERENCE_PATTERN = /(?<![\w&/[#!])([#!])(\d+)\b/g;

/**
 * Document markdown de la description : titre, auteur, approbations, état de merge, branches, puis la description
 * avec ses références GitLab en liens et ses pièces jointes en URL absolues.
 * @param {DescribedMergeRequest} mr
 * @param {GitLabUser[]} approvers
 */
function renderDescriptionDocument(mr, approvers) {
  const projectUrl = mr.web_url.replace(/\/-\/merge_requests\/\d+$/, '');
  return [
    `# [!${mr.iid}](${mr.web_url}) ${mr.title}`,
    '',
    t('**Author**: {0}', formatUser(mr.author)) + '  ',
    t(
      '**Approved by**: {0}',
      approvers.length > 0 ? approvers.map(formatUser).join(', ') : t('nobody')
    ) + '  ',
    t('**Status**: {0}', describeMergeStatus(mr).label) + '  ',
    t('**Branches**: {0} → {1}', `\`${mr.source_branch}\``, `\`${mr.target_branch}\``),
    '',
    '---',
    '',
    mr.description?.trim()
      ? linkifyDescription(mr.description, projectUrl)
      : t('_No description._'),
    '',
  ].join('\n');
}

/** @param {GitLabUser} user */
function formatUser(user) {
  return user.web_url ? `[${user.name}](${user.web_url})` : user.name;
}

/**
 * @param {string} description
 * @param {string} projectUrl
 */
function linkifyDescription(description, projectUrl) {
  return description
    .split(CODE_PATTERN)
    .map((segment, index) =>
      // Les segments impairs sont les blocs de code capturés par le `split`.
      index % 2 === 1
        ? segment
        : segment
            .replace(/(\]\(|src=")\/uploads\//g, `$1${projectUrl}/uploads/`)
            .replace(
              REFERENCE_PATTERN,
              (reference, sigil, id) =>
                `[${reference}](${projectUrl}/-/${sigil === '#' ? 'issues' : 'merge_requests'}/${id})`
            )
    )
    .join('');
}

module.exports = { renderDescriptionDocument };
