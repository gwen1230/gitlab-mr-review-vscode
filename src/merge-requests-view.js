// @ts-check
const vscode = require('vscode');
const path = require('node:path');
const { git } = require('./git');
const { readTriage, resolveTriageDirectory } = require('./triage');
const { describeMergeStatus, isMergeStatusPending } = require('./merge-status');
const { getBranchTriagePath, getTriageCommand } = require('./triage-runner');
const { reviewBranch } = require('./review-worktree');
const { t } = require('./l10n');
const {
  MERGE_REQUEST_GROUPS,
  formatAge,
  getMergeRequestGroup,
  getTriageState,
  isMergeRequestShown,
} = require('./merge-requests');

/** Âge au-delà duquel la liste est relue quand la vue redevient visible, et fréquence de relecture. */
const REFRESH_MS = 5 * 60_000;
/** Délai et nombre maximal de relectures pour afficher les états de merge recalculés par GitLab. */
const RECHECK_DELAY_MS = 10_000;
const MAX_RECHECKS = 3;

/**
 * Repo du workspace et son projet GitLab.
 * @typedef {{ repoRoot: string, projectPath: string, client: import('./gitlab').GitLabClient }} Repository
 */

/**
 * @typedef {Repository & {
 *   currentUser?: { id: number },
 *   mergeRequests: import('./merge-requests').ListedMergeRequest[],
 *   triages: Map<number, import('./triage').Triage | undefined>,
 *   error?: string,
 * }} RepositoryState
 */

/**
 * @typedef {{ kind: 'repository', state: RepositoryState }} RepositoryNode
 * @typedef {{ kind: 'group', state: RepositoryState, label: string, isExpanded: boolean, mergeRequests: import('./merge-requests').ListedMergeRequest[] }} GroupNode
 * @typedef {{ kind: 'mergeRequest' | 'author' | 'status' | 'triage' | 'review', state: RepositoryState, mr: import('./merge-requests').ListedMergeRequest }} MergeRequestNode
 * @typedef {RepositoryNode | GroupNode | MergeRequestNode} Node
 */

/**
 * Vue « MR du projet » : MR ouvertes de chaque repo du workspace, groupées (à relire par moi, mes MR,
 * autres), avec l'état de leur triage. Une MR se déplie sur son auteur, son état de merge, son triage
 * (à lancer sans checkout) et sa relecture dans VS Code.
 * @implements {vscode.TreeDataProvider<Node>}
 */
