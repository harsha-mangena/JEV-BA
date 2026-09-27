import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ArtifactRef, EvidenceEvent } from '@qa/contracts';
import { Redactor } from './redact.ts';

type Kind = EvidenceEvent['kind'];

/**
 * Append-only, ordered evidence for one attempt. Events are redacted before
 * they are written and are never rewritten; a later success does not
 * overwrite an earlier failure because each attempt has its own log.
 */
export class EvidenceLog {
  readonly events: EvidenceEvent[] = [];
  readonly artifacts: ArtifactRef[] = [];
  readonly redactor = new Redactor();
  private seq = 0;
  private readonly eventsPath: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    readonly attemptId: string,
    /** Root that artifact paths are reported relative to. */
    readonly root: string = dir,
  ) {
    this.eventsPath = join(dir, 'events.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.eventsPath, '');
  }

  record(kind: Kind, summary: string, data: Record<string, unknown> = {}): EvidenceEvent {
    const event: EvidenceEvent = {
      seq: this.seq++,
      at: new Date().toISOString(),
      attempt_id: this.attemptId,
      kind,
      summary: this.redactor.string(summary),
      data: this.redactor.value(data),
    };
    this.events.push(event);
    const line = `${JSON.stringify(event)}\n`;
    this.writes = this.writes.then(() => appendFile(this.eventsPath, line));
    return event;
  }

  async writeArtifact(kind: ArtifactRef['kind'], name: string, bytes: Buffer | string): Promise<ArtifactRef> {
    const path = join(this.dir, name);
    await mkdir(dirname(path), { recursive: true });
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    await writeFile(path, buf);
    return this.registerArtifact(kind, path, buf);
  }

  registerArtifact(kind: ArtifactRef['kind'], absPath: string, bytes: Buffer): ArtifactRef {
    const ref: ArtifactRef = {
      kind,
      path: relative(this.root, absPath),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
    this.artifacts.push(ref);
    this.record('artifact', `${kind} ${ref.path}`, { ...ref });
    return ref;
  }

  /** Checksum a finished file without appending an event (used for the event log itself). */
  async checksumFile(kind: ArtifactRef['kind'], absPath: string): Promise<ArtifactRef> {
    const bytes = await readFile(absPath);
    return { kind, path: relative(this.root, absPath), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }

  get eventsFile(): string {
    return this.eventsPath;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
