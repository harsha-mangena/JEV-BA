import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSandboxCgroup, type CgroupFailure, type ResourceGuarantee, type SandboxCgroup } from './cgroup.ts';

/**
 * Linux namespace sandbox for generated or repaired test code (audit F03).
 *
 * The child runs as an unprivileged user (uid 65534 when started by root)
 * inside new user, mount, network, PID, IPC and UTS namespaces:
 *   - filesystem: a private tmpfs root with read-only binds of the system,
 *     the Node runtime, the browser cache and node_modules; the only writable
 *     host path is the job's own work directory; the host root is detached
 *     with pivot_root, so nothing else is reachable at all;
 *   - network: a fresh namespace with loopback only; one allowed TCP target
 *     (the application under test) is relayed through a UNIX socket, so no
 *     other host service or external address is reachable;
 *   - privileges: no_new_privs, empty capability bounding set before the
 *     untrusted program runs; rlimits on processes, files and core dumps;
 *   - memory: with `limits.memoryBytes`, the whole process tree runs in its
 *     own control group with that memory limit (and a process cap), joined
 *     before any untrusted code runs; if the limit cannot be enforced, nothing
 *     runs;
 *   - lifetime: a hard timeout kills the whole process group, and the PID
 *     namespace dies with its init.
 * There is no fallback: if the sandbox cannot be created, nothing runs.
 */
export interface SandboxRun {
  /** Program and arguments, resolved inside the sandbox. */
  command: string[];
  /** Host directory mounted read-write at /sandbox/work (the only writable host path). */
  workDir: string;
  /** Extra host paths bound read-only at the same path. */
  readOnly?: string[];
  /** Host directory bound read-only at /sandbox/node_modules. */
  nodeModules?: string;
  /** Environment for the untrusted program (nothing is inherited). */
  env?: Record<string, string>;
  /** The single TCP endpoint the program may reach, exposed inside at the same host:port. */
  allowTcp?: { host: string; port: number };
  timeoutMs: number;
  /**
   * `nproc` bounds the processes the sandbox may *add*: RLIMIT_NPROC counts every
   * task (thread) of the real uid, so the kernel limit is set to the uid's current
   * thread count plus a small allowance for host churn plus this budget (otherwise
   * a busy CI user could not even start the sandbox).
   */
  limits?: { nproc?: number; nofile?: number; fsizeBytes?: number; memoryBytes?: number };
  /** Environment of the runner itself (cgroup delegation settings); defaults to process.env. */
  hostEnv?: NodeJS.ProcessEnv;
}

