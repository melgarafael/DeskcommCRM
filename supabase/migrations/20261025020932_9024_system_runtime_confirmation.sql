-- manifest: system_version records bounded host observations of running services, separate from checkout and update intent.
-- Nullable for compatibility. Old heartbeats explicitly clear the observation.
alter table public.system_version
  add column if not exists runtime_confirmation jsonb;
comment on column public.system_version.runtime_confirmation is
  'Authenticated host observation of compose services and immutable images; the API derives coverage, freshness and release identity.';
