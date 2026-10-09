-- manifest: **A limpeza automática de mídia antiga ganha um interruptor e passa a marcar a mensagem (issue #1534, PR #2180).** Coluna `organizations.media_retention_enforced` (default TRUE: a organização que já existe CONTINUA com a limpeza que roda desde a 0432/1.53.0, e a nova nasce igual; sem backfill, então a atualização não desliga nem religa ninguém). `fn_enfileirar_midia_vencida` só expira organização com o interruptor ligado, anula `media_storage_path` E `media_url`, zera `media_derived_text`, grava `metadata.media_status='expired'` + `media_expired_at` + `media_retention_days`, mantém o piso de 30 dias e SUSPENDE a expiração enquanto a organização tem pedido LGPD em andamento (`lgpd_requests` status `received`/`processing`). Dreno em lotes também no cron `data-retention`; rota `messages/[id]/media` devolve 410 e não re-busca do provedor.
--
-- ──── a limpeza de mídia ganha interruptor e marca a mensagem como expirada (migration 0557) ────
--
-- Desde a 0432 (#1731, versão 1.53.0) a função abaixo apaga a mídia de mensagem
-- de TODA organização pela `media_retention_days` dela. Esta migration NÃO muda
-- isso para quem já existe — decisão do mantenedor (doc 92, opção A): a limpeza
-- continua ligada, e o interruptor serve para quem quiser DESLIGAR.
--
-- Esta migration fecha o aceite do issue #1534 por quatro pontas:
--   (A) `organizations.media_retention_enforced`, default TRUE. O `add column`
--       com default preenche TRUE em toda linha existente, e NÃO há `update`
--       de backfill: um `update` aqui seria reaplicado pelo `update.sh` a cada
--       versão (o baseline inteiro roda de novo) e desfaria a escolha de quem
--       mexeu no interruptor.
--   (B) A função passou a respeitar o interruptor, a anular TAMBÉM `media_url` (a
--       rota de mídia não re-busca do provedor o que expirou), a zerar
--       `media_derived_text` (a transcrição sai junto com o áudio) e a marcar
--       `metadata.media_status='expired'` + `media_expired_at` — o marcador da
--       tela (aviso próprio) e da rota (410).
--   (C) Piso de 30 dias no `greatest(..., 30)`: vale MESMO com valor menor
--       gravado direto no banco, porque o piso mora dentro do corpo da função.
--   (D) Suspensão por pedido LGPD em andamento: enquanto a organização tem
--       `lgpd_requests` em `received`/`processing`, a função não enfileira a
--       mídia dela — um pedido de acesso/eliminação em curso não pode ter o
--       objeto destruído no meio do atendimento. Sem schema novo: a tabela e o
--       índice `lgpd_requests_org_status_idx` já existem (0064).
--
-- Lotes: `p_limite` (default 500) limita o `alvo`, então quem chama em laço drena
-- progressivamente — é o que o cron `data-retention` (lotes de 1000, teto de 20
-- por execução) e o cron `media-retention` (tandas de 500) fazem.
--
-- Idempotente. O apêndice do `baseline.sql` carrega o MESMO corpo (a regra
-- `apendice-do-baseline-nao-diverge-da-cadeia` cobra).

alter table public.organizations
  add column if not exists media_retention_enforced boolean not null default true;

-- ──── a função que aplica a retenção, agora respeitando o interruptor ───────
--
-- O corpo é o da 0483 EDITADO: as mudanças são (1) o gate `media_retention_enforced`
-- e a SUSPENÇÃO por pedido LGPD aberto no passo VENCIDAS, e (2) o `limpas`
-- anulando também `media_url`, zerando `media_derived_text` e gravando o
-- marcador `media_status='expired'` + `media_expired_at`. O resto — piso no
-- `greatest`, lote no `limit`, isolamento por `m.organization_id` na junção,
-- templates e avatares fora do `alvo`, a reabertura no `on conflict`, o expurgo
-- da fila, os órfãos das duas filas — é exatamente o corpo da 0483.
create or replace function public.fn_enfileirar_midia_vencida(p_limite integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_lim integer := greatest(1, least(coalesce(p_limite, 500), 5000));
  v_vencidas integer := 0;
  v_orfas integer := 0;
  v_orfas_nota integer := 0;
  v_expurgadas integer := 0;
  v_janela_deleted interval := interval '90 days';
begin
  -- 0. EXPURGO da fila (0043 comportamento preservado).
  delete from public.storage_redaction_queue
   where status = 'deleted'
     and request_id is null
     and coalesce(processed_at, enqueued_at) < now() - v_janela_deleted;
  get diagnostics v_expurgadas = row_count;

  -- 1. VENCIDAS: arquivo de mensagem mais velho que a retenção — SÓ de
  --    organização com o interruptor LIGADO (media_retention_enforced, o padrão) e que
  --    NÃO está com pedido LGPD em andamento. Piso de 30 dias no `greatest`,
  --    mesmo com valor menor gravado no banco. A mensagem fica (texto, status,
  --    horário); o arquivo sai, a `media_url` também (a rota não busca de novo do
  --    provedor), a transcrição some junto e a mensagem é MARCADA
  --    `media_status='expired'` (aceite #1534).
  with alvo as (
    select m.id, m.organization_id, m.media_storage_path as caminho,
           greatest(coalesce(o.media_retention_days, 365), 30) as retencao_dias
      from public.messages m
      join public.organizations o on o.id = m.organization_id
     where m.media_storage_path is not null
       and o.media_retention_enforced
       and m.created_at < now() - make_interval(days => greatest(coalesce(o.media_retention_days, 365), 30))
       and not exists (
         select 1 from public.lgpd_requests r
          where r.organization_id = m.organization_id
            and r.status in ('received', 'processing')
       )
     order by m.created_at
     limit v_lim
     for update of m skip locked
  ), fila as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct a.organization_id, 'whatsapp-media', a.caminho
      from alvo a
     where not exists (
       select 1 from public.messages m2
        where m2.media_storage_path = a.caminho
          and m2.id not in (select id from alvo)
     )
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  ), limpas as (
    update public.messages m
       set media_storage_path = null,
           media_url = null,
           media_derived_text = null,
           metadata = coalesce(m.metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'media_status', 'expired',
                  'media_expired_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'media_retention_days', alvo.retencao_dias
                ),
           updated_at = now()
      from alvo
     where m.id = alvo.id
    returning 1
  )
  select count(*) into v_vencidas from limpas;

  -- 2. ÓRFÃOS (bucket whatsapp-media) — comportamento da 0432, intacto.
  with orfaos as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'whatsapp-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.organizations g where g.id::text = split_part(o.name, '/', 1))
       and (
         split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or split_part(o.name, '/', 2) = 'avatars'
       )
       and not exists (select 1 from public.messages m where m.media_storage_path = o.name)
       and not exists (select 1 from public.contacts c where c.avatar_storage_path = o.name)
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = 'whatsapp-media' and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     limit v_lim
  ), fila as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select org, 'whatsapp-media', caminho from orfaos
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_orfas from fila;

  -- 2b. ÓRFÃOS DA NOTA INTERNA (bucket internal-media) — comportamento da 0483, intacto.
  with orfaos_da_nota as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'internal-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.organizations g where g.id::text = split_part(o.name, '/', 1))
       and split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and not exists (
         select 1 from public.conversation_notes n where n.media_storage_path = o.name
       )
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = 'internal-media' and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     limit v_lim
  ), fila_da_nota as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select org, 'internal-media', caminho from orfaos_da_nota
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_orfas_nota from fila_da_nota;
  v_orfas := v_orfas + v_orfas_nota;
  return jsonb_build_object('vencidas', v_vencidas, 'orfas', v_orfas, 'expurgadas', v_expurgadas);
end;
$$;

revoke execute on function public.fn_enfileirar_midia_vencida(integer) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_midia_vencida(integer) to service_role;