export interface SandboxResult {
  status: 'exited' | 'timeout' | 'unavailable';
  /** A resource limit the program hit (it was killed for it). */
  exceeded?: 'memory';
  /** With a memory limit: what the run's cgroup enforced, and how each bound was established. */
  guarantee?: ResourceGuarantee;
  /** When the run was refused because a required bound could not be established: why, per hierarchy tried. */
  refused?: Array<{ parent: string; reason: CgroupFailure | 'membership_unverified'; guarantee: string; detail: string }>;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const SETUP = String.raw`
set -eu
PATH=/usr/sbin:/sbin:$PATH
mount --make-rprivate /
R="$SBX_ROOT"
mount -t tmpfs -o size=64m,mode=0755 sbxroot "$R"
ro() { mkdir -p "$R$1"; mount --rbind "$1" "$R$1"; mount -o remount,bind,ro "$R$1"; }
ro /usr
for l in bin lib lib32 lib64 sbin; do
  if [ -L "/$l" ]; then ln -s "$(readlink "/$l")" "$R/$l"; elif [ -d "/$l" ]; then ro "/$l"; fi
done
ro /etc
for p in $SBX_RO; do ro "$p"; done
mkdir -p "$R/sandbox/work" "$R/run/qa" "$R/proc" "$R/tmp" "$R/dev"
mount --bind "$SBX_WORK" "$R/sandbox/work"
if [ -n "$SBX_NODE_MODULES" ]; then mkdir -p "$R/sandbox/node_modules"; mount --rbind "$SBX_NODE_MODULES" "$R/sandbox/node_modules"; mount -o remount,bind,ro "$R/sandbox/node_modules"; fi
mount --bind "$SBX_RUN" "$R/run/qa"
mount -o remount,bind,ro "$R/run/qa"
mount -t proc -o nosuid,nodev,noexec proc "$R/proc"
mount -t tmpfs -o size=256m,mode=1777,nosuid,nodev tmp "$R/tmp"
mount -t tmpfs -o mode=0755,nosuid dev "$R/dev"
for n in null zero random urandom; do touch "$R/dev/$n"; mount --bind "/dev/$n" "$R/dev/$n"; done
mkdir -p "$R/dev/shm"; mount -t tmpfs -o size=256m,mode=1777,nosuid,nodev shm "$R/dev/shm"
ln -s /proc/self/fd "$R/dev/fd"
mkdir "$R/.oldroot"
cd "$R"
pivot_root . .oldroot
umount -l /.oldroot
rmdir /.oldroot
# Loopback only: bring lo up in the fresh network namespace.
perl -e 'socket(my $s, 2, 2, 0) or die "socket: $!"; my $r = pack("a16 s x14", "lo", 0x1|0x8|0x40); ioctl($s, 0x8914, $r) or die "lo up: $!"'
DROP="setpriv --no-new-privs --bounding-set=-all --inh-caps=-all"
if [ -n "$SBX_RELAY_PORT" ]; then
  $DROP -- "$SBX_NODE" /run/qa/relay.cjs "$SBX_RELAY_HOST" "$SBX_RELAY_PORT" /run/qa/app.sock /tmp/relay.ready &
  i=0; while [ ! -e /tmp/relay.ready ]; do i=$((i+1)); [ $i -gt 200 ] && { echo "relay did not start" >&2; exit 97; }; sleep 0.05; done
fi
unset SBX_ROOT SBX_RO SBX_WORK SBX_RUN SBX_NODE SBX_NODE_MODULES SBX_RELAY_HOST SBX_RELAY_PORT
cd /sandbox/work
exec $DROP -- "$@"
`;

/** Trusted relay inside the sandbox: TCP host:port → UNIX socket bound from the host. */
const RELAY = `const net = require('node:net'); const fs = require('node:fs');
const [host, port, sock, ready] = process.argv.slice(2);
net.createServer((c) => { const u = net.connect(sock); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); })
  .listen(Number(port), host, () => fs.writeFileSync(ready, ''));
`;

/** Headroom for threads the uid's other processes start between counting and exec. */
const HOST_TASK_CHURN = 32;

/** Tasks (threads) currently owned by a real uid — what RLIMIT_NPROC counts. */
async function tasksOf(uid: number): Promise<number> {
  const { readdir, readFile } = await import('node:fs/promises');
  let n = 0;
  for (const pid of (await readdir('/proc').catch(() => [] as string[])).filter((d) => /^\d+$/.test(d))) {
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    const m = /^Uid:\s+(\d+)/m.exec(status);
    if (!m || Number(m[1]) !== uid) continue;
    const t = /^Threads:\s+(\d+)/m.exec(status);
    n += t ? Number(t[1]) : 1;
  }
  return n;
}

let probed: { ok: boolean; detail: string } | undefined;

/** Whether this host can create the sandbox (user namespaces, pivot_root, perl, setpriv, unshare). */
export async function sandboxAvailable(): Promise<{ ok: boolean; detail: string }> {
  if (probed) return probed;
  if (process.platform !== 'linux') return (probed = { ok: false, detail: `sandbox requires Linux (platform ${process.platform})` });
  for (const bin of ['unshare', 'setpriv', 'prlimit', 'perl']) {
    if (spawnSync('sh', ['-c', `command -v ${bin}`]).status !== 0) return (probed = { ok: false, detail: `${bin} is not installed` });
  }
  const work = await mkdtemp(join(tmpdir(), 'qa-sbx-probe-'));
  try {
    const r = await runSandboxed({ command: ['/bin/sh', '-c', 'test ! -e /root/. -o ! -r /root && echo ok'], workDir: work, timeoutMs: 15_000 });
    probed = r.status === 'exited' && r.code === 0 && r.stdout.trim() === 'ok' ? { ok: true, detail: 'user/mount/net/pid namespaces available' } : { ok: false, detail: `sandbox probe failed (${r.status} ${r.code}): ${r.stderr.trim().slice(0, 300)}` };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return probed;
}

export async function runSandboxed(o: SandboxRun): Promise<SandboxResult> {
  const asRoot = process.getuid?.() === 0;
  const uid = 65534;
  const run = await mkdtemp(join(tmpdir(), 'qa-sbx-run-'));
  const root = await mkdtemp(join(tmpdir(), 'qa-sbx-root-'));
  let relay: Server | undefined;
  let cgroup: SandboxCgroup | undefined;
  try {
    await mkdir(o.workDir, { recursive: true });
    await writeFile(join(run, 'relay.cjs'), RELAY);
    await chmod(run, 0o755);
    if (asRoot) {
      // The sandboxed user owns only its work directory and mount point.
      await chown(o.workDir, uid, uid);
      await chown(root, uid, uid);
    }
    if (o.allowTcp) {
      const { host, port } = o.allowTcp;
      relay = createServer((c) => {
        const t = createConnection({ host, port });
        c.pipe(t);
        t.pipe(c);
        c.on('error', () => t.destroy());
        t.on('error', () => c.destroy());
      });
      const sock = join(run, 'app.sock');
      await new Promise<void>((resolve, reject) => relay!.once('error', reject).listen(sock, resolve));
      await chmod(sock, 0o777);
    }
    const node = process.execPath;
    const ro = [dirname(dirname(node)), ...(o.readOnly ?? [])];
    const lim = o.limits ?? {};
    const argv = [
      `--nproc=${(await tasksOf(asRoot ? uid : (process.getuid?.() ?? 0))) + HOST_TASK_CHURN + (lim.nproc ?? 1024)}`,
      `--nofile=${lim.nofile ?? 4096}`,
      `--fsize=${lim.fsizeBytes ?? 512 * 1024 * 1024}`,
      '--core=0',
      '--',
      ...(asRoot ? ['setpriv', `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--'] : []),
      'unshare', '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '--kill-child', '--ipc', '--uts', '--',
      '/bin/sh', '-c', SETUP, 'qa-sandbox', ...o.command,
    ];
    const env: Record<string, string> = {
      PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: '/sandbox/work',
      ...o.env,
      SBX_ROOT: root,
      SBX_RO: ro.join(' '),
      SBX_WORK: o.workDir,
      SBX_RUN: run,
      SBX_NODE: node,
      SBX_NODE_MODULES: o.nodeModules ?? '',
      SBX_RELAY_HOST: o.allowTcp?.host ?? '',
      SBX_RELAY_PORT: o.allowTcp ? String(o.allowTcp.port) : '',
    };
    if (lim.memoryBytes !== undefined) {
      const cg = await createSandboxCgroup({ memoryBytes: lim.memoryBytes, pids: lim.nproc ?? 1024 }, o.hostEnv ?? process.env);
      if ('unavailable' in cg) return { status: 'unavailable', code: null, signal: null, stdout: '', stderr: `memory limit cannot be enforced: ${cg.unavailable}`, refused: cg.failures };
      cgroup = cg;
    }
    return await new Promise<SandboxResult>((resolve) => {
      // With a cgroup, a gate holds the process until it has been moved into the cgroup; only then does it exec
      // anything else, so nothing runs outside the limit.
      const child = cgroup
        ? spawn('/bin/sh', ['-c', 'read _gate && exec "$@"', 'qa-sandbox-gate', 'prlimit', ...argv], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('prlimit', argv, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const cap = (s: string, d: Buffer) => (s.length < 1_000_000 ? s + d.toString() : s);
      child.stdout!.on('data', (d: Buffer) => (stdout = cap(stdout, d)));
      child.stderr!.on('data', (d: Buffer) => (stderr = cap(stderr, d)));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }, o.timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ status: 'unavailable', code: null, signal: null, stdout, stderr: `${stderr}${e.message}` });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        void (async () => {
          const exceeded = cgroup && (await cgroup.stats()).oomKilled ? ('memory' as const) : undefined;
          resolve({ status: timedOut ? 'timeout' : 'exited', ...(exceeded ? { exceeded } : {}), ...(cgroup ? { guarantee: cgroup.guarantee } : {}), code, signal, stdout, stderr });
        })();
      });
      if (cgroup) {
        cgroup.join(child.pid!).then(
          () => child.stdin!.end('go\n'),
          (e: Error) => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              /* already gone */
            }
            clearTimeout(timer);
            resolve({ status: 'unavailable', code: null, signal: null, stdout, stderr: `memory limit cannot be enforced: joining ${cgroup!.path} failed: ${e.message}`, refused: [{ parent: cgroup!.path, reason: 'membership_unverified', guarantee: 'memory', detail: e.message }] });
          },
        );
      }
    });
  } finally {
    await cgroup?.destroy().catch(() => undefined);
    relay?.close();
    await rm(run, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
