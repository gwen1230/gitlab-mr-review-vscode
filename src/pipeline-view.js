// @ts-check
const vscode = require('vscode');
const {
  PIPELINE_ICONS,
  PIPELINE_POLL_MS,
  RUNNING_PIPELINE_STATUSES,
  formatDuration,
  groupJobsByStage,
  isAllowedFailure,
} = require('./pipeline');
const { t } = require('./l10n');

/** Couleur d'icône par statut ; les autres statuts gardent celle du texte. @type {Record<string, string>} */
const STATUS_COLORS = {
  success: 'testing.iconPassed',
  failed: 'testing.iconFailed',
};

/**
 * Sous-ensemble de la session de revue utile à la vue (cf. `ReviewSession` dans extension.js).
 * @typedef {object} PipelineSession
 * @property {string} repoRoot
 * @property {string} projectPath
 * @property {import('./gitlab').GitLabClient} client
 * @property {{ iid: number, title: string, head_pipeline?: { id: number, status: string, web_url: string } | null }} mr
 */

/**
 * @typedef {{ kind: 'session', session: PipelineSession }} SessionNode
 * @typedef {{ kind: 'stage', session: PipelineSession, pipelineId: number, stage: import('./pipeline').Stage }} StageNode
 * @typedef {{ kind: 'job', session: PipelineSession, job: import('./pipeline').Job }} JobNode
 * @typedef {SessionNode | StageNode | JobNode} Node
 */

/**
 * Vue « Pipeline » : stages et jobs du dernier pipeline de la MR. Un job `trigger` se déplie sur les
 * stages de son pipeline enfant. Les pipelines qui tournent sont relus toutes les 30 s tant que la vue
 * est visible. Un clic sur un job l'ouvre dans GitLab.
 * @implements {vscode.TreeDataProvider<Node>}
 */
class PipelineView {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {object} sessions
   * @param {() => PipelineSession[]} sessions.list
   * @param {vscode.Event<void>} sessions.onDidChange
   */
  constructor(context, sessions) {
    this.sessions = sessions;
    /**
     * Stages par pipeline (parent ou enfant), par session, avec le statut qu'ils reflètent : un
     * changement de statut les périme.
     * @type {WeakMap<PipelineSession, Map<number, { status: string, stages: Promise<import('./pipeline').Stage[]> }>>}
     */
    this.pipelines = new WeakMap();
    /** @type {vscode.EventEmitter<void>} */
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.treeView = vscode.window.createTreeView('mrReview.pipeline', { treeDataProvider: this });
    const polling = setInterval(() => this.refreshRunning(), PIPELINE_POLL_MS);
    context.subscriptions.push(
      this.changeEmitter,
      this.treeView,
      { dispose: () => clearInterval(polling) },
      this.treeView.onDidChangeVisibility(() => this.refreshRunning()),
      sessions.onDidChange(() => this.changeEmitter.fire())
    );
  }

  /** Les jobs d'un pipeline qui tourne changent sans que son statut bouge : on les relit. */
  refreshRunning() {
    if (!this.treeView.visible) {
      return;
    }
    let isStale = false;
    for (const session of this.sessions.list()) {
      const sessionPipelines = this.pipelines.get(session) ?? new Map();
      for (const [pipelineId, { status }] of sessionPipelines) {
        if (RUNNING_PIPELINE_STATUSES.includes(status)) {
          sessionPipelines.delete(pipelineId);
          isStale = true;
        }
      }
    }
    if (isStale) {
      this.changeEmitter.fire();
    }
  }

  /**
   * @param {Node} [node]
   * @returns {Promise<Node[]>}
   */
  async getChildren(node) {
    if (!node) {
      const sessions = this.sessions.list();
      this.treeView.message = sessions.length === 0 ? t('No MR loaded.') : undefined;
      const pipeline = sessions.length === 1 ? sessions[0].mr.head_pipeline : undefined;
      this.treeView.description = pipeline ? `#${pipeline.id} · ${pipeline.status}` : undefined;
      if (sessions.length === 1) {
        return this.getHeadStageNodes(sessions[0]);
      }
      return sessions.map((session) => ({ kind: 'session', session }));
    }
    if (node.kind === 'session') {
      return this.getHeadStageNodes(node.session);
    }
    if (node.kind === 'stage') {
      return node.stage.jobs.map((job) => ({ kind: 'job', session: node.session, job }));
    }
    const downstream = node.job.downstream_pipeline;
    return downstream
      ? this.getStageNodes(node.session, String(downstream.project_id), downstream)
      : [];
  }

