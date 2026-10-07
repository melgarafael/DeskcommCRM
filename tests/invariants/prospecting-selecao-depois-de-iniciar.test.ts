/**
 * MARCAR, DESMARCAR E EXCLUIR EMPRESAS DEPOIS DE INICIADA — num Postgres de verdade.
 *
 * A fila de uma campanha pausada passa a aceitar escolha do operador. O que só uma linha
 * de verdade responde:
 *
 * 1. desmarcar tira da fila só quem está `queued`, e o envio (que só pega `queued`) não a
 *    alcança mais; quem já teve tentativa (`sent`, `failed`, `sending`) não muda;
 * 2. marcar de novo devolve só quem o OPERADOR tirou — nunca quem o produto recusou (sem
 *    telefone, já era contato) —, e, no modo `on_start`, só quem já tem conversa;
 * 3. outra organização, mesmo sabendo os ids, não alcança nada, nos DOIS níveis (a função e o
 *    SQL cru, porque a leitura de antes pode sumir num refactor e o teste da função
 *    continuaria verde);
 * 4. excluir as desmarcadas apaga SÓ a linha da busca de quem o operador tirou e que nunca
 *    virou registro do CRM, e preserva a linha-tomba (`suppression_salt`) de quem exerceu
 *    opt-out ou exclusão, que é o que o gatilho de reimportação consulta.
 *
 * Cada arquivo de invariante recebe um banco novo (`tests/db/banco-limpo-por-arquivo.ts`).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RAZAO_NAO_SELECIONADA } from "@/lib/prospecting/schema";
import {
  DESCARTAR_DESMARCADAS_SQL,
  FILA_DESMARCAR_SQL,
  descartarDesmarcadas,
  selecionarNaFila,
} from "@/lib/prospecting/store";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const db = pool as unknown as pg.Pool;

const ORG_A = "0b120000-0000-4000-8000-000000000001";
const ORG_B = "0b120000-0000-4000-8000-000000000002";
const PAUSADA_NO_ENVIO = "0b120000-1111-4000-8000-000000000001";
const PAUSADA_AO_INICIAR = "0b120000-1111-4000-8000-000000000002";
const RODANDO = "0b120000-1111-4000-8000-000000000003";
const RASCUNHO = "0b120000-1111-4000-8000-000000000004";
const DE_OUTRA_ORG = "0b120000-1111-4000-8000-000000000005";

const CONFIG = {
  agent_id: "0b120000-2222-4000-8000-000000000001",
  channel_session_id: "0b120000-2222-4000-8000-000000000002",
  pipeline_id: "0b120000-2222-4000-8000-000000000003",
  stage_id: "0b120000-2222-4000-8000-000000000004",
  qualified_stage_id: "0b120000-2222-4000-8000-000000000005",
  instruction: "Vender consultoria para clínicas.",
  qualification: "Confirmou a necessidade e a decisão.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "LIA-teste",
};

let canalA = "";
/** Uma conversa de verdade: `conversation_id` é chave estrangeira, e o id inventado não passaria. */
async function conversa(n: number): Promise<string> {
  const contato = `0b120000-6666-4000-8000-${String(n).padStart(12, "0")}`;
  const conv = `0b120000-4444-4000-8000-${String(n).padStart(12, "0")}`;
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Empresa de teste')",
    [contato, ORG_A],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conv, ORG_A, contato, canalA],
  );
  return conv;
}

let contador = 0;
const telefone = () => `+55119999${String(++contador).padStart(5, "0")}`;
const cand = (n: number) => `0b120000-3333-4000-8000-${String(n).padStart(12, "0")}`;

