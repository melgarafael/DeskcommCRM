/**
 * "RESPONDER O CLIENTE" NÃO VIRA PRÓXIMA AÇÃO DO NEGÓCIO (issue #3429).
 *
 * `update_lead_state` gravava `next_action` como o modelo escreveu, e o card do
 * quadro mostra a frase como proposta — "Propõe: Responder o cliente", com
 * Aprovar e Ignorar. A frase não diz nada a quem vende (o agente já responde a
 * cada mensagem), ocupa a faixa do card no lugar de "esfriando"/retomada/
 * probabilidade, e aprová-la move `last_activity_at` — o relógio de silêncio que
 * o radar de risco lê — sem ninguém ter feito nada pelo cliente.
 *
 * Agora a frase vazia NÃO é gravada: o resto da chamada vale (a mesma chamada
 * pode marcar avanço de estágio) e o modelo recebe o aviso na resposta da
 * ferramenta. `next_action_seq` não avança, então a proposta que a pessoa está
 * vendo no card segue sendo a mesma.
 */
import { describe, expect, it, vi } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import { applyLeadStateUpdate, proximaAcaoGenerica } from "@/lib/agent-engine/agent/lead-state";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const IDS = { tenantId: "org-1", leadId: "contato-1" };

/** Só a frase que não diz nada. Sem acento, sem caixa, e o mesmo em espanhol. */
const GENERICAS = [
  "Responder o cliente",
  "responder ao cliente.",
  "Responder cliente",
  "Responder o lead",
  "Responder à dúvida do cliente",
  "Responder a nova mensagem do cliente",
  "Atender o cliente",
  "Retornar ao cliente",
  "Responder",
  "Responder al cliente",
];

/** Controle: o que tem conteúdo continua passando — a lista não julga o texto. */
const COM_CONTEUDO = [
  "Enviar o orçamento do modelo X até sexta",
  "Responder ao cliente com o orçamento do modelo X",
  "Responder a objeção de preço com o plano anual",
  "Aguardar o comprovante do Pix",
  "Aguardar resposta do cliente",
  "Ligar amanhã às 10h para confirmar o endereço",
];

/**
 * Banco de mentira: devolve a linha que o UPSERT gravaria, para o teste olhar o
 * que foi para o `insert` em vez de confiar na mensagem de retorno.
 * `$5` é o texto da proposta e `$6` é "reescreveu a proposta nesta chamada" —
 * os dois que decidem o que o card mostra.
 */
function banco(atual: { stage: string; next_action: string | null } | null = null) {
  const upserts: unknown[][] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("from lead_state where")) {
        return { rows: atual ? [{ ...atual, qualification: {} }] : [] };
      }
      upserts.push(params);
      return {
        rows: [{ stage: params[2], qualification: {}, next_action: params[4], next_action_seq: 1 }],
      };
    }),
  };
  return { db: db as unknown as Queryable, upserts };
}

describe("update_lead_state com uma frase que não diz nada", () => {
  it("não grava a frase, não avança a identidade da proposta e avisa o modelo", async () => {
    const { db, upserts } = banco();
    const r = await applyLeadStateUpdate(db, IDS, { next_action: "Responder o cliente" });

    expect(upserts[0]?.[4]).toBeNull(); // next_action
    expect(upserts[0]?.[5]).toBe(false); // reescreveu a proposta?
    expect(r.ok && r.message).toContain("NÃO foi gravada");
  });

  it("o resto da chamada vale: o estágio avança mesmo com a frase vazia", async () => {
    const { db, upserts } = banco({ stage: "new", next_action: null });
    const r = await applyLeadStateUpdate(db, IDS, {
      stage: "contacted",
      reason: "cliente respondeu",
      next_action: "Responder o cliente",
    });

    expect(r.ok && r.transition).toMatchObject({ from: "new", to: "contacted" });
    expect(upserts[0]?.[2]).toBe("contacted");
    expect(upserts[0]?.[4]).toBeNull();
  });

  it("a proposta que já estava no card fica como estava", async () => {
    const { db, upserts } = banco({ stage: "new", next_action: "Enviar o orçamento até sexta" });
    await applyLeadStateUpdate(db, IDS, { next_action: "Responder o cliente" });

    expect(upserts[0]?.[4]).toBe("Enviar o orçamento até sexta");
    expect(upserts[0]?.[5]).toBe(false);
  });
});

describe("proximaAcaoGenerica", () => {
  it.each(GENERICAS)("%s não é próxima ação", (frase) => {
    expect(proximaAcaoGenerica(frase)).toBe(true);
  });

  it.each(COM_CONTEUDO)("controle: %s tem conteúdo", (frase) => {
    expect(proximaAcaoGenerica(frase)).toBe(false);
  });
});

describe("a descrição do campo ensina o modelo", () => {
  it("diz o que é próxima ação, nega a frase vazia e manda omitir o campo", () => {
    // A recusa no servidor vale para qualquer modelo; a descrição é o que evita
    // a chamada errada. Sem ela, o modelo continua escrevendo "Responder o
    // cliente" e recebendo o aviso em todo turno.
    const shape = (
      AGENT_TOOL_DEFS.update_lead_state.inputSchema as unknown as {
        shape: Record<string, { description?: string }>;
      }
    ).shape;
    const descricao = shape.next_action?.description ?? "";

    expect(descricao).toContain("até quando"); // o que faz a frase ser concreta
    expect(descricao).toContain("não é próxima ação");
    expect(descricao).toContain("não envie este campo");
  });
});

describe("controles: o que continua valendo", () => {
  it("uma ação concreta continua sendo gravada, e a identidade avança", async () => {
    const { db, upserts } = banco();
    const r = await applyLeadStateUpdate(db, IDS, {
      next_action: "Enviar o orçamento do modelo X até sexta",
    });

    expect(upserts[0]?.[4]).toBe("Enviar o orçamento do modelo X até sexta");
    expect(upserts[0]?.[5]).toBe(true);
    expect(r.ok && r.message).not.toContain("NÃO foi gravada");
  });

  it("null limpa a proposta, como antes", async () => {
    const { db, upserts } = banco({ stage: "new", next_action: "Enviar o orçamento até sexta" });
    await applyLeadStateUpdate(db, IDS, { next_action: null });

    expect(upserts[0]?.[4]).toBeNull();
    expect(upserts[0]?.[5]).toBe(true);
  });
});
