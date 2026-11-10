import { describe, expect, it, vi } from "vitest";

import { matchesHandoffKeyword, palavrasDePassagem } from "@/lib/agent-engine/agent/agent-config";
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { buildNativeMediaParts } from "@/lib/agent-engine/agent/media-parts";
import { loadInboundForJob } from "@/lib/agent-engine/agent/inbound-turn";
import {
  __test_fitToBudget,
  corpoDaMensagem,
  getLeadContext,
  MARCADOR_IMAGEM_NAO_VISTA,
  textoDoClienteNaUltimaMensagem,
} from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * O AGENTE QUE DESLIGOU "VER AS FOTOS QUE O CLIENTE ENVIA" (migration 9108).
 *
 * A descrição de uma foto pode existir porque OUTRO agente da empresa a pediu.
 * Quem desligou a opção não a recebe: recebe um aviso de que chegou uma imagem
 * e de que ele não sabe o que ela mostra — nunca o `[image]` cru, que é o que
 * leva o modelo a inventar (17/09: com `[documento]`, o agente descreveu um PDF
 * que nunca leu). Nem a imagem nativa vai ao modelo. Áudio e PDF não mudam.
 */

const DESCRICAO = "tênis vermelho tamanho 42";
const foto = (body: string | null, derivado: string | null = DESCRICAO) => ({
  type: "image",
  body,
  media_url: "u",
  media_storage_path: "p",
  media_derived_text: derivado,
});

describe("corpoDaMensagem — quem não vê imagens", () => {
  it("foto JÁ descrita: o aviso, sem a descrição", () => {
    const corpo = corpoDaMensagem(foto(null), false);
    expect(corpo).toBe(MARCADOR_IMAGEM_NAO_VISTA);
    expect(corpo).not.toContain("tênis");
  });

  it("a legenda que o cliente digitou continua, depois do aviso", () => {
    expect(corpoDaMensagem(foto("quero esse"), false)).toBe(`${MARCADOR_IMAGEM_NAO_VISTA}\nLegenda do cliente: quero esse`);
  });

  it("foto sem descrição: o aviso, nunca o [image] cru", () => {
    expect(corpoDaMensagem(foto(null, null), false)).toBe(MARCADOR_IMAGEM_NAO_VISTA);
  });

  it.each(["audio", "document", "video"])("controle: %s não muda com a opção", (tipo) => {
    const m = { ...foto(null), type: tipo };
    expect(corpoDaMensagem(m, false)).toBe(corpoDaMensagem(m, true));
    expect(corpoDaMensagem(m, false)).toContain(DESCRICAO);
  });

  it("a foto que NÓS mandamos não vira o aviso: a legenda é nossa, nunca 'do cliente'", () => {
    const nossa = { ...foto("Segue o boleto do pedido 123", null), direction: "outbound" };
    expect(corpoDaMensagem(nossa, false)).toBe("Segue o boleto do pedido 123");
    expect(corpoDaMensagem({ ...nossa, direction: "inbound" }, false), "controle: a recebida vira").toContain(
      MARCADOR_IMAGEM_NAO_VISTA,
    );
  });

  it("controle: quem vê imagens lê a descrição, como sempre (e o padrão é ver)", () => {
    expect(corpoDaMensagem(foto(null), true)).toContain(DESCRICAO);
    expect(corpoDaMensagem(foto(null))).toContain(DESCRICAO);
  });
});

describe("o aviso", () => {
  it("diz que chegou uma imagem e que o agente não sabe o que ela mostra", () => {
    expect(MARCADOR_IMAGEM_NAO_VISTA).toContain("imagem");
    expect(MARCADOR_IMAGEM_NAO_VISTA).toMatch(/não sabe o que ela mostra/);
    expect(MARCADOR_IMAGEM_NAO_VISTA).toMatch(/NUNCA descreva nem suponha/);
  });

  it("não promete ao cliente o que ninguém vai fazer (a mesma régua de MARCADOR_NAO_LIDA)", () => {
    expect(MARCADOR_IMAGEM_NAO_VISTA.toLowerCase()).not.toMatch(/depois|em breve|analisar|vou /);
  });

  it("não dispara a passagem para pessoa: nem palavra cadastrada com cara de pedido de pessoa, nem a regra fixa", () => {
    // A detecção de passagem busca por TRECHO no corpo da recebida, e o aviso é
    // esse corpo. "atendimento" cadastrado já mandou toda foto para a fila.
    const palavras = palavrasDePassagem([
      "falar com humano", "atendente", "pessoa real", "atendimento", "agente", "humano", "pessoa", "gerente", "suporte",
    ]);
    expect(matchesHandoffKeyword(MARCADOR_IMAGEM_NAO_VISTA, palavras)).toBe(false);
    expect(matchesHandoffKeyword(MARCADOR_IMAGEM_NAO_VISTA, palavrasDePassagem(["imagem"])), "controle").toBe(true);
    expect(detectHumanHandoffRequest(MARCADOR_IMAGEM_NAO_VISTA)).toBe(false);
  });

  it("não sai para fora como texto que o cliente digitou (moldura de mídia)", () => {
    const ultima = { direction: "inbound" as const, body: MARCADOR_IMAGEM_NAO_VISTA, sent_at: "t" };
    expect(textoDoClienteNaUltimaMensagem([ultima])).toBe("");
  });
});

