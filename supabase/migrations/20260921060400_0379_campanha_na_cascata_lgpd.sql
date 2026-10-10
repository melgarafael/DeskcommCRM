-- 0379 — A CAMPANHA ENTRA NA CASCATA DE ANONIMIZAÇÃO
--
-- `campaign_recipients` guarda a MENSAGEM dita à pessoa (`rendered_body`) e o
-- telefone para onde foi (`recipient_address`); `campaign_suppressions` guarda
-- a cauda do número. Nenhum dos dois estava em
-- `fn_lgpd_cascade_redact_contact`: anonimizar devolvia SUCESSO e a prospecção
-- continuava legível — falha muda, com o SLA de LGPD marcado como cumprido.
-- Medido pelo invariante `lgpd-cascata-alcanca-quem-guarda-pessoa`.
--
-- Duas decisões que não são esquecimento:
--
--   1. A LINHA de `campaign_recipients` FICA. Ela é a prova de que a pessoa
--      esteve naquela campanha; apagá-la desfaria a contagem de quem recebeu.
--      O que sai é o conteúdo.
--   2. O HASH de `campaign_suppressions` FICA. É ele que faz o "não me mande
--      mais" continuar valendo depois da anonimização — apagá-lo faria a
--      pessoa voltar a receber campanha.
--
-- Redefine a função inteira (padrão da 0235), a partir da definição VIGENTE no
-- baseline — que é a ÚLTIMA das nove que o arquivo contém, não a primeira.
-- Partir de uma cópia anterior desfaria em silêncio o que a main consertou na
-- cascata desde então: entre a primeira e a vigente há 10 tabelas de diferença.

CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  -- As grafias do telefone desta pessoa, capturadas ANTES de o passo 1 zerar
  -- `contacts.phone_number`. A ordem aqui não é detalhe: o expurgo da
  -- prospecção roda ~150 linhas depois do `update contacts`, e ler o telefone
  -- lá embaixo leria NULL — o braço por telefone existiria no código e não
  -- alcançaria linha nenhuma, que é pior que não existir, porque parece feito.
  v_variantes text[] := '{}';
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

  -- Capturado AGORA, enquanto o telefone ainda existe (o passo 1 o apaga).
  select coalesce(public.fn_telefone_variantes(phone_number), '{}')
    into v_variantes
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

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

  -- CAMPANHAS: o que foi DITO à pessoa e o endereço para onde foi.
  --
  -- `rendered_body` é a mensagem que ela recebeu e `recipient_address` o
  -- telefone. Sem esta limpeza, anonimizar devolveria SUCESSO deixando a
  -- prospecção legível — falha muda, com o SLA marcado como cumprido.
  -- A LINHA FICA: ela é a prova de que a pessoa esteve naquela campanha, e
  -- apagá-la desfaria a contagem de quem recebeu.
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
  --
  -- O HASH do endereço PERMANECE de propósito: é ele que faz o "não me mande
  -- mais" continuar valendo depois da anonimização. Apagá-lo faria a pessoa
  -- voltar a receber campanha.
  update campaign_suppressions set
    address_tail = null,
    reason = null,
    contact_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_suppressions', v_count);
  -- REAPLICADO AO DERIVAR ESTE APÊNDICE (merge da main, 0359 comanda).
  -- O Postgres troca o corpo INTEIRO num `create or replace`: um apêndice
  -- escrito sobre uma versão anterior da função APAGA, em silêncio, o passo
  -- que outra entrega acrescentou. Anonimizar devolveria SUCESSO com o texto
  -- da comanda ainda legível — e o SLA marcado como cumprido.
  -- 6b. sales — a comanda. PRESERVA valor, status e datas, e NÃO desliga o
  --     contato: a venda é registro financeiro (e fiscal) da organização, e
  --     desligá-la do contato faria o relatório por cliente deixar de fechar
  --     com o faturamento do período — divergência muda, meses depois, num
  --     número que ninguém consegue reconciliar. O contato apontado já é
  --     `Cliente Anonimizado #N`; o que sai daqui é o TEXTO LIVRE, que é onde
  --     a pessoa é nomeada de novo ("cliente da Ana, filha da Dona Maria").
  --     Os itens (`sale_items`) não entram: `description` ali é o nome do
  --     SERVIÇO, congelado na inclusão, e apagá-lo destruiria o relatório por
  --     serviço sem tirar dado de pessoa nenhum.
  update sales set
    notes = null,
    cancel_reason = case when cancel_reason is null then null else '[redigido]' end,
    reverse_reason = case when reverse_reason is null then null else '[redigido]' end,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('sales', v_count);

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

  -- Native discovery stores commercial/person data before the Inbox exists.
  -- Keep only keyed suppression tokens, restricted to the server, to prevent
  -- another extraction from reintroducing this erased candidate.
  --
  -- O PREDICADO ALCANÇA POR VÍNCULO **OU** POR TELEFONE, e o segundo braço é o
  -- que conserta um buraco real: quando o telefone raspado já pertencia a um
  -- contato conhecido da organização, `lib/prospecting/store.ts` grava o
  -- candidato como `skipped` e DEIXA `contact_id` nulo de propósito (lá o
  -- vínculo é o freio de mão do envio, em `worker.ts`). Só pelo `contact_id`,
  -- essa pessoa — justamente a que a empresa já conhece — pedia exclusão,
  -- recebia sucesso, a auditoria gravava `lgpd.redact_executed`, e o nome, o
  -- telefone e o endereço dela seguiam legíveis aqui.
  --
  -- Em expurgo os dois erros não têm o mesmo preço: alcançar demais custa um
  -- registro de prospecção descartado; alcançar de menos é violação legal. Por
  -- isso o `or`, e por isso a comparação por VARIANTE do nono dígito.
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
  -- MESMO predicado do bloco anterior. Se os dois divergirem, a linha alcançada
  -- por um e não pelo outro fica com `suppression_salt` semeado e os dados
  -- pessoais intactos — um estado que parece tratado e não está.
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('prospecting_candidates', v_count);


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
    -- `aviso_de_caso_nao_entregue` (migration 0292) entra AQUI e não num
    -- passo próprio: é o mesmo predicado polimórfico, e o braço
    -- `ref_kind='agent_case'` já alcança o caso do titular. O corpo do aviso
    -- embute o título do caso, que é texto sobre a pessoa.
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

  -- entregas_de_aviso_de_caso — o registro do aviso ao suporte (migration 0292).
  --
  -- A tabela NÃO guarda o texto do aviso (só `corpo_hash`), e a única coluna
  -- capaz de ecoar um dado da pessoa é `erro_detalhe`: ali vai o texto CRU que
  -- o transporte devolveu, truncado, e um provedor que recusa um envio costuma
  -- devolver o destinatário dentro da mensagem de erro.
  --
  -- O que FICA, de propósito: `status`, `erro_codigo`, `tentativas`,
  -- `enviado_em`, `destino`, `corpo_hash`. São operação — quantos avisos saíram,
  -- quantos falharam e por quê. Um passo que apagasse a linha inteira ficaria
  -- verde num teste de "o texto sumiu" e tiraria da organização a resposta a
  -- "quantos avisos não chegaram em março". `destino` é o telefone da EQUIPE,
  -- não do titular: anonimizar um cliente não apaga o número do plantão.
  --
  -- ⚠️ PONTO CEGO DECLARADO: `tests/invariants/lgpd-cascata-alcanca-quem-
  -- guarda-pessoa.test.ts` só cobra tabela com FK para `contacts` E coluna cujo
  -- NOME case o padrão de PII. Esta tabela não satisfaz nenhuma das duas — o
  -- gate ficaria VERDE sem este passo. Ele entra porque é certo, não porque o
  -- gate cobra, e isto está escrito aqui para a próxima sessão não o remover
  -- achando que é ornamento. Quem o vigia é a catraca
  -- `tests/invariants/cascata-lgpd-nao-encolhe.test.ts`.
  --
  -- O vínculo é pela CONVERSA, como o de `agent_cases`: esta tabela aponta para
  -- o caso, e o caso não tem FK para `contacts`.
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
