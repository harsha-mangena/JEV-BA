-- Completion phase 2: durable action intents, effect receipts, lease fencing.

-- Every lease increments the fence; a worker's writes are accepted only while
-- it still holds the fence it leased with (a stale worker is rejected even if
-- its lease owner string matches after a restart).
alter table jobs add column fence bigint not null default 0;

create table action_intents (
  intent_id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null references runs(id),
  run_attempt integer not null,
  shard integer not null,
  job_id bigint not null references jobs(id),
  fence bigint not null,
  attempt_id text not null,
  scenario_id text not null,
  execution_profile text not null,
  owner text,
  idempotency_key text,
  effect text not null,
  mutation text,
  contract_intent text,
  state text not null check (state in ('PREPARED','DISPATCHING','NOT_DISPATCHED','ACKNOWLEDGED','EFFECT_CONFIRMED','EFFECT_UNKNOWN','RECONCILING','RECONCILED','NEEDS_REVIEW')),
  detail text,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index action_intents_scope on action_intents(run_id, run_attempt, shard, state);
create index action_intents_review on action_intents(tenant_id, state) where state = 'NEEDS_REVIEW';

create table intent_transitions (
  id bigserial primary key,
  intent_id text not null references action_intents(intent_id),
  from_state text,
  to_state text not null,
  fence bigint not null,
  detail text,
  at timestamptz not null default now()
);
create index intent_transitions_intent on intent_transitions(intent_id, id);

create table effect_receipts (
  id bigserial primary key,
  intent_id text not null references action_intents(intent_id),
  kind text not null,
  entity_id text not null,
  owner text not null,
  idempotency_key text,
  observed_at timestamptz not null default now(),
  unique (intent_id, kind, entity_id)
);

alter table case_results add column fence bigint;
