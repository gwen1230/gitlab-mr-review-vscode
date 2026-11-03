// @ts-check
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getTriagePath,
  isBlockingCheck,
  readTriage,
  resolveTriageDirectory,
  validateTriage,
} = require('./triage');
const { t } = require('./l10n');

/**
 * MR à trier : la commande trie `origin/<branch>`, sans checkout.
 * @typedef {object} TriageRequest
 * @property {string} repoRoot repo où lancer la commande
 * @property {{ iid: number, web_url: string, source_branch: string, target_branch: string }} mr
 * @property {{ base_sha: string, head_sha: string }} diffRefs
 * @property {string[]} paths fichiers de la MR (nouveaux chemins)
 */

/** Commande de triage du réglage `mrReview.triageCommand`, vide si aucune. */
function getTriageCommand() {
  return vscode.workspace.getConfiguration('mrReview').get('triageCommand', '').trim();
}

/**
 * Triage d'une branche dans le dossier du réglage `mrReview.triageDirectory`.
 * @param {string} branch
 */
function getBranchTriagePath(branch) {
  return getTriagePath(
    resolveTriageDirectory(
      vscode.workspace.getConfiguration('mrReview').get('triageDirectory', '~/.mr-review/triage')
    ),
    branch
  );
}

/** @param {string} repoRoot @param {number} iid */
function getRunKey(repoRoot, iid) {
  return `${repoRoot}!${iid}`;
}

/**
 * Lance la commande de triage sur des MR, en parallèle, une fois par MR, et contrôle le JSON qu'elle
 * écrit : un triage refusé est mis de côté et le précédent rétabli. La sortie des commandes va dans le
 * canal « MR Review — Triage », chaque ligne préfixée par sa MR.
 */
