-- Re-audit R3: deployment lineage (channels) and authoritative ordering.
--
-- A channel is one lineage of candidates inside an environment: the whole
-- environment for `lineage: single` (channel 'default'), or one per verified
-- provider channel (e.g. a pull-request preview) for `lineage: per_channel`.
-- Supersession, the current candidate, generations and promotion decisions
-- are all scoped to the channel.
--
-- Ordering comes from verified provider state (provider_sequence) or, for a
-- lineage whose deployments carry none, from serialized arrival; a lineage
-- keeps the mode its first deployment established. A tie is ambiguous and
-- holds the lineage until a strictly newer deployment arrives. (Lineages
-- carried over from before this migration get their mode from their next
-- deployment.) The channel row is the
-- lock that serializes submission (generation allocation, current candidate)
-- against promotion consumption.

alter table deployments add column channel text not null default 'default';
alter table deployments add column provider_sequence bigint;
alter table runs add column channel text not null default 'default';
alter table promotion_decisions add column channel text not null default 'default';

create table deployment_channels (
  project_id text not null references projects(id),
  environment text not null,
  channel text not null,
  generation bigint not null default 0,
  current_deployment_id text references deployments(id),
  -- Fixed by the lineage's first deployment: 'provider' (verified sequence) or 'arrival' (serialized arrival).
  ordering text check (ordering in ('provider','arrival')),
  ambiguous_detail text,
  updated_at timestamptz not null default now(),
  primary key (project_id, environment, channel)
);

-- Earlier generations were allocated with max()+1 and no lock; renumber them
-- consecutively (order preserved) so the uniqueness below holds.
update runs r set generation = x.rn
from (select id, row_number() over (partition by project_id, environment order by generation nulls last, created_at) rn from runs) x
where r.id = x.id and r.generation is not null;
create unique index runs_channel_generation on runs(project_id, environment, channel, generation);

insert into deployment_channels(project_id, environment, channel, generation, current_deployment_id)
select e.project_id, e.environment, 'default',
       coalesce((select max(generation) from runs r where r.project_id = e.project_id and r.environment = e.environment), 0),
       (select id from deployments d where d.project_id = e.project_id and d.environment = e.environment order by created_at desc limit 1)
from (select distinct project_id, environment from deployments) e;

-- Delivery identity is scoped to the tenant and project that received it.
-- (Records without a tenant/project cannot be scoped; they only deduplicated
-- deliveries that were never bound to a project.)
delete from event_deliveries where tenant_id is null or project_id is null;
alter table event_deliveries drop constraint event_deliveries_pkey;
alter table event_deliveries alter column tenant_id set not null, alter column project_id set not null;
alter table event_deliveries add primary key (tenant_id, project_id, provider, delivery_id);
