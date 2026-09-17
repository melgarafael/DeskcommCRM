-- O host segura installation FOR UPDATE; admissão segura FOR SHARE da mesma linha.
-- Chamado somente após drenagem ou cancelamento explícito; suspender não basta.
do $$ begin
  perform 1 from bench_state.installation where id=1 for update;
  if exists(select 1 from bench_state.jobs where contract_version<3 and status in ('pending','suspended')) then
    raise exception using errcode='P0001',message='old_jobs_require_drain_or_cancel';
  end if;
  alter table bench_state.records rename column amount_cents to amount_minor;
  update bench_state.installation set schema_version=3 where id=1;
end $$;
