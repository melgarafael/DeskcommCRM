-- 0434 — a fila de remoção de mídia não é eterna: `deleted`/`skipped` reabrem
-- quando o MESMO caminho volta a existir, e linha `deleted` antiga é expurgada.
--
-- Achado na triagem do #1731 (retenção de mídia executada) e detalhado na issue
-- #1739. A 0432 enfileirava com `on conflict (bucket, object_path) do nothing`
-- e o worker marca a linha como `deleted`
-- (`lib/lgpd/storage-redaction-queue.ts`) sem nada a remover depois. Com
-- `unique (bucket, object_path)`, isso produz DUAS coisas ruins:
--
--   1. reenfileirar um caminho que já saiu vira no-op silencioso: o arquivo
--      NOVO gravado naquele caminho nunca é podado nem pela retenção nem pela
--      LGPD;
--   2. a fila cresce sem teto — toda mídia removida deixa uma linha para
--      sempre.
--
-- ## MEDIDO ANTES DE CONCERTAR (#1739, passo 1) — sim, há reaproveitamento
--
-- `grep` em TODOS os emissores de upload do bucket `whatsapp-media` (só o
-- bucket que a fila enfileira):
--
--   * `app/api/v1/cron/contact-avatars/route.ts:204` —
--     `${org}/avatars/${contactId}.jpg` com `upsert: true`: caminho ESTÁVEL
--     por contato, regravado a cada refresh de 7 dias (o comentário da própria
--     linha diz «Caminho estável por contato»). É o reaproveitamento REAL, e o
--     mesmo caminho é enfileirado em dois lugares: `lib/lgpd/redact-cascade.ts`
--     (anonimização) e o cron, quando o contato é anonimizado no meio do fetch.
--   * `workers/media-persist-worker.ts:122` — `storagePathFor(org, conversa,
--     mensagem, mime)` = `{org}/{conversa}/{mensagem}.{ext}` com
--     `upsert: true`: determinístico por MENSAGEM — reaproveita o caminho só
--     quando a MESMA mensagem é regravada (retry), nunca entre mensagens.
--   * `app/api/v1/conversations/[id]/media/route.ts:99` — `out-${randomUUID()}`
--     : nunca reaproveita.
--   * `app/api/v1/products/[id]/fotos/route.ts:107` — `${org}/${produto}/
--     ${randomUUID()}.${ext}`: nunca reaproveita.
--   * `app/api/v1/channels/partner/templates/media/route.ts:103` —
--     `templates/${randomUUID()}.${ext}`: nunca reaproveita (e `org/templates/`
--     nunca entra na fila).
--
-- Conclusão da medida: o item 1 da issue NÃO é teórico — o avatar reaproveita
-- caminho por contato. Então o conserto é o `on conflict ... do update`, e não
-- só o expurgo (que cuidaria só do item 2).
--
-- ## O QUE MUDA
--
--   * Reabre SOMENTE o que já terminou: `deleted`/`skipped` → `pending`, com
--     tentativa zerada e o carimbo da nova tentativa. `pending` e `failed` não
--     são tocados — o `where` do `do update` garante, não um comentário.
--   * O filtro de órfãos deixa de contar linha terminal como «já está na
--     fila»: sem isso o `not exists` segurava o caminho ANTES de o conflito
--     acontecer, e o `do update` jamais rodava.
--   * Expurgo das linhas `deleted` com mais de 90 dias, no MESMO cron diário
--     de retenção (`app/api/v1/cron/media-retention` → esta função): resolve o
--     item 2 sem cron novo. `failed` NÃO é expurgada — a issue manda não mexer
--     nela, e ela é o registro de uma remoção que não passou das 3 tentativas.
--
-- Mesma assinatura (um argumento): criar um segundo parâmetro por `create or
-- replace` nasceria um SOBRECARGA esquecida fora do `revoke`/`grant` que vem
-- depois. O par revoke/grant é repetido para o arquivo ficar autocontido.
--
-- No `baseline.sql` o corpo é EDITADO NO LUGAR do apêndice da 0432 (mesmo
-- desenho das 0417/0426): função criada depois da varredura de `anon` seria
-- reprovada por `varredura-anon-e-o-ultimo-bloco`.
--
-- Sem coluna, sem constraint, sem índice e sem dado reescrito: o expurgo apaga
-- linha de fila que já cumpriu o papel, e nenhuma tabela tem FK para
-- `storage_redaction_queue` (medido no `baseline.sql`: só `id` como PK).
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
  -- Janela do expurgo, em UM lugar só: é a constante que se muda amanhã.
  v_janela_deleted interval := interval '90 days';
