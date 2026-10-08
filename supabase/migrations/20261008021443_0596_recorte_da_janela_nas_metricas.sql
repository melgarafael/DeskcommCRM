-- manifest: **As funções de métricas cortam a conversa pela JANELA antes do `cross join lateral` (issue #2514).** `fn_attendant_metrics` (0037) e `fn_channel_metrics` (0590) custavam o MESMO com janela de 1 dia e com 90: a CTE de conversas lia toda conversa atribuída da organização e, para cada uma, rodava o lateral sobre `messages` — a janela só entrava no filtro do agregado, DEPOIS de todo o trabalho. Medido na issue num banco com 3.000 conversas e 12.000 mensagens: 13,9 s contra 14,1 s (canal) e 13,9 s contra 15,8 s (atendente), ou seja, a janela não movia a agulha, e no dashboard a página chama as duas com janela curta a cada visita. **A correção é o recorte, não a régua**: um conjunto de candidatas avaliado ANTES do lateral, com as duas condições que a saída realmente exige — (a) conversa atribuída na janela (é o predicado de `conversations_handled`/`sem_resposta`, que já existia) e (b) mensagem humana de saída na janela (é o caso necessário de `first_human_out >= p_from and < p_to`: toda conversa cuja 1ª resposta humana cai na janela TEM uma mensagem humana de saída na janela — é ela a 1ª). As linhas que ficam de fora não eram contadas, não eram vazamento e não entravam na média: elas só pagavam o lateral. **O resultado numérico para o mesmo recorte é o mesmo** — paridade provada contra a régua antiga em `tests/invariants/metricas-cortam-pela-janela.test.ts`, que também mede que a janela curta toca menos conversas que a longa. Candidatas usam índices que já existem: `idx_messages_org_direction_sent` (0133, `(organization_id, direction, sent_at)`) e `idx_conversations_org_assignee_assigned` (0037, `(organization_id, assigned_to_user_id, assigned_at)` parcial em `assigned_to_user_id is not null`) — nenhum índice novo, nenhuma coluna nova, nenhuma mudança de UI (sem i18n). Idempotente (`create or replace`), portável em psql puro (sem BEGIN/COMMIT, sem temp table); espelho no `baseline.sql` ANTES do bloco da `VARREDURA anon` (0116), que é de propósito o último que cria função. Refs #2504, Refs #2390 (critério 9: volume grande não pode estourar).
create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
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
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
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
revoke all on function public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid) from public, anon;
grant execute on function public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid) to authenticated, service_role;

create or replace function public.fn_channel_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- ─── #2514: o recorte ANTES do lateral, não depois dele ────────────────────
  --
  -- A irmã lia TODA conversa da organização com `channel_session_id` e pagava o
  -- lateral (`messages`, com a RLS de `messages` por linha) para cada uma; a
  -- janela só cortava dentro do agregado, então 1 dia e 90 dias custavam igual
  -- (medido: 13,971 s contra 14,068 s).
  --
  -- As duas condições são as que a SAÍDA exige, e nada mais:
  --
  --   (a) `assigned_at` na janela — é o predicado de `conversations_handled` e
  --       de `sem_resposta`, que já existia no `count(*) filter`;
  --   (b) mensagem humana de saída na janela — é o caso necessário de
  --       `first_human_out >= p_from and < p_to`: toda conversa cuja 1ª
  --       resposta humana cai na janela TEM uma mensagem humana de saída na
  --       janela, porque a 1ª é uma delas.
  --
  -- Linha que fica de fora não movia nenhum número: contagem 0, vazamento 0,
  -- média nula. Ela só pagava o lateral. O `UNION` deduplica as que são as duas
  -- coisas ao mesmo tempo.
  --
  -- Custos cobertos por índice que já existe, um para cada ramo:
  -- `idx_conversations_org_assignee_assigned` (0037) em (a) e
  -- `idx_messages_org_direction_sent` (0133) em (b).
  candidatas as (
    -- (a) recorte da contagem e do vazamento: janela semiaberta em
    -- `assigned_at`, com o resto dos predicados do `conv_agg` da irmã — são os
    -- mesmos que o `where` de `conversas` já exige, e juntos casam com o índice.
    select c.id
    from public.conversations c
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and c.channel_session_id is not null
      and c.assigned_at >= p_from and c.assigned_at < p_to
      and (p_owner is null or c.assigned_to_user_id = p_owner)
    union
    -- (b) recorte da média: 1ª resposta humana na janela.
    select c.id
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where m.organization_id = p_org
      and m.direction = 'outbound'
      and m.sent_by_user_id is not null
      and m.sent_at >= p_from
      and m.sent_at < p_to
  ),
  -- Uma linha por conversa na régua de ATRIBUIÇÃO da irmã (0037 §6.5).
  -- O lateral e o seu `where` estão intactos: o que mudou é que ele roda para as
  -- candidatas, e não para a organização inteira.
  conversas as (
    select
      c.channel_session_id as channel_session_id,
      c.channel as channel,
      c.assigned_at as assigned_at,
      fr.first_in,
      fr.first_human_out
    from public.conversations c
    join candidatas k on k.id = c.id
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
      and c.channel_session_id is not null
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
  ),
  -- Uma linha por canal: volume, 1ª resposta humana e vazamento no MESMO
  -- `group by`, para a soma nunca divergir da média.
  canais as (
    select
      c.channel_session_id,
      -- O tipo é constante por sessão (0027/0368): `max()` agrupa uma coluna
      -- funcionalmente dependente, não inventa valor.
      max(c.channel) as channel,
      -- Critério 1: volume por canal, janela semiaberta em `assigned_at`.
      count(*) filter (
        where c.assigned_at >= p_from and c.assigned_at < p_to
      ) as conversations_handled,
      -- Critério 3: o vazamento — conversa da janela que NUNCA teve 1ª resposta
      -- humana. Conta aqui e só aqui; nunca mexe na média.
      count(*) filter (
        where c.assigned_at >= p_from and c.assigned_at < p_to
          and c.first_human_out is null
      ) as sem_resposta,
      -- Critérios 2 e 4: a MESMA fórmula da irmã — bot fora e `t1 <= t0`
      -- descartado. Sem par válido a média fica `null` (não medida), nunca 0.
      avg(extract(epoch from (c.first_human_out - c.first_in))) filter (
        where c.first_in is not null
          and c.first_human_out is not null
          and c.first_human_out > c.first_in
          and c.first_human_out >= p_from and c.first_human_out < p_to
      ) as avg_first_response_seconds
    from conversas c
    group by c.channel_session_id
  )
  select jsonb_build_object(
    'channels', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'channel_session_id', k.channel_session_id,
          'channel_name', coalesce(cs.phone_number, cs.display_name, cs.waha_session_name),
          'channel', k.channel,
          'is_archived', (cs.archived_at is not null),
          'conversations_handled', k.conversations_handled,
          'avg_first_response_seconds', k.avg_first_response_seconds,
          'sem_resposta', k.sem_resposta
        ) order by k.conversations_handled desc, k.channel_session_id
      )
      from canais k
      left join public.channel_sessions cs on cs.id = k.channel_session_id
      -- Critério 5: canal sem atividade na janela não é linha, é ruído — a
      -- resposta sem dado é `[]` e a tela diz "Sem atividade no período".
      where k.conversations_handled > 0
         or k.sem_resposta > 0
         or k.avg_first_response_seconds is not null
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.fn_channel_metrics(uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function public.fn_channel_metrics(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public.fn_channel_metrics(uuid, timestamptz, timestamptz, uuid)
  to authenticated, service_role;
