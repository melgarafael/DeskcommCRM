import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_MANAGER, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * A OCUPAÇÃO DO GOOGLE DO DONO NÃO DEPENDE DE QUEM PERGUNTA (issue #879, PR #883,
 * migration 0260) — medida no Postgres, sob `set role` e JWT de verdade.
 *
 * ═══ O que os testes de unidade não alcançam ═══
 *
 * `tests/unit/agenda-ocupacao-do-google-do-dono.test.ts` e os casos do Atendente
 * em `tests/unit/pessoa-marca-fora-da-grade.test.ts` provam que a coleta pergunta
 * à FUNÇÃO e que a resposta não muda com o olhar da sessão. Mas o olhar de lá é
 * um dublê. Quem garante que a função atravessa a RLS da conexão — e SÓ ela — é
 * este arquivo:
 *
 * 1. CONTROLE do defeito: pela junção que o PostgREST fazia, o atendente lê 0 e
 *    o dono lê 1. Se a policy de `calendar_connections` mudar, este caso avisa
 *    que a premissa da função mudou junto.
 * 2. Dono, gerente e atendente recebem a MESMA ocupação pela função.
 * 3. O dono é filtro: o Google de outra pessoa da casa não entra.
 * 4. Pertencimento conferido no corpo: quem é de OUTRA organização recebe zero,
 *    mesmo passando o `p_org` certo.
 * 5. `anon` não executa (as duas origens de EXECUTE revogadas).
 * 6. O que volta é ocupação: as colunas são as cinco declaradas, e o TÍTULO do
 *    evento não aparece em lugar nenhum da resposta.
 * 7. `service_role` (a ferramenta MCP, sem JWT) continua lendo.
 *
 * Conectar como `postgres` mediria NADA: aqui é `set local role` + claims.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_VIZINHA = randomUUID();
const USUARIO_DA_VIZINHA = randomUUID();
const CONEXAO_DO_DONO = randomUUID();
const CONEXAO_DO_GERENTE = randomUUID();

const TITULO_SIGILOSO = "Cirurgia sigilosa — paciente Fulano";
const INICIO = "2030-03-12T13:00:00.000Z";
const FIM = "2030-03-12T14:00:00.000Z";
const JANELA: [string, string] = ["2030-03-12T12:00:00.000Z", "2030-03-12T15:00:00.000Z"];

const OCUPACAO = "select * from public.fn_agenda_ocupacao_google_do_dono($1, $2, $3, $4)";
const CONEXOES = "select * from public.fn_agenda_conexoes_google_do_dono($1, $2)";
/** A leitura que a coleta fazia pelo PostgREST: o embed `calendar_connections!inner` com filtro de dono. */
const JUNCAO_DIRETA = `
  select e.starts_at from public.calendar_selected_external_events e
    join public.calendar_connections c on c.id = e.connection_id
   where e.organization_id = $1 and c.user_id = $2
     and e.starts_at < $4 and e.ends_at > $3`;

type Ator = { tipo: "usuario"; id: string } | { tipo: "anon" } | { tipo: "service_role" };

async function como(ator: Ator, sqlText: string, args: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (ator.tipo === "usuario") {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: ator.id, role: "authenticated" }),
      ]);
    } else if (ator.tipo === "anon") {
      await client.query("set local role anon");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    } else {
      await client.query("set local role service_role");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
    }
    return await client.query(sqlText, args);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

const usuario = (id: string): Ator => ({ tipo: "usuario", id });

beforeAll(async () => {
  seedGov();
  await pool.query("insert into auth.users(id, email) values ($1, $2)", [
    USUARIO_DA_VIZINHA,
    `${USUARIO_DA_VIZINHA}@invariant.test`,
  ]);
  await pool.query(
    "insert into organizations(id, slug, display_name, legal_name) values ($1, $2, 'Vizinha', 'Vizinha')",
    [ORG_VIZINHA, `vizinha-${ORG_VIZINHA}`],
  );
  await pool.query(
    "insert into user_organizations(organization_id, user_id, role, accepted_at) values ($1, $2, 'admin', now())",
    [ORG_VIZINHA, USUARIO_DA_VIZINHA],
  );

  // A agenda do DONO (um `agent`) e, na mesma casa, a do gerente — para o filtro
  // de dono ter o que recusar.
  for (const [conexao, dono] of [
    [CONEXAO_DO_DONO, GOV_AGENT_A],
    [CONEXAO_DO_GERENTE, GOV_MANAGER],
  ] as const) {
    await pool.query(
      `insert into calendar_connections(id, organization_id, user_id, provider, account_email, status, last_sync_at)
       values ($1, $2, $3, 'google_calendar', $4, 'healthy', now())`,
      [conexao, GOV_ORG, dono, `${conexao}@invariant.test`],
    );
    await pool.query(
      `insert into calendar_connection_calendars(id, organization_id, connection_id, external_calendar_id, name, is_destination, counts_for_conflicts, access_role)
       values ($1, $2, $3, 'primary', 'Principal', true, true, 'owner')`,
      [randomUUID(), GOV_ORG, conexao],
    );
    await pool.query(
      `insert into calendar_external_events(organization_id, connection_id, external_calendar_id, external_event_id, title, starts_at, ends_at)
       values ($1, $2, 'primary', $3, $4, $5, $6)`,
      [GOV_ORG, conexao, `ev-${conexao}`, TITULO_SIGILOSO, INICIO, FIM],
    );
  }
});

