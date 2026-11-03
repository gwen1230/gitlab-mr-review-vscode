# MR Review

[English](README.md) · **Français**

Relire une MR GitLab dans VS Code, dans une seule vue :

- le **diff natif** de VS Code : la merge-base de la MR à gauche, le **vrai fichier du worktree** à droite, donc Cmd+clic, références et survols fonctionnent ;
- les **discussions** de la MR affichées sur les lignes, avec réponse et résolution ;
- un **nouveau commentaire** se pose dans la marge (« + ») : en brouillon dans la review en cours, ou
  publié tout de suite.

## Installation

Téléchargez le `.vsix` de la [dernière release](https://github.com/gwen1230/gitlab-mr-review-vscode/releases/latest),
puis :

```bash
code --install-extension mr-review-<version>.vsix
```

ou, dans VS Code, vue Extensions > menu « … » > « Install from VSIX… ». L'interface suit la langue de
VS Code (anglais ou français).

Ouvrez ensuite un repo dont la branche checkoutée a une MR ouverte sur le remote `origin` : la vue
MR Review (barre d'activité) la charge. La première requête vers GitLab demande un token (voir
[Authentification](#authentification)).

## Ouvrir un fichier

Par lien, depuis un markdown, une page HTML ou un terminal :

```
vscode://gwen1230.mr-review/open?repo=<racine absolue du repo>&path=<chemin relatif>&line=<n>
```

L'extension prend la branche checkoutée dans `repo`, trouve sa MR ouverte sur le remote `origin`, et
ouvre le diff positionné sur la ligne. Un fichier ajouté s'affiche face à un document vide, un fichier
supprimé aussi (sa version de base à gauche) : c'est toujours une vue diff, avec ses boutons.

Une fois la MR chargée, tout fichier de la MR ouvert d'une autre façon (Cmd+clic, Quick Open) est
commentable lui aussi, sur le fichier du worktree.

## Vue « Fichiers de la MR »

Icône MR Review de la barre d'activité :

- **📄 Description** : état de merge (prête, draft, conflits, à rebaser, fils à résoudre, approbations
  manquantes…), auteur et approbateurs de la MR. Un clic ouvre la description dans l'aperçu
  markdown, avec les branches ; `#12` et `!34` y deviennent des liens vers le ticket et la MR. Les
  images jointes restent invisibles sur un projet privé : l'aperçu ne s'authentifie pas auprès de
  GitLab.
- **💬 Discussions hors code** : les discussions générales de la MR, les brouillons généraux, et les
  fils posés sur une version précédente dont la ligne a changé depuis. Comme dans GitLab, un fil d'une
  version précédente reste sur le code, à sa ligne décalée, tant que les commits suivants n'ont pas
  touché cette ligne. Ils s'ouvrent dans un document où l'on répond, résout, ou commente la MR
  (dernière ligne).
- **Fichiers** groupés 🔴 / 🟠 / 🟢 dans l'ordre du [triage](#triage) s'il y en a un, sinon par
  dossier. Chaque fichier affiche ses fils non résolus (💬 n) et une
  case « relu », qui se décoche si un commit retouche le fichier.
- **Chaque fichier** affiche ses lignes ajoutées et supprimées (`+12 -3`).
- **Bloc « Filtres »** au-dessus des fichiers : champ de recherche dans les chemins, filtré pendant la
  frappe (plusieurs termes séparés par des espaces, tous requis ; Échap vide le champ), case « Non
  relus seulement » et nombre de fichiers affichés. Les groupes se déplient pour montrer tous les
  résultats ; la navigation fichier suivant / précédent suit le filtre. Le bouton ✕ du titre des
  fichiers efface les deux.
- **🔄 Modifiés depuis ma relecture** : un fichier coché puis retouché par un commit se décoche et
  remonte dans ce groupe. Un clic ouvre le diff entre la version relue et la version actuelle ; les
  boutons de la ligne donnent le choix avec le diff complet de la MR. Le recocher enregistre la
  nouvelle version comme relue.
- **Points à vérifier du triage** (`checks` du JSON) : sous chaque fichier, les bloquants (🛑) en
  premier, à cocher une fois tranchés (`🛑 1 · ⚑ 1/3` sur le fichier, total des bloquants restants
  dans le titre de la vue). Dans l'éditeur, les points bloquants s'affichent en fin de ligne (barrés
  une fois vérifiés) et dans la règle de défilement ; `mrReview.showAllChecksInEditor` y ajoute les
  autres. Le survol de la ligne montre tous ses points et propose « Marquer vérifié » et
  « Commenter sur la MR » (aussi en bouton sur le point, dans la vue) : un brouillon de commentaire
  reprend la question sur sa ligne, à reformuler puis ajouter à la review ou publier.
- **Fil non résolu suivant / précédent** : `ctrl+alt+↓` / `ctrl+alt+↑` (ou le menu « … » de la vue),
  dans l'ordre des fichiers de la vue puis des lignes, puis les discussions hors code ; repart du
  début après le dernier.
- **Fichier suivant / précédent** : `ctrl+alt+→` / `ctrl+alt+←`, ou les flèches de la vue et du diff.
  « Suivant » coche le fichier quitté (réglage `mrReview.markViewedOnNext`).

## Triage

Le triage est **optionnel** et **n'est pas fourni** par l'extension : c'est un fichier JSON, produit par
l'outil de votre choix (script, linter, LLM…), qui classe les fichiers de la MR par attention à leur
porter et liste des points à vérifier. L'extension le lit et s'en sert pour :

- grouper et ordonner les fichiers de la vue (🔴 à lire attentivement, 🟠 à survoler, 🟢 de confiance) ;
- afficher les points à vérifier sous chaque fichier et sur leurs lignes dans l'éditeur, à cocher ou à
  transformer en commentaire ;
- signaler un triage périmé quand la MR a reçu des commits depuis.

### Format du fichier

Un fichier par branche : `<mrReview.triageDirectory>/<branche>.json` (`~/.mr-review/triage` par
défaut), les `/` de la branche remplacés par `-` (`feature/login` → `feature-login.json`).

```json
{
  "head": "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  "target": "main",
  "files": [
    {
      "path": "src/auth/session.ts",
      "level": "red",
      "line": 42,
      "reasons": "Changes token refresh; no test covers expiry.",
      "checks": [
        { "line": 57, "severity": "blocking", "question": "Is the refresh retried only once?" },
        { "line": 80, "question": "Should the error be logged?" }
      ]
    },
    { "path": "src/auth/session.test.ts", "level": "orange" },
    { "path": "README.md", "level": "green" }
  ]
}
```

| Champ                      | Obligatoire | Description                                                                |
| -------------------------- | ----------- | -------------------------------------------------------------------------- |
| `head`                     | oui         | SHA complet du commit trié ; différent du dernier commit de la MR : triage périmé |
| `target`                   | non         | branche cible triée ; différente de celle de la MR : avertissement         |
| `files`                    | oui         | fichiers dans l'ordre de lecture conseillé                                 |
| `files[].path`             | oui         | chemin relatif à la racine du repo                                         |
| `files[].level`            | oui         | `red`, `orange` ou `green`                                                 |
| `files[].line`             | non         | ligne où ouvrir le diff                                                    |
| `files[].reasons`          | non         | justification du niveau, affichée au survol                                |
| `files[].checks`           | non         | points à vérifier                                                          |
| `checks[].question`        | oui         | le point à vérifier                                                        |
| `checks[].line`            | non         | ligne concernée, dans la version `head`                                    |
| `checks[].severity`        | non         | `blocking` (🛑) ou `check` (défaut)                                        |

Les valeurs françaises `rouge` / `orange` / `vert` et `bloquant` / `à vérifier` sont aussi acceptées.
Les fichiers de la MR absents du triage s'affichent à part ; ceux du triage absents de la MR sont
ignorés.

### Lancer le triage depuis l'extension

Le réglage `mrReview.triageCommand` (vide par défaut) déclare une commande shell qui trie une MR sur
sa branche dans `origin`, sans checkout : la MR de la branche checkoutée (vue « Fichiers de la MR »)
ou n'importe quelle MR ouverte (vue « MR du projet »). Elle est lancée à la racine du repo, doit écrire
`$MR_REVIEW_TRIAGE_FILE`, et reçoit :

| Variable                | Valeur                                                    |
| ----------------------- | --------------------------------------------------------- |
| `MR_REVIEW_REPO`        | racine du repo                                            |
| `MR_REVIEW_BRANCH`      | branche source de la MR                                   |
| `MR_REVIEW_TARGET`      | branche cible de la MR                                    |
| `MR_REVIEW_HEAD`        | dernier commit de la MR                                   |
| `MR_REVIEW_BASE`        | merge-base de la MR                                       |
| `MR_REVIEW_IID`         | numéro de la MR                                           |
| `MR_REVIEW_URL`         | lien de la MR                                             |
| `MR_REVIEW_TRIAGE_FILE` | JSON à écrire, dans `mrReview.triageDirectory`            |

Par exemple :

```json
"mrReview.triageCommand": "~/bin/triage-mr \"$MR_REVIEW_BASE\" \"$MR_REVIEW_HEAD\" > \"$MR_REVIEW_TRIAGE_FILE\""
```

La commande passe par `/bin/sh` avec le `PATH` de VS Code, celui que donnent les fichiers de
connexion du shell (`.zprofile`, `.zshrc`…). Un exécutable que ces fichiers n'ajoutent pas au `PATH`
s'écrit en chemin absolu.

- **Lancement** : nœud « Lancer le triage » / « Mettre à jour le triage » en tête de la vue quand la
  branche n'a pas de triage ou qu'il est périmé, bouton ✨ du menu « … » de la vue, ou palette.
- **Pendant** : barre de progression sur la vue, nœud « Triage en cours… », ⟳ dans la barre d'état,
  sortie en direct dans le canal « MR Review — Triage », chaque ligne préfixée par `[!iid]` : plusieurs
  triages tournent en parallèle. ⏹ sur le nœud arrête le triage, « MR Review : Annuler le triage »
  (palette) les arrête tous.
- **Contrôle** : code de sortie 0, JSON lisible, au format attendu (niveaux, gravités, lignes) et fait
  sur le dernier commit de la MR. Un triage refusé est mis de côté (`<triage>.json.rejected`) et le
  précédent rétabli. Une autre cible ou des fichiers différents de ceux de la MR ne donnent qu'un
  avertissement. Un JSON non réécrit est accepté s'il est déjà à jour.

## Vue « MR du projet »

Les MR ouvertes du projet `origin` de chaque repo du workspace, dernière activité en premier, en trois
groupes : 👀 **À relire par moi** (relecteur), ✍ **Mes MR** (auteur), 📂 **Autres** (replié). Chaque
MR affiche son auteur, l'état de son triage (🔴/🛑 s'il est à jour, « périmé », « triage… ») et
« draft » ; son icône donne l'état de merge. Elle se déplie sur :

- 👤 **auteur**, branches source → cible, dernière activité ;
- **état de merge** : un clic ou ↗ ouvre la MR dans GitLab ;
- ✨ **triage** : à jour, périmé (commit trié), absent ou en cours. ▶ le lance ou le relance sans
  checkout, ⏹ l'arrête ;
- 👁 **Relire dans VS Code** (aussi en bouton sur la MR) : ouvre le worktree qui a déjà checkouté la
  branche, sinon bascule sur elle le worktree de relecture (réglage `mrReview.reviewWorktree`, refusé
  avec des modifications non commitées) puis l'ouvre, dans cette fenêtre si c'est déjà la sienne.

En tête : 🔍 filtre (titre, branche, auteur ou `!iid`, plusieurs termes), masquer les drafts, ⟳. La
liste se relit toutes les 5 min tant que la vue est visible. Une MR d'un fork, dont la branche n'est pas
sur `origin`, ne se trie ni ne se relit.

## Vue « Pipeline »

Sous les fichiers : les stages du dernier pipeline de la MR et leurs jobs, avec statut et durée. Les
stages en échec ou en cours sont dépliés ; un job en échec autorisé (`allow_failure`) s'affiche en
avertissement. Un clic ouvre le job dans GitLab. Un job `trigger` se déplie sur les stages et jobs de
son pipeline enfant (déplié d'office s'il échoue ou tourne) ; son bouton ↗ ouvre ce pipeline dans
GitLab. Les pipelines sont relus toutes les 30 s tant qu'ils tournent et que la vue est visible.

## Commenter

- **Une ligne** : « + » dans la marge. **Plusieurs lignes** : sélectionner les lignes, puis « + ».
- **Ajouter à la review** met le commentaire (ou la réponse) en brouillon, visible de vous seul.
  **Publier maintenant** le poste tout de suite.
- **Suggestion** : sélectionner le code côté branche, clic droit > « MR Review : Suggérer une
  modification ». Un bloc `suggestion` pré-rempli s'ouvre : le modifier, puis l'ajouter à la review ou
  le publier. L'auteur l'applique en un clic dans GitLab.
- **Ses propres commentaires et brouillons** se modifient (✎) et se suppriment (🗑) depuis le fil.
- **Soumettre la review** (✓✓ dans la vue, ou la palette) : publier les brouillons, avec ou sans
  approbation, approuver seul, ou retirer son approbation.

## Barre d'état

`!iid`, état de merge (icône, détail au survol), nombre de fils non résolus, nombre de brouillons, 👍 si
vous avez approuvé, état du pipeline, ⚠ si le worktree n'est pas sur le dernier commit. Un clic ouvre
la MR dans GitLab.

## Suivi de la MR

- **Relecture toutes les 30 s**, fenêtre au premier plan (et dès qu'elle y revient) : état de merge,
  pipeline, discussions. Les fils affichés reçoivent les nouvelles réponses et leur état résolu, les
  nouveaux fils apparaissent sur les fichiers ouverts.
- **Nouveaux commentaires** des autres signalés par une notification, « Afficher » ouvre le fil.
- **Nouveaux commits ou rebase sur GitLab** : la MR se recharge. Un commentaire de code est aussi
  refusé s'il partirait sur une version que GitLab a déjà dépassée.
- **Mettre à jour le worktree** (bouton de la vue, notification, ou palette) : avance rapide si la
  branche locale est en retard ; si elle a été rebasée ou force-pushée, alignement sur la MR après
  confirmation (`git reset --keep`, les commits remplacés restent dans le reflog). Refusé avec des
  modifications non commitées ou des commits locaux qui ne sont qu'à pousser.

La MR se recharge aussi quand le HEAD du repo change (pull, checkout, commit).

## Prérequis

- **Branche à jour** : le HEAD du worktree doit être le dernier commit de la MR. Sinon les
  nouveaux commentaires sont désactivés, car leurs lignes seraient décalées. « MR Review : Mettre à
  jour le worktree » s'en charge, rebase compris : la MR se recharge seule.

## Authentification

Un token par instance GitLab, rangé dans le trousseau de VS Code. Deux façons de l'obtenir :

- **Personal access token** (par défaut, aucune configuration) : à la première requête, l'extension
  le demande dans un champ masqué. Le bouton ↗ du champ ouvre la page de création de GitLab, nom et
  scope `api` pré-remplis : il reste à le créer et le coller.
- **OAuth / SSO** (optionnel) : connexion dans le navigateur, avec le SSO de l'instance, et
  renouvellement automatique. Utile quand les PAT sont interdits ou de courte durée. Créez une fois
  une application dans GitLab > Préférences > Applications (une application utilisateur suffit) :
  - URI de redirection : `vscode://gwen1230.mr-review/authentication` ;
  - « Confidential » décoché (flux PKCE, pas de secret) ;
  - scope `api`.

  Puis déclarez son Application ID dans le réglage utilisateur :

  ```json
  "mrReview.oauthApplications": { "https://gitlab.com": "<Application ID>" }
  ```

Un token refusé par GitLab (401 : expiré ou révoqué) est oublié et redemandé. « MR Review : Se
connecter à GitLab » saisit ou remplace un token sans attendre, « MR Review : Se déconnecter de
GitLab » les efface tous.

## Développer

```bash
npm install                  # typescript et types, pour la vérification de types seulement
npm run typecheck            # tsc --checkJs sur extension.js et src/
npm test                     # tests des fonctions pures et couverture des traductions
npm run package              # construit mr-review-<version>.vsix (sans vsce)
code --install-extension mr-review-<version>.vsix --force
```

Puis « Developer: Reload Window ».

Les chaînes de l'interface sont en anglais dans le code (`t('…')` de `src/l10n.js`, `%clé%` dans
`package.json`) ; leur traduction française est dans `l10n/bundle.l10n.fr.json` et
`package.nls.fr.json`. `npm test` échoue si une traduction manque.

Les commits suivent [Conventional Commits](https://www.conventionalcommits.org/fr/) : release-please
en tire le CHANGELOG et la version, et publie le `.vsix` dans la release GitHub.

## Licence

[MIT](LICENSE)
