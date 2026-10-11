-- manifest: **O rótulo da seção de LGPD não inventa dado onde a coluna era nula (issue #2656).** A redação por seção declarada de módulo (`modulo_secoes_lgpd`, 0485, gatilho `trg_lgpd_secoes_de_modulo` → `fn_lgpd_redigir_secoes_de_modulo`) gravava o rótulo de anonimizado em TODA linha alcançada pelas colunas de `colunas_rotulo`, inclusive onde a coluna era `NULL` — um campo que nunca foi preenchido passava a dizer `Cliente Anonimizado #N`, e a linha afirmava que havia um texto ali (medido na triagem do #1907: `cancel_reason` preenchido numa comanda finalizada sem cancelamento). O `set` gerado passa a preservar o nulo: `%I = case when %I is null then null else %L end`, o mesmo predicado que `colunas_redigidas` já aplica desde a 0619. Forward-fix: migration NOVA que só reescreve a função (a 0485 e a 0619 continuam intocáveis, já aplicadas em toda instalação) + apêndice igual no `baseline.sql`. Nenhum módulo da `main` declara `colunas_rotulo` não vazio, então não há dado afetado em instalação nenhuma.
-- 0628: o rótulo da seção de LGPD preserva o nulo da coluna.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────────────────────
--
-- A 0485 montava o `set` da seção assim:
--
--   select string_agg(format('%I = %L', c, v_rotulo), ', ' order by c) into v_rotulos
--     from unnest(s.colunas_rotulo) as c;
--
-- `%L` imprime o valor SEM testar nulidade, e o `update` alcança toda linha do
-- contato na tabela declarada. Onde a coluna era `NULL`, ela passava a receber o
-- rótulo: o dado é inventado, e em LGPD inventar é o mesmo erro de ler — a linha
-- passa a afirmar que existia um texto sobre a pessoa.
--
-- ─── O conserto, e por que ele tem esta forma ───────────────────────────────────────────────
--
--   motivo = case when motivo is null then null else 'Cliente Anonimizado #N' end
--
-- É exatamente o que `colunas_redigidas` faz desde a 0619 (`[redigido]`) e o que
-- o passo 6c da cascata fazia quando a comanda ainda era função do núcleo:
-- `cancel_reason = case when cancel_reason is null then null else '[redigido]' end`.
-- Trocar o lugar do passo (da cascata para a seção declarada) não pode mudar a
-- saída de LGPD — é a régua escrita em `tests/invariants/comanda-anonimizada-pela-secao.test.ts`.
--
-- Preservar o nulo NÃO apaga o efeito: a coluna preenchida continua recebendo o
-- rótulo do contato anonimizado, e `colunas` (que vira nulo) também não muda.
-- Os quatro modos da seção, depois desta migration:
--
--   colunas          → null
--   colunas_rotulo   → case when is null then null else <rótulo> end   ← ESTA migration
--   colunas_redigidas→ case when is null then null else '[redigido]' end
--   colunas_agora    → now()
--
-- ─── FORWARD-FIX, e não edição das antigas ──────────────────────────────────────────────────
--
-- A 0485 e a 0619 já estão aplicadas em toda instalação: reescrever o corpo
-- delas muda a história sem mudar nenhum banco, e quem aplicasse a cadeia de
-- novo receberia um arquivo diferente do que o `supabase_migrations` registra.
-- Por isso o conserto é `create or replace` numa migration NOVA — a mesma porta
-- pela qual todas as correções de função saem aqui (reaplicável: `if not exists`,
-- `create or replace`, `drop trigger if exists`) —, com o apêndice idêntico no
-- `baseline.sql`, ANTES do bloco da VARREDURA anon (0116), que proíbe `create
-- function` depois dela.
--
-- ─── Alcance: nenhum dado afetado hoje ──────────────────────────────────────────────────────
--
-- Nenhum módulo da `main` declara `colunas_rotulo` não vazio (o `honorarios` não
-- usa; o `financeiro` do #1907 passou a não usar — os motivos estão em
-- `colunas_redigidas`), então a tabela nasce vazia de propósito e não há linha
-- real com rótulo inventado a corrigir. A migration não backfilla nada: o que não
-- existe não se conserta, e apagar dado real aqui seria adivinhar.
--
-- Evidência: `tests/invariants/rotulo-da-secao-nao-inventa-o-nulo.test.ts` (efeito
-- no banco: nula continua nula, preenchida vira o rótulo) e
-- `tests/unit/rotulo-da-secao-de-lgpd-preserva-o-nulo.test.ts` (a última definição
-- da cadeia e do baseline montam o `set` preservando o nulo; a 0619 segue intacta).

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
  v_rotulo text := 'Cliente Anonimizado #' || substring(new.id::text from 1 for 8);
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

revoke execute on function public.fn_lgpd_redigir_secoes_de_modulo() from public, anon, authenticated;

-- A porta não muda: a mesma virada `false → true` de is_anonymized em contacts,
-- pelos DOIS caminhos de anonimização (a cascata e `fn_lgpd_anonymize_contact`).
drop trigger if exists trg_lgpd_secoes_de_modulo on public.contacts;
create trigger trg_lgpd_secoes_de_modulo
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized and not old.is_anonymized)
  execute function public.fn_lgpd_redigir_secoes_de_modulo();
