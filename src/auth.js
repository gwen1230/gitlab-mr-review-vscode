// @ts-check
const vscode = require('vscode');
const crypto = require('node:crypto');
const { t } = require('./l10n');

/** URI de redirection à déclarer dans l'application OAuth GitLab. */
const REDIRECT_URI = 'vscode://gwen1230.mr-review/authentication';
/** Un token qui expire dans moins d'une minute est renouvelé tout de suite. */
const EXPIRY_MARGIN_MS = 60_000;
/** Instances pour lesquelles un token est rangé, pour pouvoir les oublier. */
const INSTANCES_KEY = 'mr-review.instances';

/** @typedef {{ accessToken: string, refreshToken: string, codeVerifier: string, expiresAt: number }} OAuthTokens */

/** @type {Map<string, { resolve: (code: string) => void, reject: (error: Error) => void }>} par `state` */
const pendingAuthorizations = new Map();
/** @type {Map<string, Promise<string>>} par instance, pour ne lancer qu'une connexion à la fois */
const pendingTokens = new Map();

/** @param {string} instanceUrl */
const oauthSecretKey = (instanceUrl) => `mr-review.oauth.${instanceUrl}`;
/** @param {string} instanceUrl */
const patSecretKey = (instanceUrl) => `mr-review.pat.${instanceUrl}`;

/**
 * Token GitLab pour `instanceUrl`. Avec une application OAuth configurée (`mrReview.oauthApplications`),
 * connexion dans le navigateur (SSO de l'instance) puis renouvellement automatique. Sinon, PAT demandé
 * une fois. Les deux sont rangés dans le trousseau de VS Code.
 * @param {vscode.ExtensionContext} context
 * @param {string} instanceUrl
 * @returns {Promise<string>}
 */
function getToken(context, instanceUrl) {
  const pending = pendingTokens.get(instanceUrl);
  if (pending) {
    return pending;
  }
  /** @type {Record<string, string>} */
  const oauthApplications = vscode.workspace
    .getConfiguration('mrReview')
    .get('oauthApplications', {});
  const clientId = oauthApplications[instanceUrl];
  const request = (
    clientId ? getOAuthToken(context, instanceUrl, clientId) : getPat(context, instanceUrl)
  ).finally(() => pendingTokens.delete(instanceUrl));
  pendingTokens.set(instanceUrl, request);
  return request;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} instanceUrl
 * @param {string} clientId
 */
async function getOAuthToken(context, instanceUrl, clientId) {
  const stored = await context.secrets.get(oauthSecretKey(instanceUrl));
  /** @type {OAuthTokens | undefined} */
  const tokens = stored ? JSON.parse(stored) : undefined;
  if (tokens && tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return tokens.accessToken;
  }
  if (tokens) {
    try {
      return await requestTokens(context, instanceUrl, tokens.codeVerifier, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: tokens.codeVerifier,
      });
    } catch {
      // Refresh token expiré ou révoqué : nouvelle connexion.
    }
  }
  return authorize(context, instanceUrl, clientId);
}

/**
 * Flux « authorization code » avec PKCE : la page de connexion de GitLab s'ouvre dans le navigateur et
 * renvoie vers VS Code par l'URI de redirection.
 * @param {vscode.ExtensionContext} context
 * @param {string} instanceUrl
 * @param {string} clientId
 */
async function authorize(context, instanceUrl, clientId) {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomUUID();
  const authorizeUrl = new URL('/oauth/authorize', instanceUrl);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'api',
    state,
    code_challenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const code = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('MR Review: signing in to {0} in the browser…', new URL(instanceUrl).host),
      cancellable: true,
    },
    (_progress, cancellation) =>
      new Promise((resolve, reject) => {
        pendingAuthorizations.set(state, { resolve, reject });
        cancellation.onCancellationRequested(() => {
          pendingAuthorizations.delete(state);
          reject(new Error(t('GitLab sign-in cancelled.')));
        });
        vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
      })
  );

  return requestTokens(context, instanceUrl, codeVerifier, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });
}

/**
 * Reçoit le retour de GitLab : `vscode://gwen1230.mr-review/authentication?code=…&state=…`.
 * @param {vscode.Uri} uri
 */
