// @ts-check
const vscode = require('vscode');
const path = require('node:path');
const { git, parseRemote } = require('./src/git');
const {
  parseHunks,
  parseNumstat,
  parseRawDiff,
  toLineRangeEntry,
  toPositionLines,
} = require('./src/diff');
const { GitLabClient } = require('./src/gitlab');
const { t } = require('./src/l10n');
const {
  getToken,
  handleAuthenticationRedirect,
  invalidateToken,
  signIn,
  signOut,
} = require('./src/auth');
const { FilesView } = require('./src/files-view');
const { StatusBar } = require('./src/status-bar');
const { CheckDecorations } = require('./src/check-decorations');
const { FiltersView } = require('./src/filters-view');
const { PipelineView } = require('./src/pipeline-view');
const { TriageRunner, getTriageCommand } = require('./src/triage-runner');
const { MergeRequestsView } = require('./src/merge-requests-view');
const { renderDescriptionDocument } = require('./src/description');
const {
  getDocumentEntries,
  getExcerpt,
  getPositionSide,
  isDiffDiscussion,
  isDiffDraft,
  isResolvable,
  isUnresolved,
  locatePosition,
  renderDiscussionsDocument,
} = require('./src/discussions');

/** Côté gauche d'un fichier ajouté : document vide. */
const EMPTY_SCHEME = 'mr-review-empty';
/** Version d'un fichier telle que relue : blob git enregistré en cochant le fichier. */
const REVIEWED_SCHEME = 'mr-review-reviewed';
/** Document virtuel des discussions qui n'ont pas leur place sur une ligne de code. */
const DISCUSSIONS_SCHEME = 'mr-review-discussions';
/** Document markdown de la description de la MR, ouvert en aperçu. */
const DESCRIPTION_SCHEME = 'mr-review-description';
/** Délai avant de recharger les MR après un changement de HEAD (pull, checkout, commit). */
const HEAD_CHANGE_DELAY_MS = 1500;
/** Fréquence de relecture des MR (commits, état, pipeline, discussions), fenêtre au premier plan. */
const POLL_MS = 30_000;

/**
 * @typedef {object} ReviewSession
 * @property {string} repoRoot
 * @property {string} projectPath
 * @property {string} branch
 * @property {GitLabClient} client
 * @property {{ id: number, name: string, avatar_url?: string }} currentUser
 * @property {import('./src/description').DescribedMergeRequest & { head_pipeline?: { id: number, status: string, web_url: string } | null }} mr
 * @property {{ base_sha: string, start_sha: string, head_sha: string }} diffRefs
 * @property {boolean} isHeadUpToDate le worktree est sur le dernier commit de la MR
 * @property {import('./src/description').GitLabUser[]} approvers
 * @property {boolean} isApproved approuvée par l'utilisateur connecté
 * @property {Map<string, import('./src/diff').ChangedFile>} files fichiers de la MR, par nouveau chemin
 * @property {Map<string, Promise<import('./src/diff').Hunk[]>>} hunks
 * @property {Map<string, Promise<import('./src/diff').Hunk[]>>} versionHunks hunks d'un fichier entre
 *   une version précédente de la MR et la version courante, par `<de>..<à>:<chemin>`
 * @property {Promise<any[]>} discussions
 * @property {Promise<any[]>} drafts brouillons de review de l'utilisateur connecté
 * @property {Promise<import('./src/discussions').ThreadLocations>} threadLocations
 * @property {Set<string>} renderedUris
 * @property {vscode.CommentThread[]} threads
 */

/**
 * @typedef {{ kind: 'diff', session: ReviewSession, newPath: string, side: 'old' | 'new' }
 *   | { kind: 'discussions', session: ReviewSession }} CommentTarget
 */

/**
 * Commentaire affiché, avec ce qu'il faut pour le modifier ou le supprimer sur GitLab.
 * @typedef {vscode.Comment & { meta: CommentMeta }} ReviewComment
 * @typedef {({ kind: 'note', discussionId: string, noteId: number }
 *   | { kind: 'draft', draftId: number }
 *   | { kind: 'suggestion' }) & { savedBody: string, thread?: vscode.CommentThread }} CommentMeta
 */

/** @type {Map<string, ReviewSession>} */
const sessions = new Map();
/** @type {Map<string, Promise<ReviewSession>>} */
const pendingSessions = new Map();
/** @type {WeakMap<vscode.CommentThread, string>} */
const discussionIds = new WeakMap();
/** @type {Set<string>} `repo:head local:head MR` déjà signalés, pour n'avertir qu'une fois */
const staleHeadWarnings = new Set();
/**
 * Notes déjà vues par MR (`projet!iid`), pour signaler les nouveaux commentaires. Survit au
 * rechargement des sessions.
 * @type {Map<string, Set<number>>}
 */
const seenNoteIds = new Map();
let isPolling = false;
/** @type {vscode.EventEmitter<void>} */
const sessionsChangeEmitter = new vscode.EventEmitter();
/** @type {vscode.EventEmitter<vscode.Uri>} */
const discussionsDocumentEmitter = new vscode.EventEmitter();
/** @type {vscode.EventEmitter<vscode.Uri>} */
const descriptionDocumentEmitter = new vscode.EventEmitter();

/** @type {vscode.CommentController} */
let controller;
/** @type {any} API de l'extension git intégrée */
let gitApi;
/** @type {FilesView} */
let filesView;
/** @type {StatusBar} */
let statusBar;
/** @type {TriageRunner} */
let triageRunner;

