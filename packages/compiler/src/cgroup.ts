import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, rmdir, statfs, writeFile } from 'node:fs/promises';
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
  /** What this group enforces, and how each part was established. */
  guarantee: ResourceGuarantee;
  /** Move a process (before it runs untrusted code) into the cgroup, and verify the kernel placed it there. */
  join(pid: number): Promise<void>;
  /** Whether the kernel reports `pid` as a member of this cgroup (in every hierarchy the limits use). */
  isMember(pid: number): Promise<boolean>;
  /** Whether the memory limit was hit (an OOM kill inside the cgroup) and the peak usage seen. */
  stats(): Promise<{ oomKilled: boolean; peakBytes: number | null }>;
  /** Kill anything left inside and remove the cgroup. */
  destroy(): Promise<void>;
}

/** statfs(2) magic numbers of the two cgroup filesystems. */
const CGROUP_SUPER_MAGIC = 0x27e0eb;
const CGROUP2_SUPER_MAGIC = 0x63677270;
/** The kernel keeps memory limits in whole pages; a read-back may differ from the request by less than one. */
const MAX_PAGE_BYTES = 64 * 1024;

const exists = (p: string) => access(p).then(() => true, () => false);

/** Which cgroup filesystem holds `dir` (null: not a cgroup filesystem at all). */
async function cgroupVersionOf(dir: string): Promise<1 | 2 | null> {
  const t = (await statfs(dir)).type;
  return t === CGROUP2_SUPER_MAGIC ? 2 : t === CGROUP_SUPER_MAGIC ? 1 : null;
}

/** Write a control file the kernel created; never create one (an ordinary file would enforce nothing). */
async function writeControl(file: string, value: string): Promise<void> {
  const h = await open(file, 'r+');
  try {
    await h.write(value);
  } finally {
    await h.close();
  }
}

async function readControl(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).trim();
}

