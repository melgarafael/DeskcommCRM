-- manifest: **A tela Desempenho passa a mostrar a MEDIANA da 1ª resposta humana por atendente, ao lado da média, e o recorte por ETIQUETA DO CONTATO tira da conta as conversas de um contato que carrega a etiqueta pedida (issue #3212, fatia 1).** A média (`avg_first_response_seconds`) existe desde a 0037 e não muda um byte; o que faltava era o número que NÃO é arrastado por um atendimento de 25 dias — a MEDIANA, que a tela não mostrava em lugar nenhum —, e a resposta para «quanto tempo o FORNECEDOR segura o atendimento», que não tinha como separar fornecedor de cliente: as etiquetas existem em `contacts.tags` (0033/0034, índice GIN `idx_contacts_tags_gin`) e nenhuma métrica as lia. **As duas contas são as de CONVERSA** — `conversations_handled`, a média e a mediana: `won`/`lost` são negócios de `crm_leads` e `calls_answered` é ligação de `voice_calls`, e nenhum dos dois é conversa de contato, então nenhum é tocado. **A régua da média é a MESMA** — o `avg(...)` e o seu `where` (incluindo o recorte da janela da 0596 antes do `cross join lateral`) saem idênticos; a mediana entra como campo NOVO, `percentile_cont(0.5) within group (order by extract(epoch from (first_human_out - first_in)))`, no mesmo agregado e sobre o mesmo conjunto, para as duas nunca divergirem. **Amostra sem par válido devolve `null` (não medida), NUNCA 0** — o campo nasce no `jsonb_build_object` como `tf.median_first_response_seconds` e o grupo vazio do `ttfr` dá `null` pelo `left join`. **O recorte por etiqueta** normaliza os dois lados com `lower(btrim(...))` (`Fornecedor ` e `fornecedor` são a mesma etiqueta para quem digita na tela de contatos) e é o par SQL do módulo puro `lib/metrics/mediana-e-recorte-por-etiqueta.ts` (`contatoCarregaEtiqueta()`/`mediana()`), comparado lado a lado em `tests/invariants/mediana-e-recorte-por-etiqueta.test.ts`. A resposta DECLARA o recorte: `excluded_tag` (a etiqueta usada, `null` quando não houve recorte) e `excluded_conversations` (quantas conversas da janela ela tirou da conta — 0 quando a etiqueta não é informada). **A assinatura antiga de 4 argumentos é DERRUBADA** antes do `create or replace`: com as duas vivas, a chamada posicional de 4 argumentos (`fn_attendant_metrics(org, from, to, null)`, o formato de `tests/invariants/metricas-cortam-pela-janela.test.ts`) ficaria ambígua (`function is not unique`), e a função nova é SECURITY INVOKER — fora da varredura de anon da 0116, que só cobre definer —, por isso o `revoke`/`grant` é reemitido com a assinatura nova. Nenhum índice novo, nenhuma coluna nova, nenhuma reescrita da média. Idempotente (`create or replace` + `drop function if exists`), portável em psql puro (sem BEGIN/COMMIT, sem temp table); espelho no `baseline.sql` NO MESMO bloco da função (edição dos blocos existentes, nunca bloco novo), ANTES da `VARREDURA anon` (0116). UI: só o cabeçalho e a célula do Card de performance em `app/app/metrics/_components/MetricsClient.tsx`; rota e hook ganham o campo e o parâmetro (`excluir_etiqueta`). Refs #3212 (fatia 1).

-- A assinatura de 4 argumentos sai: com as duas vivas a chamada POSICIONAL de 4 argumentos
-- fica ambígua (`function is not unique`) — e é assim que a suíte de invariantes e outros
-- leitores chamam a função. `create or replace` não substitui assinatura diferente.
drop function if exists public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid);

