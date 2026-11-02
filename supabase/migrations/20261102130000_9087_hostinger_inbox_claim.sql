-- manifest: claim por caixa para serializar rodadas IMAP concorrentes; a lease expira após falha do worker.

alter table public.organization_email_connections
  add column if not exists inbox_claim_token uuid,
  add column if not exists inbox_claim_until timestamptz;

do $claim_constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.organization_email_connections'::regclass
       and conname = 'organization_email_connections_claim_pair_check'
  ) then
    alter table public.organization_email_connections
      add constraint organization_email_connections_claim_pair_check
      check ((inbox_claim_token is null) = (inbox_claim_until is null));
  end if;
end
$claim_constraint$;

comment on column public.organization_email_connections.inbox_claim_token is
  'Token efêmero do worker que reservou a caixa; não é credencial de canal nem é exposto ao cliente.';
comment on column public.organization_email_connections.inbox_claim_until is
  'Expiração da reserva IMAP. Outro worker pode assumir a caixa após esta data se o processo original cair.';

create index if not exists organization_email_connections_claim_idx
  on public.organization_email_connections (inbox_claim_until, last_sync_at)
  where inbox_sync_enabled and status = 'healthy';

notify pgrst, 'reload schema';
