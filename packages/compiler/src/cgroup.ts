import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * Enforced memory and process limits for sandboxed programs, via a Linux
 * control group created for each run (cgroup v2, or the v1 memory/pids
 * hierarchies).
 *
 * Where the cgroup is created:
 *   - `QA_SANDBOX_CGROUP`: a delegated parent directory (v2 directory with the
 *     memory controller enabled in its `cgroup.subtree_control`, or a v1
 *     memory-hierarchy directory). CI creates one; see the workflow.
 *   - otherwise the caller's own cgroup in the v1 memory hierarchy, or the v2
 *     unified hierarchy when memory is delegated to it.
 * Moving the program into the cgroup needs write access to the common
 * ancestor's `cgroup.procs`; with `QA_SANDBOX_CGROUP_SUDO=1` that single write
 * goes through `sudo -n tee` (the program itself never gains privileges).
 * When no cgroup can be created, nothing runs (the caller fails closed).
 */
export interface CgroupLimits {
  memoryBytes: number;
  pids?: number;
}

export interface SandboxCgroup {
  version: 1 | 2;
  path: string;
  /** Move a process (before it runs untrusted code) into the cgroup. */
  join(pid: number): Promise<void>;
  /** Whether the memory limit was hit (an OOM kill inside the cgroup) and the peak usage seen. */
  stats(): Promise<{ oomKilled: boolean; peakBytes: number | null }>;
  /** Kill anything left inside and remove the cgroup. */
  destroy(): Promise<void>;
}

const exists = (p: string) => access(p).then(() => true, () => false);

async function writeAs(file: string, value: string, sudo: boolean): Promise<void> {
  try {
    await writeFile(file, value);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!sudo || (code !== 'EACCES' && code !== 'EPERM')) throw e;
    await new Promise<void>((resolve, reject) => {
      const p = spawn('sudo', ['-n', 'tee', file], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr!.on('data', (d: Buffer) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`sudo tee ${file} failed: ${err.trim()}`))));
      p.stdin!.end(value);
    });
  }
}

async function ownCgroups(): Promise<{ v2: string | null; memory: string | null; pids: string | null }> {
  const lines = (await readFile('/proc/self/cgroup', 'utf8').catch(() => '')).trim().split('\n');
  const find = (pred: (ctrls: string[]) => boolean) => {
    for (const l of lines) {
      const [, ctrls, path] = l.split(':', 3) as [string, string, string];
      if (pred(ctrls.split(','))) return path ?? '/';
    }
    return null;
  };
  return { v2: lines.find((l) => l.startsWith('0::'))?.slice(3) ?? null, memory: find((c) => c.includes('memory')), pids: find((c) => c.includes('pids')) };
}

async function v2Mount(): Promise<string | null> {
  for (const m of ['/sys/fs/cgroup', '/sys/fs/cgroup/unified']) if (await exists(join(m, 'cgroup.controllers'))) return m;
  return null;
}

