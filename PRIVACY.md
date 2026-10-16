# Privacy

diffback collects nothing.

- The VS Code extension and the Claude Code plugin make no network requests and contain no
  telemetry or analytics.
- Everything diffback stores stays on your machine, in your repository's git directory
  (`.git/diffback/`): the current diff request, your review comments until they are delivered, and
  an archive of delivered reviews in `.git/diffback/reviews/`. Delete that folder to remove them.
- Your review comments, and the code you selected, are handed to the Claude Code session you are
  working in, the same way anything you type to Claude is. What Claude Code does with them is
  covered by Anthropic's terms, not by diffback.
- The author receives no data of any kind.

Questions: https://github.com/homka122/diffback/issues
