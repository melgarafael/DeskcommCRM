-- ═══════════════════════════════════════════════════════════════════════════
-- 0291 — A passagem do atendimento para uma pessoa vira um FATO com registro.
--
-- ─── O que se perdia, e onde ──────────────────────────────────────────────
--
-- Existem dois motores que tiram a conversa do automático: `performHumanHandoff`
-- (`lib/agent-engine`, `pg.Pool`) e `triggerHandoff` (`lib/ai/handoff`,
-- supabase-js). O primeiro monta um resumo do checkpoint e o enfia no corpo do
-- aviso da Central; o segundo abre o aviso SEM resumo nenhum. Em nenhum dos dois
-- sobrevive o que a pessoa que assume precisa: POR QUE a IA passou, o que ela já
-- tentou, o que o cliente pediu com as palavras dele, e se ele chegou a ser
-- avisado de que alguém vai responder.
--
-- O resultado, medido em conversa real: quem assume relê a conversa inteira e
-- repete as perguntas que a IA já fez. O cliente responde duas vezes. É esse o
-- laço de retorno desta entrega — se o briefing chegou, a repetição cai; se não
-- chegou, ela não muda e a feature é decoração.
--
-- ─── POR QUE TABELA PRÓPRIA, e não um veículo que já existe ───────────────
--
-- `crm_lead_activities.reason` é o candidato óbvio (a transferência manual já o
-- usa), e as três razões de ele não servir foram medidas antes:
--
--   1. a coluna é declarada "O PORQUÊ, legível por humano. Sem PII" em
--      `lib/leads/activity-emitter.ts`, e é por isso que `performHumanHandoff`
--      grava ali o texto FIXO "Atendimento passado para uma pessoa". O briefing
--      é resumo de conversa: é PII por construção;
--   2. a atividade é roteada para um NEGÓCIO ABERTO (`emitAgentActivityForContact`)
--      e sem negócio ela não nasce — passagem sem lead existiria e seria invisível;
--   3. o registro precisa de ESTADO (`reconhecido_por`/`reconhecido_em`) e de
--      estrutura (as tentativas). `crm_lead_activities` não tem onde pôr isso sem
--      virar `jsonb` lido por path, que é o anti-pattern nº 6 do CLAUDE.md.
--
-- ─── POR QUE AS COLUNAS SE CHAMAM `title`/`body`/`notes`/`content` ────────
--
-- De propósito, e não por gosto — é a mesma escolha da 0281.
-- `tests/invariants/lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` só enxerga
-- a tabela que satisfaz as DUAS condições: FK para `contacts` E coluna cujo NOME
-- case o padrão de PII (`…|notes|note|body|content|title|subject…`). Uma tabela
-- com `resumo`/`motivo_texto`/`cliente_quer` — que foi o desenho anterior —
-- nasceria INVISÍVEL ao gate, e a cobertura dependeria de alguém lembrar de um
-- invariante comportamental que uma sessão futura pode apagar com o gate de
-- classe verde. Escolher o nome que o instrumento lê é mais barato que ensinar o
-- instrumento a ler outro nome.
--
-- ─── DOUTRINA DIRC, respondida ────────────────────────────────────────────
--
--   Duplicar   — não: motivo, narrativa e tentativas não existem hoje em lugar
--                nenhum (`rg -n -i "o que (já )?tentou|ja_tentou"` → vazio);
--   Integrar   — `contact_id`/`conversation_id`/`caso_id` são FK, não cópias;
--   Referenciar— `motor`/`origem`/`motivo_codigo` são vocabulário fechado;
--   Calcular   — `body` NÃO é calculável depois: ele depende do estado do turno,
--                que não sobrevive ao turno.
--
-- ─── O QUE ESTA MIGRATION FAZ ─────────────────────────────────────────────
--
--   1. cria `public.passagens_de_atendimento` — uma linha por episódio;
--   2. liga a RLS de LEITURA em três condições (organização + papel `agent` +
--      visibilidade da conversa) e deixa a tabela SERVER-ONLY na escrita;
--   3. cria `fn_expurgar_passagens_vencidas` (1825 dias, piso de 90 no CORPO),
--      que o cron diário de retenção passa a chamar — e que NUNCA apaga
--      passagem ainda não reconhecida, porque passagem aberta é demanda viva;
--   4. redefine `fn_lgpd_cascade_redact_contact` com UM passo novo e UMA coluna
--      a mais no passo 2, derivada do corpo VIGENTE (a definição de maior número
--      de linha no `supabase/baseline.sql`, copiada por script — o corpo anterior
--      fica byte a byte igual, exceto pelas duas edições declaradas).
--
-- O que esta migration NÃO faz, declarado: ninguém ESCREVE nesta tabela ainda.
-- Os 13 call sites dos dois motores, o reconhecimento automático por
-- `fn_conversation_assign` e o cartão na conversa são das ondas seguintes. Uma
-- tabela sem escritor é "evento sem consumidor" ao contrário, e a única razão de
-- ela nascer antes é que schema e call site no mesmo PR fazem o reviewer ler
-- 1.500 linhas para julgar uma decisão de modelagem.
--
-- ─── REAPLICAÇÃO ──────────────────────────────────────────────────────────
--
-- `create table if not exists`, `add column if not exists`, `drop constraint if
-- exists` + `add constraint`, `create index if not exists`, `drop policy if
-- exists` + `create policy`, `create or replace function`. O `update.sh` de um
-- clone reaplica sem erro e sem duplicar efeito. Nenhuma constraint nova sobre
-- dados existentes ⇒ não há deduplicação prévia a fazer (regra 8 da doutrina).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.passagens_de_atendimento (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- FK para `contacts`: é ela que põe a tabela no escopo do invariante de LGPD,
  -- e é o filtro que a redação e o export usam.
  contact_id       uuid not null references public.contacts(id)      on delete cascade,
  -- FK para `conversations`: a passagem é da CONVERSA (é onde a pessoa
  -- responde), e é este ponteiro que a RLS usa para herdar
  -- `fn_can_view_conversation` sem passar por nenhuma tabela org-wide.
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  -- Só quando a passagem nasceu do "Não consigo → escalar" de um caso.
  -- `set null` e NÃO `cascade`: apagar o caso não pode apagar o fato de a
  -- conversa ter ido para uma pessoa.
  caso_id          uuid references public.agent_cases(id)            on delete set null,

  -- Qual dos dois motores passou. Sem esta coluna, "o motor B parou de gravar"
  -- é indistinguível de "ninguém passou conversa nenhuma".
  motor            text not null check (motor in ('engine','crm')),
  -- POR ONDE entrou (o caminho de código), distinto de POR QUE (a razão). O
  -- mesmo `requested_human` chega por três origens, e é a origem que responde
  -- "que parte do sistema decidiu isto?".
  origem           text not null check (origem in (
                     'pedido_explicito','opt_out_provavel','ferramenta_do_modelo',
                     'teto_de_gasto','caso_escalado','sentimento','legado_pedido',
                     'legado_juridico','legado_etapa','legado_confianca','legado_teto',
                     'mcp_externo','runtime_nativo')),
  -- POR QUE saiu do automático. É o que vira FRASE na tela — o código nunca
  -- aparece para uma pessoa (`lib/escalacao/passagem.ts` → `FRASE_DO_MOTIVO`).
  motivo_codigo    text not null check (motivo_codigo in (
                     'requested_human','suspected_optout','orcamento_de_ia','low_sentiment',
                     'low_confidence','critical_stage','legal_mention','refund_mention',
                     'caso_escalado')),

  -- ─── OS QUATRO NOMES QUE O GATE DE LGPD LÊ (ver o cabeçalho) ─────────────
  --   title   ← "o que o cliente quer", em uma linha (é o título do cartão)
  --   body    ← a narrativa montada, que é o que a pessoa lê antes de responder
  --   notes   ← as últimas palavras LITERAIS do cliente (citação, não conclusão)
  --   content ← o texto livre de quem passou (o `por_que` da ferramenta, a razão
  --             humana do caso, o `reason` do MCP). Vem do modelo ou de fora: é
  --             dado NÃO confiável, e por isso é sanitizado antes do insert e
  --             exibido como citação, nunca como instrução.
  title            text,
  -- `not null` porque é o que a tela mostra: um cartão sem corpo afirma que não
  -- há contexto, quando o que houve foi a montagem não ter recebido nada. O piso
  -- mora em `lib/escalacao/briefing-da-passagem.ts` (`PISO_DO_BRIEFING`).
  body             text not null,
  notes            text,
  content          text,

  -- Estruturado, para a lista numerada do cartão. NÃO é "texto livre solto": é
  -- validado por `tentativasDaPassagemSchema` (Zod, `lib/escalacao/passagem.ts`)
  -- ANTES do insert e lido por parser tipado, nunca por path cru — o CHECK aqui
  -- garante só a forma externa, porque é o que um CHECK consegue garantir.
  tentativas       jsonb not null default '[]'::jsonb
                     check (jsonb_typeof(tentativas) = 'array'),

  -- A VERDADE sobre o aviso ao cliente. `null` = ninguém tentou avisar (o
  -- caminho acionado por uma pessoa que já está na conversa e fala por si).
  -- A distinção existe porque a promessa "o cliente JÁ foi avisado" era dita sem
  -- ninguém olhar o desfecho do envio: `sendMessageHandler` devolve `failed` sem
  -- lançar, e o caminho seguinte afirmava `avisado: true`.
  cliente_avisado      boolean,
  -- Vocabulário FECHADO, não texto livre: é a TELA que traduz. Uma frase gravada
  -- em português aqui seria a segunda representação do mesmo fato, e a primeira
  -- a ficar sem espanhol.
  aviso_motivo_codigo  text check (aviso_motivo_codigo is null or aviso_motivo_codigo in (
                         'na_fila_canal_fora','falhou_no_envio','sem_telefone',
                         'pre_go_live','canal_arquivado','fora_da_janela')),

  criado_em        timestamptz not null default now(),
  -- Quem assumiu. `reconhecido_por is null` COM `reconhecido_em` preenchido = a
  -- conversa foi devolvida ao automático (ninguém assumiu, mas o episódio
  -- fechou). Nunca o contrário — é o que a constraint abaixo garante.
  reconhecido_por  uuid references auth.users(id) on delete set null,
  reconhecido_em   timestamptz,
  constraint passagens_reconhecimento_coerente
    check (reconhecido_por is null or reconhecido_em is not null)
);

