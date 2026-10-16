-- manifest: **Pedido de dados LGPD em instalação sem e-mail deixa de ficar preso em "Processando".** O CHECK `lgpd_requests_status_check` nasceu (EPIC-08) com `received/processing/completed/failed/expired`, mas o `workers/lgpd-export-worker.ts` grava `pending_review` quando não há transporte de e-mail (`EmailNotConfigured`, self-host sem `RESEND_API_KEY`/SMTP) ou quando o titular não tem endereço, e o `workers/lgpd-redact-worker.ts` grava o mesmo estado em `no_local_footprint` e na anonimização de tenant com falha parcial. O banco recusava com 23514, ninguém lia o erro, o pedido ficava em `processing` para sempre com `result` nulo e o PDF no bucket sem ponteiro — e, enquanto isso, a retenção de mídia da organização ficava suspensa (ela pausa com pedido `received`/`processing`). Medido na prova pela tela do #2669 (vps-teste, 11/10). Aqui: (1) o CHECK passa a aceitar `pending_review`, numa troca drop+add dentro de um bloco `do` (o `update.sh` roda sem `ON_ERROR_STOP`; soltos, um add que falhasse deixaria a tabela sem guarda); nenhum saneamento antes do add, porque o conjunto novo só AMPLIA o velho; (2) os pedidos já presos são levados a `pending_review` com o `result` que o worker teria gravado, e SÓ os que têm prova no `api_audit_log` de que passaram pelo desfecho recusado — o worker auditava DEPOIS do update que falhava, então a linha de audit existe sem o estado. Critérios: `lgpd.export_generated` com `metadata.warning = 'email_not_configured'` ou `metadata.delivery = 'pending_review_no_email'`; `lgpd.redact_no_local_footprint`; `lgpd.tenant_redacted` com `metadata.partial_failure = true` — sempre com o pedido ainda em `processing` e `result` nulo. Pedido preso sem essa linha de audit (o audit é fire-and-forget) fica como está. Mesmo bloco, letra a letra, no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon. Gates: `tests/invariants/pedido-lgpd-sem-email-vira-revisao-pendente.test.ts` (o CHECK aceita `pending_review` e recusa valor fora do vocabulário; o bloco do baseline executado sobre pedidos presos plantados; migration e apêndice com o mesmo bloco) e `tests/unit/lgpd-pedido-sem-email-nao-trava.test.ts` (o worker não audita nem devolve `ok` quando o banco recusa o desfecho).
-- 0651: o pedido de LGPD sem e-mail vira revisão pendente, e não "Processando" para sempre.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────────────────────
--
-- O vocabulário de `lgpd_requests.status` no TypeScript (`lib/lgpd/types.ts`, os
-- enums de `app/api/v1/lgpd/requests` e `app/api/v1/admin/lgpd/requests`, as
-- telas) sempre teve `pending_review`; o CHECK do banco nunca teve. Os workers
-- gravavam esse estado sem conferir o erro do update: a recusa (23514) sumia, o
-- worker auditava o desfecho que não aconteceu e devolvia `ok` ao dispatcher —
-- sem retentativa. O worker de exportação passa a conferir o erro (no mesmo PR);
-- aqui o banco passa a aceitar o estado.
--
-- ─── Por que o backfill é confiável ─────────────────────────────────────────────────────────
--
-- Antes desta migration NENHUM update para `pending_review` podia ter dado
-- certo, e todos os quatro caminhos que tentam escrevem um audit DEPOIS do
-- update, com o `resource_id` do pedido. Então: pedido em `processing`, com
-- `result` nulo, que tem esse audit = pedido preso exatamente por este defeito.
-- O `result` é reconstruído do que o próprio worker gravaria:
--
--   * caminhos do PDF: `{org}/{pedido}/report.pdf` e `{org}/{pedido}/data.json`,
--     fixos no worker desde o primeiro commit (`fa2df80be`), e o audit só existe
--     depois dos dois uploads (que lançam se falham);
--   * `sha256`, `signed_pades`, `delivered_to_hash`: do metadata do audit;
--   * `warning`: o assinador (`lib/lgpd/pades-signer.ts`) devolve
--     `pades_key_missing` exatamente quando `signed_pades` é falso — no ramo sem
--     transporte o audit sobrescrevia o `warning` com `email_not_configured`, e
--     é a regra do assinador que o devolve;
--   * tenant: `processed`, `failed_count`, `aggregate_counts`, `callback_status`
--     e o instante do audit como `completed_at`, que é quando o worker gravaria.
--
-- Reaplicável: depois da primeira passada os pedidos curados não estão mais em
-- `processing`, e a troca do CHECK é pulada quando ele já aceita `pending_review`.

