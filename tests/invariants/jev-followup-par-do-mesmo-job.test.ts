import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { registrarFollowupDoJev, type EscolhaDoJev } from "@/lib/ai/decisao/followup";

/**
 * O PAR DO JEV NO FOLLOW-UP SÓ SE COMPLETA PELO MESMO JOB (revisão da onda 4.1).
 *
 * `jev_observacoes` tem uma linha por (organização, tarefa, mensagem). A linha
 * que nasceu sem o lado da IA de sempre (ela falhou, ou o passo não foi
 * concluído) é completada pela repetição do MESMO job. Até o conserto,
 * QUALQUER gravação sobre a mesma mensagem a completava: um segundo passo
 * "Classificar" lendo a mesma resposta, ou o fluxo de outra inscrição do mesmo
 * contato, perguntou entre OUTRAS saídas — e a classe dele entrava contra a do
 * Jev, uma concordância (ou discordância) que não mede nada.
 *
 * Gravação de produção (`registrarFollowupDoJev`) contra Postgres real: o
 * índice único parcial e o `on conflict` só existem no banco.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

async function cenario() {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Jev Par', 'Jev Par')`,
    [org, `jev-par-${org}`],
  );
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', '+5511900000442') returning id`,
    [org],
  );
  const contato = ct[0]!.id;
  const job = async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into job_queue (organization_id, contact_id, kind, payload) values ($1, $2, 'followup_turn', '{}'::jsonb) returning id`,
      [org, contato],
    );
    return rows[0]!.id;
  };
  return { org, contato, jobDoPasso: await job(), jobDeOutroPasso: await job() };
}

function escolha(classe: string, messageId: string): EscolhaDoJev {
  return {
    estado: "observando",
    classe,
    probabilidade: 0.8,
    confianca: 0.7,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 200,
    tokensDeSaida: 2,
    latenciaMs: 300,
    messageId,
  };
}

async function linhas(org: string) {
  const { rows } = await pool.query(
    `select job_id, rotulo_jev, rotulo_atual, concordou from jev_observacoes where organization_id = $1 and tarefa = 'followup'`,
    [org],
  );
  return rows;
}

async function custos(org: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from llm_calls where organization_id = $1 and purpose = 'followup_classify' and provider = 'typesafe'`,
    [org],
  );
  return rows[0]!.n;
}

describe("o par do Jev na resposta ao follow-up", () => {
  it("outro job sobre a MESMA mensagem não completa o par sem a IA de sempre — o mesmo job completa", async () => {
    const c = await cenario();
    const mensagem = randomUUID();
    const entrada = (jobId: string) => ({ organizationId: c.org, contactId: c.contato, jobId, conversationId: null });

    // O passo não foi concluído com a saída da IA de sempre: a linha nasce sem par.
    await registrarFollowupDoJev(pool, entrada(c.jobDoPasso), escolha("não quer", mensagem), null);
    expect(await linhas(c.org)).toEqual([
      { job_id: c.jobDoPasso, rotulo_jev: "não quer", rotulo_atual: null, concordou: null },
    ]);

    // Outro passo "Classificar", com OUTRAS saídas, lê a mesma resposta.
    await registrarFollowupDoJev(pool, entrada(c.jobDeOutroPasso), escolha("respondeu", mensagem), "respondeu");
    expect(await linhas(c.org)).toEqual([
      { job_id: c.jobDoPasso, rotulo_jev: "não quer", rotulo_atual: null, concordou: null },
    ]);
    // A chamada dele aconteceu e foi paga: o custo entra mesmo sem par.
    expect(await custos(c.org)).toBe(2);

    // A repetição do MESMO job, que concluiu o passo: o par se completa, com a 1ª resposta do Jev.
    await registrarFollowupDoJev(pool, entrada(c.jobDoPasso), escolha("quer", mensagem), "quer");
    expect(await linhas(c.org)).toEqual([
      { job_id: c.jobDoPasso, rotulo_jev: "não quer", rotulo_atual: "quer", concordou: false },
    ]);

    // Completo, o par não muda mais — nem pelo mesmo job.
    await registrarFollowupDoJev(pool, entrada(c.jobDoPasso), escolha("quer", mensagem), "não quer");
    expect(await linhas(c.org)).toEqual([
      { job_id: c.jobDoPasso, rotulo_jev: "não quer", rotulo_atual: "quer", concordou: false },
    ]);
  });
});
