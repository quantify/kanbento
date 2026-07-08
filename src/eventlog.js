import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

// The event log is a pluggable transport. The kernel depends only on this
// interface; the distribution tier (local / shared / cloud) is a choice of
// backend — see docs/distribution.md.
//
//   interface Log {
//     append(event): Promise<event>   // append-only; returns the event
//     read():        Promise<event[]> // full history, in order
//     describe():    string           // human-readable location
//   }

// Local single-file JSONL log. Concurrent appends from multiple processes on a
// local filesystem are safe: each event line is < 4KB and O_APPEND writes are
// atomic, so lines never interleave — the filesystem is the sequencer. (Two
// writers reading-then-appending can still race a global invariant; that is the
// shared multi-machine concern, deferred in docs/distribution.md.)
export class FileLog {
  constructor(path) {
    this.path = path;
  }

  async append(event) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  async read() {
    if (!existsSync(this.path)) return [];
    const raw = await readFile(this.path, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }

  describe() {
    return this.path;
  }
}
