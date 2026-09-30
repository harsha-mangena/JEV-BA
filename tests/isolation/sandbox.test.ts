import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxCgroup, runSandboxed, sandboxAvailable, validateGeneratedSpec } from '@qa/compiler';

/**
 * Isolation lane (audit F03). Hostile programs run directly in the sandbox —
 * bypassing the lint on purpose — and every escape route is checked from the
 * host side. This lane is mandatory: an unavailable sandbox fails it.
 */

const ROOT = join(import.meta.dirname, '../..');
const BASE = join(ROOT, '.qa-work', 'isolation');
let app: Server;
let other: Server;
let appPort = 0;
let otherPort = 0;
let otherHits = 0;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  await mkdir(BASE, { recursive: true });
  app = createServer((_q, s) => s.end('app-ok'));
  other = createServer((_q, s) => {
    otherHits++;
    s.end('other-service');
  });
  appPort = await listen(app);
  otherPort = await listen(other);
});
afterAll(async () => {
  app?.close();
  other?.close();
});

async function hostile(name: string, script: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) {
  const workDir = join(BASE, name);
  await rm(workDir, { recursive: true, force: true });
  const r = await runSandboxed({ command: [process.execPath, '-e', script], workDir, allowTcp: { host: '127.0.0.1', port: appPort }, timeoutMs: 30_000, ...extra });
  return { ...r, workDir };
}

describe('namespace sandbox', () => {
  it('is available on this runner (the lane fails instead of skipping when it is not)', async () => {
    const s = await sandboxAvailable();
    expect(s.ok, s.detail).toBe(true);
  });

  it('confines the filesystem: only the work directory is writable and host files are invisible', async () => {
    const outside = join(BASE, 'outside-marker.txt');
    const canary = join(BASE, 'host-secret.txt');
    await rm(outside, { force: true });
    await writeFile(canary, 'HOST-CANARY-7f3a');
    const r = await hostile(
      'fs',
      `const fs = require('fs'); const out = {};
       const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = e.code; } };
       t('write_outside', () => (fs.writeFileSync(${JSON.stringify(outside)}, 'x'), 'WROTE'));
       t('read_canary', () => fs.readFileSync(${JSON.stringify(canary)}, 'utf8'));
       t('read_repo', () => fs.readdirSync(${JSON.stringify(ROOT)}).length);
       t('read_root_home', () => fs.readdirSync('/root').length);
       t('write_usr', () => (fs.writeFileSync('/usr/qa-x', 'x'), 'WROTE'));
       t('write_etc', () => (fs.writeFileSync('/etc/qa-x', 'x'), 'WROTE'));
       t('write_work', () => (fs.writeFileSync('/sandbox/work/inside.txt', 'ok'), 'ok'));
       t('shadow', () => fs.readFileSync('/etc/shadow', 'utf8').length);
       console.log(JSON.stringify(out));`,
    );
    expect(r.status, r.stderr).toBe('exited');
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ write_outside: 'ENOENT', read_canary: 'ENOENT', read_repo: 'ENOENT', read_root_home: 'ENOENT', write_usr: 'EROFS', write_etc: 'EROFS', write_work: 'ok' });
    expect(out.shadow).not.toEqual(expect.any(Number));
    await expect(readFile(outside)).rejects.toThrow();
    expect(await readFile(join(r.workDir, 'inside.txt'), 'utf8')).toBe('ok');
  });

  it('confines the network: the application is reachable, other host services and external addresses are not', async () => {
    otherHits = 0;
    const r = await hostile(
      'net',
      `const net = require('net');
       const conn = (h, p) => new Promise((res) => { const s = net.connect({ host: h, port: p }); s.setTimeout(2000); s.on('connect', () => { s.destroy(); res('CONNECTED'); }); s.on('error', (e) => res(e.code)); s.on('timeout', () => { s.destroy(); res('TIMEOUT'); }); });
       (async () => {
         const app = await fetch('http://127.0.0.1:${appPort}/').then((r) => r.text(), (e) => String(e.cause?.code ?? e));
         console.log(JSON.stringify({ app, other: await conn('127.0.0.1', ${otherPort}), postgres: await conn('127.0.0.1', 5432), external: await conn('1.1.1.1', 443), dns: await require('dns').promises.lookup('example.com').then(() => 'RESOLVED', (e) => e.code) }));
       })();`,
    );
    expect(r.status, r.stderr).toBe('exited');
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out.app).toBe('app-ok');
    expect(out.other).not.toBe('CONNECTED');
    expect(out.postgres).not.toBe('CONNECTED');
    expect(out.external).not.toBe('CONNECTED');
    expect(out.dns).not.toBe('RESOLVED');
    expect(otherHits).toBe(0);
  });

  it('inherits no host environment and runs with no capabilities, no_new_privs and a private PID space', async () => {
    process.env.QA_HOST_CANARY = 'env-canary-91b2';
    try {
      const r = await hostile(
        'priv',
        `const fs = require('fs');
         const st = Object.fromEntries(fs.readFileSync('/proc/self/status', 'utf8').split('\\n').filter((l) => /^(CapEff|CapPrm|CapBnd|NoNewPrivs):/.test(l)).map((l) => l.split(/:\\s+/)));
         const pids = fs.readdirSync('/proc').filter((d) => /^\\d+$/.test(d)).length;
         console.log(JSON.stringify({ env: Object.keys(process.env).sort(), st, pids }));`,
        { env: { ALLOWED: '1' } },
      );
      expect(r.status, r.stderr).toBe('exited');
      const out = JSON.parse(r.stdout) as { env: string[]; st: Record<string, string>; pids: number };
      expect(out.env).not.toContain('QA_HOST_CANARY');
      expect(out.env).toContain('ALLOWED');
      expect(out.env.filter((k) => k.startsWith('SBX_'))).toEqual([]);
      expect(out.st).toMatchObject({ CapEff: '0000000000000000', CapPrm: '0000000000000000', CapBnd: '0000000000000000', NoNewPrivs: '1' });
      expect(out.pids).toBeLessThan(10);
    } finally {
      delete process.env.QA_HOST_CANARY;
    }
  });

  it('kills the whole process tree on timeout, including detached descendants', async () => {
    const marker = `qa-sbx-orphan-${Date.now()}`;
    const r = await hostile('timeout', `require('child_process').spawn('/bin/sh', ['-c', 'exec -a ${marker} sleep 600'], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`, { timeoutMs: 2_000 });
    expect(r.status).toBe('timeout');
    await new Promise((res) => setTimeout(res, 300));
    expect(spawnSync('pgrep', ['-f', marker]).status).toBe(1);
  });

  it('bounds process creation', async () => {
    const r = await hostile(
      'nproc',
      `const cp = require('child_process'); let ok = 0, failed = 0;
       for (let i = 0; i < 200; i++) { try { cp.spawn('/bin/sleep', ['30'], { stdio: 'ignore' }).on('error', () => failed++); ok++; } catch { failed++; } }
       setTimeout(() => { console.log(JSON.stringify({ ok, failed })); process.exit(0); }, 1500);`,
      { limits: { nproc: 64 } },
    );
    // The sandbox itself must start even when its uid already runs many processes elsewhere.
    expect(r.status, r.stderr).toBe('exited');
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: number; failed: number };
    expect(out.failed).toBeGreaterThan(0);
  });
});

