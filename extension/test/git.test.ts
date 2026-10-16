import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectChanges } from '../src/git';
import { git, makeRepo, write } from './helpers';

const rel = (repo: string, p?: string) => (p ? path.relative(repo, p) : undefined);

function summary(repo: string, changes: Awaited<ReturnType<typeof collectChanges>>) {
  return changes
    .map((c) => ({
      old: rel(repo, c.old?.path),
      new: rel(repo, c.new?.path),
      oldRef: c.old?.ref,
      newRef: c.new?.ref,
    }))
    .sort((a, b) => String(a.new ?? a.old).localeCompare(String(b.new ?? b.old)));
}

describe('staged', () => {
  test('modified, added, deleted and renamed files', async () => {
    const repo = makeRepo({ 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'old-name.txt': 'same content here\n'.repeat(5) });
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    write(repo, { 'keep.txt': 'k2\n', 'new.txt': 'n\n' });
    git(repo, 'rm', '-q', 'gone.txt');
    git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    git(repo, 'add', '-A');

    expect(summary(repo, await collectChanges(repo, { kind: 'staged' }))).toEqual([
      { old: 'gone.txt', new: undefined, oldRef: head, newRef: undefined },
      { old: 'keep.txt', new: 'keep.txt', oldRef: head, newRef: undefined },
      { old: 'old-name.txt', new: 'new-name.txt', oldRef: head, newRef: undefined },
      { old: undefined, new: 'new.txt', oldRef: undefined, newRef: undefined },
    ]);
  });

  test('shows the index, not the disk, when the file changed after staging', async () => {
    const repo = makeRepo();
    write(repo, { 'a.txt': 'staged\n' });
    git(repo, 'add', 'a.txt');
    write(repo, { 'a.txt': 'edited after staging\n' });

    const [change] = await collectChanges(repo, { kind: 'staged' });
    expect(change.new?.ref).toBe(''); // '' is the index
  });

  test('works in a repository without commits', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diffback-empty-'));
    git(repo, 'init', '-q');
    write(repo, { 'first.txt': 'hello\n' });
    git(repo, 'add', '-A');

    expect(summary(repo, await collectChanges(repo, { kind: 'staged' }))).toEqual([
      { old: undefined, new: 'first.txt', oldRef: undefined, newRef: undefined },
    ]);
  });
});

describe('uncommitted', () => {
  test('includes untracked files and ignores gitignored ones', async () => {
    const repo = makeRepo({ '.gitignore': 'ignored.log\n', 'a.txt': 'one\n' });
    write(repo, { 'a.txt': 'two\n', 'brand-new.py': 'print(1)\n', 'ignored.log': 'x\n' });

    const files = summary(repo, await collectChanges(repo, { kind: 'uncommitted' })).map((c) => c.new);
    expect(files).toEqual(['a.txt', 'brand-new.py']);
  });

  test('the new side is always the file on disk', async () => {
    const repo = makeRepo();
    write(repo, { 'a.txt': 'two\n' });
    const [change] = await collectChanges(repo, { kind: 'uncommitted' });
    expect(change.new).toEqual({ path: path.join(repo, 'a.txt') });
  });
});

describe('range', () => {
  test('diffs from the merge base, so main moving on does not leak in', async () => {
    const repo = makeRepo({ 'shared.txt': 'base\n' });
    git(repo, 'switch', '-q', '-c', 'feature');
    write(repo, { 'feature.txt': 'f\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feature');
    git(repo, 'switch', '-q', 'main');
    write(repo, { 'main-only.txt': 'm\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main moves on');
    git(repo, 'switch', '-q', 'feature');

    const files = summary(repo, await collectChanges(repo, { kind: 'range', base: 'main', head: 'HEAD' })).map((c) => c.new);
    expect(files).toEqual(['feature.txt']);
  });

  test('points at the committed version when the disk copy differs', async () => {
    const repo = makeRepo();
    git(repo, 'switch', '-q', '-c', 'feature');
    write(repo, { 'a.txt': 'committed\n' });
    git(repo, 'commit', '-qam', 'change');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    write(repo, { 'a.txt': 'local edit\n' });

    const [change] = await collectChanges(repo, { kind: 'range', base: 'main', head: 'HEAD' });
    expect(change.new?.ref).toBe(head);
  });

  test('rejects an unknown revision', async () => {
    const repo = makeRepo();
    expect(collectChanges(repo, { kind: 'range', base: 'main', head: 'nope' })).rejects.toThrow('Unknown revision');
  });
});
