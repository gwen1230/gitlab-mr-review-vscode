// @ts-check
const vscode = require('vscode');
const path = require('node:path');
const { getTriagePath, readTriage, resolveTriageDirectory } = require('./triage');
const {
  countUnresolvedByFile,
  getDocumentEntries,
  getExcerpt,
  isDiffDiscussion,
  isResolvable,
  isUnresolved,
} = require('./discussions');

const LEVEL_GROUPS = [
  { level: 'rouge', label: '🔴 À lire', isExpanded: true },
  { level: 'orange', label: '🟠 À survoler', isExpanded: true },
  { level: 'vert', label: '🟢 En confiance', isExpanded: false },
];
const UNTRIAGED_LABEL = '⚪ Hors triage';
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
 * @property {{ iid: number, title: string }} mr
 * @property {{ head_sha: string }} diffRefs
 * @property {boolean} isHeadUpToDate
 * @property {Map<string, import('./diff').ChangedFile>} files
 * @property {Promise<any[]>} discussions
 * @property {Promise<any[]>} drafts
 */

/**
 * @typedef {{ kind: 'session', session: ViewSession }} SessionNode
 * @typedef {{ kind: 'group', session: ViewSession, label: string, isExpanded: boolean, files: FileNode[] }} GroupNode
 * @typedef {{ kind: 'file', session: ViewSession, path: string, line?: number, reasons?: string, checks?: import('./triage').TriageCheck[], isTriaged: boolean, parent?: GroupNode }} FileNode
 * @typedef {{ kind: 'check', session: ViewSession, path: string, check: import('./triage').TriageCheck, parent: FileNode }} CheckNode
 * @typedef {{ kind: 'discussions', session: ViewSession, entries: import('./discussions').DocumentEntry[] }} DiscussionsNode
 * @typedef {{ kind: 'discussionEntry', session: ViewSession, entry: import('./discussions').DocumentEntry, line: number, parent: DiscussionsNode }} DiscussionEntryNode
 * @typedef {SessionNode | GroupNode | FileNode | CheckNode | DiscussionsNode | DiscussionEntryNode} Node
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
   */
  constructor(context, sessions) {
    this.context = context;
    this.sessions = sessions;
    /** @type {Map<string, Promise<import('./triage').Triage | undefined>>} par repo */
    this.triages = new Map();
    /** @type {Map<string, Map<string, number>>} fils non résolus par fichier, par repo */
    this.unresolvedCounts = new Map();
    /** @type {string[]} */
    this.loadErrors = [];
    this.isWorkspaceLoaded = false;
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
                tooltip: 'Supprimé dans la MR',
              }
            : undefined,
      }),
      sessions.onDidChange(() => this.changeEmitter.fire())
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
      vscode.workspace.getConfiguration('mrReview').get('triageDirectory', '~/.claude/triage')
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
      return (node.checks ?? []).map((check) => ({
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
    const [discussions, drafts] = await Promise.all([
      session.discussions.catch(() => []),
      session.drafts.catch(() => []),
    ]);
    this.unresolvedCounts.set(session.repoRoot, countUnresolvedByFile(discussions, session.files));
    return [
      {
        kind: 'discussions',
        session,
        entries: getDocumentEntries(discussions, drafts, session.diffRefs.head_sha),
      },
      ...(await this.getFileGroups(session)),
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
      groups = LEVEL_GROUPS.map(({ level, label, isExpanded }) => ({
        kind: 'group',
        session,
        label,
        isExpanded,
        files: triage.files
          .filter((file) => file.level === level && session.files.has(file.path))
          .map((file) => ({ kind: 'file', session, ...file, isTriaged: true })),
      }));
      groups.push({
        kind: 'group',
        session,
        label: UNTRIAGED_LABEL,
        isExpanded: true,
        files: [...session.files.keys()]
          .filter((filePath) => !triagedPaths.has(filePath))
          .map((filePath) => ({ kind: 'file', session, path: filePath, isTriaged: false })),
      });
    } else {
      groups = this.groupByDirectory(session);
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
      case 'discussions': {
        const unresolvedCount = node.entries.filter(
          (entry) => entry.kind === 'discussion' && isUnresolved(entry.discussion)
        ).length;
        const item = new vscode.TreeItem(
          '💬 Discussions hors code',
          node.entries.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.id = `discussions:${session.repoRoot}`;
        item.description = `${unresolvedCount} non résolue(s) · ${node.entries.length}`;
        item.tooltip =
          'Discussions générales, fils posés sur une version précédente et brouillons généraux. Ouvrir pour répondre ou commenter la MR.';
        item.command = {
          command: 'mrReview.openDiscussions',
          title: 'Ouvrir les discussions',
          arguments: [session.repoRoot, node.entries.length + 1],
        };
        return item;
      }
      case 'discussionEntry':
        return this.getDiscussionEntryTreeItem(node);
      case 'check': {
        const item = new vscode.TreeItem(node.check.question);
        item.id = `check:${session.repoRoot}:${node.path}:${node.check.line}:${node.check.question}`;
        item.description = node.check.line ? `L${node.check.line}` : '';
        item.tooltip = new vscode.MarkdownString(node.check.question);
        item.checkboxState = this.isCheckDone(session, node.path, node.check)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.command = {
          command: 'mrReview.openFile',
          title: 'Ouvrir le diff sur le point',
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
        item.id = `group:${session.repoRoot}:${node.label}`;
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
      title: 'Ouvrir la discussion',
      arguments: [session.repoRoot, node.line],
    };
    if (entry.kind === 'draft') {
      const item = new vscode.TreeItem(getExcerpt(entry.draft.note));
      item.id = `draft:${session.repoRoot}:${entry.draft.id}`;
      item.description = 'brouillon';
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
        ? `version précédente · ${path.posix.basename(position.new_path ?? position.old_path)}`
        : '',
      notes[0].author.name,
      notes.length > 1 ? `${notes.length - 1} réponse(s)` : '',
      isUnresolved(discussion) ? '' : isResolvable(discussion) ? 'résolue' : '',
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
    // L'icône du fichier se déduit du nom, quel que soit le schéma.
    const checks = node.checks ?? [];
    const doneCheckCount = checks.filter((check) =>
      this.isCheckDone(session, node.path, check)
    ).length;
    const item = new vscode.TreeItem(
      isDeleted ? fileUri.with({ scheme: DELETED_FILE_SCHEME }) : fileUri,
      checks.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = `file:${session.repoRoot}:${node.path}`;
    item.label = isDeleted
      ? [...basename].map((character) => character + COMBINING_STRIKETHROUGH).join('')
      : basename;
    item.description = [
      checks.length > 0 ? `⚑ ${doneCheckCount}/${checks.length}` : '',
      unresolvedCount > 0 ? `💬 ${unresolvedCount}` : '',
      node.isTriaged ? path.posix.dirname(node.path) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `\`${node.path}\``,
        isDeleted ? 'Supprimé dans la MR' : '',
        changedFile.oldPath !== node.path ? `ancien chemin : \`${changedFile.oldPath}\`` : '',
        unresolvedCount > 0 ? `${unresolvedCount} fil(s) non résolu(s)` : '',
        node.reasons ?? '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );
    item.checkboxState = this.isViewed(session, node.path)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: 'mrReview.openFile',
      title: 'Ouvrir le diff',
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
    this.treeView.description = [
      sessions.length === 1 ? `!${sessions[0].mr.iid}` : '',
      files.length ? `${this.formatProgress(files)} relus` : '',
      draftCount ? `${draftCount} brouillon(s)` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const messages = sessions.length === 0 ? [...this.loadErrors] : [];
    for (const session of sessions) {
      if (!session.isHeadUpToDate) {
        messages.push(
          `Le worktree n'est pas sur le dernier commit de la MR (${session.diffRefs.head_sha.slice(0, 11)}) : nouveaux commentaires désactivés jusqu'au pull.`
        );
      }
      const triage = await this.getTriage(session).catch((error) => {
        messages.push(error.message);
        return undefined;
      });
      if (triage && triage.head !== session.diffRefs.head_sha) {
        messages.push(
          `Triage fait sur ${triage.head.slice(0, 11)}, la MR est à ${session.diffRefs.head_sha.slice(0, 11)} : relancez /triage-mr pour le mettre à jour.`
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
    /** @type {Record<string, string>} */
    const viewed = this.context.globalState.get(this.getViewedKey(session), {});
    return viewed[filePath] === session.files.get(filePath)?.blob;
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
