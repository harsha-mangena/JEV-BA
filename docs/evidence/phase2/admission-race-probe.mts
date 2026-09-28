import { createIsolatedDb, dropSchema } from '../../../packages/db/src/index.ts';
const url = 'postgres://qa@127.0.0.1:55432/postgres';
const schema = 't_oldlease';
const db = await createIsolatedDb(url, schema);
const OLD = `with active as (
  select tenant_id, count(*) n from jobs where state='leased' and lease_expires_at >= now() group by tenant_id
), candidate as (
  select j.id from jobs j join tenants t on t.id = j.tenant_id left join active a on a.tenant_id = j.tenant_id
  where ((j.state='queued' and j.available_at <= now()) or (j.state='leased' and j.lease_expires_at < now()))
    and coalesce(a.n, 0) < t.max_concurrent_jobs
  order by coalesce(a.n, 0), j.available_at, j.id
  limit 1 for update of j skip locked
)
update jobs set state='leased', lease_owner=$1, lease_expires_at=now() + interval '60 seconds', attempts=attempts+1, updated_at=now()
from candidate where jobs.id = candidate.id returning jobs.id`;
let worst = 0;
for (let round = 0; round < 20; round++) {
  await db.query('delete from jobs');
  await db.query(`insert into tenants(id,name,max_concurrent_jobs) values ('acme','acme',2) on conflict (id) do update set max_concurrent_jobs=2`);
  await db.query(`insert into jobs(tenant_id, kind) select 'acme','noop' from generate_series(1,30)`);
  await Promise.all(Array.from({ length: 12 }, (_, i) => db.query(OLD, [`w${i}`])));
  const n = (await db.one<{ n: number }>(`select count(*)::int n from jobs where state='leased'`))!.n;
  worst = Math.max(worst, n);
}
console.log(JSON.stringify({ query: 'pre-phase-2 lease CTE', tenant_quota: 2, concurrent_workers: 12, rounds: 20, max_active_leases_observed: worst }));
await db.close();
await dropSchema(url, schema);
