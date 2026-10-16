import * as fs from 'fs';
import * as path from 'path';
import { listState, readJson, STATE_FILES, stateDir, writeJsonAtomic } from './state';

const HEARTBEAT_MS = 2_000;
/** Heartbeats this old belong to a window that crashed; they are cleaned up on startup. */
const STALE_HEARTBEAT_MS = 60_000;

/** What the agent already received from closed windows: drafts with these ids are done. */
export interface Consumed {
  draftIds: Set<string>;
  general: boolean;
}

/**
 * Marks this window as open on its repositories. The agent-side watcher treats a
 * `closing-<pid>.json` as a real close only when no window of the repo is still beating,
 * which tells a closed window from a reload or from a second window on the same repo.
 */
export class WindowPresence {
  private timer: NodeJS.Timeout | undefined;
  private readonly alive = `${STATE_FILES.alivePrefix}${process.pid}`;
  private readonly closing = `${STATE_FILES.closingPrefix}${process.pid}.json`;

  constructor(private readonly repos: () => string[]) {}

  start(): void {
    this.beat();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  private beat(): void {
    const now = new Date();
    for (const dir of this.dirs()) {
      const file = path.join(dir, this.alive);
      try {
        fs.utimesSync(file, now, now);
      } catch {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, '');
        } catch {
          // A read-only or vanished git dir: nothing to signal.
        }
      }
    }
  }

  /** The window is closing or reloading: stop beating and leave what was not sent. */
  stop(closingFor: (repo: string) => unknown): void {
    clearInterval(this.timer);
    for (const repo of this.repos()) {
      const dir = stateDir(repo);
      if (!dir) continue;
      fs.rmSync(path.join(dir, this.alive), { force: true });
      writeJsonAtomic(path.join(dir, this.closing), closingFor(repo));
    }
  }

  /**
   * On startup: closing files are void now that a window is open again, and drafts that the
   * agent got when an earlier window closed must not be sent twice.
   */
  takeConsumed(): Consumed {
    const consumed: Consumed = { draftIds: new Set(), general: false };
    for (const dir of this.dirs()) {
      for (const file of listState(dir, STATE_FILES.closingPrefix)) fs.rmSync(file, { force: true });
      for (const file of listState(dir, STATE_FILES.alivePrefix)) {
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > STALE_HEARTBEAT_MS) fs.rmSync(file, { force: true });
        } catch {
          // Another window removed it first.
        }
      }
      const consumedDir = path.join(dir, STATE_FILES.consumedDir);
      for (const file of listState(consumedDir, '')) {
        const review = readJson<{ draftIds?: string[]; general?: string[] }>(file);
        for (const id of review?.draftIds ?? []) consumed.draftIds.add(id);
        if (review?.general?.length) consumed.general = true;
        fs.rmSync(file, { force: true });
      }
    }
    return consumed;
  }

  private dirs(): string[] {
    return this.repos()
      .map(stateDir)
      .filter((d): d is string => !!d);
  }
}
