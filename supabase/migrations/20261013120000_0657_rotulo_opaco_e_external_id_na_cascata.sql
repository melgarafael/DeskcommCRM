-- manifest: **O rótulo de anonimizado deixa de derivar do id do contato, o `external_id` do titular sai das mensagens que sobram, e o pedido de exclusão AVISA o titular depois de apagar (issue #2342).** Três achados da triagem, no mesmo pedido de exclusão: (1) `v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8)` gravava nos 8 primeiros caracteres do uuid do contato um sufixo que qualquer pessoa com o banco casava com a linha `contacts` — rótulo derivado do id é pseudonimização, e dado pseudonimizado segue sendo dado pessoal (RGPD considerando 26; LGPD art. 12 e art. 13 §4); (2) o passo 3 da cascata redigia o corpo, a mídia e o metadata de `messages`, mas deixava `external_id` — o TELEFONE do titular — legível na linha que resta; (3) a cascata não informava o titular de nada depois de apagar (art. 12.º n.º 3 do RGPD). Este arquivo conserta (1) e (2); (3) entra no worker (`workers/lgpd-redact-worker.ts`) e na rota de aviso do art. 12.º, e vale só para organização FORA do Brasil (decisão de produto de 2026-10-16): no Brasil o aviso não existe, e o texto brasileiro fica para uma revisão própria.
-- 0657: rótulo opaco de anonimizado, `messages.external_id` zerado na cascata.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────────────────────
--
-- O sufixo do rótulo era a CAUDA do id:
--
--   v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);
--
-- O contato continua com o MESMO id depois da anonimização, então quem tem o
-- banco não precisa de nada mais: `select id, name from contacts where
-- is_anonymized` devolve a parelinha pronta. Reidentificar é olhar, não
-- calcular — e é exatamente o que o considerando 26 do RGPD diz que dado
-- pseudonimizado ainda é.
--
-- ─── O conserto, e por que um token aleatório ───────────────────────────────────────────────
--
-- Hash com sal parece o remédio, e não é: quem tem o banco tem também o sal,
-- e aí basta recalcular o hash de cada `contacts.id` para reencontrar a linha.
-- O sufixo tem de NÃO SER FUNÇÃO do id — 32 bits de aleatoriedade, gerados uma
-- vez, gravados no `name` do contato no passo 1. Nada no banco permite ir do
-- rótulo de volta ao titular.
--
-- O rótulo precisa continuar MESMO em todas as tabelas (é assim que a tela
-- reconhece um contato anonimizado em lead, caso, proposta e mídia de voz), e a
-- geração é centralizada numa função só — `fn_lgpd_rotulo_anonimizado`, que
-- reusa o que já está no contato quando existe. O gatilho de seções de módulo
-- (0485) roda ANTES do commit do passo 1, então ele lê `new.name`, que nesse
-- ponto já é o rótulo novo.
--
-- O FORMATO (`Cliente Anonimizado #` + 8 dígitos hexadecimais) não muda: o
-- prefixo é o que `lib/escalacao/texto-do-aviso.ts` usa para não cortar o rótulo
-- no primeiro token, e o regex de 8 hex casava com o sufixo novo também.
--
-- ─── `messages.external_id` ─────────────────────────────────────────────────────────────────
--
-- A coluna guarda o telefone do titular no inbound e o id do provider no
-- outbound. O passo 3 já redigia o corpo, apagava a mídia e limpava o metadata,
-- e a coluna sobrava inteira — a última PII viva das linhas que RESTAM depois
-- do pedido de exclusão. Zerar não quebra o que existe: `messages_org_external_id_unique`
-- trata NULL como distinto de todo NULL, a citação (`reply_to_message_id`,
-- migration 0168) aponta para o id da linha, e o dedup por eco do provider só
-- alcança mensagem ainda em voo — pedido de exclusão não manda mensagem nenhuma.
-- Linhas exportadas antes (PDF/data.json do titular) não mudam: nada aqui
-- reescreve o que já foi entregue, e a contagem por tabela (`counts`) segue a
-- mesma.
--
-- ─── FORWARD-FIX ────────────────────────────────────────────────────────────────────────────
--
-- A cascata já foi reescrita seis vezes — 0019 nasceu, 0477/0482/0483/0497/0620
-- cresceram — e todas já estão aplicadas: o conserto é `create or replace` numa
-- migration NOVA (a mesma porta de sempre), com o apêndice idêntico no
-- `baseline.sql`, ANTES do bloco da VARREDURA anon (0116), que proíbe
-- `create function` depois dela.
--
-- Evidência: `tests/invariants/lgpd-rotulo-opaco-e-external-id.test.ts` (efeito
-- no banco: rótulo não deriva do id, mesmo valor em todas as tabelas,
-- `external_id` zerado e a linha de pé) e
-- `tests/unit/cascata-lgpd-rotulo-opaco-e-external-id.test.ts` (a última
-- definição do baseline e da cadeia são as que mudam).

