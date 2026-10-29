/**
 * O ANÚNCIO QUE O CONTATO CLICOU CHEGA AO PROMPT — e só ao da organização dele.
 *
 * `origem-do-contato.test.ts` mede o bloco em texto e a consulta isolada. Faltava
 * medir o caminho até o prompt: sabotado na triagem do #2984, apagar o
 * `origemBlock` da chamada a `ritualBlocks` em `buildOpeningMessage`, trocar a
 * leitura do turno por `''` ou tirar o `organization_id = $1` da consulta deixava
 * os 54 testes vizinhos verdes. Cada caso abaixo fecha uma dessas três.
 */
import { describe, expect, it, vi } from "vitest";

import { buildOrigemBlock, montarBlocoDeOrigem } from "@/lib/agent-engine/agent/abertura/origem-do-contato";
import { buildOpeningMessage, ritualBlocks } from "@/lib/agent-engine/agent/abertura/ritual";
import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";
import { logger } from "@/lib/logger";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "55555555-5555-4555-8555-555555555555";
const TITULO = "Lisboa a partir de R$ 2.370";
const ORIGEM = `Este contato chegou por um ANÚNCIO pago. ${TITULO}`;
const contexto = { contact: { name: "Cliente", email: null }, messages: [] } as never;

describe("o bloco de origem chega ao ritual de abertura", () => {
  it("ritualBlocks com origem ⇒ cabeçalho e conteúdo", () => {
    const t = ritualBlocks(null, null, contexto, "sem notas", false, "", ORIGEM).join("\n");
    expect(t).toContain("## Origem deste contato");
    expect(t).toContain(TITULO);
  });

  it("sem origem ⇒ nenhum cabeçalho (contato que não veio de anúncio não paga token)", () => {
    const t = ritualBlocks(null, null, contexto, "sem notas", false, "", "").join("\n");
    expect(t).not.toContain("## Origem deste contato");
    expect(t).toContain("## Contexto do lead");
  });

  it("buildOpeningMessage repassa a origem ao ritual", () => {
    const t = buildOpeningMessage(null, null, contexto, "sem notas", false, [], "", undefined, undefined, ORIGEM);
    expect(t).toContain(TITULO);
  });
});

describe("o rótulo trata o anúncio como dado não verificado", () => {
  it("não o apresenta como algo que o cliente não escreveu", () => {
    const bloco = montarBlocoDeOrigem(
      { source: "meta_ads", title: TITULO, body: "Saídas em outubro", created_at: new Date() },
      new Date(),
    );
    expect(bloco).toContain("NÃO verificado");
    expect(bloco).not.toContain("não é fala do cliente");
  });
});

describe("a consulta isola a organização", () => {
  it("filtra organization_id = $1 e id = $2 — o pool do motor não tem RLS", async () => {
    let sql = "";
    const db = { query: async (s: string) => { sql = s; return { rows: [] }; } };
    await buildOrigemBlock(db as never, ORG, CONTATO, new Date());
    expect(sql.replace(/\s+/g, " ")).toContain("where organization_id = $1 and id = $2");
  });
});

describe("falha de leitura é tolerada, não calada", () => {
  it("devolve '' e deixa um aviso com a organização e o contato", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const db = { query: async () => { throw new Error("db caiu"); } };
    await expect(buildOrigemBlock(db as never, ORG, CONTATO, new Date())).resolves.toBe("");
    expect(aviso).toHaveBeenCalledWith(
      expect.stringContaining("origem-do-contato"),
      expect.objectContaining({ organization_id: ORG, contact_id: CONTATO }),
    );
    aviso.mockRestore();
  });
});

describe("o turno inbound lê o anúncio e o entrega à abertura", () => {
  it("o buildOpening recebe o origemBlock com o título do anúncio", async () => {
    const recebido: { origemBlock?: string } = {};
    const query = async (sql: string) => {
      if (sql.includes("ad_title")) {
        return { rows: [{ source: "meta_ads", title: TITULO, body: "Saídas em outubro", created_at: new Date() }] };
      }
      if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
        return { rows: [{ name: "Cliente", display_name: null, email: null, phone_number: "5511999999999", tags: [], is_blocked: false, is_personal: false, source: "meta_ads", consent: null, is_anonymized: false }] };
      }
      if (sql.includes("from conversations") && sql.includes("is_group = false")) return { rows: [{ id: CONVERSA }] };
      if (sql.includes("playbook_pointers")) return { rows: [{ layer: "platform", version_id: "v1", content: "p" }] };
      return { rows: [] };
    };
    const deps = {
      log: { info() {}, warn() {}, error() {}, debug() {} },
      llmCfg: {},
      crmCfg: {},
      knobs: { maxSteps: 1 },
      clock: () => new Date("2026-10-06T15:00:00Z"),
    };
    const job = {
      id: "11111111-1111-4111-8111-111111111111", organization_id: ORG, contact_id: CONTATO,
      kind: "inbound_turn", payload: {}, attempts: 1, claimed_by: "w", claimed_at: new Date(),
    };
    await expect(
      runAgentTurn(deps as never, job as never, { query } as never, { workerId: "w" }, {
        resolvedAgent: {
          config: {
            agentId: "agente-1", versionId: "v1", operationMode: "automatic", pausedAt: null,
            systemPrompt: "persona", toolIds: [], casesEnabled: false,
            historyMessageWindow: 20, historyTokenWindow: 1000,
          },
          routerId: null, intentName: null, confidence: null, outcome: "fallback",
        },
        channelSessionId: "44444444-4444-4444-8444-444444444444",
        conversationId: CONVERSA,
        inboundMessageId: "66666666-6666-4666-8666-666666666666",
        buildOpening: (args: { origemBlock?: string }) => {
          recebido.origemBlock = args.origemBlock;
          return "";
        },
      } as never),
      // Ponto de parada: a primeira chamada de modelo, sem config de LLM na org.
    ).rejects.toThrow(/config LLM/);
    expect(recebido.origemBlock).toContain(TITULO);
  });
});
