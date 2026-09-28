// A real worker process for crash/recovery tests: it leases and executes one
// job against the test schema and is killed (SIGKILL, whole process group,
// browser included) by the test while a checkout is in flight.
import { Db } from '@qa/db';
import { PipelineDeploymentVerifier, RecordingStatusPublisher } from '@qa/integrations';
import { JobWorker, Orchestrator } from '@qa/orchestrator';

const url = process.env.DATABASE_URL!;
const schema = process.env.QA_SCHEMA!;
const db = new Db(url, { schema });
const publisher = new RecordingStatusPublisher();
const orch = new Orchestrator({ db, suiteBaseDir: process.env.QA_ROOT!, env: process.env, verifierFor: () => new PipelineDeploymentVerifier(), publisherFor: () => publisher });
const worker = new JobWorker(orch, { outDir: process.env.QA_OUT!, env: process.env, leaseSeconds: Number(process.env.QA_LEASE_SECONDS ?? 5), workerId: 'crash-worker', log: (m) => process.stdout.write(`${m}\n`) });
process.stdout.write('ready\n');
await worker.processOne();
process.stdout.write('finished\n');
await db.close();
