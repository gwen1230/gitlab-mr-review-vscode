// @ts-check
const vscode = require('vscode');
const crypto = require('node:crypto');
const { t } = require('./l10n');

/**
 * Bloc « Filtres » au-dessus de la vue des fichiers : champ de recherche par chemin (filtré pendant la
 * frappe) et case « Non relus seulement ». Vue web, l'arbre ne pouvant pas porter de champ de saisie.
 * @implements {vscode.WebviewViewProvider}
 */
class FiltersView {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./files-view').FilesView} filesView
   */
  constructor(context, filesView) {
    this.filesView = filesView;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('mrReview.filters', this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      filesView.onDidChangeTreeData(() => this.postState())
    );
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(crypto.randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'filter') {
        await this.filesView.setFilter(message.text);
      } else if (message.type === 'unviewedOnly') {
        await this.filesView.setUnviewedOnly(message.value);
      } else if (message.type === 'ready') {
        this.postState();
      }
    });
  }

  /** Renvoie l'état des filtres et le nombre de fichiers affichés, par exemple après « Effacer ». */
  postState() {
    this.view?.webview.postMessage({
      type: 'state',
      text: this.filesView.filterText,
      isUnviewedOnly: this.filesView.isUnviewedOnly,
      ...this.filesView.countShownFiles(),
    });
  }
}

/** @param {string} nonce */
function getHtml(nonce) {
  return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { padding: 6px 12px 8px; color: var(--vscode-foreground); font-size: var(--vscode-font-size); }
  input[type="search"] {
    box-sizing: border-box; width: 100%; padding: 4px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: inherit; font-size: inherit;
  }
  input[type="search"]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; }
  label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  input[type="checkbox"] { accent-color: var(--vscode-checkbox-background); margin: 0; }
  .count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
</style>
</head>
<body>
  <input id="search" type="search" placeholder="${escapeHtml(t('Search paths…'))}" aria-label="${escapeHtml(t('Search for an MR file'))}">
  <div class="row">
    <label><input id="unviewed" type="checkbox"> ${escapeHtml(t('Unviewed only'))}</label>
    <span id="count" class="count"></span>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const countFormat = ${JSON.stringify(t('{0}/{1} files'))};
  const search = document.getElementById('search');
  const unviewed = document.getElementById('unviewed');
  const count = document.getElementById('count');
  search.addEventListener('input', () => vscode.postMessage({ type: 'filter', text: search.value }));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      search.value = '';
      vscode.postMessage({ type: 'filter', text: '' });
    }
  });
  unviewed.addEventListener('change', () =>
    vscode.postMessage({ type: 'unviewedOnly', value: unviewed.checked })
  );
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') {
      return;
    }
    // Pas de réécriture pendant la frappe : l'extension renvoie le texte sans les espaces de fin.
    if (document.activeElement !== search) {
      search.value = data.text;
    }
    unviewed.checked = data.isUnviewedOnly;
    count.textContent = data.total
      ? countFormat.replace('{0}', data.shown).replace('{1}', data.total)
      : '';
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

module.exports = { FiltersView };