-- Auto-cura para o clone que já tenha uma versão ANTERIOR da tabela: o
-- `create table if not exists` acima é no-op ali. Só as colunas que podem ser
-- acrescentadas a uma tabela COM LINHAS entram — as `not null` sem default não
-- podem, e não precisam: a tabela nasce aqui.
alter table public.passagens_de_atendimento add column if not exists caso_id uuid;
alter table public.passagens_de_atendimento add column if not exists title text;
alter table public.passagens_de_atendimento add column if not exists notes text;
alter table public.passagens_de_atendimento add column if not exists content text;
alter table public.passagens_de_atendimento add column if not exists tentativas jsonb not null default '[]'::jsonb;
alter table public.passagens_de_atendimento add column if not exists cliente_avisado boolean;
alter table public.passagens_de_atendimento add column if not exists aviso_motivo_codigo text;
alter table public.passagens_de_atendimento add column if not exists reconhecido_por uuid;
alter table public.passagens_de_atendimento add column if not exists reconhecido_em timestamptz;

-- Os CHECK em bloco próprio, para o clone que tenha a tabela sem eles.
-- `drop` + `add` é auto-curativo E é o que garante UMA constraint por coluna: o
-- nome usado aqui é o mesmo que o Postgres dá ao CHECK inline do `create table`
-- acima, então a segunda aplicação substitui em vez de duplicar. Duas
-- constraints definindo o mesmo vocabulário fazem
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` se RECUSAR a medir —
-- e ele está certo em se recusar: escolher uma daria veredito falso sobre todos
-- os pares.
alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_motor_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_motor_check
  check (motor in ('engine','crm'));

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_origem_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_origem_check
  check (origem in (
    'pedido_explicito','opt_out_provavel','ferramenta_do_modelo',
    'teto_de_gasto','caso_escalado','sentimento','legado_pedido',
    'legado_juridico','legado_etapa','legado_confianca','legado_teto',
    'mcp_externo','runtime_nativo'));

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_motivo_codigo_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_motivo_codigo_check
  check (motivo_codigo in (
    'requested_human','suspected_optout','orcamento_de_ia','low_sentiment',
    'low_confidence','critical_stage','legal_mention','refund_mention',
    'caso_escalado'));

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_aviso_motivo_codigo_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_aviso_motivo_codigo_check
  check (aviso_motivo_codigo is null or aviso_motivo_codigo in (
    'na_fila_canal_fora','falhou_no_envio','sem_telefone',
    'pre_go_live','canal_arquivado','fora_da_janela'));

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_tentativas_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_tentativas_check
  check (jsonb_typeof(tentativas) = 'array');

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_reconhecimento_coerente;
alter table public.passagens_de_atendimento
  add constraint passagens_reconhecimento_coerente
  check (reconhecido_por is null or reconhecido_em is not null);

-- Três índices, um LEITOR DECLARADO cada. Índice sem leitor é evento sem
-- consumidor com outro nome.
--   · por conversa  → o cartão, que lista as passagens daquela conversa;
create index if not exists passagens_por_conversa
  on public.passagens_de_atendimento (organization_id, conversation_id, criado_em desc);
--   · por contato   → a redação e o export do titular (FK direta);
create index if not exists passagens_por_contato
  on public.passagens_de_atendimento (organization_id, contact_id, criado_em desc);
--   · não reconhecidas → o segundo braço do cobrador em
--     `app/api/v1/cron/case-stale-watcher` (onda seguinte) e o expurgo, que só
--     apaga linha JÁ reconhecida.
create index if not exists passagens_nao_reconhecidas
  on public.passagens_de_atendimento (organization_id, criado_em desc)
  where reconhecido_em is null;

alter table public.passagens_de_atendimento enable row level security;

-- ── Privilégio: leitura pelo login, escrita SÓ pelo servidor ───────────────
-- `revoke all` PRIMEIRO porque o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
-- TABLES TO "authenticated"` do baseline vem ANTES de toda tabela de apêndice:
-- sem o revoke, a tabela nasce com INSERT/UPDATE/DELETE para `authenticated` e a
-- policy seria a única coisa entre um `viewer` e a escrita. É exatamente o
-- defeito que a 0279 teve de consertar em três tabelas já nascidas.
--
-- E não há caminho de escrita pelo PostgREST NENHUM: quem grava é o service role
-- (os dois motores) e, na onda seguinte, o trigger definer do reconhecimento.
-- Uma passagem forjada por um membro é uma mentira com cara de registro — ela
-- diria que a IA desistiu de um atendimento que ela nunca tocou.
revoke all    on public.passagens_de_atendimento from anon, authenticated;
grant  select on public.passagens_de_atendimento to authenticated;
grant  all    on public.passagens_de_atendimento to service_role;

