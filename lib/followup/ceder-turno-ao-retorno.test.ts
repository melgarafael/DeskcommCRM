import type pg from "pg";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { deveCederTurnoAoRetorno } from "./ceder-turno-ao-retorno";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const POINTER = "55555555-5555-4555-8555-555555555555";
const VERSAO = "66666666-6666-4666-8666-666666666666";
const AGORA = new Date("2026-09-20T12:00:00.000Z");

const pedido = {
  organizationId: ORG,
  contactId: CONTATO,
  conversationId: CONVERSA,
  messageId: MSG,
  agora: AGORA,
};

function pool(respostas: Array<{ match: (sql: string) => boolean; rows: unknown[] }>): Pick<pg.Pool, "query"> {
  return {
    query: (async (sql: string) => {
      const hit = respostas.find((r) => r.match(sql));
      return { rows: hit?.rows ?? [] };
    }) as pg.Pool["query"],
  };
}

const pointerQualifica = {
  match: (sql: string) => sql.includes("followup_flow_pointers"),
  rows: [
    {
      id: POINTER,
      active_version_id: VERSAO,
      trigger_config: { kind: "inbound_after_silence", params: { threshold_minutes: 1440 } },
    },
  ],
};

const NO_DE_GATILHO = {
  id: "t",
  type: "trigger",
  label: "Cliente voltou",
  position: { x: 0, y: 0 },
  config: {},
};

function grafoPublicado(no: Record<string, unknown>) {
  return {
    match: (sql: string) => sql.includes("followup_flow_versions"),
    rows: [{ id: VERSAO, graph: { nodes: [NO_DE_GATILHO, no], edges: [] } }],
  };
}

/** Texto fixo: o produtor enrolla mesmo sem nenhum agente armando o ponteiro. */
const grafoDeTextoFixo = grafoPublicado({
  id: "a",
  type: "action",
  label: "Aviso",
  position: { x: 0, y: 120 },
  config: { mode: "text", body: "Oi! Vi que você sumiu." },
});

/** Pede IA: sem agente armando, o produtor BARRA — o agente segue falando. */
const grafoQuePedeIa = grafoPublicado({
  id: "a",
  type: "action",
  label: "Resposta da IA",
  position: { x: 0, y: 120 },
  config: { mode: "ai_message", prompt_hint: "retome a conversa" },
});

const ninguemArma = {
  match: (sql: string) => sql.includes("ai_agent_versions"),
  rows: [],
};

const conversaLivre = {
  match: (sql: string) => sql.includes("from conversations"),
  rows: [
    {
      is_group: false,
      assignee_kind: "ai",
      bot_silenced_until: null,
      is_blocked: false,
      force_human: false,
      tags: [],
    },
  ],
};

// "waiting_reply" só aparece na consulta de vivos; a do evento de inscrição
// também cita followup_enrollments (join) e não pode casar aqui.
const semVivo = {
  match: (sql: string) => sql.includes("waiting_reply"),
  rows: [],
};

const inboundOntem = {
  match: (sql: string) => sql.includes("from messages"),
  rows: [{ sent_at: new Date(AGORA.getTime() - 2 * 24 * 60 * 60_000).toISOString() }],
};

const agenteArma = {
  match: (sql: string) => sql.includes("ai_agent_versions"),
  rows: [{ agent_id: "aa", followup: { enabled: true, flow_pointer_ids: [POINTER] } }],
};

describe("deveCederTurnoAoRetorno", () => {
  it("sem pointer armado, o turno do agente segue", async () => {
    expect(await deveCederTurnoAoRetorno(pool([]), pedido)).toBe(false);
  });

  it("consulta falhou: fail-open, o turno segue", async () => {
    const quebrado = {
      query: (async () => {
        throw new Error("db down");
      }) as pg.Pool["query"],
    };
    expect(await deveCederTurnoAoRetorno(quebrado, pedido)).toBe(false);
  });

  it("gap qualifica, gate arma, ninguém vivo: cede o turno", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([pointerQualifica, conversaLivre, semVivo, inboundOntem, agenteArma, grafoDeTextoFixo]),
        pedido,
      ),
    ).toBe(true);
  });

  it("primeiro inbound da vida não cede — não é retorno", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([
          pointerQualifica,
          conversaLivre,
          semVivo,
          { match: (sql: string) => sql.includes("from messages"), rows: [] },
          agenteArma,
          grafoDeTextoFixo,
        ]),
        pedido,
      ),
    ).toBe(false);
  });

  it("fluxo de texto fixo sem agente armado: cede o turno — o produtor enrollaria", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([pointerQualifica, conversaLivre, semVivo, inboundOntem, ninguemArma, grafoDeTextoFixo]),
        pedido,
      ),
    ).toBe(true);
  });

  it("fluxo que pede IA sem agente armado não cede — o produtor barra esse enroll", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([pointerQualifica, conversaLivre, semVivo, inboundOntem, ninguemArma, grafoQuePedeIa]),
        pedido,
      ),
    ).toBe(false);
  });

  it("o produtor já inscreveu por ESTA mensagem: cede, mesmo com a inscrição viva", async () => {
    // Caminho real: pos-entrada drena o event_log (o produtor inscreve e avança
    // o fluxo) ANTES de pedir o despacho do agente. Quando o drain chega aqui,
    // a inscrição deste retorno já está viva no slot do contato.
    const inscritoPorEsta = {
      match: (sql: string) => sql.includes("enrolled_by_inbound_after_silence"),
      rows: [{ "?column?": 1 }],
    };
    const vivoDesteRetorno = {
      match: (sql: string) => sql.includes("waiting_reply"),
      rows: [{ pointer_id: POINTER }],
    };
    expect(
      await deveCederTurnoAoRetorno(
        pool([pointerQualifica, conversaLivre, inscritoPorEsta, vivoDesteRetorno, inboundOntem, ninguemArma, grafoDeTextoFixo]),
        pedido,
      ),
    ).toBe(true);
    // Controle: o mesmo slot vivo SEM o evento desta mensagem é outra inscrição — não cede.
    expect(
      await deveCederTurnoAoRetorno(
        pool([pointerQualifica, conversaLivre, vivoDesteRetorno, inboundOntem, ninguemArma, grafoDeTextoFixo]),
        pedido,
      ),
    ).toBe(false);
  });

  it("outro enrollment vivo não cede — este gatilho não enrollaria", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([
          pointerQualifica,
          conversaLivre,
          { match: (sql: string) => sql.includes("waiting_reply"), rows: [{ pointer_id: "outro" }] },
          inboundOntem,
          agenteArma,
          grafoDeTextoFixo,
        ]),
        pedido,
      ),
    ).toBe(false);
  });
});

describe("o drain do agente chama o skip", () => {
  it("drain.ts importa deveCederTurnoAoRetorno", () => {
    const fonte = readFileSync(
      path.join(process.cwd(), "lib/agent-engine/edge/crm/drain.ts"),
      "utf8",
    );
    expect(fonte).toContain("deveCederTurnoAoRetorno");
  });
});