/** @param {vscode.ExtensionContext} context */
exports.activate = (context) => {
  gitApi = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
  controller = vscode.comments.createCommentController('mr-review', t('GitLab MR'));
  controller.options = {
    prompt: t('Comment on the MR'),
    placeHolder: t('Markdown comment'),
  };
  controller.commentingRangeProvider = {
    provideCommentingRanges: getCommentingRanges,
  };
  triageRunner = new TriageRunner(context);
  filesView = new FilesView(
    context,
    {
      list: () => [...sessions.values()],
      loadWorkspace: () => loadWorkspaceSessions(context),
      onDidChange: sessionsChangeEmitter.event,
    },
    triageRunner
  );
  new FiltersView(context, filesView);
  const mergeRequestsView = new MergeRequestsView(
    context,
    () => listWorkspaceRepositories(context),
    triageRunner
  );
  new PipelineView(context, {
    list: () => [...sessions.values()],
    onDidChange: sessionsChangeEmitter.event,
  });
  statusBar = new StatusBar(
    context,
    {
      list: () => [...sessions.values()],
      findForUri: findSessionForUri,
      onDidChange: sessionsChangeEmitter.event,
    },
    triageRunner
  );
  new CheckDecorations(context, {
    findFile: (uri) => {
      const target = findCommentTarget(uri);
      return target?.kind === 'diff' && target.side === 'new'
        ? { session: target.session, path: target.newPath }
        : undefined;
    },
    filesView,
    onDidChangeSessions: sessionsChangeEmitter.event,
  });
  const polling = setInterval(() => pollSessions(context), POLL_MS);

  /**
   * @param {string} command
   * @param {(...args: any[]) => Promise<unknown>} action
   */
  const registerCommand = (command, action) =>
    vscode.commands.registerCommand(command, (...args) => run(() => action(...args)));

  context.subscriptions.push(
    controller,
    sessionsChangeEmitter,
    discussionsDocumentEmitter,
    descriptionDocumentEmitter,
    { dispose: () => clearInterval(polling) },
    vscode.window.onDidChangeWindowState((state) => state.focused && pollSessions(context)),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
    vscode.workspace.registerTextDocumentContentProvider(REVIEWED_SCHEME, {
      provideTextDocumentContent: (uri) => {
        const params = new URLSearchParams(uri.query);
        return git(params.get('repo') ?? '', ['cat-file', '-p', params.get('blob') ?? '']);
      },
    }),
    vscode.workspace.registerTextDocumentContentProvider(DISCUSSIONS_SCHEME, {
      onDidChange: discussionsDocumentEmitter.event,
      provideTextDocumentContent: provideDiscussionsDocument,
    }),
    vscode.workspace.registerTextDocumentContentProvider(DESCRIPTION_SCHEME, {
      onDidChange: descriptionDocumentEmitter.event,
      provideTextDocumentContent: (uri) => {
        const session = sessions.get(new URLSearchParams(uri.query).get('repo') ?? '');
        return session
          ? renderDescriptionDocument(session.mr, session.approvers)
          : t('MR not loaded: reopen the description from the MR Review view.');
      },
    }),
    vscode.window.registerUriHandler({
      handleUri: (uri) =>
        run(async () =>
          uri.path === '/authentication'
            ? handleAuthenticationRedirect(uri)
            : openFromUri(context, uri)
        ),
    }),
    registerCommand('mrReview.postComment', (reply) => postComment(context, reply)),
    registerCommand('mrReview.addToReview', (reply) => addToReview(context, reply)),
    registerCommand('mrReview.resolve', (thread) => resolveThread(thread, true)),
    registerCommand('mrReview.unresolve', (thread) => resolveThread(thread, false)),
    registerCommand('mrReview.editComment', async (comment) => setCommentEditing(comment, true)),
    registerCommand('mrReview.cancelEditComment', async (comment) =>
      setCommentEditing(comment, false)
    ),
    registerCommand('mrReview.saveComment', (comment) => saveComment(comment)),
    registerCommand('mrReview.deleteComment', (comment) => deleteComment(comment)),
    registerCommand('mrReview.suggestChange', () => suggestChange()),
    registerCommand('mrReview.publishSuggestion', (comment) =>
      submitSuggestion(context, comment, false)
    ),
    registerCommand('mrReview.addSuggestionToReview', (comment) =>
      submitSuggestion(context, comment, true)
    ),
    registerCommand('mrReview.cancelSuggestion', async (comment) =>
      getMeta(comment).thread?.dispose()
    ),
    registerCommand('mrReview.submitReview', () => submitReview(context)),
    registerCommand('mrReview.openFile', (repoRoot, relativePath, line) =>
      openFile(context, repoRoot, relativePath, line)
    ),
    registerCommand('mrReview.openFileSinceReview', (repoRoot, relativePath, line) =>
      openFileSinceReview(context, repoRoot, relativePath, line)
    ),
    // Boutons d'un fichier modifié depuis la relecture, dans la vue : reçoivent le nœud.
    registerCommand('mrReview.openFileSinceReviewFromView', (node) =>
      openFileSinceReview(context, node.session.repoRoot, node.path, node.line)
    ),
    registerCommand('mrReview.openFileFromView', (node) =>
      openFile(context, node.session.repoRoot, node.path, node.line)
    ),
    registerCommand('mrReview.openDiscussions', (repoRoot, line) =>
      openDiscussionsDocument(context, repoRoot, line)
    ),
    registerCommand('mrReview.openDiscussion', (repoRoot, discussionId) =>
      openDiscussion(context, repoRoot, discussionId)
    ),
    registerCommand('mrReview.updateWorktree', () => updateWorktree()),
    registerCommand('mrReview.runTriage', (repoRoot) => runTriage(context, repoRoot)),
    // Depuis le titre de la vue : aucun argument ; depuis le nœud « Triage en cours » : le nœud.
    registerCommand('mrReview.cancelTriage', async (node) =>
      triageRunner.cancel(node && { repoRoot: node.session.repoRoot, iid: node.session.mr.iid })
    ),
    registerCommand('mrReview.showTriageOutput', async () => triageRunner.output.show(true)),
    registerCommand('mrReview.refreshMergeRequests', async () => {
      mergeRequestsView.recheckCount = 0;
      mergeRequestsView.refresh();
    }),
    registerCommand('mrReview.filterMergeRequests', async () => {
      const filterText = await vscode.window.showInputBox({
        title: t('Filter project MRs'),
        placeHolder: t('Title, branch, author or !iid; separate multiple terms with spaces'),
        value: mergeRequestsView.filterText,
      });
      if (filterText !== undefined) {
        await mergeRequestsView.setFilter(filterText);
      }
    }),
    registerCommand('mrReview.clearMergeRequestFilter', () => mergeRequestsView.setFilter('')),
    registerCommand('mrReview.hideDraftMergeRequests', () =>
      mergeRequestsView.setDraftHidden(true)
    ),
    registerCommand('mrReview.showDraftMergeRequests', () =>
      mergeRequestsView.setDraftHidden(false)
    ),
    registerCommand('mrReview.triageMergeRequest', (node) => mergeRequestsView.runTriage(node)),
    registerCommand('mrReview.cancelMergeRequestTriage', async (node) =>
      triageRunner.cancel({ repoRoot: node.state.repoRoot, iid: node.mr.iid })
    ),
    registerCommand('mrReview.openMergeRequestInGitLab', async (node) => {
      await vscode.env.openExternal(vscode.Uri.parse(node.mr.web_url));
    }),
    registerCommand('mrReview.reviewMergeRequest', (node) => mergeRequestsView.review(node)),
    registerCommand('mrReview.openDescription', async (repoRoot) => {
      const session = await getSession(context, repoRoot);
      await vscode.commands.executeCommand(
        'markdown.showPreview',
        getDescriptionDocumentUri(session)
      );
    }),
    registerCommand('mrReview.toggleCheck', async (repoRoot, filePath, line, question) => {
      const session = sessions.get(repoRoot);
      if (session) {
        const check = { line, question };
        await filesView.setCheckDone(
          session,
          filePath,
          check,
          !filesView.isCheckDone(session, filePath, check)
        );
      }
    }),
    registerCommand('mrReview.commentCheck', (repoRoot, filePath, line, question) =>
      commentCheck(context, repoRoot, filePath, line, question)
    ),
    // Bouton d'un point du triage dans la vue : reçoit le nœud.
    registerCommand('mrReview.commentCheckFromView', (node) =>
      commentCheck(context, node.session.repoRoot, node.path, node.check.line, node.check.question)
    ),
    registerCommand('mrReview.filterFiles', () => filterFiles()),
    registerCommand('mrReview.clearFilter', async () => {
      await filesView.setFilter('');
      await filesView.setUnviewedOnly(false);
    }),
    registerCommand('mrReview.showUnviewedOnly', () => filesView.setUnviewedOnly(true)),
    registerCommand('mrReview.showAllFiles', () => filesView.setUnviewedOnly(false)),
    registerCommand('mrReview.nextThread', () => goToAdjacentThread(context, 1)),
    registerCommand('mrReview.previousThread', () => goToAdjacentThread(context, -1)),
    registerCommand('mrReview.nextFile', () => goToAdjacentFile(context, 1)),
    registerCommand('mrReview.previousFile', () => goToAdjacentFile(context, -1)),
    registerCommand('mrReview.openInBrowser', async () => {
      const session = statusBar.getCurrentSession();
      if (session) {
        await vscode.env.openExternal(vscode.Uri.parse(session.mr.web_url));
      }
    }),
    registerCommand('mrReview.refresh', () => reloadSessions(context)),
    registerCommand('mrReview.openDownstreamPipeline', async (node) => {
      await vscode.env.openExternal(vscode.Uri.parse(node.job.downstream_pipeline.web_url));
    }),
    registerCommand('mrReview.signIn', async () =>
      signIn(
        context,
        (await listWorkspaceRepositories(context)).map(({ client }) => client.instanceUrl)
      )
    ),
    registerCommand('mrReview.signOut', () => signOut(context)),
    vscode.workspace.onDidOpenTextDocument((document) => run(() => renderThreads(document))),
    sessionsChangeEmitter.event(() =>
      run(async () => {
        await vscode.commands.executeCommand(
          'setContext',
          'mrReview.hasSession',
          sessions.size > 0
        );
        await vscode.commands.executeCommand(
          'setContext',
          'mrReview.hasStaleWorktree',
          [...sessions.values()].some((session) => !session.isHeadUpToDate)
        );
        await Promise.all(vscode.workspace.textDocuments.map(renderThreads));
      })
    )
  );
  watchHeadChanges(context);
};

exports.deactivate = () => undefined;

/** @param {() => Promise<unknown>} action */
async function run(action) {
  try {
    await action();
  } catch (error) {
    vscode.window.showErrorMessage(
      t('MR Review: {0}', error instanceof Error ? error.message : String(error))
    );
  }
}

/**
 * Ouvre le diff d'un fichier de la MR.
 * Lien : `vscode://gwen1230.mr-review/open?repo=<racine absolue>&path=<chemin relatif>&line=<n>`.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri} uri
 */
async function openFromUri(context, uri) {
  const params = new URLSearchParams(uri.query);
  const repo = params.get('repo');
  const relativePath = params.get('path');
  if (!repo || !relativePath || !path.isAbsolute(repo)) {
    throw new Error(t('invalid link: {0}', uri.toString(true)));
  }
  const repoRoot = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  await openFile(context, repoRoot, relativePath, Number(params.get('line')) || undefined);
}

/**
 * Ouvre le diff d'un fichier de la MR, positionné sur `line` (1-based).
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @param {string} relativePath
 * @param {number} [line]
 */
async function openFile(context, repoRoot, relativePath, line) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!absolutePath.startsWith(repoRoot + path.sep)) {
    throw new Error(t('path outside the repository: {0}', relativePath));
  }
  const options = { preview: false, selection: toLineSelection(line) };

  const session = await getSession(context, repoRoot);
  const changedFile = session.files.get(relativePath);
  const head = vscode.Uri.file(absolutePath);
  if (!changedFile) {
    vscode.window.showInformationMessage(
      t('{0} is not part of MR !{1}.', relativePath, session.mr.iid)
    );
    await vscode.window.showTextDocument(head, options);
    return;
  }

  // Un fichier ajouté s'affiche face à un document vide, un fichier supprimé aussi, de l'autre côté :
  // toujours une vue diff, avec ses boutons de navigation.
  const empty = vscode.Uri.from({
    scheme: EMPTY_SCHEME,
    path: `/${relativePath}`,
    query: new URLSearchParams({ repo: repoRoot }).toString(),
  });
  /** @type {vscode.Uri} */
  const base =
    changedFile.status === 'A'
      ? empty
      : gitApi.toGitUri(
          vscode.Uri.file(path.join(repoRoot, changedFile.oldPath)),
          session.diffRefs.base_sha
        );
  const branch = changedFile.status === 'D' ? empty : head;
  const title = `${path.basename(relativePath)} (!${session.mr.iid})`;
  await vscode.commands.executeCommand('vscode.diff', base, branch, title, options);
  // Déjà ouverts avant le clic, ces documents ne repassent pas par onDidOpenTextDocument.
  const openDocuments = vscode.workspace.textDocuments.filter((document) =>
    [base.toString(), branch.toString()].includes(document.uri.toString())
  );
  await Promise.all(openDocuments.map(renderThreads));
}

/**
 * Ouvre le diff entre la version relue d'un fichier et sa version actuelle. Sans version relue
 * exploitable (fichier jamais coché, supprimé depuis, blob absent du repo local), ouvre le diff complet
 * de la MR.
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @param {string} relativePath
 * @param {number} [line]
 */