/** Create a per-run cgroup with the given limits, or say why none can be created. */
export async function createSandboxCgroup(limits: CgroupLimits, env: NodeJS.ProcessEnv = process.env): Promise<SandboxCgroup | { unavailable: string }> {
  if (process.platform !== 'linux') return { unavailable: `cgroups require Linux (platform ${process.platform})` };
  const sudo = env.QA_SANDBOX_CGROUP_SUDO === '1';
  const name = `qa-sbx-${randomBytes(6).toString('hex')}`;
  const own = await ownCgroups();
  const candidates: Array<{ version: 1 | 2; parent: string; pidsParent?: string }> = [];
  if (env.QA_SANDBOX_CGROUP) candidates.push({ version: (await exists(join(env.QA_SANDBOX_CGROUP, 'cgroup.controllers'))) ? 2 : 1, parent: env.QA_SANDBOX_CGROUP });
  else {
    const v2 = await v2Mount();
    if (v2 && own.v2 !== null) candidates.push({ version: 2, parent: join(v2, own.v2) });
    if (own.memory !== null && (await exists('/sys/fs/cgroup/memory/memory.limit_in_bytes'))) {
      candidates.push({ version: 1, parent: join('/sys/fs/cgroup/memory', own.memory), ...(own.pids !== null && (await exists('/sys/fs/cgroup/pids')) ? { pidsParent: join('/sys/fs/cgroup/pids', own.pids) } : {}) });
    }
  }
  const tried: string[] = [];
  for (const c of candidates) {
    const dir = join(c.parent, name);
    try {
      if (c.version === 2) {
        const enabled = (await readFile(join(c.parent, 'cgroup.subtree_control'), 'utf8')).split(/\s+/);
        if (!enabled.includes('memory')) throw new Error(`memory controller is not delegated to ${c.parent}`);
        await mkdir(dir);
        await writeFile(join(dir, 'memory.max'), String(limits.memoryBytes));
        if (await exists(join(dir, 'memory.swap.max'))) await writeFile(join(dir, 'memory.swap.max'), '0');
        if (await exists(join(dir, 'memory.oom.group'))) await writeFile(join(dir, 'memory.oom.group'), '1');
        if (limits.pids && (await exists(join(dir, 'pids.max')))) await writeFile(join(dir, 'pids.max'), String(limits.pids));
        return v2Group(dir, sudo);
      }
      await mkdir(dir);
      await writeFile(join(dir, 'memory.limit_in_bytes'), String(limits.memoryBytes));
      if (await exists(join(dir, 'memory.memsw.limit_in_bytes'))) await writeFile(join(dir, 'memory.memsw.limit_in_bytes'), String(limits.memoryBytes)).catch(() => undefined);
      let pidsDir: string | null = null;
      if (limits.pids && c.pidsParent) {
        pidsDir = join(c.pidsParent, name);
        await mkdir(pidsDir).catch(() => (pidsDir = null));
        if (pidsDir) await writeFile(join(pidsDir, 'pids.max'), String(limits.pids)).catch(() => undefined);
      }
      return v1Group(dir, pidsDir, sudo);
    } catch (e) {
      tried.push(`${c.parent}: ${(e as Error).message}`);
      await rmdir(dir).catch(() => undefined);
    }
  }
  return { unavailable: `no cgroup could be created for the sandbox memory limit (${tried.join('; ') || 'no cgroup hierarchy found'}); delegate one with QA_SANDBOX_CGROUP` };
}

async function killAll(procsFile: string): Promise<void> {
  const pids = (await readFile(procsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone, or not ours to signal: the cgroup still bounds it */
    }
  }
}

async function removeDir(dir: string, procs: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await killAll(procs);
    if (await rmdir(dir).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function v2Group(dir: string, sudo: boolean): SandboxCgroup {
  return {
    version: 2,
    path: dir,
    join: (pid) => writeAs(join(dir, 'cgroup.procs'), String(pid), sudo),
    async stats() {
      const events = await readFile(join(dir, 'memory.events'), 'utf8').catch(() => '');
      const oom = Number(/^oom_kill (\d+)/m.exec(events)?.[1] ?? 0);
      const peak = await readFile(join(dir, 'memory.peak'), 'utf8').then((s) => Number(s), () => null);
      return { oomKilled: oom > 0, peakBytes: peak };
    },
    async destroy() {
      if (await exists(join(dir, 'cgroup.kill'))) await writeFile(join(dir, 'cgroup.kill'), '1').catch(() => undefined);
      await removeDir(dir, join(dir, 'cgroup.procs'));
    },
  };
}

function v1Group(dir: string, pidsDir: string | null, sudo: boolean): SandboxCgroup {
  return {
    version: 1,
    path: dir,
    async join(pid) {
      await writeAs(join(dir, 'cgroup.procs'), String(pid), sudo);
      if (pidsDir) await writeAs(join(pidsDir, 'cgroup.procs'), String(pid), sudo);
    },
    async stats() {
      const oomControl = await readFile(join(dir, 'memory.oom_control'), 'utf8').catch(() => '');
      const kills = Number(/^oom_kill (\d+)/m.exec(oomControl)?.[1] ?? 0);
      const failcnt = Number((await readFile(join(dir, 'memory.failcnt'), 'utf8').catch(() => '0')).trim());
      const peak = await readFile(join(dir, 'memory.max_usage_in_bytes'), 'utf8').then((s) => Number(s), () => null);
      // Kernels that report oom_kill say exactly whether the limit killed something; older ones only count hits.
      return { oomKilled: /^oom_kill /m.test(oomControl) ? kills > 0 : failcnt > 0, peakBytes: peak };
    },
    async destroy() {
      await removeDir(dir, join(dir, 'cgroup.procs'));
      if (pidsDir) await removeDir(pidsDir, join(pidsDir, 'cgroup.procs'));
    },
  };
}
