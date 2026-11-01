-- manifest: crm_lead_attachments (anexos do campo personalizado `file` do negócio, #3229 de @kaiow2018-cmd): tabela com RLS por organização, e a poda de mídia (fn_enfileirar_midia_vencida, passo 2b) passa a segurar o anexo vivo e a enfileirar o órfão de negócio apagado

-- Anexo de um campo `file` do negócio. Um arquivo por linha; o binário mora no
-- bucket privado `internal-media`, sob `{org}/leads/{lead}/{campo}/{id}.{ext}`,
-- e a URL é assinada sob demanda pela rota de mídia (nada de link salvo aqui).
-- `lead_id` em cascata: o negócio apagado leva as linhas, e o arquivo que sobra
-- vira órfão para a `fn_enfileirar_midia_vencida` (passo 2b, logo abaixo).
create table if not exists public.crm_lead_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  field_key text not null,
  file_name text not null,
  file_size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  storage_path text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_lead_attachments_org_lead_idx
  on public.crm_lead_attachments(organization_id, lead_id);

create index if not exists crm_lead_attachments_lead_field_idx
  on public.crm_lead_attachments(lead_id, field_key);

-- Índice do `not exists` do passo 2b: a varredura de órfãos pergunta por caminho.
create index if not exists crm_lead_attachments_storage_path_idx
  on public.crm_lead_attachments(storage_path);

alter table public.crm_lead_attachments enable row level security;

-- O caminho do arquivo fica preso à organização, ao negócio e ao campo da
-- PRÓPRIA linha. As rotas de mídia e de remoção falam com o Storage pelo
-- cliente admin, então é o banco que garante que a linha só aponta para o que
-- é dela — vale para qualquer escritor, inclusive o `service_role`. O nome do
-- arquivo é um segmento só (sem barra e sem começar por ponto), e a chave do
-- campo segue a régua do funil (`customFieldSchema.key`). O `case` fixa a
-- ordem: a chave é conferida antes de entrar na expressão regular.
-- Bloco DO: o `update.sh` roda sem ON_ERROR_STOP, e um `drop` solto seguido de
-- um `add` que falhasse deixaria a tabela sem a guarda. A linha que não cabe
-- na régua só pode ter vindo de escrita direta (a rota nunca a produziu, e a
-- tabela não saiu em versão nenhuma): sai antes da restrição entrar.
do $$
begin
  delete from public.crm_lead_attachments
   where not (case
     when field_key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
       then storage_path ~ ('^' || organization_id::text || '/leads/' || lead_id::text || '/'
                            || field_key || '/[A-Za-z0-9_-][A-Za-z0-9._-]*$')
     else false
   end);
  alter table public.crm_lead_attachments
    drop constraint if exists crm_lead_attachments_storage_path_check;
  alter table public.crm_lead_attachments
    add constraint crm_lead_attachments_storage_path_check check (case
      when field_key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
        then storage_path ~ ('^' || organization_id::text || '/leads/' || lead_id::text || '/'
                             || field_key || '/[A-Za-z0-9_-][A-Za-z0-9._-]*$')
      else false
    end);
end $$;

-- Depois de gravado, o caminho não muda (nenhuma rota o altera).
create or replace function public.fn_crm_lead_attachments_caminho_imutavel()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.storage_path is distinct from old.storage_path then
    raise exception 'crm_lead_attachments.storage_path não muda depois de gravado'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_attachments_caminho_imutavel() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_attachments_caminho_imutavel on public.crm_lead_attachments;
create trigger trg_crm_lead_attachments_caminho_imutavel
  before update on public.crm_lead_attachments
  for each row execute function public.fn_crm_lead_attachments_caminho_imutavel();

-- Policies: `drop` de TODOS os nomes que esta tabela já teve (o head original
-- do PR e a primeira versão desta migration) antes de criar as atuais —
-- policies permissivas somam (OR), e uma antiga esquecida reabriria o que as
-- novas fecham. `drop` + `create` com o MESMO nome: o `update.sh` reaplica
-- este arquivo sem ON_ERROR_STOP.
-- Leitura e escrita amarradas à visibilidade do NEGÓCIO pai: o `exists` em
-- `crm_leads` roda sob a RLS dela, então quem não enxerga o negócio (escopo
-- "só os seus") não enxerga nem mexe nos anexos dele. Escrita: `agent` para
-- cima também na RLS — as rotas já exigem `agent`, e um `viewer` falando
-- direto com o PostgREST não pode anexar nem apagar.
drop policy if exists tenant_isolation_crm_lead_attachments_all on public.crm_lead_attachments;
drop policy if exists crm_lead_attachments_tenant_isolate on public.crm_lead_attachments;
drop policy if exists tenant_isolation_crm_lead_attachments_select on public.crm_lead_attachments;
create policy tenant_isolation_crm_lead_attachments_select on public.crm_lead_attachments
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_attachments.lead_id
           and l.organization_id = crm_lead_attachments.organization_id
      )
  );

