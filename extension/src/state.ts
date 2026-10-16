import * as fs from 'fs';
import * as path from 'path';

/**
 * Files exchanged between the agent-side scripts and the extension.
 * They live in <git-dir>/diffback, so git never sees them. See docs/protocol.md.
 */
export const STATE_FILES = {
  request: 'request.json',
  requestAck: 'request-ack.json',
  review: 'review.json',
  /** Closing files the agent has delivered, left for the next window to drop those drafts. */
  consumedDir: 'consumed',
  /** Per window: `alive-<pid>` is touched while the window is open, `closing-<pid>.json` is left when it closes. */
  alivePrefix: 'alive-',
  closingPrefix: 'closing-',
} as const;

/** The git dir of a repository root, following the `.git` file of worktrees and submodules. */
function gitDirOf(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    return match ? path.resolve(root, match[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/** The root of the repository containing `file` (a file or a directory), or undefined. */
export function findRepo(file: string): string | undefined {
  for (let dir = file; ; ) {
    if (gitDirOf(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function stateDir(repo: string): string | undefined {
  const dir = gitDirOf(repo);
  return dir && path.join(dir, 'diffback');
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Write via rename so readers never see a half-written file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Files in a state dir whose names start with `prefix`. */
export function listState(dir: string, prefix: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}
