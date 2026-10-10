-- 0071_crm_lead_activities_barramento
-- CRM Vivo · Wave 3, bloco 1 (CORE 2 — schema do barramento). SÓ SCHEMA:
-- emissores e UI vêm no bloco seguinte, para um poder ser reprovado sem
-- derrubar o outro.
--
-- crm_lead_activities deixa de ser um log de módulo e vira o barramento único
-- da vida do lead: quem agiu (`actor_kind`/`actor_agent_id`), por que
-- (`reason`) e com base em quê (`evidence`).
--
-- FRONTEIRA DIRC — fixada aqui porque em três meses o run_id estaria nos dois:
--   * `source_module`/`source_id` = O QUE ORIGINOU a atividade. É UM ponteiro,
--     sempre um, e identifica a linha que gerou este registro.
--   * `evidence`  = O QUE SUSTENTA o que a atividade afirma. São N referências
--     (run_ids, trace_ids), no formato de flywheel_distiller_proposals.evidence.
--   * `evidence` NUNCA repete o `source_id`. Origem não é prova.
--
-- Idempotente, portável em psql puro (sem BEGIN/COMMIT, sem temp tables).

-- ---------------------------------------------------------------------------
-- A. Colunas do barramento
-- ---------------------------------------------------------------------------

-- 'contact' é a PESSOA do outro lado — não 'lead': deste lado da casa lead é o
-- NEGÓCIO (crm_leads), então 'lead' diria "o negócio falou". Também não
-- adotamos 'agent'/'human' de agent_case_events: aqui 'agent' já é papel humano
-- de RBAC (viewer < agent < manager < admin) e colidiria.
alter table public.crm_lead_activities
  add column if not exists actor_kind text
  check (actor_kind in ('user','ai','system','rule','contact'));

alter table public.crm_lead_activities
  add column if not exists actor_agent_id uuid
  references public.ai_agents(id) on delete set null;

-- O PORQUÊ em texto legível por humano — é o que a timeline mostra embaixo da
-- linha, e o que torna a decisão da IA discutível em vez de mágica.
alter table public.crm_lead_activities
  add column if not exists reason text;

-- O LASTRO: {"run_ids": [...], "trace_ids": [...]} — mesmo formato de
-- flywheel_distiller_proposals.evidence.
alter table public.crm_lead_activities
  add column if not exists evidence jsonb;

comment on column public.crm_lead_activities.actor_kind is
  'Quem agiu: user (humano do time) | ai (agente) | system (o produto) | rule (automação) | contact (a pessoa atendida). NUNCA "lead": lead aqui é o negócio.';
comment on column public.crm_lead_activities.evidence is
  'O que SUSTENTA a atividade: {"run_ids":[],"trace_ids":[]} (N referências). Não confundir com source_module/source_id, que é O QUE ORIGINOU (um ponteiro). evidence nunca repete o source_id — origem não é prova.';
comment on column public.crm_lead_activities.reason is
  'Por que esta atividade existe, em texto legível. Sem PII: é exibido na timeline e exportado no LGPD.';

-- ---------------------------------------------------------------------------
-- B. Backfill A PARTIR DO JSONB — antes de qualquer default e antes da
--    constraint (doutrina de migrations §8).
--
--    actor_kind e reason JÁ são gravados hoje dentro de metadata
--    (lib/ai/handoff/orchestrator.ts). Backfillar tudo como 'system' apagaria
--    informação que já existe — seria perda de dado disfarçada de migration.
-- ---------------------------------------------------------------------------

-- ORDEM IMPORTA: o lastro sobe ANTES do ator. Promover para 'ai' e degradar
-- depois funciona na primeira aplicação (a constraint ainda não existe) e
-- QUEBRA no update.sh de um clone, onde ela já existe e recusa a linha no ato.
-- Aqui nenhum estado intermediário inválido chega a existir.

-- 1. Lastro que já existe em metadata sobe para a coluna (nunca inventado).
update public.crm_lead_activities
   set evidence = jsonb_strip_nulls(
         jsonb_build_object(
           'run_ids',   metadata->'run_ids',
           'trace_ids', metadata->'trace_ids'
         ))
 where evidence is null
   and (jsonb_typeof(metadata->'run_ids') = 'array'
     or jsonb_typeof(metadata->'trace_ids') = 'array');

-- 2. Atores que não são a IA: promoção direta.
update public.crm_lead_activities
   set actor_kind = metadata->>'actor_kind'
 where actor_kind is null
   and metadata->>'actor_kind' in ('user','system','rule','contact');

-- 3. 'ai' só quando há execução que sustente a afirmação.
update public.crm_lead_activities
   set actor_kind = 'ai'
 where actor_kind is null
   and metadata->>'actor_kind' = 'ai'
   and (coalesce(jsonb_array_length(evidence->'run_ids'), 0) > 0
     or coalesce(jsonb_array_length(evidence->'trace_ids'), 0) > 0);

-- 4. 'ai' sem lastro nenhum vira 'system': o registro continua inteiro (o
--    reason é preservado); o que se recusa a afirmar é a AUTORIA da IA, porque
--    não há execução que a sustente.
update public.crm_lead_activities
   set actor_kind = 'system'
 where actor_kind is null
   and metadata->>'actor_kind' = 'ai';

