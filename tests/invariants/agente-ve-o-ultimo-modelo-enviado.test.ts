/**
 * O AGENTE VÊ O ÚLTIMO MODELO APROVADO QUE O CLIENTE RECEBEU — mesmo de outro atendimento.
 *
 * Medido numa instalação real: o fluxo de acompanhamento mandou o modelo
 * aprovado com uma oferta (preço com desconto); o cliente respondeu "Sim, quero"
 * no botão OITO dias depois, com o atendimento anterior já fechado. A resposta
 * abriu um atendimento novo, o histórico do agente começa em
 * `service_started_at`, e o modelo ficou de fora: o agente confirmou o preço
 * cheio e se apresentou de novo. O cliente não respondeu mais.
 *
 * O que este arquivo prova, num Postgres com o baseline:
 *   1. o modelo de antes do atendimento entra no contexto, antes da resposta;
 *   2. o diálogo antigo que NÃO é modelo continua fora (o isolamento do
 *      atendimento segue valendo para todo o resto);
 *   3. modelo de mais de 30 dias não entra;
 *   4. o modelo que já está na janela não aparece duas vezes; fora das últimas
 *      N mensagens, volta no começo.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

async function novoContatoEConversa(): Promise<{ contato: string; conversa: string }> {
  const contato = randomUUID();
  const conversa = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Modelo')", [
    contato,
    GOV_ORG,
  ]);
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [conversa, GOV_ORG, contato, GOV_SESSION],
  );
  return { contato, conversa };
}

async function mensagem(
  c: { contato: string; conversa: string },
  m: { direcao: "inbound" | "outbound"; tipo?: "text" | "template"; corpo: string; ha?: string },
): Promise<void> {
  const quando = m.ha ? `now() - interval '${m.ha}'` : "clock_timestamp()";
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,'ai',$9,${quando})`,
    [
      randomUUID(),
      GOV_ORG,
      c.conversa,
      GOV_SESSION,
      c.contato,
      m.tipo ?? "text",
      m.direcao,
      m.direcao === "inbound" ? "received" : "sent",
      m.corpo,
    ],
  );
  await pool.query(`select fn_mark_conversation_message($1,$2,$3,${quando})`, [c.conversa, m.direcao, m.corpo]);
}

async function fecharAtendimento(conversa: string): Promise<void> {
  const { rows } = await pool.query("select service_revision from conversations where id=$1", [conversa]);
  await pool.query("select * from fn_service_status($1,$2,'closed',$3)", [
    GOV_ORG,
    conversa,
    rows[0].service_revision,
  ]);
}

async function contexto(c: { contato: string; conversa: string }, historyLimit = 20): Promise<string[]> {
  const r = await getLeadContext(
    pool,
    {} as never,
    { tenantId: GOV_ORG, leadId: c.contato, conversationId: c.conversa, fuso: "America/Sao_Paulo" },
    { historyLimit, maxTokens: 4000 },
  );
  if (!r.ok) throw new Error("contexto não montou");
  return r.context.messages.map((m) => m.body);
}

beforeAll(() => {
  seedGov();
});
afterAll(async () => {
  await pool.end();
});

describe("o último modelo aprovado entra no histórico do agente", () => {
  it("resposta dias depois, em atendimento novo: a oferta aparece antes do 'sim', o diálogo antigo não", async () => {
    const c = await novoContatoEConversa();
    await mensagem(c, { direcao: "inbound", corpo: "DIALOGO_ANTIGO_DO_CLIENTE", ha: "9 days" });
    await mensagem(c, { direcao: "outbound", corpo: "RESPOSTA_ANTIGA_DO_AGENTE", ha: "9 days" });
    await mensagem(c, { direcao: "outbound", tipo: "template", corpo: "OFERTA_COM_DESCONTO", ha: "8 days" });
    await fecharAtendimento(c.conversa);
    await mensagem(c, { direcao: "inbound", corpo: "Sim, quero" });

    const corpos = await contexto(c);
    expect(corpos).toEqual(["OFERTA_COM_DESCONTO", "Sim, quero"]);
  });

  it("modelo de mais de 30 dias não entra", async () => {
    const c = await novoContatoEConversa();
    await mensagem(c, { direcao: "outbound", tipo: "template", corpo: "OFERTA_VELHA", ha: "31 days" });
    await fecharAtendimento(c.conversa);
    await mensagem(c, { direcao: "inbound", corpo: "Oi" });

    expect(await contexto(c)).toEqual(["Oi"]);
  });

  it("o modelo já na janela não se repete; fora das últimas N mensagens, volta no começo", async () => {
    const c = await novoContatoEConversa();
    await mensagem(c, { direcao: "inbound", corpo: "Quero o ventilador", ha: "2 hours" });
    await mensagem(c, { direcao: "outbound", tipo: "template", corpo: "OFERTA_NA_JANELA", ha: "1 hour" });
    await mensagem(c, { direcao: "inbound", corpo: "m1", ha: "50 minutes" });
    await mensagem(c, { direcao: "outbound", corpo: "m2", ha: "40 minutes" });
    await mensagem(c, { direcao: "inbound", corpo: "m3", ha: "30 minutes" });

    expect(await contexto(c)).toEqual(["Quero o ventilador", "OFERTA_NA_JANELA", "m1", "m2", "m3"]);
    expect(await contexto(c, 2)).toEqual(["OFERTA_NA_JANELA", "m2", "m3"]);
  });
});
