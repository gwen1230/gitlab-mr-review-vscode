// @ts-check
const vscode = require('vscode');
const path = require('node:path');
const { getTriagePath, isBlockingCheck, readTriage, resolveTriageDirectory } = require('./triage');
const { getTriageCommand } = require('./triage-runner');
const {
  NO_LOCATIONS,
  countUnresolvedByFile,
  getDocumentEntries,
  getExcerpt,
  isDiffDiscussion,
  isDiffDraft,
  isResolvable,
  isUnresolved,
} = require('./discussions');
const { describeMergeStatus } = require('./merge-status');
const { t } = require('./l10n');

const LEVEL_GROUPS = [
  { level: 'red', getLabel: () => t('🔴 Read carefully'), isExpanded: true },
  { level: 'orange', getLabel: () => t('🟠 Skim'), isExpanded: true },
  { level: 'green', getLabel: () => t('🟢 Trusted'), isExpanded: false },
];
const getUntriagedLabel = () => t('⚪ Not triaged');
/** Fichiers relus puis retouchés par un commit : ils reprennent aussi leur place dans leur groupe. */
const getChangedSinceReviewLabel = () => t('🔄 Changed since my review');
/** Schéma des fichiers supprimés dans la vue : seule cette vue reçoit leur décoration. */
const DELETED_FILE_SCHEME = 'mr-review-deleted';
/** Caractère combinant qui barre la lettre qui le précède : l'arbre ne sait pas barrer un libellé. */
const COMBINING_STRIKETHROUGH = '̶';

/**
 * Sous-ensemble de la session de revue utile à la vue (cf. `ReviewSession` dans extension.js).
 * @typedef {object} ViewSession
 * @property {string} repoRoot
 * @property {string} projectPath
 * @property {string} branch
 * @property {import('./description').DescribedMergeRequest} mr
 * @property {import('./description').GitLabUser[]} approvers
 * @property {{ head_sha: string }} diffRefs
 * @property {boolean} isHeadUpToDate
 * @property {Map<string, import('./diff').ChangedFile>} files
 * @property {Promise<any[]>} discussions
 * @property {Promise<any[]>} drafts
 * @property {Promise<import('./discussions').ThreadLocations>} threadLocations
 */

/**
 * @typedef {{ kind: 'session', session: ViewSession }} SessionNode
 * @typedef {{ kind: 'description', session: ViewSession }} DescriptionNode
 * @typedef {{ kind: 'triageAction', session: ViewSession, triage?: import('./triage').Triage }} TriageActionNode
 * @typedef {{ kind: 'group', session: ViewSession, label: string, isExpanded: boolean, files: FileNode[] }} GroupNode
 * @typedef {{ kind: 'file', session: ViewSession, path: string, line?: number, reasons?: string, checks?: import('./triage').TriageCheck[], isTriaged: boolean, parent?: GroupNode }} FileNode
 * @typedef {{ kind: 'check', session: ViewSession, path: string, check: import('./triage').TriageCheck, parent: FileNode }} CheckNode
 * @typedef {{ kind: 'discussions', session: ViewSession, entries: import('./discussions').DocumentEntry[] }} DiscussionsNode
 * @typedef {{ kind: 'discussionEntry', session: ViewSession, entry: import('./discussions').DocumentEntry, line: number, parent: DiscussionsNode }} DiscussionEntryNode
 * @typedef {SessionNode | DescriptionNode | TriageActionNode | GroupNode | FileNode | CheckNode | DiscussionsNode | DiscussionEntryNode} Node
 */

/**
 * Vue « Fichiers de la MR » : discussions générales, puis fichiers groupés par niveau de triage (sinon
 * par dossier), à cocher une fois relus. Une case cochée se décoche quand un commit retouche le fichier.
 * @implements {vscode.TreeDataProvider<Node>}
 */