function handleAuthenticationRedirect(uri) {
  const params = new URLSearchParams(uri.query);
  const state = params.get('state') ?? '';
  const pending = pendingAuthorizations.get(state);
  if (!pending) {
    throw new Error(t('Unexpected GitLab sign-in callback: run the action again.'));
  }
  pendingAuthorizations.delete(state);
  const code = params.get('code');
  if (code) {
    pending.resolve(code);
  } else {
    pending.reject(
      new Error(
        t(
          'GitLab sign-in refused: {0}',
          params.get('error_description') ?? params.get('error') ?? ''
        )
      )
    );
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} instanceUrl
 * @param {string} codeVerifier
 * @param {Record<string, string>} params
 */
async function requestTokens(context, instanceUrl, codeVerifier, params) {
  const response = await fetch(new URL('/oauth/token', instanceUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new Error(`GitLab /oauth/token : ${response.status} ${await response.text()}`);
  }
  const data = /** @type {{ access_token: string, refresh_token: string, expires_in: number }} */ (
    await response.json()
  );
  /** @type {OAuthTokens} */
  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    codeVerifier,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await context.secrets.store(oauthSecretKey(instanceUrl), JSON.stringify(tokens));
  await rememberInstance(context, instanceUrl);
  return tokens.accessToken;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} instanceUrl
 */
async function getPat(context, instanceUrl) {
  const storedPat = await context.secrets.get(patSecretKey(instanceUrl));
  if (storedPat) {
    return storedPat;
  }
  const host = new URL(instanceUrl).host;
  const pat = await askPat(instanceUrl);
  if (!pat) {
    throw new Error(t('No GitLab token for {0}.', host));
  }
  await context.secrets.store(patSecretKey(instanceUrl), pat);
  await rememberInstance(context, instanceUrl);
  return pat;
}

/**
 * Demande un PAT, avec un bouton qui ouvre la page de création de GitLab, nom et scope pré-remplis.
 * @param {string} instanceUrl
 * @returns {Promise<string | undefined>}
 */
function askPat(instanceUrl) {
  const createTokenUrl = new URL('/-/user_settings/personal_access_tokens', instanceUrl);
  createTokenUrl.search = new URLSearchParams({ name: 'MR Review', scopes: 'api' }).toString();
  const createTokenButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: t('Create a token in GitLab'),
  };
  const input = vscode.window.createInputBox();
  input.title = t('MR Review: personal access token for {0}', new URL(instanceUrl).host);
  input.prompt = t(
    'Personal access token with the "api" scope (button on the right to create one). To sign in with SSO instead, declare an OAuth application in the mrReview.oauthApplications setting.'
  );
  input.password = true;
  input.ignoreFocusOut = true;
  input.buttons = [createTokenButton];
  return new Promise((resolve) => {
    input.onDidTriggerButton(() =>
      vscode.env.openExternal(vscode.Uri.parse(createTokenUrl.toString()))
    );
    input.onDidAccept(() => {
      resolve(input.value.trim() || undefined);
      input.hide();
    });
    input.onDidHide(() => {
      resolve(undefined);
      input.dispose();
    });
    input.show();
  });
}

/**
 * Connexion explicite à une instance : celles déjà connues et celles des remotes `origin` du workspace,
 * ou une URL saisie. Le token rangé est oublié, puis redemandé (PAT ou OAuth).
 * @param {vscode.ExtensionContext} context
 * @param {string[]} workspaceInstances
 */
async function signIn(context, workspaceInstances) {
  const otherInstance = t('Other instance…');
  const instances = [
    ...new Set([...workspaceInstances, ...context.globalState.get(INSTANCES_KEY, [])]),
  ];
  let instanceUrl = instances.length
    ? await vscode.window.showQuickPick([...instances, otherInstance], {
        title: t('MR Review: sign in to GitLab'),
      })
    : otherInstance;
  if (instanceUrl === otherInstance) {
    instanceUrl = await vscode.window.showInputBox({
      title: t('MR Review: sign in to GitLab'),
      prompt: t('GitLab instance URL'),
      value: 'https://gitlab.com',
      validateInput: (value) =>
        /^https?:\/\/[^/]+\/?$/.test(value.trim()) ? undefined : t('Expected: https://host'),
    });
  }
  if (!instanceUrl) {
    return;
  }
  const origin = new URL(instanceUrl.trim()).origin;
  await invalidateToken(context, origin);
  await getToken(context, origin);
  vscode.window.showInformationMessage(t('MR Review: signed in to {0}.', new URL(origin).host));
}

/** @param {vscode.ExtensionContext} context @param {string} instanceUrl */
async function rememberInstance(context, instanceUrl) {
  /** @type {Set<string>} */
  const instances = new Set(context.globalState.get(INSTANCES_KEY, []));
  await context.globalState.update(INSTANCES_KEY, [...instances.add(instanceUrl)]);
}

/**
 * Oublie le token d'une instance, refusé par GitLab : le prochain `getToken` relance la connexion.
 * @param {vscode.ExtensionContext} context
 * @param {string} instanceUrl
 */
async function invalidateToken(context, instanceUrl) {
  await context.secrets.delete(oauthSecretKey(instanceUrl));
  await context.secrets.delete(patSecretKey(instanceUrl));
}

/**
 * Oublie les tokens OAuth et les PAT de toutes les instances.
 * @param {vscode.ExtensionContext} context
 */
async function signOut(context) {
  /** @type {string[]} */
  const instances = context.globalState.get(INSTANCES_KEY, []);
  await Promise.all(instances.map((instanceUrl) => invalidateToken(context, instanceUrl)));
  await context.globalState.update(INSTANCES_KEY, []);
}

module.exports = { getToken, handleAuthenticationRedirect, invalidateToken, signIn, signOut };
