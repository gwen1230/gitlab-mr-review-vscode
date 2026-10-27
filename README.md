# MR Review

Relire une MR GitLab dans VS Code, dans une seule vue :

- le **diff natif** de VS Code : la merge-base de la MR à gauche, le **vrai fichier du worktree** à droite, donc Cmd+clic, références et survols fonctionnent ;
- les **discussions** de la MR affichées sur les lignes, avec réponse et résolution ;
- un **nouveau commentaire** se pose dans la marge (« + ») : en brouillon dans la review en cours, ou
  publié tout de suite.

## Ouvrir un fichier

Par lien, depuis un markdown, une page HTML ou un terminal :

```
vscode://local.mr-review/open?repo=<racine absolue du repo>&path=<chemin relatif>&line=<n>
```

L'extension prend la branche checkoutée dans `repo`, trouve sa MR ouverte sur le remote `origin`, et
ouvre le diff positionné sur la ligne. Un fichier ajouté s'affiche face à un document vide, un fichier
supprimé dans sa version de base.

Une fois la MR chargée, tout fichier de la MR ouvert d'une autre façon (Cmd+clic, Quick Open) est
commentable lui aussi, sur le fichier du worktree.

## Vue « Fichiers de la MR »

Icône MR Review de la barre d'activité :

- **💬 Discussions hors code** : les discussions générales de la MR, les fils posés sur une version
  précédente (leur ligne d'origine ne correspond plus forcément au code affiché) et les brouillons
  généraux. Ils s'ouvrent dans un document où l'on répond, résout, ou commente la MR (dernière ligne).
- **Fichiers** groupés 🔴 / 🟠 / 🟢 dans l'ordre du triage (`~/.claude/triage/<branche>.json`, écrit par
  le skill `triage-mr`), sinon par dossier. Chaque fichier affiche ses fils non résolus (💬 n) et une
  case « relu », qui se décoche si un commit retouche le fichier.
- **Points à vérifier du triage** (`checks` du JSON) : sous chaque fichier, à cocher une fois tranchés
  (`⚑ 1/3` sur le fichier). Dans l'éditeur, le point s'affiche en fin de ligne (barré une fois
  vérifié), est marqué dans la règle de défilement, et son survol propose « Marquer vérifié ».
- **Fichier suivant / précédent** : `ctrl+alt+→` / `ctrl+alt+←`, ou les flèches de la vue et du diff.
  « Suivant » coche le fichier quitté (réglage `mrReview.markViewedOnNext`).

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

`!iid`, nombre de fils non résolus, nombre de brouillons, 👍 si vous avez approuvé, état du pipeline
(relu toutes les 30 s tant qu'il tourne), ⚠ si le worktree n'est pas sur le dernier commit. Un clic
ouvre la MR dans GitLab.

La MR se recharge seule quand le HEAD du repo change (pull, checkout, commit).

## Prérequis

- **Branche à jour** : le HEAD du worktree doit être le dernier commit de la MR. Sinon les
  nouveaux commentaires sont désactivés, car leurs lignes seraient décalées. Un pull suffit : la MR se
  recharge seule. « MR Review : Rafraîchir la MR et ses commentaires » relit aussi les commentaires
  postés par les autres depuis.
- **Authentification** : connexion OAuth dans le navigateur, donc avec le SSO de l'instance. Il faut
  une fois créer une application dans GitLab > Préférences > Applications :
  - URI de redirection : `vscode://local.mr-review/authentication` ;
  - « Confidential » décoché (flux PKCE, pas de secret) ;
  - scope `api`.

  Puis déclarer son Application ID dans le réglage utilisateur :

  ```json
  "mrReview.oauthApplications": { "https://gitlab.com": "<Application ID>" }
  ```

  Le token est rangé dans le trousseau de VS Code et renouvelé automatiquement. S'il est révoqué côté
  GitLab (401), la connexion se relance d'elle-même. Sans application déclarée, un PAT (scope `api`)
  est demandé à la place. « MR Review : Se déconnecter de GitLab » efface les deux.

## Développer

```bash
npm install                  # typescript et types, pour la vérification de types seulement
npm run typecheck            # tsc --checkJs sur extension.js et src/
npm test                     # tests des fonctions pures (positions, discussions)
npm run package              # construit mr-review-<version>.vsix (sans vsce)
code --install-extension mr-review-<version>.vsix --force
```

Puis « Developer: Reload Window ».
