import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sandbox resource contract (completion C2). Every bound the cgroup
 * advertises is written, read back and recorded, or execution is refused
 * before the program starts. Faults are injected into the host's control-file
 * I/O (reads, writes, existence checks), which is kept apart from the tests
 * that let the kernel enforce the limits (tests/isolation/sandbox.test.ts).
 */
const faults = vi.hoisted(() => ({
  denyWrite: null as RegExp | null,
  read: [] as Array<{ match: RegExp; value: string }>,
  missing: null as RegExp | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const deny = (p: unknown) => {
    if (faults.denyWrite && typeof p === 'string' && faults.denyWrite.test(p)) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
  };
  const mod = {
    ...fs,
    open: (async (p: Parameters<typeof fs.open>[0], flags?: Parameters<typeof fs.open>[1], ...rest: unknown[]) => {
      if (flags && String(flags) !== 'r') deny(p);
      return (fs.open as (...a: unknown[]) => unknown)(p, flags, ...rest);
    }) as typeof fs.open,
    writeFile: (async (p: Parameters<typeof fs.writeFile>[0], ...rest: unknown[]) => {
      deny(p);
      return (fs.writeFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.writeFile,
    readFile: (async (p: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      const f = typeof p === 'string' ? faults.read.find((r) => r.match.test(p)) : undefined;
      if (f) return rest[0] ? f.value : Buffer.from(f.value);
      return (fs.readFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFile,
    access: (async (p: Parameters<typeof fs.access>[0], ...rest: unknown[]) => {
      if (faults.missing && typeof p === 'string' && faults.missing.test(p)) throw Object.assign(new Error(`ENOENT: no such file, access '${p}'`), { code: 'ENOENT' });
      return (fs.access as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.access,
  };
  return { ...mod, default: mod };
});

const { createSandboxCgroup, runSandboxed, validateGeneratedSpec } = await import('@qa/compiler');

const ROOT = join(import.meta.dirname, '../..');
const WORK = join(ROOT, '.qa-work', 'resource-contract');
const LIMIT = 128 * 1024 * 1024;
beforeEach(() => {
  faults.denyWrite = null;
  faults.read = [];
  faults.missing = null;
});

/** This host's cgroup version and the control file that bounds swap there. */
async function host() {
  const cg = await createSandboxCgroup({ memoryBytes: LIMIT, pids: 64 });
  if ('unavailable' in cg) throw new Error(`the isolation lane needs a delegated cgroup: ${cg.unavailable}`);
  const r = { version: cg.version, parent: dirname(cg.path), guarantee: cg.guarantee };
  await cg.destroy();
  return { ...r, swapFile: r.version === 1 ? 'memory.memsw.limit_in_bytes' : 'memory.swap.max', memFile: r.version === 1 ? 'memory.limit_in_bytes' : 'memory.max' };
}

async function dispatch(name: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) {
  const workDir = join(WORK, name);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const r = await runSandboxed({ command: [process.execPath, '-e', `require('fs').writeFileSync('/sandbox/work/ran', '1')`], workDir, timeoutMs: 30_000, limits: { memoryBytes: LIMIT }, ...extra });
  return { ...r, ran: await stat(join(workDir, 'ran')).then(() => true, () => false) };
}

const leftovers = async (parent: string) => (await readdir(parent)).filter((n) => n.startsWith('qa-sbx-'));
const esc = (s: string) => s.replace(/\./g, '\\.');

describe('sandbox resource contract (completion C2)', () => {
  it('real host: the contract is established, recorded and reported with the run', async () => {
    const h = await host();
    expect(h.guarantee.memoryBytes).toBe(LIMIT);
    expect(['zero', 'combined_with_memory', 'no_host_swap']).toContain(h.guarantee.swap.bound);
    if (h.version === 2) expect(h.guarantee.pids).toMatchObject({ cap: 64 });
    const r = await dispatch('real');
    expect(r.status, r.stderr).toBe('exited');
    expect(r.ran).toBe(true);
    expect(r.guarantee?.memoryBytes).toBe(LIMIT);
    console.log(`RESOURCE-CONTRACT host v${h.version} ${JSON.stringify(r.guarantee)}`);
  });

  for (const which of ['memory', 'swap'] as const) {
    it(`a denied ${which} bound write refuses execution with a typed reason`, async () => {
      const h = await host();
      faults.denyWrite = new RegExp(`${esc(which === 'memory' ? h.memFile : h.swapFile)}$`);
      const r = await dispatch(`deny-${which}`);
      expect(r.status).toBe('unavailable');
      expect(r.ran, 'the program must not start').toBe(false);
      expect(r.refused).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'control_write_failed', guarantee: which })]));
      expect(await leftovers(h.parent), 'no partially created group is left').toEqual([]);
    });

    it(`a ${which} bound that reads back weaker than requested refuses execution`, async () => {
      const h = await host();
      faults.read = [{ match: new RegExp(`${esc(which === 'memory' ? h.memFile : h.swapFile)}$`), value: which === 'swap' && h.version === 2 ? 'max\n' : `${LIMIT * 2}\n` }];
      const r = await dispatch(`mismatch-${which}`);
      expect(r.status).toBe('unavailable');
      expect(r.ran).toBe(false);
      expect(r.refused).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'limit_mismatch', guarantee: which })]));
      expect(await leftovers(h.parent)).toEqual([]);
    });
  }

  it('without swap accounting, a host with swap is refused (memory plus swap would be unbounded)', async () => {
    const h = await host();
    faults.missing = new RegExp(`${esc(h.swapFile)}$`);
    faults.read = [{ match: /^\/proc\/swaps$/, value: 'Filename\tType\tSize\tUsed\tPriority\n/swapfile file 1048572 0 -2\n' }];
    const r = await dispatch('no-accounting-swap');
    expect(r.status).toBe('unavailable');
    expect(r.ran).toBe(false);
    expect(r.refused).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'swap_unbounded', guarantee: 'swap' })]));
  });

  it('without swap accounting, a host with no swap runs, and the guarantee says how it was established', async () => {
    const h = await host();
    faults.missing = new RegExp(`${esc(h.swapFile)}$`);
    faults.read = [{ match: /^\/proc\/swaps$/, value: 'Filename\tType\tSize\tUsed\tPriority\n' }];
    const r = await dispatch('no-accounting-no-swap');
    expect(r.status, r.stderr).toBe('exited');
    expect(r.ran).toBe(true);
    expect(r.guarantee?.swap).toMatchObject({ bound: 'no_host_swap', established_by: expect.stringMatching(/proc\/swaps/) });
  });

  it('a pids cap that reads back differently refuses execution', async () => {
    const h = await host();
    if (h.guarantee.pids.cap === null) {
      // v1 without a writable pids hierarchy: the recorded bound is RLIMIT_NPROC, per user — never presented as a cgroup cap.
      expect(h.guarantee.pids.established_by).toMatch(/RLIMIT_NPROC.*per user/);
      return;
    }
    faults.read = [{ match: /pids\.max$/, value: '999999\n' }];
    const r = await dispatch('pids-mismatch');
    expect(r.status).toBe('unavailable');
    expect(r.ran).toBe(false);
    expect(r.refused).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'limit_mismatch', guarantee: 'pids' })]));
  });

  it('unverifiable membership refuses execution and removes the group', async () => {
    const h = await host();
    faults.read = [{ match: /^\/proc\/\d+\/cgroup$/, value: '0::/somewhere-else\n12:memory:/somewhere-else\n11:pids:/somewhere-else\n' }];
    const r = await dispatch('membership');
    expect(r.status).toBe('unavailable');
    expect(r.ran, 'the gate is never released').toBe(false);
    expect(r.refused).toEqual([expect.objectContaining({ reason: 'membership_unverified' })]);
    expect(await leftovers(h.parent)).toEqual([]);
  });

  it('a run killed at its timeout leaves no group behind', async () => {
    const h = await host();
    const r = await dispatch('timeout', { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 1_500 });
    expect(r.status).toBe('timeout');
    expect(await leftovers(h.parent)).toEqual([]);
  });

  it.each([
    ['a fractional byte count', { memoryBytes: 1.5 }],
    ['zero', { memoryBytes: 0 }],
    ['a negative limit', { memoryBytes: -1 }],
    ['NaN', { memoryBytes: Number.NaN }],
    ['a zero process cap', { memoryBytes: LIMIT, pids: 0 }],
  ])('invalid configuration (%s) is refused before the hierarchy is touched', async (_n, limits) => {
    const cg = await createSandboxCgroup(limits);
    expect(cg).toMatchObject({ failures: [expect.objectContaining({ reason: 'invalid_config' })] });
  });

  it('an unusable QA_SANDBOX_MEMORY_MB is an error, not a silent default', async () => {
    const prev = process.env.QA_SANDBOX_MEMORY_MB;
    process.env.QA_SANDBOX_MEMORY_MB = 'lots';
    try {
      const v = await validateGeneratedSpec(`import { test } from '@playwright/test';\ntest('t', async () => {});\n`, { workDir: join(WORK, 'env'), baseUrl: 'http://127.0.0.1:9', fixtureToken: 'x' });
      expect(v).toMatchObject({ status: 'error', detail: expect.stringMatching(/invalid QA_SANDBOX_MEMORY_MB/) });
    } finally {
      if (prev === undefined) delete process.env.QA_SANDBOX_MEMORY_MB;
      else process.env.QA_SANDBOX_MEMORY_MB = prev;
    }
  });
});
