#!/usr/bin/env node
// Run one test lane and write a machine-readable result manifest:
// code SHA, environment, command, dependency versions, timing, counts, skip reasons, digest.
import { spawnSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const LANES = {
  static: { cmd: ['npx', 'tsc', '-p', 'tsconfig.json', '--noEmit'], kind: 'tsc' },
  unit: { config: 'vitest.config.ts' },
  e2e: { config: 'vitest.e2e.config.ts', requires: ['browser'] },
  service: { config: 'vitest.service.config.ts', requires: ['browser', 'postgres'] },
  audit: { config: 'vitest.audit.config.ts', requires: ['browser'] },
  isolation: { config: 'vitest.isolation.config.ts', requires: ['sandbox'] },
  live: { config: 'vitest.live.config.ts', requires: ['provider-credentials'], env: ['QA_S1_API_KEY'] },
};

const name = process.argv[2];
const lane = LANES[name];
if (!lane) {
  console.error(`usage: run-lane <${Object.keys(LANES).join('|')}>`);
  process.exit(2);
}
// A lane whose external prerequisite is missing is BLOCKED: it is recorded, never run, never counted as passing.
const missing = (lane.env ?? []).filter((k) => !process.env[k]);
if (missing.length) {
  const blocked = { lane: name, status: 'BLOCKED', missing_prerequisites: missing, requires: lane.requires ?? [], at: new Date().toISOString() };
  mkdirSync(join('evidence', 'lanes'), { recursive: true });
  writeFileSync(join('evidence', 'lanes', `${name}.json`), `${JSON.stringify(blocked, null, 2)}\n`);
  console.log(`lane ${name}: BLOCKED (missing ${missing.join(', ')}) → evidence/lanes/${name}.json`);
  process.exit(3);
}
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const started = new Date();
const out = join('evidence', 'lanes');
mkdirSync(out, { recursive: true });
const tmp = join(out, `.${name}.vitest.json`);
let command;
let result;
if (lane.kind === 'tsc') {
  command = lane.cmd.join(' ');
  result = spawnSync(lane.cmd[0], lane.cmd.slice(1), { stdio: 'inherit' });
} else {
  const args = ['vitest', 'run', '--config', lane.config, '--reporter=default', '--reporter=json', `--outputFile.json=${tmp}`];
  command = `npx ${args.join(' ')}`;
  result = spawnSync('npx', args, { stdio: 'inherit', env: process.env });
}
const finished = new Date();
let counts = null;
const skipped = [];
if (lane.kind !== 'tsc') {
  try {
    const j = JSON.parse(readFileSync(tmp, 'utf8'));
    counts = { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests + (j.numTodoTests ?? 0) };
    for (const f of j.testResults) for (const a of f.assertionResults) if (a.status === 'pending' || a.status === 'skipped') skipped.push(`${f.name.replace(process.cwd() + '/', '')} › ${a.fullName}`);
    rmSync(tmp, { force: true });
  } catch { counts = null; }
}
const manifest = {
  lane: name,
  status: result.status === 0 ? 'PASSED' : 'FAILED',
  code_sha: sh('git rev-parse HEAD'),
  dirty: (sh('git status --porcelain') ?? '').length > 0,
  command,
  exit_code: result.status,
  started_at: started.toISOString(),
  finished_at: finished.toISOString(),
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, ci: !!process.env.CI, database: process.env.DATABASE_URL ? 'configured' : 'absent', require_service: process.env.QA_REQUIRE_SERVICE === '1' },
  dependencies: { playwright: sh('node -p "require(\'@playwright/test/package.json\').version"'), typescript: sh('node -p "require(\'typescript/package.json\').version"'), vitest: sh('node -p "require(\'vitest/package.json\').version"'), postgres: sh('psql --version') },
  requires: lane.requires ?? [],
  counts,
  skipped,
};
manifest.digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`lane ${name}: exit ${result.status}; ${counts ? `${counts.passed}/${counts.total} passed, ${counts.failed} failed, ${counts.skipped} skipped` : 'no counts'} → evidence/lanes/${name}.json`);
process.exit(result.status ?? 1);
