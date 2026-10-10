-- 0485 — A anonimização de LGPD alcança as SEÇÕES DE MÓDULO declaradas (D8 da ADR-0002, #1114)
--
-- Lei: `docs/adr/0002-tabelas-de-modulo-num-banco-so.md`, D8:
--   "Anonimização e retenção alcançam as tabelas do módulo por SQL dinâmico protegido por
--    `to_regclass`: onde o módulo não está instalado, pulam sem erro. Uma cascata que citasse
--    a tabela pelo nome abortaria a anonimização inteira em toda instalação sem o módulo —
--    medido."
--
-- ── O que JÁ existe e o que este arquivo acrescenta ──────────────────────────────────────────
-- A cascata `fn_lgpd_cascade_redact_contact` continua sendo a função única do NÚCLEO (0119 →
-- 0482), e a exportação já trata o módulo ausente: `lib/lgpd/export-collector.ts` engole só o
-- 42P01 ("relation does not exist") e LANÇA para todo outro erro, porque seção de módulo
-- ilegível nunca sai como export completo (D8, parte de export, 0480/#1578).
--
-- O que faltava era o mecanismo GENÉRICO da D8: um módulo declara as SUAS seções UMA vez, e a
-- anonimização as alcança sem que a cascata ganhe um passo novo a cada módulo. Sem isto, o
-- próximo módulo com texto livre sobre a pessoa só ficaria alcançado se alguém lembrasse de
-- reescrever uma função de ~400 linhas — e o esquecimento, em LGPD, é o modo de falha silencioso
-- (rota devolve SUCESSO, SLA cumprido, linha legível).
--
-- ── As três peças ─────────────────────────────────────────────────────────────────────────────
-- 1. `modulo_secoes_lgpd` — o módulo declara `(modulo, tabela, ligacao, colunas, colunas_rotulo)`.
--    Escrito só pela migration do módulo: RLS ligada, zero policy, `anon`/`authenticated` sem
--    privilégio (mesmo desenho de `modulos_instalados`, 0340). Nenhum módulo oficial declara
--    linha hoje — honorários não tem texto livre sobre a pessoa (decisão escrita na 0480) —, e a
--    tabela nasce VAZIA de propósito: não se inventa dado de LGPD para um módulo que não pediu.
-- 2. `fn_lgpd_redigir_secoes_de_modulo()` — gatilho `after update of is_anonymized` em
--    `contacts`, a MESMA porta das 0174/0184/0210/0391: a virada `false → true` é por onde os
--    DOIS caminhos de anonimização passam (a cascata e `fn_lgpd_anonymize_contact`), então não
--    há caminho que escape por construção.
-- 3. O `to_regclass` antes de CADA seção — módulo não instalado = tabela ausente = `continue`,
--    sem erro, em qualquer instalação. É literalmente o que a ADR pede e o que a cascata
--    nomeada por tabela não pode dar.
--
-- ── Por que SECURITY DEFINER sem parâmetro (D4) ───────────────────────────────────────────────
-- O gatilho roda com a sessão de quem atualizou `contacts`; sem `definer`, um caminho que
-- atualiza como `authenticated` não teria permissão de escrever na tabela de outro módulo por
-- cima da RLS. Sem PARÂMETRO nenhum (nada de tabela, SQL ou organização vindo de fora), o efeito
-- é fixo e conhecido: a mesma argumentação da D4 para a provisionadora. `execute` revogado de
-- `public`, `anon` e `authenticated` — gatilho não precisa de grant para disparar, e sem argumento
-- de organização esta função fica fora da régua de `definer-membership-varredura` por construção.
--
-- ── Coluna declarada que não existe: ERRO ALTO, não redação pela metade ──────────────────────
-- Declaração errada da migration do módulo levanta `modulo_secao_invalida` nomeando módulo e
-- tabela. Silenciar aqui seria entregar ANONIMIZAÇÃO COM SUCESSO com a pessoa legível — o mesmo
-- modo de falha que a LGPD não tolera em lugar nenhum. O invariante da D8 mede os dois lados.
--
-- Reaplicável (tripla da casa): `if not exists`, `create or replace`, `drop trigger if exists`.
-- O apêndice do `baseline.sql` entra ANTES do bloco da `VARREDURA anon` (0116), que proíbe
-- `create function` depois dela — ver `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.

create table if not exists public.modulo_secoes_lgpd (
  modulo text not null check (modulo ~ '^[a-z][a-z0-9_]{1,40}$'),
  tabela text not null check (tabela ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- Predicado que liga a linha da tabela ao contato, com $1 = organization_id e
  -- $2 = contact_id. Vai para o `execute` via `using`: nenhum valor de contato entra no texto.
  ligacao text not null,
  colunas text[] not null default '{}'::text[],
  colunas_rotulo text[] not null default '{}'::text[],
  primary key (modulo, tabela)
);
comment on table public.modulo_secoes_lgpd is
  'Seções de LGPD que um MÓDULO opcional declara (ADR-0002, D8). Escrito só pela migration do módulo; fn_lgpd_redigir_secoes_de_modulo lê com to_regclass e PULA a seção cuja tabela não existe (módulo não instalado).';

alter table public.modulo_secoes_lgpd enable row level security;
-- Fechada também para `service_role`: o gatilho abaixo é `definer` de dono `postgres` e
-- executa o `tabela`/`ligacao` gravados aqui, e o default ACL daria GRANT ALL a ele.
revoke all on public.modulo_secoes_lgpd from public, anon, authenticated, service_role;

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
  v_rotulo text := 'Cliente Anonimizado #' || substring(new.id::text from 1 for 8);
begin
  -- O gatilho já tem `when (new.is_anonymized and not old.is_anonymized)`, e a guarda aqui é a
  -- mesma: uma função que também serve de alvo de `execute` não deve depender do chamador.
  if not (new.is_anonymized and not old.is_anonymized) then
    return null;
  end if;

  for s in
    select modulo, tabela, ligacao, colunas, colunas_rotulo
      from public.modulo_secoes_lgpd
     order by modulo, tabela
  loop
    v_rel := to_regclass(format('public.%I', s.tabela));

    -- D8, o ponto central: módulo não instalado não existe aqui, e a anonimização de um
    -- contato NUNCA pode falhar por causa de módulo que ninguém ligou.
    if v_rel is null then
      continue;
    end if;

    if btrim(s.ligacao) = '' or (cardinality(s.colunas) = 0 and cardinality(s.colunas_rotulo) = 0) then
      raise exception 'modulo_secao_invalida: %/% declara ligação vazia ou sem coluna', s.modulo, s.tabela;
    end if;

    if exists (
      select 1
        from unnest(s.colunas || s.colunas_rotulo) as c(coluna)
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
    select string_agg(format('%I = %L', c, v_rotulo), ', ' order by c) into v_rotulos
      from unnest(s.colunas_rotulo) as c;
    v_sets := concat_ws(', ', v_nulos, v_rotulos);

    -- SQL dinâmico: o NOME da tabela vem da declaração (e já passou pelo to_regclass acima),
    -- o predicado vai literal e os dois valores entram por `using`.
    execute format('update public.%I set %s where (%s)', s.tabela, v_sets, s.ligacao)
      using new.organization_id, new.id;
  end loop;

  return null;
end $f$;

revoke execute on function public.fn_lgpd_redigir_secoes_de_modulo() from public, anon, authenticated;

drop trigger if exists trg_lgpd_secoes_de_modulo on public.contacts;
create trigger trg_lgpd_secoes_de_modulo
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized and not old.is_anonymized)
  execute function public.fn_lgpd_redigir_secoes_de_modulo();