class MergeRequestsView {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {() => Promise<Repository[]>} listRepositories
   * @param {import('./triage-runner').TriageRunner} triageRunner
   */
  constructor(context, listRepositories, triageRunner) {
    this.listRepositories = listRepositories;
    this.triageRunner = triageRunner;
    /** @type {RepositoryState[] | undefined} */
    this.states = undefined;
    this.loadedAt = 0;
    this.filterText = '';
    this.isDraftHidden = false;
    this.recheckCount = 0;
    /** @type {vscode.EventEmitter<void>} */
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.treeView = vscode.window.createTreeView('mrReview.mergeRequests', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(
          resolveTriageDirectory(
            vscode.workspace.getConfiguration('mrReview').get('triageDirectory', '~/.mr-review/triage')
          )
        ),
        '*.json'
      )
    );
    const polling = setInterval(() => {
      if (this.treeView.visible && vscode.window.state.focused) {
        this.refresh();
      }
    }, REFRESH_MS);
    context.subscriptions.push(
      this.changeEmitter,
      this.treeView,
      watcher,
      { dispose: () => clearInterval(polling) },
      watcher.onDidCreate(() => this.reloadTriages()),
      watcher.onDidChange(() => this.reloadTriages()),
      watcher.onDidDelete(() => this.reloadTriages()),
      this.treeView.onDidChangeVisibility(({ visible }) => {
        if (visible && Date.now() - this.loadedAt > REFRESH_MS) {
          this.refresh();
        }
      }),
      triageRunner.onDidChange(() => this.changeEmitter.fire())
    );
  }

  /** Relit les MR au prochain affichage. */
  refresh() {
    this.states = undefined;
    this.changeEmitter.fire();
  }

  /** @param {string} filterText */
  async setFilter(filterText) {
    this.filterText = filterText.trim();
    await vscode.commands.executeCommand(
      'setContext',
      'mrReview.hasMergeRequestFilter',
      this.filterText !== ''
    );
    this.changeEmitter.fire();
  }

  /** @param {boolean} isDraftHidden */
  async setDraftHidden(isDraftHidden) {
    this.isDraftHidden = isDraftHidden;
    await vscode.commands.executeCommand('setContext', 'mrReview.draftsHidden', isDraftHidden);
    this.changeEmitter.fire();
  }

  async reloadTriages() {
    for (const state of this.states ?? []) {
      state.triages = await readTriages(state.mergeRequests);
    }
    this.changeEmitter.fire();
  }

  /** @returns {Promise<RepositoryState[]>} */
  async loadStates() {
    if (this.states) {
      return this.states;
    }
    this.loadedAt = Date.now();
    const repositories = await this.listRepositories();
    this.states = await Promise.all(
      repositories.map(async (repository) => {
        try {
          const [currentUser, mergeRequests] = await Promise.all([
            repository.client.getCurrentUser(),
            repository.client.listOpenMergeRequests(repository.projectPath),
          ]);
          return {
            ...repository,
            currentUser,
            mergeRequests,
            triages: await readTriages(mergeRequests),
          };
        } catch (error) {
          return {
            ...repository,
            mergeRequests: [],
            triages: new Map(),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
    this.scheduleMergeStatusRecheck(this.states);
    return this.states;
  }

  /**
   * La liste demande à GitLab de recalculer les états de merge pas encore calculés, en tâche de fond :
   * on la relit peu après pour les afficher, quelques fois au plus.
   * @param {RepositoryState[]} states
   */
  scheduleMergeStatusRecheck(states) {
    const hasPendingStatus = states.some((state) => state.mergeRequests.some(isMergeStatusPending));
    if (!hasPendingStatus) {
      this.recheckCount = 0;
      return;
    }
    if (this.recheckCount < MAX_RECHECKS) {
      this.recheckCount += 1;
      setTimeout(() => this.refresh(), RECHECK_DELAY_MS);
    }
  }

  /**
   * @param {Node} [node]
   * @returns {Promise<Node[]>}
   */
  async getChildren(node) {
    if (!node) {
      const states = await this.loadStates();
      this.updateHeader(states);
      return states.length === 1
        ? this.getGroups(states[0])
        : states.map((state) => ({ kind: 'repository', state }));
    }
    if (node.kind === 'repository') {
      return this.getGroups(node.state);
    }
    if (node.kind === 'group') {
      return node.mergeRequests.map((mr) => ({ kind: 'mergeRequest', state: node.state, mr }));
    }
    if (node.kind === 'mergeRequest') {
      return /** @type {const} */ (['author', 'status', 'triage', 'review']).map((kind) => ({
        kind,
        state: node.state,
        mr: node.mr,
      }));
    }
    return [];
  }

  /**
   * @param {RepositoryState} state
   * @returns {GroupNode[]}
   */
  getGroups(state) {
    const userId = state.currentUser?.id ?? -1;
    const shownMergeRequests = state.mergeRequests.filter((mr) =>
      isMergeRequestShown(mr, { filterText: this.filterText, isDraftHidden: this.isDraftHidden })
    );
    return MERGE_REQUEST_GROUPS.map(({ group, label, isExpanded }) => ({
      kind: /** @type {const} */ ('group'),
      state,
      label,
      isExpanded: isExpanded || this.filterText !== '',
      mergeRequests: shownMergeRequests.filter((mr) => getMergeRequestGroup(mr, userId) === group),
    })).filter((groupNode) => groupNode.mergeRequests.length > 0);
  }

  /** @param {RepositoryState[]} states */
  updateHeader(states) {
    const mergeRequests = states.flatMap((state) =>
      state.mergeRequests.map((mr) => ({ state, mr }))
    );
    const triagedCount = mergeRequests.filter(
      ({ state, mr }) => state.triages.get(mr.iid)?.head === mr.sha
    ).length;
    this.treeView.description = t(
      '{0} MR · {1} triaged and up to date',
      mergeRequests.length,
      triagedCount
    );
    this.treeView.message =
      [
        ...states.flatMap((state) =>
          state.error ? [t('{0}: {1}', path.basename(state.repoRoot), state.error)] : []
        ),
        this.filterText ? t('Filter: {0}', this.filterText) : '',
        this.isDraftHidden ? t('Drafts hidden') : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined;
  }

  /**
   * @param {Node} node
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    if (node.kind === 'repository') {
      const item = new vscode.TreeItem(
        path.basename(node.state.repoRoot),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `repository:${node.state.repoRoot}`;
      item.description = node.state.projectPath;
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        node.isExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      // Un identifiant propre au filtre : VS Code garde sinon l'état replié de chaque groupe.
      item.id = `group:${node.state.repoRoot}:${node.label}${this.filterText ? ':filtré' : ''}`;
      item.description = String(node.mergeRequests.length);
      return item;
    }
    const { state, mr } = node;
    const idPrefix = `mr:${state.repoRoot}:${mr.iid}`;
    const isFork = mr.source_project_id !== mr.project_id;
    const startedAt = this.triageRunner.getStartedAt(state.repoRoot, mr.iid);
    const triageState = getTriageState(state.triages.get(mr.iid), mr.sha, Boolean(startedAt));
    const mergeStatus = describeMergeStatus(mr);
    const mergeStatusIcon = new vscode.ThemeIcon(
      mergeStatus.icon,
      mergeStatus.color ? new vscode.ThemeColor(mergeStatus.color) : undefined
    );
    switch (node.kind) {
      case 'mergeRequest': {
        const item = new vscode.TreeItem(
          `!${mr.iid} ${mr.title}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = idPrefix;
        item.iconPath = mergeStatusIcon;
        item.description = [
          mr.author.name,
          triageState.kind === 'running' ? '⟳ triage…' : '',
          triageState.kind === 'current'
            ? `🔴${triageState.red}${triageState.blocking ? ` 🛑${triageState.blocking}` : ''}`
            : '',
          triageState.kind === 'stale' ? t('✨ triage outdated') : '',
        ]
          .filter(Boolean)
          .join(' · ');
        item.tooltip = new vscode.MarkdownString(
          [
            `**!${mr.iid}** ${mr.title}`,
            `$(${mergeStatus.icon}) ${mergeStatus.label}`,
            `\`${mr.source_branch}\` → \`${mr.target_branch}\``,
          ].join('\n\n'),
          true
        );
        item.contextValue = isFork ? 'mergeRequestFork' : 'mergeRequest';
        return item;
      }
      case 'author': {
        const item = new vscode.TreeItem(mr.author.name);
        item.id = `${idPrefix}:author`;
        item.iconPath = new vscode.ThemeIcon('account');
        item.description = `${mr.source_branch} → ${mr.target_branch} · ${formatAge(mr.updated_at, new Date())}`;
        return item;
      }
      case 'status': {
        const item = new vscode.TreeItem(mergeStatus.label);
        item.id = `${idPrefix}:status`;
        item.iconPath = mergeStatusIcon;
        item.tooltip = t('Open the MR in GitLab.');
        item.contextValue = 'mergeRequestStatus';
        item.command = {
          command: 'mrReview.openMergeRequestInGitLab',
          title: t('Open in GitLab'),
          arguments: [node],
        };
        return item;
      }
      case 'triage':
        return this.getTriageTreeItem(node, triageState, startedAt, isFork);
      case 'review': {
        const item = new vscode.TreeItem(t('Review in VS Code'));
        item.id = `${idPrefix}:review`;
        item.iconPath = new vscode.ThemeIcon('eye');
        if (isFork) {
          item.description = t('MR from a fork: branch not on origin');
          return item;
        }
        item.tooltip = t(
          "Open the MR's branch: its worktree, otherwise the review worktree (mrReview.reviewWorktree setting) switched to it."
        );
        item.command = {
          command: 'mrReview.reviewMergeRequest',
          title: t('Review in VS Code'),
          arguments: [node],
        };
        return item;
      }
    }
  }

  /**
   * @param {MergeRequestNode} node
   * @param {import('./merge-requests').TriageState} triageState
   * @param {Date | undefined} startedAt
   * @param {boolean} isFork
   */
  getTriageTreeItem(node, triageState, startedAt, isFork) {
    const item = new vscode.TreeItem('');
    item.id = `mr:${node.state.repoRoot}:${node.mr.iid}:triage`;
    if (isFork) {
      item.label = t('Triage unavailable');
      item.description = t('MR from a fork: branch not on origin');
      item.iconPath = new vscode.ThemeIcon('sparkle');
      return item;
    }
    if (triageState.kind === 'running') {
      item.label = t('Triage running…');
      item.description = t('since {0}', startedAt?.toLocaleTimeString().slice(0, 5) ?? '');
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      item.contextValue = 'mergeRequestTriageRunning';
      item.command = { command: 'mrReview.showTriageOutput', title: t('Show output') };
      return item;
    }
    item.iconPath = new vscode.ThemeIcon('sparkle');
    if (triageState.kind === 'none') {
      item.label = t('No triage');
      item.description = getTriageCommand() ? '' : t('mrReview.triageCommand setting is empty');
      item.contextValue = 'mergeRequestTriageNone';
      item.command = {
        command: 'mrReview.triageMergeRequest',
        title: t('Run triage'),
        arguments: [node],
      };
      return item;
    }
    item.label = triageState.kind === 'current' ? t('Triage up to date') : t('Triage outdated');
    item.description = [
      triageState.kind === 'stale' ? t('done on {0}', triageState.head.slice(0, 11)) : '',
      `🔴${triageState.red} 🟠${triageState.orange} 🟢${triageState.green}`,
      triageState.blocking ? `🛑${triageState.blocking}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    item.contextValue = 'mergeRequestTriage';
    return item;
  }

  /**
   * Lance le triage d'une MR sans la checkouter : la commande trie `origin/<branche source>`.
   * @param {MergeRequestNode} node
   */
  async runTriage(node) {
    if (!getTriageCommand()) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'mrReview.triageCommand'
      );
      return;
    }
    const { state, mr } = node;
    const { diff_refs: diffRefs } = await state.client.getMergeRequest(state.projectPath, mr.iid);
    if (!diffRefs) {
      throw new Error(t('GitLab is still preparing the diff of !{0}: try again in a moment.', mr.iid));
    }
    await git(state.repoRoot, ['fetch', 'origin', mr.source_branch, mr.target_branch]);
    const paths = (
      await git(state.repoRoot, [
        'diff',
        '--name-only',
        '-M',
        '-z',
        diffRefs.base_sha,
        diffRefs.head_sha,
      ])
    )
      .split('\0')
      .filter(Boolean);
    await this.triageRunner.run(
      { repoRoot: state.repoRoot, mr, diffRefs, paths },
      'mrReview.mergeRequests'
    );
  }

  /** @param {MergeRequestNode} node */
  async review(node) {
    await reviewBranch(node.state.repoRoot, node.mr.source_branch);
  }
}

/**
 * Triages des MR, par iid ; absent pour une MR sans triage ou au triage illisible.
 * @param {import('./merge-requests').ListedMergeRequest[]} mergeRequests
 */
async function readTriages(mergeRequests) {
  return new Map(
    await Promise.all(
      mergeRequests.map(
        async (mr) =>
          /** @type {[number, import('./triage').Triage | undefined]} */ ([
            mr.iid,
            await readTriage(getBranchTriagePath(mr.source_branch)).catch(() => undefined),
          ])
      )
    )
  );
}

module.exports = { MergeRequestsView };
