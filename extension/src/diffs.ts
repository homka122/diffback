import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Change, collectChanges, Scope, Side } from './git';
import { findRepo, readJson, STATE_FILES, stateDir, writeJsonAtomic } from './state';

/** A request older than this is stale (e.g. left over from before a restart) and is ignored. */
const REQUEST_TTL_MS = 120_000;
const DIFFS_KEY = 'diffback.diffs';

interface DiffRequest {
  version: 1;
  id: string;
  created: number;
  scope: 'staged' | 'uncommitted' | { base: string; head: string };
}

/** Tells show-diff.sh what happened to its request. */
interface DiffAck {
  id: string;
  status: 'shown' | 'empty' | 'error';
  files?: number;
  message?: string;
}

/** What was shown, kept so review comments can jump back into the same diff. */
interface ShownDiff {
  source: string;
  title: string;
  entries: { original?: string; modified?: string }[];
}

export type DiffSide = 'old' | 'new';

function toUri(side: Side | undefined): vscode.Uri | undefined {
  if (!side) return undefined;
  const uri = vscode.Uri.file(side.path);
  // The built-in git extension serves `git:` URIs with {path, ref}; ref '' is the index.
  return side.ref === undefined ? uri : uri.with({ scheme: 'git', query: JSON.stringify(side) });
}

/** The {path, ref} behind a `git:` URI. */
function gitSide(uri: vscode.Uri): Side | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    return JSON.parse(uri.query) as Side;
  } catch {
    return undefined;
  }
}

/** Path on disk behind a document or diff URI. */
export function filePath(uri: string | vscode.Uri): string | undefined {
  const parsed = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
  return parsed.scheme === 'file' ? parsed.fsPath : gitSide(parsed)?.path;
}

function toScope(scope: DiffRequest['scope']): Scope {
  if (scope === 'staged' || scope === 'uncommitted') return { kind: scope };
  return { kind: 'range', ...scope };
}

function scopeLabel(scope: DiffRequest['scope']): string {
  return typeof scope === 'string' ? scope : `${scope.base}...${scope.head}`;
}

export class DiffController implements vscode.Disposable {
  private readonly seen = new Set<string>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly shown = new vscode.EventEmitter<void>();
  /** Fires after a requested diff is on screen. */
  readonly onDidShowDiff = this.shown.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Repositories of the open workspace folders (a folder may sit inside a repo). */
  repos(): string[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => findRepo(f.uri.fsPath));
    return [...new Set(roots.filter((r): r is string => !!r))];
  }

  /** Watches each repo's request file. Safe to call again when workspace folders change. */
  start(): void {
    for (const repo of this.repos()) {
      if (this.watchers.has(repo)) continue;
      try {
        this.watch(repo);
      } catch (err) {
        void vscode.window.showWarningMessage(`diffback: cannot watch ${repo}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private watch(repo: string): void {
    const dir = stateDir(repo);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, STATE_FILES.request);
    // The window may have been opened just to show this request.
    void this.handleRequest(repo, dir, file);
    const watcher = fs.watch(dir, (_event, name) => {
      if (name === STATE_FILES.request) void this.handleRequest(repo, dir, file);
    });
    watcher.on('error', () => this.watchers.delete(repo));
    this.watchers.set(repo, watcher);
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.shown.dispose();
  }

  private async handleRequest(repo: string, dir: string, file: string): Promise<void> {
    const request = readJson<DiffRequest>(file);
    if (!request || this.seen.has(request.id) || Date.now() - request.created > REQUEST_TTL_MS) return;
    this.seen.add(request.id);
    const ack = (a: Omit<DiffAck, 'id'>) => writeJsonAtomic(path.join(dir, STATE_FILES.requestAck), { id: request.id, ...a });

    let changes: Change[];
    try {
      changes = await collectChanges(repo, toScope(request.scope));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ack({ status: 'error', message });
      void vscode.window.showErrorMessage(`diffback: ${message}`);
      return;
    }
    if (changes.length === 0) {
      ack({ status: 'empty' });
      void vscode.window.showInformationMessage(`diffback: no ${scopeLabel(request.scope)} changes to show.`);
      return;
    }

    const diff: ShownDiff = {
      source: vscode.Uri.from({ scheme: 'diffback', path: `/${request.id}` }).toString(),
      title: `${path.basename(repo)}: ${scopeLabel(request.scope)}`,
      entries: changes.map((c) => ({ original: toUri(c.old)?.toString(), modified: toUri(c.new)?.toString() })),
    };
    const diffs = this.context.workspaceState.get<Record<string, ShownDiff>>(DIFFS_KEY, {});
    await this.context.workspaceState.update(DIFFS_KEY, { ...diffs, [repo]: diff });
    try {
      await this.open(diff);
      ack({ status: 'shown', files: changes.length });
      this.shown.fire();
    } catch (err) {
      ack({ status: 'error', message: `cannot open the multi-file diff: ${err instanceof Error ? err.message : err}` });
    }
  }

  /**
   * Opens (or re-focuses) the multi-file diff. A stable source URI makes VS Code reuse
   * the open editor, so a `reveal` just scrolls it instead of opening a new tab.
   */
  private async open(diff: ShownDiff, reveal?: { modified: string; range: vscode.Range }): Promise<void> {
    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
      multiDiffSourceUri: vscode.Uri.parse(diff.source),
      title: diff.title,
      resources: diff.entries.map((e) => ({
        originalUri: e.original && vscode.Uri.parse(e.original),
        modifiedUri: e.modified && vscode.Uri.parse(e.modified),
      })),
      reveal: reveal && {
        modifiedUri: vscode.Uri.parse(reveal.modified),
        range: {
          startLineNumber: reveal.range.start.line + 1,
          startColumn: reveal.range.start.character + 1,
          endLineNumber: reveal.range.end.line + 1,
          endColumn: reveal.range.end.character + 1,
        },
      },
    });
  }

  private lastDiff(repo: string): ShownDiff | undefined {
    return this.context.workspaceState.get<Record<string, ShownDiff>>(DIFFS_KEY, {})[repo];
  }

  /**
   * Which side of a change a document shows. Files on disk and the index are the new side;
   * a committed version is the old side unless it is the new side of the last diff (branch reviews).
   */
  sideOf(repo: string, uri: vscode.Uri): DiffSide {
    const side = gitSide(uri);
    if (!side || side.ref === '') return 'new';
    const key = uri.toString();
    return this.lastDiff(repo)?.entries.some((e) => e.modified === key) ? 'new' : 'old';
  }

  /**
   * Scrolls the last diff to a commented range. Returns false when the file is not part
   * of it, so the caller can open the file on its own instead.
   */
  async reveal(repo: string, uri: vscode.Uri, range: vscode.Range): Promise<boolean> {
    const diff = this.lastDiff(repo);
    const key = uri.toString();
    const entry =
      diff?.entries.find((e) => e.original === key || e.modified === key) ??
      // A comment made in the plain file still belongs to that file's diff.
      (uri.scheme === 'file' ? diff?.entries.find((e) => e.modified && filePath(e.modified) === uri.fsPath) : undefined);
    if (!diff || !entry?.modified) return false;
    // VS Code can only scroll by the modified side; for old-side comments the line is approximate.
    await this.open(diff, { modified: entry.modified, range });
    return true;
  }
}
