// @ts-check
const vscode = require('vscode');
const { isBlockingCheck } = require('./triage');
const { t } = require('./l10n');

/**
 * Points à vérifier du triage dans l'éditeur : texte en fin de ligne (barré une fois tranché), marque
 * dans la règle de défilement, et survol avec un lien pour les cocher. Seuls les points bloquants
 * s'affichent en fin de ligne, sauf réglage `mrReview.showAllChecksInEditor` ; le survol montre tous
 * ceux de la ligne. Pas de CodeLens : la vue diff les masque par défaut (`diffEditor.codeLens`).
 */
class CheckDecorations {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {object} dependencies
   * @param {(uri: vscode.Uri) => { session: import('./files-view').ViewSession, path: string } | undefined} dependencies.findFile
   *   fichier de la MR affiché côté branche
   * @param {import('./files-view').FilesView} dependencies.filesView
   * @param {vscode.Event<void>} dependencies.onDidChangeSessions
   */
  constructor(context, { findFile, filesView, onDidChangeSessions }) {
    this.findFile = findFile;
    this.filesView = filesView;
    this.blockingDecoration = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { color: new vscode.ThemeColor('editorError.foreground'), margin: '0 0 0 2em' },
    });
    this.pendingDecoration = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { color: new vscode.ThemeColor('editorWarning.foreground'), margin: '0 0 0 2em' },
    });
    this.doneDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('disabledForeground'),
        margin: '0 0 0 2em',
        textDecoration: 'line-through',
      },
    });
    const update = () => this.updateVisibleEditors();
    context.subscriptions.push(
      this.blockingDecoration,
      this.pendingDecoration,
      this.doneDecoration,
      vscode.window.onDidChangeVisibleTextEditors(update),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mrReview.showAllChecksInEditor')) {
          update();
        }
      }),
      onDidChangeSessions(update),
      filesView.onDidChangeTreeData(update),
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        { provideHover: (document, position) => this.provideHover(document, position) }
      )
    );
  }

  updateVisibleEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateEditor(editor).catch(() => undefined);
    }
  }

  /**
   * Points du fichier affiché, avec leur ligne dans le document (0-based). Une ligne au-delà de la fin
   * du fichier (triage fait sur une autre version) est ramenée à la dernière.
   * @param {vscode.TextDocument} document
   */
  async getDocumentChecks(document) {
    const file = this.findFile(document.uri);
    if (!file) {
      return [];
    }
    const checks = await this.filesView.getChecks(file.session, file.path);
    return checks
      .filter((check) => check.line)
      .map((check) => ({
        file,
        check,
        line: Math.min(/** @type {number} */ (check.line), document.lineCount) - 1,
        isBlocking: isBlockingCheck(check),
        isDone: this.filesView.isCheckDone(file.session, file.path, check),
      }));
  }

  /** @param {vscode.TextEditor} editor */
  async updateEditor(editor) {
    const isShowingAll = vscode.workspace
      .getConfiguration('mrReview')
      .get('showAllChecksInEditor', false);
    const documentChecks = (await this.getDocumentChecks(editor.document)).filter(
      (documentCheck) => isShowingAll || documentCheck.isBlocking
    );
    /**
     * @param {typeof documentChecks} selectedChecks
     * @param {string} marker
     */
    const toDecorations = (selectedChecks, marker) =>
      selectedChecks.map(({ check, line }) => ({
        range: editor.document.lineAt(line).range,
        renderOptions: { after: { contentText: `${marker} ${check.question}` } },
      }));
    const pendingChecks = documentChecks.filter((documentCheck) => !documentCheck.isDone);
    editor.setDecorations(
      this.blockingDecoration,
      toDecorations(
        pendingChecks.filter((documentCheck) => documentCheck.isBlocking),
        '🛑'
      )
    );
    editor.setDecorations(
      this.pendingDecoration,
      toDecorations(
        pendingChecks.filter((documentCheck) => !documentCheck.isBlocking),
        '⚑'
      )
    );
    editor.setDecorations(
      this.doneDecoration,
      toDecorations(
        documentChecks.filter((documentCheck) => documentCheck.isDone),
        '✓'
      )
    );
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   */
  async provideHover(document, position) {
    const lineChecks = (await this.getDocumentChecks(document)).filter(
      (documentCheck) => documentCheck.line === position.line
    );
    if (lineChecks.length === 0) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: ['mrReview.toggleCheck', 'mrReview.commentCheck'] };
    for (const { file, check, isBlocking, isDone } of lineChecks) {
      const args = encodeURIComponent(
        JSON.stringify([file.session.repoRoot, file.path, check.line, check.question])
      );
      const status = isDone ? t('✓ Verified') : isBlocking ? t('🛑 Blocking') : t('⚑ To check');
      markdown.appendMarkdown(
        `**${status}** — ${check.question} · ` +
          `[${isDone ? t('Reopen') : t('Mark as verified')}](command:mrReview.toggleCheck?${args}) · ` +
          `[${t('Comment on the MR')}](command:mrReview.commentCheck?${args})\n\n`
      );
    }
    return new vscode.Hover(markdown);
  }
}

module.exports = { CheckDecorations };
