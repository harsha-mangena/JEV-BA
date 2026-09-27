-- Phase 4: deployment-triggered orchestration.
create table tenants (
  id text primary key,
  name text not null,
  max_concurrent_jobs integer not null default 4 check (max_concurrent_jobs > 0),
  created_at timestamptz not null default now()
);

create table projects (
  id text primary key,
  tenant_id text not null references tenants(id),
  repository_id text,
  repository_full_name text,
  config jsonb not null,
  webhook_secret_ref text,
  github_installation_id bigint,
  created_at timestamptz not null default now()
);
create unique index projects_repository_id on projects(repository_id) where repository_id is not null;

create table api_tokens (
  token_hash text primary key,
  tenant_id text not null references tenants(id),
  project_id text references projects(id),
  role text not null check (role in ('admin', 'submitter', 'reviewer', 'viewer')),
  label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table event_deliveries (
  provider text not null,
  delivery_id text not null,
  tenant_id text references tenants(id),
  project_id text references projects(id),
  payload_digest text not null,
  outcome text not null,
  detail text,
  run_id text,
  received_at timestamptz not null default now(),
  primary key (provider, delivery_id)
);

create table deployments (
  id text primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  provider text not null,
  provider_deployment_id text not null,
  environment text not null,
  immutable_url text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  unique (project_id, provider, provider_deployment_id)
);
create index deployments_env on deployments(project_id, environment, created_at desc);

create table runs (
  id text primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  deployment_id text not null references deployments(id),
  environment text not null,
  commit_sha text not null,
  suite_revision text not null,
  execution_profile text not null,
  dedup_key text not null unique,
  state text not null check (state in ('RECEIVED','VALIDATING','WAITING_READY','QUEUED','RUNNING','VERIFYING','COMPLETED','ERROR','CANCELLED','SUPERSEDED')),
  attempt integer not null default 1,
  selection_manifest jsonb,
  gate jsonb,
  reason text,
  message text,
  superseded_by text references runs(id),
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index runs_project_env on runs(project_id, environment, created_at desc);

create table case_results (
  run_id text not null references runs(id),
  attempt integer not null,
  shard integer not null,
  scenario_id text not null,
  execution_profile text not null,
  verdict text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, attempt, scenario_id, execution_profile)
);

create table jobs (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  run_id text references runs(id),
  kind text not null,
  payload jsonb not null default '{}',
  state text not null default 'queued' check (state in ('queued','leased','done','failed','cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready on jobs(state, available_at);
create index jobs_run on jobs(run_id);

create table outbox_events (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  kind text not null,
  payload jsonb not null,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index outbox_pending on outbox_events(available_at) where published_at is null;

create table audit_log (
  id bigserial primary key,
  tenant_id text,
  actor text not null,
  action text not null,
  subject text,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);

create table cleanup_tasks (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  run_id text references runs(id),
  fixture_id text not null,
  fixture_api_url text not null,
  state text not null default 'pending' check (state in ('pending','done','failed')),
  attempts integer not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (fixture_id)
);
