-- manifest: **Anonimizar um contato alcança as fichas fundidas nele.** `fn_lgpd_cascade_redact_contact` passa a percorrer, depois de virar a ficha, as fichas com `is_merged_into` apontando para ela na mesma organização, da mais funda para a de cima: mesmas regras, marca de apagamento de cada telefone delas (#4201) e uma linha `lgpd.redact_executed` por ficha, com o ator (`auth.uid()`) e `ficha_de_origem` no metadata. A própria cascata passa também a pôr na fila de remoção, por `fn_fila_de_remocao_de_arquivo`, a foto de perfil e os anexos dos negócios de que o contato é o titular, e a soltar os ponteiros; o negócio só ligado pela `crm_lead_links` mantém os anexos; o retorno ganha as contagens `crm_lead_attachments`, `crm_lead_attachments_mantidos` e `fichas_absorvidas`. `fn_redigir_conversas_ao_anonimizar` e o passo 7 enfileiram só caminho sob a organização. As colunas de fusão e anonimização de `contacts` e a fila `storage_redaction_queue` passam a ser escritas só pelo servidor. O bloco final confere a organização das linhas da fila de remoção e anonimiza, em qualquer banco, as fichas absorvidas de quem já estava anonimizado; rodá-lo de novo não acha ninguém. Assinatura, `search_path`, `security definer` e grants da cascata inalterados. Espelho no apêndice do `supabase/baseline.sql`: funções e gatilhos antes da VARREDURA anon (0116), bloco de dados no fim do arquivo. Prova em `tests/invariants/lgpd-alcanca-fichas-fundidas.test.ts`.
--
-- Põe um arquivo na fila de remoção. Quem chama já provou pela forma do caminho que
-- ele é desta organização, então a linha que exista com o mesmo caminho passa a ser
-- dela, pendente: sem isso o ponteiro sairia e o arquivo ficaria.
create or replace function public.fn_fila_de_remocao_de_arquivo(p_organization_id uuid, p_request_id uuid, p_bucket text, p_caminho text)
returns void language sql security definer
set search_path = '' as $$
  insert into public.storage_redaction_queue (organization_id, request_id, bucket, object_path)
  values (p_organization_id, p_request_id, p_bucket, p_caminho)
  on conflict (bucket, object_path) do update set
    organization_id = excluded.organization_id,
    request_id = excluded.request_id,
    status = 'pending',
    attempts = 0,
    processed_at = null,
    error_message = null;
$$;
revoke execute on function public.fn_fila_de_remocao_de_arquivo(uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- A virada de `is_anonymized` também enfileira a mídia das mensagens, antes do passo 7
-- da cascata: o mesmo filtro nas duas. O restante é a última definição do baseline.
create or replace function public.fn_redigir_conversas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_variantes text[];
  v_lids text[];
  v_msgs_de_grupo uuid[];
begin
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
    from public.messages m
   where m.organization_id = new.organization_id
     and m.conversation_id in (
       select c.id from public.conversations c
        where c.contact_id = new.id and c.organization_id = new.organization_id)
     and m.media_storage_path like new.organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;

  update public.messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  update public.conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = new.id and organization_id = new.organization_id;

  update public.lead_checkpoints set
    rolling_summary = '[resumo anonimizado]',
    commitments = '[]'::jsonb,
    objections = '[]'::jsonb,
    next_action = null,
    declaracao = null
  where contact_id = new.id and organization_id = new.organization_id;

  -- ── issue #1964 — lead_notes: a memória do agente sobre o contato ─────────
  update public.lead_notes set
    headline = '(anonimizado)',
    body = '(anonimizado)',
    embedding = null,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (headline is distinct from '(anonimizado)'
         or body is distinct from '(anonimizado)'
         or embedding is not null);

  -- ── issue #1964 — ai_agent_runs.tool_calls: preserva o nome e redige o resto
  -- A transformação espelha `redigirToolCalls` (lib/lgpd/cascata.ts): cada
  -- passo vira `{ step?, tool_name?, redacted: true, tool_calls: [{ tool_name }] }`.
  -- Fica QUAIS ferramentas rodaram e em que passo; sai o texto do modelo, os
  -- argumentos e os resultados. Guard no WHERE: só corre quando há passo sem
  -- `redacted`, então o `[]` de nascença e a run já redigida não são tocados.
  update public.ai_agent_runs set
    tool_calls = public.fn_lgpd_redigir_tool_calls(ai_agent_runs.tool_calls)
  where ai_agent_runs.organization_id = new.organization_id
    and ai_agent_runs.contact_id = new.id
    and exists (
      select 1 from jsonb_array_elements(ai_agent_runs.tool_calls) s
       where coalesce(s->>'redacted', 'false')::boolean is not true
    );

  -- ── issue #1964 — lead_state: a próxima ação e a qualificação da lead ─────
  update public.lead_state set
    next_action = null,
    qualification = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (next_action is not null
         or coalesce(qualification, '{}'::jsonb) <> '{}'::jsonb);

  -- ── issue #1964 — contacts.social_identity ───────────────────────────────
  -- O índice único parcial `where social_identity is not null` torna anular
  -- seguro (a linha sai do índice sem violar unicidade). Guard no WHERE para a
  -- varredura não reescrever o que já está anonimizado.
  update public.contacts set
    social_identity = null,
    updated_at = now()
  where id = new.id
    and organization_id = new.organization_id
    and social_identity is not null;

  -- Mensagens de grupo escritas pelo titular (0482, ver o cabeçalho daquele bloco).
  -- (9043) O principal E os telefones extras. O gatilho roda no `update` da
  -- ficha, ANTES de `fn_lgpd_cascade_redact_contact` apagar os extras: é por
  -- isso que eles ainda estão aqui para serem lidos.
  select coalesce(array_agg(distinct v), '{}') into v_variantes
    from (
      select unnest(public.fn_telefone_variantes(coalesce(old.phone_number, new.phone_number))) as v
      union all
      select unnest(public.fn_telefone_variantes(t.phone_number))
        from public.contact_phones t
       where t.organization_id = new.organization_id and t.contact_id = new.id
    ) as todas;
  select coalesce(array_agg(distinct l), '{}') into v_lids
    from (
      select coalesce(old.wa_lid, new.wa_lid) as l
      union all
      select t.wa_lid from public.contact_phones t
       where t.organization_id = new.organization_id and t.contact_id = new.id
    ) as todos
   where l is not null;

  select coalesce(array_agg(m.id), '{}')
    into v_msgs_de_grupo
    from public.messages m
   where m.organization_id = new.organization_id
     and m.metadata ? 'group_sender'
     and (
       regexp_replace(coalesce(m.metadata->'group_sender'->>'phone', ''), '\D', '', 'g') = any(v_variantes)
       or (m.metadata->'group_sender'->>'lid' = any(v_lids))
     );

  if cardinality(v_msgs_de_grupo) > 0 then
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
      from public.messages m
     where m.organization_id = new.organization_id
       and m.id = any(v_msgs_de_grupo)
       and m.media_storage_path like new.organization_id::text || '/%'
    on conflict (bucket, object_path) do nothing;

    update public.conversations set
      last_message_preview = null,
      updated_at = now()
    where organization_id = new.organization_id
      and id in (select m.conversation_id from public.messages m
                  where m.organization_id = new.organization_id and m.id = any(v_msgs_de_grupo));

    update public.messages set
      body = '[mensagem anonimizada]',
      media_url = null,
      media_mime = null,
      media_size_bytes = null,
      media_storage_path = null,
      media_derived_text = null,
      metadata = '{}'::jsonb,
      updated_at = now()
    where organization_id = new.organization_id
      and id = any(v_msgs_de_grupo);
  end if;

  return new;
end
$f$;

-- O alcance mora na cascata, e não num gatilho na virada de `is_anonymized`, para
-- ficar só no caminho autorizado (`fn_lgpd_anonymize_contact` e o pedido formal).
-- `auth.uid()` é quem clicou no botão; no worker do pedido formal é nulo.
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
  -- (9243)
  v_fundida_em uuid;
  v_avatar text;
  v_absorvida uuid;
  v_leads uuid[];
  v_absorvidas int := 0;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized, is_merged_into, avatar_storage_path
    into v_already, v_fundida_em, v_avatar
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

  -- (9043) As variantes do principal E dos telefones extras, lidas ANTES de
  -- apagar os extras (passo 1b): o candidato da prospecção casado pelo número
  -- extra também é da pessoa que pediu para ser esquecida.
  select coalesce(array_agg(distinct v), '{}')
    into v_variantes
    from (
      select unnest(public.fn_telefone_variantes(c.phone_number)) as v
        from contacts c
       where c.id = p_contact_id and c.organization_id = p_organization_id
      union all
      select unnest(public.fn_telefone_variantes(t.phone_number))
        from contact_phones t
       where t.contact_id = p_contact_id and t.organization_id = p_organization_id
    ) as todas;

  -- O arquivo da mensagem mora sob a organização dela: as outras formas não entram
  -- na fila (9243), como no passo 6d.
  select coalesce(array_agg(distinct media_storage_path) filter (
           where media_storage_path like p_organization_id::text || '/%'), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 0b. a foto de perfil (9243). A fila antes do ponteiro: sem a linha, o arquivo
  -- ficaria no bucket sem ninguém capaz de achá-lo. O caminho é estável por
  -- contato, então a linha terminal de um pedido anterior é reaberta. Só o caminho
  -- exato que o cron grava entra na fila.
  if v_avatar = p_organization_id::text || '/avatars/' || p_contact_id::text || '.jpg' then
    perform public.fn_fila_de_remocao_de_arquivo(p_organization_id, p_request_id, 'whatsapp-media', v_avatar);
  end if;

  -- 1. contacts (irreversible)
  update contacts set
    avatar_storage_path = null,
    avatar_updated_at = case when v_avatar is null then avatar_updated_at else now() end,
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    phone_number = null,
    phone_type = null,
    phone_whatsapp = null,
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

  -- 1b. contact_phones (9043) — os telefones extras, com o `lid` de cada um.
  -- Depois do passo 1: o gatilho de redação das mensagens de grupo, que roda
  -- no `update` acima, ainda precisava lê-los.
  delete from contact_phones
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_phones', v_count);

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
  -- 5a. crm_lead_attachments (9243) — só no negócio de que o contato é o titular
  -- (`crm_leads.contact_id`): o arquivo vai para a fila e a linha sai. O negócio só
  -- ligado pela `crm_lead_links` tem outro titular e mantém os anexos, contados em
  -- `crm_lead_attachments_mantidos`. `crm_lead_attachments_storage_path_check` prende
  -- o caminho à organização e ao negócio da linha, então aqui não há outra forma a
  -- conferir.
  select coalesce(array_agg(l.id), '{}') into v_leads
    from crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contact_id;
  perform public.fn_fila_de_remocao_de_arquivo(p_organization_id, p_request_id, 'internal-media', a.storage_path)
    from crm_lead_attachments a
   where a.organization_id = p_organization_id
     and a.lead_id = any (v_leads);
  delete from crm_lead_attachments a
   where a.organization_id = p_organization_id
     and a.lead_id = any (v_leads);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('crm_lead_attachments', v_count);
  select count(distinct a.id) into v_count
    from crm_lead_attachments a
    join crm_lead_links k on k.lead_id = a.lead_id and k.organization_id = a.organization_id
   where a.organization_id = p_organization_id
     and k.target_kind = 'contact'
     and k.target_id = p_contact_id;
  v_counts := v_counts || jsonb_build_object('crm_lead_attachments_mantidos', v_count);

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
    motivo_recusa = null,
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
         or valor_anterior is not null
         or motivo_recusa is not null);
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

  -- 7y. as fichas fundidas nesta (9243), pela mesma função: mesmas regras, a marca
  -- de cada telefone delas e a própria linha de auditoria. A mais funda primeiro:
  -- quando a de cima é chamada, as de baixo já viraram, e a recursão não acompanha
  -- o comprimento da corrente. `cycle` encerra ponteiro em círculo. Só conta a fusão
  -- com data: todo caminho que funde grava `merged_at` junto com o ponteiro.
  for v_absorvida in
    with recursive alcance (id, profundidade) as (
      select c.id, 1 from contacts c
       where c.organization_id = p_organization_id and c.is_merged_into = p_contact_id
         and c.merged_at is not null
      union all
      select f.id, a.profundidade + 1
        from contacts f
        join alcance a on f.is_merged_into = a.id
       where f.organization_id = p_organization_id
         and f.merged_at is not null
    ) cycle id set em_ciclo using caminho
    select a.id
      from alcance a
      join contacts c on c.id = a.id
     where not a.em_ciclo and not c.is_anonymized
     group by a.id
     order by max(a.profundidade) desc, a.id
  loop
    perform public.fn_lgpd_cascade_redact_contact(p_organization_id, v_absorvida, p_request_id);
    v_absorvidas := v_absorvidas + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('fichas_absorvidas', v_absorvidas);

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    auth.uid(),
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id,
      'ficha_de_origem', v_fundida_em
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
revoke execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) to service_role;

-- Fusão e anonimização são escritas pelas funções do servidor (`fn_mesclar_contatos`
-- e a cascata, ambas `security definer`), nunca pela sessão. Como em
-- `fn_contacts_carteira_so_pelo_servidor`: o alvo é o papel da sessão.
create or replace function public.fn_contacts_fusao_e_anonimizacao_so_pelo_servidor()
returns trigger language plpgsql
set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'contacts_fusao_e_anonimizacao_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Fusão e anonimização passam por fn_mesclar_contatos e fn_lgpd_anonymize_contact.';
  end if;
  return new;
end $$;
revoke execute on function public.fn_contacts_fusao_e_anonimizacao_so_pelo_servidor() from public, anon, authenticated, service_role;

drop trigger if exists trg_contacts_fusao_e_anonimizacao_so_pelo_servidor on public.contacts;
create trigger trg_contacts_fusao_e_anonimizacao_so_pelo_servidor
  before update on public.contacts
  for each row
  when (old.is_merged_into is distinct from new.is_merged_into
     or old.merged_at is distinct from new.merged_at
     or old.is_anonymized is distinct from new.is_anonymized
     or old.anonymized_at is distinct from new.anonymized_at)
  execute function public.fn_contacts_fusao_e_anonimizacao_so_pelo_servidor();

drop trigger if exists trg_contacts_fusao_e_anonimizacao_so_pelo_servidor_ao_criar on public.contacts;
create trigger trg_contacts_fusao_e_anonimizacao_so_pelo_servidor_ao_criar
  before insert on public.contacts
  for each row
  when (new.is_merged_into is not null
     or new.merged_at is not null
     or new.anonymized_at is not null
     or new.is_anonymized)
  execute function public.fn_contacts_fusao_e_anonimizacao_so_pelo_servidor();

-- Todo escritor da fila de remoção de arquivos é do servidor: a sessão só lê.
revoke all on table public.storage_redaction_queue from authenticated;
grant select on table public.storage_redaction_queue to authenticated;

do $fichas_absorvidas$
declare
  v_ficha record;
begin
  -- A linha da fila vale para arquivo sob a organização dela, com segmentos de nome
  -- comum: a régua do dreno (`isMediaPathInOrganization`). A cascata recoloca na fila
  -- o que ainda for de alguma ficha.
  delete from public.storage_redaction_queue q
   where q.object_path not like q.organization_id::text || '/%'
      or q.object_path ~ '(^|/)\.{0,2}(/|$)'
      or position(chr(92) in q.object_path) > 0;

  -- A ficha alcançada leva as que estão abaixo dela pela própria cascata.
  for v_ficha in
    select a.organization_id, a.id
      from public.contacts a
      join public.contacts s
        on s.id = a.is_merged_into and s.organization_id = a.organization_id
     where s.is_anonymized and not a.is_anonymized and a.merged_at is not null
     order by a.organization_id, a.id
  loop
    perform public.fn_lgpd_cascade_redact_contact(v_ficha.organization_id, v_ficha.id, null);
  end loop;
end
$fichas_absorvidas$;