describe('generated-spec validation runs only inside the sandbox', () => {
  it('a lint-clean spec cannot reach any service but the application under test', async () => {
    otherHits = 0;
    const source = `import { expect, test } from '@playwright/test';
test('probe another loopback service', async () => {
  const r = await fetch('http://127.0.0.1:${otherPort}/').then(() => 'reached', () => 'blocked');
  expect(r).toBe('reached');
});
`;
    const v = await validateGeneratedSpec(source, { workDir: join(BASE, 'spec-net'), baseUrl: `http://127.0.0.1:${appPort}`, fixtureToken: 'isolation-token-0000', timeoutMs: 60_000 });
    expect(v.lint).toEqual([]);
    expect(v.status).toBe('failed');
    expect(otherHits).toBe(0);
  });

  it('lint rejects the audit F03 spec and equivalent spellings before anything runs', async () => {
    const outside = join(BASE, 'f03-marker.txt');
    for (const src of [
      `import { writeFileSync } from 'fs';\nimport { test } from '@playwright/test';\ntest('x', () => { writeFileSync(${JSON.stringify(outside)}, 'x'); });`,
      `import { test } from '@playwright/test';\ntest('x', () => { require('fs').writeFileSync(${JSON.stringify(outside)}, 'x'); });`,
      `import { test } from '@playwright/test';\ntest('x', async () => { (await import('node:fs')).writeFileSync(${JSON.stringify(outside)}, 'x'); });`,
      `import { test } from '@playwright/test';\ntest('x', () => { (globalThis as any)['proc' + 'ess'].exit(0); });`,
    ]) {
      const v = await validateGeneratedSpec(src, { workDir: join(BASE, 'spec-lint'), baseUrl: `http://127.0.0.1:${appPort}`, fixtureToken: 'isolation-token-0000', timeoutMs: 30_000 });
      expect(v.status, src).toBe('rejected');
    }
    await expect(readFile(outside)).rejects.toThrow();
  });
});