async function writeAs(file: string, value: string, sudo: boolean): Promise<void> {
  try {
    await writeControl(file, value);
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

/** The cgroup `pid` belongs to in the hierarchy that holds `controller` (v1) or in the unified hierarchy (v2). */
async function cgroupOf(pid: number, version: 1 | 2, controller = 'memory'): Promise<string | null> {
  const lines = (await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '')).trim().split('\n');
  for (const l of lines) {
    const [id, ctrls, path] = l.split(':', 3) as [string, string, string | undefined];
    if (version === 2 ? id === '0' && ctrls === '' : ctrls.split(',').includes(controller)) return path ?? null;
  }
  return null;
}

async function listsPid(procsFile: string, pid: number): Promise<boolean> {
  return (await readFile(procsFile, 'utf8').catch(() => '')).split('\n').includes(String(pid));
}


/**
 * The resource contract a sandbox cgroup promises (and records how it was
 * established). Memory: the whole process tree's resident memory *plus swap*
 * stays within `memoryBytes` — on v2 with `memory.swap.max = 0` (no swap at
 * all), on v1 with `memory.memsw.limit_in_bytes` equal to the memory limit
 * (a combined bound: some swap may be used, but never beyond the total), or,
 * where the kernel has no swap accounting, only on a host with no swap
 * configured (checked in /proc/swaps when the group is created; enabling swap
 * later is outside this check). Processes: a cgroup pids cap where the pids
 * controller is available (always on v2); on v1 without it, only the
 * sandbox's RLIMIT_NPROC, which the kernel counts per user (all threads of the
 * sandbox uid), not per sandbox.
 */
export interface ResourceGuarantee {
  memoryBytes: number;
  swap: { bound: 'zero' | 'combined_with_memory' | 'no_host_swap'; established_by: string };
  pids: { cap: number; established_by: string } | { cap: null; established_by: string };
}

export type CgroupFailure = 'invalid_config' | 'not_linux' | 'no_hierarchy' | 'not_cgroup' | 'controller_missing' | 'control_missing' | 'control_write_failed' | 'limit_mismatch' | 'swap_unbounded';

export interface CgroupUnavailable {
  unavailable: string;
  /** Why each candidate hierarchy was refused, and which guarantee failed. */
  failures: Array<{ parent: string; reason: CgroupFailure; guarantee: 'memory' | 'swap' | 'pids' | 'hierarchy'; detail: string }>;
}

class SetupError extends Error {
  constructor(
    readonly reason: CgroupFailure,
    readonly guarantee: 'memory' | 'swap' | 'pids' | 'hierarchy',
    message: string,
  ) {
    super(message);
  }
}

/** Write a control file and read it back; any failure refuses the group (a required bound is never skipped). */
async function setControl(file: string, value: string, guarantee: 'memory' | 'swap' | 'pids', accept: (actual: string) => boolean): Promise<void> {
  try {
    await writeControl(file, value);
  } catch (e) {
    throw new SetupError('control_write_failed', guarantee, `${file} could not be set to ${value}: ${(e as Error).message}`);
  }
  const actual = await readControl(file).catch((e: Error) => `unreadable (${e.message})`);
  if (!accept(actual)) throw new SetupError('limit_mismatch', guarantee, `${file} reads back as ${actual}, not ${value}`);
}

/** Within one page of the request and never above it (the kernel keeps limits in whole pages). */
const limitMatches = (requested: number) => (actual: string) => {
  const n = Number(actual);
  return Number.isFinite(n) && n <= requested && requested - n < MAX_PAGE_BYTES;
};

async function hostHasSwap(): Promise<boolean> {
  const lines = (await readFile('/proc/swaps', 'utf8').catch(() => 'unreadable\nunknown')).trim().split('\n');
  return lines.length > 1;
}

/**
 * Create a per-run cgroup with the given limits, or say why none can be
 * created. Nothing is assumed from paths: the parent must be on a cgroup
 * filesystem (statfs), with the controllers delegated to it; the control files
 * written must be ones the kernel created; every limit of the resource
 * contract (see `ResourceGuarantee`) must be written and read back, or the
 * group is refused; and `join` verifies kernel membership. A plain directory,
 * a hand-made controller layout or a hierarchy without the memory controller
 * is rejected.
 */
export async function createSandboxCgroup(limits: CgroupLimits, env: NodeJS.ProcessEnv = process.env): Promise<SandboxCgroup | CgroupUnavailable> {
  const refuse = (reason: CgroupFailure, detail: string): CgroupUnavailable => ({ unavailable: detail, failures: [{ parent: '', reason, guarantee: 'hierarchy', detail }] });
  if (!Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes <= 0) return refuse('invalid_config', `invalid memory limit ${limits.memoryBytes}: a positive whole number of bytes is required`);
  if (limits.pids !== undefined && (!Number.isSafeInteger(limits.pids) || limits.pids <= 0)) return refuse('invalid_config', `invalid process cap ${limits.pids}: a positive whole number is required`);
  if (process.platform !== 'linux') return refuse('not_linux', `cgroups require Linux (platform ${process.platform})`);
  const sudo = env.QA_SANDBOX_CGROUP_SUDO === '1';
  const name = `qa-sbx-${randomBytes(6).toString('hex')}`;
  const candidates: Array<{ parent: string; pidsParent?: string }> = [];
  if (env.QA_SANDBOX_CGROUP) candidates.push({ parent: env.QA_SANDBOX_CGROUP });
  else {
    const own = await ownCgroups();
    const v2 = await v2Mount();
    if (v2 && own.v2 !== null) candidates.push({ parent: join(v2, own.v2) });
    if (own.memory !== null) candidates.push({ parent: join('/sys/fs/cgroup/memory', own.memory), ...(own.pids !== null ? { pidsParent: join('/sys/fs/cgroup/pids', own.pids) } : {}) });
  }
  const failures: CgroupUnavailable['failures'] = [];
  const mem = String(limits.memoryBytes);
  for (const c of candidates) {
    const dir = join(c.parent, name);
    let pidsDir: string | null = null;
    let made = false;
    try {
      const version = await cgroupVersionOf(c.parent).catch(() => null);
      if (version === null) throw new SetupError('not_cgroup', 'hierarchy', 'not on a cgroup filesystem');
      const requireControls = async (d: string, files: string[]) => {
        for (const f of files) if (!(await exists(join(d, f)))) throw new SetupError('control_missing', 'hierarchy', `the kernel did not create ${f}`);
      };
      const noSwapHost = async (why: string) => {
        if (await hostHasSwap()) throw new SetupError('swap_unbounded', 'swap', `${why}, and this host has swap configured (/proc/swaps): memory plus swap would not be bounded`);
        return { bound: 'no_host_swap' as const, established_by: `${why}; /proc/swaps lists no swap at creation` };
      };
      if (version === 2) {
        if (!(await exists(join(c.parent, 'cgroup.controllers')))) throw new SetupError('not_cgroup', 'hierarchy', 'no cgroup.controllers: not a cgroup v2 directory');
        const enabled = (await readControl(join(c.parent, 'cgroup.subtree_control'))).split(/\s+/);
        if (!enabled.includes('memory')) throw new SetupError('controller_missing', 'memory', 'the memory controller is not delegated to it (cgroup.subtree_control)');
        if (limits.pids && !enabled.includes('pids')) throw new SetupError('controller_missing', 'pids', 'the pids controller is not delegated to it (cgroup.subtree_control)');
        await mkdir(dir);
        made = true;
        if ((await cgroupVersionOf(dir)) !== 2) throw new SetupError('not_cgroup', 'hierarchy', 'the new cgroup is not on the cgroup v2 filesystem');
        await requireControls(dir, ['cgroup.procs', 'memory.max', 'memory.events']);
        await setControl(join(dir, 'memory.max'), mem, 'memory', limitMatches(limits.memoryBytes));
        let swap: ResourceGuarantee['swap'];
        if (await exists(join(dir, 'memory.swap.max'))) {
          await setControl(join(dir, 'memory.swap.max'), '0', 'swap', (a) => a === '0');
          swap = { bound: 'zero', established_by: 'memory.swap.max = 0 (read back)' };
        } else swap = await noSwapHost('no memory.swap.max (swap accounting is off)');
        if (await exists(join(dir, 'memory.oom.group'))) await writeControl(join(dir, 'memory.oom.group'), '1');
        let pids: ResourceGuarantee['pids'] = { cap: null, established_by: 'no cap requested' };
        if (limits.pids) {
          await setControl(join(dir, 'pids.max'), String(limits.pids), 'pids', (a) => a === String(limits.pids));
          pids = { cap: limits.pids, established_by: 'pids.max (read back)' };
        }
        return v2Group(dir, name, sudo, { memoryBytes: limits.memoryBytes, swap, pids });
      }
      if (!(await exists(join(c.parent, 'memory.limit_in_bytes')))) throw new SetupError('controller_missing', 'memory', 'not in the cgroup v1 memory hierarchy (no memory.limit_in_bytes)');
      await mkdir(dir);
      made = true;
      if ((await cgroupVersionOf(dir)) !== 1) throw new SetupError('not_cgroup', 'hierarchy', 'the new cgroup is not on a cgroup v1 filesystem');
      await requireControls(dir, ['cgroup.procs', 'memory.limit_in_bytes']);
      await setControl(join(dir, 'memory.limit_in_bytes'), mem, 'memory', limitMatches(limits.memoryBytes));
      let swap: ResourceGuarantee['swap'];
      if (await exists(join(dir, 'memory.memsw.limit_in_bytes'))) {
        // Required: the combined bound is the only thing that stops the tree from swapping past its memory limit.
        await setControl(join(dir, 'memory.memsw.limit_in_bytes'), mem, 'swap', limitMatches(limits.memoryBytes));
        swap = { bound: 'combined_with_memory', established_by: 'memory.memsw.limit_in_bytes = memory limit (read back)' };
      } else swap = await noSwapHost('no memory.memsw.limit_in_bytes (swap accounting is off)');
      let pids: ResourceGuarantee['pids'] = { cap: null, established_by: 'RLIMIT_NPROC only (counted per user: every thread of the sandbox uid), no v1 pids hierarchy for this cgroup' };
      if (limits.pids && c.pidsParent && (await exists(c.pidsParent)) && (await cgroupVersionOf(c.pidsParent).catch(() => null)) === 1) {
        // A v1 pids group this runner may not create leaves the documented RLIMIT_NPROC bound; one it did create
        // must take and read back its cap, or the group is refused.
        const pd = join(c.pidsParent, name);
        if (await mkdir(pd).then(() => true, () => false)) {
          pidsDir = pd;
          await requireControls(pidsDir, ['pids.max', 'cgroup.procs']);
          await setControl(join(pidsDir, 'pids.max'), String(limits.pids), 'pids', (a) => a === String(limits.pids));
          pids = { cap: limits.pids, established_by: 'v1 pids.max (read back)' };
        }
      } else if (!limits.pids) pids = { cap: null, established_by: 'no cap requested' };
      return v1Group(dir, pidsDir, name, sudo, { memoryBytes: limits.memoryBytes, swap, pids });
    } catch (e) {
      const se = e instanceof SetupError ? e : new SetupError('control_write_failed', 'hierarchy', (e as Error).message);
      failures.push({ parent: c.parent, reason: se.reason, guarantee: se.guarantee, detail: se.message });
      if (made) await rmdir(dir).catch(() => undefined);
      if (pidsDir) await rmdir(pidsDir).catch(() => undefined);
    }
  }
  const detail = failures.map((f) => `${f.parent}: ${f.detail}`).join('; ') || 'no cgroup hierarchy found';
  return { unavailable: `no cgroup could be created for the sandbox memory limit (${detail}); delegate one with QA_SANDBOX_CGROUP`, failures: failures.length ? failures : [{ parent: '', reason: 'no_hierarchy', guarantee: 'hierarchy', detail }] };
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

function v2Group(dir: string, name: string, sudo: boolean, guarantee: ResourceGuarantee): SandboxCgroup {
  const isMember = async (pid: number) => (await listsPid(join(dir, 'cgroup.procs'), pid)) && !!(await cgroupOf(pid, 2))?.endsWith(`/${name}`);
  return {
    version: 2,
    path: dir,
    guarantee,
    isMember,
    async join(pid) {
      await writeAs(join(dir, 'cgroup.procs'), String(pid), sudo);
      if (!(await isMember(pid))) throw new Error(`the kernel does not report process ${pid} in ${dir}`);
    },
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

function v1Group(dir: string, pidsDir: string | null, name: string, sudo: boolean, guarantee: ResourceGuarantee): SandboxCgroup {
  const isMember = async (pid: number) =>
    (await listsPid(join(dir, 'cgroup.procs'), pid)) &&
    !!(await cgroupOf(pid, 1, 'memory'))?.endsWith(`/${name}`) &&
    (!pidsDir || ((await listsPid(join(pidsDir, 'cgroup.procs'), pid)) && !!(await cgroupOf(pid, 1, 'pids'))?.endsWith(`/${name}`)));
  return {
    version: 1,
    path: dir,
    guarantee,
    isMember,
    async join(pid) {
      await writeAs(join(dir, 'cgroup.procs'), String(pid), sudo);
      if (pidsDir) await writeAs(join(pidsDir, 'cgroup.procs'), String(pid), sudo);
      if (!(await isMember(pid))) throw new Error(`the kernel does not report process ${pid} in ${dir}`);
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
