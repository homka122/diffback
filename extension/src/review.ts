import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffController, DiffSide, filePath } from './diffs';
import { Consumed } from './presence';
import { findRepo, readJson, STATE_FILES, stateDir, writeJsonAtomic } from './state';

const COMMENTS_KEY = 'diffback.comments';
const GENERAL_KEY = 'diffback.general';
/** Our own cursor moves fire selection events too; ignore them for this long. */
const OWN_SELECTION_GRACE_MS = 1000;

interface PlainRange {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

interface Comment {
  id: string;
  repo: string;
  file: string;
  side: DiffSide;
  uri: string;
  range: PlainRange;
  code: string;
  body: string;
}

/** A selection waiting for a comment, or an existing comment being edited (`editId`). */
type Draft = Omit<Comment, 'id' | 'body'> & { editId?: string; body: string };

/** The shape the agent reads. Lines and columns are 1-based. */
export interface AgentComment {
  file: string;
  side: DiffSide;
  lines: [number, number];
  start: { line: number; col: number };
  end: { line: number; col: number };
  code: string;
  comment: string;
  /** Set on text that was still in the comment box, not yet added, when the window closed. */
  unsaved?: true;
}

export interface ReviewFile {
  version: 1;
  repo: string;
  published?: string;
  closed?: string;
  general: string[];
  comments: AgentComment[];
  /** Only in closing files: lets the next window drop drafts the agent already received. */
  draftIds?: string[];
}

export interface PanelState {
  draft: { key: string; location: string; code: string; editing: boolean; body: string } | null;
  comments: { id: string; location: string; code: string; body: string }[];
  general: string;
  status: string;
}

const toPlain = (r: vscode.Range): PlainRange => ({
  sl: r.start.line,
  sc: r.start.character,
  el: r.end.line,
  ec: r.end.character,
});
const toRange = (p: PlainRange) => new vscode.Range(p.sl, p.sc, p.el, p.ec);

/** Lines as the user sees them: a selection ending at column 0 does not include that line. */
function lineSpan(r: PlainRange): [number, number] {
  const end = r.ec === 0 && r.el > r.sl ? r.el - 1 : r.el;
  return [r.sl + 1, end + 1];
}

function location(c: Pick<Comment, 'file' | 'side' | 'range'>): string {
  const [a, b] = lineSpan(c.range);
  return `${c.file}:${a}${b === a ? '' : `–${b}`}${c.side === 'old' ? ' (before)' : ''}`;
}

function toAgent(c: Omit<Comment, 'id' | 'repo' | 'uri'>): AgentComment {
  return {
    file: c.file,
    side: c.side,
    lines: lineSpan(c.range),
    start: { line: c.range.sl + 1, col: c.range.sc + 1 },
    end: { line: c.range.el + 1, col: c.range.ec + 1 },
    code: c.code,
    comment: c.body,
  };
}

export class ReviewController implements vscode.Disposable {
  private comments: Comment[];
  private general: string;
  private draft: Draft | null = null;
  private status = '';
  private selectionTimer: NodeJS.Timeout | undefined;
  private ignoreSelectionUntil = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly panelRequested = new vscode.EventEmitter<void>();
  /** Fires whenever the panel should re-render. */
  readonly onDidChange = this.changed.event;
  /** Fires when a fresh selection wants the panel on screen. */
  readonly onDidRequestPanel = this.panelRequested.event;

