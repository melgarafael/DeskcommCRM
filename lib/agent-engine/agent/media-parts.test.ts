import { describe, expect, it, vi } from "vitest";

import { buildNativeMediaParts } from "./media-parts";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * Regressão da VISÃO NATIVA (Onda 3 / re-verificado 2026-07-23): prova que a
 * parte nativa É montada no formato que o AI SDK v7 entrega ao modelo
 * (`{type:'file', data:Buffer, mediaType}`) quando as condições valem. A
 * conclusão anterior de que "a parte não chega ao modelo" estava ERRADA —
 * confirmado ao vivo com Anthropic e OpenAI (com tools+multi-step). Este teste
 * trava o wiring pra o mito não voltar.
 */

// admin.storage.from(bucket).download(path) → { data: Blob, error: null }
function fakeAdmin(bytes: Buffer, opts: { fail?: boolean } = {}) {
  return {
    storage: {
      from: () => ({
        download: vi.fn(async () =>
          opts.fail
            ? { data: null, error: new Error("boom") }
            : { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null },
        ),
      }),
    },
  } as never;
}

const imageInbound: LeadContextMessage = {
  direction: "inbound",
  body: "[image]",
  sent_at: "2026-07-23T10:00:00Z",
  type: "image",
  media_storage_path: "org/conv/msg.jpg",
  media_mime: "image/jpeg",
};

describe("buildNativeMediaParts — regressão da visão nativa", () => {
  it("imagem inbound + provider capaz + multimodal on → 1 file part com mediaType MIME e bytes Buffer", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // header JPEG
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: fakeAdmin(bytes),
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("file");
    expect(parts[0]!.mediaType).toBe("image/jpeg");
    expect(Buffer.isBuffer(parts[0]!.data)).toBe(true);
    expect(parts[0]!.data.equals(bytes)).toBe(true);
  });

  it("multimodalInput=false → [] (feature desligada no agente)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: false,
      admin: fakeAdmin(Buffer.from([1])),
    });
    expect(parts).toEqual([]);
  });

  it("provider sem capacidade de visão → [] (derivado textual cobre)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "desconhecido",
      model: "modelo-x",
      multimodalInput: true,
      admin: fakeAdmin(Buffer.from([1])),
    });
    expect(parts).toEqual([]);
  });

  it("última inbound sem mídia → [] (não re-anexa mídia antiga do histórico)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound, { direction: "inbound", body: "e aí?", sent_at: "2026-07-23T10:05:00Z" }],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: fakeAdmin(Buffer.from([1])),
    });
    expect(parts).toEqual([]);
  });

  it("download do storage falha → [] sem lançar (turno nunca aborta pela mídia)", async () => {
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: fakeAdmin(Buffer.from([1]), { fail: true }),
    });
    expect(parts).toEqual([]);
  });
});

/**
 * ═══ O ROTEADOR: o call site REAL consulta o catálogo, e o direto NÃO ═══════
 *
 * A regra vive em `lib/ai/pontos/capacidade-em-vigor.ts` e tem teste próprio.
 * O que faltava é o que este bloco guarda: que ESTE arquivo a chama, e com o
 * catálogo ligado. Sem isso, trocar `visaoEmVigor` de volta por
 * `modelCapabilities(...).image` deixaria a suíte verde e o motor voltaria a
 * anexar a imagem a um modelo que a recusa — teste guarda a função, não o
 * call site.
 *
 * ⚠️ O dublê deste arquivo NÃO tinha `.from`, então nenhum caso passava pelo
 * ramo do roteador. A ausência de `.from` também é o caso de "banco fora", e
 * ele tem um teste aqui de propósito: falha de catálogo não pode derrubar o
 * turno — cai no palpite, que é o comportamento de antes da regra existir.
 */
function fakeAdminComCatalogo(bytes: Buffer, supports_vision: boolean | null) {
  const consultas: string[] = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (_c: string, v: string) => {
    consultas.push(v);
    return chain;
  };
  chain.is = () => chain;
  chain.maybeSingle = async () => ({ data: supports_vision === null ? null : { supports_vision } });
  return {
    consultas,
    admin: {
      from: () => chain,
      storage: {
        from: () => ({
          download: vi.fn(async () => ({
            data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
            error: null,
          })),
        }),
      },
    } as never,
  };
}

describe("buildNativeMediaParts — no roteador quem decide é o catálogo", () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it("openrouter + catálogo diz que NÃO enxerga → nenhuma parte nativa", async () => {
    // O defeito que este caso existe para impedir: o registro casa o prefixo
    // `openai/` e afirma que enxerga, o motor anexa os bytes, e o provedor
    // recusa — derrubando a resposta daquela mensagem para o cliente.
    const db = fakeAdminComCatalogo(bytes, false);
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openrouter",
      model: "openai/gpt-3.5-turbo",
      multimodalInput: true,
      admin: db.admin,
    });
    expect(parts).toEqual([]);
    expect(db.consultas, "o catálogo nem foi consultado").toContain("openai/gpt-3.5-turbo");
  });

  it("openrouter + catálogo diz que enxerga → a parte nativa vai", async () => {
    // Controle: sem ele, "no roteador nunca anexe" satisfaria o caso acima e a
    // visão morreria para quem usa OpenRouter com um modelo que enxerga.
    const db = fakeAdminComCatalogo(bytes, true);
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openrouter",
      model: "openai/gpt-4o",
      multimodalInput: true,
      admin: db.admin,
    });
    expect(parts).toHaveLength(1);
  });

  it("openrouter SEM linha no catálogo → cai no prefixo, que é melhor que nada", async () => {
    const db = fakeAdminComCatalogo(bytes, null);
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openrouter",
      model: "openai/gpt-4o",
      multimodalInput: true,
      admin: db.admin,
    });
    expect(parts).toHaveLength(1);
  });

  it("⚠️ provedor DIRETO não paga ida ao banco — o dublê explode se for consultado", async () => {
    // Guarda de custo: um roundtrip por turno com mídia, para confirmar o que o
    // registro já sabe. Se alguém tirar o atalho de `visaoEmVigor`, este caso
    // vira vermelho em vez de a conta do banco subir em silêncio.
    const db = fakeAdminComCatalogo(bytes, false);
    (db.admin as unknown as { from: () => never }).from = () => {
      throw new Error("provedor direto NÃO pode consultar o catálogo");
    };
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openai",
      model: "gpt-4o",
      multimodalInput: true,
      admin: db.admin,
    });
    expect(parts).toHaveLength(1);
  });

  it("catálogo fora do ar não derruba o turno — cai no palpite", async () => {
    const db = fakeAdminComCatalogo(bytes, false);
    (db.admin as unknown as { from: () => never }).from = () => {
      throw new Error("banco fora");
    };
    const parts = await buildNativeMediaParts({
      messages: [imageInbound],
      provider: "openrouter",
      model: "openai/gpt-4o",
      multimodalInput: true,
      admin: db.admin,
    });
    expect(parts).toHaveLength(1);
  });
});
