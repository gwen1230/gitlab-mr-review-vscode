# MR Review

**English** · [Français](README.fr.md)

Review a GitLab merge request (MR) in VS Code, in a single view:

- VS Code's **native diff**: the MR merge-base on the left, the **real worktree file** on the right, so
  Cmd+click, references and hovers just work;
- the MR **discussions** shown on their lines, with reply and resolve;
- a **new comment** starts from the gutter ("+"): as a draft in the pending review, or posted right
  away.

## Installation

Download the `.vsix` from the [latest release](https://github.com/gwen1230/gitlab-mr-review-vscode/releases/latest),
then:

```bash
code --install-extension mr-review-<version>.vsix
```

or, in VS Code, Extensions view > "…" menu > "Install from VSIX…". The UI follows VS Code's display
language (English or French).

Then open a repository whose checked-out branch has an open MR on the `origin` remote: the MR Review
view (activity bar) loads it. The first GitLab request asks for a token (see
[Authentication](#authentication)).

## Opening a file

From a link, in markdown, an HTML page or a terminal:

```
vscode://gwen1230.mr-review/open?repo=<absolute repo root>&path=<relative path>&line=<n>
```

The extension takes the branch checked out in `repo`, finds its open MR on the `origin` remote, and
opens the diff at that line. An added file is shown against an empty document, and so is a deleted
file (its base version on the left): it is always a diff view, with its buttons.

Once the MR is loaded, any MR file opened another way (Cmd+click, Quick Open) can be commented on
too, on the worktree file.

## "MR files" view

MR Review icon in the activity bar:

- **📄 Description**: merge status (ready, draft, conflicts, needs rebase, unresolved threads, missing
  approvals…), author and approvers. A click opens the description in the markdown preview, with the
  branches; `#12` and `!34` become links to the issue and the MR. Attached images stay hidden on a
  private project: the preview doesn't authenticate with GitLab.
- **💬 Discussions outside code**: the MR general discussions, general drafts, and threads posted on a
  previous version whose line has changed since. As in GitLab, a thread from a previous version stays
  on the code, at its shifted line, as long as later commits haven't touched that line. They open in a
  document where you reply, resolve, or comment on the MR (last line).
- **Files** grouped 🔴 / 🟠 / 🟢 in [triage](#triage) order when there is one, by folder otherwise.
  Each file shows its unresolved threads (💬 n) and a "viewed" checkbox, which is cleared when a commit
  touches the file again.
- **Each file** shows its added and removed lines (`+12 -3`).
- **"Filters" block** above the files: path search, filtered as you type (several space-separated
  terms, all required; Escape clears the field), "Unviewed only" checkbox, and the number of files
  shown. Groups expand to show every match; next / previous file navigation follows the filter. The ✕
  button in the files title clears both.
- **🔄 Changed since my review**: a viewed file touched again by a commit is unchecked and moves to this
  group. A click opens the diff between the reviewed version and the current one; the row buttons
  offer the full MR diff as well. Checking it again records the new version as reviewed.
- **Triage checks** (`checks` in the JSON): under each file, blocking ones (🛑) first, to check off once
  settled (`🛑 1 · ⚑ 1/3` on the file, remaining blocking checks in the view title). In the editor,
  blocking checks show at the end of their line (struck through once verified) and in the overview
  ruler; `mrReview.showAllChecksInEditor` adds the others. The line hover shows all its checks and
  offers "Mark as verified" and "Comment on the MR" (also a button on the check, in the view): a draft
  comment quotes the question on its line, to rephrase then add to the review or post.
- **Next / previous unresolved thread**: `ctrl+alt+↓` / `ctrl+alt+↑` (or the view's "…" menu), in the
  view's file order then line order, then discussions outside code; wraps around after the last one.
- **Next / previous file**: `ctrl+alt+→` / `ctrl+alt+←`, or the arrows of the view and of the diff.
  "Next" marks the file you leave as viewed (setting `mrReview.markViewedOnNext`).

## Triage

Triage is **optional** and **not provided** by the extension: it is a JSON file, produced by the tool
of your choice (script, linter, LLM…), that ranks the MR files by how much attention they need and
lists checks to make. The extension reads it to:

- group and order the files of the view (🔴 read carefully, 🟠 skim, 🟢 trusted);
- show checks under each file and on their lines in the editor, to check off or turn into a comment;
- flag a stale triage when the MR got new commits since.

### File format

One file per branch: `<mrReview.triageDirectory>/<branch>.json` (`~/.mr-review/triage` by default),
with the branch's `/` replaced by `-` (`feature/login` → `feature-login.json`).

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

| Field               | Required | Description                                                          |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `head`              | yes      | full SHA of the triaged commit; not the MR's latest commit: stale    |
| `target`            | no       | triaged target branch; different from the MR's: warning              |
| `files`             | yes      | files in recommended reading order                                   |
| `files[].path`      | yes      | path relative to the repository root                                 |
| `files[].level`     | yes      | `red`, `orange` or `green`                                           |
| `files[].line`      | no       | line to open the diff at                                             |
| `files[].reasons`   | no       | why this level, shown on hover                                       |
| `files[].checks`    | no       | checks to make                                                       |
| `checks[].question` | yes      | the check                                                            |
| `checks[].line`     | no       | line concerned, in the `head` version                                |
| `checks[].severity` | no       | `blocking` (🛑) or `check` (default)                                 |

French values `rouge` / `orange` / `vert` and `bloquant` / `à vérifier` are accepted too. MR files
missing from the triage are shown apart; triage files that aren't in the MR are ignored.

### Running the triage from the extension

The `mrReview.triageCommand` setting (empty by default) declares a shell command that triages an MR
from its branch on `origin`, without checking it out: the MR of the checked-out branch ("MR files"
view) or any open MR ("Project MRs" view). It runs at the repository root, must write
`$MR_REVIEW_TRIAGE_FILE`, and receives:

| Variable                | Value                                          |
| ----------------------- | ---------------------------------------------- |
| `MR_REVIEW_REPO`        | repository root                                |
| `MR_REVIEW_BRANCH`      | MR source branch                               |
| `MR_REVIEW_TARGET`      | MR target branch                               |
| `MR_REVIEW_HEAD`        | MR latest commit                               |
| `MR_REVIEW_BASE`        | MR merge-base                                  |
| `MR_REVIEW_IID`         | MR number                                      |
| `MR_REVIEW_URL`         | MR link                                        |
| `MR_REVIEW_TRIAGE_FILE` | JSON to write, in `mrReview.triageDirectory`   |

For example:

```json
"mrReview.triageCommand": "~/bin/triage-mr \"$MR_REVIEW_BASE\" \"$MR_REVIEW_HEAD\" > \"$MR_REVIEW_TRIAGE_FILE\""
```

The command runs through `/bin/sh` with VS Code's `PATH`, the one set by the shell login files
(`.zprofile`, `.zshrc`…). An executable those files don't add to the `PATH` needs an absolute path.

- **Start**: "Run triage" / "Update triage" node at the top of the view when the branch has no
  triage or a stale one, ✨ button in the view's "…" menu, or the command palette.
- **While running**: progress bar on the view, "Triage running…" node, ⟳ in the status bar, live
  output in the "MR Review — Triage" channel, each line prefixed with `[!iid]`: several triages run in
  parallel. ⏹ on the node stops it, "MR Review: Cancel triage" (palette) stops them all.
- **Checks**: exit code 0, readable JSON, in the expected format (levels, severities, lines) and made
  on the MR's latest commit. A rejected triage is set aside (`<triage>.json.rejected`) and the
  previous one restored. Another target or files different from the MR's only give a warning. A JSON
  that wasn't rewritten is accepted if it is already up to date.

## "Project MRs" view

Open MRs of the `origin` project of each workspace repository, most recent activity first, in three
groups: 👀 **To review** (reviewer), ✍ **My MRs** (author), 📂 **Others** (collapsed). Each MR shows its
author, its triage state (🔴/🛑 when up to date, "outdated", "triage…") and "draft"; its icon gives the
merge status. It expands to:

- 👤 **author**, source → target branches, last activity;
- **merge status**: a click or ↗ opens the MR in GitLab;
- ✨ **triage**: up to date, outdated (triaged commit), missing or running. ▶ runs it or runs it again
  without checkout, ⏹ stops it;
- 👁 **Review in VS Code** (also a button on the MR): opens the worktree that already has the branch
  checked out, otherwise switches the review worktree to it (setting `mrReview.reviewWorktree`,
  refused with uncommitted changes) then opens it, in this window if it is already its own.

At the top: 🔍 filter (title, branch, author or `!iid`, several terms), hide drafts, ⟳. The list is
refreshed every 5 min while the view is visible. An MR from a fork, whose branch isn't on `origin`,
can be neither triaged nor reviewed.

## "Pipeline" view

Below the files: the stages of the MR's latest pipeline and their jobs, with status and duration.
Failed or running stages are expanded; an allowed failure (`allow_failure`) shows as a warning. A
click opens the job in GitLab. A `trigger` job expands to the stages and jobs of its child pipeline
(expanded by default when it fails or runs); its ↗ button opens that pipeline in GitLab. Pipelines are
refreshed every 30 s while they run and the view is visible.

## Commenting

- **One line**: "+" in the gutter. **Several lines**: select them, then "+".
- **Add to review** saves the comment (or reply) as a draft, visible only to you. **Post now** posts it
  right away.
- **Suggestion**: select code on the branch side, right-click > "MR Review: Suggest a change". A
  prefilled `suggestion` block opens: edit it, then add it to the review or post it. The author applies
  it in one click in GitLab.
- **Your own comments and drafts** can be edited (✎) and deleted (🗑) from the thread.
- **Submit review** (✓✓ in the view, or the palette): post the drafts, with or without approval,
  approve only, or revoke your approval.

## Status bar

`!iid`, merge status (icon, details on hover), unresolved threads, drafts, 👍 if you approved,
pipeline status, ⚠ if the worktree isn't on the latest commit. A click opens the MR in GitLab.

## Keeping up with the MR

- **Refreshed every 30 s** while the window is focused (and as soon as it gets focus back): merge
  status, pipeline, discussions. Displayed threads get new replies and their resolved state, new
  threads show up on open files.
- **New comments** from others raise a notification; "Show" opens the thread.
- **New commits or rebase on GitLab**: the MR reloads. A code comment is also refused if it would land
  on a version GitLab has already moved past.
- **Update worktree** (view button, notification, or palette): fast-forward when the local branch is
  behind; if it was rebased or force-pushed, aligns it with the MR after confirmation
  (`git reset --keep`, replaced commits stay in the reflog). Refused with uncommitted changes or local
  commits that only need pushing.

The MR also reloads when the repository HEAD changes (pull, checkout, commit).

## Requirements

- **Up-to-date branch**: the worktree HEAD must be the MR's latest commit. Otherwise new comments are
  disabled, since their lines would be shifted. "MR Review: Update worktree" handles it, rebase
  included: the MR reloads by itself.

## Authentication

One token per GitLab instance, stored in VS Code's secret storage. Two ways to get it:

- **Personal access token** (default, nothing to configure): on the first request, the extension asks
  for it in a masked field. The field's ↗ button opens GitLab's token page with the name and the
  `api` scope prefilled: create it and paste it.
- **OAuth / SSO** (optional): sign in in the browser, with the instance's SSO, and automatic refresh.
  Useful when personal access tokens are forbidden or short-lived. Create an application once in
  GitLab > Preferences > Applications (a user application is enough):
  - redirect URI: `vscode://gwen1230.mr-review/authentication`;
  - "Confidential" unchecked (PKCE flow, no secret);
  - scope `api`.

  Then declare its Application ID in your user settings:

  ```json
  "mrReview.oauthApplications": { "https://gitlab.com": "<Application ID>" }
  ```

A token rejected by GitLab (401: expired or revoked) is forgotten and asked for again. "MR Review:
Sign in to GitLab" enters or replaces a token right away, "MR Review: Sign out of GitLab" clears them
all.

## Development

```bash
npm install                  # typescript and types, for type checking only
npm run typecheck            # tsc --checkJs on extension.js and src/
npm test                     # pure function tests and translation coverage
npm run package              # builds mr-review-<version>.vsix (without vsce)
code --install-extension mr-review-<version>.vsix --force
```

Then "Developer: Reload Window".

UI strings are in English in the code (`t('…')` from `src/l10n.js`, `%key%` in `package.json`);
their French translation lives in `l10n/bundle.l10n.fr.json` and `package.nls.fr.json`. `npm test`
fails when a translation is missing.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): release-please derives the
CHANGELOG and the version from them, and attaches the `.vsix` to the GitHub release.

## License

[MIT](LICENSE)
