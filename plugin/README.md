# diffback

Claude Code plugin. It needs the diffback VS Code extension:
`code --install-extension homka122.diffback` (VS Code Marketplace), Open VSX for Cursor and
VSCodium, or the VSIX from https://github.com/homka122/diffback/releases. It does nothing in
claude.ai chat or Cowork.

Before a commit or amend, Claude stages what it plans to commit and runs `scripts/show-diff.sh`.
Before a push or pull request it shows the branch against its base, and when you ask to see the
changes it shows everything uncommitted, new files included. The script opens VS Code on your
repository with one multi-file diff. You select any code, comment on it in the Review panel and
press Publish. `scripts/wait-review.sh` waits in the background for the comments and prints them
to Claude, which answers each one, fixes the code and shows the diff again. Claude still waits for
your OK in chat before it commits, pushes or opens a PR.

What the scripts touch: they run `git` and your editor CLI (`code`, or `DIFFBACK_EDITOR`), and they
read and write JSON files in `<git-dir>/diffback/`. Nothing is sent over the network. There is no
telemetry and no account.

Requirements: VS Code 1.106+, git, bash. Tested on Linux (Fedora). On macOS the scripts run in CI
under stock bash, but the extension is untested there; Windows is untested.

Full docs: https://github.com/homka122/diffback. License: MIT.
