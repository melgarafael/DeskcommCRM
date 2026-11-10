-- manifest: lead_field_proposals (fila de proposta de campo do CARD a partir de documento, #3316): tabela com RLS por organização, idempotência por índice parcial (org+negócio+campo enquanto pending) e a cascata de anonimização (fn_lgpd_cascade_redact_contact, passo 5b) passa a redigir trecho/valores das propostas do negócio
--
-- 0772 — o voucher vira proposta de campo do card, e espera HUMANO (issue #3316).
--
-- Retomada do #3415 (fechado sem merge), com os três defeitos medidos pelo
-- mantenedor corrigidos: a auditoria da decisão não copia mais os valores (só
-- metadados), a fila tem consumidor NA TELA do card (`RevisaoDoDocumento`) e
-- `expires_at` passou a valer — na leitura, na decisão, no nascimento e numa
-- varredura (o cron `contact-proposals-watcher`).
--
-- ═══ A DECISÃO ═══
--
-- O documento (voucher, bilhete, apólice) é lido pela IA, que PROPOE valores
-- para os campos do funil (`pipeline.settings.fields`). Um humano CONFIRMA
-- campo a campo, com o valor atual, o proposto e o trecho de origem à vista.
-- Nada grava em `crm_leads.custom_fields` sem essa confirmação.
--
-- ═══ POR QUE UMA TABELA, E NÃO `crm_lead_activities` ═══
--
-- A timeline é APPEND-ONLY de história: uma linha por evento, com payload que a
-- tela resume. A proposta é TRABALHO PENDENTE: tem estado (`pending` →
-- `accepted`/`dismissed`/`expired`), prazo, decisor, e uma trava que precisa
-- fechar a corrida entre dois humanos clicando ao mesmo tempo. Colocar estado
-- numa tabela de evento faria "marcar como decidido" e "gravar o campo" brigarem
-- pelo mesmo payload, e a leitura da fila viraria varredura de histórico.
--
-- ═══ A FORMA É A DA IRMÃ DE CONTATOS (0123) ═══
--
-- `contact_field_proposals` é a fila de proposta de dado que já rodou em
-- produção: valor proposto × valor ANTERIOR capturado no nascimento (o `from`
-- que a decisão exige), trecho de origem, prazo obrigatório, índice único
-- parcial como IDEMPOTÊNCIA (23505 não é falha: é o voucher relido em dez
-- turnos não enchendo a fila de revisão). A diferença é a chave: a proposta é
-- sobre o NEGÓCIO (um contato tem N negócios, cada um com seu funil), então a
-- chave é `lead_id` + `campo`.
--
-- ═══ POR QUE `campo` NÃO TEM VOCABULÁRIO FECHADO ═══
--
-- Na irmã, o CHECK lista email/name/phone_number/birthdate porque o CADASTRO
-- tem quatro colunas fixas. Aqui os campos são DECLARADOS PELO DONO em
-- `pipeline.settings.fields`, com chave livre (`customFieldSchema.key`): um
-- CHECK fechado recusaria o primeiro funil que renomeasse um campo. O CHECK que
-- existe confere a FORMA da chave (a mesma do schema) — o filtro de "só campos
-- do funil" é do SERVIDOR (`lib/leads/proposta-de-campos-por-documento.ts`),
-- que lê o funil do próprio negócio em cada nascimento.
--
-- ═══ VALOR EM `jsonb`, NÃO EM `text` ═══
--
-- `crm_leads.custom_fields` é jsonb: um campo `number` grava número, um
-- `boolean` grava booleano, um `multiselect` grava lista. Guardar em texto e
-- converter na confirmação faria a fila prometer "42" para um card que espera
-- `42`, e a comparação com o valor atual (jsonb) casaria torto.
--
-- ═══ LGPD ═══
--
-- O trecho é texto do documento sobre a PESSOA. A cascata de anonimização
-- (`fn_lgpd_cascade_redact_contact`) ganha o passo 5b: redigir trecho e os dois
-- valores, preservando campo/status/decisão — o mesmo tratamento de
-- `crm_leads.custom_fields` (passo 5), que também é dado do negócio sem
-- identificar a pessoa depois da redação.

create table if not exists public.lead_field_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,

  -- QUAL campo do funil. A FORMA é a de `customFieldSchema.key` (letra inicial,
  -- até 40, letras/números/underscore); o SERVIDOR decide se a chave está no
  -- funil do negócio — o vocabulário é do dono, não desta tabela.
  campo text not null,

  -- O valor proposto e o que existia no card quando a proposta nasceu. jsonb,
  -- porque o card é jsonb: número, booleano e lista chegam como são.
  valor_proposto jsonb,
  valor_anterior jsonb,

  -- DE ONDE veio, para quem decide conferir em vez de acreditar. `trecho` é o
  -- texto do documento daquele valor; sem ele a proposta nem nasce (régua do
  -- servidor). `attachment_id` aponta para o documento ANEXADO AO NEGÓCIO
  -- (`crm_lead_attachments`, #3229) — o arquivo que a pessoa abre na revisão.
  trecho text,
  attachment_id uuid references public.crm_lead_attachments(id) on delete set null,
  proposed_by_agent_id uuid references public.ai_agents(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,

  status text not null default 'pending',

  -- Carimbados pelo BANCO, nunca pelo processo — mesma razão da 0123: instantes
  -- comparados entre si vêm do mesmo relógio.
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  -- Por que foi recusada. É o LAÇO DE RETORNO: proposta que o humano rejeita
  -- diz onde a IA erra, e sem o motivo o sinal é só um número.
  motivo_recusa text,
  updated_at timestamptz not null default now()
);

comment on table public.lead_field_proposals is
  'Campo do CARD que a IA leu num documento (voucher, bilhete, apólice) e propôs — aguardando confirmação humana (issue #3316). NUNCA grava em crm_leads.custom_fields sozinha: quem grava é a confirmação, pela porta de edição que já existe. SEMPRE com prazo: proposta que ninguém decide vira badge permanente, que simula atenção e adia a decisão.';

-- ⚠️ O COMMENT DA COLUNA DO PRAZO, DENTRO DA GUARDA.
--
-- `comment on column` numa tabela ausente é ERRO, e não aviso: num clone que
-- aplica só parte das migrations (ou num `update.sh` interrompido), este comando
-- abortaria a migration inteira por causa de uma frase de documentação. A guarda
-- `to_regclass` deixa o comentário ser o que ele é — documentação —, e não um
-- portão de schema. (`comment on table` acima é seguro porque a tabela acabou de
-- ser criada neste mesmo arquivo.)
do $$
begin
  if to_regclass('public.lead_field_proposals') is not null then
    comment on column public.lead_field_proposals.expires_at is
      'Prazo OBRIGATÓRIO da proposta — e prazo que ninguém cobra é pior que prazo nenhum. É aplicado em QUATRO lugares: a leitura da fila (GET .../field-proposals filtra expires_at > now), a decisão (POST recusa decidir vencida), o nascimento (a vencida que bloqueia o índice único parcial é encerrada) e a varredura (cron contact-proposals-watcher → vencePropostasDeCampo). Vencida = expires_at <= now().';
    comment on column public.lead_field_proposals.trecho is
      'Trecho do documento de onde o valor saiu — o que permite CONFERIR em vez de acreditar. É texto do documento SOBRE A PESSOA: redigido pela cascata de anonimização (fn_lgpd_cascade_redact_contact, passo 5b), junto com valor_proposto e valor_anterior.';
  end if;
end $$;

create index if not exists lead_field_proposals_org_lead_idx
  on public.lead_field_proposals(organization_id, lead_id);

-- O worker de vencimento varre por aqui (status + prazo), o mesmo desenho da
-- fila de contatos.
create index if not exists lead_field_proposals_prazo_idx
  on public.lead_field_proposals(status, expires_at);

-- A FORMA da chave do funil (`customFieldSchema.key`): letra inicial, até 40
-- caracteres, letras/números/underscore. Só a forma — a decisão de "isto está
-- no funil?" é do servidor, que lê o funil do próprio negócio.
alter table public.lead_field_proposals
  drop constraint if exists lead_field_proposals_campo_check;
alter table public.lead_field_proposals
  add constraint lead_field_proposals_campo_check check (campo ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$');

alter table public.lead_field_proposals
  drop constraint if exists lead_field_proposals_status_check;
alter table public.lead_field_proposals
  add constraint lead_field_proposals_status_check check (
    status = any (array['pending', 'accepted', 'dismissed', 'expired']::text[])
  );

-- Prazo no futuro: proposta que nasce vencida vira item de caixa no primeiro
-- tick e ninguém entende de onde veio.
alter table public.lead_field_proposals
  drop constraint if exists lead_field_proposals_prazo_no_futuro;
alter table public.lead_field_proposals
  add constraint lead_field_proposals_prazo_no_futuro check (expires_at > proposed_at);

-- Decisão e decisor andam juntos. Status decidido sem `decided_at` é registro
-- que não sabe dizer quando aconteceu — e é essa pergunta que a auditoria faz.
alter table public.lead_field_proposals
  drop constraint if exists lead_field_proposals_decisao_datada;
alter table public.lead_field_proposals
  add constraint lead_field_proposals_decisao_datada check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  );

-- ⚠️ ESTE ÍNDICE É A IDEMPOTÊNCIA — não é otimização.
--
-- O modelo vai reler o MESMO voucher em turnos seguidos. Sem ele, dez leituras
-- viram dez linhas e a tela de revisão vira coluna de repetições. `where not
-- exists` no código NÃO substitui: é check-then-act, e dois turnos
-- concorrentes passam pela janela — o mesmo defeito que a 0027 matou nos
-- contatos. PARCIAL: propostas decididas ficam como histórico e não bloqueiam
-- a próxima leitura (o funil pode ter mudado, e o voucher novo é outro).
create unique index if not exists uq_lead_field_proposals_uma_viva
  on public.lead_field_proposals (organization_id, lead_id, campo)
  where status = 'pending';

alter table public.lead_field_proposals enable row level security;

-- `anon` NÃO lê a fila: o `alter default privileges … grant all on tables to
-- anon` do baseline alcança toda tabela nova, e a anon key vai para o browser.
-- O `fn_proteger_tabelas_de_organizacao()` não cobre este caso porque ele só
-- age em tabela SEM RLS — e esta nasce com RLS ligada (de propósito, para não
-- receber a policy `for all` só-tenancy).
revoke all on public.lead_field_proposals from anon;

-- Leitura e escrita amarradas à visibilidade do NEGÓCIO pai: o `exists` em
-- `crm_leads` roda sob a RLS dela, então quem não enxerga o negócio (escopo
-- "só os seus") não enxerga nem mexe nas propostas dele. Escrita: `agent` para
-- cima também na RLS — as rotas já exigem `agent`, e um `viewer` falando
-- direto com o PostgREST não decide proposta nenhuma. `drop` + `create` com o
-- MESMO nome, como a 0731: policies permissivas somam (OR), e uma esquecida
-- reabriria o que as novas fecham.
drop policy if exists tenant_isolation_lead_field_proposals_select on public.lead_field_proposals;
create policy tenant_isolation_lead_field_proposals_select on public.lead_field_proposals
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.crm_leads l
         where l.id = lead_field_proposals.lead_id
           and l.organization_id = lead_field_proposals.organization_id
      )
  );

drop policy if exists tenant_isolation_lead_field_proposals_write on public.lead_field_proposals;
create policy tenant_isolation_lead_field_proposals_write on public.lead_field_proposals
  for all to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = lead_field_proposals.lead_id
           and l.organization_id = lead_field_proposals.organization_id
      )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
  );