afterAll(() => pool.end());

describe("a premissa: a RLS da conexão esconde o Google do dono de um atendente", () => {
  it("CONTROLE: pela junção direta o dono lê 1 e o atendente lê 0", async () => {
    const args = [GOV_ORG, GOV_AGENT_A, ...JANELA];
    expect((await como(usuario(GOV_AGENT_A), JUNCAO_DIRETA, args)).rowCount).toBe(1);
    expect((await como(usuario(GOV_AGENT_B), JUNCAO_DIRETA, args)).rowCount).toBe(0);
  });
});

describe("fn_agenda_ocupacao_google_do_dono", () => {
  it("dono, gerente e atendente recebem a MESMA ocupação", async () => {
    const args = [GOV_ORG, GOV_AGENT_A, ...JANELA];
    const respostas = await Promise.all(
      [GOV_AGENT_A, GOV_MANAGER, GOV_AGENT_B].map(async (id) =>
        (await como(usuario(id), OCUPACAO, args)).rows.map((l) => [
          new Date(l.starts_at).toISOString(),
          new Date(l.ends_at).toISOString(),
          l.connection_status,
        ]),
      ),
    );
    expect(respostas[0]).toEqual([[INICIO, FIM, "healthy"]]);
    expect(respostas[1]).toEqual(respostas[0]);
    expect(respostas[2], "o atendente não viu o Google do dono — a ocupação ainda depende de quem pergunta").toEqual(
      respostas[0],
    );
  });

  it("o dono é filtro: pedir a agenda do gerente não traz o Google do dono, e vice-versa", async () => {
    const doGerente = await como(usuario(GOV_AGENT_B), OCUPACAO, [GOV_ORG, GOV_MANAGER, ...JANELA]);
    expect(doGerente.rowCount).toBe(1);
    const alguem = await como(usuario(GOV_AGENT_B), OCUPACAO, [GOV_ORG, randomUUID(), ...JANELA]);
    expect(alguem.rowCount, "usuário sem conexão recebeu ocupação de outra pessoa").toBe(0);
  });

  it("encostar não é ocupar: a janela que termina no início do evento não o traz", async () => {
    const r = await como(usuario(GOV_AGENT_B), OCUPACAO, [GOV_ORG, GOV_AGENT_A, JANELA[0], INICIO]);
    expect(r.rowCount).toBe(0);
  });

  it("quem é de OUTRA organização recebe zero, mesmo passando o p_org certo", async () => {
    const r = await como(usuario(USUARIO_DA_VIZINHA), OCUPACAO, [GOV_ORG, GOV_AGENT_A, ...JANELA]);
    expect(r.rowCount, "leitura cross-tenant: a função confiou no p_org do argumento").toBe(0);
  });

  it("anon não executa", async () => {
    await expect(como({ tipo: "anon" }, OCUPACAO, [GOV_ORG, GOV_AGENT_A, ...JANELA])).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("devolve ocupação, nunca conteúdo: cinco colunas, e o título não aparece", async () => {
    const r = await como(usuario(GOV_AGENT_B), OCUPACAO, [GOV_ORG, GOV_AGENT_A, ...JANELA]);
    expect(r.fields.map((f) => f.name)).toEqual(["starts_at", "ends_at", "transparency", "status", "connection_status"]);
    expect(JSON.stringify(r.rows)).not.toContain("Cirurgia");
  });

  it("service_role (a ferramenta MCP, sem JWT) continua lendo", async () => {
    const r = await como({ tipo: "service_role" }, OCUPACAO, [GOV_ORG, GOV_AGENT_A, ...JANELA]);
    expect(r.rowCount).toBe(1);
  });
});

describe("fn_agenda_conexoes_google_do_dono", () => {
  it("CONTROLE: o atendente não lê a conexão do dono direto na tabela", async () => {
    const r = await como(
      usuario(GOV_AGENT_B),
      "select status from public.calendar_connections where organization_id = $1 and user_id = $2",
      [GOV_ORG, GOV_AGENT_A],
    );
    expect(r.rowCount).toBe(0);
  });

  it("o atendente recebe a situação da conexão do dono — e só status e last_sync_at", async () => {
    const r = await como(usuario(GOV_AGENT_B), CONEXOES, [GOV_ORG, GOV_AGENT_A]);
    expect(r.fields.map((f) => f.name)).toEqual(["status", "last_sync_at"]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].status).toBe("healthy");
    expect(r.rows[0].last_sync_at).not.toBeNull();
  });

  it("outra organização recebe zero; anon não executa", async () => {
    expect((await como(usuario(USUARIO_DA_VIZINHA), CONEXOES, [GOV_ORG, GOV_AGENT_A])).rowCount).toBe(0);
    await expect(como({ tipo: "anon" }, CONEXOES, [GOV_ORG, GOV_AGENT_A])).rejects.toMatchObject({ code: "42501" });
  });
});
