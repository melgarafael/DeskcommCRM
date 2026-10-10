-- Migration 0017: Create lgpd-exports storage bucket with per-tenant RLS
-- Wave 4 EPIC-08 (S-08.04): LGPD data-request export delivery

-- Private bucket, 50MB cap, only PDF + JSON
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lgpd-exports',
  'lgpd-exports',
  false,
  52428800,
  array['application/pdf', 'application/json']
)
on conflict (id) do nothing;

-- Per-tenant SELECT: only members of the org owning the path prefix.
-- Worker uploads/deletes via service-role (bypasses RLS naturally) — no
-- INSERT/DELETE policy is added for anon/authenticated since users must
-- never write to this bucket.
create policy "tenant_read_lgpd_exports" on storage.objects for select
  using (
    bucket_id = 'lgpd-exports'
    and exists (
      select 1 from public.user_organizations uo
      where uo.user_id = auth.uid()
        and uo.revoked_at is null
        and uo.organization_id = (split_part(name, '/', 1))::uuid
    )
  );
