import { beforeEach, describe, expect, it, vi } from "vitest";

import { DETALHE_DA_MENSAGEM_EM_QUARENTENA } from "@/lib/channels/quarentena";
import {
  dispatchEvent,
  registerHandler,
  type EventHandler,
  type EventRow,
} from "@/lib/event-log/dispatcher";

/**
 * O PONTO ÚNICO DA QUARENTENA NO EVENT_LOG (#4026, fatia 1).
 *
 * ─── Por que o gate mora aqui ──────────────────────────────────────────────
 *
 * `message.received` tem mais de dez consumidores no registry: automação,
 * push para a equipe, match de campanha, reatividade de follow-up, resposta
 * automática por evento, conversão de anúncio, aviso ao dono da carteira. Um
 * `if` em cada um seria vinte lugares para esquecer um — e o esquecido é sempre
 * o que manda mensagem para fora.
 *
 * O dispatcher é o único caminho por onde todos passam. Um gate aqui, antes do
 * laço, cobre todos: a mensagem marcada não acorda nenhum deles.
 *
 * ─── O detalhe importa ─────────────────────────────────────────────────────
 *
 * O resultado vira `skipped` com `mensagem_em_quarentena` e ENTRA em
 * `consumed_by` (o dreno trata `skipped` como consumido). Sem isso, o evento
 * voltaria a `pending` para sempre e o dreno gastaria a vida re-tentando um
 * evento que nunca vai poder rodar.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 *
 * · tirar o gate: o primeiro caso acusa (o handler de automação roda);
 * · devolver `error` em vez de `skipped`: o segundo caso acusa (o evento
 *   voltaria para a fila);
 * · não tratar exceção da leitura: o caso do fail-open acusa (handler nunca
 *   roda e a promessa rejeita).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const MENSAGEM = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "44444444-4444-4444-8444-444444444444";

const automacao = vi.fn(async () => ({ consumer_key: "teste.automacao", status: "ok" as const }));
const push = vi.fn(async () => ({ consumer_key: "teste.push", status: "ok" as const }));
const outro = vi.fn(async () => ({ consumer_key: "teste.outro", status: "ok" as const }));

const handlerAutomacao: EventHandler = {
  key: "teste.automacao",
  events: ["message.received"],
  naOrgParada: "pula",
  handle: automacao,
};
const handlerPush: EventHandler = {
  key: "teste.push",
  events: ["message.received"],
  naOrgParada: "pula",
  handle: push,
};
/** Consome OUTRO tipo: não pode ser afetado pelo gate da mensagem. */
const handlerDeLead: EventHandler = {
  key: "teste.outro",
  events: ["lead.created"],
  naOrgParada: "roda",
  handle: outro,
};

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "evento-1",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: MENSAGEM,
    payload: { message_id: MENSAGEM, conversation_id: CONVERSA },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  registerHandler(handlerAutomacao);
  registerHandler(handlerPush);
  registerHandler(handlerDeLead);
  automacao.mockClear();
  push.mockClear();
  outro.mockClear();
  automacao.mockImplementation(async () => ({ consumer_key: "teste.automacao", status: "ok" as const }));
  push.mockImplementation(async () => ({ consumer_key: "teste.push", status: "ok" as const }));
  outro.mockImplementation(async () => ({ consumer_key: "teste.outro", status: "ok" as const }));
});

describe("mensagem em quarentena", () => {
  it("nenhum consumidor do evento roda — todos saem skipped com o motivo", async () => {
    const emQuarentena = vi.fn(async () => true);

    const resultados = await dispatchEvent(evento(), { orgParada: false, emQuarentena });

    expect(automacao, "a automação rodou para uma mensagem em quarentena").not.toHaveBeenCalled();
    expect(push, "o push para a equipe saiu para uma mensagem em quarentena").not.toHaveBeenCalled();
    expect(resultados).toEqual([
      { consumer_key: "teste.automacao", status: "skipped", detail: DETALHE_DA_MENSAGEM_EM_QUARENTENA },
      { consumer_key: "teste.push", status: "skipped", detail: DETALHE_DA_MENSAGEM_EM_QUARENTENA },
    ]);
    // `skipped` é o que o dreno grava em `consumed_by`: sem isto o evento
    // voltaria para a fila para sempre.
    expect(resultados.every((r) => r.status === "skipped")).toBe(true);
    expect(emQuarentena).toHaveBeenCalledWith(ORG, MENSAGEM);
  });

  it("a marca vem do payload quando o evento não traz `entity_id`", async () => {
    // A recuperação de mensagem perdida emite `message.received` com
    // `entity_id` nulo e o id só no payload. Ler apenas `entity_id` deixaria
    // esse caminho fora do gate.
    const emQuarentena = vi.fn(async () => true);

    await dispatchEvent(evento({ entity_kind: "message", entity_id: null }), {
      orgParada: false,
      emQuarentena,
    });

    expect(emQuarentena).toHaveBeenCalledWith(ORG, MENSAGEM);
    expect(automacao).not.toHaveBeenCalled();
  });
});

describe("os lados opostos", () => {
  it("mensagem normal: o fluxo é exatamente o de antes", async () => {
    const emQuarentena = vi.fn(async () => false);

    const resultados = await dispatchEvent(evento(), { orgParada: false, emQuarentena });

    expect(automacao).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(resultados.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(resultados.some((r) => r.detail === DETALHE_DA_MENSAGEM_EM_QUARENTENA)).toBe(false);
  });

  it("evento sem mensagem não paga a consulta nem é afetado", async () => {
    const emQuarentena = vi.fn(async () => true);

    await dispatchEvent(evento({ event_type: "lead.created", entity_kind: "lead", entity_id: null, payload: {} }), {
      orgParada: false,
      emQuarentena,
    });

    expect(emQuarentena).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledTimes(1);
  });

  it("FALHA na leitura da marca é fail-open: o consumidor roda", async () => {
    const emQuarentena = vi.fn(async () => {
      throw new Error("timeout");
    });

    await expect(dispatchEvent(evento(), { orgParada: false, emQuarentena })).resolves.toEqual([
      { consumer_key: "teste.automacao", status: "ok" },
      { consumer_key: "teste.push", status: "ok" },
    ]);
    expect(automacao).toHaveBeenCalledTimes(1);
  });

  it("sem a leitura injetada (caminhos que não têm banco), nada muda", async () => {
    await dispatchEvent(evento(), { orgParada: false });

    expect(automacao).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