async function openFileSinceReview(context, repoRoot, relativePath, line) {
  const session = await getSession(context, repoRoot);
  const viewedBlob = filesView.getViewedBlob(session, relativePath);
  const changedFile = session.files.get(relativePath);
  const isBlobAvailable =
    viewedBlob !== undefined &&
    (await git(repoRoot, ['cat-file', '-e', `${viewedBlob}^{blob}`]).then(
      () => true,
      () => false
    ));
  if (!viewedBlob || !changedFile || changedFile.status === 'D' || !isBlobAvailable) {
    if (viewedBlob && !isBlobAvailable) {
      vscode.window.showInformationMessage(
        t(
          'Reviewed version of {0} not found in the local repository: showing the full MR diff.',
          path.basename(relativePath)
        )
      );
    }
    await openFile(context, repoRoot, relativePath, line);
    return;
  }
  const reviewed = vscode.Uri.from({
    scheme: REVIEWED_SCHEME,
    path: `/${relativePath}`,
    query: new URLSearchParams({ repo: repoRoot, blob: viewedBlob }).toString(),
  });
  const head = vscode.Uri.file(path.join(repoRoot, relativePath));
  await vscode.commands.executeCommand(
    'vscode.diff',
    reviewed,
    head,
    t('{0} (since your review)', path.basename(relativePath)),
    { preview: false, selection: toLineSelection(line) }
  );
  const headDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === head.toString()
  );
  if (headDocument) {
    await renderThreads(headDocument);
  }
}

/**
 * Diff depuis la relecture pour un fichier relu puis retouché, sinon diff complet de la MR.
 * @param {vscode.ExtensionContext} context
 * @param {ReviewSession} session
 * @param {string} relativePath
 * @param {number} [line]
 */
function openFileForReview(context, session, relativePath, line) {
  return filesView.isChangedSinceReview(session, relativePath)
    ? openFileSinceReview(context, session.repoRoot, relativePath, line)
    : openFile(context, session.repoRoot, relativePath, line);
}

/** @param {number} [line] 1-based */
function toLineSelection(line) {
  const selectedLine = Math.max((line ?? 1) - 1, 0);
  return new vscode.Range(selectedLine, 0, selectedLine, 0);
}

/**
 * Ouvre le document des discussions (générales, sur une version précédente, brouillons généraux),
 * positionné sur `line`.
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @param {number} [line]
 */
async function openDiscussionsDocument(context, repoRoot, line) {
  const session = await getSession(context, repoRoot);
  const document = await vscode.workspace.openTextDocument(getDiscussionsDocumentUri(session));
  await vscode.window.showTextDocument(document, {
    preview: false,
    selection: toLineSelection(line),
  });
  await renderThreads(document);
}

/** @param {ReviewSession} session */
function getDiscussionsDocumentUri(session) {
  return vscode.Uri.from({
    scheme: DISCUSSIONS_SCHEME,
    path: `/!${session.mr.iid} discussions`,
    query: new URLSearchParams({ repo: session.repoRoot }).toString(),
  });
}

/** @param {ReviewSession} session */
function getDescriptionDocumentUri(session) {
  return vscode.Uri.from({
    scheme: DESCRIPTION_SCHEME,
    // L'extension `.md` fait reconnaître le document comme du markdown.
    path: `/!${session.mr.iid} description.md`,
    query: new URLSearchParams({ repo: session.repoRoot }).toString(),
  });
}

/** @param {ReviewSession} session */
async function getSessionDocumentEntries(session) {
  const [discussions, drafts, locations] = await Promise.all([
    session.discussions,
    session.drafts,
    session.threadLocations,
  ]);
  return getDocumentEntries(discussions, drafts, locations);
}

/**
 * Ouvre une discussion : sur sa ligne si elle a sa place dans le code, sinon dans le document des
 * discussions.
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @param {string} discussionId
 */
async function openDiscussion(context, repoRoot, discussionId) {
  const session = await getSession(context, repoRoot);
  const location = (await session.threadLocations).discussions.get(discussionId);
  if (location) {
    await openFile(context, repoRoot, location.path, location.endLine);
    return;
  }
  const index = (await getSessionDocumentEntries(session)).findIndex(
    (entry) => entry.kind === 'discussion' && entry.discussion.id === discussionId
  );
  await openDiscussionsDocument(context, repoRoot, index + 1);
}

/** @param {vscode.Uri} uri */
async function provideDiscussionsDocument(uri) {
  const session = sessions.get(new URLSearchParams(uri.query).get('repo') ?? '');
  if (!session) {
    return t('MR not loaded: reopen the discussions from the MR Review view.');
  }
  return renderDiscussionsDocument(await getSessionDocumentEntries(session));
}

/**
 * Fichier suivant ou précédent dans l'ordre de la vue, en cochant celui qu'on quitte vers l'avant
 * (réglage `mrReview.markViewedOnNext`).
 * @param {vscode.ExtensionContext} context
 * @param {1 | -1} step
 */
async function goToAdjacentFile(context, step) {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const target = activeUri ? findCommentTarget(activeUri) : undefined;
  // Version relue (diff depuis la relecture) ou document vide (fichier ajouté ou supprimé) : le repo
  // et le chemin sont dans l'URI.
  const reviewedRepo =
    activeUri?.scheme === REVIEWED_SCHEME || activeUri?.scheme === EMPTY_SCHEME
      ? new URLSearchParams(activeUri.query).get('repo')
      : null;
  const session = target?.session ?? sessions.get(reviewedRepo ?? '') ?? [...sessions.values()][0];
  if (!session) {
    throw new Error(t('no MR loaded: open the MR Review view or a triage link.'));
  }
  const currentPath =
    target?.kind === 'diff' ? target.newPath : reviewedRepo ? activeUri?.path.slice(1) : undefined;
  const files = await filesView.getOrderedFiles(session);
  const index = currentPath ? files.findIndex((file) => file.path === currentPath) : -1;
  const isMarkViewedOnNext = vscode.workspace
    .getConfiguration('mrReview')
    .get('markViewedOnNext', true);
  if (step > 0 && index >= 0 && isMarkViewedOnNext) {
    await filesView.setViewed(files[index], true);
  }
  const nextFile = index < 0 ? files.at(step > 0 ? 0 : -1) : files[index + step];
  if (!nextFile) {
    vscode.window.showInformationMessage(
      step > 0 ? t('Last file of the MR.') : t('First file of the MR.')
    );
    return;
  }
  await openFileForReview(context, session, nextFile.path, nextFile.line);
  await filesView.reveal(nextFile);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @returns {Promise<ReviewSession>}
 */
async function getSession(context, repoRoot) {
  const existing = sessions.get(repoRoot);
  if (existing) {
    return existing;
  }
  const pending = pendingSessions.get(repoRoot) ?? createSession(context, repoRoot);
  pendingSessions.set(repoRoot, pending);
  try {
    const session = await pending;
    sessions.set(repoRoot, session);
    sessionsChangeEmitter.fire();
    return session;
  } finally {
    pendingSessions.delete(repoRoot);
  }
}

/**
 * Retrouve la MR ouverte de la branche courante, ses `diff_refs`, ses discussions et les brouillons
 * de review de l'utilisateur connecté.
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @returns {Promise<ReviewSession>}
 */
async function createSession(context, repoRoot) {
  const { projectPath, client } = await getRepository(context, repoRoot);
  const branch = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const openMr = await client.findOpenMergeRequest(projectPath, branch);
  if (!openMr) {
    throw new Error(t('no open MR for branch {0} on {1}.', branch, projectPath));
  }
  const [mr, currentUser, approvals] = await Promise.all([
    client.getMergeRequest(projectPath, openMr.iid),
    client.getCurrentUser(),
    client.getApprovals(projectPath, openMr.iid),
  ]);
  const diffRefs = mr.diff_refs;
  await ensureCommit(repoRoot, diffRefs.base_sha);
  await ensureCommit(repoRoot, diffRefs.head_sha);
  const localHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const isHeadUpToDate = localHead === diffRefs.head_sha;
  const warningKey = `${repoRoot}:${localHead}:${diffRefs.head_sha}`;
  if (!isHeadUpToDate && !staleHeadWarnings.has(warningKey)) {
    staleHeadWarnings.add(warningKey);
    vscode.window
      .showWarningMessage(
        t(
          'The worktree ({0}) is not on the latest commit of MR !{1} ({2}): new comments are disabled until it is updated.',
          localHead.slice(0, 11),
          mr.iid,
          diffRefs.head_sha.slice(0, 11)
        ),
        t('Update worktree')
      )
      .then((choice) => (choice ? run(() => updateWorktree(repoRoot)) : undefined));
  }
  const [rawDiff, numstat] = await Promise.all([
    git(repoRoot, [
      'diff',
      '-M',
      '--raw',
      '-z',
      '--no-abbrev',
      diffRefs.base_sha,
      diffRefs.head_sha,
    ]),
    git(repoRoot, ['diff', '-M', '--numstat', '-z', diffRefs.base_sha, diffRefs.head_sha]),
  ]);
  const files = parseRawDiff(rawDiff);
  for (const [newPath, stats] of parseNumstat(numstat)) {
    const changedFile = files.get(newPath);
    if (changedFile) {
      changedFile.stats = stats;
    }
  }
  /** @type {(import('./src/description').GitLabUser & { id: number })[]} */
  const approvers = (approvals.approved_by ?? []).map(
    (/** @type {any} */ approval) => approval.user
  );
  /** @type {ReviewSession} */
  const session = {
    repoRoot,
    projectPath,
    branch,
    client,
    currentUser,
    mr,
    diffRefs,
    isHeadUpToDate,
    approvers,
    isApproved: approvers.some((approver) => approver.id === currentUser.id),
    files,
    hunks: new Map(),
    versionHunks: new Map(),
    discussions: Promise.resolve([]),
    drafts: Promise.resolve([]),
    threadLocations: Promise.resolve({
      discussions: new Map(),
      drafts: new Map(),
    }),
    renderedUris: new Set(),
    threads: [],
  };
  loadReviewState(session);
  return session;
}

/**
 * Projet GitLab du remote `origin` d'un repo, et son client.
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @returns {Promise<import('./src/merge-requests-view').Repository>}
 */
async function getRepository(context, repoRoot) {
  const { instanceUrl, projectPath } = parseRemote(
    (await git(repoRoot, ['remote', 'get-url', 'origin'])).trim()
  );
  const client = new GitLabClient(
    instanceUrl,
    () => getToken(context, instanceUrl),
    () => invalidateToken(context, instanceUrl)
  );
  return { repoRoot, projectPath, client };
}

/**
 * Repos des dossiers du workspace, une fois chacun ; un dossier hors git ou sans remote GitLab est
 * ignoré.
 * @param {vscode.ExtensionContext} context
 */
async function listWorkspaceRepositories(context) {
  const repoRoots = new Set();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const repoRoot = await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel']).then(
      (output) => output.trim(),
      () => undefined
    );
    if (repoRoot) {
      repoRoots.add(repoRoot);
    }
  }
  const repositories = await Promise.all(
    [...repoRoots].map((repoRoot) => getRepository(context, repoRoot).catch(() => undefined))
  );
  return repositories.filter((repository) => repository !== undefined);
}

