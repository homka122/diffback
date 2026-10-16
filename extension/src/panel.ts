import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ReviewController } from './review';

type PanelMessage =
  | { type: 'ready' }
  | { type: 'draftInput'; body: string }
  | { type: 'generalInput'; text: string }
  | { type: 'save'; body: string }
  | { type: 'cancel' }
  | { type: 'edit' | 'delete' | 'reveal'; id: string }
  | { type: 'publish' };

export class ReviewPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'diffback.review';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly review: ReviewController,
  ) {
    review.onDidChange(() => this.render());
    review.onDidRequestPanel(() => void this.show());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: PanelMessage) => this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Brings the panel up without stealing focus from the editor, so the selection survives. */
  async show(): Promise<void> {
    if (this.view) {
      if (!this.view.visible) this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${ReviewPanel.viewId}.focus`);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  private render(): void {
    void this.view?.webview.postMessage({ type: 'state', ...this.review.panelState() });
  }

  private async onMessage(m: PanelMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.render();
        break;
      case 'draftInput':
        this.review.setDraftBody(m.body);
        break;
      case 'generalInput':
        this.review.setGeneral(m.text);
        break;
      case 'save':
        this.review.saveDraft(m.body);
        break;
      case 'cancel':
        this.review.cancelDraft();
        break;
      case 'edit':
        this.review.editComment(m.id);
        break;
      case 'delete':
        this.review.deleteComment(m.id);
        break;
      case 'reveal':
        await this.review.revealComment(m.id);
        break;
      case 'publish':
        this.review.publish();
        break;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${asset('panel.css')}">
</head>
<body>
  <p id="hint" class="hint">Select code in any editor — whole lines or a few characters — and write your comment here.</p>

  <section id="draft" class="card" hidden>
    <div id="draft-location" class="location"></div>
    <pre id="draft-code"></pre>
    <textarea id="draft-body" placeholder="What should change?"></textarea>
    <div class="keys">Ctrl+Enter to add · Esc to cancel</div>
    <div class="row">
      <button id="cancel" class="secondary">Cancel</button>
      <button id="save">Add</button>
    </div>
  </section>

  <section id="list-section" hidden>
    <h3 id="list-title"></h3>
    <div id="list" class="list"></div>
  </section>

  <footer>
    <textarea id="general" placeholder="Overall note (optional)"></textarea>
    <div class="row">
      <span id="status" class="status"></span>
      <button id="publish" disabled>Publish</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }
}
