-- Completion phase 7: execution snapshots, run lineage and single-use promotion decisions.

-- The effective execution configuration a run was selected against (audit F05).
alter table runs add column execution_snapshot jsonb;
-- Monotonic per (project, environment): a promotion is only valid for the newest generation.
alter table runs add column generation bigint;
create index runs_generation on runs(project_id, environment, generation desc);

create table promotion_decisions (
  id text primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  environment text not null,
  provider_deployment_id text not null,
  commit_sha text not null,
  run_id text references runs(id),
  run_attempt integer,
  suite_revision text,
  generation bigint,
  eligible boolean not null,
  reasons jsonb not null default '[]',
  decided_by text not null,
  decided_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by text,
  consume_outcome text check (consume_outcome in ('promoted','refused'))
);
create index promotion_decisions_project on promotion_decisions(project_id, environment, decided_at desc);
