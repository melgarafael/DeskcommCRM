-- ═══════════════════════════════════════════════════════════════════════════
-- 0281 — Conversar com o caso: onde a consulta interna da equipe à IA fica.
--
-- ─── POR QUE TABELA PRÓPRIA, e não um lugar que já existe ─────────────────
--
-- As três alternativas óbvias quebram consumidores VIVOS, e as três foram
-- medidas antes de a tabela ser escrita:
--
--   · `conversation_notes` → `lerContinuidadeHumana` (lib/escalacao/
--     continuidade.ts) lê essa tabela e `montarResumo` põe o texto, literal,
--     no prompt do agente que fala com o CLIENTE. A pergunta do atendente
--     viraria ordem para a IA — e o cliente leria a consequência.
--   · `agent_case_events` com `actor_kind='human'` → `fn_atrito_metrics` conta
--     `count(*)` como intervenções e `min(created_at)` como primeiro toque.
--     Perguntar zeraria a espera da fila sem ninguém ter decidido nada: o
--     Índice de Atrito passaria a medir LEITURA em vez de DECISÃO.
--   · `agent_cases`, qualquer coluna → `updated_at` é o "alguém encostou" do
--     cobrador de caso parado (`app/api/v1/cron/case-stale-watcher`). Escrever
--     ali calaria o vigia. Esta tabela NÃO toca `agent_cases`, e a ausência é
--     garantia e não esperança: não há trigger de `updated_at` naquela tabela.
--
-- ─── POR QUE A COLUNA DE TEXTO SE CHAMA `body` ────────────────────────────
--
-- De propósito, e não por gosto. `tests/invariants/lgpd-cascata-alcanca-quem-
-- guarda-pessoa.test.ts` só enxerga a tabela que satisfaz as DUAS condições:
-- FK para `contacts` E coluna cujo NOME case o padrão de PII
-- (`…|notes|note|body|content|title|subject…`). Uma tabela com colunas
-- `pergunta`/`resposta` nasceria INVISÍVEL ao gate — que é exatamente o ponto
-- cego que a investigação mediu. Escolher o nome que o gate lê é mais barato
-- que ensinar o gate a ler outro nome. `contact_id` existe pela mesma razão.
--
-- ─── O QUE ESTA MIGRATION FAZ ─────────────────────────────────────────────
--
--   1. cria `public.agent_case_chat_messages` — uma linha por MENSAGEM, com
--      `turn_id` agrupando pergunta e resposta;
--   2. liga a RLS de LEITURA em três condições (organização + papel `agent` +
--      visibilidade da conversa) e deixa a tabela SERVER-ONLY na escrita;
--   3. cria `fn_expurgar_conversa_do_caso_vencida` (365 dias, piso de 90 no
--      CORPO), que o cron diário de retenção passa a chamar;
--   4. redefine `fn_lgpd_cascade_redact_contact` com UM passo novo, derivado
--      do corpo VIGENTE (a definição de maior número de linha no
--      `supabase/baseline.sql`, copiada por script — o corpo anterior fica
--      byte a byte igual).
--
-- ─── REAPLICAÇÃO ──────────────────────────────────────────────────────────
--
-- `create table if not exists`, `create index if not exists`, `drop policy if
-- exists` + `create policy`, `create or replace function`. O `update.sh` de um
-- clone reaplica sem erro e sem duplicar efeito.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.agent_case_chat_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  case_id          uuid not null references public.agent_cases(id)   on delete cascade,
  -- DUAS COLUNAS DENORMALIZADAS DE PROPÓSITO (doutrina DIRC: Duplicar, não
  -- Referenciar):
  --  · `conversation_id`: a policy de SELECT precisa da conversa SEM passar
  --    por `agent_cases`, cuja policy é org-wide e reintroduziria exatamente o
  --    vazamento que esta feature fecha;
  --  · `contact_id`: é a FK que põe a tabela no escopo do invariante de LGPD e
  --    o filtro que a redação e o export usam. Sem ela, anonimizar devolveria
  --    sucesso com a conversa legível, e nenhum gate acusaria.
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  contact_id       uuid not null references public.contacts(id)      on delete cascade,
  -- Agrupa pergunta + resposta. GERADO NO CLIENTE: é ele que dá a idempotência
  -- sem copiar a resposta para `idempotency_keys` (ver a unique lá embaixo).
  turn_id          uuid not null,
  author_kind      text not null check (author_kind in ('human','ai')),
  -- `on delete set null`: a saída de uma pessoa do sistema não apaga o que ela
  -- perguntou. Por isso NÃO existe check acoplando `author_kind` a
  -- `author_user_id` — ele quebraria o próprio `set null`.
  author_user_id   uuid references auth.users(id) on delete set null,
  -- null quando a resposta falhou, ou quando a redação de LGPD passou por aqui.
  body             text,
  -- null = deu certo. NÃO existe coluna `status`: ela seria a segunda
  -- representação do mesmo fato (anti-pattern 2 do CLAUDE.md).
  error_code       text,
  -- Quem RESPONDEU de fato. null = respondeu a persona padrão da organização
  -- (agente do caso ausente, arquivado, pausado ou despublicado). A persona "de
  -- agora" é recalculada a cada requisição; esta coluna é o registro histórico.
  agent_id         uuid references public.ai_agents(id)  on delete set null,
  llm_call_id      uuid references public.llm_calls(id)  on delete set null,
  -- O atendimento que originou o caso já tinha mudado quando esta resposta foi
  -- dada. Mesmo vocabulário do audit da rota de resposta ao caso.
  service_stale    boolean not null default false,
  redacted_at      timestamptz,
  created_at       timestamptz not null default now(),
  -- A IDEMPOTÊNCIA DO POST, no banco e NÃO em `idempotency_keys`: o helper
  -- `comIdempotencia` grava `response_body` (lib/api/idempotency.ts), que seria
  -- uma cópia da resposta sobre a pessoa numa tabela FORA da cascata de LGPD e
  -- SEM expurgo nenhum (`grep -rn "idempotency_keys" app/api/v1/cron lib/retencao
  -- lib/lgpd` → vazio). Esta unique resolve o clique duplo E a corrida que o
  -- próprio helper declara não cobrir.
  constraint agent_case_chat_messages_turno_unico
    unique (organization_id, case_id, turn_id, author_kind)
);

