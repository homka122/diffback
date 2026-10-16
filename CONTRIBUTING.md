# Contributing

Thanks for taking the time. Bug reports with clear steps are as valuable as code.

## Layout

```
extension/          VS Code extension (TypeScript)
  src/              diff opener, review panel, file protocol
  media/            panel UI (plain JS + CSS), icons
plugin/             Claude Code plugin
  skills/diffback/  the skill Claude follows
  scripts/          show-diff.sh, wait-review.sh
.claude-plugin/     makes this repo a plugin marketplace
docs/               protocol notes and media
```

## Working on the extension

```sh
cd extension
bun install
bun run build        # or: bun run watch
```

Open the repo in VS Code and press F5 ("Run extension") to start an Extension Development Host with your build.
To try it end to end, open a git repo with some changes in that window and run
`bash plugin/scripts/show-diff.sh <that repo> uncommitted` from a terminal.

`bun run package` produces `extension/diffback.vsix`.

## Working on the plugin

Point Claude Code at your checkout instead of GitHub:

```
/plugin marketplace add /path/to/diffback
/plugin install diffback@diffback
```

After editing the skill or scripts, run `/plugin marketplace update diffback` and reinstall.
`claude plugin validate ./plugin --strict` checks the manifest. The scripts must stay compatible
with bash 3.2 (the default on macOS) and BSD userland; CI runs them on macOS and runs shellcheck.

## Pull requests

- Keep changes focused; one idea per PR.
- Describe how you tested it (which OS, VS Code version, which scope).
- If you change the files in `<git-dir>/diffback/`, update [docs/protocol.md](docs/protocol.md).
