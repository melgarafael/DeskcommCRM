-- O vocabulário de etiquetas deixa de ser só de LEITURA.
--
-- A 0244 (issue #852, fatia S1) fez o seletor do Inbox oferecer as etiquetas que
-- existem. O que faltava era a outra metade: até aqui a etiqueta só ENTRAva no
-- vocabulário. Cada agente escrevia em `add_tag` a etiqueta que o prompt dele
-- mandasse, e ninguém tinha por onde corrigir. Medido numa instalação real, a
-- operação acumulou as TRÊS versões da mesma ideia — "Cliente Novo",
-- "cliente novo" e "novo-cliente" — e o resultado não era cosmético: o filtro
-- da lista de conversas separava em três grupos a mesma carteira, e o agente
-- continuava escrevendo a grafia velha porque a regra dele não sabia da nova.
--
-- ─── o que esta migration entrega ─────────────────────────────────────────────
--
-- (1) `fn_vocabulario_de_tags(p_org)`: o vocabulário COM O USO, por tabela.
--     A tela precisa responder "onde esta etiqueta está" antes de mexer nela —
--     a lista de 0244 diz quais existem, não quanto pesam.
--
-- (2) `fn_tags_normalizar(tags, de, para, remover)`: função PURA (immutable,
--     sem tabela) que renomeia/junta/exclui numa lista de etiquetas, ordenando
--     e desduplicando por nome canônico. É o que impede a junção de virar
--     duplicata (`{"a","b"}` + renomear b→a tem de dar `{"a"}`, não `{"a","a"}`).
--
-- (3) `fn_vocabulario_de_tags_operar(p_org, acao, tag, destino)`: a operação
--     inteira numa transação — os três arrays (`contacts.tags`,
--     `crm_leads.tags`, `conversations.tags`), as sementes da organização
--     (`settings.tags` e `settings.canonical_conversation_tags`) e os
--     `add_tag` dos agentes (`automation_rules.actions`). É ESTE o ponto da
--     issue: renomear a etiqueta sem corrigir a regra do agente deixa o agente
--     escrevendo a etiqueta que acabou de sair do vocabulário, e a tela que
--     existe para arrumar vira fábrica de lixo novo. Como é uma chamada só,
--     não existe estado intermediário: ou tudo muda, ou nada muda.
--
-- ─── por que função de banco, e não rota que faz UPDATE em laço ───────────────
--
-- PostgREST não expressa `unnest` + `array_agg` (o rename de array é linha a
-- linha), não faz `UPDATE` em três tabelas mais `jsonb_set` em automação com
-- atomicidade garantida, e não tem transação de rota. Um laço no servidor
-- serrilhado em 6 chamadas deixaria, na falha do meio, contato renomeado com
-- regra de agente ainda apontando para o nome velho — exatamente o defeito que
-- a issue descreve.
--
-- ─── ⛔ security DEFINER na escrita, e por que aqui é o contrário da 0244 ─────
--
-- `fn_tags_de_conversa_em_uso` (0244) é INVOKER porque é leitura e a RLS isola.
-- Esta não pode ser: quem escreve precisa alcançar `automation_rules` e a linha
-- de `organizations` do DONO da regra — o manager da organização. Um manager
-- comum não tem policy de escrita em `organizations` (é do admin), então invoker
-- faria a tela salvar metade e falhar a outra metade com um erro de RLS que o
-- operador não entende. Definer é o que torna a operação inteira atômica de
-- fato.
--
-- O que a torna segura: `auth.uid()` tem de passar em
-- `fn_role_at_least(p_org, 'manager')` ANTES de qualquer escrita, e a exceção
-- (`42501`, `insufficient_role`) é a mesma das irmãs — a rota mapeia para 403.
-- O `p_org` deixa de ser fronteira e vira filtro: quem chamar com a organização
-- de outro tenant é recusado pelo banco, não pela rota.
--
-- ⚠️ Consequência de gate: definer VOLÁTIL concedida a `authenticated` cai em
-- `tests/invariants/hardening-definer-varredura.test.ts`; entra em
-- `AUTHENTICATED_PERMITIDO` com o call site nomeado (a rota deste PR).
-- `tests/invariants/tags-vocabulario.test.ts` prova o que a exceção declara:
-- viewer/agent/anon recusados, cross-tenant sem efeito, e a junção sem
-- duplicata.
--
-- Sem coluna nova, sem constraint, sem backfill: o vocabulário continua sendo
-- jsonb em `organizations.settings` + os arrays que já existem. Índice: nenhum
-- novo — a leitura usa `idx_conversations_tags_gin` (0244) e varre `contacts` e
-- `crm_leads` por `organization_id`, que já têm índice.

-- ─── 1. leitura: o vocabulário e quanto cada etiqueta pesa ───────────────────

create or replace function public.fn_vocabulario_de_tags(p_org uuid)
returns table (
  tag text,
  uso_em_contatos bigint,
  uso_em_leads bigint,
  uso_em_conversas bigint,
  em_regras bigint,
  cor text,
  descricao text,
  no_vocabulario boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with vocabulario as (
    -- A organização pode guardar o vocabulário de dois jeitos, e os dois contam:
    -- `tags` (a lista com cor e descrição, vinda da tela) e
    -- `canonical_conversation_tags` (as sementes, que a 0244 já usava).
    select
      nullif(btrim(coalesce(entrada.valor ->> 'tag', entrada.valor #>> '{}')), '') as tag,
      nullif(btrim(coalesce(entrada.valor ->> 'cor', '')), '') as cor,
      nullif(btrim(coalesce(entrada.valor ->> 'descricao', '')), '') as descricao
    from public.organizations o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.settings -> 'tags') = 'array'
           then o.settings -> 'tags' else '[]'::jsonb end
    ) as entrada(valor)
    where o.id = p_org
    union all
    select nullif(btrim(coalesce(semente #>> '{}', '')), ''), null, null
    from public.organizations o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.settings -> 'canonical_conversation_tags') = 'array'
           then o.settings -> 'canonical_conversation_tags' else '[]'::jsonb end
    ) as semente(valor)
    where o.id = p_org
  ),
  vocabulario_limpo as (
    -- Uma linha por nome canônico. Se a lista curada tem cor/descrição, ela vence
    -- a semente crua.
    select distinct on (lower(v.tag))
           v.tag, v.cor, v.descricao
    from vocabulario v
    where v.tag is not null
    order by lower(v.tag), (v.cor is not null or v.descricao is not null) desc
  ),
  uso as (
    select nullif(btrim(t.valor), '') as tag, 'contatos' as origem
    from public.contacts c, unnest(coalesce(c.tags, '{}'::text[])) as t(valor)
    where c.organization_id = p_org
    union all
    select nullif(btrim(t.valor), ''), 'leads'
    from public.crm_leads l, unnest(coalesce(l.tags, '{}'::text[])) as t(valor)
    where l.organization_id = p_org
    union all
    select nullif(btrim(t.valor), ''), 'conversas'
    from public.conversations v, unnest(coalesce(v.tags, '{}'::text[])) as t(valor)
    where v.organization_id = p_org
  ),
  uso_limpo as (
    select u.tag, u.origem from uso u where u.tag is not null and u.tag <> ''
  ),
  regras as (
    -- As ações `add_tag` dos agentes. É o que o operador NÃO via: a etiqueta
    -- podia ter zero conversas e ainda estar sendo escrita amanhã pela regra.
    -- `r.id` junto: a coluna "Regras de agente" da tela conta REGRAS, e a
    -- exclusão (mais abaixo) conta `distinct r.id`. Sem o id aqui, uma regra com
    -- duas ações `add_tag` da mesma etiqueta aparecia como "2" na lista e como
    -- "1" no resultado da operação — o mesmo rótulo contando coisas diferentes.
    select r.id as regra_id, nullif(btrim(etiqueta.valor #>> '{}'), '') as tag
    from public.automation_rules r
    cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) as acao(valor)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(acao.valor -> 'config' -> 'tags') = 'array'
           then acao.valor -> 'config' -> 'tags' else '[]'::jsonb end
    ) as etiqueta(valor)
    where r.organization_id = p_org
      and acao.valor ->> 'type' = 'add_tag'
  ),
  regras_limpo as (
    select r.regra_id, r.tag from regras r where r.tag is not null and r.tag <> ''
  ),
  bruto as (
    select tag from vocabulario_limpo
    union all select tag from uso_limpo
    union all select tag from regras_limpo
  ),
  todas as (
    select min(b.tag) as tag, lower(b.tag) as chave
    from bruto b
    where b.tag is not null
    group by lower(b.tag)
  )
  select
    coalesce(v.tag, t.tag) as tag,
    (select count(*) from uso_limpo u
      where lower(u.tag) = t.chave and u.origem = 'contatos') as uso_em_contatos,
    (select count(*) from uso_limpo u
      where lower(u.tag) = t.chave and u.origem = 'leads')    as uso_em_leads,
    (select count(*) from uso_limpo u
      where lower(u.tag) = t.chave and u.origem = 'conversas') as uso_em_conversas,
    (select count(distinct r.regra_id) from regras_limpo r
      where lower(r.tag) = t.chave)                           as em_regras,
    v.cor,
    v.descricao,
    (v.tag is not null)                                       as no_vocabulario
  from todas t
  left join vocabulario_limpo v on lower(v.tag) = t.chave
  order by t.chave
  -- Teto, como na 0244: numa organização bagunçada a união cresce sem limite e
  -- isto vai para uma tela.
  limit 500;
$$;

-- ─── 2. o rename/junção/exclusão numa lista de etiquetas ─────────────────────

create or replace function public.fn_tags_normalizar(
  p_tags text[],
  p_de text,
  p_para text,
  p_remover boolean
)
returns text[]
language sql
immutable
security invoker
set search_path = public
as $$
  -- `distinct on` pela chave canônica DO RESULTADO, e não da entrada.
  --
  -- ⚠️ Deduplicar pela entrada parece a mesma coisa e não é: no `juntar`, os dois
  -- nomes têm chaves DIFERENTES por definição (é o que os torna duas etiquetas),
  -- e depois da substituição viram o MESMO nome. Medido num Postgres real:
  -- `{VIP, obra}` juntando `obra` em `VIP` devolvia `{VIP, VIP}` — a etiqueta
  -- duplicada no array, e `fn_vocabulario_de_tags` conta OCORRÊNCIAS, então o
  -- registro passava a pesar 2 na própria tela que deveria arrumá-lo. O caso
  -- `{vip, VIP}` do teste passava por acidente: ali as duas chaves já eram
  -- iguais ANTES da substituição.
  select coalesce(array_agg(n.tag order by n.ord), '{}'::text[])
  from (
    select distinct on (lower(s.tag)) s.tag, s.ord
    from (
      select case
               when p_remover then null
               when lower(btrim(e.valor)) = lower(btrim(coalesce(p_de, ''))) then btrim(p_para)
               else btrim(e.valor)
             end as tag,
             e.ord
      from unnest(coalesce(p_tags, '{}'::text[])) with ordinality as e(valor, ord)
      where btrim(coalesce(e.valor, '')) <> ''
    ) s
    where s.tag is not null and s.tag <> ''
    order by lower(s.tag), s.ord
  ) as n;
$$;

-- ─── 3. a operação: tudo numa transação, regra do agente incluída ────────────

create or replace function public.fn_vocabulario_de_tags_operar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tag     text := btrim(coalesce(p_tag, ''));
  v_destino text := btrim(coalesce(p_destino, ''));
  v_remover boolean;
  v_contatos integer := 0;
  v_leads integer := 0;
  v_conversas integer := 0;
  v_regras integer := 0;
  v_id uuid;
  v_ids uuid[];
  v_settings jsonb;
  v_antes jsonb;
  v_depois jsonb;
  v_definido boolean := false;
begin
  -- Portão de papel ANTES de qualquer escrita. Definer com p_org vindo da rota:
  -- é esta linha que separa o tenant de quem chama.
  if p_org is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_acao is null or p_acao not in ('renomear', 'juntar', 'excluir') then
    raise exception using errcode = '22023', message = 'acao_invalida';
  end if;
  if v_tag = '' then
    raise exception using errcode = '22023', message = 'tag_obrigatoria';
  end if;
  v_remover := (p_acao = 'excluir');
  if not v_remover and v_destino = '' then
    raise exception using errcode = '22023', message = 'destino_obrigatorio';
  end if;

  -- ── POR QUE NÃO SAI EVENTO DAQUI ──────────────────────────────────────────
  --
  -- Os laços abaixo CONTAM as linhas alteradas e não emitem nada em `event_log`.
  -- A primeira versão emitia `contact.tags_changed` / `lead.tags_changed` /
  -- `conversation.tags_changed` POR LINHA, e nenhum desses tipos tem consumidor:
  -- `lib/event-log/register-handlers.ts` registra 13 handlers e nenhum os
  -- declara; o motor de automação ouve `lead.tag_added`/`contact.tag_added`, que
  -- é outro tipo (e disparar automação num renomear em lote seria pior que não
  -- disparar). Evento sem consumidor é o anti-pattern 3 do CLAUDE.md, e aqui
  -- custava milhares de linhas dentro de UMA transação, num log que nada drena e
  -- nada expurga.
  --
  -- Quem registra a operação é o AUDIT LOG, na borda: `tag_vocabulary.changed`
  -- em `app/api/v1/tags/vocabulario/route.ts`, com os contadores que este corpo
  -- devolve. E a tela aberta se atualiza pelo Realtime das próprias tabelas.

  -- (a) contatos
  for v_id in
    with alvo as (
      select c.id, public.fn_tags_normalizar(c.tags, v_tag, v_destino, v_remover) as novas
      from public.contacts c
      where c.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(c.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.contacts c
         set tags = a.novas
        from alvo a
       where c.id = a.id
         and c.tags is distinct from a.novas
      returning c.id
    )
    select id from mudou
  loop
    v_contatos := v_contatos + 1;
  end loop;

  -- (b) leads
  for v_id in
    with alvo as (
      select l.id, public.fn_tags_normalizar(l.tags, v_tag, v_destino, v_remover) as novas
      from public.crm_leads l
      where l.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(l.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.crm_leads l
         set tags = a.novas
        from alvo a
       where l.id = a.id
         and l.tags is distinct from a.novas
      returning l.id
    )
    select id from mudou
  loop
    v_leads := v_leads + 1;
  end loop;

  -- (c) conversas
  for v_id in
    with alvo as (
      select v.id, public.fn_tags_normalizar(v.tags, v_tag, v_destino, v_remover) as novas
      from public.conversations v
      where v.organization_id = p_org
        and exists (
          select 1 from unnest(coalesce(v.tags, '{}'::text[])) as x(valor)
          where lower(btrim(x.valor)) = lower(v_tag)
        )
    ), mudou as (
      update public.conversations v
         set tags = a.novas
        from alvo a
       where v.id = a.id
         and v.tags is distinct from a.novas
      returning v.id
    )
    select id from mudou
  loop
    v_conversas := v_conversas + 1;
  end loop;

  -- (d) as regras dos agentes — o ponto da issue.
  --
  -- `excluir` NÃO apaga a regra: quem exclui a etiqueta é avisado de quantas
  -- regras a escrevem (o número volta no jsonb e a tela pede confirmação), mas
  -- apagar `add_tag` de um agente em produção é decisão de outra tela. Aqui a
  -- lista da regra só é reescrita quando o nome muda ou quando ele sai.
  select coalesce(o.settings, '{}'::jsonb) into v_settings
  from public.organizations o where o.id = p_org;

  if v_settings is null then
    v_settings := '{}'::jsonb;
  end if;

  if not v_remover then
    with alvo as (
      select r.id,
             jsonb_agg(
               case
                 when a.valor ->> 'type' = 'add_tag'
                  and jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
                 then jsonb_set(
                        a.valor,
                        '{config,tags}',
                        to_jsonb(public.fn_tags_normalizar(
                          array(select jsonb_array_elements_text(a.valor -> 'config' -> 'tags')),
                          v_tag, v_destino, false
                        ))
                      )
                 else a.valor
               end
               order by a.ord
             ) as novas
      from public.automation_rules r
      cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb))
        with ordinality as a(valor, ord)
      where r.organization_id = p_org
      -- ⚠️ `group by r.id` E SÓ. Agrupar também pelo TIPO da ação devolvia uma
      -- linha por (regra, tipo), cada uma com `novas` = só o subconjunto daquele
      -- tipo; o `update ... from alvo` casava as duas linhas, o Postgres usava
      -- UMA arbitrária, e `is distinct from` é sempre verdadeiro num subconjunto
      -- — então a regra com ações de dois tipos era TRUNCADA a um tipo só, em
      -- toda organização, mesmo que ela nunca tenha citado a etiqueta renomeada.
      -- Medido num Postgres real: regra com `add_tag` + `assign_owner` ficava com
      -- uma ação, e a tela dizia "atualizada em 1 regra(s) de agente".
      group by r.id
    ), mudou as (
      update public.automation_rules r
         set actions = alvo.novas,
             updated_at = now()
        from alvo
       where r.id = alvo.id
         and r.actions is distinct from alvo.novas
      returning r.id
    )
    select count(*) into v_regras from mudou;
  else
    -- Exclusão: conta as regras que ainda escrevem a etiqueta, sem tocar nelas.
    select count(distinct r.id) into v_regras
    from public.automation_rules r
    cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) as a(valor)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
           then a.valor -> 'config' -> 'tags' else '[]'::jsonb end
    ) as e(valor)
    where r.organization_id = p_org
      and a.valor ->> 'type' = 'add_tag'
      and lower(btrim(e.valor #>> '{}')) = lower(v_tag);
  end if;

  -- (e) o vocabulário da organização, nos dois lugares onde ele mora.
  v_antes := coalesce(v_settings -> 'tags', '[]'::jsonb);
  v_depois := coalesce(
    (
      select jsonb_agg(entrada.valor order by entrada.ord)
      from (
        -- Dedupe pela chave DEPOIS da substituição (mesma razão de
        -- `fn_tags_normalizar`): juntar duas entradas de chaves diferentes num
        -- nome só deixava as duas no vocabulário, agora com o mesmo `tag`.
        select distinct on (lower(x.chave)) x.valor, x.ord
        from (
          select case
                   when v_remover then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                   else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                 end as chave,
                 case
                   when v_remover then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then jsonb_set(
                            case when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', e.valor #>> '{}')
                                 else e.valor end,
                            '{tag}', to_jsonb(v_destino))
                   else case when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', e.valor #>> '{}')
                             else e.valor end
                 end as valor,
                 e.ord
          from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
          where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
        ) x
        where x.valor is not null and coalesce(x.chave, '') <> ''
        order by lower(x.chave), x.ord
      ) as entrada
      where entrada.valor is not null
    ),
    '[]'::jsonb
  );
  if v_depois <> v_antes then
    v_settings := jsonb_set(v_settings, '{tags}', v_depois);
    v_definido := true;
  end if;

  v_antes := coalesce(v_settings -> 'canonical_conversation_tags', '[]'::jsonb);
  v_depois := coalesce(
    (
      select jsonb_agg(semente.valor order by semente.ord)
      from (
        -- Dedupe pela chave DEPOIS da substituição, como acima.
        select distinct on (lower(y.valor)) y.valor, y.ord
        from (
          select case
                   when v_remover then null
                   when lower(btrim(s.valor #>> '{}')) = lower(v_tag) then v_destino
                   else btrim(s.valor #>> '{}')
                 end as valor,
                 s.ord
          from jsonb_array_elements(v_antes) with ordinality as s(valor, ord)
          where btrim(s.valor #>> '{}') <> ''
        ) y
        where coalesce(y.valor, '') <> ''
        order by lower(y.valor), y.ord
      ) as semente
      where semente.valor is not null
    ),
    '[]'::jsonb
  );
  if v_depois <> v_antes then
    v_settings := jsonb_set(v_settings, '{canonical_conversation_tags}', v_depois);
    v_definido := true;
  end if;

  if v_definido then
    update public.organizations o
       set settings = v_settings,
           updated_at = now()
     where o.id = p_org;
  end if;

  return jsonb_build_object(
    'acao', p_acao,
    'tag', v_tag,
    'destino', nullif(v_destino, ''),
    'contatos', v_contatos,
    'leads', v_leads,
    'conversas', v_conversas,
    'regras', v_regras,
    'alterou', (v_contatos + v_leads + v_conversas + v_regras > 0 or v_definido)
  );
end;
$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (CLAUDE.md):
-- (A) o `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do baseline,
--     que vale para toda função criada depois dele e que `revoke from public` NÃO
--     remove;
-- (B) o grant a PUBLIC que o Postgres dá a qualquer função ao criá-la, que
--     `revoke from anon` NÃO remove.
-- Tratar só uma deixa a função alcançável pela anon key, que vai para o browser.
revoke execute on function public.fn_vocabulario_de_tags(uuid) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags(uuid) to authenticated, service_role;

revoke execute on function public.fn_tags_normalizar(text[], text, text, boolean) from public, anon;
grant  execute on function public.fn_tags_normalizar(text[], text, text, boolean) to authenticated, service_role;

-- A de escrita é definer e volátil: `authenticated` chama pela sessão do usuário
-- (POST app/api/v1/tags/vocabulario/route.ts, com createClient de cookie), e por
-- isso está declarada em AUTHENTICATED_PERMITIDO no gate
-- tests/invariants/hardening-definer-varredura.test.ts — a exceção nomeia o call
-- site, não abre a porta.
revoke execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text) to authenticated, service_role;
