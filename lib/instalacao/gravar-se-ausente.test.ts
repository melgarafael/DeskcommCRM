/**
 * `gravarSeAusente` — o valor que o próprio sistema gera UMA vez (o segredo do
 * webhook da instalação).
 *
 * O que este arquivo prova, com banco e cifra dublados:
 *   1. a primeira escrita grava cifrado (nunca em claro) e devolve o valor;
 *   2. a segunda NÃO sobrescreve: devolve o que já estava — duas primeiras
 *      conexões simultâneas terminam com o MESMO segredo, e o provedor assina
 *      com o que a rota confere;
 *   3. sem chave de cifra, nada é gravado (falha fechada, como a da tela).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhas: new Map<string, Record<string, unknown>>(),
  upserts: [] as Array<{ linha: Record<string, unknown>; opcoes: unknown }>,
  semCifra: false,
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (v: string) => {
    if (h.semCifra) throw new Error("AI_CRED_AES_KEY ausente");
    return {
      ciphertext: Buffer.from(v),
      iv: Buffer.from("iv"),
      tag: Buffer.from("tag"),
      last4: v.slice(-4),
    };
  },
  decryptKey: (e: { ciphertext: Buffer }) => e.ciphertext.toString(),
  bufToBytea: (b: Buffer) => `\\x${b.toString("hex")}`,
  byteaToBuffer: (s: string) => Buffer.from(s.slice(2), "hex"),
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let chave = "";
      const q = {
        upsert: async (linha: Record<string, unknown>, opcoes: { ignoreDuplicates?: boolean }) => {
          h.upserts.push({ linha, opcoes });
          const k = String(linha.chave);
          if (!h.linhas.has(k) || !opcoes.ignoreDuplicates) h.linhas.set(k, linha);
          return { error: null };
        },
        select: () => q,
        eq: (_k: string, v: string) => ((chave = v), q),
        abortSignal: () => q,
        maybeSingle: async () => ({ data: h.linhas.get(chave) ?? null, error: null }),
      };
      return q;
    },
  }),
}));

import { gravarSeAusente } from "./config";

beforeEach(() => {
  h.linhas.clear();
  h.upserts.length = 0;
  h.semCifra = false;
});

describe("gravarSeAusente", () => {
  it("primeira escrita: grava cifrado, sem nada em claro, e devolve o valor", async () => {
    expect(await gravarSeAusente("SEGREDO_X", "valor-um", { ehSegredo: true })).toBe("valor-um");
    const [{ linha, opcoes }] = h.upserts as [{ linha: Record<string, unknown>; opcoes: unknown }];
    expect(opcoes).toEqual({ onConflict: "chave", ignoreDuplicates: true });
    expect(linha).toMatchObject({ chave: "SEGREDO_X", eh_segredo: true, semeado_do_env: false });
    expect(linha).not.toHaveProperty("valor");
    expect(JSON.stringify(linha)).not.toContain("valor-um");
  });

  it("segunda escrita não sobrescreve: devolve o que a primeira gravou", async () => {
    await gravarSeAusente("SEGREDO_X", "valor-um", { ehSegredo: true });
    expect(await gravarSeAusente("SEGREDO_X", "valor-dois", { ehSegredo: true })).toBe("valor-um");
  });

  it("sem chave de cifra: nada é gravado", async () => {
    h.semCifra = true;
    expect(await gravarSeAusente("SEGREDO_X", "valor-um", { ehSegredo: true })).toBeNull();
    expect(h.upserts).toEqual([]);
  });
});
