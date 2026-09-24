import { describe, expect, it, vi } from "vitest";

import { corpoDoEnvio } from "../edge/crm/send-message";
import {
  enviarComFotos,
  LIMITE_DA_LEGENDA,
  prepararFotosDoProduto,
  type FotoParaEnvio,
} from "./fotos-do-produto";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const PRODUTO = "bbbbbbbb-0000-4000-8000-000000000001";
const CONVERSA = "cccccccc-0000-4000-8000-000000000001";
const CAPA = `${ORG}/${PRODUTO}/11111111-2222-4333-8444-555555555555.jpg`;
const SEGUNDA = `${ORG}/${PRODUTO}/66666666-7777-4888-8999-000000000000.png`;

function banco(linha: { id: string; fotos: string[] | null } | null) {
  const query = vi.fn(async (_sql: string, _valores: unknown[]) => ({ rows: linha ? [linha] : [] }));
  return { db: { query } as never, query };
}

describe("prepararFotosDoProduto — a foto do catálogo vai para a pasta da conversa", () => {
  it("copia cada foto para whatsapp-media/<org>/<conversa>/, na ordem da tela", async () => {
    const { db, query } = banco({ id: PRODUTO, fotos: [CAPA, SEGUNDA] });
    const copiar = vi.fn(async () => true);

    const r = await prepararFotosDoProduto(db, copiar, {
      tenantId: ORG,
      conversationId: CONVERSA,
      codigo: " IP15 ",
    });

    // O produto é procurado NA organização do job, ativo, pelo código sem espaço.
    expect(query.mock.calls[0]?.[1]).toEqual([ORG, "IP15"]);
    expect(copiar.mock.calls).toEqual([
      [CAPA, `${ORG}/${CONVERSA}/catalogo-11111111-2222-4333-8444-555555555555.jpg`],
      [SEGUNDA, `${ORG}/${CONVERSA}/catalogo-66666666-7777-4888-8999-000000000000.png`],
    ]);
    expect(r).toEqual({
      ok: true,
      tinha: 2,
      fotos: [
        { storagePath: `${ORG}/${CONVERSA}/catalogo-11111111-2222-4333-8444-555555555555.jpg`, mime: "image/jpeg" },
        { storagePath: `${ORG}/${CONVERSA}/catalogo-66666666-7777-4888-8999-000000000000.png`, mime: "image/png" },
      ],
    });
  });

  it("caminho de OUTRA organização na linha nunca é copiado (a cópia é por service role)", async () => {
    const alheio = `${OUTRA_ORG}/${PRODUTO}/11111111-2222-4333-8444-555555555555.jpg`;
    const { db } = banco({ id: PRODUTO, fotos: [alheio] });
    const copiar = vi.fn(async () => true);

    const r = await prepararFotosDoProduto(db, copiar, { tenantId: ORG, conversationId: CONVERSA, codigo: "IP15" });

    expect(copiar).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, fotos: [], tinha: 0 });
  });

  it("código que não existe volta ao modelo como erro de ensino, sem copiar nada", async () => {
    const { db } = banco(null);
    const copiar = vi.fn(async () => true);

    const r = await prepararFotosDoProduto(db, copiar, { tenantId: ORG, conversationId: CONVERSA, codigo: "XX" });

    expect(r.ok).toBe(false);
    expect(copiar).not.toHaveBeenCalled();
  });

  it("foto que não copiou fica de fora e o resto segue — degradar, não derrubar", async () => {
    const { db } = banco({ id: PRODUTO, fotos: [CAPA, SEGUNDA] });
    const copiar = vi.fn(async (origem: string) => origem !== CAPA);

    const r = await prepararFotosDoProduto(db, copiar, { tenantId: ORG, conversationId: CONVERSA, codigo: "IP15" });

    expect(r.ok && r.fotos.map((f) => f.mime)).toEqual(["image/png"]);
    expect(r.ok && r.tinha).toBe(2);
  });
});

