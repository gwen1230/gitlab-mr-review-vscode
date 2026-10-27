// @ts-check
const vscode = require('vscode');
const path = require('node:path');
const { git, parseRemote } = require('./src/git');
const { parseHunks, parseRawDiff, toLineRangeEntry, toPositionLines } = require('./src/diff');
const { GitLabClient } = require('./src/gitlab');
const { getToken, handleAuthenticationRedirect, invalidateToken, signOut } = require('./src/auth');
const { FilesView } = require('./src/files-view');
const { StatusBar, hasRunningPipeline } = require('./src/status-bar');
const { CheckDecorations } = require('./src/check-decorations');
const {
  getDocumentEntries,
  isDiffDiscussion,
  isDiffDraft,
  isResolvable,
  renderDiscussionsDocument,
} = require('./src/discussions');

/** Côté gauche d'un fichier ajouté : document vide. */
const EMPTY_SCHEME = 'mr-review-empty';
/** Document virtuel des discussions qui n'ont pas leur place sur une ligne de code. */
const DISCUSSIONS_SCHEME = 'mr-review-discussions';
/** Délai avant de recharger les MR après un changement de HEAD (pull, checkout, commit). */
const HEAD_CHANGE_DELAY_MS = 1500;
/** Fréquence de relecture d'une MR dont le pipeline tourne. */
const PIPELINE_POLL_MS = 30_000;

/**
 * @typedef {object} ReviewSession
 * @property {string} repoRoot
 * @property {string} projectPath
 * @property {string} branch
 * @property {GitLabClient} client
 * @property {{ id: number, name: string, avatar_url?: string }} currentUser
 * @property {{ iid: number, title: string, web_url: string, head_pipeline?: { status: string } }} mr
 * @property {{ base_sha: string, start_sha: string, head_sha: string }} diffRefs
 * @property {boolean} isHeadUpToDate le worktree est sur le dernier commit de la MR
 * @property {boolean} isApproved approuvée par l'utilisateur connecté
 * @property {Map<string, import('./src/diff').ChangedFile>} files fichiers de la MR, par nouveau chemin
 * @property {Map<string, Promise<import('./src/diff').Hunk[]>>} hunks
 * @property {Promise<any[]>} discussions
 * @property {Promise<any[]>} drafts brouillons de review de l'utilisateur connecté
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
/** @type {vscode.EventEmitter<void>} */
const sessionsChangeEmitter = new vscode.EventEmitter();
/** @type {vscode.EventEmitter<vscode.Uri>} */
const discussionsDocumentEmitter = new vscode.EventEmitter();

/** @type {vscode.CommentController} */
let controller;
/** @type {any} API de l'extension git intégrée */
let gitApi;
/** @type {FilesView} */
let filesView;
/** @type {StatusBar} */
let statusBar;

