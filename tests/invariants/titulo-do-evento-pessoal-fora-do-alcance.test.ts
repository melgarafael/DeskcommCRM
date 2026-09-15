import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * O TÍTULO DO EVENTO PESSOAL DO GOOGLE NÃO ALCANÇA OUTRO MEMBRO — migration 0260.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `public.calendar_external_events` é o espelho da agenda PESSOAL de quem
 * atende. O papel `authenticated` tinha SELECT de TABELA nela e a view
 * `calendar_selected_external_events` era `select e.*` — com o `title` dentro.
 * Qualquer membro da organização, inclusive Somente leitura, lia o compromisso
 * particular do colega: "Consulta médica", "Terapia", "entrevista de emprego".
 * O CRM só precisava daquele evento como ocupado ou livre.
 *
 * O gate de TELA (`tests/unit/ocupacao-do-google-nao-expoe-titulo.test.ts`)
 * guarda os caminhos por onde a ocupação chega à Agenda e não protege o BANCO:
 * quem tem a chave da organização e fala direto com a REST não passa por lá. É
 * essa a camada que este arquivo vigia.
 *
 * ─── Por que um arquivo próprio, e o que ele mede ───────────────────────────
 *
 * 1. o CONTROLE reconstrói o estado da v1.26.0 dentro da transação — `grant
 *    select on table` + a view `select e.*` — e mostra o vazamento acontecendo;
 *    sem ele, um instrumento quebrado deixaria os casos de baixo verdes por
 *    nada, que é o pior desfecho para uma guarda de privacidade;
 * 2. o bloco da 0260, LIDO do `supabase/baseline.sql` pelo rótulo — o texto que
 *    o self-host aplica, não uma cópia;
 * 3. só então a sonda: o colega barrado no `title`, a ocupação de pé para ele, e
 *    o espelho do dono inteiro.
 *
 * ─── O que ele NÃO exige ────────────────────────────────────────────────────
 *
 * Não exige que a policy de leitura deixe de ser da organização: ela É da
 * organização, de propósito, porque a grade da equipe mostra a ocupação do
 * colega. O que se mede é o PRIVILÉGIO DE COLUNA, que é onde o título estava
 * exposto.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const ROTULO_0260 =
  "-- ---- PRIVACIDADE: o título do evento pessoal do Google sai do alcance do membro (migration 0260) ----";

