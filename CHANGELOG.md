# Changelog

All notable changes to the diffback extension and Claude Code plugin.

## 0.1.0

- Claude opens one scrollable multi-file diff in VS Code for staged changes, uncommitted changes, or a branch (`main...HEAD`).
- Review panel: select any code, on either side of the diff, and comment on it. Comments are highlighted in the editor and survive reloads.
- Publish sends every comment, with file, lines and the selected code, straight back to the agent.
- Closing the VS Code window delivers whatever was not published yet.
- Clicking a comment scrolls the diff back to it.