/**
 * Lance la lecture des discussions et des brouillons, puis leur emplacement dans le diff, et signale
 * les nouveaux commentaires. Lus plus tard par la vue et les fils : un rejet est rattrapé ici pour ne
 * pas rester non suivi d'ici là.
 * @param {ReviewSession} session
 */
function loadReviewState(session) {
  session.discussions = session.client.listDiscussions(session.projectPath, session.mr.iid);
  session.drafts = session.client.listDraftNotes(session.projectPath, session.mr.iid);
  session.threadLocations = locateThreads(session);
  return Promise.all([session.discussions, session.drafts, session.threadLocations])
    .then(([discussions]) => notifyNewNotes(session, discussions))
    .catch(() => undefined);
}

/**
 * Emplacement dans le diff courant des fils et des brouillons de code. Ceux d'une version précédente
 * suivent leur ligne si elle n'a pas changé depuis ; les autres n'ont pas d'emplacement et vont dans le
 * document des discussions.
 * @param {ReviewSession} session
 * @returns {Promise<import('./src/discussions').ThreadLocations>}
 */
async function locateThreads(session) {
  const [discussions, drafts] = await Promise.all([session.discussions, session.drafts]);
  /** @param {any} position */
  const locate = async (position) => {
    const isNewSide = getPositionSide(position) === 'new';
    const fromSha = isNewSide ? position.head_sha : position.base_sha;
    const toSha = isNewSide ? session.diffRefs.head_sha : session.diffRefs.base_sha;
    if (!fromSha || fromSha === toSha) {
      return locatePosition(position, session.files);
    }
    const filePath = isNewSide ? position.new_path : position.old_path;
    const hunks = await getVersionHunks(session, fromSha, toSha, filePath).catch(() => undefined);
    return hunks && locatePosition(position, session.files, hunks);
  };
  /** @type {import('./src/discussions').ThreadLocations} */
  const locations = { discussions: new Map(), drafts: new Map() };
  await Promise.all([
    ...discussions.filter(isDiffDiscussion).map(async (discussion) => {
      const location = await locate(discussion.notes[0].position);
      if (location) {
        locations.discussions.set(discussion.id, location);
      }
    }),
    ...drafts.filter(isDiffDraft).map(async (draft) => {
      const location = await locate(draft.position);
      if (location) {
        locations.drafts.set(draft.id, location);
      }
    }),
  ]);
  return locations;
}

/**
 * Hunks `-U0` d'un fichier entre une version précédente de la MR et la version courante. Le commit de la
 * version précédente peut manquer en local après un force-push : GitLab le garde pour ses fils.
 * @param {ReviewSession} session
 * @param {string} fromSha
 * @param {string} toSha
 * @param {string} filePath
 */
function getVersionHunks(session, fromSha, toSha, filePath) {
  const key = `${fromSha}..${toSha}:${filePath}`;
  const cached = session.versionHunks.get(key);
  if (cached) {
    return cached;
  }
  const hunks = ensureCommit(session.repoRoot, fromSha)
    .then(() =>
      git(session.repoRoot, ['diff', '-U0', '--no-color', fromSha, toSha, '--', filePath])
    )
    .then(parseHunks);
  session.versionHunks.set(key, hunks);
  return hunks;
}

/**
 * Signale les commentaires des autres apparus depuis la dernière lecture de la MR. Rien à la première
 * lecture : tout y est nouveau.
 * @param {ReviewSession} session
 * @param {any[]} discussions
 */
function notifyNewNotes(session, discussions) {
  const key = `${session.projectPath}!${session.mr.iid}`;
  const seen = seenNoteIds.get(key);
  const notes = discussions.flatMap((discussion) =>
    discussion.notes
      .filter((/** @type {any} */ note) => !note.system)
      .map((/** @type {any} */ note) => ({ discussion, note }))
  );
  seenNoteIds.set(key, new Set([...(seen ?? []), ...notes.map(({ note }) => note.id)]));
  const newNotes = seen
    ? notes.filter(({ note }) => !seen.has(note.id) && note.author.id !== session.currentUser.id)
    : [];
  if (newNotes.length === 0) {
    return;
  }
  const [{ discussion, note }] = newNotes;
  const isReply = discussion.notes.find((/** @type {any} */ first) => !first.system) !== note;
  const isOwnThread = discussion.notes[0].author.id === session.currentUser.id;
  const iid = session.mr.iid;
  const excerpt = getExcerpt(note.body);
  const message =
    newNotes.length > 1
      ? t(
          '!{0} · {1} new comments from {2}',
          iid,
          newNotes.length,
          [...new Set(newNotes.map((entry) => entry.note.author.name))].join(', ')
        )
      : !isReply
        ? t('!{0} · {1} commented: “{2}”', iid, note.author.name, excerpt)
        : isOwnThread
          ? t('!{0} · {1} replied to your thread: “{2}”', iid, note.author.name, excerpt)
          : t('!{0} · {1} replied: “{2}”', iid, note.author.name, excerpt);
  vscode.window
    .showInformationMessage(message, t('Show'))
    .then(
      (choice) =>
        choice &&
        vscode.commands.executeCommand('mrReview.openDiscussion', session.repoRoot, discussion.id)
    );
}

/**
 * Charge la MR de la branche checkoutée dans chaque dossier du workspace.
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<string[]>} une erreur par dossier sans MR chargée
 */
async function loadWorkspaceSessions(context) {
  const errors = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const repoRoot = (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
      await getSession(context, repoRoot);
    } catch (error) {
      errors.push(
        t('{0}: {1}', folder.name, error instanceof Error ? error.message : String(error))
      );
    }
  }
  return errors;
}

/**
 * Recharge les MR (nouveau commit, nouvelle branche, nouveaux commentaires) et réaffiche les fils des
 * documents ouverts.
 * @param {vscode.ExtensionContext} context
 */
async function reloadSessions(context) {
  const repoRoots = [...sessions.keys()];
  const discussionsDocumentUris = [...sessions.values()].map(getDiscussionsDocumentUri);
  const descriptionDocumentUris = [...sessions.values()].map(getDescriptionDocumentUri);
  for (const session of sessions.values()) {
    session.threads.forEach((thread) => thread.dispose());
  }
  sessions.clear();
  sessionsChangeEmitter.fire();

  const errors = await loadWorkspaceSessions(context);
  for (const repoRoot of repoRoots.filter((candidate) => !sessions.has(candidate))) {
    await getSession(context, repoRoot).catch((error) =>
      errors.push(t('{0}: {1}', path.basename(repoRoot), error.message))
    );
  }
  filesView.reset(errors);
  discussionsDocumentUris.forEach((uri) => discussionsDocumentEmitter.fire(uri));
  descriptionDocumentUris.forEach((uri) => descriptionDocumentEmitter.fire(uri));
}

/**
 * Recharge les MR quand le HEAD d'un repo change (pull, checkout, commit) : repo d'une MR chargée, ou
 * repo du workspace une fois la vue ouverte (une autre branche peut avoir une MR).
 * @param {vscode.ExtensionContext} context
 */
function watchHeadChanges(context) {
  /** @param {string} repoRoot */
  const isWatchedRepo = (repoRoot) =>
    sessions.has(repoRoot) ||
    (filesView.isWorkspaceLoaded &&
      (vscode.workspace.workspaceFolders ?? []).some(
        (folder) =>
          folder.uri.fsPath === repoRoot || folder.uri.fsPath.startsWith(repoRoot + path.sep)
      ));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reloadTimer;
  /** @param {any} repository */
  const watchRepository = (repository) => {
    const getHeadKey = () => `${repository.state.HEAD?.name}@${repository.state.HEAD?.commit}`;
    let headKey = getHeadKey();
    context.subscriptions.push(
      repository.state.onDidChange(() => {
        const newHeadKey = getHeadKey();
        if (newHeadKey === headKey) {
          return;
        }
        headKey = newHeadKey;
        if (!isWatchedRepo(repository.rootUri.fsPath)) {
          return;
        }
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => run(() => reloadSessions(context)), HEAD_CHANGE_DELAY_MS);
      })
    );
  };
  gitApi.repositories.forEach(watchRepository);
  context.subscriptions.push(gitApi.onDidOpenRepository(watchRepository), {
    dispose: () => clearTimeout(reloadTimer),
  });
}

