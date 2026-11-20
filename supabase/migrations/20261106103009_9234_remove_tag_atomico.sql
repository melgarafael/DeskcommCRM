-- manifest: **Ação de automação `remove_tag`: tirar etiqueta do negócio ou do contato, atômico no banco.** Funções `fn_lead_remover_etiquetas` e `fn_contato_remover_etiquetas`, irmãs das `fn_*_adicionar_etiquetas` da 0682: a lista é refeita DENTRO do `UPDATE` (`with ordinality`, preserva a ordem das que ficam), então dois eventos concorrentes do mesmo negócio ou contato — um em cada dreno do `event_log` — não devolvem a etiqueta que o outro tirou nem apagam a que o outro pôs. A comparação é pela chave canônica (`lower(btrim(...))`), a mesma do `excluir` do vocabulário (0264/0673): tirar "VIP" tira "vip". `security definer`, `EXECUTE` só para `service_role`, `revoke` de `public`, `anon` e `authenticated`; linha de outra organização devolve nulo e não é tocada. **Etiqueta renomeada acompanha a regra que tira:** `fn_vocabulario_de_tags`, `_pagina` e `_operar` passam a enxergar `remove_tag` além de `add_tag`, tanto para reescrever a regra no renomear e no juntar quanto para contar as regras citadas na tela e no aviso de exclusão, que continua sem apagar regra.

