import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * O TÍTULO DO EVENTO PESSOAL DO GOOGLE NÃO ALCANÇA OUTRO MEMBRO — migration 0261.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `public.calendar_external_events` é o espelho da agenda PESSOAL de quem
 * atende. O papel `authenticated` tinha SELECT de TABELA nela e a view
 * `calendar_selected_external_events` era `select e.*` — com o `title` dentro.
 * Qualquer membro da organização, inclusive Somente leitura, tinha privilégio
 * para ler o compromisso particular do colega: "Consulta médica", "Terapia",
 * "entrevista de emprego". O CRM só precisava daquele evento como ocupado ou
 * livre.
 *
 * O ALCANCE REAL é menor que o privilégio: desde a migration 0225 (v1.17.0) o
 * sincronizador grava o título NULO e zera o que encontra — o caso do
 * `service_role` abaixo prende isso —, então o nome só existe em linhas gravadas
 * antes da v1.17.0 e ainda não regravadas. A `FIXTURE` insere o título À MÃO,
 * como uma dessas linhas. E o `title` não é o único dado pessoal: o id do
 * calendário segue ao alcance, declarado e medido no último caso da migration, e
 * o `ical_uid` do mesmo período também — e esse nem a ressincronização limpa.
 *
 * A tela nunca mostrou o título. Quem guarda isso do lado da tela é
 * `tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts` (as consultas da
 * Agenda à tabela e à view não pedem `title`) e a spec
 * `tests/e2e/agenda-ocupacao-do-google-na-grade.spec.ts`. Nenhum dos dois
 * protege o BANCO: quem tem a chave da organização e fala direto com a REST não
 * passa por lá. É essa a camada que este arquivo vigia.
 *
 * ─── O que ele mede, e por que em quatro situações diferentes ───────────────
 *
 * 1. CONTROLE: o estado da v1.26.0 reconstruído na transação — `grant select on
 *    table` + a view `select e.*` — com o vazamento acontecendo. Sem ele, um
 *    instrumento quebrado deixaria os casos de baixo verdes por nada.
 * 2. O CAMINHO DE ATUALIZAÇÃO: o bloco da 0261, LIDO do `supabase/baseline.sql`
 *    pelo rótulo, aplicado POR CIMA do estado da v1.26.0 — o que o `update.sh`
 *    de um clone antigo faz. Aplicá-lo sobre o banco já instalado mediria o
 *    bloco contra um estado em que o defeito já não existe.
 * 3. O BANCO INSTALADO, sem reaplicar nada. É o único caso que enxerga um bloco
 *    POSTERIOR (ou um remendo à mão no Supabase) que devolva o SELECT de tabela
 *    a `authenticated`: os casos do item 2 reaplicam a 0261 e a reaplicação
 *    revoga de novo, então ficariam verdes sobre um banco que vaza. É também
 *    onde mora a varredura das funções e views que o login alcança: uma
 *    `security definer` lê com o privilégio do dono e passaria por cima do
 *    grant de coluna com todos os outros casos verdes.
 * 4. SOB O DEFAULT ACL DO SUPABASE, simulado na transação (`alter default
 *    privileges … grant all on tables` para a view que o bloco recria, e `grant
 *    all on table` para a tabela que já existe — ver `DEFAULT_ACL_DO_SUPABASE`),
 *    com um controle de que a simulação, e não o dump, é o que chega à view: a
 *    view recriada não fica legível por `anon`; o colega que não é dono da
 *    conexão não lê o título nem pela tabela nem pela view; o DONO lê o que a
 *    tela dele lê (a ocupação) e também não lê o título; e
 *    `fn_agenda_ocupacao_google_do_dono`, da migration 0260, segue devolvendo a
 *    ocupação por cima da view recriada.
 *
 * ─── O que ele NÃO exige ────────────────────────────────────────────────────
 *
 * Não exige nada da policy de leitura, que segue da organização. O que se mede é
 * o PRIVILÉGIO DE COLUNA, que é onde o título estava exposto. E não exige que o
 * colega leia a ocupação do dono direto na tabela ou na view: a grade não lê
 * assim (a leitura da tela esconde do não-gestor a conexão do colega), e quem
 * entrega essa ocupação a todo membro é a função da 0260 — é isso que fica de
 * pé. Trocar a policy por "dono da conexão OU gestor" é decisão do dono (ver a
 * 0261); se vier, só o caso "o que a 0261 NÃO fecha" fica vermelho, de propósito.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const ROTULO_0261 =
  "-- ---- PRIVACIDADE: o título do evento pessoal do Google sai do alcance do membro (migration 0261) ----";

