import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * CONVIDADOS DA EQUIPE NO COMPROMISSO — o schema, no banco de verdade (#4006).
 *
 * A feature tem três invariantes que NÃO se provam no TypeScript:
 *
 * 1. **O par (compromisso, pessoa) é único** — sem isso o mesmo colega entra
 *    duas vezes e o Google recusa o evento inteiro por e-mail repetido.
 * 2. **As FKs são COMPOSTAS com a organização** — id de outra empresa tem de
 *    ser recusado pelo BANCO, não só pelo código. Sem a FK composta, um id
 *    adivinhado entraria e o gatilho mexeria na revisão de um compromisso
 *    alheio.
 * 3. **A mudança de convidado sobe a revisão publicável** — é o que faz o
 *    worker de push selecionar a linha. A função inteira mora no banco, então
 *    o teste do texto dela é o único jeito de provar isso sem cron.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function linhas(q: string): string[] {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", q],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const COLUNAS = `
  select column_name || ':' || data_type || ':' || is_nullable
    from information_schema.columns
   where table_schema = 'public' and table_name = 'calendar_appointment_team_guests'
   order by column_name
`;

describe("a tabela dos convidados da equipe", () => {
  it("existe com as colunas e a semântica de remoção", () => {
    expect(linhas(COLUNAS)).toEqual([
      "appointment_id:uuid:NO",
      "created_at:timestamp with time zone:NO",
      "id:uuid:NO",
      "organization_id:uuid:NO",
      "removed_at:timestamp with time zone:YES",
      "user_id:uuid:NO",
    ]);
  });

  it("um par (compromisso, pessoa) por linha", () => {
    const definicao = linhas(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conname = 'calendar_appointment_team_guests_unico'`,
    ).join(" ");
    expect(definicao).toContain("UNIQUE (appointment_id, user_id)");
  });

  it("as duas FKs levam a ORGANIZAÇÃO junto — id de outra empresa é recusado pelo banco", () => {
    const compromisso = linhas(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conname = 'calendar_appointment_team_guests_compromisso_fkey'`,
    ).join(" ");
    const membro = linhas(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conname = 'calendar_appointment_team_guests_membro_fkey'`,
    ).join(" ");
    expect(compromisso).toContain("FOREIGN KEY (organization_id, appointment_id)");
    expect(compromisso).toContain("calendar_appointments(organization_id, id)");
    expect(membro).toContain("FOREIGN KEY (user_id, organization_id)");
    expect(membro).toContain("user_organizations(user_id, organization_id)");
  });

  it("RLS ligada, leitura por organização e escrita por `agent` — a régua da agenda", () => {
    const rls = linhas(
      `select relrowsecurity from pg_class
        where oid = 'public.calendar_appointment_team_guests'::regclass`,
    );
    expect(rls).toEqual(["t"]);

    const select = linhas(
      `select qual from pg_policies
        where schemaname = 'public' and tablename = 'calendar_appointment_team_guests'
          and cmd = 'SELECT'`,
    ).join(" ");
    expect(select).toContain("fn_user_org_ids");

    const escrita = linhas(
      `select coalesce(qual, '') || ' ' || coalesce(with_check, '') from pg_policies
        where schemaname = 'public' and tablename = 'calendar_appointment_team_guests'
          and cmd = 'ALL'`,
    ).join(" ");
    expect(escrita).toContain("fn_role_at_least");
    expect(escrita).toContain("'agent'::text");
  });
});

describe("o tipo de agendamento ganha os dois campos", () => {
  it("convidados_padrao é uuid[] e nasce vazio", () => {
    expect(
      linhas(`select data_type || ':' || coalesce(column_default, '')
                from information_schema.columns
               where table_schema = 'public' and table_name = 'calendar_event_types'
                 and column_name = 'convidados_padrao'`),
    ).toEqual(["ARRAY:'{}'::uuid[]"]);
  });

  it("levar_dados_do_negocio é boolean e nasce LIGADO", () => {
    expect(
      linhas(`select data_type || ':' || coalesce(column_default, '')
                from information_schema.columns
               where table_schema = 'public' and table_name = 'calendar_event_types'
                 and column_name = 'levar_dados_do_negocio'`),
    ).toEqual(["boolean:true"]);
  });
});

describe("mudar convidado marca o compromisso para o Google", () => {
  it("o gatilho existe nas três operações", () => {
    const gatilho = linhas(
      `select tgtype::text from pg_trigger
        where tgname = 'trg_convidados_da_equipe_marcam_google' and not tgisinternal`,
    );
    expect(gatilho).toHaveLength(1);
    // 5 = ROW, 4 = INSERT, 8 = DELETE, 16 = UPDATE na máscara do Postgres.
    const tipo = Number(gatilho[0]);
    expect(tipo & 4).toBe(4);
    expect(tipo & 8).toBe(8);
    expect(tipo & 16).toBe(16);
  });

  it("a função sobe SÓ a revisão publicável — não toca metadata privada", () => {
    const corpo = linhas(
      `select pg_get_functiondef('public.fn_convidados_da_equipe_marcam_google()'::regprocedure)`,
    ).join("\n");
    // `pg_get_functiondef` devolve os COMENTÁRIOS do corpo também, então a
    // asserção é sobre a ATRIBUIÇÃO — a prosa explica justamente o que a
    // função não toca, e citar o nome basta para mentir o teste.
    expect(corpo).toContain("google_local_revision = google_local_revision + 1");
    expect(corpo).not.toContain("google_next_attempt_at =");
    expect(corpo).not.toContain("google_pending_write =");
    // `pg_get_functiondef` devolve as palavras-chave em MAIÚSCULA.
    expect(corpo.toUpperCase()).toContain("SECURITY DEFINER");
  });
});