describe("enviarComFotos — o texto é a legenda da primeira foto", () => {
  const FOTO_1: FotoParaEnvio = { storagePath: `${ORG}/${CONVERSA}/catalogo-1.jpg`, mime: "image/jpeg" };
  const FOTO_2: FotoParaEnvio = { storagePath: `${ORG}/${CONVERSA}/catalogo-2.jpg`, mime: "image/jpeg" };

  function canal(desfechos: string[] = []) {
    const enviados: Array<{ tipo: "texto" | "foto"; corpo: string; foto?: string }> = [];
    let i = 0;
    const proximo = () => ({ kind: desfechos[i++] ?? "sent", messageId: `m${i}` });
    return {
      enviados,
      opts: {
        enviarTexto: async (corpo: string) => (enviados.push({ tipo: "texto", corpo }), proximo()),
        enviarFoto: async (foto: FotoParaEnvio, legenda: string) => (
          enviados.push({ tipo: "foto", corpo: legenda, foto: foto.storagePath }), proximo()
        ),
        sleep: vi.fn(async () => undefined),
        jitter: () => 1500,
      },
    };
  }

  it("sem foto, é o envio de texto de sempre", async () => {
    const c = canal();
    await enviarComFotos("Custa R$ 10", [], c.opts);
    expect(c.enviados).toEqual([{ tipo: "texto", corpo: "Custa R$ 10" }]);
  });

  it("com fotos: a capa leva o texto, as demais vão sem legenda, com a pausa anti-ban entre elas", async () => {
    const c = canal();
    await enviarComFotos("iPhone 15 por R$ 5.499", [FOTO_1, FOTO_2], c.opts);
    expect(c.enviados).toEqual([
      { tipo: "foto", corpo: "iPhone 15 por R$ 5.499", foto: FOTO_1.storagePath },
      { tipo: "foto", corpo: "", foto: FOTO_2.storagePath },
    ]);
    expect(c.opts.sleep).toHaveBeenCalledTimes(1);
  });

  it("texto maior que a legenda do WhatsApp sai como texto, e as fotos depois", async () => {
    const c = canal();
    const longo = "a".repeat(LIMITE_DA_LEGENDA + 1);
    await enviarComFotos(longo, [FOTO_1], c.opts);
    expect(c.enviados).toEqual([
      { tipo: "texto", corpo: longo },
      { tipo: "foto", corpo: "", foto: FOTO_1.storagePath },
    ]);
  });

  // O teto de mensagens do turno é medido ANTES DE CADA FOTO, contando o que
  // já saiu. Achado de revisão: com o teto calculado uma vez, antes do texto, a
  // descrição longa (texto à parte) não era descontada e o turno estourava.
  describe("teto de mensagens do turno (max_sends_per_turn)", () => {
    const FOTO_3: FotoParaEnvio = { storagePath: `${ORG}/${CONVERSA}/catalogo-3.jpg`, mime: "image/jpeg" };
    const comTeto = (c: ReturnType<typeof canal>, teto: number) => ({
      ...c.opts,
      restantes: () => teto - c.enviados.length,
    });

    it("descrição longa + 3 fotos com teto 3: o texto gasta uma, e só 2 fotos saem", async () => {
      const c = canal();
      const longo = "a".repeat(LIMITE_DA_LEGENDA + 1);
      await enviarComFotos(longo, [FOTO_1, FOTO_2, FOTO_3], comTeto(c, 3));
      expect(c.enviados).toHaveLength(3);
      expect(c.enviados.map((e) => e.tipo)).toEqual(["texto", "foto", "foto"]);
    });

    it("legenda que cabe + 3 fotos com teto 3: as 3 saem, a capa com o texto", async () => {
      const c = canal();
      await enviarComFotos("Caneca por R$ 49", [FOTO_1, FOTO_2, FOTO_3], comTeto(c, 3));
      expect(c.enviados.map((e) => e.tipo)).toEqual(["foto", "foto", "foto"]);
    });

    it("teto já gasto: só o texto sai, sem foto", async () => {
      const c = canal();
      await enviarComFotos("Caneca por R$ 49", [FOTO_1], { ...c.opts, restantes: () => 0 });
      expect(c.enviados).toEqual([{ tipo: "texto", corpo: "Caneca por R$ 49" }]);
    });
  });

  it("para no primeiro desfecho que não é sucesso — contato bloqueado não recebe a segunda foto", async () => {
    const c = canal(["blocked"]);
    const r = await enviarComFotos("oi", [FOTO_1, FOTO_2], c.opts);
    expect(r.kind).toBe("blocked");
    expect(c.enviados).toHaveLength(1);
  });
});

describe("corpoDoEnvio — a foto chega ao handler como imagem da conversa", () => {
  const base = {
    tenantId: ORG,
    leadId: "lead",
    jobId: "job",
    seq: 1,
    conversationId: CONVERSA,
  };

  it("com media: type image, caminho e mime, e a legenda no body", () => {
    expect(
      corpoDoEnvio({ ...base, body: "legenda", media: { storagePath: "p.jpg", mime: "image/jpeg" } }, "k"),
    ).toEqual({
      conversation_id: CONVERSA,
      type: "image",
      media_storage_path: "p.jpg",
      media_mime: "image/jpeg",
      body: "legenda",
      metadata: { idempotency_key: "k" },
    });
  });

  it("foto sem legenda vai SEM body — o schema do envio recusa corpo vazio", () => {
    const corpo = corpoDoEnvio({ ...base, body: "", media: { storagePath: "p.jpg", mime: "image/jpeg" } }, "k");
    expect("body" in corpo).toBe(false);
  });

  it("texto comum segue texto", () => {
    expect(corpoDoEnvio({ ...base, body: "oi" }, "k")).toMatchObject({ type: "text", body: "oi" });
  });
});