async function campanha(id: string, org: string, status: string, config: unknown) {
  await pool.query(
    `insert into prospecting_campaigns(id,organization_id,request_id,name,search,status,config)
     values ($1,$2,gen_random_uuid(),$3,'{}',$4,$5::jsonb)`,
    [id, org, `c-${id.slice(-3)}`, status, config === null ? null : JSON.stringify(config)],
  );
}
async function candidato(
  n: number,
  camp: string,
  org: string,
  campos: {
    status?: string;
    selected?: boolean;
    error?: string | null;
    conversation?: string | null;
    contact?: string | null;
    salt?: boolean;
  } = {},
) {
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,phone,data,status,selected,error,conversation_id,contact_id,suppression_salt)
     values ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9,$10,$11)`,
    [
      cand(n),
      org,
      camp,
      `place-${n}`,
      telefone(),
      campos.status ?? "queued",
      campos.selected ?? true,
      campos.error ?? null,
      campos.conversation ?? null,
      campos.contact ?? null,
      campos.salt ? Buffer.alloc(32, 1) : null,
    ],
  );
}
async function estado(n: number) {
  const { rows } = await pool.query(
    "select status, selected, error from prospecting_candidates where id = $1",
    [cand(n)],
  );
  return rows[0] as { status: string; selected: boolean; error: string | null } | undefined;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'sel-a','A','A'), ($2,'sel-b','B','B')`,
    [ORG_A, ORG_B],
  );
  canalA = (
    await pool.query(
      "insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,gen_random_uuid()::text,'WORKING',decode('00','hex')) returning id",
      [ORG_A],
    )
  ).rows[0].id;
  await campanha(PAUSADA_NO_ENVIO, ORG_A, "paused", { ...CONFIG, funnel_entry: "on_send" });
  await campanha(PAUSADA_AO_INICIAR, ORG_A, "paused", { ...CONFIG, funnel_entry: "on_start" });
  await campanha(RODANDO, ORG_A, "running", { ...CONFIG, funnel_entry: "on_send" });
  await campanha(RASCUNHO, ORG_A, "draft", null);
  await campanha(DE_OUTRA_ORG, ORG_B, "paused", { ...CONFIG, funnel_entry: "on_send" });
});
afterAll(() => pool.end());

describe("desmarcar quem está na fila", () => {
  it("tira da fila só quem está `queued`, com o motivo do operador; quem já teve tentativa não muda", async () => {
    await candidato(1, PAUSADA_NO_ENVIO, ORG_A, { status: "queued" });
    await candidato(2, PAUSADA_NO_ENVIO, ORG_A, { status: "sent" });
    await candidato(3, PAUSADA_NO_ENVIO, ORG_A, { status: "failed", error: "x" });
    await candidato(4, PAUSADA_NO_ENVIO, ORG_A, { status: "sending" });
    const r = await selecionarNaFila(
      db,
      ORG_A,
      PAUSADA_NO_ENVIO,
      [cand(1), cand(2), cand(3), cand(4)],
      false,
    );
    expect(r.changed_ids).toEqual([cand(1)]);
    expect(await estado(1)).toEqual({
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
    });
    expect((await estado(2))?.status).toBe("sent");
    expect((await estado(3))?.status).toBe("failed");
    expect((await estado(4))?.status).toBe("sending");
  });
});

describe("marcar de novo", () => {
  it("no modo `on_send`, devolve à fila a que o operador tirou", async () => {
    const r = await selecionarNaFila(db, ORG_A, PAUSADA_NO_ENVIO, [cand(1)], true);
    expect(r.changed_ids).toEqual([cand(1)]);
    expect(await estado(1)).toEqual({ status: "queued", selected: true, error: null });
  });

  it("NÃO ressuscita quem o produto recusou: sem telefone e contato que já existia continuam fora", async () => {
    await candidato(10, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: true,
      error: "Sem telefone brasileiro válido.",
    });
    await candidato(11, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: true,
      error: "Contato já existe no CRM; atendimento preservado.",
    });
    const r = await selecionarNaFila(db, ORG_A, PAUSADA_NO_ENVIO, [cand(10), cand(11)], true);
    expect(r.changed_ids).toEqual([]);
    expect((await estado(10))?.status).toBe("skipped");
    expect((await estado(11))?.status).toBe("skipped");
  });

  it("no modo `on_start`, só volta quem JÁ tem conversa: desmarcada antes de iniciar nunca ganhou contato", async () => {
    await candidato(20, PAUSADA_AO_INICIAR, ORG_A, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
      conversation: null,
    });
    await candidato(21, PAUSADA_AO_INICIAR, ORG_A, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
      conversation: await conversa(21),
    });
    const r = await selecionarNaFila(db, ORG_A, PAUSADA_AO_INICIAR, [cand(20), cand(21)], true);
    expect(r.changed_ids).toEqual([cand(21)]);
    expect((await estado(20))?.status).toBe("skipped");
    expect((await estado(21))?.status).toBe("queued");
  });
});