describe("o histórico do agente", () => {
  const base = {
    lead_id: "l1",
    contact: { name: "x", phone: null, email: null, tags: [], is_blocked: false },
    conversation_id: "c1",
    last_human_decision: null,
  };
  const linha = {
    direction: "inbound" as const,
    ...foto(null),
    media_mime: "image/jpeg",
    sent_at: new Date("2026-07-22T10:00:00Z"),
    metadata: null,
  };

  it("fitToBudget sem visão: a foto vira o aviso", () => {
    expect(__test_fitToBudget(base, [linha], 100000, "UTC", false).messages[0]!.body).toBe(MARCADOR_IMAGEM_NAO_VISTA);
    expect(__test_fitToBudget(base, [linha], 100000, "UTC").messages[0]!.body).toContain(DESCRICAO);
  });

  it("fitToBudget sem visão: a foto que nós enviamos fica com a nossa legenda", () => {
    const nossa = { ...linha, direction: "outbound" as const, body: "Segue o boleto do pedido 123", media_derived_text: null };
    expect(__test_fitToBudget(base, [nossa], 100000, "UTC", false).messages[0]!.body).toBe("Segue o boleto do pedido 123");
  });

  it("getLeadContext obedece ao knob verImagens (o caminho do turno e da prévia)", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from contacts"))
          return {
            rows: [
              {
                name: "Carlos", display_name: null, email: null, phone_number: "+5511900000000", tags: [],
                is_blocked: false, source: "whatsapp", consent: null, is_anonymized: false,
              },
            ],
          };
        if (sql.includes("media_derived_text")) return { rows: [linha] };
        return { rows: [] };
      },
    };
    const entrada = { tenantId: "org-1", leadId: "contato-1", conversationId: "c1", fuso: "UTC" };
    const sem = await getLeadContext(db as never, {} as never, entrada, { historyLimit: 20, maxTokens: 100000, verImagens: false });
    const com = await getLeadContext(db as never, {} as never, entrada, { historyLimit: 20, maxTokens: 100000 });
    if (!sem.ok || !com.ok) throw new Error("contexto não lido");
    expect(sem.context.messages[0]!.body).toBe(MARCADOR_IMAGEM_NAO_VISTA);
    expect(com.context.messages[0]!.body, "ausente = vê (follow-up, classificador)").toContain(DESCRICAO);
  });

  it("a linha que o turno responde (loadInboundForJob) também vira o aviso", async () => {
    const db = { query: async () => ({ rows: [{ ...foto(null), metadata: null }] }) };
    const entrada = { tenantId: "org-1", conversationId: "c1", inboundMessageId: "m1" };
    expect((await loadInboundForJob(db as never, entrada, false))?.body).toBe(MARCADOR_IMAGEM_NAO_VISTA);
    expect((await loadInboundForJob(db as never, entrada))?.body).toContain(DESCRICAO);
  });
});

describe("a imagem nativa (multimodal) também respeita a opção", () => {
  const admin = {
    storage: {
      from: () => ({
        download: vi.fn(async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null })),
      }),
    },
  };
  const img = { direction: "inbound" as const, body: "x", sent_at: "t", type: "image", media_storage_path: "o/c/m.jpg", media_mime: "image/jpeg" };
  const pdf = { ...img, type: "document", media_storage_path: "o/c/m.pdf", media_mime: "application/pdf" };

  it("sem visão: nenhuma imagem vai ao modelo", async () => {
    const parts = await buildNativeMediaParts({
      messages: [img], provider: "anthropic", model: "claude-sonnet-4-6", multimodalInput: true, verImagens: false, admin: admin as never,
    });
    expect(parts).toEqual([]);
  });

  it("controle: com visão, a imagem vai", async () => {
    const parts = await buildNativeMediaParts({
      messages: [img], provider: "anthropic", model: "claude-sonnet-4-6", multimodalInput: true, verImagens: true, admin: admin as never,
    });
    expect(parts).toHaveLength(1);
  });

  it("controle: o PDF não muda com a opção", async () => {
    const parts = await buildNativeMediaParts({
      messages: [pdf], provider: "google", model: "gemini-2.5-pro", multimodalInput: true, verImagens: false, admin: admin as never,
    });
    expect(parts[0]).toMatchObject({ mediaType: "application/pdf" });
  });
});
