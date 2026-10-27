// @ts-check
const vscode = require('vscode');
const { isUnresolved } = require('./discussions');

/** @type {Record<string, string>} */
const PIPELINE_ICONS = {
  success: '$(pass)',
  failed: '$(error)',
  running: '$(sync~spin)',
  pending: '$(clock)',
  created: '$(clock)',
  preparing: '$(clock)',
  waiting_for_resource: '$(clock)',
  scheduled: '$(clock)',
  manual: '$(play-circle)',
  canceled: '$(circle-slash)',
  skipped: '$(debug-step-over)',
};

/** Statuts d'un pipeline qui peut encore changer : ils justifient de relire la MR. */
const RUNNING_PIPELINE_STATUSES = [
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'scheduled',
];

/**
 * Barre d'état : MR de l'éditeur actif, fils non résolus, pipeline, avertissement si le worktree n'est
 * pas sur le dernier commit. Un clic ouvre la MR dans GitLab.
 */
class StatusBar {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {object} sessions
   * @param {() => any[]} sessions.list
   * @param {(uri: vscode.Uri) => any} sessions.findForUri
   * @param {vscode.Event<void>} sessions.onDidChange
   */
  constructor(context, sessions) {
    this.sessions = sessions;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = 'mrReview.openInBrowser';
    context.subscriptions.push(
      this.item,
      sessions.onDidChange(() => this.update()),
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

    this.item.text = [
      `$(git-pull-request) !${session.mr.iid}`,
      `$(comment-discussion) ${unresolvedCount}`,
      drafts.length ? `$(edit) ${drafts.length}` : '',
      session.isApproved ? '$(thumbsup)' : '',
      pipeline ? (PIPELINE_ICONS[pipeline.status] ?? '$(circle-outline)') : '',
      session.isHeadUpToDate ? '' : '$(warning)',
    ]
      .filter(Boolean)
      .join('  ');
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**!${session.mr.iid}** ${session.mr.title}`,
        `${unresolvedCount} fil(s) non résolu(s)`,
        drafts.length
          ? `${drafts.length} brouillon(s) à publier : « MR Review : Soumettre la review »`
          : '',
        session.isApproved ? 'Approuvée par vous' : '',
        pipeline ? `Pipeline : ${pipeline.status}` : 'Pas de pipeline',
        session.isHeadUpToDate
          ? ''
          : '$(warning) Le worktree n’est pas sur le dernier commit de la MR : nouveaux commentaires désactivés.',
        'Cliquer pour ouvrir la MR dans GitLab.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      true
    );
    this.item.show();
  }
}

/** @param {any} session */
function hasRunningPipeline(session) {
  return RUNNING_PIPELINE_STATUSES.includes(session.mr.head_pipeline?.status);
}

module.exports = { StatusBar, hasRunningPipeline };
