-- Phase 9: reviews, quotas, retention.
create table findings (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  fingerprint text not null,
  kind text not null,
  scenario_id text not null,
  checkpoint text not null,
  execution_profile text not null,
  requirement_ids jsonb not null default '[]',
  certainty text not null check (certainty in ('suspected','reproduced','confirmed')),
  summary text not null,
  occurrences integer not null default 1,
  commits jsonb not null default '[]',
  evidence jsonb not null default '[]',
  status text not null default 'open' check (status in ('open','accepted','dismissed')),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (project_id, fingerprint)
);

create table baseline_approvals (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  run_id text not null references runs(id),
  scenario_id text not null,
  checkpoint text not null,
  execution_profile text not null,
  rendering_profile text not null,
  version integer not null,
  sha256 text not null,
  commit_sha text not null,
  approved_by text not null,
  approved_at timestamptz not null default now()
);

create table scenario_approvals (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references projects(id),
  scenario_id text not null,
  source text not null,
  sha256 text not null,
  approved_by text not null,
  approved_at timestamptz not null default now()
);

create table provider_usage (
  tenant_id text not null references tenants(id),
  day date not null,
  provider text not null,
  requests integer not null default 0,
  primary key (tenant_id, day, provider)
);

alter table tenants add column s1_daily_quota integer not null default 10000 check (s1_daily_quota >= 0);
alter table runs add column artifacts_purged_at timestamptz;
alter table case_results add column run_dir text;
alter table cleanup_tasks add column alerted_at timestamptz;
