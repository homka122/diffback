---
name: diffback
description: Show the user your changes as one scrollable diff in VS Code and collect their review comments before committing, amending, pushing or opening a pull request. Use before every `git commit`, `git commit --amend`, `git push` and `gh pr create`, and whenever the user asks to see, review or check the changes or the diff.
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/show-diff.sh *), Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/wait-review.sh *)
---

# Review the diff with the user before it leaves your hands

The user reviews your changes the way they would review a pull request. Nothing is committed,
amended, pushed or opened as a PR until they explicitly approve in chat.

## 1. Pick the scope

| Before | Prepare | Scope |
|---|---|---|
| a commit | Stage exactly what the commit should contain: check `git status --short`, stage files by name, not with `git add -A`. If something unrelated is already staged, ask before unstaging it. | `staged` |
| an amend | Stage the additions. Say that the diff shows only what the amend adds; offer `HEAD~1...HEAD` if they want the whole commit. | `staged` |
| a push | Find the upstream (`git rev-parse --abbrev-ref @{u}`). If these commits were already reviewed and approved in this session, skip the review. | `<upstream>...HEAD` |
| a pull request | `git fetch origin`, then take the default branch from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` or `git symbolic-ref --short refs/remotes/origin/HEAD`. Use the remote-tracking ref, e.g. `origin/main`, never a possibly stale local branch. Mention uncommitted changes: they will not be in the PR. | `origin/<base>...HEAD` |
| the user just wants to look | Nothing. | `uncommitted` (includes new files) |

## 2. Summarize in chat

Run `git diff --stat` for the scope, then give one or two lines per file: what changed and why.
Point out anything worth a second look: debug output, commented-out code, secrets, unrelated
changes, generated or lock files.

## 3. Open the diff, then wait for comments

```
bash ${CLAUDE_PLUGIN_ROOT}/scripts/show-diff.sh <repo> <scope>
```

It opens VS Code on the repo with every changed file in one scrollable diff, and returns once the
diff is on screen. Exit code 3: nothing to show. Exit code 1: a setup or git problem; relay the
message, it says what to install or fix.

Then start the watcher **in the background** (`run_in_background: true`). It replaces any older
watcher for the same repo, so just start it:

```
bash ${CLAUDE_PLUGIN_ROOT}/scripts/wait-review.sh <repo>
```

Tell the user the diff is open and how many files it has, and that they can select any code,
comment on it in the side panel and press **Publish**, or just close the window when done.

## 4. Handle the review

The watcher finishes when the user publishes or closes the window, and prints JSON:

- `general`: overall notes.
- `comments[]`: `file`, `side` (`new` or `old` version), `lines` [first, last], `start`/`end`
  (line and column), `code` (the selected text), `comment`. `unsaved: true` marks text the user was
  still typing when the window closed: treat it as a comment, but mention it was not submitted.
- `closed`: present when the window was closed. No comments then means "looked, nothing to add":
  ask in chat how to proceed.

Go through every comment: `file:lines → what you will do`. Answer questions in chat without
touching code. If nothing needs to change, start the watcher again right away so the next Publish
reaches you. Otherwise make the changes and show the new state:

- commit or amend flow: stage the fixes and show `staged` again;
- push or PR flow: the fixes are not in the commits yet, so show them as `uncommitted` and say it
  is the follow-up; once the user agrees, commit them and, if asked, show the whole range again.

Start the watcher again after each new diff.

## 5. Wait for an explicit OK

Publishing comments or closing the window is **not** approval. Commit, push or open the PR only
after the user says so in chat. Before committing, propose the commit message (or PR title and
description) and let the user adjust it.

Once the user approves, or the review is over, stop the background watcher. If the user answers
in chat while it is still running, leave it: it does nothing until the next Publish.