describe("quem não pode mexer na fila não altera nada", () => {
  it("campanha RODANDO: 409, e a linha não muda", async () => {
    await candidato(30, RODANDO, ORG_A, { status: "queued" });
    await expect(selecionarNaFila(db, ORG_A, RODANDO, [cand(30)], false)).rejects.toMatchObject({
      status: 409,
    });
    expect((await estado(30))?.status).toBe("queued");
  });

  it("campanha em rascunho: 409 (lá vale o `select` da escolha inicial)", async () => {
    await expect(selecionarNaFila(db, ORG_A, RASCUNHO, [cand(30)], false)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("outra organização, com os ids certos, recebe 404 e nada muda", async () => {
    await candidato(40, PAUSADA_NO_ENVIO, ORG_A, { status: "queued" });
    await expect(
      selecionarNaFila(db, ORG_B, PAUSADA_NO_ENVIO, [cand(40)], false),
    ).rejects.toMatchObject({ status: 404 });
    expect((await estado(40))?.status).toBe("queued");
  });

  it("o SQL cru também recusa a organização errada — a guarda não mora só na leitura de antes", async () => {
    const { rows } = await pool.query(FILA_DESMARCAR_SQL, [
      ORG_B,
      PAUSADA_NO_ENVIO,
      [cand(40)],
      RAZAO_NAO_SELECIONADA,
    ]);
    expect(rows).toHaveLength(0);
    expect((await estado(40))?.status).toBe("queued");
  });

  it("o SQL cru não alcança candidato de OUTRA campanha da mesma organização", async () => {
    const { rows } = await pool.query(FILA_DESMARCAR_SQL, [
      ORG_A,
      PAUSADA_AO_INICIAR,
      [cand(40)],
      RAZAO_NAO_SELECIONADA,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("excluir as desmarcadas", () => {
  beforeAll(async () => {
    // Desmarcada, sem registro no CRM: pode sair.
    await candidato(50, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
    });
    // Desmarcada, mas já virou contato (campanha no modo antigo): NÃO é daqui.
    await candidato(51, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
      conversation: await conversa(51),
    });
    // Linha-tomba de quem exerceu opt-out: jamais se apaga.
    await candidato(52, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
      salt: true,
    });
    // Recusada pelo produto, e MARCADA: não é escolha do operador.
    await candidato(53, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: true,
      error: "Sem telefone brasileiro válido.",
    });
    // Marcada e na fila: de jeito nenhum.
    await candidato(54, PAUSADA_NO_ENVIO, ORG_A, { status: "queued", selected: true });
    // Da outra organização, desmarcada: intocável por A.
    await candidato(55, DE_OUTRA_ORG, ORG_B, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
    });
  });

  it("apaga SÓ a linha da busca de quem o operador tirou e que nunca virou registro do CRM", async () => {
    const r = await descartarDesmarcadas(db, ORG_A, PAUSADA_NO_ENVIO);
    expect(r.discarded, "só a 50 é descartável neste ponto").toBe(1);
    expect(await estado(50)).toBeUndefined();
    expect(await estado(51), "já tem conversa: é registro do CRM").toBeDefined();
    expect(await estado(52), "linha-tomba de supressão nunca se apaga").toBeDefined();
    expect(await estado(53), "recusada pelo produto, não escolhida pelo operador").toBeDefined();
    expect(await estado(54), "marcada e na fila").toBeDefined();
  });

  it("empresa que já tem CONTATO, mesmo sem conversa nem negócio, também não é apagada", async () => {
    const contato = "0b120000-6666-4000-8000-000000000099";
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Empresa com contato')",
      [contato, ORG_A],
    );
    await candidato(56, PAUSADA_NO_ENVIO, ORG_A, {
      status: "skipped",
      selected: false,
      error: RAZAO_NAO_SELECIONADA,
      contact: contato,
    });
    const r = await descartarDesmarcadas(db, ORG_A, PAUSADA_NO_ENVIO);
    expect(r.discarded).toBe(0);
    expect(await estado(56)).toBeDefined();
  });

  it("em RASCUNHO, apaga a desmarcada `new` e preserva a marcada", async () => {
    await candidato(60, RASCUNHO, ORG_A, { status: "new", selected: false });
    await candidato(61, RASCUNHO, ORG_A, { status: "new", selected: true });
    const r = await descartarDesmarcadas(db, ORG_A, RASCUNHO);
    expect(r.discarded).toBe(1);
    expect(await estado(60)).toBeUndefined();
    expect(await estado(61)).toBeDefined();
  });

  it("a outra organização não perde nada", async () => {
    expect(await estado(55)).toBeDefined();
  });

  it("o SQL cru também respeita organização e campanha", async () => {
    const { rows } = await pool.query(DESCARTAR_DESMARCADAS_SQL, [
      ORG_A,
      DE_OUTRA_ORG,
      RAZAO_NAO_SELECIONADA,
    ]);
    expect(rows).toHaveLength(0);
    expect(await estado(55)).toBeDefined();
  });

  it("campanha rodando: 409", async () => {
    await expect(descartarDesmarcadas(db, ORG_A, RODANDO)).rejects.toMatchObject({ status: 409 });
  });

  it("outra organização: 404", async () => {
    await expect(descartarDesmarcadas(db, ORG_B, PAUSADA_NO_ENVIO)).rejects.toMatchObject({
      status: 404,
    });
  });
});