/**
 * Relit les MR chargées, fenêtre au premier plan seulement : nouveaux commits ou nouvelle cible
 * (rechargement complet), état de merge et pipeline, discussions. Silencieux en cas d'échec réseau.
 * @param {vscode.ExtensionContext} context
 */
async function pollSessions(context) {
  if (isPolling || !vscode.window.state.focused) {
    return;
  }
  isPolling = true;
  try {
    for (const session of [...sessions.values()]) {
      if (sessions.get(session.repoRoot) !== session) {
        continue;
      }
      const mr = await session.client.getMergeRequest(session.projectPath, session.mr.iid);
      // Sans `diff_refs`, GitLab prépare encore le diff d'un push : on attend le tick suivant.
      if (!mr.diff_refs) {
        continue;
      }
      if (!hasSameDiffRefs(mr.diff_refs, session.diffRefs)) {
        await reloadSessions(context);
        return;
      }
      if (getMergeRequestSignature(mr) !== getMergeRequestSignature(session.mr)) {
        session.mr = mr;
        sessionsChangeEmitter.fire();
        descriptionDocumentEmitter.fire(getDescriptionDocumentUri(session));
      }
      await reloadReviewState(session);
    }
  } catch {
    // Prochaine tentative au tick suivant.
  } finally {
    isPolling = false;
  }
}

/**
 * @param {{ base_sha: string, start_sha: string, head_sha: string }} first
 * @param {{ base_sha: string, start_sha: string, head_sha: string }} second
 */
function hasSameDiffRefs(first, second) {
  return (
    first.base_sha === second.base_sha &&
    first.start_sha === second.start_sha &&
    first.head_sha === second.head_sha
  );
}

/**
 * Ce qui, dans la MR, change l'affichage hors diff : titre, description, état de merge, pipeline.
 * @param {any} mr
 */
function getMergeRequestSignature(mr) {
  return JSON.stringify([
    mr.title,
    mr.description,
    mr.state,
    mr.draft,
    mr.detailed_merge_status,
    mr.head_pipeline?.id,
    mr.head_pipeline?.status,
  ]);
}

/**
 * Aligne le worktree sur le dernier commit de la MR : avance rapide si la branche locale est en
 * retard, sinon remplacement après confirmation (branche rebasée ou force-pushée sur GitLab). Refuse
 * avec des modifications non commitées, ou des commits locaux qui ne sont qu'à pousser.
 * @param {string} [repoRoot] sinon la MR de l'éditeur actif, ou la première pas à jour
 */
async function updateWorktree(repoRoot) {
  const current = statusBar.getCurrentSession();
  const session = repoRoot
    ? sessions.get(repoRoot)
    : current && !current.isHeadUpToDate
      ? current
      : [...sessions.values()].find((candidate) => !candidate.isHeadUpToDate);
  if (!session || session.isHeadUpToDate) {
    vscode.window.showInformationMessage(
      t('The worktree is already on the latest commit of the MR.')
    );
    return;
  }
  const headSha = session.diffRefs.head_sha;
  const sourceBranch = session.mr.source_branch;
  const branch = (await git(session.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (branch !== sourceBranch) {
    throw new Error(t('the worktree is on {0}, not on the MR branch ({1}).', branch, sourceBranch));
  }
  const changes = await git(session.repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (changes.trim()) {
    throw new Error(
      t('the worktree has uncommitted changes: commit or stash them, then try again.')
    );
  }
  // Met aussi à jour la branche de suivi `origin/<branche>`.
  await git(session.repoRoot, ['fetch', 'origin', sourceBranch]).catch(() => undefined);
  await ensureCommit(session.repoRoot, headSha);
  /** @param {string} ancestor @param {string} descendant */
  const isAncestor = (ancestor, descendant) =>
    git(session.repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]).then(
      () => true,
      () => false
    );
  if (await isAncestor('HEAD', headSha)) {
    await git(session.repoRoot, ['merge', '--ff-only', headSha]);
    return;
  }
  const localCommits = (
    await git(session.repoRoot, ['log', '--format=%h %s', `${headSha}..HEAD`])
  ).trim();
  if (await isAncestor(headSha, 'HEAD')) {
    throw new Error(
      t(
        '{0} has local commits that are not in the MR: push them and the MR will update.\n{1}',
        branch,
        localCommits
      )
    );
  }
  const alignLabel = t('Align with MR');
  const confirmation = await vscode.window.showWarningMessage(
    t(
      '{0} was rewritten on GitLab (rebase or force-push). Align the worktree with the MR ({1})?',
      branch,
      headSha.slice(0, 11)
    ),
    {
      modal: true,
      detail: t(
        'These local commits, absent from the MR, will leave the branch (recoverable with git reflog). After a rebase, they are usually the old versions of the MR commits:\n{0}',
        localCommits
      ),
    },
    alignLabel
  );
  if (confirmation === alignLabel) {
    await git(session.repoRoot, ['reset', '--keep', headSha]);
  }
}

/**
 * Lance la commande de triage sur la MR de la branche checkoutée. Le triage porte sur la branche de la
 * MR sur `origin` : le worktree n'a pas besoin d'être à jour.
 * @param {vscode.ExtensionContext} context
 * @param {string} [repoRoot] sinon la MR de l'éditeur actif
 */
async function runTriage(context, repoRoot) {
  if (!getTriageCommand()) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'mrReview.triageCommand');
    return;
  }
  const session = repoRoot ? await getSession(context, repoRoot) : statusBar.getCurrentSession();
  if (!session) {
    throw new Error(t('no MR loaded.'));
  }
  await triageRunner.run(
    {
      repoRoot: session.repoRoot,
      mr: session.mr,
      diffRefs: session.diffRefs,
      paths: [...session.files.keys()],
    },
    'mrReview.files'
  );
}

/** @param {string} repoRoot @param {string} sha */
async function ensureCommit(repoRoot, sha) {
  try {
    await git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    await git(repoRoot, ['fetch', 'origin', sha]);
  }
}

/**
 * Ce que représente ce document pour une MR chargée : un côté du diff d'un fichier, ou le document des
 * discussions.
 * @param {vscode.Uri} uri
 * @returns {CommentTarget | undefined}
 */
function findCommentTarget(uri) {
  if (uri.scheme === DISCUSSIONS_SCHEME) {
    const session = sessions.get(new URLSearchParams(uri.query).get('repo') ?? '');
    return session && { kind: 'discussions', session };
  }
  if (uri.scheme === 'file') {
    for (const session of sessions.values()) {
      const relativePath = path.relative(session.repoRoot, uri.fsPath).split(path.sep).join('/');
      const changedFile = session.files.get(relativePath);
      if (changedFile && changedFile.status !== 'D' && !relativePath.startsWith('..')) {
        return { kind: 'diff', session, newPath: relativePath, side: 'new' };
      }
    }
    return undefined;
  }
  if (uri.scheme === 'git') {
    /** @type {{ path?: string, ref?: string }} */
    let query;
    try {
      query = JSON.parse(uri.query);
    } catch {
      return undefined;
    }
    for (const session of sessions.values()) {
      if (!query.path || query.ref !== session.diffRefs.base_sha) {
        continue;
      }
      const oldPath = path.relative(session.repoRoot, query.path).split(path.sep).join('/');
      for (const [newPath, changedFile] of session.files) {
        if (changedFile.oldPath === oldPath && changedFile.status !== 'A') {
          return { kind: 'diff', session, newPath, side: 'old' };
        }
      }
    }
  }
  return undefined;
}

/**
 * MR à laquelle appartient un document, même hors des fichiers modifiés.
 * @param {vscode.Uri} uri
 */
function findSessionForUri(uri) {
  const target = findCommentTarget(uri);
  if (target) {
    return target.session;
  }
  return [...sessions.values()].find(
    (session) => uri.scheme === 'file' && uri.fsPath.startsWith(session.repoRoot + path.sep)
  );
}

/** @param {vscode.TextDocument} document */
function getCommentingRanges(document) {
  const target = findCommentTarget(document.uri);
  if (target?.kind === 'discussions') {
    const lastLine = document.lineCount - 1;
    return [new vscode.Range(lastLine, 0, lastLine, 0)];
  }
  if (!target?.session.isHeadUpToDate) {
    return [];
  }
  return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
}

/** @param {ReviewSession} session @param {string} newPath */
function getHunks(session, newPath) {
  const cached = session.hunks.get(newPath);
  if (cached) {
    return cached;
  }
  const { oldPath } = /** @type {import('./src/diff').ChangedFile} */ (session.files.get(newPath));
  const paths = oldPath === newPath ? [newPath] : [oldPath, newPath];
  const hunks = git(session.repoRoot, [
    'diff',
    '-M',
    '-U0',
    '--no-color',
    session.diffRefs.base_sha,
    session.diffRefs.head_sha,
    '--',
    ...paths,
  ]).then(parseHunks);
  session.hunks.set(newPath, hunks);
  return hunks;
}

/**
 * Affiche les discussions et les brouillons de la MR qui portent sur ce document. Les fils d'une
 * version précédente dont la ligne a changé depuis vont dans le document des discussions.
 * @param {vscode.TextDocument} document
 */