create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null,
  -- (0754) A etiqueta do contato que SAI da conta das conversas. `null` = sem recorte.
  p_excluir_etiqueta text default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- ─── #3212: o recorte por ETIQUETA DO CONTATO ───────────────────────────
  --
  -- «Quanto tempo o fornecedor segura o atendimento» não tinha resposta: não havia como
  -- tirar da régua as conversas de um contato que carrega uma etiqueta. As etiquetas
  -- existem em `contacts.tags` (0033/0034, com índice GIN) e NENHUMA métrica as lia.
  --
  -- O recorte é do CONTATO e vale para as três contas de CONVERSA — a contagem
  -- (`conversations_handled`), a média e a mediana. `won`/`lost` são NEGÓCIOS e
  -- `calls_answered` é LIGAÇÃO: nenhum dos dois é conversa de contato, e nenhum é tocado.
  --
  -- A comparação normaliza os DOIS lados com `lower(btrim(...))`: etiqueta é texto que o
  -- operador digita (`Fornecedor ` e `fornecedor` são a mesma), e é a MESMA normalização de
  -- `contatoCarregaEtiqueta()` em `lib/metrics/mediana-e-recorte-por-etiqueta.ts` — o par
  -- TS×SQL é comparado lado a lado em `tests/invariants/mediana-e-recorte-por-etiqueta.test.ts`.
  contatos_excluidos as (
    select ct.id
    from public.contacts ct
    where p_excluir_etiqueta is not null
      and ct.organization_id = p_org
      and exists (
        select 1
        from unnest(coalesce(ct.tags, '{}'::text[])) as t
        where lower(btrim(t)) = lower(btrim(p_excluir_etiqueta))
      )
  ),
  -- ETIQUETA NÃO INFORMADA NÃO RECORTA: `p_excluir_etiqueta` nulo esvazia o conjunto acima e
  -- este total sai 0 — a resposta DECLARA o que foi tirado, e «nada» é resposta legítima.
  conversas_excluidas as (
    select count(*) as total
    from public.conversations c
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and c.assigned_at >= p_from and c.assigned_at < p_to
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and exists (select 1 from contatos_excluidos e where e.id = c.contact_id)
  ),
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (
        where status = 'lost'
          -- A transferência entre funis não é perda comercial (migration 0266).
          and coalesce(lost_reason, '') <> 'moved_to_another_pipeline'
      ) as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
      -- (0754) conversa cujo CONTATO carrega a etiqueta pedida sai da conta.
      and not exists (select 1 from contatos_excluidos e where e.id = contact_id)
    group by assigned_to_user_id
  ),
  -- (0235) Chamada de voz ATENDIDA conta como trabalho.
  --
  -- Quem passa o dia ao telefone tinha produtividade zero nesta função: ela
  -- lia negócios fechados, conversas atribuídas e primeira resposta por
  -- MENSAGEM, e nenhuma das três enxerga uma ligação.
  --
  -- `owner_user_id` é quem esteve NA LINHA (a rota de atender grava; a ponte de
  -- eventos confirma pelo `owner` do upstream) — e não `created_by`, que só
  -- existe na chamada iniciada pelo CRM e diria zero para toda ligação
  -- recebida. `answered_at is not null` é o que separa trabalho de telefone
  -- tocando.
  voice_agg as (
    select
      owner_user_id as user_id,
      count(*) as calls_answered,
      coalesce(sum(duration_ms), 0)::bigint as call_ms
    from public.voice_calls
    where organization_id = p_org
      and owner_user_id is not null
      and answered_at is not null
      and answered_at >= p_from and answered_at < p_to
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  -- ─── #2514: o recorte ANTES do lateral, não depois dele ────────────────────
  --
  -- O `ttfr` media a 1ª resposta humana de TODA conversa atribuída da
  -- organização: o `cross join lateral` rodava uma vez por conversa e a janela
  -- só entrava no filtro do agregado. 1 dia e 90 dias faziam o mesmo trabalho
  -- (medido: 13,9 s contra 15,8 s), e o dashboard chama isso com janela curta a
  -- cada visita.
  --
  -- O candidato é EXATO, não uma margem: a média só pode nascer de conversa cuja
  -- 1ª resposta humana cai na janela (`fr.first_human_out >= p_from and <
  -- p_to`, predicado que já existia), e toda conversa assim tem UMA mensagem
  -- humana de saída na janela — é justamente ela a 1ª. O que
  -- `ttfr_candidatas` deixa de fora não passava daquele filtro de qualquer
  -- forma: não era contagem, não era vazamento, só pagava o lateral.
  --
  -- O custo do candidato acompanha a JANELA: `idx_messages_org_direction_sent`
  -- (0133) cobre o predicado inteiro, `(organization_id, direction, sent_at)`.
  ttfr_candidatas as (
    select distinct m.conversation_id
    from public.messages m
    where m.organization_id = p_org
      and m.direction = 'outbound'
      and m.sent_by_user_id is not null
      and m.sent_at >= p_from
      and m.sent_at < p_to
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds,
      -- (0754) MEDIANA da 1ª resposta: o valor do MEIO da amostra ordenada (com
      -- tamanho par, `percentile_cont(0.5)` interpola os dois do meio — o mesmo de
      -- `mediana()` em `lib/metrics/mediana-e-recorte-por-etiqueta.ts`). Grupo sem
      -- par válido não existe no agregado e o campo sai `null` (não medida), NUNCA 0.
      percentile_cont(0.5) within group (
        order by extract(epoch from (fr.first_human_out - fr.first_in))
      ) as median_first_response_seconds
    from public.conversations c
    -- A linha de fora do candidato nunca entrou na média; ela só existia para
    -- ser varrida. O lateral e o filtro de baixo estão INTACTOS.
    join ttfr_candidatas k on k.conversation_id = c.id
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      -- (0754) o MESMO recorte do `conv_agg`: média e mediana nascem do mesmo conjunto,
      -- para uma nunca divergir da outra.
      and not exists (select 1 from contatos_excluidos e where e.id = c.contact_id)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
    union select user_id from voice_agg
  )
  select jsonb_build_object(
    -- (0754) a etiqueta QUE FOI USADA e o total de conversas que ela tirou da conta
    -- vêm declarados na resposta: recorte sem número declarado vira número torto.
    'excluded_tag', p_excluir_etiqueta,
    'excluded_conversations', (select total from conversas_excluidas),
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds,
          'median_first_response_seconds', tf.median_first_response_seconds,
          'calls_answered', coalesce(va.calls_answered, 0),
          'call_seconds', (coalesce(va.call_ms, 0) / 1000)::bigint
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
      left join voice_agg va on va.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;
-- SECURITY INVOKER não é coberta pela VARREDURA anon da 0116 (que só olha definer), e a
-- função é nova: sem isto ela nasceria com o EXECUTE default de PUBLIC (e de anon, que o
-- ALTER DEFAULT PRIVILEGES do dump grava no catálogo).
revoke all on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid, text)
  from public, anon;
grant execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid, text)
  to authenticated, service_role;