/** @param {vscode.ExtensionContext} context */
exports.activate = (context) => {
  gitApi = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
  controller = vscode.comments.createCommentController('mr-review', 'MR GitLab');
  controller.options = { prompt: 'Commenter sur la MR', placeHolder: 'Commentaire en markdown' };
  controller.commentingRangeProvider = { provideCommentingRanges: getCommentingRanges };
  filesView = new FilesView(context, {
    list: () => [...sessions.values()],
    loadWorkspace: () => loadWorkspaceSessions(context),
    onDidChange: sessionsChangeEmitter.event,
  });
  statusBar = new StatusBar(context, {
    list: () => [...sessions.values()],
    findForUri: findSessionForUri,
    onDidChange: sessionsChangeEmitter.event,
  });
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
  const pipelinePolling = setInterval(() => pollRunningPipelines(), PIPELINE_POLL_MS);

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
    { dispose: () => clearInterval(pipelinePolling) },
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
    vscode.workspace.registerTextDocumentContentProvider(DISCUSSIONS_SCHEME, {
      onDidChange: discussionsDocumentEmitter.event,
      provideTextDocumentContent: provideDiscussionsDocument,
    }),
    vscode.window.registerUriHandler({
      handleUri: (uri) =>
        run(async () =>
          uri.path === '/authentication'
            ? handleAuthenticationRedirect(uri)
            : openFromUri(context, uri)
        ),
    }),
    registerCommand('mrReview.postComment', (reply) => postComment(reply)),
    registerCommand('mrReview.addToReview', (reply) => addToReview(reply)),
    registerCommand('mrReview.resolve', (thread) => resolveThread(thread, true)),
    registerCommand('mrReview.unresolve', (thread) => resolveThread(thread, false)),
    registerCommand('mrReview.editComment', async (comment) => setCommentEditing(comment, true)),
    registerCommand('mrReview.cancelEditComment', async (comment) =>
      setCommentEditing(comment, false)
    ),
    registerCommand('mrReview.saveComment', (comment) => saveComment(comment)),
    registerCommand('mrReview.deleteComment', (comment) => deleteComment(comment)),
    registerCommand('mrReview.suggestChange', () => suggestChange()),
    registerCommand('mrReview.publishSuggestion', (comment) => submitSuggestion(comment, false)),
    registerCommand('mrReview.addSuggestionToReview', (comment) => submitSuggestion(comment, true)),
    registerCommand('mrReview.cancelSuggestion', async (comment) =>
      getMeta(comment).thread?.dispose()
    ),
    registerCommand('mrReview.submitReview', () => submitReview(context)),
    registerCommand('mrReview.openFile', (repoRoot, relativePath, line) =>
      openFile(context, repoRoot, relativePath, line)
    ),
    registerCommand('mrReview.openDiscussions', (repoRoot, line) =>
      openDiscussionsDocument(context, repoRoot, line)
    ),
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
    registerCommand('mrReview.nextFile', () => goToAdjacentFile(context, 1)),
    registerCommand('mrReview.previousFile', () => goToAdjacentFile(context, -1)),
    registerCommand('mrReview.openInBrowser', async () => {
      const session = statusBar.getCurrentSession();
      if (session) {
        await vscode.env.openExternal(vscode.Uri.parse(session.mr.web_url));
      }
    }),
    registerCommand('mrReview.refresh', () => reloadSessions(context)),
    registerCommand('mrReview.signOut', () => signOut(context)),
    vscode.workspace.onDidOpenTextDocument((document) => run(() => renderThreads(document))),
    sessionsChangeEmitter.event(() =>
      run(async () => {
        await vscode.commands.executeCommand(
          'setContext',
          'mrReview.hasSession',
          sessions.size > 0
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
      `MR Review : ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Ouvre le diff d'un fichier de la MR.
 * Lien : `vscode://local.mr-review/open?repo=<racine absolue>&path=<chemin relatif>&line=<n>`.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.Uri} uri
 */
async function openFromUri(context, uri) {
  const params = new URLSearchParams(uri.query);
  const repo = params.get('repo');
  const relativePath = params.get('path');
  if (!repo || !relativePath || !path.isAbsolute(repo)) {
    throw new Error(`lien invalide : ${uri.toString(true)}`);
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
    throw new Error(`chemin hors du repo : ${relativePath}`);
  }
  const options = { preview: false, selection: toLineSelection(line) };

  const session = await getSession(context, repoRoot);
  const changedFile = session.files.get(relativePath);
  const head = vscode.Uri.file(absolutePath);
  if (!changedFile) {
    vscode.window.showInformationMessage(
      `${relativePath} ne fait pas partie de la MR !${session.mr.iid}.`
    );
    await vscode.window.showTextDocument(head, options);
    return;
  }

  /** @type {vscode.Uri} */
  const base =
    changedFile.status === 'A'
      ? vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${relativePath}` })
      : gitApi.toGitUri(
          vscode.Uri.file(path.join(repoRoot, changedFile.oldPath)),
          session.diffRefs.base_sha
        );
  if (changedFile.status === 'D') {
    await vscode.window.showTextDocument(base, options);
  } else {
    const title = `${path.basename(relativePath)} (!${session.mr.iid})`;
    await vscode.commands.executeCommand('vscode.diff', base, head, title, options);
  }
  // Déjà ouverts avant le clic, ces documents ne repassent pas par onDidOpenTextDocument.
  const openDocuments = vscode.workspace.textDocuments.filter((document) =>
    [base.toString(), head.toString()].includes(document.uri.toString())
  );
  await Promise.all(openDocuments.map(renderThreads));
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
async function getSessionDocumentEntries(session) {
  return getDocumentEntries(
    await session.discussions,
    await session.drafts,
    session.diffRefs.head_sha
  );
}

/** @param {vscode.Uri} uri */
async function provideDiscussionsDocument(uri) {
  const session = sessions.get(new URLSearchParams(uri.query).get('repo') ?? '');
  if (!session) {
    return 'MR non chargée : rouvrez les discussions depuis la vue MR Review.';
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
  const session = target?.session ?? [...sessions.values()][0];
  if (!session) {
    throw new Error('aucune MR chargée : ouvrez la vue MR Review ou un lien de triage.');
  }
  const files = await filesView.getOrderedFiles(session);
  const index =
    target?.kind === 'diff' ? files.findIndex((file) => file.path === target.newPath) : -1;
  const isMarkViewedOnNext = vscode.workspace
    .getConfiguration('mrReview')
    .get('markViewedOnNext', true);
  if (step > 0 && index >= 0 && isMarkViewedOnNext) {
    await filesView.setViewed(files[index], true);
  }
  const nextFile = index < 0 ? files.at(step > 0 ? 0 : -1) : files[index + step];
  if (!nextFile) {
    vscode.window.showInformationMessage(
      step > 0 ? 'Dernier fichier de la MR.' : 'Premier fichier de la MR.'
    );
    return;
  }
  await openFile(context, session.repoRoot, nextFile.path, nextFile.line);
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
  const { instanceUrl, projectPath } = parseRemote(
    (await git(repoRoot, ['remote', 'get-url', 'origin'])).trim()
  );
  const branch = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const client = new GitLabClient(
    instanceUrl,
    () => getToken(context, instanceUrl),
    () => invalidateToken(context, instanceUrl)
  );
  const openMr = await client.findOpenMergeRequest(projectPath, branch);
  if (!openMr) {
    throw new Error(`aucune MR ouverte pour la branche ${branch} sur ${projectPath}.`);
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
    vscode.window.showWarningMessage(
      `Le worktree (${localHead.slice(0, 11)}) n'est pas sur le dernier commit de la MR !${mr.iid} ` +
        `(${diffRefs.head_sha.slice(0, 11)}) : nouveaux commentaires désactivés jusqu'au pull.`
    );
  }
  const rawDiff = await git(repoRoot, [
    'diff',
    '-M',
    '--raw',
    '-z',
    '--no-abbrev',
    diffRefs.base_sha,
    diffRefs.head_sha,
  ]);
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
    isApproved: (approvals.approved_by ?? []).some(
      (/** @type {any} */ approval) => approval.user.id === currentUser.id
    ),
    files: parseRawDiff(rawDiff),
    hunks: new Map(),
    discussions: Promise.resolve([]),
    drafts: Promise.resolve([]),
    renderedUris: new Set(),
    threads: [],
  };
  loadReviewState(session);
  return session;
}

/**
 * Lance la lecture des discussions et des brouillons. Lues plus tard par la vue et les fils : un rejet
 * est rattrapé ici pour ne pas rester non suivi d'ici là.
 * @param {ReviewSession} session
 */
function loadReviewState(session) {
  session.discussions = session.client.listDiscussions(session.projectPath, session.mr.iid);
  session.drafts = session.client.listDraftNotes(session.projectPath, session.mr.iid);
  return Promise.all([session.discussions, session.drafts]).catch(() => undefined);
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
      errors.push(`${folder.name} : ${error instanceof Error ? error.message : String(error)}`);
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
  for (const session of sessions.values()) {
    session.threads.forEach((thread) => thread.dispose());
  }
  sessions.clear();
  sessionsChangeEmitter.fire();

  const errors = await loadWorkspaceSessions(context);
  for (const repoRoot of repoRoots.filter((candidate) => !sessions.has(candidate))) {
    await getSession(context, repoRoot).catch((error) =>
      errors.push(`${path.basename(repoRoot)} : ${error.message}`)
    );
  }
  filesView.reset(errors);
  discussionsDocumentUris.forEach((uri) => discussionsDocumentEmitter.fire(uri));
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

/** Relit les MR dont le pipeline tourne, pour la barre d'état. Silencieux en cas d'échec réseau. */
async function pollRunningPipelines() {
  for (const session of sessions.values()) {
    if (!hasRunningPipeline(session)) {
      continue;
    }
    try {
      const mr = await session.client.getMergeRequest(session.projectPath, session.mr.iid);
      if (mr.head_pipeline?.status !== session.mr.head_pipeline?.status) {
        session.mr.head_pipeline = mr.head_pipeline;
        sessionsChangeEmitter.fire();
      }
    } catch {
      // Prochaine tentative au tick suivant.
    }
  }
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
 * Affiche les discussions et les brouillons de la MR qui portent sur ce document. Les fils posés sur
 * une version précédente vont dans le document des discussions : leur ligne d'origine ne correspond
 * plus forcément au code affiché.
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
  const [discussions, drafts] = await Promise.all([session.discussions, session.drafts]);
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
    const oldPath = session.files.get(target.newPath)?.oldPath;
    /** @param {any} position */
    const getLines = (position) => {
      const start = position.line_range?.start;
      // Une ligne inchangée porte old_line et new_line : on l'affiche côté branche.
      if (target.side === 'new') {
        return position.new_path === target.newPath && position.new_line
          ? [start?.new_line ?? position.new_line, position.new_line]
          : [];
      }
      return position.old_path === oldPath && !position.new_line && position.old_line
        ? [start?.old_line ?? position.old_line, position.old_line]
        : [];
    };
    for (const discussion of discussions.filter(isDiffDiscussion)) {
      const { position } = discussion.notes[0];
      const [startLine, endLine] = getLines(position);
      if (endLine && position.head_sha === session.diffRefs.head_sha) {
        threadsByDiscussion.set(
          discussion.id,
          createDiscussionThread(session, document.uri, startLine, endLine, discussion)
        );
      }
    }
    for (const draft of drafts.filter(isDiffDraft)) {
      const [startLine, endLine] = getLines(draft.position);
      if (endLine) {
        createDraftThread(session, document.uri, startLine, endLine, draft);
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
  thread.label = 'Brouillon';
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
    label: 'Brouillon',
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
  thread.label = isResolved ? 'Résolu' : undefined;
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
    throw new Error("ce document n'appartient à aucune MR ouverte.");
  }
  return target;
}

/**
 * Publie tout de suite un nouveau fil, ou une réponse si le fil existe déjà sur la MR.
 * @param {vscode.CommentReply} reply
 */
async function postComment({ thread, text }) {
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
    const position = await buildPosition(target, thread);
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
 * @param {vscode.CommentReply} reply
 */
async function addToReview({ thread, text }) {
  const target = requireCommentTarget(thread);
  const { session } = target;
  const discussionId = discussionIds.get(thread);
  const draft = await session.client.createDraftNote(
    session.projectPath,
    session.mr.iid,
    discussionId
      ? { note: text, in_reply_to_discussion_id: discussionId }
      : { note: text, position: await buildPosition(target, thread) }
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
 * (`line_range` quand il en couvre plusieurs).
 * @param {CommentTarget} target
 * @param {vscode.CommentThread} thread
 */
async function buildPosition(target, thread) {
  if (target.kind === 'discussions') {
    return undefined;
  }
  const { session } = target;
  if (!session.isHeadUpToDate) {
    throw new Error("le worktree n'est pas sur le dernier commit de la MR.");
  }
  if (!thread.range) {
    throw new Error('fil sans ligne.');
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
 * Relit discussions et brouillons pour les compteurs de la vue et de la barre d'état, et le document
 * des discussions (une nouvelle entrée prend la place de la ligne « Nouveau commentaire », où son fil
 * est déjà accroché). Les fils déjà affichés restent en place.
 * @param {ReviewSession} session
 */
function reloadReviewState(session) {
  loadReviewState(session).then(() => {
    sessionsChangeEmitter.fire();
    discussionsDocumentEmitter.fire(getDiscussionsDocumentUri(session));
  });
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
  const confirmation = await vscode.window.showWarningMessage(
    isDraft ? 'Supprimer ce brouillon ?' : 'Supprimer ce commentaire de la MR ?',
    { modal: true },
    'Supprimer'
  );
  if (confirmation !== 'Supprimer') {
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
    meta.thread.dispose();
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
    throw new Error('placez le curseur dans le fichier de la branche, côté droit du diff.');
  }
  if (!target.session.isHeadUpToDate) {
    throw new Error("le worktree n'est pas sur le dernier commit de la MR.");
  }
  const { start, end } = editor.selection;
  // Une sélection qui finit en début de ligne ne couvre pas cette ligne.
  const endLine = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
  const code = editor.document.getText(
    new vscode.Range(start.line, 0, endLine, editor.document.lineAt(endLine).text.length)
  );
  // La suggestion remplace la ligne commentée (la dernière) et les N lignes au-dessus.
  const body = [`\`\`\`suggestion:-${endLine - start.line}+0`, code, '```'].join('\n');

  const thread = controller.createCommentThread(
    editor.document.uri,
    new vscode.Range(start.line, 0, endLine, 0),
    []
  );
  /** @type {ReviewComment} */
  const suggestion = {
    body,
    mode: vscode.CommentMode.Editing,
    author: { name: target.session.currentUser.name },
    label: 'Suggestion',
    contextValue: 'suggestionEditor',
    meta: { kind: 'suggestion', savedBody: body },
  };
  setThreadComments(thread, [suggestion]);
  thread.canReply = false;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

/**
 * Publie la suggestion en cours de rédaction, ou l'ajoute à la review.
 * @param {vscode.Comment} comment suggestion, avec le texte modifié
 * @param {boolean} isDraft
 */
async function submitSuggestion(comment, isDraft) {
  const { thread } = getMeta(comment);
  if (!thread) {
    return;
  }
  const reply = { thread, text: getCommentText(comment) };
  setThreadComments(thread, []);
  try {
    await (isDraft ? addToReview(reply) : postComment(reply));
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
    throw new Error('aucune MR chargée.');
  }
  const draftCount = (await session.drafts).length;
  /** @type {(vscode.QuickPickItem & { isPublish: boolean, approval?: boolean })[]} */
  const choices = [];
  if (draftCount > 0) {
    choices.push(
      { label: `$(check-all) Publier ${draftCount} brouillon(s)`, isPublish: true },
      ...(session.isApproved
        ? []
        : [{ label: '$(pass-filled) Publier et approuver', isPublish: true, approval: true }])
    );
  }
  choices.push(
    session.isApproved
      ? { label: '$(circle-slash) Retirer mon approbation', isPublish: false, approval: false }
      : { label: '$(thumbsup) Approuver', isPublish: false, approval: true }
  );
  const choice = await vscode.window.showQuickPick(choices, {
    title: `Review de !${session.mr.iid} ${session.mr.title}`,
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