describe('enforced memory limit', () => {
  it('kills a program that exceeds its memory limit (whole tree, via its own cgroup) and reports it', async () => {
    const r = await hostile('mem', `const a = []; for (;;) a.push(Buffer.alloc(1 << 20, 1));`, { limits: { memoryBytes: 96 * 1024 * 1024 } });
    expect(r.status, r.stderr).toBe('exited');
    expect(r.exceeded).toBe('memory');
    expect(r.code === 137 || r.signal === 'SIGKILL' || r.code !== 0).toBe(true);
  });

  it('bounds child processes too: memory used by descendants counts against the same limit', async () => {
    const r = await hostile(
      'mem-tree',
      `const cp = require('child_process');
       const kids = Array.from({ length: 4 }, () => cp.spawn(process.execPath, ['-e', 'const a=[];for(;;)a.push(Buffer.alloc(1<<20,1))'], { stdio: 'ignore' }));
       setTimeout(() => { console.log(JSON.stringify({ alive: kids.filter((k) => k.exitCode === null && k.signalCode === null).length })); process.exit(0); }, 4000);`,
      { limits: { memoryBytes: 128 * 1024 * 1024 } },
    );
    expect(r.exceeded).toBe('memory');
  });

  it('a program within its limit runs normally', async () => {
    const r = await hostile('mem-ok', `const b = Buffer.alloc(16 << 20, 1); console.log(b.length)`, { limits: { memoryBytes: 256 * 1024 * 1024 } });
    expect(r.status, r.stderr).toBe('exited');
    expect(r.code, r.stderr).toBe(0);
    expect(r.exceeded).toBeUndefined();
    expect(r.stdout.trim()).toBe(String(16 << 20));
  });

  it('refuses to run at all when the limit cannot be enforced (no fallback)', async () => {
    const r = await hostile('mem-none', `console.log('ran')`, { limits: { memoryBytes: 64 * 1024 * 1024 }, hostEnv: { QA_SANDBOX_CGROUP: '/nonexistent/cgroup' } });
    expect(r.status).toBe('unavailable');
    expect(r.stdout).not.toContain('ran');
    expect(r.stderr).toMatch(/memory limit cannot be enforced/);
  });

  describe('only a real, delegated kernel cgroup is accepted (review-4 P4c)', () => {
    const LIMITS = { memoryBytes: 64 * 1024 * 1024, pids: 64 };
    const ran = async (workDir: string) => stat(join(workDir, 'ran')).then(() => true, () => false);

    it('rejects an ordinary writable directory before anything is dispatched', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-plain-cgroup-'));
      try {
        const cg = await createSandboxCgroup(LIMITS, { QA_SANDBOX_CGROUP: dir });
        expect('unavailable' in cg && cg.unavailable).toMatch(/not on a cgroup filesystem/);
        const r = await hostile('mem-plain', `require('fs').writeFileSync('/sandbox/work/ran', '1')`, { limits: { memoryBytes: LIMITS.memoryBytes }, hostEnv: { QA_SANDBOX_CGROUP: dir } });
        expect(r.status).toBe('unavailable');
        expect(await ran(r.workDir), 'the program must not have run').toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a hand-made controller layout (files named like a cgroup on an ordinary filesystem)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'qa-fake-layout-'));
      try {
        for (const [f, v] of [['cgroup.controllers', 'memory pids'], ['cgroup.subtree_control', 'memory pids'], ['cgroup.procs', ''], ['memory.max', 'max'], ['memory.limit_in_bytes', '9223372036854771712']]) await writeFile(join(dir, f!), v!);
        const cg = await createSandboxCgroup(LIMITS, { QA_SANDBOX_CGROUP: dir });
        expect('unavailable' in cg && cg.unavailable).toMatch(/not on a cgroup filesystem/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a real cgroup without the memory controller delegated to it', async () => {
      const real = await createSandboxCgroup(LIMITS);
      if ('unavailable' in real) throw new Error(real.unavailable);
      try {
        // v2: a fresh cgroup has no controllers enabled for its children; v1: a hierarchy other than memory.
        const parent = real.version === 2 ? real.path : '/sys/fs/cgroup/pids';
        const cg = await createSandboxCgroup(LIMITS, { QA_SANDBOX_CGROUP: parent });
        expect('unavailable' in cg && cg.unavailable).toMatch(real.version === 2 ? /memory controller is not delegated/ : /not in the cgroup v1 memory hierarchy/);
      } finally {
        await real.destroy();
      }
    });

    it('verifies kernel membership, and the configured limit reads back as requested', async () => {
      const cg = await createSandboxCgroup(LIMITS);
      if ('unavailable' in cg) throw new Error(cg.unavailable);
      const p = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        await new Promise((r) => p.once('spawn', r));
        expect(await cg.isMember(p.pid!), 'not a member before joining').toBe(false);
        await cg.join(p.pid!);
        expect(await cg.isMember(p.pid!)).toBe(true);
        const limit = await readFile(join(cg.path, cg.version === 2 ? 'memory.max' : 'memory.limit_in_bytes'), 'utf8');
        expect(Number(limit)).toBe(LIMITS.memoryBytes);
        // A process that is gone cannot be joined; the join fails instead of reporting success.
        const gone = spawnSync('true').pid;
        await expect(cg.join(gone)).rejects.toThrow();
      } finally {
        p.kill('SIGKILL');
        await cg.destroy();
      }
    });
  });
});
