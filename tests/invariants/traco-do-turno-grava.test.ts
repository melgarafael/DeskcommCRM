/**
 * O TRAÇO DO TURNO GRAVA DE VERDADE (issue #2869, migration 0721).
 *
 * `registrarTracoDoTurno` engole todo erro de propósito: observabilidade não
 * pode derrubar o atendimento. O preço é que um SQL quebrado não dá vermelho em
 * lugar nenhum — o turno segue, e a tabela fica vazia em silêncio. Este arquivo
 * é a medida que falta: grava num Postgres real, com um logger que REPROVA o
 * teste no primeiro `warn`.
 *
 * O caso do modelo semeia uma linha em `llm_calls` com OUTRO modelo de
 * propósito: só assim ele separa "gravou o modelo do turno" de "caiu no
 * `coalesce` com o maior modelo das chamadas do job".
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  montarTracoDoTurno,
  registrarTracoDoTurno,
  type EntradaDoTraco,
} from "@/lib/agent-engine/agent/traco-do-turno";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const logQueReprova: Logger = {
  info: () => {},
  warn: (msg, fields) => {
    throw new Error(`warn inesperado: ${msg} ${JSON.stringify(fields)}`);
  },
  error: (msg, fields) => {
    throw new Error(`error inesperado: ${msg} ${JSON.stringify(fields)}`);
  },
};

const org = randomUUID();
const contato = randomUUID();
const job = randomUUID();

function entrada(extra: Partial<EntradaDoTraco> = {}): EntradaDoTraco {
  return {
    organizationId: org,
    jobId: job,
    previewRunId: null,
    conversationId: null,
    contactId: contato,
    agentId: null,
    agentVersionId: null,
    isDryRun: false,
    status: "completed",
    abortReason: null,
    errorCode: null,
    errorMessage: null,
    provider: "provedor-do-turno",
    model: "modelo-do-turno",
    messagesSent: 1,
    historicoMensagens: null,
    knowledgeSourceIds: [],
    ferramentas: [{ nome: "send_message", estado: "ok", erro: null, duracao_ms: 12 }],
    ...extra,
  };
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Traço','Traço')",
    [org],
  );
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Traço')", [
    contato,
    org,
  ]);
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,status,payload,locked_by,locked_at) values($1,$2,$3,'inbound_turn','running','{}','traco-test',now())",
    [job, org, contato],
  );
  // OUTRO modelo nas chamadas do job: é o que o fallback do `coalesce` pegaria.
  await pool.query(
    `insert into llm_calls(organization_id,contact_id,job_id,provider,model,input_tokens,output_tokens,cost_cents,latency_ms)
     values($1,$2,$3,'provedor-auxiliar','zz-modelo-auxiliar',100,20,3,400)`,
    [org, contato, job],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [org]);
  await pool.end();
});

describe("registrarTracoDoTurno num banco real", () => {
  it("grava a linha do turno real com o modelo DO TURNO e os agregados do job", async () => {
    await registrarTracoDoTurno(pool, montarTracoDoTurno(entrada()), logQueReprova);

    const { rows } = await pool.query(
      "select status, provider, model, messages_sent, tokens_in, tokens_out, ferramentas, is_dry_run from agent_turn_traces where job_id = $1",
      [job],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "completed",
      provider: "provedor-do-turno",
      model: "modelo-do-turno",
      messages_sent: 1,
      tokens_in: 100,
      tokens_out: 20,
      is_dry_run: false,
    });
    expect(rows[0].ferramentas).toEqual([
      { nome: "send_message", estado: "ok", erro: null, duracao_ms: 12 },
    ]);
  });

  it("repetir o mesmo job ATUALIZA a linha em vez de duplicar", async () => {
    await registrarTracoDoTurno(
      pool,
      montarTracoDoTurno(
        entrada({ status: "failed", model: "modelo-da-retentativa", errorMessage: "caiu" }),
      ),
      logQueReprova,
    );

    const { rows } = await pool.query(
      "select status, model, error_message from agent_turn_traces where job_id = $1",
      [job],
    );
    expect(rows).toEqual([
      { status: "failed", model: "modelo-da-retentativa", error_message: "caiu" },
    ]);
  });

  it("a prévia grava com a própria chave, marcada como prévia, e guarda o modelo", async () => {
    const run = `run-${randomUUID()}`;
    await registrarTracoDoTurno(
      pool,
      montarTracoDoTurno(entrada({ jobId: null, previewRunId: run, isDryRun: true })),
      logQueReprova,
    );

    const { rows } = await pool.query(
      "select job_id, is_dry_run, model, provider from agent_turn_traces where preview_run_id = $1",
      [run],
    );
    expect(rows).toEqual([
      { job_id: null, is_dry_run: true, model: "modelo-do-turno", provider: "provedor-do-turno" },
    ]);
  });

  it("a sessão do usuário NÃO grava: a escrita é só do motor", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await expect(
        client.query(
          "insert into agent_turn_traces(organization_id, preview_run_id, is_dry_run, status) values($1,'x',true,'completed')",
          [org],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