class TriageRunner {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.output = vscode.window.createOutputChannel('MR Review — Triage');
    /** @type {Map<string, { startedAt: Date, cancel: () => void }>} par `repo!iid` */
    this.runs = new Map();
    /** @type {vscode.EventEmitter<void>} */
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.changeEmitter.event;
    const updateCommandContext = () =>
      vscode.commands.executeCommand(
        'setContext',
        'mrReview.hasTriageCommand',
        Boolean(getTriageCommand())
      );
    updateCommandContext();
    context.subscriptions.push(
      this.output,
      this.changeEmitter,
      { dispose: () => this.runs.forEach((run) => run.cancel()) },
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mrReview.triageCommand')) {
          updateCommandContext();
          this.changeEmitter.fire();
        }
      })
    );
  }

  /** @param {string} repoRoot @param {number} iid */
  getStartedAt(repoRoot, iid) {
    return this.runs.get(getRunKey(repoRoot, iid))?.startedAt;
  }

  /**
   * Arrête le triage d'une MR, sinon tous ceux en cours.
   * @param {{ repoRoot: string, iid: number }} [mergeRequest]
   */
  cancel(mergeRequest) {
    const key = mergeRequest && getRunKey(mergeRequest.repoRoot, mergeRequest.iid);
    for (const [runKey, run] of this.runs) {
      if (!key || runKey === key) {
        run.cancel();
      }
    }
  }

  /**
   * @param {TriageRequest} request
   * @param {string} progressViewId vue qui affiche la progression
   */
  async run(request, progressViewId) {
    const { repoRoot, mr, diffRefs } = request;
    const key = getRunKey(repoRoot, mr.iid);
    if (this.runs.has(key)) {
      this.output.show(true);
      return;
    }
    const command = getTriageCommand();
    const triagePath = getBranchTriagePath(mr.source_branch);
    const previousContent = await fs.readFile(triagePath, 'utf8').catch(() => undefined);
    await fs.mkdir(path.dirname(triagePath), { recursive: true });
    const startedAt = new Date();
    const prefix = `[!${mr.iid}] `;
    this.output.appendLine(
      prefix +
        t(
          '▶ {0} · triage of {1} ({2}): {3}',
          startedAt.toLocaleTimeString(),
          mr.source_branch,
          diffRefs.head_sha.slice(0, 11),
          command
        )
    );
    const child = spawn(command, {
      cwd: repoRoot,
      env: {
        ...process.env,
        MR_REVIEW_REPO: repoRoot,
        MR_REVIEW_BRANCH: mr.source_branch,
        MR_REVIEW_TARGET: mr.target_branch,
        MR_REVIEW_HEAD: diffRefs.head_sha,
        MR_REVIEW_BASE: diffRefs.base_sha,
        MR_REVIEW_IID: String(mr.iid),
        MR_REVIEW_URL: mr.web_url,
        MR_REVIEW_TRIAGE_FILE: triagePath,
      },
      shell: true,
      // Groupe de processus à part : l'annulation arrête aussi les processus lancés par le shell.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let isCancelled = false;
    this.runs.set(key, {
      startedAt,
      cancel: () => {
        isCancelled = true;
        if (child.pid === undefined) {
          return;
        }
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Déjà terminé.
        }
      },
    });
    this.fireChange();
    // Lignes préfixées par la MR : plusieurs triages écrivent en même temps dans le canal.
    let pendingText = '';
    /** @param {Buffer} chunk */
    const appendOutput = (chunk) => {
      const lines = (pendingText + String(chunk)).split('\n');
      pendingText = lines.pop() ?? '';
      lines.forEach((line) => this.output.appendLine(prefix + line));
    };
    try {
      const exitCode = await vscode.window.withProgress(
        { location: { viewId: progressViewId } },
        () =>
          /** @type {Promise<number | null>} */ (
            new Promise((resolve, reject) => {
              child.stdout.on('data', appendOutput);
              child.stderr.on('data', appendOutput);
              child.on('error', reject);
              child.on('close', resolve);
            })
          )
      );
      if (pendingText) {
        this.output.appendLine(prefix + pendingText);
      }
      await this.checkResult(request, triagePath, previousContent, startedAt, {
        exitCode,
        isCancelled,
      });
    } finally {
      this.runs.delete(key);
      this.fireChange();
    }
  }

  fireChange() {
    vscode.commands.executeCommand('setContext', 'mrReview.triageRunning', this.runs.size > 0);
    this.changeEmitter.fire();
  }

  /**
   * Contrôle le triage écrit par la commande. Un triage que la commande n'a pas réécrit est accepté
   * s'il est déjà à jour : la commande peut alors s'arrêter sans rien écrire.
   * @param {TriageRequest} request
   * @param {string} triagePath
   * @param {string | undefined} previousContent
   * @param {Date} startedAt
   * @param {{ exitCode: number | null, isCancelled: boolean }} outcome
   */
  async checkResult(request, triagePath, previousContent, startedAt, { exitCode, isCancelled }) {
    const prefix = `[!${request.mr.iid}] `;
    const stats = await fs.stat(triagePath).catch(() => undefined);
    const isRewritten = stats !== undefined && stats.mtimeMs >= startedAt.getTime();
    if (isCancelled) {
      if (isRewritten) {
        await this.setAside(triagePath, previousContent, prefix);
      }
      this.output.appendLine(prefix + t('■ Triage cancelled.'));
      return;
    }
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    let warnings = [];
    /** @type {import('./triage').Triage | undefined} */
    let triage;
    if (exitCode !== 0) {
      errors.push(t('the command exited with code {0}.', String(exitCode)));
    } else {
      triage = await readTriage(triagePath).catch((error) => {
        errors.push(error.message);
        return undefined;
      });
      if (triage) {
        const validation = validateTriage(triage, {
          head: request.diffRefs.head_sha,
          target: request.mr.target_branch,
          paths: request.paths,
        });
        errors.push(...validation.errors);
        warnings = validation.warnings;
      }
      if (!isRewritten && (!triage || errors.length > 0)) {
        // Un triage précédent ne compte que s'il est déjà à jour : ses défauts ne sont pas ceux de la commande.
        errors.splice(0, errors.length, t('the command did not write {0}.', triagePath));
        warnings = [];
      }
    }
    warnings.forEach((warning) => this.output.appendLine(`${prefix}⚠ ${warning}`));

    if (errors.length > 0) {
      errors.forEach((error) => this.output.appendLine(`${prefix}✖ ${error}`));
      if (isRewritten) {
        await this.setAside(triagePath, previousContent, prefix);
      }
      this.showResult(
        vscode.window.showErrorMessage,
        t('Triage of !{0} rejected: {1}', request.mr.iid, errors[0])
      );
      return;
    }
    const files = triage?.files ?? [];
    /** @param {string} level */
    const countLevel = (level) => files.filter((file) => file.level === level).length;
    const blockingCount = files.flatMap((file) => file.checks ?? []).filter(isBlockingCheck).length;
    const summary = `🔴 ${countLevel('red')} · 🟠 ${countLevel('orange')} · 🟢 ${countLevel('green')} · 🛑 ${blockingCount}`;
    this.output.appendLine(
      prefix +
        (isRewritten
          ? t('✔ Triage written: {0}', summary)
          : t('✔ Triage already up to date: {0}', summary))
    );
    this.showResult(
      warnings.length > 0 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage,
      (isRewritten
        ? t('Triage of !{0} done: {1}', request.mr.iid, summary)
        : t('Triage of !{0} already up to date: {1}', request.mr.iid, summary)) +
        (warnings.length > 0 ? ` · ⚠ ${warnings.join(' ')}` : '')
    );
  }

  /**
   * Met de côté un triage refusé (`<triage>.rejected`) et rétablit le précédent, s'il y en avait un.
   * @param {string} triagePath
   * @param {string | undefined} previousContent
   * @param {string} prefix
   */
  async setAside(triagePath, previousContent, prefix) {
    const rejectedPath = `${triagePath}.rejected`;
    await fs.rename(triagePath, rejectedPath);
    if (previousContent !== undefined) {
      await fs.writeFile(triagePath, previousContent);
    }
    this.output.appendLine(
      prefix +
        (previousContent === undefined
          ? t('Rejected triage set aside in {0}.', rejectedPath)
          : t('Rejected triage set aside in {0}, previous triage restored.', rejectedPath))
    );
  }

  /**
   * @param {(message: string, ...items: string[]) => Thenable<string | undefined>} show
   * @param {string} message
   */
  showResult(show, message) {
    show(message, t('Show Output')).then((choice) => choice && this.output.show(true));
  }
}

module.exports = { TriageRunner, getBranchTriagePath, getTriageCommand };