  private readonly commentDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    borderRadius: '2px',
  });
  private readonly draftDecoration = vscode.window.createTextEditorDecorationType({
    border: '1px dashed',
    borderColor: new vscode.ThemeColor('focusBorder'),
    borderRadius: '2px',
  });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diffs: DiffController,
  ) {
    this.comments = context.workspaceState.get<Comment[]>(COMMENTS_KEY, []);
    this.general = context.workspaceState.get<string>(GENERAL_KEY, '');
  }

  dispose(): void {
    clearTimeout(this.selectionTimer);
    this.commentDecoration.dispose();
    this.draftDecoration.dispose();
    this.changed.dispose();
    this.panelRequested.dispose();
  }

  /** Drops what the agent already received when an earlier window closed. */
  applyConsumed(consumed: Consumed): void {
    if (!consumed.draftIds.size && !consumed.general) return;
    this.comments = this.comments.filter((c) => !consumed.draftIds.has(c.id));
    if (consumed.general) this.general = '';
    this.persist();
  }

  // ---- selection → draft ----

  onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): void {
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command || Date.now() < this.ignoreSelectionUntil) return;
    clearTimeout(this.selectionTimer);
    const delay = vscode.workspace.getConfiguration('diffback').get<number>('selectionDelay', 100);
    this.selectionTimer = setTimeout(() => this.takeSelection(e.textEditor), delay);
  }

  private takeSelection(editor: vscode.TextEditor): void {
    if (this.draft?.editId) return; // editing an existing comment; new selections don't hijack it
    const selection = editor.selection;
    const code = editor.document.getText(selection);
    if (!code.trim()) {
      // Clicking elsewhere dismisses an untouched draft.
      if (this.draft && !this.draft.body.trim()) this.setDraft(null);
      return;
    }
    const target = this.describe(editor.document.uri);
    if (!target) return;
    this.status = '';
    // A new selection moves the draft; text already typed stays with it.
    this.setDraft({ ...target, uri: editor.document.uri.toString(), range: toPlain(selection), code, body: this.draft?.body ?? '' });
    this.panelRequested.fire();
  }

  /** Repo, path and diff side of a document, or undefined if it is not inside a git repo. */
  private describe(uri: vscode.Uri): Pick<Comment, 'repo' | 'file' | 'side'> | undefined {
    const file = filePath(uri);
    const repo = file && findRepo(path.dirname(file));
    if (!file || !repo) return undefined;
    return { repo, file: path.relative(repo, file), side: this.diffs.sideOf(repo, uri) };
  }

  // ---- panel actions ----

  setDraftBody(body: string): void {
    if (this.draft) this.draft.body = body;
  }

  setGeneral(text: string): void {
    this.general = text;
    void this.context.workspaceState.update(GENERAL_KEY, text);
  }

  saveDraft(body: string): void {
    const text = body.trim();
    if (!this.draft || !text) return;
    const { editId, body: _typed, ...target } = this.draft;
    if (editId) {
      const comment = this.comments.find((c) => c.id === editId);
      if (comment) comment.body = text;
    } else {
      this.comments.push({ ...target, id: randomUUID(), body: text });
      this.comments.sort((a, b) => a.file.localeCompare(b.file) || a.range.sl - b.range.sl);
    }
    this.persist();
    this.setDraft(null);
    void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  cancelDraft(): void {
    this.setDraft(null);
    void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  editComment(id: string): void {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return;
    const { id: editId, ...rest } = comment;
    this.setDraft({ ...rest, editId });
  }

  deleteComment(id: string): void {
    this.comments = this.comments.filter((c) => c.id !== id);
    this.persist();
    if (this.draft?.editId === id) this.setDraft(null);
    else this.refresh();
  }

  async revealComment(id: string): Promise<void> {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return;
    const uri = vscode.Uri.parse(comment.uri);
    const range = toRange(comment.range);
    if (await this.diffs.reveal(comment.repo, uri, range)) {
      await this.placeCursor(uri, range.start);
    } else {
      await vscode.window.showTextDocument(uri, { selection: range, preview: true });
    }
  }

  /** Diff editors are created lazily as they scroll into view, so wait for ours to appear. */
  private async placeCursor(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const key = uri.toString();
    for (let attempt = 0; attempt < 20; attempt++) {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
      if (editor) {
        this.ignoreSelectionUntil = Date.now() + OWN_SELECTION_GRACE_MS;
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ---- publishing ----

  /**
   * Appends comments and the overall note to each repo's review.json (an unread earlier
   * publish is extended, not replaced). Only what was actually written is cleared.
   */
  publish(): void {
    const general = this.general.trim();
    if (!this.comments.length && !general) return;
    const repos = [...new Set(this.comments.map((c) => c.repo))];
    const noteRepo = this.noteRepo();
    if (general && noteRepo && !repos.includes(noteRepo)) repos.push(noteRepo);

    let sent = 0;
    let noteSent = false;
    const failed: string[] = [];
    for (const repo of repos) {
      const dir = stateDir(repo);
      if (!dir) {
        failed.push(repo);
        continue;
      }
      const file = path.join(dir, STATE_FILES.review);
      const review = readJson<ReviewFile>(file) ?? { version: 1, repo, general: [], comments: [] };
      const mine = this.comments.filter((c) => c.repo === repo);
      review.comments.push(...mine.map(toAgent));
      if (general && repo === noteRepo) {
        review.general.push(general);
        noteSent = true;
      }
      review.published = new Date().toISOString();
      writeJsonAtomic(file, review);
      sent += mine.length;
      this.comments = this.comments.filter((c) => c.repo !== repo);
    }
    if (noteSent) this.setGeneral('');
    this.persist();

    this.status = `Sent to your agent: ${sent} comment${sent === 1 ? '' : 's'}${noteSent ? ' and the overall note' : ''}.`;
    if (failed.length) {
      this.status = '';
      void vscode.window.showErrorMessage(`diffback: not a git repository, comments kept: ${failed.join(', ')}`);
    }
    this.refresh();
  }

  /** Everything not yet sent for one repo, including text still in the comment box. */
  closingFor(repo: string): ReviewFile {
    const mine = this.comments.filter((c) => c.repo === repo);
    const comments = mine.map(toAgent);
    if (this.draft?.repo === repo && this.draft.body.trim() && !this.draft.editId) {
      comments.push({ ...toAgent({ ...this.draft, body: this.draft.body.trim() }), unsaved: true });
    }
    return {
      version: 1,
      repo,
      closed: new Date().toISOString(),
      general: repo === this.noteRepo() && this.general.trim() ? [this.general.trim()] : [],
      comments,
      draftIds: mine.map((c) => c.id),
    };
  }

  /** The overall note goes to one repo: the first one with comments, else the first in the window. */
  private noteRepo(): string | undefined {
    return [...this.comments.map((c) => c.repo), ...this.diffs.repos()].find((r) => stateDir(r));
  }

  // ---- state ----

  panelState(): PanelState {
    const d = this.draft;
    return {
      draft: d && {
        key: d.editId ?? 'new',
        location: location(d),
        code: d.code,
        editing: !!d.editId,
        body: d.body,
      },
      comments: this.comments.map((c) => ({ id: c.id, location: location(c), code: c.code, body: c.body })),
      general: this.general,
      status: this.status,
    };
  }

  private setDraft(draft: Draft | null): void {
    this.draft = draft;
    this.refresh();
  }

  private persist(): void {
    void this.context.workspaceState.update(COMMENTS_KEY, this.comments);
  }

  refresh(): void {
    this.changed.fire();
    this.decorate();
  }

  decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const key = editor.document.uri.toString();
      editor.setDecorations(
        this.commentDecoration,
        this.comments
          .filter((c) => c.uri === key)
          .map((c) => ({ range: toRange(c.range), hoverMessage: new vscode.MarkdownString(c.body) })),
      );
      editor.setDecorations(this.draftDecoration, this.draft?.uri === key ? [toRange(this.draft.range)] : []);
    }
  }
}