async function renderThreads(document) {
  const target = findCommentTarget(document.uri);
  const uriKey = document.uri.toString();
  if (!target || target.session.renderedUris.has(uriKey)) {
    return;
  }
  const { session } = target;
  session.renderedUris.add(uriKey);
  const [discussions, drafts, locations] = await Promise.all([
    session.discussions,
    session.drafts,
    session.threadLocations,
  ]);
  /** @type {Map<string, vscode.CommentThread>} */
  const threadsByDiscussion = new Map();

  if (target.kind === 'discussions') {
    const entries = await getSessionDocumentEntries(session);
    entries.forEach((entry, index) => {
      if (entry.kind === 'discussion') {
        threadsByDiscussion.set(
          entry.discussion.id,
          createDiscussionThread(session, document.uri, index + 1, index + 1, entry.discussion)
        );
      } else {
        createDraftThread(session, document.uri, index + 1, index + 1, entry.draft);
      }
    });
  } else {
    for (const discussion of discussions) {
      const location = locations.discussions.get(discussion.id);
      if (location && isLocatedOn(location, target)) {
        threadsByDiscussion.set(
          discussion.id,
          createDiscussionThread(
            session,
            document.uri,
            location.startLine,
            location.endLine,
            discussion
          )
        );
      }
    }
    for (const draft of drafts) {
      const location = locations.drafts.get(draft.id);
      if (location && isLocatedOn(location, target)) {
        createDraftThread(session, document.uri, location.startLine, location.endLine, draft);
      }
    }
  }

  for (const draft of drafts) {
    const thread = threadsByDiscussion.get(draft.discussion_id);
    if (thread) {
      setThreadComments(thread, [...thread.comments, draftToComment(draft, session)]);
    }
  }
}

/**
 * @param {import('./src/discussions').ThreadLocation} location
 * @param {CommentTarget & { kind: 'diff' }} target
 */
function isLocatedOn(location, target) {
  return location.path === target.newPath && location.side === target.side;
}

/**
 * Met les fils affichés au niveau des discussions relues, sans recréer ceux qui n'ont pas changé :
 * nouvelles réponses et état résolu dans les fils existants (sauf commentaire en cours d'édition),
 * nouveaux fils sur les documents de code déjà affichés. Le document des discussions, dont les lignes
 * se décalent avec ses entrées, est réaffiché si ses entrées ont changé.
 * @param {ReviewSession} session
 * @param {Set<string>} previousDiscussionIds
 * @param {string} previousEntriesKey entrées du document des discussions avant relecture
 */
async function refreshThreads(session, previousDiscussionIds, previousEntriesKey) {
  const [discussions, drafts, locations] = await Promise.all([
    session.discussions,
    session.drafts,
    session.threadLocations,
  ]);
  const discussionsById = new Map(discussions.map((discussion) => [discussion.id, discussion]));
  for (const thread of session.threads) {
    const discussion = discussionsById.get(discussionIds.get(thread) ?? '');
    if (
      !discussion ||
      thread.comments.some((comment) => comment.mode === vscode.CommentMode.Editing)
    ) {
      continue;
    }
    const notes = discussion.notes.filter((/** @type {any} */ note) => !note.system);
    const shownNotes = thread.comments.flatMap((comment) => {
      const meta = getMeta(comment);
      return meta.kind === 'note' ? [{ id: meta.noteId, body: meta.savedBody }] : [];
    });
    /** @param {{ id: number, body: string }[]} noteList */
    const toNotesKey = (noteList) => JSON.stringify(noteList.map(({ id, body }) => [id, body]));
    if (toNotesKey(notes) !== toNotesKey(shownNotes)) {
      setThreadComments(thread, [
        ...notes.map((/** @type {any} */ note) => noteToComment(note, discussion.id, session)),
        ...drafts
          .filter((draft) => draft.discussion_id === discussion.id)
          .map((draft) => draftToComment(draft, session)),
      ]);
    }
    const resolvedState = discussion.notes[0].resolved ? 'resolved' : 'unresolved';
    if (isResolvable(discussion) && thread.contextValue !== resolvedState) {
      setThreadState(thread, discussion);
    }
  }

  // Un fil qu'on vient de publier est déjà affiché.
  const shownDiscussionIds = new Set(session.threads.map((thread) => discussionIds.get(thread)));
  const newDiscussions = discussions.filter(
    (discussion) =>
      !previousDiscussionIds.has(discussion.id) && !shownDiscussionIds.has(discussion.id)
  );
  for (const document of vscode.workspace.textDocuments) {
    const target = findCommentTarget(document.uri);
    if (
      target?.kind !== 'diff' ||
      target.session !== session ||
      !session.renderedUris.has(document.uri.toString())
    ) {
      continue;
    }
    for (const discussion of newDiscussions) {
      const location = locations.discussions.get(discussion.id);
      if (location && isLocatedOn(location, target)) {
        createDiscussionThread(
          session,
          document.uri,
          location.startLine,
          location.endLine,
          discussion
        );
      }
    }
  }

  const discussionsDocumentUri = getDiscussionsDocumentUri(session);
  if (getEntriesKey(await getSessionDocumentEntries(session)) !== previousEntriesKey) {
    const uriKey = discussionsDocumentUri.toString();
    const documentThreads = session.threads.filter((thread) => thread.uri.toString() === uriKey);
    documentThreads.forEach((thread) => thread.dispose());
    session.threads = session.threads.filter((thread) => !documentThreads.includes(thread));
    session.renderedUris.delete(uriKey);
    discussionsDocumentEmitter.fire(discussionsDocumentUri);
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uriKey
    );
    if (document) {
      await renderThreads(document);
    }
  } else {
    discussionsDocumentEmitter.fire(discussionsDocumentUri);
  }
}

/** @param {import('./src/discussions').DocumentEntry[]} entries */
function getEntriesKey(entries) {
  return entries
    .map((entry) => (entry.kind === 'draft' ? `draft:${entry.draft.id}` : entry.discussion.id))
    .join();
}

/**
 * @param {ReviewSession} session
 * @param {vscode.Uri} uri
 * @param {number} startLine 1-based
 * @param {number} endLine 1-based
 * @param {any} discussion
 */
function createDiscussionThread(session, uri, startLine, endLine, discussion) {
  const thread = controller.createCommentThread(uri, toThreadRange(startLine, endLine), []);
  setThreadComments(
    thread,
    discussion.notes
      .filter((/** @type {any} */ note) => !note.system)
      .map((/** @type {any} */ note) => noteToComment(note, discussion.id, session))
  );
  thread.canReply = true;
  discussionIds.set(thread, discussion.id);
  setThreadState(thread, discussion);
  session.threads.push(thread);
  return thread;
}

/**
 * Fil d'un brouillon qui ouvre une discussion : on ne peut pas y répondre avant publication.
 * @param {ReviewSession} session
 * @param {vscode.Uri} uri
 * @param {number} startLine 1-based
 * @param {number} endLine 1-based
 * @param {any} draft
 */
function createDraftThread(session, uri, startLine, endLine, draft) {
  const thread = controller.createCommentThread(uri, toThreadRange(startLine, endLine), []);
  setThreadComments(thread, [draftToComment(draft, session)]);
  markDraftThread(thread);
  session.threads.push(thread);
  return thread;
}