-- Auto-cura para o clone que já tenha uma versão ANTERIOR da tabela: o
-- `create table if not exists` acima é no-op ali. Só as colunas que podem ser
-- acrescentadas a uma tabela COM LINHAS entram — as `not null` sem default não
-- podem, e não precisam: a tabela nasce aqui, então nenhum clone tem uma forma
-- anterior dela sem elas.
alter table public.agent_case_chat_messages add column if not exists author_user_id uuid;
alter table public.agent_case_chat_messages add column if not exists body text;
alter table public.agent_case_chat_messages add column if not exists error_code text;
alter table public.agent_case_chat_messages add column if not exists agent_id uuid;
alter table public.agent_case_chat_messages add column if not exists llm_call_id uuid;
alter table public.agent_case_chat_messages add column if not exists service_stale boolean not null default false;
alter table public.agent_case_chat_messages add column if not exists redacted_at timestamptz;

-- O CHECK e a unique em bloco próprio, para o clone que tenha a tabela sem
-- eles. `drop` + `add` é auto-curativo; a tabela nasce vazia, então não há dado
-- a corrigir antes (a regra 8 da doutrina de migrations).
alter table public.agent_case_chat_messages
  drop constraint if exists agent_case_chat_messages_author_kind_check;
alter table public.agent_case_chat_messages
  add constraint agent_case_chat_messages_author_kind_check
  check (author_kind in ('human','ai'));

