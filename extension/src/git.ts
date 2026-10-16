import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Hash of git's empty tree: the "before" side of a repository without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type Scope =
  | { kind: 'staged' }
  /** Working tree against HEAD, including untracked files. */
  | { kind: 'uncommitted' }
  | { kind: 'range'; base: string; head: string };

/**
 * One side of a changed file.
 * `ref` undefined means the file on disk, '' the index, anything else a commit.
 */
export interface Side {
  path: string;
  ref?: string;
}

export interface Change {
  old?: Side;
  new?: Side;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function resolveCommit(repo: string, rev: string): Promise<string | undefined> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim();
  } catch {
    return undefined;
  }
}

function splitZ(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/** Parses `git diff --name-status -z`: renames and copies carry two paths. */
function parseNameStatus(output: string): { status: string; oldPath: string; newPath: string }[] {
  const tokens = splitZ(output);
  const entries: { status: string; oldPath: string; newPath: string }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ status: status[0], oldPath: tokens[i + 1], newPath: tokens[i + 2] });
      i += 3;
    } else {
      entries.push({ status, oldPath: tokens[i + 1], newPath: tokens[i + 1] });
      i += 2;
    }
  }
  return entries;
}

/**
 * Lists changed files for a scope. Where the file on disk is identical to the
 * version being shown, the "new" side points at the real file, so it stays editable.
 */
export async function collectChanges(repo: string, scope: Scope): Promise<Change[]> {
  const head = (await resolveCommit(repo, 'HEAD')) ?? EMPTY_TREE;
  let oldRev: string;
  let newRef: string | undefined;
  let diffArgs: string[];
  let differsOnDisk: string[] | undefined; // `git diff` args listing files whose disk copy differs

  switch (scope.kind) {
    case 'staged':
      oldRev = head;
      newRef = '';
      diffArgs = ['--cached'];
      differsOnDisk = [];
      break;
    case 'uncommitted':
      oldRev = head;
      newRef = undefined;
      diffArgs = [head];
      break;
    case 'range': {
      const headRev = await resolveCommit(repo, scope.head);
      if (!headRev) throw new Error(`Unknown revision: ${scope.head}`);
      oldRev = (await git(repo, ['merge-base', scope.base, headRev])).trim();
      newRef = headRev;
      diffArgs = [oldRev, headRev];
      differsOnDisk = [headRev];
      break;
    }
  }

  const entries = parseNameStatus(await git(repo, ['diff', '--name-status', '-M', '-z', ...diffArgs]));
  if (scope.kind === 'uncommitted') {
    // New files the agent created are part of "what changed", even before anyone stages them.
    const untracked = splitZ(await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']));
    entries.push(...untracked.map((p) => ({ status: 'A', oldPath: p, newPath: p })));
  }
  const dirty = differsOnDisk && new Set(splitZ(await git(repo, ['diff', '--name-only', '-z', ...differsOnDisk])));
  const abs = (p: string) => path.join(repo, p);

  return entries.map(({ status, oldPath, newPath }) => {
    const change: Change = {};
    if (status !== 'A') change.old = { path: abs(oldPath), ref: oldRev };
    if (status !== 'D') {
      const onDisk = newRef === undefined || (!dirty?.has(newPath) && fs.existsSync(abs(newPath)));
      change.new = onDisk ? { path: abs(newPath) } : { path: abs(newPath), ref: newRef };
    }
    return change;
  });
}
