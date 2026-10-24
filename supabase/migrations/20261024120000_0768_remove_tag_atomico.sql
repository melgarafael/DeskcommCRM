-- manifest: **Ação de automação `remove_tag`: tirar etiqueta do negócio ou do contato, atômico no banco.** Funções `fn_lead_remover_etiquetas` e `fn_contato_remover_etiquetas`, irmãs das `fn_*_adicionar_etiquetas` da 0682: a lista é refeita DENTRO do `UPDATE` (`with ordinality`, preserva a ordem das que ficam), então dois eventos concorrentes do mesmo negócio ou contato — um em cada dreno do `event_log` — não devolvem a etiqueta que o outro tirou nem apagam a que o outro pôs. A comparação é pela chave canônica (`lower(btrim(...))`), a mesma do `excluir` do vocabulário (0264/0673): tirar "VIP" tira "vip". `security definer`, `EXECUTE` só para `service_role`, `revoke` de `public`, `anon` e `authenticated`; linha de outra organização devolve nulo e não é tocada.

-- ---- o remove_tag tira no UPDATE, sob a trava da linha (migration 0768) ----
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
-- (`removidas`), que é o que a ação relata na aba Atividade. Nada a tirar =
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

notify pgrst, 'reload schema';