/** @param {vscode.CommentThread} thread */
function markDraftThread(thread) {
  thread.canReply = false;
  thread.contextValue = 'draftThread';
  thread.label = t('Draft');
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

/** @param {number} startLine 1-based @param {number} endLine 1-based */
function toThreadRange(startLine, endLine) {
  return new vscode.Range(Math.min(startLine, endLine) - 1, 0, endLine - 1, 0);
}

/**
 * Remplace les commentaires d'un fil, en rattachant chacun à son fil pour les commandes de commentaire.
 * @param {vscode.CommentThread} thread
 * @param {readonly vscode.Comment[]} comments
 */
function setThreadComments(thread, comments) {
  comments.forEach((comment) => (getMeta(comment).thread = thread));
  thread.comments = comments;
}

/** @param {vscode.Comment} comment */
function getMeta(comment) {
  return /** @type {ReviewComment} */ (comment).meta;
}

/**
 * @param {any} note
 * @param {string} discussionId
 * @param {ReviewSession} session
 * @returns {ReviewComment}
 */
function noteToComment(note, discussionId, session) {
  return {
    body: new vscode.MarkdownString(note.body),
    mode: vscode.CommentMode.Preview,
    author: {
      name: note.author.name,
      iconPath: note.author.avatar_url ? vscode.Uri.parse(note.author.avatar_url) : undefined,
    },
    timestamp: new Date(note.created_at),
    contextValue: note.author.id === session.currentUser.id ? 'own' : undefined,
    meta: { kind: 'note', discussionId, noteId: note.id, savedBody: note.body },
  };
}

/**
 * @param {any} draft
 * @param {ReviewSession} session
 * @returns {ReviewComment}
 */
function draftToComment(draft, session) {
  return {
    body: new vscode.MarkdownString(draft.note),
    mode: vscode.CommentMode.Preview,
    author: {
      name: session.currentUser.name,
      iconPath: session.currentUser.avatar_url
        ? vscode.Uri.parse(session.currentUser.avatar_url)
        : undefined,
    },
    label: t('Draft'),
    contextValue: 'draftNote',
    meta: { kind: 'draft', draftId: draft.id, savedBody: draft.note },
  };
}

/**
 * Bouton résoudre / rouvrir, libellé et repli selon l'état de la discussion.
 * @param {vscode.CommentThread} thread
 * @param {any} discussion
 */
function setThreadState(thread, discussion) {
  if (!isResolvable(discussion)) {
    thread.contextValue = 'notResolvable';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return;
  }
  setThreadResolved(thread, Boolean(discussion.notes[0].resolved));
}

/** @param {vscode.CommentThread} thread @param {boolean} isResolved */
function setThreadResolved(thread, isResolved) {
  thread.contextValue = isResolved ? 'resolved' : 'unresolved';
  thread.label = isResolved ? t('Resolved') : undefined;
  thread.state = isResolved
    ? vscode.CommentThreadState.Resolved
    : vscode.CommentThreadState.Unresolved;
  thread.collapsibleState = isResolved
    ? vscode.CommentThreadCollapsibleState.Collapsed
    : vscode.CommentThreadCollapsibleState.Expanded;
}

/** @param {vscode.CommentThread} thread */
function requireCommentTarget(thread) {
  const target = findCommentTarget(thread.uri);
  if (!target) {
    throw new Error(t('this document does not belong to any open MR.'));
  }
  return target;
}

/**
 * Publie tout de suite un nouveau fil, ou une réponse si le fil existe déjà sur la MR.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.CommentReply} reply
 */
async function postComment(context, { thread, text }) {
  const target = requireCommentTarget(thread);
  const { session } = target;
  const discussionId = discussionIds.get(thread);
  if (discussionId) {
    const note = await session.client.addNote(
      session.projectPath,
      session.mr.iid,
      discussionId,
      text
    );
    setThreadComments(thread, [...thread.comments, noteToComment(note, discussionId, session)]);
  } else {
    const position = await buildPosition(context, target, thread);
    const discussion = await session.client.createDiscussion(
      session.projectPath,
      session.mr.iid,
      text,
      position
    );
    attachDiscussion(session, thread, discussion);
  }
  reloadReviewState(session);
}

/**
 * Ajoute le commentaire à la review en cours (brouillon), à publier avec « Soumettre la review ».
 * @param {vscode.ExtensionContext} context
 * @param {vscode.CommentReply} reply
 */
async function addToReview(context, { thread, text }) {
  const target = requireCommentTarget(thread);
  const { session } = target;
  const discussionId = discussionIds.get(thread);
  const draft = await session.client.createDraftNote(
    session.projectPath,
    session.mr.iid,
    discussionId
      ? { note: text, in_reply_to_discussion_id: discussionId }
      : { note: text, position: await buildPosition(context, target, thread) }
  );
  if (!discussionId) {
    markDraftThread(thread);
    session.threads.push(thread);
  }
  setThreadComments(thread, [...thread.comments, draftToComment(draft, session)]);
  reloadReviewState(session);
}

/**
 * Position GitLab d'un nouveau fil : aucune pour une discussion générale, sinon les lignes du fil
 * (`line_range` quand il en couvre plusieurs). Vérifie d'abord que la MR n'a pas bougé sur GitLab
 * depuis son chargement : le fil serait sinon posé sur une version déjà dépassée.
 * @param {vscode.ExtensionContext} context
 * @param {CommentTarget} target
 * @param {vscode.CommentThread} thread
 */
async function buildPosition(context, target, thread) {
  if (target.kind === 'discussions') {
    return undefined;
  }
  const { session } = target;
  if (!session.isHeadUpToDate) {
    throw new Error(t('the worktree is not on the latest commit of the MR.'));
  }
  if (!thread.range) {
    throw new Error(t('thread has no line.'));
  }
  const { diff_refs: latestDiffRefs } = await session.client.getMergeRequest(
    session.projectPath,
    session.mr.iid
  );
  if (!latestDiffRefs || !hasSameDiffRefs(latestDiffRefs, session.diffRefs)) {
    run(() => reloadSessions(context));
    throw new Error(
      t(
        '!{0} changed on GitLab since it was loaded (new commits or rebase): comment not posted. The MR is reloading; update the worktree, then comment again.',
        session.mr.iid
      )
    );
  }
  const hunks = await getHunks(session, target.newPath);
  const startLine = thread.range.start.line + 1;
  const endLine = thread.range.end.line + 1;
  return {
    position_type: 'text',
    base_sha: session.diffRefs.base_sha,
    start_sha: session.diffRefs.start_sha,
    head_sha: session.diffRefs.head_sha,
    old_path: session.files.get(target.newPath)?.oldPath,
    new_path: target.newPath,
    ...toPositionLines(hunks, target.side, endLine),
    ...(endLine > startLine && {
      line_range: {
        start: toLineRangeEntry(hunks, target.side, startLine, target.newPath),
        end: toLineRangeEntry(hunks, target.side, endLine, target.newPath),
      },
    }),
  };
}

/**
 * Rattache un fil local à la discussion GitLab qui vient d'être créée.
 * @param {ReviewSession} session
 * @param {vscode.CommentThread} thread
 * @param {any} discussion
 */
function attachDiscussion(session, thread, discussion) {
  discussionIds.set(thread, discussion.id);
  setThreadComments(
    thread,
    discussion.notes.map((/** @type {any} */ note) => noteToComment(note, discussion.id, session))
  );
  thread.canReply = true;
  setThreadState(thread, discussion);
  session.threads.push(thread);
}

/**
 * Relit discussions et brouillons : fils affichés, compteurs de la vue et de la barre d'état, document
 * des discussions, nouveaux commentaires signalés. Silencieux en cas d'échec : l'action qui l'a
 * déclenchée a abouti.
 * @param {ReviewSession} session
 */
async function reloadReviewState(session) {
  try {
    const previousDiscussions = await session.discussions.catch(() => []);
    const previousStateKey = getReviewStateKey(
      previousDiscussions,
      await session.drafts.catch(() => [])
    );
    const previousEntriesKey = getEntriesKey(
      await getSessionDocumentEntries(session).catch(() => [])
    );
    await loadReviewState(session);
    const [discussions, drafts] = await Promise.all([session.discussions, session.drafts]);
    if (getReviewStateKey(discussions, drafts) === previousStateKey) {
      return;
    }
    await refreshThreads(
      session,
      new Set(previousDiscussions.map((discussion) => discussion.id)),
      previousEntriesKey
    );
    sessionsChangeEmitter.fire();
  } catch {
    // Relu au prochain tick de pollSessions.
  }
}

/**
 * Ce qui change l'affichage des discussions et des brouillons : notes, textes, état résolu.
 * @param {any[]} discussions
 * @param {any[]} drafts
 */
function getReviewStateKey(discussions, drafts) {
  return JSON.stringify([
    discussions.map((discussion) => [
      discussion.id,
      discussion.notes.map((/** @type {any} */ note) => [note.id, note.body, note.resolved]),
    ]),
    drafts.map((draft) => [draft.id, draft.note]),
  ]);
}

/** @param {vscode.CommentThread} thread @param {boolean} isResolved */
async function resolveThread(thread, isResolved) {
  const target = findCommentTarget(thread.uri);
  const discussionId = discussionIds.get(thread);
  if (!target || !discussionId) {
    return;
  }
  await target.session.client.setResolved(
    target.session.projectPath,
    target.session.mr.iid,
    discussionId,
    isResolved
  );
  setThreadResolved(thread, isResolved);
  reloadReviewState(target.session);
}

/**
 * Passe un de ses commentaires (ou brouillons) en édition, ou annule l'édition.
 * @param {vscode.Comment} comment
 * @param {boolean} isEditing
 */
function setCommentEditing(comment, isEditing) {
  const meta = getMeta(comment);
  comment.mode = isEditing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
  if (!isEditing) {
    comment.body = new vscode.MarkdownString(meta.savedBody);
  }
  if (meta.thread) {
    setThreadComments(meta.thread, [...meta.thread.comments]);
  }
}

/** @param {vscode.Comment} comment */
function getCommentText(comment) {
  return typeof comment.body === 'string' ? comment.body : comment.body.value;
}

/**
 * Enregistre sur GitLab le texte modifié d'un commentaire ou d'un brouillon.
 * @param {vscode.Comment} comment
 */
async function saveComment(comment) {
  const meta = getMeta(comment);
  const target = meta.thread && findCommentTarget(meta.thread.uri);
  if (!target || !meta.thread) {
    return;
  }
  const { session } = target;
  const text = getCommentText(comment);
  if (meta.kind === 'note') {
    await session.client.updateNote(
      session.projectPath,
      session.mr.iid,
      meta.discussionId,
      meta.noteId,
      text
    );
  } else if (meta.kind === 'draft') {
    await session.client.updateDraftNote(session.projectPath, session.mr.iid, meta.draftId, text);
  }
  meta.savedBody = text;
  comment.body = new vscode.MarkdownString(text);
  comment.mode = vscode.CommentMode.Preview;
  setThreadComments(meta.thread, [...meta.thread.comments]);
  reloadReviewState(session);
}

/**
 * Supprime sur GitLab un de ses commentaires ou brouillons, après confirmation.
 * @param {vscode.Comment} comment
 */
async function deleteComment(comment) {
  const meta = getMeta(comment);
  const target = meta.thread && findCommentTarget(meta.thread.uri);
  if (!target || !meta.thread) {
    return;
  }
  const isDraft = meta.kind === 'draft';
  const deleteLabel = t('Delete');
  const confirmation = await vscode.window.showWarningMessage(
    isDraft ? t('Delete this draft?') : t('Delete this comment from the MR?'),
    { modal: true },
    deleteLabel
  );
  if (confirmation !== deleteLabel) {
    return;
  }
  const { session } = target;
  if (meta.kind === 'note') {
    await session.client.deleteNote(
      session.projectPath,
      session.mr.iid,
      meta.discussionId,
      meta.noteId
    );
  } else if (meta.kind === 'draft') {
    await session.client.deleteDraftNote(session.projectPath, session.mr.iid, meta.draftId);
  }
  const remainingComments = meta.thread.comments.filter((candidate) => candidate !== comment);
  if (remainingComments.length === 0) {
    const { thread } = meta;
    thread.dispose();
    session.threads = session.threads.filter((candidate) => candidate !== thread);
  } else {
    setThreadComments(meta.thread, remainingComments);
  }
  reloadReviewState(session);
}

/**
 * Ouvre un fil sur la sélection avec un bloc `suggestion` pré-rempli, à modifier puis publier ou
 * ajouter à la review.
 */
async function suggestChange() {
  const editor = vscode.window.activeTextEditor;
  const target = editor && findCommentTarget(editor.document.uri);
  if (!editor || target?.kind !== 'diff' || target.side !== 'new') {
    throw new Error(t('place the cursor in the branch file, on the right side of the diff.'));
  }
  if (!target.session.isHeadUpToDate) {
    throw new Error(t('the worktree is not on the latest commit of the MR.'));
  }
  const { start, end } = editor.selection;
  // Une sélection qui finit en début de ligne ne couvre pas cette ligne.
  const endLine = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
  const code = editor.document.getText(
    new vscode.Range(start.line, 0, endLine, editor.document.lineAt(endLine).text.length)
  );
  // La suggestion remplace la ligne commentée (la dernière) et les N lignes au-dessus.
  const body = [`\`\`\`suggestion:-${endLine - start.line}+0`, code, '```'].join('\n');
  openCommentEditor(
    target.session,
    editor.document.uri,
    new vscode.Range(start.line, 0, endLine, 0),
    body,
    t('Suggestion')
  );
}

/**
 * Ouvre un fil local avec un commentaire pré-rempli en édition, à ajouter à la review, publier ou
 * annuler (boutons `suggestionEditor`).
 * @param {ReviewSession} session
 * @param {vscode.Uri} uri
 * @param {vscode.Range} range
 * @param {string} body
 * @param {string} label
 */
function openCommentEditor(session, uri, range, body, label) {
  const thread = controller.createCommentThread(uri, range, []);
  /** @type {ReviewComment} */
  const comment = {
    body,
    mode: vscode.CommentMode.Editing,
    author: { name: session.currentUser.name },
    label,
    contextValue: 'suggestionEditor',
    meta: { kind: 'suggestion', savedBody: body },
  };
  setThreadComments(thread, [comment]);
  thread.canReply = false;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

/**
 * Ouvre le diff sur la ligne d'un point du triage, avec un brouillon de commentaire qui reprend la
 * question, à reformuler avant de l'ajouter à la review.
 * @param {vscode.ExtensionContext} context
 * @param {string} repoRoot
 * @param {string} filePath
 * @param {number | undefined} line
 * @param {string} question
 */
async function commentCheck(context, repoRoot, filePath, line, question) {
  if (!line) {
    throw new Error(t('this triage item has no line: comment on it from the general discussion.'));
  }
  await openFile(context, repoRoot, filePath, line);
  const session = await getSession(context, repoRoot);
  if (!session.isHeadUpToDate) {
    throw new Error(t('the worktree is not on the latest commit of the MR.'));
  }
  const changedFile = session.files.get(filePath);
  if (!changedFile || changedFile.status === 'D') {
    throw new Error(t('only a file present on the branch side can receive this comment.'));
  }
  const head = vscode.Uri.file(path.join(repoRoot, filePath));
  const document = await vscode.workspace.openTextDocument(head);
  const lineIndex = Math.min(line, document.lineCount) - 1;
  openCommentEditor(
    session,
    head,
    new vscode.Range(lineIndex, 0, lineIndex, 0),
    question,
    t('Triage item')
  );
}

/**
 * Filtre la vue par chemin pendant la saisie. Échap rétablit le filtre précédent.
 */
async function filterFiles() {
  const previousFilter = filesView.filterText;
  const input = vscode.window.createInputBox();
  input.title = t('Filter MR files');
  input.placeholder = t('Part of the path; separate multiple terms with spaces');
  input.value = previousFilter;
  let isAccepted = false;
  await new Promise((resolve) => {
    input.onDidChangeValue((value) => filesView.setFilter(value));
    input.onDidAccept(() => {
      isAccepted = true;
      input.hide();
    });
    input.onDidHide(() => {
      if (!isAccepted) {
        filesView.setFilter(previousFilter);
      }
      input.dispose();
      resolve(undefined);
    });
    input.show();
  });
}

/**
 * Fil non résolu suivant ou précédent : fils affichés sur le code dans l'ordre des fichiers de la vue
 * puis des lignes, puis discussions hors code (document des discussions). Repart du début après le
 * dernier.
 * @param {vscode.ExtensionContext} context
 * @param {1 | -1} step
 */
async function goToAdjacentThread(context, step) {
  const editor = vscode.window.activeTextEditor;
  const target = editor ? findCommentTarget(editor.document.uri) : undefined;
  const session = target?.session ?? [...sessions.values()][0];
  if (!session) {
    throw new Error(t('no MR loaded: open the MR Review view or a triage link.'));
  }
  const fileOrder = new Map(
    (await filesView.getOrderedFiles(session)).map((file, index) => [file.path, index])
  );
  const documentOrder = session.files.size;
  const locations = await session.threadLocations;
  /** @type {{ order: number, line: number, path?: string }[]} */
  const stops = (await session.discussions).flatMap((discussion) => {
    const location = locations.discussions.get(discussion.id);
    return location && isUnresolved(discussion)
      ? [
          {
            path: location.path,
            line: location.endLine,
            order: fileOrder.get(location.path) ?? documentOrder - 1,
          },
        ]
      : [];
  });
  (await getSessionDocumentEntries(session)).forEach((entry, index) => {
    if (entry.kind === 'discussion' && isUnresolved(entry.discussion)) {
      stops.push({ order: documentOrder, line: index + 1 });
    }
  });
  if (stops.length === 0) {
    vscode.window.showInformationMessage(t('No unresolved threads on !{0}.', session.mr.iid));
    return;
  }
  stops.sort((first, second) => first.order - second.order || first.line - second.line);

  const cursorLine = (editor?.selection.active.line ?? -1) + 1;
  const current =
    target?.kind === 'diff'
      ? {
          order: fileOrder.get(target.newPath) ?? documentOrder - 1,
          line: cursorLine,
        }
      : target?.kind === 'discussions'
        ? { order: documentOrder, line: cursorLine }
        : { order: -1, line: 0 };
  /** @param {{ order: number, line: number }} stop */
  const isAfter = (stop) =>
    stop.order > current.order || (stop.order === current.order && stop.line > current.line);
  /** @param {{ order: number, line: number }} stop */
  const isBefore = (stop) =>
    stop.order < current.order || (stop.order === current.order && stop.line < current.line);
  const nextStop =
    step > 0
      ? (stops.find(isAfter) ?? stops[0])
      : (stops.findLast(isBefore) ?? stops[stops.length - 1]);

  if (nextStop.path) {
    await openFile(context, session.repoRoot, nextStop.path, nextStop.line);
  } else {
    await openDiscussionsDocument(context, session.repoRoot, nextStop.line);
  }
}

/**
 * Publie la suggestion en cours de rédaction, ou l'ajoute à la review.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Comment} comment suggestion, avec le texte modifié
 * @param {boolean} isDraft
 */
async function submitSuggestion(context, comment, isDraft) {
  const { thread } = getMeta(comment);
  if (!thread) {
    return;
  }
  const reply = { thread, text: getCommentText(comment) };
  setThreadComments(thread, []);
  try {
    await (isDraft ? addToReview(context, reply) : postComment(context, reply));
  } catch (error) {
    comment.mode = vscode.CommentMode.Editing;
    setThreadComments(thread, [comment]);
    throw error;
  }
}

/**
 * Publie les brouillons et/ou approuve la MR de l'éditeur actif.
 * @param {vscode.ExtensionContext} context
 */
async function submitReview(context) {
  const session = statusBar.getCurrentSession();
  if (!session) {
    throw new Error(t('no MR loaded.'));
  }
  const draftCount = (await session.drafts).length;
  /** @type {(vscode.QuickPickItem & { isPublish: boolean, approval?: boolean })[]} */
  const choices = [];
  if (draftCount > 0) {
    choices.push(
      {
        label:
          draftCount === 1
            ? t('$(check-all) Publish {0} draft', draftCount)
            : t('$(check-all) Publish {0} drafts', draftCount),
        isPublish: true,
      },
      ...(session.isApproved
        ? []
        : [
            {
              label: t('$(pass-filled) Publish and approve'),
              isPublish: true,
              approval: true,
            },
          ])
    );
  }
  choices.push(
    session.isApproved
      ? {
          label: t('$(circle-slash) Revoke my approval'),
          isPublish: false,
          approval: false,
        }
      : { label: t('$(thumbsup) Approve'), isPublish: false, approval: true }
  );
  const choice = await vscode.window.showQuickPick(choices, {
    title: t('Review of !{0} {1}', session.mr.iid, session.mr.title),
  });
  if (!choice) {
    return;
  }
  if (choice.isPublish) {
    await session.client.publishDraftNotes(session.projectPath, session.mr.iid);
  }
  if (choice.approval !== undefined) {
    await session.client.setApproved(session.projectPath, session.mr.iid, choice.approval);
  }
  // Les brouillons publiés deviennent des discussions : on reconstruit tous les fils.
  await reloadSessions(context);
}