update public.crm_lead_activities
   set reason = metadata->>'reason'
 where reason is null
   and nullif(metadata->>'reason', '') is not null;

-- 5. Quem tem autor humano registrado é 'user' — o dado está na coluna, só não
--    estava nomeado.
update public.crm_lead_activities
   set actor_kind = 'user'
 where actor_kind is null
   and performed_by_user_id is not null;

-- 6. Cura de banco onde a constraint ainda não existia e uma linha 'ai' entrou
--    sem lastro (não alcançável depois que a constraint existe — por isso vem
--    por último e é no-op no caminho feliz).
update public.crm_lead_activities
   set actor_kind = 'system'
 where actor_kind = 'ai'
   and coalesce(jsonb_array_length(evidence->'run_ids'), 0) = 0
   and coalesce(jsonb_array_length(evidence->'trace_ids'), 0) = 0;

-- ---------------------------------------------------------------------------
-- C. Constraint de lastro (drop+add — re-aplicável)
--
--    A doutrina do CORE 3 ("número sem porquê não é gravado") aplicada uma wave
--    antes: se a IA afirma algo na timeline, existe run_id ou trace_id que
--    sustente. `jsonb_array_length(...) > 0`, NÃO `evidence ? 'run_ids'` — a
--    segunda passa com array VAZIO, e lastro vazio não sustenta nada.
-- ---------------------------------------------------------------------------

alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_ai_needs_evidence;
alter table public.crm_lead_activities
  add constraint crm_lead_activities_ai_needs_evidence check (
    actor_kind <> 'ai'
    or coalesce(jsonb_array_length(evidence->'run_ids'), 0) > 0
    or coalesce(jsonb_array_length(evidence->'trace_ids'), 0) > 0
  );

-- Timeline por ator (o dossiê filtra "só o que a IA fez"), parcial porque a
-- maioria das linhas não é de agente.
create index if not exists idx_lead_activities_org_actor_agent
  on public.crm_lead_activities (organization_id, actor_agent_id, performed_at desc)
  where actor_agent_id is not null;

-- ---------------------------------------------------------------------------
-- D. stage_changed_at — de carona, porque esta wave passa a emitir atividade na
--    mudança de estágio. Sem a coluna, "3d em Negociação" no card continua
--    medindo tempo SEM RESPOSTA (last_activity_at) e mente sobre o estágio.
--    Trigger puro: carimba a coluna, sem HTTP (doutrina — trigger nunca faz rede).
-- ---------------------------------------------------------------------------

alter table public.crm_leads
  add column if not exists stage_changed_at timestamptz;

-- Bancos existentes: o melhor palito honesto é a criação do lead — nunca
-- inventar uma data de entrada no estágio que ninguém registrou.
update public.crm_leads
   set stage_changed_at = created_at
 where stage_changed_at is null;

alter table public.crm_leads
  alter column stage_changed_at set default now();

create or replace function public.fn_stamp_stage_changed_at() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
  elsif new.stage_id is distinct from old.stage_id then
    new.stage_changed_at := now();
  end if;
  return new;
end$$;

drop trigger if exists trg_stamp_stage_changed_at on public.crm_leads;
create trigger trg_stamp_stage_changed_at
  before insert or update on public.crm_leads
  for each row execute function public.fn_stamp_stage_changed_at();

comment on column public.crm_leads.stage_changed_at is
  'Quando o lead entrou no estágio atual. Carimbado por trigger. É o relógio de "tempo no estágio" do card — distinto de last_activity_at, que é "tempo sem resposta".';

-- ---------------------------------------------------------------------------
-- E. Realtime — o dossiê assina a timeline filtrada por lead_id (§3.5). O board
--    NÃO assina esta tabela: ele já escuta crm_leads por pipeline_id, e o
--    trigger fn_update_last_activity_at faz toda atividade tocar o lead.
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime' and schemaname='public' and tablename='crm_lead_activities'
  ) then
    alter publication supabase_realtime add table public.crm_lead_activities;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- F. LGPD — a coluna nova entra no cascade de anonimização NO MESMO ARQUIVO que
--    a cria. Separar é como a regra de apagamento nunca acontece: ninguém audita
--    coluna de justificativa procurando dado pessoal, então o vazamento nasceria
--    invisível — dentro da entrega que existe para tornar as coisas visíveis.
--
--    Corpo IDÊNTICO ao vigente (extraído do baseline, não redigitado) + `reason`
--    no UPDATE que já existia. Mesmo cuidado da fn_emit_event_on_lead_change na
--    0070: reescrever função à mão é como se perde comportamento em silêncio.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  -- Collect media storage paths (we only delete what we own — media_storage_path)
  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    -- email_normalized NÃO entra: é GENERATED ALWAYS AS (lower(trim(email)))
    -- e o Postgres recusa escrita nela — a linha acima já a zera por derivação.
    -- Com a atribuição, o cascade INTEIRO abortava e nada era anonimizado.
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  --    `reason` é texto livre escrito por LLM sobre a conversa do lead: supor que
  --    nunca conterá um nome é a suposição que falha. `evidence` NÃO é limpa —
  --    guarda só ids (run_ids/trace_ids), e as linhas apontadas são redigidas por
  --    conta própria; âncora sem alvo não vira link, e isso não é erro.
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;
