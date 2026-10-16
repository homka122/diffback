import * as vscode from 'vscode';
import { DiffController } from './diffs';
import { ReviewPanel } from './panel';
import { WindowPresence } from './presence';
import { ReviewController } from './review';

let shutdown: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const diffs = new DiffController(context);
  const review = new ReviewController(context, diffs);
  const panel = new ReviewPanel(context.extensionUri, review);
  const presence = new WindowPresence(() => diffs.repos());

  // Register the UI first, so a problem with one repo below cannot take the panel down with it.
  context.subscriptions.push(
    diffs,
    review,
    vscode.window.registerWebviewViewProvider(ReviewPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => review.onSelectionChanged(e)),
    vscode.window.onDidChangeVisibleTextEditors(() => review.decorate()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => diffs.start()),
    // Bring the Review panel up with the diff, so it is never an empty, unresolved view.
    diffs.onDidShowDiff(() => panel.show()),
    vscode.commands.registerCommand('diffback.publish', () => review.publish()),
    vscode.commands.registerCommand('diffback.showPanel', () => panel.show()),
  );

  try {
    review.applyConsumed(presence.takeConsumed());
  } catch (err) {
    console.error('diffback: could not read the state of earlier windows', err);
  }
  presence.start();
  diffs.start();
  review.decorate();

  shutdown = () => presence.stop((repo) => review.closingFor(repo));
}

/** Runs when the window closes or reloads: hand unsent comments to the agent-side watcher. */
export function deactivate(): void {
  shutdown?.();
}