do $$
declare
  v_exportacoes integer;
  v_sem_pegada integer;
  v_tenants integer;
begin
  -- 1. O CHECK passa a aceitar o estado que o código grava. Drop e add no MESMO
  --    statement: se o add falhar, a transação desfaz o drop junto.
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.lgpd_requests'::regclass
       and conname = 'lgpd_requests_status_check'
       and pg_get_constraintdef(oid) like '%''pending_review''%'
  ) then
    alter table public.lgpd_requests drop constraint if exists lgpd_requests_status_check;
    alter table public.lgpd_requests add constraint lgpd_requests_status_check
      check (status = any (array['received'::text, 'processing'::text, 'completed'::text,
                                 'failed'::text, 'expired'::text, 'pending_review'::text]));
  end if;

  -- 2. Exportação presa: sem transporte de e-mail, ou titular sem endereço.
  with prova as (
    select distinct on (a.resource_id) a.resource_id, a.organization_id, a.metadata
      from public.api_audit_log a
     where a.action = 'lgpd.export_generated'
       and a.resource_type = 'lgpd_request'
       and (a.metadata->>'warning' = 'email_not_configured'
            or a.metadata->>'delivery' = 'pending_review_no_email')
     order by a.resource_id, a.created_at desc
  )
  update public.lgpd_requests r
     set status = 'pending_review',
         error_message = case when p.metadata->>'warning' = 'email_not_configured'
                              then 'email_not_configured' else 'no_delivery_email' end,
         result = jsonb_build_object(
                    'pdf_path', r.organization_id::text || '/' || r.id::text || '/report.pdf',
                    'json_path', r.organization_id::text || '/' || r.id::text || '/data.json',
                    'sha256', p.metadata->'sha256',
                    'signed_pades', p.metadata->'signed_pades',
                    'warning', case when (p.metadata->>'signed_pades')::boolean
                                    then null else 'pades_key_missing' end
                  )
                  || case when p.metadata->>'warning' = 'email_not_configured'
                          then jsonb_build_object('delivered_to_hash', p.metadata->'delivered_to_hash')
                          else '{}'::jsonb end
    from prova p
   where r.id = p.resource_id
     and r.organization_id = p.organization_id
     and r.request_type = 'data_request'
     and r.status = 'processing'
     and r.result is null;
  get diagnostics v_exportacoes = row_count;

  -- 3. Anonimização de contato sem pegada local.
  update public.lgpd_requests r
     set status = 'pending_review',
         error_message = 'no_local_footprint',
         result = jsonb_build_object('reason', 'no_local_footprint')
   where r.request_type in ('redact', 'store_redact')
     and r.status = 'processing'
     and r.result is null
     and exists (
       select 1
         from public.api_audit_log a
        where a.action = 'lgpd.redact_no_local_footprint'
          and a.resource_type = 'lgpd_request'
          and a.resource_id = r.id
          and a.organization_id = r.organization_id
     );
  get diagnostics v_sem_pegada = row_count;

  -- 4. Anonimização de tenant com falha parcial.
  with prova as (
    select distinct on (a.resource_id) a.resource_id, a.organization_id, a.metadata, a.created_at
      from public.api_audit_log a
     where a.action = 'lgpd.tenant_redacted'
       and a.resource_type = 'lgpd_request'
       and a.metadata->>'partial_failure' = 'true'
     order by a.resource_id, a.created_at desc
  )
  update public.lgpd_requests r
     set status = 'pending_review',
         completed_at = p.created_at,
         error_message = 'partial_failure',
         cascaded_to = p.metadata->'aggregate_counts',
         result = jsonb_build_object(
                    'scope', 'tenant',
                    'processed', p.metadata->'processed',
                    'failed_contacts_count', p.metadata->'failed_count',
                    'aggregate_counts', p.metadata->'aggregate_counts',
                    'callback_status', p.metadata->'callback_status',
                    'organization_status', 'redacted'
                  )
    from prova p
   where r.id = p.resource_id
     and r.organization_id = p.organization_id
     and r.request_type in ('redact', 'store_redact')
     and r.status = 'processing'
     and r.result is null;
  get diagnostics v_tenants = row_count;

  raise notice '0651: pedidos presos levados a pending_review — exportacao %, sem pegada %, tenant %',
    v_exportacoes, v_sem_pegada, v_tenants;
end $$;
