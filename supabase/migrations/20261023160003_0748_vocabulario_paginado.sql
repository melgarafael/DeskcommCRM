-- manifest: Paginar e pesquisar o vocabulário sem perder as etiquetas após a 500ª; RLS permanece invoker.
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