/** O bloco rotulado da 0261, do rótulo até o próximo rótulo de apêndice. */
function blocoDa0261(): string {
  const inicio = BASELINE.indexOf(ROTULO_0261);
  if (inicio === -1) throw new Error("rótulo da 0261 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0261, inicio + 1) !== -1) throw new Error("rótulo da 0261 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0261.length);
  if (fim === -1) throw new Error("fim do bloco da 0261 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/**
 * O estado da v1.26.0, reconstruído: SELECT de TABELA para `authenticated` e a
 * view com `e.*`. É a régua do instrumento — o defeito existe aqui, e cada
 * asserção do controle tem de enxergá-lo.
 */
const DEFEITO_DA_V1260 = `
  grant select on public.calendar_external_events to authenticated;
  drop view if exists public.calendar_selected_external_events;
  create view public.calendar_selected_external_events
  with (security_invoker = true) as
  select e.* from public.calendar_external_events e
   where e.status <> 'cancelled'
     and public.fn_google_counts_for_conflicts(e.organization_id, e.connection_id, e.external_calendar_id);
  grant select on public.calendar_selected_external_events to authenticated, service_role;
`;

/**
 * O default ACL de TABELAS que todo projeto Supabase grava antes de qualquer SQL
 * nosso, reconstruído dentro da transação (o `rollback` o desfaz). O prelude do
 * `test:db` o reproduz desde a issue #887, e o próprio dump também emite um
 * `ALTER DEFAULT PRIVILEGES … ON TABLES` — depender de qualquer um dos dois faria
 * o caso medir o ambiente do gate, não o Supabase. As duas metades têm alvos diferentes:
 *
 * - o `alter default privileges` decide o ACL de relação CRIADA DEPOIS, e o bloco
 *   da 0261 CRIA a view (`drop` + `create`). É ele que dá tudo a `anon` na view
 *   recriada, e o bloco tem de tirar;
 * - o `grant all on table` alcança a TABELA, que já existe e a quem default ACL
 *   nenhum se aplica mais. É o grant que devolve o SELECT de tabela: o bloco tem
 *   de fechar o título partindo daqui.
 *
 * Um `grant` na VIEW aqui não faria nada: o `drop view` do bloco o descarta antes
 * de qualquer asserção. A versão anterior desta constante fazia exatamente isso,
 * e o lado da view media o default ACL do dump (medido no pg15 pelo cético do
 * lote 11: sem o `revoke … from anon` do bloco, a view recriada saía legível por
 * `anon` com ou sem aquela linha). O controle deste lado é o primeiro caso do
 * último `describe`.
 */
const DEFAULT_ACL_DO_SUPABASE = `
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  grant all on table public.calendar_external_events to anon, authenticated, service_role;
`;

/**
 * Tira de `pg_default_acl` a entrada de TABELAS que o dump gravou — o banco de um
 * projeto sem o bootstrap do Supabase. Só existe para o controle provar que é a
 * simulação, e não o dump, que alcança a view.
 */
const SEM_DEFAULT_ACL_DE_TABELAS = `
  alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
`;

/** Recria a view como o bloco recria (só a forma importa aqui: nasce do default ACL). */
const RECRIA_A_VIEW = `
  drop view if exists public.calendar_selected_external_events;
  create view public.calendar_selected_external_events with (security_invoker = true) as
    select e.id from public.calendar_external_events e;
`;

const ORG = "02610000-0000-4000-8000-0000000000a1";
const DONO = "02610000-0000-4000-8000-000000000001";
const COLEGA = "02610000-0000-4000-8000-000000000002";
const CONEXAO = "02610000-0000-4000-8000-0000000000c1";
const EVENTO = "02610000-0000-4000-8000-0000000000e1";
/** A conta Google do `DONO` — e o id da agenda principal dele no Google. */
const EMAIL_DO_DONO = "dono-0261@invariant.test";

/** O compromisso pessoal que ninguém na recepção deveria ler. */
const TITULO = "Terapia sigilosa";

/**
 * O `ical_uid` gravado junto com o título pelo cron anterior à v1.17.0. Não é um
 * id do Google: é o UID RFC 5545 que o sistema de QUEM CRIOU o evento gerou
 * (`evento.iCalUID`, `lib/agenda/google/evento.ts`) — num convite externo, o
 * formato e o domínio de quem convidou.
 */
const ICAL_UID_RESIDUAL = "convite-0261@sistema-de-quem-convidou.test";

/**
 * A agenda pessoal do `DONO`, com o evento e com o `COLEGA` na mesma
 * organização em papel `viewer` — o caso mais generoso para quem espia, e por
 * isso o caso do defeito. O título do evento é inserido À MÃO: é o resíduo de
 * uma sincronização anterior à v1.17.0, porque o sincronizador de hoje o grava
 * nulo — e o `ical_uid` vem junto, do mesmo período.
 */
const FIXTURE = `
  insert into auth.users (id, email) values
    ('${DONO}', '${EMAIL_DO_DONO}'),
    ('${COLEGA}', 'colega-0261@invariant.test');
  insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'inv-0261', 'Inv 0261', 'Inv 0261');
  insert into public.user_organizations (organization_id, user_id, role, accepted_at) values
    ('${ORG}', '${DONO}', 'agent', now()),
    ('${ORG}', '${COLEGA}', 'viewer', now());
  insert into public.calendar_connections (id, organization_id, user_id, provider, account_email, status)
    values ('${CONEXAO}', '${ORG}', '${DONO}', 'google_calendar', '${EMAIL_DO_DONO}', 'healthy');
  insert into public.calendar_external_events
    (id, organization_id, connection_id, external_calendar_id, external_event_id,
     title, ical_uid, starts_at, ends_at, transparency)
    values ('${EVENTO}', '${ORG}', '${CONEXAO}', 'pessoal', 'ev-0261', '${TITULO}', '${ICAL_UID_RESIDUAL}',
            now() + interval '1 day', now() + interval '1 day 1 hour', 'opaque');
`;

/** Fala como `usuario`, com o JWT que o PostgREST poria na sessão. */
function como(usuario: string): string {
  return `
  reset role;
  select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', true);
  set local role authenticated;
`;
}

/** Fala como o `COLEGA` — o membro que NÃO é dono da conexão. */
const COMO_COLEGA = como(COLEGA);
/** Fala como o `DONO` da conexão. */
const COMO_DONO = como(DONO);

/** Um gestor da organização — o papel a quem a RLS de `calendar_connections` mostra a conexão alheia. */
const GESTOR = "02610000-0000-4000-8000-000000000003";
const GESTOR_NA_ORG = `
  insert into auth.users (id, email) values ('${GESTOR}', 'gestor-0261@invariant.test');
  insert into public.user_organizations (organization_id, user_id, role, accepted_at)
    values ('${ORG}', '${GESTOR}', 'manager', now());
`;
/** Fala como o `GESTOR`. */
const COMO_GESTOR = como(GESTOR);

/**
 * A leitura que a tela da Agenda do dono faz (`app/app/agenda/page.tsx`), com o
 * embed `calendar_connections!inner(user_id)` escrito como a junção que o
 * PostgREST monta. É o que "o dono continua vendo a própria agenda" quer dizer.
 */
const LEITURA_DA_TELA = `
  select e.id, e.starts_at, e.ends_at, e.status, e.transparency, c.user_id
    from public.calendar_selected_external_events e
    join public.calendar_connections c on c.id = e.connection_id
   where e.organization_id = '${ORG}'
     and e.transparency <> 'transparent'
     and e.status <> 'cancelled'`;

/** Marcador das linhas de resultado: a saída do psql traz também BEGIN, SET, GRANT… */
const MARCA = "SONDA|";

/** A agenda `pessoal` do `DONO` no catálogo — o que o sincronizador reserva para ler. */
const CALENDARIO = "02610000-0000-4000-8000-0000000000d1";
const CATALOGO_DO_DONO = `
  insert into public.calendar_connection_calendars
    (id, organization_id, connection_id, external_calendar_id, name, counts_for_conflicts, access_role)
    values ('${CALENDARIO}', '${ORG}', '${CONEXAO}', 'pessoal', 'Pessoal', true, 'owner');
`;

/**
 * O caminho de produção que escreve no espelho: o sincronizador, que o executor
 * (`lib/agenda/google/calendar-executor.ts`) chama com o admin client — reservar
 * a agenda (`claim`) e gravar dois eventos lidos do Google, um que já existe com
 * título e `ical_uid` residuais e um novo, cada um COM `title` e `ical_uid` no
 * payload — como o executor manda: ele espalha `read.evento`, que traz o
 * `ical_uid`, e só sobrescreve o `title` com nulo.
 *
 * ⚠️ Quem GRAVA não é o `service_role`. `fn_google_calendar` é `security
 * definer`: o `insert … on conflict` roda com o privilégio do DONO da função. Do
 * `service_role`, este caminho usa só o EXECUTE dela — é o que `executa=` mede. O
 * espelho é lido depois pelo harness (`reset role`), porque a leitura é do
 * instrumento, não do produto: lê-lo como `service_role` faria o caso depender de
 * um SELECT que o sincronizador não usa.
 *
 * O `\gset` guarda a reserva numa variável do psql, como o executor guarda o
 * `claim` entre as chamadas.
 */
const SINCRONIZA_COMO_SERVICE_ROLE = `
  reset role;
  set local role service_role;
  select '${MARCA}' || 'papel=' || current_user;
  select '${MARCA}' || 'executa=' ||
    has_function_privilege('service_role', 'public.fn_google_calendar(uuid, uuid, text, jsonb)', 'EXECUTE')::text;
  select public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'claim') -> 'claim' as reserva \\gset
  select public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'item', jsonb_build_object(
    'claim', :'reserva'::jsonb,
    'item', jsonb_build_object('external_event_id', 'ev-0261', 'title', '${TITULO} (do Google)',
      'ical_uid', 'uid-que-o-google-manda-hoje@google.com',
      'starts_at', now() + interval '1 day', 'ends_at', now() + interval '1 day 1 hour', 'status', 'confirmed')));
  select public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'item', jsonb_build_object(
    'claim', :'reserva'::jsonb,
    'item', jsonb_build_object('external_event_id', 'ev-0261-novo', 'title', 'Entrevista de emprego',
      'ical_uid', 'uid-do-evento-novo@google.com',
      'starts_at', now() + interval '2 days', 'ends_at', now() + interval '2 days 1 hour', 'status', 'confirmed')));
  reset role;
  select '${MARCA}' || 'espelho=' ||
    string_agg(external_event_id || ':' || coalesce(title, '(nulo)') || ':' || coalesce(ical_uid, '(nulo)'),
               ',' order by external_event_id)
    from public.calendar_external_events where connection_id = '${CONEXAO}';
`;

/**
 * O caminho de produção que APAGA do espelho: a desconexão
 * (`app/api/v1/agenda/google/desconectar/route.ts`), pelo admin client, com
 * `.delete().eq("organization_id", …).in("connection_id", …)`. Este SIM usa
 * privilégio de TABELA do `service_role` — DELETE, e SELECT nas duas colunas do
 * filtro, que o Postgres exige para avaliar o `where` — e é o único caminho do
 * produto que usa. É o que `desconexao=` mede.
 */
const DESCONECTA_COMO_SERVICE_ROLE = `
  reset role;
  set local role service_role;
  select '${MARCA}' || 'desconexao=' ||
    has_table_privilege('service_role', 'public.calendar_external_events', 'DELETE')::text || ',' ||
    has_column_privilege('service_role', 'public.calendar_external_events', 'organization_id', 'SELECT')::text || ',' ||
    has_column_privilege('service_role', 'public.calendar_external_events', 'connection_id', 'SELECT')::text;
  delete from public.calendar_external_events
   where organization_id = '${ORG}' and connection_id in ('${CONEXAO}');
  reset role;
  select '${MARCA}' || 'depois_de_desconectar=' || count(*)::text
    from public.calendar_external_events where connection_id = '${CONEXAO}';
`;

/**
 * Quem, em `public`, lê o espelho (a tabela ou a view) e cita `title` ou a linha
 * inteira — e, desses, quem o login alcança (EXECUTE da função para
 * `authenticated`/`anon`, SELECT da view). Duas linhas marcadas: `citam=` e
 * `alcancaveis=`. `pg_get_functiondef` serve a `plpgsql`, `sql` e `begin atomic`;
 * `pg_get_viewdef` devolve a view com o `e.*` já expandido, então a coluna
 * `title` aparece pelo nome.
 */
const VARREDURA_DE_LEITORES_DO_TITULO = `
  with objetos as (
    select 'função ' || p.oid::regprocedure::text as objeto,
           pg_get_functiondef(p.oid) as corpo,
           has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('anon', p.oid, 'EXECUTE') as alcancavel
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f', 'p')
    union all
    select 'view ' || c.oid::regclass::text,
           pg_get_viewdef(c.oid),
           has_table_privilege('authenticated', c.oid, 'SELECT')
             or has_table_privilege('anon', c.oid, 'SELECT')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v', 'm')
  ),
  leitores as (
    select objeto, alcancavel
      from objetos
     where corpo ~* 'calendar_(selected_)?external_events'
       and corpo ~* '(\\mtitle\\M|\\m[a-z_][a-z0-9_]*\\.\\*|select\\s+\\*|to_jsonb?\\s*\\(|jsonb?_agg\\s*\\(\\s*[a-z_][a-z0-9_]*\\s*\\))'
  )
  select linha from (
    select 1 as ordem, '${MARCA}' || 'citam=' || coalesce(string_agg(objeto, ',' order by objeto), '(nenhum)') as linha
      from leitores
    union all
    select 2, '${MARCA}' || 'alcancaveis=' ||
              coalesce(string_agg(objeto, ',' order by objeto) filter (where alcancavel), '(nenhum)')
      from leitores
  ) as sondas
  order by ordem;
`;

/**
 * Roda `corpo` numa transação desfeita e devolve as linhas marcadas com `MARCA`,
 * sem a marca, na ordem em que saíram.
 */
function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Roda o script e devolve o erro do Postgres, ou `null` se ele passou. */
function erroDo(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("migration 0261 — o título do evento pessoal fora do alcance do membro", () => {
  it("controle: o estado da v1.26.0 deixa o colega ler o título, na tabela e na view", () => {
    // Sem este caso, todo o resto ficaria verde se o instrumento não medisse
    // nada — e ele afirmaria privacidade sem ter olhado.
    const [privilegio, direto, pelaView] = sondasDesfeitas(`
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      select '${MARCA}' || has_column_privilege(
        'authenticated', 'public.calendar_external_events', 'title', 'SELECT')::text;
      ${COMO_COLEGA}
      select '${MARCA}' || 'tabela=' || coalesce(title, '(nulo)')
        from public.calendar_external_events where id = '${EVENTO}';
      select '${MARCA}' || 'view=' || coalesce(title, '(nulo)')
        from public.calendar_selected_external_events where id = '${EVENTO}';
    `);

    expect(privilegio, "a simulação não reproduz o privilégio da v1.26.0").toBe("true");
    expect(direto, "o colega não leu o título direto na tabela — a simulação não reproduz o defeito").toBe(
      `tabela=${TITULO}`,
    );
    expect(pelaView, "o colega não leu o título pela view — a simulação não reproduz o defeito").toBe(
      `view=${TITULO}`,
    );
  });

  it("sobre a v1.26.0, o bloco da 0261 dá permission denied no título ao colega — o erro, não zero linhas", () => {
    // "Zero linhas" seria indistinguível de "não há evento", e o alvo aqui é a
    // COLUNA: o Postgres tem de recusar a leitura, não devolver vazio.
    const erro = erroDo(`
      begin;
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select title from public.calendar_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(erro, "o colega leu o título do evento pessoal do dono SEM erro").not.toBeNull();
    expect(erro).toContain("permission denied for table calendar_external_events");
  });

  it("sobre a v1.26.0, o bloco da 0261 tira o SELECT de tabela e mantém a ocupação concedida", () => {
    const [tabela, titulo, ocupacao] = sondasDesfeitas(`
      ${DEFEITO_DA_V1260}
      ${blocoDa0261()}
      select '${MARCA}' || has_table_privilege(
        'authenticated', 'public.calendar_external_events', 'SELECT')::text;
      select '${MARCA}' || has_column_privilege(
        'authenticated', 'public.calendar_external_events', 'title', 'SELECT')::text;
      select '${MARCA}' || has_column_privilege(
        'authenticated', 'public.calendar_external_events', 'starts_at', 'SELECT')::text;
    `);
    expect(tabela, "o SELECT de tabela sobreviveu — privilégio de tabela cobre todas as colunas").toBe("false");
    expect(titulo, "o título continua legível por coluna").toBe("false");
    expect(ocupacao, "a ocupação perdeu a leitura — o conserto é largo demais").toBe("true");
  });

  it("sobre a v1.26.0, o bloco da 0261 deixa de pé quem mostra a ocupação: a leitura da tela para o dono e o gestor, e a função da 0260 para o colega — cuja tela já não trazia a ocupação do dono", () => {
    // A versão anterior deste caso exigia que o colega Somente leitura seguisse
    // lendo a ocupação do dono DIRETO na tabela e na view, "senão a grade da
    // equipe esvaziaria". A grade não lê assim. `app/app/agenda/page.tsx` e
    // `app/api/v1/agenda/agendamentos/route.ts` pedem a view com a sessão do
    // usuário e o embed `calendar_connections!inner(user_id)` — a
    // `LEITURA_DA_TELA` —, e a RLS de `calendar_connections` (dono OU gestor)
    // tira da resposta a linha cuja conexão o leitor não vê. Para quem não é
    // gestor, a tela JÁ não mostrava a ocupação do Google do colega antes da 0261
    // (issue #879). Quem a entrega a todo membro é
    // `fn_agenda_ocupacao_google_do_dono` (0260), `security definer`, que o
    // encaixe de horários chama (`lib/agenda/consulta.ts`).
    //
    // Prender a leitura direta do colega protegia um uso que o produto não tem, e
    // ficaria vermelho justamente com o fechamento mais barato do resto do
    // espelho — trocar a policy de SELECT por "dono da conexão OU gestor", a régua
    // de `calendar_connection_calendars_select`, que é decisão do dono (ver a
    // 0261). O que precisa continuar de pé é o que este caso mede.
    const [colegaAntes, colegaDepois, dono, gestor, funcao] = sondasDesfeitas(`
      ${FIXTURE}
      ${GESTOR_NA_ORG}
      ${DEFEITO_DA_V1260}
      ${COMO_COLEGA}
      select '${MARCA}' || 'tela=' || count(*)::text from (${LEITURA_DA_TELA}) t;
      reset role;
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select '${MARCA}' || 'tela=' || count(*)::text from (${LEITURA_DA_TELA}) t;
      ${COMO_DONO}
      select '${MARCA}' || 'tela=' || count(*)::text || ',' || coalesce(min(t.user_id::text), '(ninguém)')
        from (${LEITURA_DA_TELA}) t;
      ${COMO_GESTOR}
      select '${MARCA}' || 'tela=' || count(*)::text || ',' || coalesce(min(t.user_id::text), '(ninguém)')
        from (${LEITURA_DA_TELA}) t;
      ${COMO_COLEGA}
      select '${MARCA}' || 'funcao=' || count(*)::text || ',' || coalesce(min(o.transparency), '(nulo)') || ',' ||
             coalesce(min(o.status), '(nulo)') || ',' || coalesce(min(o.connection_status), '(nulo)')
        from public.fn_agenda_ocupacao_google_do_dono('${ORG}', '${DONO}', now(), now() + interval '2 days') o;
    `);
    expect(
      colegaAntes,
      "na v1.26.0 a leitura da tela entregou ao colega que não é gestor a ocupação do dono — a premissa com que a 0261 descreve a grade mudou",
    ).toBe("tela=0");
    expect(
      colegaDepois,
      "depois do bloco a leitura da tela entregou ao colega que não é gestor a ocupação do dono — a premissa com que a 0261 descreve a grade mudou",
    ).toBe("tela=0");
    expect(dono, "o dono perdeu a própria ocupação na leitura da tela da Agenda").toBe(`tela=1,${DONO}`);
    expect(gestor, "o gestor perdeu a ocupação do dono na leitura da tela da Agenda").toBe(`tela=1,${DONO}`);
    expect(funcao, "o colega deixou de receber a ocupação do dono pela função da 0260").toBe(
      "funcao=1,opaque,confirmed,healthy",
    );
  });

  it("sobre a v1.26.0, a view recriada não tem `title` na definição — e pedi-lo é erro, não silêncio", () => {
    // A view era `select e.*`: era por ali que a próxima coluna nasceria
    // exposta, e o `e.*` já expandido não é conferível pela lista de colunas.
    const [colunas] = sondasDesfeitas(`
      ${DEFEITO_DA_V1260}
      ${blocoDa0261()}
      select '${MARCA}' || coalesce(string_agg(column_name, ',' order by column_name), '(sem colunas)')
        from information_schema.columns
       where table_schema = 'public' and table_name = 'calendar_selected_external_events'
         and column_name in ('title', 'description', 'location', 'attendees');
    `);
    expect(colunas, "a view da ocupação voltou a carregar coluna de conteúdo").toBe("(sem colunas)");

    const erro = erroDo(`
      begin;
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select title from public.calendar_selected_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(erro, "a view ainda entrega o título").not.toBeNull();
    expect(erro).toContain('column "title" does not exist');
  });

  it("o bloco não fecha o espelho para quem o mantém: o sincronizador, que o service_role chama, grava a ocupação com o título NULO — zerando o que encontra — e a desconexão, como service_role, apaga", () => {
    // O que a 0261 fecha é a LEITURA por login de usuário. Os dois caminhos que
    // mantêm o espelho rodam aqui SOB `set local role service_role` — e não como
    // o superusuário do harness, que é quem `sql()` usa —, mas usam o papel de
    // formas diferentes, e o caso mede cada uma pelo que ela usa:
    //
    // - o sincronizador (`lib/agenda/google/calendar-executor.ts`) usa do
    //   `service_role` só o EXECUTE de `fn_google_calendar`. A função é
    //   `security definer`: quem grava na tabela é o DONO dela, e privilégio de
    //   tabela do `service_role` não entra — o controle "quem grava é a função"
    //   mede isso revogando todos;
    // - a desconexão (`app/api/v1/agenda/google/desconectar`) usa privilégio de
    //   TABELA do `service_role`: DELETE, e SELECT nas colunas do filtro.
    //
    // A versão anterior prendia SELECT e UPDATE do `service_role` no `title` e
    // dizia medir "o service_role de verdade, pelo caminho do sincronizador".
    // Nenhum caminho do produto usa esse privilégio, e um endurecimento futuro que
    // o revogasse daria aqui um vermelho falso dizendo que o espelho deixou de
    // ser mantido.
    //
    // E o caso prende a premissa que a prosa da 0261 usa para dizer o alcance: o
    // sincronizador NÃO grava o nome desde a 0225 (v1.17.0), e o `on conflict`
    // ZERA o título que encontra. A fixture traz o título à mão, como uma linha
    // gravada pelo cron anterior à v1.17.0 — que é o único lugar onde ele existe.
    //
    // Prende também o que a 0261 diz do `ical_uid`, do mesmo período: o
    // sincronizador não o grava (o evento novo fica nulo, embora o payload o
    // traga) e o `on conflict` NÃO o põe no `set` — o residual sobrevive ao
    // reprocessamento que zera o título. No dia em que a ressincronização passar
    // a limpá-lo, este caso fica vermelho e a prosa muda junto.
    const linhas = sondasDesfeitas(`
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      ${blocoDa0261()}
      ${SINCRONIZA_COMO_SERVICE_ROLE}
      ${DESCONECTA_COMO_SERVICE_ROLE}
    `);
    expect(
      linhas,
      "o service_role perdeu o que os caminhos do produto usam (EXECUTE do sincronizador, DELETE/SELECT da desconexão), ou o sincronizador mudou o que grava — voltou a gravar o nome, ou passou a gravar/limpar o ical_uid (a prosa da 0261 descreve o resíduo)",
    ).toEqual([
      "papel=service_role",
      "executa=true",
      `espelho=ev-0261:(nulo):${ICAL_UID_RESIDUAL},ev-0261-novo:(nulo):(nulo)`,
      "desconexao=true,true,true",
      "depois_de_desconectar=0",
    ]);
  });

  it("controle do caso acima: quem grava é a função, e não o service_role — sem privilégio nenhum de tabela o sincronizador grava igual, e só a desconexão é recusada", () => {
    // Sem este caso, "o sincronizador não depende de privilégio de tabela do
    // service_role" seria prosa. `revoke all` tira SELECT, INSERT, UPDATE e
    // DELETE do papel na tabela; a `security definer` segue gravando com o
    // privilégio do dono dela.
    const [papel, executa, espelho] = sondasDesfeitas(`
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      ${blocoDa0261()}
      revoke all on public.calendar_external_events from service_role;
      ${SINCRONIZA_COMO_SERVICE_ROLE}
    `);
    expect(papel).toBe("papel=service_role");
    expect(executa).toBe("executa=true");
    expect(espelho, "sem privilégio de tabela o espelho saiu diferente — ou o sincronizador não grava pela definer, ou mudou o que faz com title/ical_uid").toBe(
      `espelho=ev-0261:(nulo):${ICAL_UID_RESIDUAL},ev-0261-novo:(nulo):(nulo)`,
    );

    const desconexao = erroDo(`
      begin;
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      ${blocoDa0261()}
      revoke all on public.calendar_external_events from service_role;
      ${SINCRONIZA_COMO_SERVICE_ROLE}
      ${DESCONECTA_COMO_SERVICE_ROLE}
      rollback;
    `);
    expect(desconexao, "sem privilégio de tabela a desconexão apagou mesmo assim — a sessão não é do service_role").not.toBeNull();
    expect(desconexao).toContain("permission denied for table calendar_external_events");
  });

  it("controle dos casos acima: sem o privilégio do service_role, a mesma sequência é recusada — o papel medido é o real", () => {
    // Sem este caso, o de cima ficaria verde rodando como superusuário, que
    // passa por cima de qualquer `revoke` — foi assim que a versão anterior dele
    // afirmava "o service_role grava" com um INSERT feito pelo `postgres`.
    const semChamada = erroDo(`
      begin;
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      ${blocoDa0261()}
      revoke execute on function public.fn_google_calendar(uuid, uuid, text, jsonb) from service_role;
      ${SINCRONIZA_COMO_SERVICE_ROLE}
      ${DESCONECTA_COMO_SERVICE_ROLE}
      rollback;
    `);
    expect(semChamada, "sem EXECUTE o sincronizador rodou mesmo assim — a sessão não é do service_role").not.toBeNull();
    expect(semChamada).toContain("permission denied for function fn_google_calendar");

    const semApagar = erroDo(`
      begin;
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      ${blocoDa0261()}
      revoke delete on public.calendar_external_events from service_role;
      ${SINCRONIZA_COMO_SERVICE_ROLE}
      ${DESCONECTA_COMO_SERVICE_ROLE}
      rollback;
    `);
    expect(semApagar, "sem DELETE a desconexão apagou mesmo assim — a sessão não é do service_role").not.toBeNull();
    expect(semApagar).toContain("permission denied for table calendar_external_events");
  });

  it("`anon` continua sem SELECT — o bloco não abre porta nova", () => {
    const [tabela, view] = sondasDesfeitas(`
      ${blocoDa0261()}
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_external_events', 'SELECT')::text;
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_selected_external_events', 'SELECT')::text;
    `);
    expect(tabela, "`anon` ganhou leitura da tabela do espelho").toBe("false");
    expect(view, "`anon` ganhou leitura da view da ocupação").toBe("false");
  });

  it("o que a 0261 NÃO fecha, e declara: o colega segue lendo o id do calendário — na agenda principal, o e-mail da conta que a RLS da conexão esconde dele", () => {
    // O `title` não é o único dado pessoal do espelho. `external_calendar_id` é o
    // `id` do CalendarList do Google (`fn_google_catalog` grava `it->>'id'`), e na
    // agenda PRINCIPAL — a que conta por padrão — esse id é o e-mail da conta.
    // A RLS de `calendar_connections` esconde a conta de um colega que não é
    // gestor; esta tabela e a view a entregam a todo membro.
    //
    // A 0261 deixa isso aberto por decisão escrita no cabeçalho dela. Revogar a
    // COLUNA não serve: a view é `security_invoker` e passa a coluna a
    // `fn_google_counts_for_conflicts`, então revogá-la derruba TODA leitura da
    // view por membro. O que fecha sem mudar leitura nenhuma é a policy de SELECT
    // "dono da conexão OU gestor": as leituras de tela já escondem do não-gestor a
    // conexão do colega (caso da grade, acima), e a ocupação que todo membro
    // precisa vem da função da 0260, que a policy não alcança. Isso é do dono.
    // Este caso existe para a prosa não mentir em nenhum dos dois sentidos: no
    // dia em que alguém fechar, ele fica vermelho — e a 0261, o fragmento e o
    // MANIFEST mudam junto.
    const [conexao, tabela, view] = sondasDesfeitas(`
      ${FIXTURE}
      insert into public.calendar_external_events
        (organization_id, connection_id, external_calendar_id, external_event_id, starts_at, ends_at)
        values ('${ORG}', '${CONEXAO}', '${EMAIL_DO_DONO}', 'ev-0261-principal',
                now() + interval '3 days', now() + interval '3 days 1 hour');
      ${DEFEITO_DA_V1260}
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select '${MARCA}' || 'conexao=' || count(*)::text
        from public.calendar_connections where id = '${CONEXAO}';
      select '${MARCA}' || 'tabela=' || external_calendar_id
        from public.calendar_external_events where external_event_id = 'ev-0261-principal';
      select '${MARCA}' || 'view=' || external_calendar_id
        from public.calendar_selected_external_events where external_event_id = 'ev-0261-principal';
    `);
    expect(conexao, "a RLS da conexão passou a mostrar a conta ao colega — a premissa da declaração mudou").toBe(
      "conexao=0",
    );
    expect(
      tabela,
      "o colega deixou de ler o id do calendário na tabela — a exposição declarada na 0261 foi fechada: atualize a prosa",
    ).toBe(`tabela=${EMAIL_DO_DONO}`);
    expect(
      view,
      "o colega deixou de ler o id do calendário pela view — a exposição declarada na 0261 foi fechada: atualize a prosa",
    ).toBe(`view=${EMAIL_DO_DONO}`);
  });
});

/**
 * O RESÍDUO que a ressincronização deixa — o que a 0261 escreve sobre "o alcance
 * real", preso aqui para a prosa não encolher de novo. Estes casos não aplicam
 * o bloco: eles medem o sincronizador (`fn_google_calendar`, chamado como
 * `service_role`) e dimensionam a decisão de anular o resíduo, que é do dono.
 */
describe("o alcance do resíduo que a 0261 descreve — o que a ressincronização não regrava", () => {
  it("o rebuild completo de 24h não regrava nem apaga o evento CANCELADO: futuro e dentro da janela, ele mantém o nome — e o evento confirmado que sumiu do Google é apagado", () => {
    // O `page` final do rebuild (`mode=full`) apaga o que a leitura não viu,
    // mas com `and status<>'cancelled'`; e a leitura completa do Google não
    // devolve cancelados, então nenhum `item` o zera. O controle do mesmo
    // rebuild é o evento CONFIRMADO que não veio: esse é apagado — prova de que o
    // rebuild rodou inteiro, e que o cancelado sobrou por ser cancelado.
    const [modo, espelho] = sondasDesfeitas(`
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      insert into public.calendar_external_events
        (organization_id, connection_id, external_calendar_id, external_event_id, title, status, starts_at, ends_at)
        values
        ('${ORG}', '${CONEXAO}', 'pessoal', 'ev-0261-cancelado', 'Consulta cancelada', 'cancelled',
         now() + interval '3 days', now() + interval '3 days 1 hour'),
        ('${ORG}', '${CONEXAO}', 'pessoal', 'ev-0261-sumiu', 'Entrevista que sumiu', 'confirmed',
         now() + interval '4 days', now() + interval '4 days 1 hour');
      set local role service_role;
      select public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'claim') -> 'claim' as reserva \\gset
      reset role;
      select '${MARCA}' || 'modo=' || (sync_cursor ->> 'mode')
        from public.calendar_connection_calendars where id = '${CALENDARIO}';
      set local role service_role;
      select public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'item', jsonb_build_object(
        'claim', :'reserva'::jsonb,
        'item', jsonb_build_object('external_event_id', 'ev-0261', 'title', '${TITULO} (do Google)',
          'starts_at', now() + interval '1 day', 'ends_at', now() + interval '1 day 1 hour', 'status', 'confirmed')));
      select public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'page', jsonb_build_object(
        'claim', :'reserva'::jsonb, 'next_page_token', null, 'next_sync_token', 'sync-0261'));
      reset role;
      select '${MARCA}' || 'espelho=' ||
        string_agg(external_event_id || ':' || status || ':' || coalesce(title, '(nulo)'), ',' order by external_event_id)
        from public.calendar_external_events where connection_id = '${CONEXAO}';
    `);
    expect(modo, "a primeira reserva da agenda não foi um rebuild completo — o caso não mede o rebuild").toBe("modo=full");
    expect(
      espelho,
      "o rebuild passou a regravar/apagar o evento cancelado, ou deixou de apagar o confirmado que sumiu — a prosa do resíduo na 0261 muda junto",
    ).toBe("espelho=ev-0261:confirmed:(nulo),ev-0261-cancelado:cancelled:Consulta cancelada");
  });

  it("a agenda que o sincronizador não lê não é regravada, futuro inclusive: fora do catálogo a reserva não sai, e de membro revogado ou de conexão com o token vencido ela é recusada", () => {
    // Sem reserva não há `item` nem `page`: as linhas daquela agenda ficam como
    // estão, com o nome, até o expurgo (90 dias depois do fim). A terceira forma
    // — agenda desmarcada (não conta, não é destino e não tem agendamento
    // vinculado) — mora no cron, que nem chama a reserva
    // (`app/api/v1/cron/agenda-google-sync/route.ts`), e não é medida aqui.
    const RESERVA = `
      set local role service_role;
      select '${MARCA}' || 'reserva=' ||
        coalesce(public.fn_google_calendar('${ORG}', '${CALENDARIO}', 'claim') -> 'sync_cursor' ->> 'mode', '(nenhuma)');
    `;
    const [comTudoEmOrdem, foraDoCatalogo] = sondasDesfeitas(`
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      savepoint controle;
      ${RESERVA}
      reset role;
      rollback to savepoint controle;
      update public.calendar_connection_calendars set available = false where id = '${CALENDARIO}';
      ${RESERVA}
    `);
    expect(comTudoEmOrdem, "o controle falhou: com a agenda disponível, o membro ativo e a conexão saudável a reserva não saiu").toBe(
      "reserva=full",
    );
    expect(foraDoCatalogo, "o sincronizador passou a reservar agenda fora do catálogo — a prosa do resíduo na 0261 muda junto").toBe(
      "reserva=(nenhuma)",
    );

    const membroRevogado = erroDo(`
      begin;
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      update public.user_organizations set revoked_at = now() where organization_id = '${ORG}' and user_id = '${DONO}';
      ${RESERVA}
      rollback;
    `);
    expect(membroRevogado, "o sincronizador passou a reservar a agenda de membro revogado — a prosa do resíduo na 0261 muda junto").not.toBeNull();
    expect(membroRevogado).toContain("google_connection_unavailable");

    const tokenVencido = erroDo(`
      begin;
      ${FIXTURE}
      ${CATALOGO_DO_DONO}
      update public.calendar_connections set status = 'token_expired' where id = '${CONEXAO}';
      ${RESERVA}
      rollback;
    `);
    expect(tokenVencido, "o sincronizador passou a reservar agenda de conexão fora do ar — a prosa do resíduo na 0261 muda junto").not.toBeNull();
    expect(tokenVencido).toContain("google_connection_unavailable");
  });
});

describe("o banco instalado pelo baseline inteiro — sem reaplicar o bloco da 0261", () => {
  it("não entrega o título ao colega: sem SELECT de tabela, sem SELECT no `title`, e a view sem a coluna", () => {
    // Todo caso acima reaplica a 0261, e a reaplicação revoga de novo. Um bloco
    // POSTERIOR que devolvesse `grant select on table` a `authenticated` — ou o
    // mesmo remendo feito à mão no Supabase — reabriria o título com todos eles
    // verdes. Este caso lê o banco como o `install.sh` o deixou.
    const [tabela, titulo] = sondasDesfeitas(`
      select '${MARCA}' || has_table_privilege('authenticated', 'public.calendar_external_events', 'SELECT')::text;
      select '${MARCA}' || has_column_privilege(
        'authenticated', 'public.calendar_external_events', 'title', 'SELECT')::text;
    `);
    expect(tabela, "o banco instalado devolve o SELECT de TABELA a `authenticated`").toBe("false");
    expect(titulo, "o banco instalado deixa `authenticated` ler o `title`").toBe("false");

    const pelaTabela = erroDo(`
      begin;
      ${FIXTURE}
      ${COMO_COLEGA}
      select title from public.calendar_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(pelaTabela, "no banco instalado o colega leu o título SEM erro").not.toBeNull();
    expect(pelaTabela).toContain("permission denied for table calendar_external_events");

    const pelaView = erroDo(`
      begin;
      ${FIXTURE}
      ${COMO_COLEGA}
      select title from public.calendar_selected_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(pelaView, "no banco instalado a view entrega o título").not.toBeNull();
    expect(pelaView).toContain('column "title" does not exist');
  });

  it("nenhuma função nem view que `authenticated` ou `anon` alcance lê o título do espelho — quem lê com o privilégio do dono passa por cima do grant de coluna", () => {
    // O grant de coluna fecha o `title` para o LOGIN. Uma função `security
    // definer`, ou uma view sem `security_invoker`, lê com o privilégio do DONO
    // dela e passa por cima dele — e todas as asserções de privilégio acima
    // seguem verdes. Medido na triagem: uma definer com EXECUTE para
    // `authenticated` devolvendo `e.title` entregou "Terapia sigilosa" ao colega
    // com `has_column_privilege(... 'title' ...)` = false.
    //
    // A varredura olha o que o login alcança em `public` (EXECUTE da função,
    // SELECT da view) e cujo corpo cita o espelho — a tabela ou a view — junto
    // com `title` ou com a LINHA INTEIRA (`e.*`, `select *`, `to_json`/`to_jsonb`,
    // `json_agg(e)`). É conservadora de propósito: uma função que cite `title` de
    // outra tabela no mesmo corpo também reprova, e a saída é escrever aqui por
    // que ela não entrega o título do espelho. Uma tela do titular que um dia
    // precise do nome nasce assim — e este caso muda junto com ela, de propósito.
    //
    // Fora do alcance da varredura, e escrito: SQL dinâmico que monte o nome da
    // tabela por partes, e função de outro schema chamada por uma de `public`.
    const [citam, alcancaveis] = sondasDesfeitas(VARREDURA_DE_LEITORES_DO_TITULO);
    expect(alcancaveis, "uma função ou view que o login alcança lê o título (ou a linha inteira) do espelho").toBe(
      "alcancaveis=(nenhum)",
    );
    expect(
      citam,
      "a varredura não enxerga mais só fn_google_calendar, a única função que cita o título (para gravá-lo nulo) — ou apareceu outra que só o service_role executa, ou a sonda ficou cega",
    ).toBe("citam=função fn_google_calendar(uuid,uuid,text,jsonb)");

    // Controle: a varredura pega o que precisa pegar, e só isso — três leitores
    // alcançáveis que entregam o título (um deles lido de fato pelo colega), um
    // alcançável que só lê ocupação e um que cita o título mas só o service_role
    // executa.
    const [tituloPeloColega, citamComSondas, alcancaveisComSondas] = sondasDesfeitas(`
      ${FIXTURE}
      create function public.fn_sonda_0261_titulo_do_titular(p_conexao uuid) returns setof text
        language sql stable security definer set search_path = public
        as $f$ select e.title from public.calendar_external_events e where e.connection_id = p_conexao $f$;
      create function public.fn_sonda_0261_linha_inteira(p_conexao uuid) returns setof jsonb
        language sql stable security definer set search_path = public
        as $f$ select to_jsonb(e) from public.calendar_external_events e where e.connection_id = p_conexao $f$;
      create view public.v_sonda_0261_espelho as select e.* from public.calendar_external_events e;
      create function public.fn_sonda_0261_so_ocupacao(p_conexao uuid) returns setof timestamptz
        language sql stable security definer set search_path = public
        as $f$ select e.starts_at from public.calendar_selected_external_events e where e.connection_id = p_conexao $f$;
      create function public.fn_sonda_0261_titulo_do_servico(p_conexao uuid) returns setof text
        language sql stable security definer set search_path = public
        as $f$ select e.title from public.calendar_external_events e where e.connection_id = p_conexao $f$;
      revoke execute on function public.fn_sonda_0261_titulo_do_titular(uuid) from public, anon;
      grant  execute on function public.fn_sonda_0261_titulo_do_titular(uuid) to authenticated;
      revoke execute on function public.fn_sonda_0261_linha_inteira(uuid) from public, anon;
      grant  execute on function public.fn_sonda_0261_linha_inteira(uuid) to authenticated;
      revoke all on public.v_sonda_0261_espelho from public, anon;
      grant  select on public.v_sonda_0261_espelho to authenticated;
      revoke execute on function public.fn_sonda_0261_so_ocupacao(uuid) from public, anon;
      grant  execute on function public.fn_sonda_0261_so_ocupacao(uuid) to authenticated;
      revoke execute on function public.fn_sonda_0261_titulo_do_servico(uuid) from public, anon, authenticated;
      grant  execute on function public.fn_sonda_0261_titulo_do_servico(uuid) to service_role;
      ${COMO_COLEGA}
      select '${MARCA}' || 'colega=' || string_agg(t, ',') from public.fn_sonda_0261_titulo_do_titular('${CONEXAO}') t;
      reset role;
      ${VARREDURA_DE_LEITORES_DO_TITULO}
    `);
    expect(tituloPeloColega, "a sonda não reproduz o furo — a definer não entregou o título ao colega").toBe(
      `colega=${TITULO}`,
    );
    expect(citamComSondas).toBe(
      "citam=função fn_google_calendar(uuid,uuid,text,jsonb),função fn_sonda_0261_linha_inteira(uuid)," +
        "função fn_sonda_0261_titulo_do_servico(uuid),função fn_sonda_0261_titulo_do_titular(uuid),view v_sonda_0261_espelho",
    );
    expect(alcancaveisComSondas, "a varredura não pega um leitor alcançável do título, ou pega quem só lê ocupação").toBe(
      "alcancaveis=função fn_sonda_0261_linha_inteira(uuid),função fn_sonda_0261_titulo_do_titular(uuid),view v_sonda_0261_espelho",
    );
  });

  it("coluna do espelho legível por membro é decisão explícita: só o `title` fica de fora, e a view cabe no que foi concedido", () => {
    // O grant é por LISTA de colunas: coluna nova no espelho nasce ilegível para
    // `authenticated`. É o lado seguro, mas é uma decisão — este caso fica
    // vermelho até alguém escrever se a coluna nova vai ao alcance do membro
    // (entra no grant e na view, que andam juntos) ou não (entra em
    // NAO_CONCEDIDAS).
    //
    // ⚠️ "Concedida" NÃO quer dizer "não pessoal". O `title` é a única coluna
    // FORA do grant, mas não é o único dado pessoal: `external_calendar_id` está
    // DENTRO, e na agenda principal do Google ele é o e-mail da conta conectada.
    // Isso está declarado na 0261 e medido pelo último caso do describe da
    // migration. `external_event_id` também segue concedido, e `ical_uid` — o UID
    // RFC 5545 de quem criou o evento, não um id do Google — é resíduo do mesmo
    // período do `title` que a ressincronização não limpa (caso do service_role).
    const NAO_CONCEDIDAS = "title";
    const [foraDoGrant, viewForaDoGrant, ocupacaoNaView] = sondasDesfeitas(`
      select '${MARCA}' || coalesce(string_agg(a.attname, ',' order by a.attname), '(nenhuma)')
        from pg_attribute a
       where a.attrelid = 'public.calendar_external_events'::regclass
         and a.attnum > 0 and not a.attisdropped
         and not has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT');
      select '${MARCA}' || coalesce(string_agg(v.attname, ',' order by v.attname), '(nenhuma)')
        from pg_attribute v
       where v.attrelid = 'public.calendar_selected_external_events'::regclass
         and v.attnum > 0 and not v.attisdropped
         and not has_column_privilege('authenticated', 'public.calendar_external_events', v.attname::text, 'SELECT');
      select '${MARCA}' || string_agg(v.attname, ',' order by v.attname)
        from pg_attribute v
       where v.attrelid = 'public.calendar_selected_external_events'::regclass
         and v.attname in ('connection_id', 'ends_at', 'organization_id', 'starts_at', 'status', 'transparency');
    `);
    expect(
      foraDoGrant,
      "o conjunto de colunas que `authenticated` NÃO lê mudou — coluna nova no espelho, ou o `title` voltou ao alcance",
    ).toBe(NAO_CONCEDIDAS);
    expect(
      viewForaDoGrant,
      "a view traz coluna que `authenticated` não lê na tabela: com `security_invoker`, toda leitura da view vira 42501",
    ).toBe("(nenhuma)");
    expect(ocupacaoNaView, "a view perdeu coluna de que a grade precisa — a sonda acima mediria o vazio").toBe(
      "connection_id,ends_at,organization_id,starts_at,status,transparency",
    );
  });
});

describe("sob o default ACL do Supabase, simulado na transação antes do bloco da 0261", () => {
  it("controle: é a simulação, e não o dump, que dá à view recriada o grant a `anon` — sem ela a view nasce fechada, com ela nasce aberta", () => {
    // Sem este caso, os de baixo mediriam o default ACL que o dump deixou em
    // `pg_default_acl`, e não o do Supabase: o `grant` na view que a versão
    // anterior fazia sumia no `drop view` do bloco sem ninguém notar.
    const [semSimulacao, comSimulacao] = sondasDesfeitas(`
      ${SEM_DEFAULT_ACL_DE_TABELAS}
      ${RECRIA_A_VIEW}
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_selected_external_events', 'SELECT')::text;
      ${DEFAULT_ACL_DO_SUPABASE}
      ${RECRIA_A_VIEW}
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_selected_external_events', 'SELECT')::text;
    `);
    expect(semSimulacao, "sem default ACL de tabelas a view recriada já nasce legível por `anon` — o controle não isola nada").toBe(
      "false",
    );
    expect(
      comSimulacao,
      "a simulação não alcança a view que o bloco recria — os casos deste describe mediriam o dump, não o Supabase",
    ).toBe("true");
  });

  it("a view recriada pelo bloco não fica legível por `anon`, embora o default ACL do Supabase dê tudo a `anon` em relação nova", () => {
    // O bloco faz `drop` + `create` da view; o ACL dela nasce do default ACL, e
    // no Supabase ele concede a `anon`. É o `revoke all … from public, anon` do
    // bloco que fecha — e este caso mede esse revoke partindo de um banco SEM a
    // entrada do dump, para não depender dela.
    const [view] = sondasDesfeitas(`
      ${DEFEITO_DA_V1260}
      ${SEM_DEFAULT_ACL_DE_TABELAS}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0261()}
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_selected_external_events', 'SELECT')::text;
    `);
    expect(view, "com o default ACL do Supabase, `anon` lê a view da ocupação recriada pela 0261").toBe("false");
  });

  it("o colega que não é dono da conexão não lê o título, nem pela tabela nem pela view", () => {
    const pelaTabela = erroDo(`
      begin;
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select title from public.calendar_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(pelaTabela, "com o default ACL do Supabase o colega leu o título SEM erro").not.toBeNull();
    expect(pelaTabela).toContain("permission denied for table calendar_external_events");

    const pelaView = erroDo(`
      begin;
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select title from public.calendar_selected_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(pelaView, "com o default ACL do Supabase a view entrega o título").not.toBeNull();
    expect(pelaView).toContain('column "title" does not exist');
  });

  it("o dono lê a ocupação que a tela dele lê — e também não lê o título, porque nenhuma tela o mostra", () => {
    // Nenhuma tela lê `title` de evento externo (guardado por
    // `tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts`), então fechar a
    // coluna para o dono não tira nada do que ele vê. Se um dia houver tela do
    // titular, ela nasce com função `security definer` própria e este caso muda
    // junto, de propósito.
    const [tela] = sondasDesfeitas(`
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0261()}
      ${COMO_DONO}
      select '${MARCA}' || count(*)::text || ',' || coalesce(min(t.user_id::text), '(ninguém)') || ',' ||
             coalesce(min(t.transparency), '(nulo)') || ',' || coalesce(min(t.status), '(nulo)')
        from (${LEITURA_DA_TELA}) t;
    `);
    expect(tela, "o dono perdeu a própria ocupação na leitura da tela da Agenda").toBe(`1,${DONO},opaque,confirmed`);

    const titulo = erroDo(`
      begin;
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0261()}
      ${COMO_DONO}
      select title from public.calendar_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(titulo, "o dono lê o título pela sessão — o grant não é o da 0261").not.toBeNull();
    expect(titulo).toContain("permission denied for table calendar_external_events");
  });

  it("fn_agenda_ocupacao_google_do_dono (migration 0260) segue devolvendo a ocupação por cima da view recriada", () => {
    // A função do lote 10 lê `calendar_selected_external_events` de dentro de
    // uma `security definer`. O `drop view` da 0261 não pode deixá-la sem chão.
    const [colega, dono] = sondasDesfeitas(`
      ${FIXTURE}
      ${DEFEITO_DA_V1260}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0261()}
      ${COMO_COLEGA}
      select '${MARCA}' || count(*)::text || ',' || coalesce(min(o.transparency), '(nulo)') || ',' ||
             coalesce(min(o.status), '(nulo)') || ',' || coalesce(min(o.connection_status), '(nulo)')
        from public.fn_agenda_ocupacao_google_do_dono('${ORG}', '${DONO}', now(), now() + interval '2 days') o;
      ${COMO_DONO}
      select '${MARCA}' || count(*)::text
        from public.fn_agenda_ocupacao_google_do_dono('${ORG}', '${DONO}', now(), now() + interval '2 days') o;
    `);
    expect(colega, "o colega deixou de receber a ocupação do Google do dono pela função").toBe(
      "1,opaque,confirmed,healthy",
    );
    expect(dono, "o dono deixou de receber a própria ocupação pela função").toBe("1");
  });
});
