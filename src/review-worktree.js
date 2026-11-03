// @ts-check
const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { git, parseWorktrees } = require('./git');
const { t } = require('./l10n');

/**
 * Ouvre la branche d'une MR dans VS Code : le worktree qui l'a déjà checkoutée, sinon le worktree de
 * relecture (réglage `mrReview.reviewWorktree`), basculé sur cette branche. Un worktree de relecture
 * avec des modifications non commitées est refusé.
 * @param {string} repoRoot repo de la MR
 * @param {string} branch branche source de la MR
 */
async function reviewBranch(repoRoot, branch) {
  const worktrees = parseWorktrees(await git(repoRoot, ['worktree', 'list', '--porcelain']));
  let worktreePath = worktrees.find((worktree) => worktree.branch === branch)?.path;
  if (!worktreePath) {
    const configuredPath = vscode.workspace
      .getConfiguration('mrReview')
      .get('reviewWorktree', '')
      .trim();
    if (!configuredPath) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'mrReview.reviewWorktree'
      );
      throw new Error(
        t('set the review worktree (mrReview.reviewWorktree setting), then try again.')
      );
    }
    // `git worktree list` donne des chemins réels : on compare au chemin réel du réglage.
    const reviewPath = await fs
      .realpath(path.resolve(configuredPath.replace(/^~(?=$|\/)/, os.homedir())))
      .catch(() => configuredPath);
    if (!worktrees.some((worktree) => worktree.path === reviewPath)) {
      throw new Error(t('{0} is not a worktree of {1} (git worktree list).', reviewPath, repoRoot));
    }
    const changes = await git(reviewPath, ['status', '--porcelain', '--untracked-files=no']);
    if (changes.trim()) {
      throw new Error(
        t(
          'the review worktree ({0}) has uncommitted changes: commit or stash them, then try again.',
          reviewPath
        )
      );
    }
    await git(reviewPath, ['fetch', 'origin', branch]);
    const hasLocalBranch = await git(reviewPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]).then(
      () => true,
      () => false
    );
    if (hasLocalBranch) {
      await git(reviewPath, ['switch', branch]);
      // Branche réécrite depuis (rebase) : l'extension propose de l'aligner une fois la MR chargée.
      await git(reviewPath, ['merge', '--ff-only', `origin/${branch}`]).catch(() => undefined);
    } else {
      await git(reviewPath, ['switch', '--create', branch, '--track', `origin/${branch}`]);
    }
    worktreePath = reviewPath;
  }

  const isOpenHere = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.fsPath === worktreePath
  );
  if (isOpenHere) {
    await vscode.commands.executeCommand('mrReview.files.focus');
  } else {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
      forceNewWindow: true,
    });
  }
}

module.exports = { reviewBranch };