drop policy if exists tenant_isolation_crm_lead_attachments_write on public.crm_lead_attachments;
create policy tenant_isolation_crm_lead_attachments_write on public.crm_lead_attachments
  for all to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_attachments.lead_id
           and l.organization_id = crm_lead_attachments.organization_id
      )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_attachments.lead_id
           and l.organization_id = crm_lead_attachments.organization_id
      )
  );

-- O `alter default privileges` do baseline dá ALL a `anon` em tabela nova.
revoke all on public.crm_lead_attachments from anon;

-- A poda de mídia passa a enxergar o anexo de negócio (passo 2b). O corpo é a
-- ÚLTIMA definição da cadeia (0572, com o passo 2c da nota viva) mais só este
-- delta: `'leads'` no segundo segmento e o `not exists` em crm_lead_attachments.
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
  -- Órfãos do bucket PRÓPRIO da nota interna (0483). Contam em `v_orfas`:
  -- é a mesma categoria — arquivo sem ponteiro — e a chave de retorno não
  -- muda (o `toEqual` congelado de `poda-de-midia.test.ts` mede as três).
  v_orfas_nota integer := 0;
  -- Anexo de nota VIVO que já passou da retenção (#1887). Conta em
  -- `v_vencidas`: é a MESMA categoria — arquivo vencido por idade — e a chave
  -- congelada do retorno (0435) não muda de nome nem de número.
  v_vencidas_nota integer := 0;
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

  -- 1. VENCIDAS: arquivo de mensagem mais velho que a retenção da organização —
  --    SÓ de organização com o interruptor LIGADO (`media_retention_enforced`,
  --    0557/#1534) e que NÃO está com pedido LGPD em andamento: um pedido de
  --    acesso/eliminação em curso (`lgpd_requests` em `received`/`processing`)
  --    não pode ter o objeto destruído no meio do atendimento — a suspensão é
  --    da ORGANIZAÇÃO INTEIRA, o lado conservador de um prazo legal. O índice
  --    `lgpd_requests_org_status_idx` (organization_id, status) cobre a
  --    anti-join. A mensagem fica (texto, status, horário); o arquivo sai, a
  --    `media_url` também (a rota não busca de novo do provedor), a transcrição
  --    some junto (`media_derived_text`) e a tela mostra o aviso via
  --    `metadata.media_status='expired'`. O piso de 30 dias é o mesmo do
  --    formulário, mesmo com valor menor gravado no banco.
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


  -- 2b. ÓRFÃOS DA NOTA INTERNA (migration 0483): o passo 2 varre SÓ o bucket
  --     `whatsapp-media` (filtro `bucket_id`), então um anexo de nota nunca
  --     entraria na conta — e a nota que o atendente apagou deixaria o arquivo
  --     para sempre no `internal-media`, custo que só cresce. Mesmo desenho do
  --     passo 2, com as duas pontas certas: bucket `internal-media` e
  --     `conversation_notes.media_storage_path` como a referência que segura o
  --     caminho. Um dia de carência cobre o upload que sobe ANTES de a nota ser
  --     gravada (é a ordem do composer), como o passo 2 cobre o envio.
  --     Uma linha `pending`/`failed` em curso segura o caminho; `deleted`/
  --     `skipped` não, pelo mesmo motivo escrito no passo 2 (caminho reuso).
  --     Anexo de negócio (#3229) mora no MESMO bucket, sob `{org}/leads/...`,
  --     e quem segura o caminho é `crm_lead_attachments.storage_path`: sem o
  --     `not exists` dele o anexo vivo viraria órfão; sem o `'leads'` o arquivo
  --     do negócio apagado (a linha cai em cascata) ficaria para sempre.
  with orfaos_da_nota as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'internal-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and exists (select 1 from public.organizations g where g.id::text = split_part(o.name, '/', 1))
       and (
         split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or split_part(o.name, '/', 2) = 'leads'
       )
       and not exists (
         select 1 from public.conversation_notes n where n.media_storage_path = o.name
       )
       and not exists (
         select 1 from public.crm_lead_attachments a where a.storage_path = o.name
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

  -- 2c. RETENÇÃO POR IDADE DO ANEXO DA NOTA VIVA (#1887). Até aqui o bucket
  --     `internal-media` só era alcançado quando a nota SUMIA (passo 2b) ou
  --     sob pedido LGPD (passo 6d da 0483): uma nota que CONTINUA EXISTINDO
  --     segurava o anexo para sempre, e numa cota de 1 GB dividida com
  --     `whatsapp-media` o bucket crescia sem teto — anexos de até 50 MB
  --     (issue #1887; opção A, decisão do mantenedor no PR #2309).
  --     O anexo interno passa a seguir a MESMA regra da mídia de conversa:
  --     mesmo knob (`organizations.media_retention_days`, piso de 30 dias),
  --     MESMO interruptor (`media_retention_enforced`, 0557) e MESMA pausa
  --     enquanto a organização tem pedido LGPD em andamento — sem os dois, o
  --     anexo de nota seria a ÚNICA coisa apagada numa organização que
  --     desligou a limpeza, ou no meio de um atendimento LGPD. Mesmo desenho
  --     do passo 1 — a idade é a da NOTA, a mesma
  --     medida que a da mensagem, e o arquivo só sai DEPOIS do knob. Nota
  --     viva dentro da retenção não é tocada; é esta linha que o teste de
  --     #1887 cobra (e que reprova se a condição de idade sumir).
  --     Os três ponteiros são zerados como no passo 6d da 0483: a nota fica
  --     com o texto e sem card apontando para arquivo que já saiu do bucket.
  --     Arquivo já removido à mão não quebra a rodada: a linha entra como
  --     `pending` e o worker a fecha como `skipped`, como no passo 1.
  --     Aqui não existe o "nenhuma OUTRA mensagem usa" do passo 1: o caminho
  --     de anexo é único por upload (`note-<uuid>.<ext>`). A rota de nota só
  --     confere que o caminho é da mesma conversa, então duas notas PODEM
  --     apontar para o mesmo arquivo por chamada direta à API (pela tela não
  --     acontece); nesse caso a mais nova perde o anexo quando a mais velha
  --     vence — caso raro, aceito na decisão.
  with vencidas_da_nota as (
    select n.id, n.organization_id, n.media_storage_path as caminho
      from public.conversation_notes n
      join public.organizations o on o.id = n.organization_id
     where n.media_storage_path is not null
       and o.media_retention_enforced
       and n.created_at < now() - make_interval(days => greatest(coalesce(o.media_retention_days, 365), 30))
       and not exists (
         select 1 from public.lgpd_requests r
          where r.organization_id = n.organization_id
            and r.status in ('received', 'processing')
       )
     order by n.created_at
     limit v_lim
     for update of n skip locked
  ), fila_da_retencao as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct v.organization_id, 'internal-media', v.caminho
      from vencidas_da_nota v
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  ), limpas_da_nota as (
    update public.conversation_notes n
       set media_storage_path = null, media_mime = null, media_size_bytes = null
      from vencidas_da_nota v
     where n.id = v.id
    returning 1
  )
  select count(*) into v_vencidas_nota from limpas_da_nota;
  v_vencidas := v_vencidas + v_vencidas_nota;
  return jsonb_build_object('vencidas', v_vencidas, 'orfas', v_orfas, 'expurgadas', v_expurgadas);
end;
$$;

revoke execute on function public.fn_enfileirar_midia_vencida(integer) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_midia_vencida(integer) to service_role;
