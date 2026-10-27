// @ts-check
const vscode = require('vscode');

/**
 * Points à vérifier du triage dans l'éditeur : texte en fin de ligne (barré une fois tranché), marque
 * dans la règle de défilement, et survol avec un lien pour les cocher. Pas de CodeLens : la vue diff les
 * masque par défaut (`diffEditor.codeLens`).
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
    this.pendingDecoration = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        color: new vscode.ThemeColor('editorWarning.foreground'),
        margin: '0 0 0 2em',
      },
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
      this.pendingDecoration,
      this.doneDecoration,
      vscode.window.onDidChangeVisibleTextEditors(update),
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
        isDone: this.filesView.isCheckDone(file.session, file.path, check),
      }));
  }

  /** @param {vscode.TextEditor} editor */
  async updateEditor(editor) {
    const documentChecks = await this.getDocumentChecks(editor.document);
    /** @param {boolean} isDone */
    const toDecorations = (isDone) =>
      documentChecks
        .filter((documentCheck) => documentCheck.isDone === isDone)
        .map(({ check, line }) => ({
          range: editor.document.lineAt(line).range,
          renderOptions: { after: { contentText: `${isDone ? '✓' : '⚑'} ${check.question}` } },
        }));
    editor.setDecorations(this.pendingDecoration, toDecorations(false));
    editor.setDecorations(this.doneDecoration, toDecorations(true));
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
    markdown.isTrusted = { enabledCommands: ['mrReview.toggleCheck'] };
    for (const { file, check, isDone } of lineChecks) {
      const args = encodeURIComponent(
        JSON.stringify([file.session.repoRoot, file.path, check.line, check.question])
      );
      markdown.appendMarkdown(
        `**${isDone ? '✓ Vérifié' : '⚑ À vérifier'}** — ${check.question} · ` +
          `[${isDone ? 'Rouvrir' : 'Marquer vérifié'}](command:mrReview.toggleCheck?${args})\n\n`
      );
    }
    return new vscode.Hover(markdown);
  }
}

module.exports = { CheckDecorations };
