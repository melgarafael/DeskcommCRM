import { randomBytes, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ env: { AI_CRED_AES_KEY: "" } }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));

type Modulo = typeof import("./segredo-do-modulo");

/** A chave é lida e guardada em memória por `aes_gcm`: cada cenário carrega o módulo do zero. */
async function carregar(chave: string): Promise<Modulo> {
  mocks.env.AI_CRED_AES_KEY = chave;
  vi.resetModules();
  return import("./segredo-do-modulo");
}

const CHAVE = randomBytes(32).toString("base64");
const ORG = randomUUID();
const entrada = { organizationId: ORG, timestamp: 1_800_000_000_000, nonce: "n-123" };

describe("assinatura do módulo", () => {
  let m: Modulo;
  beforeEach(async () => {
    m = await carregar(CHAVE);
  });

  it("assinatura correta passa", () => {
    const segredo = m.gerarSegredo();
    expect(m.verificarAssinatura(segredo, entrada, m.assinar(segredo, entrada))).toBe(true);
    expect(m.assinar(segredo, entrada)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o timestamp como texto ou como número assina igual", () => {
    const segredo = m.gerarSegredo();
    expect(m.assinar(segredo, { ...entrada, timestamp: String(entrada.timestamp) })).toBe(
      m.assinar(segredo, entrada),
    );
  });

  it("alterar organização, carimbo, nonce, assinatura ou segredo reprova", () => {
    const segredo = m.gerarSegredo();
    const boa = m.assinar(segredo, entrada);
    expect(m.verificarAssinatura(segredo, { ...entrada, organizationId: randomUUID() }, boa)).toBe(false);
    expect(m.verificarAssinatura(segredo, { ...entrada, timestamp: entrada.timestamp + 1 }, boa)).toBe(false);
    expect(m.verificarAssinatura(segredo, { ...entrada, nonce: "n-124" }, boa)).toBe(false);
    const adulterada = (boa[0] === "a" ? "b" : "a") + boa.slice(1);
    expect(m.verificarAssinatura(segredo, entrada, adulterada)).toBe(false);
    expect(m.verificarAssinatura(m.gerarSegredo(), entrada, boa)).toBe(false);
  });

  it("assinatura de outro comprimento ou não-hex reprova sem lançar", () => {
    const segredo = m.gerarSegredo();
    const boa = m.assinar(segredo, entrada);
    for (const ruim of [
      "",
      "abc",
      boa.slice(0, 62),
      `${boa}00`,
      "z".repeat(64),
      `${boa.slice(0, 63)}g`,
      " ".repeat(64),
      null as unknown as string,
      undefined as unknown as string,
      123 as unknown as string,
    ]) {
      expect(() => m.verificarAssinatura(segredo, entrada, ruim)).not.toThrow();
      expect(m.verificarAssinatura(segredo, entrada, ruim)).toBe(false);
    }
  });

  it("aceita a assinatura em hex maiúsculo, que é o mesmo valor", () => {
    const segredo = m.gerarSegredo();
    expect(m.verificarAssinatura(segredo, entrada, m.assinar(segredo, entrada).toUpperCase())).toBe(true);
  });
});

describe("janela do carimbo", () => {
  it("a borda de exatamente 5 minutos é INCLUSIVA, para os dois lados", async () => {
    const m = await carregar(CHAVE);
    const agora = 1_800_000_000_000;
    expect(m.JANELA_DO_CARIMBO_MS).toBe(5 * 60 * 1000);
    expect(m.carimboDentroDaJanela(agora - m.JANELA_DO_CARIMBO_MS, agora)).toBe(true);
    expect(m.carimboDentroDaJanela(agora + m.JANELA_DO_CARIMBO_MS, agora)).toBe(true);
  });

  it("5 minutos + 1 ms fica de fora, para os dois lados", async () => {
    const m = await carregar(CHAVE);
    const agora = 1_800_000_000_000;
    expect(m.carimboDentroDaJanela(agora - m.JANELA_DO_CARIMBO_MS - 1, agora)).toBe(false);
    expect(m.carimboDentroDaJanela(agora + m.JANELA_DO_CARIMBO_MS + 1, agora)).toBe(false);
  });

  it("o carimbo igual ao relógio vale e o que não é número não vale", async () => {
    const m = await carregar(CHAVE);
    expect(m.carimboDentroDaJanela(1000, 1000)).toBe(true);
    expect(m.carimboDentroDaJanela(Number.NaN, 1000)).toBe(false);
    expect(m.carimboDentroDaJanela(Number.POSITIVE_INFINITY, 1000)).toBe(false);
  });
});

describe("segredo e cifra", () => {
  it("dois segredos gerados diferem e têm 43 caracteres base64url (32 bytes)", async () => {
    const m = await carregar(CHAVE);
    const a = m.gerarSegredo();
    const b = m.gerarSegredo();
    expect(a).not.toBe(b);
    for (const s of [a, b]) {
      expect(s).toHaveLength(43);
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(s, "base64url")).toHaveLength(32);
    }
  });

  it("cifrar e decifrar fazem a ida e a volta, e o cifrado não contém o segredo", async () => {
    const m = await carregar(CHAVE);
    const segredo = m.gerarSegredo();
    const cifrado = m.cifrarSegredo(segredo);
    expect(cifrado).not.toContain(segredo);
    expect(m.decifrarSegredo(cifrado)).toBe(segredo);
    // IV novo a cada cifra: o mesmo segredo não produz o mesmo texto.
    expect(m.cifrarSegredo(segredo)).not.toBe(cifrado);
  });

  it("valor guardado adulterado ou ilegível lança com frase fixa, sem eco do conteúdo", async () => {
    const m = await carregar(CHAVE);
    const segredo = m.gerarSegredo();
    const partes = m.cifrarSegredo(segredo).split(".");
    const adulterado = [partes[0], partes[1], partes[2], Buffer.from("outro").toString("base64url")].join(".");
    expect(() => m.decifrarSegredo(adulterado)).toThrow("Segredo guardado não pôde ser aberto.");
    expect(() => m.decifrarSegredo("lixo")).toThrow("Segredo guardado em formato ilegível.");
  });

  it("chave de cifra ausente lança extension_secret_key_missing, em cifrar, decifrar e na conferência", async () => {
    const com = await carregar(CHAVE);
    const cifrado = com.cifrarSegredo(com.gerarSegredo());
    const sem = await carregar("");
    for (const chamada of [
      () => sem.cifrarSegredo("qualquer"),
      () => sem.decifrarSegredo(cifrado),
      () => sem.garantirChaveDeCifra(),
    ]) {
      let erro: unknown;
      try {
        chamada();
      } catch (e) {
        erro = e;
      }
      expect(sem.ehChaveDeCifraAusente(erro)).toBe(true);
      expect(erro).toMatchObject({ code: "extension_secret_key_missing" });
      expect((erro as Error).message).toContain("chave de cifra");
    }
  });

  it("chave malformada (não tem 32 bytes) também conta como ausente", async () => {
    const m = await carregar(Buffer.from("curta").toString("base64"));
    let erro: unknown;
    try {
      m.garantirChaveDeCifra();
    } catch (e) {
      erro = e;
    }
    expect(m.ehChaveDeCifraAusente(erro)).toBe(true);
  });
});