/** O bloco rotulado da 0260, do rótulo até o próximo rótulo de apêndice. */
function blocoDa0260(): string {
  const inicio = BASELINE.indexOf(ROTULO_0260);
  if (inicio === -1) throw new Error("rótulo da 0260 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0260, inicio + 1) !== -1) throw new Error("rótulo da 0260 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0260.length);
  if (fim === -1) throw new Error("fim do bloco da 0260 não encontrado");
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

const ORG = "02600000-0000-4000-8000-0000000000a1";
const DONO = "02600000-0000-4000-8000-000000000001";
const COLEGA = "02600000-0000-4000-8000-000000000002";
const CONEXAO = "02600000-0000-4000-8000-0000000000c1";
const EVENTO = "02600000-0000-4000-8000-0000000000e1";

/** O compromisso pessoal que ninguém na recepção deveria ler. */
const TITULO = "Terapia sigilosa";

/**
 * A agenda pessoal do `DONO`, com o evento e com o `COLEGA` na mesma
 * organização em papel `viewer` — o caso mais generoso para quem espia, e por
 * isso o caso do defeito.
 */
const FIXTURE = `
  insert into auth.users (id, email) values
    ('${DONO}', 'dono-0260@invariant.test'),
    ('${COLEGA}', 'colega-0260@invariant.test');
  insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'inv-0260', 'Inv 0260', 'Inv 0260');
  insert into public.user_organizations (organization_id, user_id, role, accepted_at) values
    ('${ORG}', '${DONO}', 'agent', now()),
    ('${ORG}', '${COLEGA}', 'viewer', now());
  insert into public.calendar_connections (id, organization_id, user_id, provider, account_email, status)
    values ('${CONEXAO}', '${ORG}', '${DONO}', 'google_calendar', 'dono-0260@invariant.test', 'healthy');
  insert into public.calendar_external_events
    (id, organization_id, connection_id, external_calendar_id, external_event_id,
     title, starts_at, ends_at, transparency)
    values ('${EVENTO}', '${ORG}', '${CONEXAO}', 'pessoal', 'ev-0260', '${TITULO}',
            now() + interval '1 day', now() + interval '1 day 1 hour', 'opaque');
`;

/** Fala como o `COLEGA` — o membro que NÃO é dono da conexão. */
const COMO_COLEGA = `
  select set_config('request.jwt.claims', '{"sub":"${COLEGA}","role":"authenticated"}', true);
  set local role authenticated;
`;

/** Marcador das linhas de resultado: a saída do psql traz também BEGIN, SET, GRANT… */
const MARCA = "SONDA|";

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

describe("migration 0260 — o título do evento pessoal fora do alcance do membro", () => {
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

  it("com o bloco da 0260, o colega recebe permission denied no título — o erro, não zero linhas", () => {
    // "Zero linhas" seria indistinguível de "não há evento", e o alvo aqui é a
    // COLUNA: o Postgres tem de recusar a leitura, não devolver vazio.
    const erro = erroDo(`
      begin;
      ${FIXTURE}
      ${blocoDa0260()}
      ${COMO_COLEGA}
      select title from public.calendar_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(erro, "o colega leu o título do evento pessoal do dono SEM erro").not.toBeNull();
    expect(erro).toContain("permission denied for table calendar_external_events");
  });

  it("com o bloco da 0260, o SELECT de tabela sai e a ocupação continua concedida", () => {
    const [tabela, titulo, ocupacao] = sondasDesfeitas(`
      ${blocoDa0260()}
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

  it("a ocupação do colega continua visível, pela tabela e pela view — o conserto não quebra a grade", () => {
    // Este é o caso que impede o conserto fácil: se a privacidade só funcionar
    // apagando a ocupação de todo mundo, ela quebrou a agenda em vez de
    // consertá-la.
    const [direto, pelaView] = sondasDesfeitas(`
      ${FIXTURE}
      ${blocoDa0260()}
      ${COMO_COLEGA}
      select '${MARCA}' || 'tabela=' || starts_at::text || ',' || ends_at::text || ',' || transparency || ',' || status
        from public.calendar_external_events where id = '${EVENTO}';
      select '${MARCA}' || 'view=' || count(*)::text
        from public.calendar_selected_external_events where id = '${EVENTO}';
    `);
    expect(direto, "o colega perdeu a ocupação direto na tabela").toMatch(
      /^tabela=.+,.+,opaque,confirmed$/,
    );
    expect(pelaView, "o colega perdeu a ocupação pela view — a grade da equipe esvaziaria").toBe("view=1");
  });

  it("a view recriada não tem `title` na definição — e pedi-lo é erro, não silêncio", () => {
    // A view era `select e.*`: era por ali que a próxima coluna nasceria
    // exposta, e o `e.*` já expandido não é conferível pela lista de colunas.
    const [colunas] = sondasDesfeitas(`
      ${blocoDa0260()}
      select '${MARCA}' || coalesce(string_agg(column_name, ',' order by column_name), '(sem colunas)')
        from information_schema.columns
       where table_schema = 'public' and table_name = 'calendar_selected_external_events'
         and column_name in ('title', 'description', 'location', 'attendees');
    `);
    expect(colunas, "a view da ocupação voltou a carregar coluna de conteúdo").toBe("(sem colunas)");

    const erro = erroDo(`
      begin;
      ${FIXTURE}
      ${blocoDa0260()}
      ${COMO_COLEGA}
      select title from public.calendar_selected_external_events where id = '${EVENTO}';
      rollback;
    `);
    expect(erro, "a view ainda entrega o título").not.toBeNull();
    expect(erro).toContain('column "title" does not exist');
  });

  it("o espelho do dono fica inteiro: service_role segue lendo e gravando o título", () => {
    // O que a 0260 fecha é a LEITURA por outro membro, não o dado do dono.
    // Apagar título é decisão do dono, em migration própria.
    const [espelho, gravou] = sondasDesfeitas(`
      ${FIXTURE}
      ${blocoDa0260()}
      select '${MARCA}' || has_column_privilege(
        'service_role', 'public.calendar_external_events', 'title', 'SELECT')::text || ',' ||
        has_column_privilege('service_role', 'public.calendar_external_events', 'title', 'UPDATE')::text;
      insert into public.calendar_external_events
        (id, organization_id, connection_id, external_calendar_id, external_event_id,
         title, starts_at, ends_at)
        values ('02600000-0000-4000-8000-0000000000e2', '${ORG}', '${CONEXAO}', 'pessoal', 'ev-0260-2',
                '${TITULO} (espelho)', now() + interval '2 days', now() + interval '2 days 1 hour')
        on conflict (id) do update set title = excluded.title;
      select '${MARCA}' || 'gravadas=' || count(*)::text
        from public.calendar_external_events
       where connection_id = '${CONEXAO}' and title like '${TITULO}%';
    `);
    expect(espelho, "o espelho perdeu o título para o service_role").toBe("true,true");
    expect(gravou, "o espelho deixou de gravar o título").toBe("gravadas=2");
  });

  it("`anon` continua sem SELECT — o bloco não abre porta nova", () => {
    const [tabela, view] = sondasDesfeitas(`
      ${blocoDa0260()}
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_external_events', 'SELECT')::text;
      select '${MARCA}' || has_table_privilege('anon', 'public.calendar_selected_external_events', 'SELECT')::text;
    `);
    expect(tabela, "`anon` ganhou leitura da tabela do espelho").toBe("false");
    expect(view, "`anon` ganhou leitura da view da ocupação").toBe("false");
  });
});