-- ── RLS: organização + papel + VISIBILIDADE DA CONVERSA ───────────────────
-- As três condições, e cada uma fecha uma porta diferente:
--   · `fn_user_org_ids`      — o vizinho não lê;
--   · `fn_role_at_least`     — `viewer` não lê briefing de atendimento (ele vê a
--     conversa por desenho, e o briefing diz MAIS que a conversa: diz o que a IA
--     concluiu sobre a pessoa);
--   · `fn_can_view_conversation` — numa organização em `visibility_mode='own'`,
--     um atendente não lê o briefing de um atendimento que não é dele. É o mesmo
--     predicado de `ai_reply_drafts`, e é a razão de `conversation_id` viver
--     dentro desta tabela.
drop policy if exists tenant_isolation_passagens_de_atendimento_all on public.passagens_de_atendimento;
drop policy if exists tenant_isolation_passagens_de_atendimento_select on public.passagens_de_atendimento;
create policy tenant_isolation_passagens_de_atendimento_select
  on public.passagens_de_atendimento
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (
      select 1
        from public.conversations c
       where c.organization_id = passagens_de_atendimento.organization_id
         and c.id = passagens_de_atendimento.conversation_id
         and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- ── Retenção: a tabela nasce com dono de piso ─────────────────────────────
create or replace function public.fn_expurgar_passagens_vencidas(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 1825 = os 5 anos da auditoria, e pelo mesmo motivo: a passagem é rastro de
  -- ATENDIMENTO — quem assumiu, quando, e por quê. O piso de 90 impede que o
  -- knob vire apagador de rastro recente, e mora AQUI, no corpo, porque só assim
  -- vale para QUALQUER chamador, inclusive um `psql` na mão.
  v_dias int := greatest(coalesce(p_retencao_dias, 1825), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select p.id from public.passagens_de_atendimento p
      -- ⚠️ SÓ passagem JÁ RECONHECIDA. Uma passagem aberta é demanda viva: alguém
      -- do outro lado está esperando resposta e ninguém assumiu. Apagá-la por
      -- idade seria o expurgo virando esquecedor de pendência — e o único sinal
      -- de que a pessoa ficou sem resposta some junto.
     where p.reconhecido_em is not null
       and p.criado_em < now() - make_interval(days => v_dias)
     order by p.criado_em
     limit v_limite
  )
  delete from public.passagens_de_atendimento p using vencidas v where p.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
-- As DUAS origens de EXECUTE: o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
-- FUNCTIONS TO anon` do baseline (que `revoke from public` não remove) e o grant
-- implícito a PUBLIC que o Postgres dá a toda função ao criá-la (que `revoke
-- from anon` não remove). Fechar uma só deixa a função exposta com o gate verde.
revoke all     on function public.fn_expurgar_passagens_vencidas(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_passagens_vencidas(int,int) to service_role;

-- ── A cascata de LGPD alcança a passagem ──────────────────────────────────
-- Derivada do corpo VIGENTE do baseline (a definição de maior número de linha),
-- por script, nunca redigitada: o corpo anterior fica byte a byte igual e as
-- ÚNICAS mudanças são as duas declaradas — o passo de `passagens_de_atendimento`
-- e o `last_handoff_reason = null` dentro do passo 2, que já visita as mesmas
-- linhas com o mesmo predicado. O Postgres troca o corpo INTEIRO num `create or
-- replace`; quem derivar da versão errada apaga o passo de outra entrega sem um
-- único erro. A catraca que vigia isso é
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
    -- O motivo CRU da última passagem (migration 0291). É código de
    -- vocabulário, não texto livre — mas ele diz que ESTA pessoa foi escalada
    -- por irritação, por assunto jurídico ou por suspeita de opt-out, e isso é
    -- um fato sobre ela. Entra NESTE update, e não num segundo: mesmo
    -- predicado, mesmas linhas, metade das varreduras.
    --
    -- ⚠️ `last_handoff_reason` é CHAVE DE NEGÓCIO em outro módulo: a ponte de
    -- voz limpa o silêncio filtrando pelo VALOR da coluna
    -- (`lib/wacalls/events-bridge.ts`). Zerá-la num contato anonimizado é
    -- seguro — não há chamada viva de contato anonimizado — e é a razão de
    -- esta entrega NÃO usar essa coluna para texto rico: ela continua
    -- recebendo só o código, e o texto vive em `passagens_de_atendimento`.
    last_handoff_reason = null,
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

  -- passagens_de_atendimento — o BRIEFING é sobre a pessoa (migration 0291).
  --
  -- A linha guarda o que a IA concluiu sobre um atendimento de alguém
  -- identificável: o que ela entendeu que a pessoa quer (`title`), a narrativa
  -- que quem assumiu leu (`body`), as PALAVRAS LITERAIS do cliente (`notes`), o
  -- texto livre de quem passou (`content`) e o que a IA já tinha tentado
  -- (`tentativas`). Nada disso é registro de operação — é o relato do problema
  -- de uma pessoa, escrito por máquina, na tela de quem vai responder.
  --
  -- `body` é `not null` e recebe o RÓTULO, não `null` — a mesma razão de
  -- `voice_calls.peer_phone` e de `agent_cases.title` acima: coluna obrigatória
  -- anulada aborta o cascade INTEIRO, e um cascade abortado não anonimiza nada.
  --
  -- O que FICA, de propósito: `motor`, `origem`, `motivo_codigo`,
  -- `cliente_avisado`, `aviso_motivo_codigo`, `criado_em` e o par de
  -- reconhecimento. São operação — quantas passagens houve, por quê, quanto
  -- tempo até alguém assumir. Um passo que apagasse a linha inteira ficaria
  -- verde num teste de "o texto sumiu" e tiraria da organização a resposta a
  -- "quantos atendimentos a IA devolveu em março, e quanto tempo esperaram".
  --
  -- O vínculo é a FK DIRETA `contact_id`: a tabela a carrega exatamente para
  -- este passo não precisar passar pela conversa.
  update passagens_de_atendimento set
    body       = v_anon_label,
    title      = null,
    notes      = null,
    content    = null,
    tentativas = '[]'::jsonb
  where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('passagens_de_atendimento', v_count);

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
-- `passagens_de_atendimento` nasce SERVER-ONLY (revoke de anon/authenticated +
-- grant select), então o ramo server-only da função lhe dá ZERO policies
-- `support_write_*` — que é o contrato mais restritivo. Escrever `drop policy` à
-- mão aqui seria a segunda representação da mesma regra.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