create or replace function public.fn_lgpd_rotulo_anonimizado(p_contact_id uuid)
returns text
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_rotulo text;
begin
  if p_contact_id is null then
    return null;
  end if;

  -- Quem escreve DEPOIS do passo 1 reusa o rótulo que já está no contato: o
  -- sufixo é gerado UMA vez por anonimização, e todas as tabelas alcançadas
  -- ficam com o MESMO rótulo — é o que faz o rótulo servir de ponteiro.
  select name into v_rotulo from public.contacts where id = p_contact_id;
  if v_rotulo ~ '^Cliente Anonimizado #[0-9a-f]{8}$' then
    return v_rotulo;
  end if;

  -- Sufixo OPACO: 32 bits de aleatoriedade, nenhum pedaço do id. Diferente do
  -- `substring(id::text from 1 for 8)` anterior, o valor NÃO é função do id —
  -- nem olhando o rótulo nem enumerando os ids do banco se recupera o titular.
  return 'Cliente Anonimizado #' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
end $$;

revoke execute on function public.fn_lgpd_rotulo_anonimizado(uuid) from public, anon, authenticated;
grant execute on function public.fn_lgpd_rotulo_anonimizado(uuid) to service_role;

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

create or replace function public.fn_lgpd_redigir_secoes_de_modulo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  s record;
  v_rel oid;
  v_sets text;
  v_nulos text;
  v_rotulos text;
  v_redigidas text;
  v_agora text;
  -- O rótulo opaco (issue #2342) vem do PRÓPRIO contato quando o gatilho é
  -- disparado pela cascata: nesse ponto `new.name` já é o rótulo que o passo 1
  -- gravou, e reusar o MESMO valor mantém a seção de módulo casando com o
  -- contato. Sem o reaproveitamento cada escritor geraria um token diferente.
  v_rotulo text := case
                     when new.name ~ '^Cliente Anonimizado #[0-9a-f]{8}$' then new.name
                     else public.fn_lgpd_rotulo_anonimizado(new.id)
                   end;
begin
  if not (new.is_anonymized and not old.is_anonymized) then
    return null;
  end if;

  for s in
    select modulo, tabela, ligacao, colunas, colunas_rotulo, colunas_redigidas, colunas_agora
      from public.modulo_secoes_lgpd
     order by modulo, tabela
  loop
    v_rel := to_regclass(format('public.%I', s.tabela));

    if v_rel is null then
      continue;
    end if;

    if btrim(s.ligacao) = ''
       or (cardinality(s.colunas) = 0 and cardinality(s.colunas_rotulo) = 0
           and cardinality(s.colunas_redigidas) = 0) then
      raise exception 'modulo_secao_invalida: %/% declara ligação vazia ou sem coluna', s.modulo, s.tabela;
    end if;

    if exists (
      select 1
        from unnest(s.colunas || s.colunas_rotulo || s.colunas_redigidas || s.colunas_agora) as c(coluna)
       where not exists (
         select 1
           from pg_attribute a
          where a.attrelid = v_rel
            and a.attname = c.coluna
            and a.attnum > 0
            and not a.attisdropped
       )
    ) then
      raise exception 'modulo_secao_invalida: %/% tem coluna declarada que não existe', s.modulo, s.tabela;
    end if;

    select string_agg(format('%I = null', c), ', ' order by c) into v_nulos
      from unnest(s.colunas) as c;
    -- O conserto da #2656: o rótulo só entra onde JÁ havia valor. Um `null`
    -- declarado continua nulo — a anonimização não dá conteúdo ao que era vazio.
    select string_agg(format('%1$I = case when %1$I is null then null else %2$L end', c, v_rotulo), ', ' order by c)
      into v_rotulos
      from unnest(s.colunas_rotulo) as c;
    select string_agg(format('%1$I = case when %1$I is null then null else %2$L end', c, '[redigido]'), ', ' order by c)
      into v_redigidas
      from unnest(s.colunas_redigidas) as c;
    select string_agg(format('%I = now()', c), ', ' order by c) into v_agora
      from unnest(s.colunas_agora) as c;
    v_sets := concat_ws(', ', v_nulos, v_rotulos, v_redigidas, v_agora);

    execute format('update public.%I set %s where (%s)', s.tabela, v_sets, s.ligacao)
      using new.organization_id, new.id;
  end loop;

  return null;
end $f$;