-- ---- o remove_tag tira no UPDATE, sob a trava da linha (migration 9234) ----
-- A irmã da 0682 no sentido contrário: a ação `remove_tag` das automações.
--
-- ─── Por que uma função, e por que dentro do UPDATE ────────────────────────
--
-- Mesma corrida da 0682: o `event_log` tem dois drenos concorrentes (o laço do
-- worker e o cron `event-log-drain`) e o claim é por LINHA, não por negócio.
-- Tirar a etiqueta lendo a lista no app e gravando a lista menos as pedidas
-- seria repetir o defeito da #2888 do outro lado: a gravação de um dreno
-- devolveria a etiqueta que o outro acabou de tirar, ou apagaria a que o outro
-- acabou de pôr. Numa única instrução `UPDATE`, em READ COMMITTED, quem chega
-- depois espera o commit da linha e recalcula sobre a versão vigente.
--
-- O PostgREST não sabe dizer `tags = tags menos estas`: só manda um valor
-- pronto. Daí a função, como a 0682 e a 0502.
--
-- ─── A comparação é pela chave canônica ───────────────────────────────────
--
-- `lower(btrim(etiqueta))`, a mesma do `excluir` do vocabulário (0264/0673).
-- A etiqueta do contato é guardada normalizada (#1224) e a do card pode estar em
-- caixa mista; quem configura "VIP" quer tirar "vip". Tirar nunca cria variante,
-- então casar pela chave não tem o risco que casar teria no `add_tag`.
--
-- Elemento nulo ou só espaço no pedido é descartado ANTES: `x = any(array['a',
-- null])` dá nulo para quem não casa, e o `not (...)` descartaria a etiqueta.
--
-- ─── A leitura sob a TRAVA ────────────────────────────────────────────────
--
-- Como na 0682, o `select ... for update` não é o que conserta a corrida (quem
-- conserta é o `UPDATE`); ele responde QUAIS etiquetas esta chamada tirou
-- (`removidas`), que é o que a ação grava no detalhe da execução. Nada a tirar =
-- nada gravado, e `updated_at` não muda.
--
-- ─── O que estas funções NÃO fazem ─────────────────────────────────────────
--
-- Não decidem papel nem organização (é de quem chama: a ação roda no dreno, com
-- o client de serviço, e `p_org` vem do evento); o filtro por `organization_id`
-- é defesa em profundidade e faz linha de outra organização devolver nulo. Não
-- emitem evento: não existe gatilho `*.tag_removed`, e evento sem consumidor é
-- o anti-pattern 3 do CLAUDE.md.
--
-- Idempotente: `create or replace`, `revoke`/`grant` reaplicáveis. Sem tabela,
-- coluna, policy ou dado a corrigir.

create or replace function public.fn_lead_remover_etiquetas(
  p_org uuid,
  p_lead uuid,
  p_etiquetas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_chaves    text[];
  v_antes     text[];
  v_removidas text[];
  v_depois    text[];
begin
  v_chaves := array(
    select distinct lower(btrim(x))
      from unnest(coalesce(p_etiquetas, '{}'::text[])) as x
     where x is not null and btrim(x) <> ''
  );
  if cardinality(v_chaves) = 0 then
    raise exception 'etiquetas_vazio' using errcode = '22023';
  end if;

  -- A PRÉ-IMAGEM SOB A TRAVA (é o relatório, não a remoção). Sem linha — lead
  -- inexistente OU de outra organização — devolve nulo.
  select coalesce(tags, '{}'::text[])
    into v_antes
    from public.crm_leads
   where organization_id = p_org and id = p_lead
     for update;
  if not found then
    return null;
  end if;

  v_removidas := array(
    select t.etiqueta
      from unnest(v_antes) with ordinality as t(etiqueta, ordem)
     where lower(btrim(t.etiqueta)) = any (v_chaves)
     order by t.ordem
  );

  if cardinality(v_removidas) = 0 then
    return jsonb_build_object('tags', to_jsonb(v_antes), 'removidas', '[]'::jsonb);
  end if;

  -- UMA instrução: a lista é refeita sobre a linha vigente.
  update public.crm_leads
     set tags = array(
           select t.etiqueta
             from unnest(coalesce(tags, '{}'::text[])) with ordinality as t(etiqueta, ordem)
            where t.etiqueta is null or not (lower(btrim(t.etiqueta)) = any (v_chaves))
            order by t.ordem
         ),
         updated_at = now()
   where organization_id = p_org and id = p_lead
   returning tags into v_depois;

  return jsonb_build_object(
    'tags', to_jsonb(coalesce(v_depois, '{}'::text[])),
    'removidas', to_jsonb(v_removidas)
  );
end
$fn$;

create or replace function public.fn_contato_remover_etiquetas(
  p_org uuid,
  p_contato uuid,
  p_etiquetas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_chaves    text[];
  v_antes     text[];
  v_removidas text[];
  v_depois    text[];
begin
  -- Irmã da de cima, na tabela do CONTATO (destino `contato`). Corpo idêntico
  -- trocando a tabela e o nome do parâmetro.
  v_chaves := array(
    select distinct lower(btrim(x))
      from unnest(coalesce(p_etiquetas, '{}'::text[])) as x
     where x is not null and btrim(x) <> ''
  );
  if cardinality(v_chaves) = 0 then
    raise exception 'etiquetas_vazio' using errcode = '22023';
  end if;

  select coalesce(tags, '{}'::text[])
    into v_antes
    from public.contacts
   where organization_id = p_org and id = p_contato
     for update;
  if not found then
    return null;
  end if;

  v_removidas := array(
    select t.etiqueta
      from unnest(v_antes) with ordinality as t(etiqueta, ordem)
     where lower(btrim(t.etiqueta)) = any (v_chaves)
     order by t.ordem
  );

  if cardinality(v_removidas) = 0 then
    return jsonb_build_object('tags', to_jsonb(v_antes), 'removidas', '[]'::jsonb);
  end if;

  update public.contacts
     set tags = array(
           select t.etiqueta
             from unnest(coalesce(tags, '{}'::text[])) with ordinality as t(etiqueta, ordem)
            where t.etiqueta is null or not (lower(btrim(t.etiqueta)) = any (v_chaves))
            order by t.ordem
         ),
         updated_at = now()
   where organization_id = p_org and id = p_contato
   returning tags into v_depois;

  return jsonb_build_object(
    'tags', to_jsonb(coalesce(v_depois, '{}'::text[])),
    'removidas', to_jsonb(v_removidas)
  );
end
$fn$;

-- As DUAS origens de EXECUTE (o grant a PUBLIC da criação e o `ALTER DEFAULT
-- PRIVILEGES` do baseline) — mesma razão da 0682: estas funções ESCREVEM.
revoke execute on function public.fn_lead_remover_etiquetas(uuid, uuid, text[]) from public, anon, authenticated;
revoke execute on function public.fn_contato_remover_etiquetas(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.fn_lead_remover_etiquetas(uuid, uuid, text[]) to service_role;
grant execute on function public.fn_contato_remover_etiquetas(uuid, uuid, text[]) to service_role;

comment on function public.fn_lead_remover_etiquetas(uuid, uuid, text[]) is
  'Tira etiquetas do negócio DENTRO do UPDATE, numa única instrução atômica, casando pela chave canônica, e devolve as etiquetas gravadas e as removidas. '
  'Irmã de fn_lead_adicionar_etiquetas (0682). Não decide papel nem organização — isso é de quem chama.';
comment on function public.fn_contato_remover_etiquetas(uuid, uuid, text[]) is
  'Tira etiquetas do contato DENTRO do UPDATE, numa única instrução atômica. '
  'Mesmo desenho de fn_lead_remover_etiquetas, no destino `contato` da remove_tag.';

-- ---- o vocabulário de etiquetas enxerga a remove_tag (migration 9234) ----
-- Renomear ou juntar uma etiqueta reescrevia só as regras `add_tag`: a regra
-- que TIRA a etiqueta ficava com o nome velho e, em silêncio, parava de achar o
-- que devia tirar. As três funções partem da ÚLTIMA definição de cada uma; o que
-- muda é `= 'add_tag'` virar `in ('add_tag', 'remove_tag')`, nos dois lados: a
-- escrita (`_operar`) e as contagens (`_operar` na exclusão, `_pagina` e a
-- antiga `fn_vocabulario_de_tags`). A exclusão continua sem apagar regra nenhuma.
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
    -- As ações `add_tag` e `remove_tag` dos agentes. É o que o operador NÃO via: a etiqueta
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
      and acao.valor ->> 'type' in ('add_tag', 'remove_tag')
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

revoke execute on function public.fn_vocabulario_de_tags(uuid) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags(uuid) to authenticated, service_role;

create or replace function public.fn_vocabulario_de_tags_operar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text,
  p_cor text default null
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
  -- A cor entra normalizada (minúscula, sem espaço). A rota valida com Zod antes;
  -- esta linha defende o caminho que NÃO passa por ela — RPC direta, psql, um
  -- cliente futuro. Sem isso, `#FFF` gravaria e a comparação por igualdade da
  -- tela (que compara o que o servidor devolveu) passaria a mentir.
  v_cor     text := lower(btrim(coalesce(p_cor, '')));
  -- ── A RÉGUA DO MARCADOR, DERIVADA UMA VEZ (issue #3507) ────────────────────
  --
  -- `contacts.tags` e `conversations.tags` guardam a etiqueta em minúscula:
  -- `normalizarTag` (`lib/contacts/tag-normalizada.ts`, issue #1224, migrations
  -- 0324/0335) e `conversationTagSchema` (`.trim().toLowerCase()`,
  -- `lib/schemas/messaging.ts`), e é nessa forma que o filtro `?tag=` consulta.
  -- `v_destino` é o NOME DE EXIBIÇÃO e vai como foi digitado para o
  -- vocabulário, para as sementes de conversa, para as regras dos agentes e
  -- para `crm_leads.tags` (caixa mista aceita) — esta é a forma das DUAS
  -- colunas que são minúscula POR CONTRATO, e ela é `lower(btrim(...))`: a
  -- MESMA expressão com que `fn_tags_normalizar` compara o valor de origem e
  -- com que a 0335 normalizou o marcador já gravado.
  --
  -- ⚠️ Não vai para `fn_tags_normalizar`: aquela função também atende
  -- `crm_leads.tags`, que aceita caixa mista. A caixa é decisão de quem escreve
  -- na coluna que a exige, e são duas.
  --
  -- ⚠️ O TETO DE 40 DA RÉGUA NÃO ENTRA AQUI de propósito: `tagSchema` aceita 60
  -- (`TAG_MAX`) para o nome de exibição, e cortar o destino às escuras trocaria
  -- a caixa por um nome TRUNCADO — outra classe de defeito, com perda de dado.
  -- A divergência de teto entre a coluna (40, `TAMANHO_MAXIMO_DA_TAG`) e o
  -- vocabulário (60) fica declarada, não resolvida por um renomear.
  v_destino_minusculo text := lower(btrim(coalesce(p_destino, '')));
  v_remover boolean;
  v_so_cor  boolean;
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
  -- (e0) 'duas entradas do vocabulário viraram uma' — issue #2801.
  v_juntou boolean := false;
begin
  -- Portão de papel ANTES de qualquer escrita. Definer com p_org vindo da rota:
  -- é esta linha que separa o tenant de quem chama.
  if p_org is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_acao is null or p_acao not in ('renomear', 'juntar', 'excluir', 'definir_cor') then
    raise exception using errcode = '22023', message = 'acao_invalida';
  end if;
  if v_tag = '' then
    raise exception using errcode = '22023', message = 'tag_obrigatoria';
  end if;
  v_remover := (p_acao = 'excluir');
  v_so_cor  := (p_acao = 'definir_cor');
  if not v_remover and not v_so_cor and v_destino = '' then
    raise exception using errcode = '22023', message = 'destino_obrigatorio';
  end if;
  -- `v_cor` vazio é pedido legítimo ("sem cor"): limpa. O que não passa é cor
  -- malformada — gravar `#12` e devolver `#12` para a tela pintar deixaria o
  -- chip sem cor sem ninguém saber por quê.
  if v_so_cor and v_cor <> '' and v_cor !~ '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'cor_invalida';
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

  -- ── (z) A COR SAI ANTES DOS LAÇOS, E NÃO É OTIMIZAÇÃO ─────────────────────
  --
  -- Cor é atributo do VOCABULÁRIO, não das linhas: `contacts.tags`,
  -- `crm_leads.tags` e `conversations.tags` continuam `text[]` de nomes, porque
  -- automação, webhook (`lead.tag_added`) e MCP (`*.tags_changed`) falam em
  -- string há versões (contrato da fatia S4). Então a ação `definir_cor` não tem
  -- o que reescrever em contatos, leads nem conversas — e os laços abaixo, se
  -- rodassem, custariam uma varredura das três tabelas para devolver zero.
  --
  -- O bloco de `canonical_conversation_tags` (mais abaixo) é pior que inútil
  -- aqui: ele troca o nome da semente por `v_destino` e descarta o que sobra
  -- vazio — com `destino` nulo nesta ação, a semente seria APAGADA. Daí o
  -- `return` cedo: nesta ação, só o vocabulário curado muda.
  if v_so_cor then
    select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o where o.id = p_org;
    if v_settings is null then
      v_settings := '{}'::jsonb;
    end if;

    -- (a) tolera `settings.tags` torto (escalar/objeto): a leitura já tolera com
    -- `jsonb_typeof`, e sem esta guarda o `jsonb_array_elements` levantava
    -- `cannot extract elements from a scalar` e derrubava a tela inteira numa
    -- organização com o dado malformado. Lista que não é lista é lista vazia.
    v_antes := case
      when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags'
      else '[]'::jsonb
    end;
    v_depois := coalesce(
      (
        select jsonb_agg(entrada.valor order by entrada.ord)
        from (
          -- Uma entrada por chave canônica, agora acrescentando a cor na que
          -- casar. A entrada que era string vira objeto — a mesma forma que o
          -- rename já grava (mais abaixo, `jsonb_build_object('tag', …)`) — e
          -- `descricao` que já existia é PRESERVADA: esta ação fala de cor.
          --
          -- ⚠️ O desempate é o MESMO da função de leitura
          -- (`fn_vocabulario_de_tags`, `order by … (cor is not null or descricao
          -- is not null) desc`), e de propósito: onde a lista curada já tiver a
          -- mesma etiqueta duas vezes (uma como string, outra como objeto com
          -- cor), quem sobrevive é a entrada que carrega o metadado. Ordenar só
          -- por `ord` apagaria a cor na primeira vez que a ação rodasse sobre um
          -- vocabulário nesse estado, e a tela mostraria "sem cor" logo depois de
          -- alguém ter escolhido uma.
          select distinct on (lower(x.chave)) x.valor, x.ord
          from (
            select btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) as chave,
                   case
                     when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then case
                            when nullif(v_cor, '') is null
                            then (case when jsonb_typeof(e.valor) = 'string'
                                       then jsonb_build_object('tag', e.valor #>> '{}')
                                       else e.valor end) - 'cor'
                            else jsonb_set(
                                   case when jsonb_typeof(e.valor) = 'string'
                                        then jsonb_build_object('tag', e.valor #>> '{}')
                                        else e.valor end,
                                   '{cor}', to_jsonb(v_cor))
                          end
                     else case when jsonb_typeof(e.valor) = 'string'
                               then jsonb_build_object('tag', e.valor #>> '{}')
                               else e.valor end
                   end as valor,
                   e.ord
            from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
            where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
          ) x
          where x.valor is not null
          order by lower(x.chave),
                   ((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc,
                   x.ord
        ) as entrada
      ),
      '[]'::jsonb
    );

    -- A etiqueta que ainda não tinha entrada no vocabulário curado — semente, ou
    -- nome que só existe em uso (`no_vocabulario = false` na leitura) — GANHA
    -- uma. É deliberado: dar cor é curar. Sem isto, a tela ofereceria cor para
    -- uma etiqueta que continuaria marcada como "em uso, fora do vocabulário", e
    -- a leitura devolveria a cor de uma linha que não está na lista curada.
    if nullif(v_cor, '') is not null and not exists (
      select 1 from jsonb_array_elements(v_depois) as e(valor)
      where lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
    ) then
      v_depois := v_depois || jsonb_build_array(jsonb_build_object('tag', v_tag, 'cor', v_cor));
    end if;

    if v_depois <> v_antes then
      v_settings := jsonb_set(v_settings, '{tags}', v_depois);
      update public.organizations o
         set settings = v_settings,
             updated_at = now()
       where o.id = p_org;
      v_definido := true;
    end if;

    return jsonb_build_object(
      'acao', p_acao,
      'tag', v_tag,
      'destino', null,
      'cor', nullif(v_cor, ''),
      'contatos', 0,
      'leads', 0,
      'conversas', 0,
      'regras', 0,
      'alterou', v_definido
    );
  end if;

  -- (a) contatos
  for v_id in
    with alvo as (
      select c.id, public.fn_tags_normalizar(c.tags, v_tag, v_destino_minusculo, v_remover) as novas
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
      select v.id, public.fn_tags_normalizar(v.tags, v_tag, v_destino_minusculo, v_remover) as novas
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
  -- regras a citam (o número volta no jsonb e a tela pede confirmação), mas
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
                 when a.valor ->> 'type' in ('add_tag', 'remove_tag')
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
    -- Exclusão: conta as regras que ainda citam a etiqueta, sem tocar nelas.
    select count(distinct r.id) into v_regras
    from public.automation_rules r
    cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) as a(valor)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
           then a.valor -> 'config' -> 'tags' else '[]'::jsonb end
    ) as e(valor)
    where r.organization_id = p_org
      and a.valor ->> 'type' in ('add_tag', 'remove_tag')
      and lower(btrim(e.valor #>> '{}')) = lower(v_tag);
  end if;

  -- (e) o vocabulário da organização, nos dois lugares onde ele mora.
  -- Mesma guarda do ramo de renomear: `settings.tags` malformado não pode
  -- derrubar a cor (a leitura tolera; a escrita agora também).
  v_antes := case
    when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags'
    else '[]'::jsonb
  end;

  -- ── (e0) O AVISO DE JUNÇÃO — renomear NÃO é renome simples quando o nome
  -- já existe (issue #2801) ────────────────────────────────────────────────
  --
  -- Renomear para um nome que JÁ ESTÁ no vocabulário junta as duas entradas
  -- numa só, e a operação respondia `alterou: true` idêntico a um renome
  -- simples: a tela dizia "Etiqueta atualizada" enquanto duas etiquetas
  -- viravam uma. O marcador é medido AQUI, no vocabulário curado, e não na
  -- tela — a tela só tem a lista que ela mesma acabou de ler, e o caso
  -- justamente interessante é o que já vinha como DUAS linhas.
  --
  -- O alcance é declarado: `juntou` diz "duas ENTRADAS do vocabulário curado
  -- colapsaram". `juntar` um nome que só existia em uso (fora do vocabulário)
  -- não colapsa entrada nenhuma ali, e o marcador fica `false` — o que
  -- normalizou os nomes nesse caso foi `fn_tags_normalizar`, outro desenho.
  if not v_remover then
    select exists (
      select 1
      from jsonb_array_elements(v_antes) with ordinality as e(valor, ord)
      where btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')) <> ''
      group by lower(
                case when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                     else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                end
              )
      having count(*) > 1
    ) into v_juntou;
  end if;

  v_depois := coalesce(
    (
      select jsonb_agg(entrada.valor order by entrada.ord)
      from (
        -- Dedupe pela chave DEPOIS da substituição (mesma razão de
        -- `fn_tags_normalizar`): juntar duas entradas de chaves diferentes num
        -- nome só deixava as duas no vocabulário, agora com o mesmo `tag`.
        --
        -- ⚠️ `cor` e `descricao` da entrada sobrevivem ao rename: o `jsonb_set`
        -- mexe só em `{tag}`. Renomear não é perder a cor que alguém escolheu.
        select distinct on (lower(x.chave)) x.valor, x.ord
        from (
          select case
                   when v_remover and lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag) then null
                   when lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag)
                     then v_destino
                   else btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))
                 end as chave,
                 case
                   when v_remover and lower(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}'))) = lower(v_tag) then null
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
        -- ⚠️ O DESEMPATE É PELO METADADO, ANTES DA ORDEM (issue #2801).
        --
        -- Com `order by lower(x.chave), x.ord` a primeira entrada pela posição
        -- ficava, COM OU SEM cor/descrição: renomear "a" (que tinha cor) para
        -- "b" (que existia antes, sem cor) PERDIA a cor que o operador havia
        -- escolhido — a entrada vazia de metadado vinha primeiro na lista.
        -- Este é o MESMO desempate da função de leitura
        -- (`fn_vocabulario_de_tags`) e do ramo `definir_cor`: onde a lista tem
        -- a mesma etiqueta duas vezes, sobrevive a que carrega metadado.
        --
        -- Quando as DUAS já têm metadado, o metadado não decide mais nada e o
        -- desempate volta a ser a ORDEM: fica a que já ocupava a posição no
        -- vocabulário — isto é, o destino. Cor contra cor tem de perder uma, e
        -- a regra escolhida preserva a identidade (nome + posição + cor) de
        -- quem já estava lá, em vez de deixar a posição da lista decidir
        -- qualquer coisa depois de virar empate técnico.
        order by lower(x.chave),
                 ((x.valor ->> 'cor') is not null or (x.valor ->> 'descricao') is not null) desc,
                 x.ord
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
                   when v_remover and lower(btrim(s.valor #>> '{}')) = lower(v_tag) then null
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
    'cor', null,
    'contatos', v_contatos,
    'leads', v_leads,
    'conversas', v_conversas,
    'regras', v_regras,
    -- `juntou` é o AVISO de que esta operação juntou duas etiquetas do
    -- vocabulário numa só (issue #2801). Sem ele a resposta era indistinguível
    -- de um renome simples, e a tela não tinha o que dizer. `false` no renome
    -- que não juntou, no excluir e em `juntar` cujo destino não estava no
    -- vocabulário curado (ver o bloco (e0)).
    'juntou', v_juntou,
    'alterou', (v_contatos + v_leads + v_conversas + v_regras > 0 or v_definido)
  );
end;
$$;

revoke execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text) to authenticated, service_role;

create or replace function public.fn_vocabulario_de_tags_pagina(
  p_org uuid, p_busca text default '', p_offset integer default 0, p_limit integer default 100
) returns jsonb language sql stable security invoker set search_path = public as $$

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
    -- As ações `add_tag` e `remove_tag` dos agentes. É o que o operador NÃO via: a etiqueta
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
      and acao.valor ->> 'type' in ('add_tag', 'remove_tag')
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
    -- #3507: a grafia COM caixa vence a minúscula. Contato e conversa guardam
    -- a etiqueta em minúscula por contrato; regra `add_tag` e negócio guardam a
    -- forma digitada. `min()` deixava a minúscula vencer, e renomear só a caixa
    -- de uma etiqueta fora do vocabulário respondia 200 sem mudar a tela.
    select (array_agg(b.tag order by (b.tag = lower(b.tag)), b.tag))[1] as tag,
           lower(b.tag) as chave
    from bruto b
    where b.tag is not null
    group by lower(b.tag)
  ),
  filtradas as (
    select t.* from todas t
    where strpos(t.chave, lower(coalesce(p_busca, ''))) > 0
  ),
  pagina as (
    select * from filtradas order by chave
    offset greatest(coalesce(p_offset, 0), 0)
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ),
  linhas as (
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
  from pagina t
  left join vocabulario_limpo v on lower(v.tag) = t.chave
  order by t.chave
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(l) order by lower(l.tag)) from linhas l), '[]'::jsonb),
    'total', (select count(*) from filtradas)
  );
$$;

revoke all on function public.fn_vocabulario_de_tags_pagina(uuid,text,integer,integer) from public, anon;
grant execute on function public.fn_vocabulario_de_tags_pagina(uuid,text,integer,integer) to authenticated, service_role;

notify pgrst, 'reload schema';