begin
  -- 0. EXPURGO: a linha `deleted` já cumpriu o papel (o arquivo saiu do
  --    bucket) e nada mais precisa dela — sem isto a fila cresce sem teto
  --    (#1739, item 2). Só `deleted`: `skipped` é «o objeto já não existe»,
  --    `failed` é a prova de uma remoção que nunca passou das 3 tentativas, e
  --    a issue manda não mexer em nenhuma das duas.
  delete from public.storage_redaction_queue
   where status = 'deleted'
     and coalesce(processed_at, enqueued_at) < now() - v_janela_deleted;

  -- 1. VENCIDAS: arquivo de mensagem mais velho que a retenção da organização.
  --    A mensagem fica (texto, status, horário); só o arquivo sai, e a tela
  --    mostra «Mídia indisponível». O piso de 30 dias é o mesmo do formulário.
  with alvo as (
    select m.id, m.organization_id, m.media_storage_path as caminho
      from public.messages m
      join public.organizations o on o.id = m.organization_id
     where m.media_storage_path is not null
       and m.created_at < now() - make_interval(days => greatest(coalesce(o.media_retention_days, 365), 30))
     order by m.created_at
     limit v_lim
     for update of m skip locked
  ), fila as (
    -- O arquivo só vai para a fila quando nenhuma OUTRA mensagem o usa: a foto
    -- de catálogo tem caminho fixo por conversa e é reaproveitada a cada
    -- reenvio (`fotos-do-produto.ts`), então a mensagem de ontem pode apontar
    -- para o mesmo arquivo da vencida. A vencida perde o caminho do mesmo
    -- jeito; o arquivo sai quando a última referência vencer (aqui) ou no
    -- passo 2, como órfão.
    --
    -- O `do update` é o conserto do #1739: se aquele caminho já saiu da fila
    -- (`deleted`) ou o objeto já nem existia (`skipped`), um arquivo NOVO pode
    -- estar gravado ali agora — e o `do nothing` da 0432 engolia este pedido
    -- silenciosamente, deixando o arquivo novo fora da retenção PARA SEMPRE.
    -- O `where` é a outra metade do conserto: `pending`/`failed` em curso não
    -- são interrompidos (uma remoção em andamento não perde a tentativa).
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
       set media_storage_path = null, updated_at = now()
      from alvo
     where m.id = alvo.id
    returning 1
  )
  select count(*) into v_vencidas from limpas;

  -- 2. ÓRFÃOS: arquivo que nada no banco aponta — o rastro de conversa apagada.
  --    Só as duas pastas que o CRM grava por mensagem e por contato:
  --    `org/<conversa>/…` e `org/avatars/…`. `org/templates/…` (cabeçalho de
  --    modelo) NUNCA entra: quem o usa guarda o link, não o caminho. Um dia de
  --    carência cobre o envio que sobe o arquivo antes de gravar a mensagem.
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
       -- Só linha EM CURSO segura o caminho (`pending`, ou `failed` que ainda
       -- é o registro de uma remoção não feita). Linha `deleted`/`skipped`
       -- NÃO bloqueia mais: é justamente o caso do avatar reaproveitado
       -- (#1739) — o objeto novo no caminho antigo tinha de chegar no conflito
       -- lá embaixo para ser reaberto, e este `not exists` o engolia antes.
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

  return jsonb_build_object('vencidas', v_vencidas, 'orfas', v_orfas);
end;
$$;

revoke execute on function public.fn_enfileirar_midia_vencida(integer) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_midia_vencida(integer) to service_role;
