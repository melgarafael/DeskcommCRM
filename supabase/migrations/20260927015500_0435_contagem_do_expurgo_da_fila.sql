-- 0435 — a contagem do expurgo da fila de mídia, no retorno e na trilha
-- (issue #1765, continuação da #1739 / PR #1763).
--
-- A 0434 passou a expurgar, no CORPO de `fn_enfileirar_midia_vencida`, a linha
-- `deleted` da retenção com mais de 90 dias. O DELETE está lá, roda todo dia,
-- e a sua contagem não aparece em lugar nenhum:
--
--   1. a função devolve só `{vencidas, orfas}` — o passo 0 apaga linha e não
--      diz quantas;
--   2. `app/api/v1/cron/media-retention` audita `retention.sweep_run` só
--      quando `vencidas + orfas > 0`, então a rodada que SÓ expurgou
--      (as duas contagens zeradas) fica sem rastro nenhum — e é a rodada em
--      que a fila perde linhas de verdade;
--   3. a metadata do `retention.sweep_run` não informa quantas linhas saíram
--      da fila, então nem a linha de rastro que existe diria o essencial.
--
-- Esta migration acrescenta `expurgadas` ao retorno (mesma assinatura, um
-- argumento) e o cron passa a somar essa contagem, a auditar quando ELA sozinha
-- teve efeito, e a publicá-la na metadata.
--
-- ## POR QUE O QUE ESTÁ AQUI, E NÃO NO CORPO DA 0434
--
-- A 0434 está aplicada (mergeada na 1.54.0) e o que está no disco é histórico
-- aplicado: editar migration aplicada é proibido pela doutrina do repo
-- (`references/pre-voo.md`, "Nunca edite migration já aplicada"). Então a
-- redefinição vem por `create or replace` numa migration nova, e no
-- `baseline.sql` o corpo é EDITADO NO LUGAR do bloco da 0434 (mesmo desenho
-- das 0417/0426/0434) — quem instala pelo kit self-host recebe o corpo novo.
--
-- ## O QUE MUDA
--
--   * `v_expurgadas` conta as linhas que o DELETE do passo 0 apagou, e a chave
--     `expurgadas` entra no jsonb de retorno. É CONTAGEM DE LINHA APAGADA, e
--     não «quantas serão»: o `delete` já happened quando a função retorna, o
--     que é o que permite ao cron decidir se a rodada teve efeito.
--   * A CONTAGEM É DA CHAMADA, não da rodada: quem decide o fim da rodada é
--     o laço de tandas do cron, e ele soma. A chave é cumulativa como
--     `vencidas`/`orfas` já eram.
--   * Nada mais mexe: a janela de 90 dias, o filtro (`status = 'deleted'`,
--     `request_id is null`, `coalesce(processed_at, enqueued_at)`), a ordem
--     dos passos e as demais podas são os mesmos da 0434. `failed`, `skipped`
--     e a linha de pedido LGPD continuam de fora, cada uma pelo motivo escrito
--     no cabeçalho da 0434.
--
-- Mesma assinatura (um argumento): um segundo parâmetro por `create or
-- replace` nasceria um SOBRECARGA esquecida fora do `revoke`/`grant` que vem
-- depois. O par revoke/grant é repetido para o arquivo ficar autocontido.
--
-- Sem coluna, sem constraint, sem índice e sem dado reescrito: a contagem é de
-- linhas que o DELETE do passo 0 já apagava.
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
  -- O que o expurgo apagou NESTA chamada (#1765). Começa em 0 para que a
  -- rodada sem nada a expurgar devolva 0 — e não null, que o cron somaria
  -- como se fosse apagado.
  v_expurgadas integer := 0;
  -- Janela do expurgo, em UM lugar só: é a constante que se muda amanhã.
  v_janela_deleted interval := interval '90 days';
begin
  -- 0. EXPURGO: a linha `deleted` da RETENÇÃO já cumpriu o papel (o arquivo
  --    saiu do bucket) e nada mais precisa dela — sem isto a fila cresce sem
  --    teto (#1739, item 2). Só `deleted`: `skipped` é «o objeto já não
  --    existe», `failed` é a prova de uma remoção que nunca passou das 3
  --    tentativas, e a issue manda não mexer em nenhuma das duas.
  --    E só a de retenção (`request_id is null`): a linha de pedido LGPD é o
  --    ÚNICO registro por objeto de que a mídia do titular saiu do bucket — o
  --    worker só troca o `status` e nada audita a remoção física. Ela sai
  --    sozinha se o pedido for apagado (FK `on delete set null`).
  --    O `GET DIAGNOSTICS` conta o que o DELETE apagou NESTA chamada (#1765):
  --    sem ele a rodada que só expurgou é indistinguível, na trilha, da rodada
  --    que não tinha o que fazer.
  delete from public.storage_redaction_queue
   where status = 'deleted'
     and request_id is null
     and coalesce(processed_at, enqueued_at) < now() - v_janela_deleted;
  get diagnostics v_expurgadas = row_count;

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

  return jsonb_build_object('vencidas', v_vencidas, 'orfas', v_orfas, 'expurgadas', v_expurgadas);
end;
$$;

revoke execute on function public.fn_enfileirar_midia_vencida(integer) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_midia_vencida(integer) to service_role;
