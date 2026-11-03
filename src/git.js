// @ts-check
const { execFile } = require('node:child_process');
const { t } = require('./l10n');

/**
 * Lance une commande git dans `cwd` et renvoie sa sortie standard.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(t('git {0}: {1}', args.join(' '), stderr.trim() || error.message)));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Déduit l'instance GitLab et le chemin du projet de l'URL du remote (SSH ou HTTPS).
 * @param {string} remoteUrl
 * @returns {{ instanceUrl: string, projectPath: string }}
 */
function parseRemote(remoteUrl) {
  const ssh = remoteUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?$/);
  if (ssh) {
    return { instanceUrl: `https://${ssh[1]}`, projectPath: ssh[2] };
  }
  const https = remoteUrl.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) {
    return { instanceUrl: `https://${https[1]}`, projectPath: https[2] };
  }
  throw new Error(t('Unrecognized remote: {0}', remoteUrl));
}

/**
 * Lit la sortie de `git worktree list --porcelain` : un bloc par worktree, séparé par une ligne vide.
 * @param {string} output
 * @returns {{ path: string, branch?: string }[]} `branch` sans `refs/heads/`, absente si HEAD détaché
 */
function parseWorktrees(output) {
  return output
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n');
      const worktreePath = lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? '';
      const branch = lines
        .find((line) => line.startsWith('branch '))
        ?.slice(7)
        .replace(/^refs\/heads\//, '');
      return { path: worktreePath, ...(branch && { branch }) };
    });
}

module.exports = { git, parseRemote, parseWorktrees };
