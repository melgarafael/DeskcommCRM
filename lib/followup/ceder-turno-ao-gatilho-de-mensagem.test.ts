import type pg from "pg";
import { describe, expect, it } from "vitest";

import { deveCederTurnoAoGatilhoDeMensagem } from "./ceder-turno-ao-gatilho-de-mensagem";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const POINTER = "55555555-5555-4555-8555-555555555555";
const VERSAO = "66666666-6666-4666-8666-666666666666";
const AGORA = new Date("2026-10-22T21:17:20.000Z");

const pedido = { organizationId: ORG, contactId: CONTATO, conversationId: CONVERSA, messageId: MSG, agora: AGORA };

type Resposta = { match: (sql: string) => boolean; rows: unknown[] };

function pool(respostas: Resposta[]): Pick<pg.Pool, "query"> {
  return {
    query: (async (sql: string) => {
      const hit = respostas.find((r) => r.match(sql));
      return { rows: hit?.rows ?? [] };
    }) as pg.Pool["query"],
  };
}

const pointerDePalavra: Resposta = {
  match: (sql) => sql.includes("followup_flow_pointers"),
  rows: [
    {
      id: POINTER,
      active_version_id: VERSAO,
      surface: "followup",
      trigger_config: { kind: "keyword", params: { palavras: ["promoteste"], modo: "contem" } },
    },
  ],
};

function conversa(over: Record<string, unknown> = {}): Resposta {
  return {
    match: (sql) => sql.includes("from conversations"),
    rows: [
      {
        is_group: false,
        assignee_kind: "ai",
        bot_silenced_until: null,
        is_blocked: false,
        force_human: false,
        tags: [],
        source_metadata: null,
        ...over,
      },
    ],
  };
}

const semEventoDeInscricao: Resposta = { match: (sql) => sql.includes("followup_enrollment_events"), rows: [] };
const semVivo: Resposta = { match: (sql) => sql.includes("waiting_reply"), rows: [] };

function mensagem(body: string, recebidaHa = 2_000): Resposta {
  return {
    match: (sql) => sql.includes("select body, created_at from messages"),
    rows: [{ body, created_at: new Date(AGORA.getTime() - recebidaHa).toISOString() }],
  };
}

const NO_DE_GATILHO = { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} };

function grafo(acao: Record<string, unknown>): Resposta {
  return {
    match: (sql) => sql.includes("followup_flow_versions"),
    rows: [{ id: VERSAO, graph: { nodes: [NO_DE_GATILHO, acao], edges: [] } }],
  };
}

const grafoDeTextoFixo = grafo({
  id: "a",
  type: "action",
  label: "Resposta",
  position: { x: 0, y: 120 },
  config: { mode: "text", body: "Oi! Recebi sua palavra-chave." },
});

const grafoQuePedeIa = grafo({
  id: "a",
  type: "action",
  label: "Resposta da IA",
  position: { x: 0, y: 120 },
  config: { mode: "ai_message", prompt_hint: "responda a promoção" },
});

const ninguemArma: Resposta = { match: (sql) => sql.includes("ai_agent_versions"), rows: [] };

/** O cenário da prova no teste (out/2026): palavra-chave, texto fixo, sem agente armando. */
function cenario(over: { conversa?: Resposta; mensagem?: Resposta; grafo?: Resposta; extras?: Resposta[] } = {}) {
  return pool([
    ...(over.extras ?? []),
    pointerDePalavra,
    over.conversa ?? conversa(),
    semEventoDeInscricao,
    semVivo,
    over.mensagem ?? mensagem("PROMOTESTE"),
    over.grafo ?? grafoDeTextoFixo,
    ninguemArma,
  ]);
}

describe("deveCederTurnoAoGatilhoDeMensagem — uma voz só", () => {
  it("cede quando a palavra-chave inscreveria o contato num fluxo de texto fixo", async () => {
    expect(await deveCederTurnoAoGatilhoDeMensagem(cenario(), pedido)).toBe(true);
  });

  it("cede quando o produtor já inscreveu por esta mensagem", async () => {
    const jaInscrito: Resposta = { match: (sql) => sql.includes("followup_enrollment_events"), rows: [{ "?column?": 1 }] };
    expect(await deveCederTurnoAoGatilhoDeMensagem(cenario({ extras: [jaInscrito] }), pedido)).toBe(true);
  });

  it("não cede quando a mensagem não casa nenhuma palavra", async () => {
    expect(await deveCederTurnoAoGatilhoDeMensagem(cenario({ mensagem: mensagem("bom dia") }), pedido)).toBe(false);
  });

  it("não cede com pessoa no comando — o produtor também não inscreveria", async () => {
    expect(await deveCederTurnoAoGatilhoDeMensagem(cenario({ conversa: conversa({ assignee_kind: "user" }) }), pedido)).toBe(
      false,
    );
    expect(
      await deveCederTurnoAoGatilhoDeMensagem(cenario({ conversa: conversa({ bot_silenced_until: "infinity" }) }), pedido),
    ).toBe(false);
  });

  it("não cede para mensagem velha (backlog) — o produtor a ignora", async () => {
    expect(
      await deveCederTurnoAoGatilhoDeMensagem(cenario({ mensagem: mensagem("promoteste", 2 * 60 * 60_000) }), pedido),
    ).toBe(false);
  });

  it("não cede quando o grafo pede IA e nenhum agente arma o fluxo — o produtor barraria", async () => {
    expect(await deveCederTurnoAoGatilhoDeMensagem(cenario({ grafo: grafoQuePedeIa }), pedido)).toBe(false);
  });

  it("não cede quando outro fluxo já ocupa o contato", async () => {
    const outroVivo: Resposta = {
      match: (sql) => sql.includes("waiting_reply"),
      rows: [{ pointer_id: "outro", nasceu_depois: false }],
    };
    expect(await deveCederTurnoAoGatilhoDeMensagem(cenario({ extras: [outroVivo] }), pedido)).toBe(false);
  });

  it("fail-open: consulta quebrada deixa o agente falar", async () => {
    const quebrado: Pick<pg.Pool, "query"> = {
      query: (async () => {
        throw new Error("conexão caiu");
      }) as pg.Pool["query"],
    };
    expect(await deveCederTurnoAoGatilhoDeMensagem(quebrado, pedido)).toBe(false);
  });
});
