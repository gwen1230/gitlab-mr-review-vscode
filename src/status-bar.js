// @ts-check
const vscode = require('vscode');
const { isUnresolved } = require('./discussions');
const { PIPELINE_ICONS } = require('./pipeline');
const { describeMergeStatus } = require('./merge-status');
const { t } = require('./l10n');

/**
 * Barre d'état : MR de l'éditeur actif, état de merge, fils non résolus, pipeline, avertissement si le
 * worktree n'est pas sur le dernier commit. Un clic ouvre la MR dans GitLab.
 */
class StatusBar {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {object} sessions
   * @param {() => any[]} sessions.list
   * @param {(uri: vscode.Uri) => any} sessions.findForUri
   * @param {vscode.Event<void>} sessions.onDidChange
   * @param {import('./triage-runner').TriageRunner} triageRunner
   */
  constructor(context, sessions, triageRunner) {
    this.sessions = sessions;
    this.triageRunner = triageRunner;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = 'mrReview.openInBrowser';
    context.subscriptions.push(
      this.item,
      sessions.onDidChange(() => this.update()),
      triageRunner.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update())
    );
  }

  /** MR du document actif, sinon la première chargée. */
  getCurrentSession() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.sessions.findForUri(uri)) ?? this.sessions.list()[0];
  }

  async update() {
    const session = this.getCurrentSession();
    if (!session) {
      this.item.hide();
      return;
    }
    const [discussions, drafts] = await Promise.all([
      session.discussions.catch(() => []),
      session.drafts.catch(() => []),
    ]);
    const unresolvedCount = discussions.filter(isUnresolved).length;
    const pipeline = session.mr.head_pipeline;
    const mergeStatus = describeMergeStatus(session.mr);
    const isTriageRunning =
      this.triageRunner.getStartedAt(session.repoRoot, session.mr.iid) !== undefined;

    this.item.text = [
      `$(git-pull-request) !${session.mr.iid}`,
      `$(${mergeStatus.icon})`,
      `$(comment-discussion) ${unresolvedCount}`,
      drafts.length ? `$(edit) ${drafts.length}` : '',
      session.isApproved ? '$(thumbsup)' : '',
      pipeline ? `$(${PIPELINE_ICONS[pipeline.status] ?? 'circle-outline'})` : '',
      session.isHeadUpToDate ? '' : '$(warning)',
      isTriageRunning ? '$(sync~spin) triage' : '',
    ]
      .filter(Boolean)
      .join('  ');
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**!${session.mr.iid}** ${session.mr.title}`,
        `$(${mergeStatus.icon}) ${mergeStatus.label}`,
        t('{0} unresolved thread(s)', unresolvedCount),
        drafts.length
          ? t('{0} draft(s) to publish: "MR Review: Submit review"', drafts.length)
          : '',
        session.isApproved ? t('Approved by you') : '',
        pipeline ? t('Pipeline: {0}', pipeline.status) : t('No pipeline'),
        session.isHeadUpToDate
          ? ''
          : t(
              '$(warning) The worktree is not on the latest commit of the MR: new comments are disabled. "MR Review: Update worktree" updates it.'
            ),
        isTriageRunning ? t('$(sync~spin) Triage running') : '',
        t('Click to open the MR in GitLab.'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      true
    );
    this.item.show();
  }
}

module.exports = { StatusBar };