alter table public.agent_case_chat_messages
  drop constraint if exists agent_case_chat_messages_turno_unico;
alter table public.agent_case_chat_messages
  add constraint agent_case_chat_messages_turno_unico
  unique (organization_id, case_id, turn_id, author_kind);

-- Três índices, um propósito cada, e nenhum é prefixo de outro (a memória da
-- 0259: índice redundante sai).
create index if not exists agent_case_chat_messages_case_idx
  on public.agent_case_chat_messages (organization_id, case_id, created_at);
-- Redação e export só procuram o que ainda é legível.
create index if not exists agent_case_chat_messages_contact_idx
  on public.agent_case_chat_messages (organization_id, contact_id)
  where redacted_at is null;
-- O expurgo ordena por `created_at`.
create index if not exists agent_case_chat_messages_purga_idx
  on public.agent_case_chat_messages (created_at);

alter table public.agent_case_chat_messages enable row level security;

-- ── Privilégio: leitura pelo login, escrita SÓ pelo servidor ───────────────
-- `revoke all` PRIMEIRO porque o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
-- TABLES TO "authenticated"` do baseline vem ANTES de toda tabela de apêndice:
-- sem o revoke, a tabela nasce com INSERT/UPDATE/DELETE para `authenticated` e
-- a policy seria a única coisa entre um `viewer` e a escrita. Mesmo desenho de
-- `ai_reply_drafts` (0227) e das três tabelas da 0279.
revoke all    on public.agent_case_chat_messages from anon, authenticated;
grant  select on public.agent_case_chat_messages to authenticated;
grant  all    on public.agent_case_chat_messages to service_role;

-- ── RLS: organização + papel + VISIBILIDADE DA CONVERSA ───────────────────
-- A terceira condição é a razão de a tabela carregar `conversation_id` dentro.
-- `fn_can_view_conversation` restringe SÓ o papel `agent`: viewer/manager/admin
-- leem tudo por desenho, que é a decisão do dono do produto. Policy POR COMANDO
-- (`for select`), nunca `for all` — e aqui nem se trata disso: não existe
-- caminho de escrita pelo PostgREST, porque o `revoke` acima o fechou.
drop policy if exists tenant_isolation_agent_case_chat_messages_select on public.agent_case_chat_messages;
create policy tenant_isolation_agent_case_chat_messages_select
  on public.agent_case_chat_messages
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1
        from public.conversations c
       where c.organization_id = agent_case_chat_messages.organization_id
         and c.id = agent_case_chat_messages.conversation_id
         and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- ── Retenção: a tabela nasce com dono de piso ─────────────────────────────
create or replace function public.fn_expurgar_conversa_do_caso_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 365 = um ano fiscal: depois disso, "por que decidimos assim" é respondido
  -- pelos EVENTOS do caso, não pela deliberação que os precedeu. O piso de 90
  -- impede que o knob vire apagador de rastro recente — o mesmo piso da
  -- auditoria, e pela mesma razão. O piso mora AQUI, no corpo, porque só assim
  -- ele vale para QUALQUER chamador, inclusive um `psql` na mão.
  v_dias int := greatest(coalesce(p_retencao_dias, 365), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select m.id from public.agent_case_chat_messages m
     where m.created_at < now() - make_interval(days => v_dias)
     order by m.created_at
     limit v_limite
  )
  delete from public.agent_case_chat_messages m using vencidas v where m.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
-- As DUAS origens de EXECUTE: o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
-- FUNCTIONS TO anon` do baseline (que `revoke from public` não remove) e o
-- grant implícito a PUBLIC que o Postgres dá a toda função ao criá-la (que
-- `revoke from anon` não remove). Fechar uma só deixa a função exposta com o
-- gate verde.
revoke all    on function public.fn_expurgar_conversa_do_caso_vencida(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_conversa_do_caso_vencida(int,int) to service_role;

-- ── A cascata de LGPD alcança a conversa do caso ──────────────────────────
-- Derivada do corpo VIGENTE do baseline (a definição de maior número de linha),
-- por script, nunca redigitada: o corpo anterior fica byte a byte igual e o
-- único acréscimo é o passo de `agent_case_chat_messages`. O Postgres troca o
-- corpo INTEIRO num `create or replace` — quem derivar da versão errada apaga
-- o passo de outra entrega sem um único erro. A catraca que vigia isso é
-- `tests/invariants/cascata-lgpd-nao-encolhe.test.ts`.
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
  perform public.fn_service_lock(p_organization_id,p_contact_id);
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
  --    guarda só ids, e as linhas apontadas são redigidas por conta própria.
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

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  --
  -- `peer_phone` é `not null` e guarda o número da outra ponta: depois de
  -- anonimizar o contato, ele sobrevivia ligado ao `contact_id` e reidentificava
  -- a pessoa que pediu para ser esquecida. É o mesmo argumento que a foto de
  -- perfil já tinha (ver o bloco do avatar em `lib/lgpd/redact-cascade.ts`):
  -- anonimizar em toda parte menos numa é não ter anonimizado.
  --
  -- O que fica: direção, status, motivo do fim, marcas de tempo e duração. Um
  -- registro de "houve uma chamada de 12 minutos" sem número e sem dono não
  -- identifica ninguém e é o que sustenta a métrica do atendente e a fatura.
  -- `peer_phone` é NOT NULL, então recebe o rótulo, não `null`.
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  -- agent_cases — o que a IA escreveu SOBRE a pessoa quando travou (migration 0280).
  --
  -- O caso é o texto que a equipe lê antes de decidir: `title`, `summary` e
  -- `blocker` saem do modelo a partir da conversa, e `context_snapshot` é o
  -- recorte dessa conversa que o motor mandou para ele. Nada disso é registro de
  -- operação — é o relato do problema de uma pessoa identificável, escrito por
  -- máquina. Sem este passo, anonimizar devolvia SUCESSO com o relato intacto.
  --
  -- As três colunas de texto são `not null`: recebem rótulo e texto fixo, nunca
  -- `null` (a mesma razão de `voice_calls.peer_phone` logo acima).
  --
  -- ⚠️ `updated_at` FICA FORA DO `set`, de propósito. O cobrador de caso parado
  -- (`app/api/v1/cron/case-stale-watcher/route.ts`) lê `updated_at` como "alguém
  -- da equipe encostou neste caso". A cascata não é alguém encostando: escrever
  -- ali faria a anonimização ADIAR a cobrança de um caso que continua parado, e
  -- o efeito só apareceria como um cliente esperando mais tempo.
  --
  -- O vínculo é pela CONVERSA porque `agent_cases` não tem FK para `contacts`.
  update agent_cases set
    title = v_anon_label,
    summary = '[resumo anonimizado]',
    blocker = '[bloqueio anonimizado]',
    context_snapshot = '{}'::jsonb
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  -- agent_case_events — a linha do tempo do caso (migration 0280).
  --
  -- `body` é o que a pessoa da equipe escreveu ao responder o caso e o que o
  -- agente registrou sobre o que o LEAD respondeu; `metadata` carrega o recorte
  -- que o motor anexou. `kind`, `actor_kind`, `human_action` e `created_at`
  -- FICAM: são o registro de que houve um toque humano e quando — operação, não
  -- dado da pessoa, e é deles que sai a métrica de atendimento.
  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- demandas — o assunto do pedido (migration 0280).
  --
  -- `assunto` é texto livre sobre o que a pessoa pediu. O resto da linha é a
  -- operação da demanda (origem, estado, dono, prazo, desfecho) e fica de pé:
  -- apagar a linha inteira tiraria da organização a resposta a "quantos pedidos
  -- houve em março", que é o mesmo argumento do compromisso da agenda.
  --
  -- FK direta (`demandas.contact_id` é `not null`), então o vínculo é o contato.
  update demandas set
    assunto = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- agent_inbox_items — o aviso que leva o texto do caso para a Central (migration 0280).
  --
  -- O `body` do aviso de caso parado EMBUTE o título do caso
  -- (`app/api/v1/cron/case-stale-watcher/route.ts:128`), e o do handoff embute o
  -- motivo da parada (`lib/ai/handoff/orchestrator.ts:335`). Redigir o caso e
  -- deixar o aviso de pé seria anonimizar em toda parte menos numa — que é não
  -- ter anonimizado. O molde (resolver + trocar o corpo + soltar a referência) é
  -- o de `fn_meet_redact_contact`, que já faz isto para o aviso de compromisso.
  --
  -- ⚠️ O VÍNCULO É POLIMÓRFICO E TEM TRÊS BRAÇOS, não dois. Medido nos
  -- produtores, não suposto: `handoff` nasce com `ref_kind='contact'`
  -- (`lib/ai/handoff/orchestrator.ts:339`) E com `ref_kind='conversation'`
  -- (`lib/agent-engine/agent/inbound-turn.ts:4100`); `case_stale` nasce SEMPRE
  -- com `ref_kind='agent_case'` (a rota do cron acima, e a política em
  -- `lib/ai/inbox-destino.ts:38`). Um predicado com só os dois primeiros braços
  -- casa ZERO avisos de caso parado — e casar zero linha não é erro: é sucesso
  -- com o texto intacto.
  --
  -- Os `kind` são os MEDIDOS no CHECK vigente (`supabase/baseline.sql`, bloco
  -- único de `agent_inbox_items_kind_check`). `case_opened` NÃO existe, e kind
  -- inexistente num `in (...)` também casa zero e devolve sucesso. Para
  -- reconferir sem acreditar nesta prosa:
  --   grep -n "agent_inbox_items_kind_check check" -A40 supabase/baseline.sql
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = now(),
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    and kind in ('handoff', 'case_stale')
    and (
      (ref_kind = 'contact' and ref_id = p_contact_id)
      or (ref_kind = 'conversation' and ref_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          ))
      or (ref_kind = 'agent_case' and ref_id in (
            select id from agent_cases
              where organization_id = p_organization_id
                and conversation_id in (
                  select id from conversations
                    where contact_id = p_contact_id and organization_id = p_organization_id
                )
          ))
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_inbox_items', v_count);

  -- agent_case_chat_messages — a consulta interna da equipe à IA SOBRE o caso
  -- (migration 0281). FK DIRETA para `contacts`, então o vínculo é o titular e
  -- não precisa passar pela conversa.
  --
  -- `redacted_at is null` no `where` é o que torna o passo IDEMPOTENTE: a
  -- varredura diária de redações incompletas roda a função de novo, e sem essa
  -- condição o carimbo de QUANDO se apagou seria reescrito a cada rodada.
  --
  -- A linha NÃO é apagada, só o texto: quem abrir o caso depois continua vendo
  -- que a equipe perguntou N vezes, quando, e se a IA respondeu. Apagar a linha
  -- inteira ficaria verde num teste de "o texto sumiu" e tiraria da organização
  -- a resposta a "quanto a equipe deliberou sobre este caso".
  update agent_case_chat_messages set
    body = null,
    redacted_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and redacted_at is null;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_chat_messages', v_count);

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
revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

-- ── travas do suporte, depois de toda tabela nova (migration 0274) ─────────
-- `agent_case_chat_messages` nasce SERVER-ONLY (revoke de anon/authenticated +
-- grant select), então o ramo server-only da função lhe dá ZERO policies
-- `support_write_*` — que é o contrato mais restritivo. Escrever `drop policy`
-- à mão aqui seria a segunda representação da mesma regra.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
