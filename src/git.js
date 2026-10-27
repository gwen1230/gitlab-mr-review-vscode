// @ts-check
const { execFile } = require('node:child_process');

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
        reject(new Error(`git ${args.join(' ')} : ${stderr.trim() || error.message}`));
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
  throw new Error(`Remote non reconnu : ${remoteUrl}`);
}

module.exports = { git, parseRemote };