-- ═══ LGPD: O PASSO 5b DA CASCATA ═══
--
-- O corpo abaixo é o da ÚLTIMA definição de `fn_lgpd_cascade_redact_contact`
-- (o que o `baseline.sql` instala), copiado por inteiro e com UM passo novo —
-- a mesma doutrina da 0477: reescrever de uma versão antiga apagaria em
-- silêncio os passos que as entregas seguintes acrescentaram. Só o passo 5b é
-- novo; ele redige `trecho`, `valor_proposto` e `valor_anterior` das propostas
-- dos negócios do contato (direto ou pela `crm_lead_links`, como o passo 5),
-- preservando campo/status/decisão.
-- Gate: tests/invariants/lgpd-redact-unificado-alcanca-pelo-catalogo.test.ts.
create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'extensions', 'pg_temp'
    as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  v_variantes text[] := '{}';
  v_secao record;
  v_secoes jsonb := '{}'::jsonb;
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

  -- O rótulo NÃO deriva mais do id (issue #2342): `fn_lgpd_rotulo_anonimizado`
  -- gera um sufixo OPACO (aleatório, gravado no passo 1 abaixo). Antes, o
  -- sufixo eram os 8 primeiros caracteres do uuid do contato — quem tem o
  -- banco casava `Cliente Anonimizado #7a5f0011` com a linha `7a5f0011-…` e
  -- reidentificava o titular pelo próprio rótulo (pseudonimização, não
  -- anonimização: RGPD considerando 26, LGPD art. 12 e art. 13 §4).
  v_anon_label := public.fn_lgpd_rotulo_anonimizado(p_contact_id);

  -- Seções de módulo (D8, 0485): a redação delas é do gatilho
  -- `trg_lgpd_secoes_de_modulo`, que não devolve contagem — mas a contagem é
  -- EVIDÊNCIA (vai para `cascaded_to` no audit e no retorno). Uma chave por
  -- seção declarada, com o nome da tabela, contando pela MESMA `ligacao` do
  -- gatilho ($1 = organização, $2 = contato). Conta ANTES do passo 1 (que
  -- dispara o gatilho): a seção que soltar a própria ligação seguiria contada.
  -- Sem o módulo a tabela não existe e a chave não aparece. Seção com ligação
  -- vazia não é contada: o erro nomeado (`modulo_secao_invalida`) é do gatilho.
  for v_secao in
    select tabela, ligacao from public.modulo_secoes_lgpd order by modulo, tabela
  loop
    if to_regclass(format('public.%I', v_secao.tabela)) is not null
       and btrim(v_secao.ligacao) <> '' then
      execute format('select count(*) from public.%I where (%s)', v_secao.tabela, v_secao.ligacao)
        into v_count using p_organization_id, p_contact_id;
      v_secoes := v_secoes || jsonb_build_object(v_secao.tabela, v_count);
    end if;
  end loop;

  select coalesce(public.fn_telefone_variantes(phone_number), '{}')
    into v_variantes
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

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
    media_derived_text = null,
    -- `external_id` guarda o TELEFONE do titular (número no inbound, id do
    -- provider no outbound) e sobrevivia legível na linha que RESTA da
    -- anonimização — a última PII viva do pedido de exclusão. Zerar não quebra
    -- nada que dependa da coluna: o unique (organization_id, external_id)
    -- trata NULL como distinto de todo NULL, a citação (`reply_to_message_id`)
    -- aponta para o id da linha e não para o `external_id`, e o eco do provider
    -- só deduplica mensagem ainda em voo — pedido de exclusão não manda nada.
    external_id = null,
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
  -- 5b. lead_field_proposals (0772, #3316) — a proposta de campo que a IA leu
  -- num DOCUMENTO (voucher, bilhete, apólice). `trecho` é o texto do documento
  -- sobre a PESSOA e os dois valores são o dado que a IA extraiu: o MESMO
  -- tratamento do `custom_fields` do próprio negócio (passo 5) — campo, status
  -- e decisão PERMANECEM (a fila continua explicável), o conteúdo identificável
  -- sai. Alcança pelo vínculo do negócio com o contato (direto ou pela
  -- `crm_lead_links`), como os passos 4 e 5.
  -- Gate: tests/invariants/cascata-lgpd-nao-encolhe.test.ts (catraca da lista).
  update lead_field_proposals set
    trecho = v_anon_label,
    valor_proposto = null,
    valor_anterior = null,
    updated_at = now()
  where organization_id = p_organization_id
    and (
      lead_id in (
        select id from crm_leads
         where organization_id = p_organization_id
           and contact_id = p_contact_id
      )
      or lead_id in (
        select lead_id from crm_lead_links
         where target_kind = 'contact'
           and target_id = p_contact_id
           and organization_id = p_organization_id
      )
    )
    -- Redação IDEMPOTENTE: a segunda anonimização não deve contar linha de novo
    -- (o `already_anonymized` já barra, mas a condição também protege o rerun
    -- parcial que a 0414 permite).
    and (trecho is distinct from v_anon_label
         or valor_proposto is not null
         or valor_anterior is not null);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('lead_field_proposals', v_count);

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

  -- 6b. crm_proposals (migration 0477, #1504) — PRESERVA número, valores,
  -- itens, datas e status; redige só o que identifica a PESSOA. Ver o
  -- cabeçalho desta migration para o porquê de cada coluna.
  -- O PDF que o cliente recebeu (bucket `propostas`, `<org>/<proposta>.pdf`)
  -- tem o nome dele impresso: redigir as colunas e deixar o arquivo seria
  -- anonimizar a linha e manter o documento. Vai para a mesma fila de expurgo
  -- da mídia (passo 7), com o bucket CERTO — a mensagem que levou o PDF
  -- aponta para o mesmo caminho, mas o passo 7 só enfileira `whatsapp-media`.
  -- Lido ANTES de o passo seguinte zerar `pdf_path`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'propostas', pdf_path
    from crm_proposals
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and pdf_path is not null and length(pdf_path) > 0
     -- só arquivo DESTA organização: o expurgo nunca alcança o PDF de outra
     and pdf_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update crm_proposals set
    destinatario_nome = v_anon_label,
    briefing_json = '{}'::jsonb,
    resumo_comercial = null,
    -- o texto do documento como foi montado e como foi editado à mão: é o
    -- conteúdo do PDF, com o mesmo nome dentro.
    rendered_snapshot = null,
    secoes_editadas = null,
    pdf_path = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('crm_proposals', v_count);

  -- CAMPANHAS: o que foi DITO à pessoa e o endereço para onde foi.
  update campaign_recipients set
    rendered_body = null,
    recipient_address = null,
    variables = '{}'::jsonb,
    last_error_detail = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_recipients', v_count);

  -- LISTA DE EXCLUSÃO: solta o vínculo e apaga a cauda do telefone.
  update campaign_suppressions set
    address_tail = null,
    reason = null,
    contact_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_suppressions', v_count);

  -- 6c. sales — a comanda SAIU desta cascata (PR #1907, item 1).
  -- Este passo alterava a comanda pelo NOME, e as cinco tabelas da comanda
  -- saíram do baseline para nascerem só na instalação do módulo (ADR-0002
  -- D2/D3): sem o módulo a tabela não existe e a alteração abortava a
  -- ANONIMIZAÇÃO INTEIRA com `relation "sales" does not exist` — 68
  -- ocorrências no CI do #1907 — além de violar a D8 (migration 0485), que
  -- proíbe o núcleo nomear tabela de módulo. A redação da comanda acontece
  -- agora pela SEÇÃO declarada `financeiro/sales` em `modulo_secoes_lgpd`,
  -- que `trg_lgpd_secoes_de_modulo` aplica nos DOIS caminhos de anonimização
  -- (a cascata e a virada `is_anonymized` de `fn_lgpd_anonymize_contact`) —
  -- e pula, sem erro, onde o módulo não está instalado (`to_regclass`), que é
  -- exatamente o contrato.
  -- 6d. conversation_notes (migration 0483, F3 da #1863) — a nota interna é
  -- texto escrito SOBRE a pessoa durante o atendimento, e o anexo dela é mídia
  -- ancorada na conversa: os dois entram no alcance do titular. A 0477 já
  -- mostrou o desenho (arquivo vai para a fila ANTES de a coluna ser zerada).
  -- O bucket é `internal-media`, e não o do passo 7: a nota nunca sobe no
  -- `whatsapp-media` (é o bucket do canal do CLIENTE), e enfileirar o caminho
  -- num bucket onde ele não está deixaria a remoção apontando para o nada —
  -- a mesma falha de não ter anonimizado, um endereço mais para a direita.
  -- Por isso os caminhos de nota também NÃO entram em `v_media_paths`: essa
  -- lista só existe para o passo 7, que enfileira `whatsapp-media`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'internal-media', n.media_storage_path
    from conversation_notes n
   where n.organization_id = p_organization_id
     and n.conversation_id in (
       select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
     )
     and n.media_storage_path is not null and length(n.media_storage_path) > 0
     and n.media_storage_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update conversation_notes set
    body = '[nota interna anonimizada]',
    media_storage_path = null,
    media_mime = null,
    media_size_bytes = null
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
       where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversation_notes', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  update prospecting_candidates set suppression_salt = gen_random_bytes(32)
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)))
    and suppression_salt is null;
  update prospecting_candidates set
    suppression_place = hmac(convert_to(place_id, 'UTF8'), suppression_salt, 'sha256'),
    suppression_phone = case when phone is null then null
      else hmac(convert_to(phone, 'UTF8'), suppression_salt, 'sha256') end,
    place_id = 'redacted:' || id::text,
    phone = null,
    data = jsonb_build_object('key', 'redacted:' || id::text,
      'name', v_anon_label, 'phone', null, 'website', null,
      'category', null, 'address', null, 'maps_url', null,
      'rating', null, 'reviews', null, 'emails', '[]'::jsonb, 'socials', '[]'::jsonb),
    status = 'skipped', service_boundary = null, error = null, updated_at = now()
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('prospecting_candidates', v_count);

  -- agent_cases — o que a IA escreveu SOBRE a pessoa quando travou (migration 0280).
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
  update demandas set
    assunto = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- agent_inbox_items — o aviso que leva o texto do caso para a Central (migration 0280/0292).
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = now(),
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    and kind in ('handoff', 'case_stale', 'aviso_de_caso_nao_entregue')
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

  -- agent_case_chat_messages — a consulta interna da equipe à IA SOBRE o caso (migration 0281).
  update agent_case_chat_messages set
    body = null,
    redacted_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and redacted_at is null;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_chat_messages', v_count);

  -- passagens_de_atendimento — o BRIEFING é sobre a pessoa (migration 0291).
  update passagens_de_atendimento set
    body       = v_anon_label,
    title      = null,
    notes      = null,
    content    = null,
    tentativas = '[]'::jsonb
  where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('passagens_de_atendimento', v_count);

  -- entregas_de_aviso_de_caso — o registro do aviso ao suporte (migration 0292).
  update entregas_de_aviso_de_caso set
    erro_detalhe = null
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
  v_counts := v_counts || jsonb_build_object('entregas_de_aviso_de_caso', v_count);

  -- channel_session_groups.subject — o NOME do grupo, e a FK contact_id aponta
  -- para o placeholder do grupo (contacts.kind = 'whatsapp_group'), nunca para
  -- o titular real sendo anonimizado neste caminho — mas a FK para contacts e o
  -- nome da coluna casam o padrão automático do escopo (migration 0482), e
  -- nulificar não perde nada operacional: número, conversa e liga/desliga ficam.
  update public.channel_session_groups set
    subject = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('channel_session_groups', v_count);

  -- 7z. as contagens das seções de módulo (calculadas antes do passo 1); o
  --     núcleo vence numa colisão de nome.
  v_counts := v_secoes || v_counts;

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