class FilesView {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {object} sessions
   * @param {() => ViewSession[]} sessions.list
   * @param {() => Promise<string[]>} sessions.loadWorkspace charge la MR de chaque dossier du workspace,
   *   renvoie les erreurs
   * @param {vscode.Event<void>} sessions.onDidChange
   * @param {import('./triage-runner').TriageRunner} triageRunner
   */
  constructor(context, sessions, triageRunner) {
    this.context = context;
    this.sessions = sessions;
    this.triageRunner = triageRunner;
    /** @type {Map<string, Promise<import('./triage').Triage | undefined>>} par repo */
    this.triages = new Map();
    /** @type {Map<string, Map<string, number>>} fils non résolus par fichier, par repo */
    this.unresolvedCounts = new Map();
    /** @type {string[]} */
    this.loadErrors = [];
    this.isWorkspaceLoaded = false;
    /** Termes du filtre par chemin, séparés par des espaces : tous doivent figurer dans le chemin. */
    this.filterText = '';
    this.isUnviewedOnly = false;
    /** @type {vscode.EventEmitter<void>} */
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.treeView = vscode.window.createTreeView('mrReview.files', {
      treeDataProvider: this,
      manageCheckboxStateManually: true,
      showCollapseAll: true,
    });

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.getTriageDirectory()), '*.json')
    );
    const reloadTriages = () => {
      this.triages.clear();
      this.changeEmitter.fire();
    };
    context.subscriptions.push(
      this.changeEmitter,
      this.treeView,
      watcher,
      watcher.onDidCreate(reloadTriages),
      watcher.onDidChange(reloadTriages),
      watcher.onDidDelete(reloadTriages),
      this.treeView.onDidChangeCheckboxState((event) => this.updateViewed(event.items)),
      vscode.window.registerFileDecorationProvider({
        provideFileDecoration: (uri) =>
          uri.scheme === DELETED_FILE_SCHEME
            ? {
                badge: 'D',
                color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                tooltip: t('Deleted in the MR'),
              }
            : undefined,
      }),
      sessions.onDidChange(() => this.changeEmitter.fire()),
      triageRunner.onDidChange(() => this.changeEmitter.fire())
    );
  }

  /** @param {string} filterText */
  async setFilter(filterText) {
    this.filterText = filterText.trim();
    await vscode.commands.executeCommand('setContext', 'mrReview.hasFilter', this.hasFilter());
    this.changeEmitter.fire();
  }

  /** @param {boolean} isUnviewedOnly */
  async setUnviewedOnly(isUnviewedOnly) {
    this.isUnviewedOnly = isUnviewedOnly;
    await vscode.commands.executeCommand('setContext', 'mrReview.unviewedOnly', isUnviewedOnly);
    await vscode.commands.executeCommand('setContext', 'mrReview.hasFilter', this.hasFilter());
    this.changeEmitter.fire();
  }

  hasFilter() {
    return this.filterText !== '' || this.isUnviewedOnly;
  }

  /** Fichiers affichés par les filtres, sur toutes les MR chargées. */
  countShownFiles() {
    const files = this.sessions
      .list()
      .flatMap((session) => [...session.files.keys()].map((filePath) => ({ session, filePath })));
    return {
      shown: files.filter(({ session, filePath }) => this.isFileShown(session, filePath)).length,
      total: files.length,
    };
  }

  /**
   * @param {ViewSession} session
   * @param {string} filePath
   */
  isFileShown(session, filePath) {
    const lowerPath = filePath.toLowerCase();
    const terms = this.filterText.toLowerCase().split(/\s+/).filter(Boolean);
    return (
      terms.every((term) => lowerPath.includes(term)) &&
      !(this.isUnviewedOnly && this.isViewed(session, filePath))
    );
  }

  /**
   * Repart des MR déjà rechargées par l'extension.
   * @param {string[]} loadErrors
   */
  reset(loadErrors) {
    this.isWorkspaceLoaded = true;
    this.loadErrors = loadErrors;
    this.triages.clear();
    this.changeEmitter.fire();
  }

  getTriageDirectory() {
    return resolveTriageDirectory(
      vscode.workspace.getConfiguration('mrReview').get('triageDirectory', '~/.mr-review/triage')
    );
  }

  /**
   * @param {Node} [node]
   * @returns {Promise<Node[]>}
   */
  async getChildren(node) {
    if (!node) {
      if (!this.isWorkspaceLoaded) {
        this.isWorkspaceLoaded = true;
        this.loadErrors = await this.sessions.loadWorkspace();
      }
      const sessions = this.sessions.list();
      await this.updateHeader(sessions);
      if (sessions.length === 1) {
        return this.getSessionChildren(sessions[0]);
      }
      return sessions.map((session) => ({ kind: 'session', session }));
    }
    if (node.kind === 'session') {
      return this.getSessionChildren(node.session);
    }
    if (node.kind === 'group') {
      return node.files;
    }
    if (node.kind === 'file') {
      const checks = node.checks ?? [];
      return [
        ...checks.filter(isBlockingCheck),
        ...checks.filter((check) => !isBlockingCheck(check)),
      ].map((check) => ({
        kind: 'check',
        session: node.session,
        path: node.path,
        check,
        parent: node,
      }));
    }
    if (node.kind === 'discussions') {
      return node.entries.map((entry, index) => ({
        kind: 'discussionEntry',
        session: node.session,
        entry,
        line: index + 1,
        parent: node,
      }));
    }
    return [];
  }

  /**
   * @param {Node} node
   * @returns {Node | undefined}
   */
  getParent(node) {
    if (node.kind === 'file' || node.kind === 'check' || node.kind === 'discussionEntry') {
      return node.parent;
    }
    if (node.kind !== 'session' && this.sessions.list().length > 1) {
      return { kind: 'session', session: node.session };
    }
    return undefined;
  }

  /**
   * @param {ViewSession} session
   * @returns {Promise<Node[]>}
   */
  async getSessionChildren(session) {
    const [discussions, drafts, locations] = await Promise.all([
      session.discussions.catch(() => []),
      session.drafts.catch(() => []),
      session.threadLocations.catch(() => NO_LOCATIONS),
    ]);
    this.unresolvedCounts.set(session.repoRoot, countUnresolvedByFile(discussions, locations));
    const fileGroups = await this.getFileGroups(session);
    /** @type {GroupNode} */
    const changedSinceReviewGroup = {
      kind: 'group',
      session,
      label: getChangedSinceReviewLabel(),
      isExpanded: true,
      files: fileGroups
        .flatMap((group) => group.files)
        .filter((file) => this.isChangedSinceReview(session, file.path))
        .map((file) => ({ ...file })),
    };
    changedSinceReviewGroup.files.forEach((file) => (file.parent = changedSinceReviewGroup));
    const triage = await this.getTriage(session).catch(() => undefined);
    const isTriageActionShown =
      getTriageCommand() !== '' &&
      (this.triageRunner.getStartedAt(session.repoRoot, session.mr.iid) !== undefined ||
        triage?.head !== session.diffRefs.head_sha);
    /** @type {TriageActionNode[]} */
    const triageActions = isTriageActionShown ? [{ kind: 'triageAction', session, triage }] : [];
    return [
      { kind: 'description', session },
      ...triageActions,
      {
        kind: 'discussions',
        session,
        entries: getDocumentEntries(discussions, drafts, locations),
      },
      ...(changedSinceReviewGroup.files.length > 0 ? [changedSinceReviewGroup] : []),
      ...fileGroups,
    ];
  }

  /**
   * @param {ViewSession} session
   * @returns {Promise<GroupNode[]>}
   */
  async getFileGroups(session) {
    const triage = await this.getTriage(session);
    /** @type {GroupNode[]} */
    let groups;
    if (triage) {
      const triagedPaths = new Set(triage.files.map((file) => file.path));
      groups = LEVEL_GROUPS.map(({ level, getLabel, isExpanded }) => ({
        kind: 'group',
        session,
        label: getLabel(),
        isExpanded,
        files: triage.files
          .filter((file) => file.level === level && session.files.has(file.path))
          .map((file) => ({ kind: 'file', session, ...file, isTriaged: true })),
      }));
      groups.push({
        kind: 'group',
        session,
        label: getUntriagedLabel(),
        isExpanded: true,
        files: [...session.files.keys()]
          .filter((filePath) => !triagedPaths.has(filePath))
          .map((filePath) => ({ kind: 'file', session, path: filePath, isTriaged: false })),
      });
    } else {
      groups = this.groupByDirectory(session);
    }
    if (this.hasFilter()) {
      // Groupes dépliés pour voir tous les résultats, 🟢 compris.
      groups.forEach((group) => {
        group.files = group.files.filter((file) => this.isFileShown(session, file.path));
        group.isExpanded = true;
      });
    }
    groups = groups.filter((group) => group.files.length > 0);
    groups.forEach((group) => group.files.forEach((file) => (file.parent = group)));
    return groups;
  }

  /**
   * @param {ViewSession} session
   * @returns {GroupNode[]}
   */
  groupByDirectory(session) {
    /** @type {Map<string, FileNode[]>} */
    const directories = new Map();
    for (const filePath of [...session.files.keys()].sort()) {
      const directory = path.posix.dirname(filePath);
      const files = directories.get(directory) ?? [];
      files.push({ kind: 'file', session, path: filePath, isTriaged: false });
      directories.set(directory, files);
    }
    return [...directories].map(([directory, files]) => ({
      kind: 'group',
      session,
      label: directory,
      isExpanded: true,
      files,
    }));
  }

  /**
   * Fichiers de la MR dans l'ordre de la vue, pour la navigation fichier suivant / précédent.
   * @param {ViewSession} session
   */
  async getOrderedFiles(session) {
    return (await this.getFileGroups(session)).flatMap((group) => group.files);
  }

  /** @param {Node} node */
  async reveal(node) {
    if (this.treeView.visible) {
      await this.treeView.reveal(node, { select: true, focus: false, expand: true });
    }
  }

  /** @param {ViewSession} session */
  getTriage(session) {
    const cached = this.triages.get(session.repoRoot);
    if (cached) {
      return cached;
    }
    const triage = readTriage(getTriagePath(this.getTriageDirectory(), session.branch));
    this.triages.set(session.repoRoot, triage);
    return triage;
  }

  /**
   * @param {Node} node
   * @returns {vscode.TreeItem}
   */
  getTreeItem(node) {
    const { session } = node;
    switch (node.kind) {
      case 'session': {
        const item = new vscode.TreeItem(
          `!${session.mr.iid} ${session.mr.title}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `session:${session.repoRoot}`;
        item.description = this.formatProgress(
          [...session.files.keys()].map((filePath) => ({ session, path: filePath }))
        );
        return item;
      }
      case 'description': {
        const item = new vscode.TreeItem('📄 Description');
        item.id = `description:${session.repoRoot}`;
        const approverNames = session.approvers.map((approver) => approver.name);
        const mergeStatus = describeMergeStatus(session.mr);
        item.description = [
          mergeStatus.label,
          session.mr.author.name,
          approverNames.length > 0 ? `👍 ${approverNames.join(', ')}` : t('no approvals'),
        ].join(' · ');
        item.tooltip = new vscode.MarkdownString(
          [
            t('**Status**: $({0}) {1}', mergeStatus.icon, mergeStatus.label),
            t('**Author**: {0}', session.mr.author.name),
            t(
              '**Approved by**: {0}',
              approverNames.length > 0 ? approverNames.join(', ') : t('nobody')
            ),
            t('Open the MR description.'),
          ].join('\n\n'),
          true
        );
        item.command = {
          command: 'mrReview.openDescription',
          title: t('Open description'),
          arguments: [session.repoRoot],
        };
        return item;
      }
      case 'discussions': {
        const unresolvedCount = node.entries.filter(
          (entry) => entry.kind === 'discussion' && isUnresolved(entry.discussion)
        ).length;
        const item = new vscode.TreeItem(
          t('💬 Discussions outside code'),
          node.entries.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.id = `discussions:${session.repoRoot}`;
        item.description = t('{0} unresolved · {1}', unresolvedCount, node.entries.length);
        item.tooltip = t(
          'General discussions, threads and drafts on a previous version whose line has changed since, general drafts. Open to reply or comment on the MR.'
        );
        item.command = {
          command: 'mrReview.openDiscussions',
          title: t('Open discussions'),
          arguments: [session.repoRoot, node.entries.length + 1],
        };
        return item;
      }
      case 'triageAction': {
        const startedAt = this.triageRunner.getStartedAt(session.repoRoot, session.mr.iid);
        if (startedAt) {
          const item = new vscode.TreeItem(t('Triage running…'));
          item.id = `triageAction:${session.repoRoot}:running`;
          item.iconPath = new vscode.ThemeIcon('sync~spin');
          item.description = t('since {0}', startedAt.toLocaleTimeString().slice(0, 5));
          item.tooltip = t('Show the output of the triage command.');
          item.contextValue = 'triageRunning';
          item.command = { command: 'mrReview.showTriageOutput', title: t('Show output') };
          return item;
        }
        const item = new vscode.TreeItem(node.triage ? t('Update triage') : t('Run triage'));
        item.id = `triageAction:${session.repoRoot}`;
        item.iconPath = new vscode.ThemeIcon('sparkle');
        item.description = node.triage
          ? t('made on {0}', node.triage.head.slice(0, 11))
          : t('no triage for this branch');
        item.tooltip = t('Run the triage command (`mrReview.triageCommand` setting).');
        item.command = {
          command: 'mrReview.runTriage',
          title: t('Run triage'),
          arguments: [session.repoRoot],
        };
        return item;
      }
      case 'discussionEntry':
        return this.getDiscussionEntryTreeItem(node);
      case 'check': {
        const item = new vscode.TreeItem(
          `${isBlockingCheck(node.check) ? '🛑 ' : ''}${node.check.question}`
        );
        item.id = `check:${session.repoRoot}:${node.parent.parent?.label}:${node.path}:${node.check.line}:${node.check.question}`;
        item.description = node.check.line ? `L${node.check.line}` : '';
        item.contextValue = node.check.line ? 'triageCheck' : 'triageCheckWithoutLine';
        item.tooltip = new vscode.MarkdownString(node.check.question);
        item.checkboxState = this.isCheckDone(session, node.path, node.check)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.command = {
          command: 'mrReview.openFile',
          title: t('Open the diff at the check'),
          arguments: [session.repoRoot, node.path, node.check.line],
        };
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(
          node.label,
          node.isExpanded
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
        );
        // Un identifiant propre au filtre : VS Code garde sinon l'état replié de chaque groupe.
        item.id = `group:${session.repoRoot}:${node.label}${this.hasFilter() ? ':filtré' : ''}`;
        item.description = this.formatProgress(node.files);
        return item;
      }
      case 'file':
        return this.getFileTreeItem(node);
    }
  }

  /** @param {DiscussionEntryNode} node */
  getDiscussionEntryTreeItem(node) {
    const { session, entry } = node;
    const command = {
      command: 'mrReview.openDiscussions',
      title: t('Open discussion'),
      arguments: [session.repoRoot, node.line],
    };
    if (entry.kind === 'draft') {
      const item = new vscode.TreeItem(getExcerpt(entry.draft.note));
      item.id = `draft:${session.repoRoot}:${entry.draft.id}`;
      const { position } = entry.draft;
      item.description = isDiffDraft(entry.draft)
        ? t(
            'draft · previous version · {0}',
            path.posix.basename(position.new_path ?? position.old_path)
          )
        : t('draft');
      item.iconPath = new vscode.ThemeIcon('edit');
      item.tooltip = new vscode.MarkdownString(entry.draft.note);
      item.command = command;
      return item;
    }
    const { discussion } = entry;
    const notes = discussion.notes.filter((/** @type {any} */ note) => !note.system);
    const { position } = discussion.notes[0];
    const item = new vscode.TreeItem(getExcerpt(notes[0].body));
    item.id = `discussion:${session.repoRoot}:${discussion.id}`;
    item.description = [
      isDiffDiscussion(discussion)
        ? t('previous version · {0}', path.posix.basename(position.new_path ?? position.old_path))
        : '',
      notes[0].author.name,
      notes.length > 1 ? t('{0} reply(ies)', notes.length - 1) : '',
      isUnresolved(discussion) ? '' : isResolvable(discussion) ? t('resolved') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      isUnresolved(discussion) ? 'comment-unresolved' : 'comment'
    );
    item.tooltip = new vscode.MarkdownString(notes[0].body);
    item.command = command;
    return item;
  }

  /** @param {FileNode} node */
  getFileTreeItem(node) {
    const { session } = node;
    const changedFile = /** @type {import('./diff').ChangedFile} */ (session.files.get(node.path));
    const unresolvedCount = this.unresolvedCounts.get(session.repoRoot)?.get(node.path) ?? 0;
    const isDeleted = changedFile.status === 'D';
    const fileUri = vscode.Uri.file(path.join(session.repoRoot, node.path));
    const basename = path.posix.basename(node.path);
    const checks = node.checks ?? [];
    const doneCheckCount = checks.filter((check) =>
      this.isCheckDone(session, node.path, check)
    ).length;
    const pendingBlockingCount = this.countPendingBlockingChecks(session, node.path, checks);
    const isChangedSinceReview = this.isChangedSinceReview(session, node.path);
    // L'icône du fichier se déduit du nom, quel que soit le schéma.
    const item = new vscode.TreeItem(
      isDeleted ? fileUri.with({ scheme: DELETED_FILE_SCHEME }) : fileUri,
      checks.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    // Un fichier figure aussi dans le groupe 🔄 : l'identifiant doit rester unique dans l'arbre.
    item.id = `file:${session.repoRoot}:${node.parent?.label}:${node.path}`;
    item.contextValue = isChangedSinceReview ? 'changedSinceReview' : 'mrFile';
    item.label = isDeleted
      ? [...basename].map((character) => character + COMBINING_STRIKETHROUGH).join('')
      : basename;
    item.description = [
      changedFile.stats ? `+${changedFile.stats.added} -${changedFile.stats.deleted}` : t('binary'),
      isChangedSinceReview ? t('↻ changed since your review') : '',
      pendingBlockingCount > 0 ? `🛑 ${pendingBlockingCount}` : '',
      checks.length > 0 ? `⚑ ${doneCheckCount}/${checks.length}` : '',
      unresolvedCount > 0 ? `💬 ${unresolvedCount}` : '',
      node.isTriaged ? path.posix.dirname(node.path) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `\`${node.path}\``,
        isDeleted ? t('Deleted in the MR') : '',
        changedFile.oldPath !== node.path ? t('old path: `{0}`', changedFile.oldPath) : '',
        unresolvedCount > 0 ? t('{0} unresolved thread(s)', unresolvedCount) : '',
        node.reasons ?? '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );
    item.checkboxState = this.isViewed(session, node.path)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: isChangedSinceReview ? 'mrReview.openFileSinceReview' : 'mrReview.openFile',
      title: t('Open diff'),
      arguments: [session.repoRoot, node.path, node.line],
    };
    return item;
  }

  /** @param {ViewSession[]} sessions */
  async updateHeader(sessions) {
    const files = sessions.flatMap((session) =>
      [...session.files.keys()].map((filePath) => ({ session, path: filePath }))
    );
    const draftCount = (
      await Promise.all(sessions.map((session) => session.drafts.catch(() => [])))
    ).flat().length;
    let pendingBlockingCount = 0;
    for (const session of sessions) {
      const triage = await this.getTriage(session).catch(() => undefined);
      for (const file of triage?.files ?? []) {
        pendingBlockingCount += this.countPendingBlockingChecks(
          session,
          file.path,
          file.checks ?? []
        );
      }
    }
    this.treeView.description = [
      sessions.length === 1 ? `!${sessions[0].mr.iid}` : '',
      pendingBlockingCount ? t('🛑 {0} blocking', pendingBlockingCount) : '',
      files.length ? t('{0} viewed', this.formatProgress(files)) : '',
      draftCount ? t('{0} draft(s)', draftCount) : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const messages = sessions.length === 0 ? [...this.loadErrors] : [];
    for (const session of sessions) {
      if (!session.isHeadUpToDate) {
        messages.push(
          t(
            'The worktree is not on the latest commit of the MR ({0}): new comments are disabled until it is updated ("Update worktree" button of the view).',
            session.diffRefs.head_sha.slice(0, 11)
          )
        );
      }
      const triage = await this.getTriage(session).catch((error) => {
        messages.push(error.message);
        return undefined;
      });
      if (
        triage &&
        triage.head !== session.diffRefs.head_sha &&
        !this.triageRunner.getStartedAt(session.repoRoot, session.mr.iid)
      ) {
        const triageHead = triage.head.slice(0, 11);
        const mrHead = session.diffRefs.head_sha.slice(0, 11);
        messages.push(
          getTriageCommand()
            ? t(
                'Triage made on {0}, the MR is at {1}: use "Update triage" below to update it.',
                triageHead,
                mrHead
              )
            : t(
                'Triage made on {0}, the MR is at {1}: run the triage again to update it.',
                triageHead,
                mrHead
              )
        );
      }
    }
    this.treeView.message = messages.join('\n') || undefined;
  }

  /** @param {{ session: ViewSession, path: string }[]} files */
  formatProgress(files) {
    const viewedCount = files.filter((file) => this.isViewed(file.session, file.path)).length;
    return `${viewedCount}/${files.length}`;
  }

  /** @param {ViewSession} session */
  getViewedKey(session) {
    return `mr-review.viewed.${session.projectPath}!${session.mr.iid}`;
  }

  /** @param {ViewSession} session @param {string} filePath */
  isViewed(session, filePath) {
    return this.getViewedBlob(session, filePath) === session.files.get(filePath)?.blob;
  }

  /**
   * Empreinte du contenu relu, enregistrée en cochant le fichier.
   * @param {ViewSession} session
   * @param {string} filePath
   * @returns {string | undefined}
   */
  getViewedBlob(session, filePath) {
    /** @type {Record<string, string>} */
    const viewed = this.context.globalState.get(this.getViewedKey(session), {});
    return viewed[filePath];
  }

  /**
   * Fichier relu puis retouché par un commit : la case s'est décochée, l'ancienne empreinte reste.
   * @param {ViewSession} session
   * @param {string} filePath
   */
  isChangedSinceReview(session, filePath) {
    const viewedBlob = this.getViewedBlob(session, filePath);
    return viewedBlob !== undefined && viewedBlob !== session.files.get(filePath)?.blob;
  }

  /**
   * @param {FileNode} node
   * @param {boolean} isViewed
   */
  async setViewed(node, isViewed) {
    const key = this.getViewedKey(node.session);
    /** @type {Record<string, string>} */
    const viewed = { ...this.context.globalState.get(key, {}) };
    const blob = node.session.files.get(node.path)?.blob;
    if (isViewed && blob) {
      viewed[node.path] = blob;
    } else {
      delete viewed[node.path];
    }
    await this.context.globalState.update(key, viewed);
    this.changeEmitter.fire();
  }

  /** @param {ReadonlyArray<[Node, vscode.TreeItemCheckboxState]>} items */
  async updateViewed(items) {
    for (const [node, state] of items) {
      const isChecked = state === vscode.TreeItemCheckboxState.Checked;
      if (node.kind === 'file') {
        await this.setViewed(node, isChecked);
      } else if (node.kind === 'check') {
        await this.setCheckDone(node.session, node.path, node.check, isChecked);
      }
    }
  }

  /**
   * Points du triage tranchés, par MR : `<chemin>#<ligne>#<question>`.
   * @param {ViewSession} session
   */
  getChecksKey(session) {
    return `mr-review.checks.${session.projectPath}!${session.mr.iid}`;
  }

  /**
   * @param {string} filePath
   * @param {import('./triage').TriageCheck} check
   */
  getCheckId(filePath, check) {
    return `${filePath}#${check.line ?? ''}#${check.question}`;
  }

  /**
   * @param {ViewSession} session
   * @param {string} filePath
   * @param {import('./triage').TriageCheck} check
   */
  isCheckDone(session, filePath, check) {
    /** @type {Record<string, boolean>} */
    const doneChecks = this.context.globalState.get(this.getChecksKey(session), {});
    return Boolean(doneChecks[this.getCheckId(filePath, check)]);
  }

  /**
   * @param {ViewSession} session
   * @param {string} filePath
   * @param {import('./triage').TriageCheck} check
   * @param {boolean} isDone
   */
  async setCheckDone(session, filePath, check, isDone) {
    const key = this.getChecksKey(session);
    /** @type {Record<string, boolean>} */
    const doneChecks = { ...this.context.globalState.get(key, {}) };
    if (isDone) {
      doneChecks[this.getCheckId(filePath, check)] = true;
    } else {
      delete doneChecks[this.getCheckId(filePath, check)];
    }
    await this.context.globalState.update(key, doneChecks);
    this.changeEmitter.fire();
  }

  /**
   * @param {ViewSession} session
   * @param {string} filePath
   * @param {import('./triage').TriageCheck[]} checks
   */
  countPendingBlockingChecks(session, filePath, checks) {
    return checks.filter(
      (check) => isBlockingCheck(check) && !this.isCheckDone(session, filePath, check)
    ).length;
  }

  /**
   * Points du triage d'un fichier, pour l'éditeur.
   * @param {ViewSession} session
   * @param {string} filePath
   * @returns {Promise<import('./triage').TriageCheck[]>}
   */
  async getChecks(session, filePath) {
    const triage = await this.getTriage(session).catch(() => undefined);
    return triage?.files.find((file) => file.path === filePath)?.checks ?? [];
  }
}

module.exports = { FilesView };
