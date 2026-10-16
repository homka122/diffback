# The file protocol

diffback has no server and no network traffic. The agent side and the VS Code extension talk through
a few files in `<git-dir>/diffback/` (usually `.git/diffback/`), so git never sees them.
The Claude Code plugin is one client of this protocol; any agent or script that can write and read
files can use it.

```
.git/diffback/
├── request.json          agent → VS Code   "show this diff"
├── request-ack.json      VS Code → agent   "shown" / "empty" / "error"
├── review.json           VS Code → agent   comments from Publish
├── alive-<pid>           VS Code           heartbeat of each open window
├── closing-<pid>.json    VS Code → agent   unsent comments of a window that closed
├── consumed/             agent → VS Code   closing files already delivered
├── watcher.pid           agent             the running wait-review.sh
└── reviews/              agent             everything the agent has read, for the record
```

JSON files are written to a temporary name and renamed into place, so a reader never sees half a file.

## Showing a diff: request.json and request-ack.json

The agent writes `request.json` and runs `code <repo>`. The extension in the window on that repo
reads it, lists the changed files with git and opens VS Code's multi-diff editor.

```json
{ "version": 1, "id": "1792167761-99630-16737", "created": 1792167761000, "scope": "staged" }
```

| Field | Meaning |
|---|---|
| `id` | Unique per request. A window handles each request once. |
| `created` | Unix time in milliseconds. Requests older than two minutes are ignored, so restarting VS Code does not replay an old diff. |
| `scope` | `"staged"` (HEAD → index), `"uncommitted"` (HEAD → working tree, including untracked files), or `{"base": "origin/main", "head": "HEAD"}` (merge base of the two → head). |

The extension answers in `request-ack.json`:

```json
{ "id": "1792167761-99630-16737", "status": "shown", "files": 7 }
```

`status` is `shown`, `empty` (nothing changed in that scope) or `error` (with a `message`).
`show-diff.sh` waits for the ack with its id and turns it into an exit code.

## Publishing: review.json

Written when the user presses **Publish**. If the agent has not picked up the previous file yet,
new comments are appended to it rather than replacing it. The agent should move the file away once
read (the plugin moves it into `reviews/`).

```json
{
  "version": 1,
  "repo": "/home/me/project",
  "published": "2026-10-16T15:56:29.699Z",
  "general": ["Looks good apart from the logging."],
  "comments": [
    {
      "file": "src/handlers.py",
      "side": "new",
      "lines": [85, 85],
      "start": { "line": 85, "col": 7 },
      "end": { "line": 85, "col": 16 },
      "code": "log.info(\"%",
      "comment": "Use log.debug here, this runs on every request."
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `file` | Path relative to the repo root. |
| `side` | `new` for the changed version, `old` for the version before the change. |
| `lines` | First and last line the selection covers, 1-based. A selection that ends at the very start of a line does not count that line. |
| `start`, `end` | Exact selection, 1-based line and column. |
| `code` | The selected text, verbatim. |
| `comment` | What the user wrote. |
| `unsaved` | Only in closing files: text that was still in the comment box, not yet added, when the window closed. |
| `general` | Overall notes from the box at the bottom of the panel. |

## Closing the window: alive, closing and consumed

Each VS Code window touches `alive-<pid>` every two seconds while it is open. When a window closes
or reloads, it removes its heartbeat and writes `closing-<pid>.json`: everything not yet published,
in the same shape as `review.json`, with `closed` instead of `published` and a `draftIds` list.
Closing with no comments still writes the file, with empty lists: it tells the agent the user is done.

A reload looks exactly like a close to the extension. The difference shows up afterwards: the
reloaded window starts beating again and deletes the closing files on startup. So the agent treats
closing files as a real close only when no heartbeat is fresher than six seconds and the newest
closing file is older than a grace period (`DIFFBACK_CLOSE_GRACE`, 10 seconds by default). A second
window still open on the same repo keeps the review going.

After delivering closing files, the agent copies them into `consumed/`. The next window that opens
on the repo drops the delivered comments from its drafts and empties `consumed/`, so nothing is sent
twice.

## One watcher per repo: watcher.pid

`wait-review.sh` writes its pid to `watcher.pid` and stops an older watcher it finds there, so
starting a new one is always safe. It also exits on its own when the agent session that started it
ends; the files simply wait for the next session.
