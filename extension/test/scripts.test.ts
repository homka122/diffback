import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git, makeRepo, write } from './helpers';

const SCRIPTS = path.resolve(import.meta.dir, '../../plugin/scripts');
const stateDir = (repo: string) => path.join(repo, '.git', 'diffback');

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * A stand-in for the `code` CLI: reports the extension as installed and, when asked to open
 * the repo, answers the request the way the extension does.
 */
function fakeEditor(status: 'shown' | 'empty' | 'error' | 'silent'): string {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diffback-editor-')), 'code');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
if [ "$1" = --list-extensions ]; then echo homka122.diffback; exit 0; fi
[ ${status} = silent ] && exit 0
dir="$1/.git/diffback"
id=$(grep -o '"id": "[^"]*"' "$dir/request.json" | cut -d'"' -f4)
printf '{\\n  "id": "%s",\\n  "status": "${status}",\\n  "files": 2,\\n  "message": "boom"\\n}\\n' "$id" > "$dir/request-ack.json"
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe('show-diff.sh', () => {
  test('bad usage exits 2', () => {
    expect(run('show-diff.sh', []).code).toBe(2);
    expect(run('show-diff.sh', [makeRepo(), 'everything']).code).toBe(2);
  });

  test('outside a git repository exits 1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffback-norepo-'));
    const r = run('show-diff.sh', [dir, 'staged']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not inside a git repository');
  });

  test('nothing staged exits 3', () => {
    expect(run('show-diff.sh', [makeRepo(), 'staged']).code).toBe(3);
  });

  test('an untracked file counts as an uncommitted change', () => {
    const repo = makeRepo();
    write(repo, { 'new.py': 'x\n' });
    const r = run('show-diff.sh', [repo, 'uncommitted'], { DIFFBACK_EDITOR: fakeEditor('shown') });
    expect(r.code).toBe(0);
  });

  test('an unknown revision exits 1 instead of pretending to work', () => {
    const r = run('show-diff.sh', [makeRepo(), 'main...nope']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown revision 'nope'");
  });

  test('a missing editor CLI exits 1 with a hint', () => {
    const repo = makeRepo();
    write(repo, { 'a.txt': 'two\n' });
    const r = run('show-diff.sh', [repo, 'uncommitted'], { DIFFBACK_EDITOR: 'no-such-editor' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('DIFFBACK_EDITOR');
  });

  test('reports what the extension did with the request', () => {
    const repo = makeRepo();
    write(repo, { 'a.txt': 'two\n' });
    const shown = run('show-diff.sh', [repo, 'uncommitted'], { DIFFBACK_EDITOR: fakeEditor('shown') });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('2 files');
    expect(run('show-diff.sh', [repo, 'uncommitted'], { DIFFBACK_EDITOR: fakeEditor('empty') }).code).toBe(3);
    const error = run('show-diff.sh', [repo, 'uncommitted'], { DIFFBACK_EDITOR: fakeEditor('error') });
    expect(error.code).toBe(1);
    expect(error.err).toContain('boom');
  });

  test('times out with a hint when no extension answers', () => {
    const repo = makeRepo();
    write(repo, { 'a.txt': 'two\n' });
    const r = run('show-diff.sh', [repo, 'uncommitted'], { DIFFBACK_EDITOR: fakeEditor('silent'), DIFFBACK_OPEN_TIMEOUT: '1' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('did not pick up the request');
  });

  test('writes a well-formed request for a branch scope', () => {
    const repo = makeRepo();
    git(repo, 'switch', '-q', '-c', 'feature');
    write(repo, { 'b.txt': 'b\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'b');
    run('show-diff.sh', [repo, 'main...HEAD'], { DIFFBACK_EDITOR: fakeEditor('shown') });
    const request = JSON.parse(fs.readFileSync(path.join(stateDir(repo), 'request.json'), 'utf8'));
    expect(request.scope).toEqual({ base: 'main', head: 'HEAD' });
    expect(request.version).toBe(1);
  });
});

describe('wait-review.sh', () => {
  const touch = (file: string, secondsAgo: number) => {
    const t = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, t, t);
  };

  test('delivers a published review once and archives it', () => {
    const repo = makeRepo();
    fs.mkdirSync(stateDir(repo), { recursive: true });
    fs.writeFileSync(path.join(stateDir(repo), 'review.json'), '{"general": ["looks good"]}');
    const r = run('wait-review.sh', [repo]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('looks good');
    expect(fs.existsSync(path.join(stateDir(repo), 'review.json'))).toBe(false);
    expect(fs.readdirSync(path.join(stateDir(repo), 'reviews'))).toHaveLength(1);
  });

  test('delivers a closed window once no window is alive, and leaves a consumed copy', () => {
    const repo = makeRepo();
    const dir = stateDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    const closing = path.join(dir, 'closing-123.json');
    fs.writeFileSync(closing, '{"closed": "now", "draftIds": ["a"]}');
    touch(closing, 30);
    const r = run('wait-review.sh', [repo]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('draftIds');
    expect(fs.readdirSync(path.join(dir, 'consumed'))).toHaveLength(1);
  });

  test('keeps waiting while another window on the repo is alive', async () => {
    const repo = makeRepo();
    const dir = stateDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    const closing = path.join(dir, 'closing-123.json');
    fs.writeFileSync(closing, '{"closed": "now"}');
    touch(closing, 30);
    fs.writeFileSync(path.join(dir, 'alive-456'), '');

    const watcher = spawn('bash', [path.join(SCRIPTS, 'wait-review.sh'), repo]);
    let out = '';
    watcher.stdout.on('data', (d) => (out += d));
    await new Promise((r) => setTimeout(r, 2500));
    expect(out).toBe('');
    expect(watcher.exitCode).toBeNull();

    // The other window publishes: delivered right away.
    fs.writeFileSync(path.join(dir, 'review.json'), '{"general": ["from the other window"]}');
    const code = await new Promise((r) => watcher.on('exit', r));
    expect(code).toBe(0);
    expect(out).toContain('from the other window');
  });

  test('a new watcher replaces the old one', async () => {
    const repo = makeRepo();
    const first = spawn('bash', [path.join(SCRIPTS, 'wait-review.sh'), repo]);
    await new Promise((r) => setTimeout(r, 800));
    const second = spawn('bash', [path.join(SCRIPTS, 'wait-review.sh'), repo]);
    const firstExit = await new Promise((r) => first.on('exit', (code, signal) => r(code ?? signal)));
    expect(firstExit).not.toBe(0);
    expect(second.exitCode).toBeNull();
    second.kill();
  });
});