  /** @param {PipelineSession} session */
  async getHeadStageNodes(session) {
    const pipeline = session.mr.head_pipeline;
    if (!pipeline) {
      this.treeView.message = t('No pipeline on this MR.');
      return [];
    }
    return this.getStageNodes(session, session.projectPath, pipeline);
  }

  /**
   * @param {PipelineSession} session
   * @param {string} project chemin ou identifiant du projet du pipeline
   * @param {{ id: number, status: string }} pipeline
   * @returns {Promise<Node[]>}
   */
  async getStageNodes(session, project, pipeline) {
    /** @type {Map<number, { status: string, stages: Promise<import('./pipeline').Stage[]> }>} */
    const sessionPipelines = this.pipelines.get(session) ?? new Map();
    this.pipelines.set(session, sessionPipelines);
    let cached = sessionPipelines.get(pipeline.id);
    if (cached?.status !== pipeline.status) {
      cached = {
        status: pipeline.status,
        stages: session.client.listPipelineJobs(project, pipeline.id).then(groupJobsByStage),
      };
      sessionPipelines.set(pipeline.id, cached);
    }
    try {
      const stages = await cached.stages;
      return stages.map((stage) => ({ kind: 'stage', session, pipelineId: pipeline.id, stage }));
    } catch (error) {
      sessionPipelines.delete(pipeline.id);
      const reason = error instanceof Error ? error.message : String(error);
      this.treeView.message = t('Could not read the jobs of pipeline #{0}: {1}', pipeline.id, reason);
      return [];
    }
  }

  /**
   * @param {Node} node
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    if (node.kind === 'session') {
      const pipeline = node.session.mr.head_pipeline;
      const item = new vscode.TreeItem(
        `!${node.session.mr.iid} ${node.session.mr.title}`,
        pipeline ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      item.id = `session:${node.session.repoRoot}`;
      item.iconPath = getStatusIcon(pipeline?.status);
      item.description = pipeline ? `#${pipeline.id} · ${pipeline.status}` : t('no pipeline');
      return item;
    }
    if (node.kind === 'stage') {
      const { stage } = node;
      const item = new vscode.TreeItem(stage.name, getCollapsibleState(stage.status));
      // Le statut dans l'identifiant : un stage qui passe en échec se déplie, même replié à la main.
      item.id = `stage:${node.session.repoRoot}:${node.pipelineId}:${stage.name}:${stage.status}`;
      item.iconPath = getStatusIcon(stage.status);
      const failedCount = stage.jobs.filter(
        (job) => job.status === 'failed' && !isAllowedFailure(job)
      ).length;
      item.description = [
        stage.jobs.length === 1 ? t('1 job') : t('{0} jobs', stage.jobs.length),
        failedCount > 0 ? t('{0} failed', failedCount) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return item;
    }
    const { job } = node;
    const downstream = job.downstream_pipeline;
    const item = new vscode.TreeItem(
      job.name,
      downstream ? getCollapsibleState(downstream.status) : vscode.TreeItemCollapsibleState.None
    );
    item.id = `job:${job.id}:${downstream?.status ?? job.status}`;
    item.iconPath = isAllowedFailure(job)
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : getStatusIcon(job.status);
    item.description = job.duration ? formatDuration(job.duration) : job.status;
    item.tooltip = [
      job.name,
      isAllowedFailure(job)
        ? t('Status: {0} (failure allowed)', job.status)
        : t('Status: {0}', job.status),
      job.failure_reason ? t('Reason: {0}', job.failure_reason) : '',
      downstream ? t('Child pipeline #{0}', downstream.id) : t('Open the job in GitLab.'),
    ]
      .filter(Boolean)
      .join('\n');
    if (downstream) {
      // Un clic doit déplier le job : l'ouverture dans GitLab passe par le bouton de la ligne.
      item.contextValue = 'downstreamJob';
    } else if (job.web_url) {
      item.command = {
        command: 'vscode.open',
        title: t('Open in GitLab'),
        arguments: [vscode.Uri.parse(job.web_url)],
      };
    }
    return item;
  }
}

/** Un stage ou un pipeline enfant en échec ou en cours se déplie. @param {string} status */
function getCollapsibleState(status) {
  return status === 'failed' || status === 'running'
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.Collapsed;
}

/** @param {string} [status] */
function getStatusIcon(status) {
  const color = status && STATUS_COLORS[status];
  return new vscode.ThemeIcon(
    (status && PIPELINE_ICONS[status]) ?? 'circle-outline',
    color ? new vscode.ThemeColor(color) : undefined
  );
}

module.exports = { PipelineView };
