/**
 * A captura de `gclid` do Google Ads — o par token↔gclid e o extrator que o
 * consome. Cada bloco aqui existe por um modo de falha concreto: token
 * consumido duas vezes, colisão na geração, mensagem sem token, token de
 * outra organização.
 */
import { describe, expect, it, vi } from "vitest";
import { lerAtribuicao } from "@/lib/conversoes/leitura-da-atribuicao";

import {
  casarClickRef,
  criarClickRef,
} from "@/lib/plataformas-de-anuncio/google/captura-de-clique";
import { extrairEEstamparAtribuicaoGoogle } from "@/lib/plataformas-de-anuncio/google/atribuicao";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "33333333-3333-3333-3333-333333333333";

describe("criarClickRef", () => {
  it("grava o par token↔gclid na primeira tentativa", async () => {
    const inserts: Record<string, unknown>[] = [];
    const admin = {
      from: () => ({
        insert: async (valores: Record<string, unknown>) => {
          inserts.push(valores);
          return { error: null };
        },
      }),
    };

    const criado = await criarClickRef(admin as never, ORG, "gclid-abc", { gclid: "gclid-abc" });

    expect(criado).not.toBeNull();
    expect(criado?.token).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.organization_id).toBe(ORG);
    expect(inserts[0]?.gclid).toBe("gclid-abc");
  });

  it("tenta outro token quando o gerado colide (23505) e desiste em erro diferente", async () => {
    let chamadas = 0;
    const admin = {
      from: () => ({
        insert: async () => {
          chamadas += 1;
          if (chamadas === 1) return { error: { code: "23505", message: "duplicate" } };
          return { error: null };
        },
      }),
    };

    const criado = await criarClickRef(admin as never, ORG, "gclid-abc", {});
    expect(criado).not.toBeNull();
    expect(chamadas).toBe(2);
  });

  it("devolve null sem retentar quando o erro não é colisão de token", async () => {
    let chamadas = 0;
    const admin = {
      from: () => ({
        insert: async () => {
          chamadas += 1;
          return { error: { code: "23503", message: "fk violation" } };
        },
      }),
    };

    const criado = await criarClickRef(admin as never, ORG, "gclid-abc", {});
    expect(criado).toBeNull();
    // Erro que não é 23505 não se resolve tentando outro token — uma
    // chamada só, senão a rota fica lenta demais numa organização inexistente.
    expect(chamadas).toBe(1);
  });
});

describe("casarClickRef", () => {
  it("casa um token nunca consumido e devolve o gclid", async () => {
    const filtros: Record<string, unknown> = {};
    const admin = {
      from: () => {
        const construtor = {
          update: () => construtor,
          eq: (campo: string, valor: unknown) => {
            filtros[campo] = valor;
            return construtor;
          },
          is: (campo: string, valor: unknown) => {
            filtros[campo] = valor;
            return construtor;
          },
          select: () => construtor,
          maybeSingle: async () => ({ data: { gclid: "gclid-xyz" }, error: null }),
        };
        return construtor;
      },
    };

    const casado = await casarClickRef(admin as never, ORG, "ABC123", CONTATO);
    expect(casado).toEqual({ gclid: "gclid-xyz" });
    // O filtro tem que incluir a organização (lição da #236) e a trava de
    // consumo único.
    expect(filtros.organization_id).toBe(ORG);
    expect(filtros.token).toBe("ABC123");
    expect(filtros.matched_at).toBeNull();
  });

  it("devolve null quando o token já foi consumido (UPDATE não casa nenhuma linha)", async () => {
    const admin = {
      from: () => {
        const construtor = {
          update: () => construtor,
          eq: () => construtor,
          is: () => construtor,
          select: () => construtor,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return construtor;
      },
    };

    const casado = await casarClickRef(admin as never, ORG, "ABC123", CONTATO);
    expect(casado).toBeNull();
  });
});

describe("extrairEEstamparAtribuicaoGoogle", () => {
  it("ignora mensagem sem o padrão [ref:XXXXXX]", async () => {
    const rpc = vi.fn();
    const admin = { from: () => ({}), rpc };

    await extrairEEstamparAtribuicaoGoogle(admin as never, ORG, CONTATO, "Olá, quero saber mais!");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ignora texto nulo sem tentar nada", async () => {
    const rpc = vi.fn();
    const admin = { from: () => ({}), rpc };

    await extrairEEstamparAtribuicaoGoogle(admin as never, ORG, CONTATO, null);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("acha o token, casa o clique e estampa o contato com o gclid", async () => {
    const rpc = vi.fn(async (_fn: string, _params: Record<string, unknown>) => ({ error: null }));
    const admin = {
      from: (tabela: string) => {
        if (tabela !== "google_ads_click_refs") throw new Error(`tabela inesperada: ${tabela}`);
        const construtor = {
          update: () => construtor,
          eq: () => construtor,
          is: () => construtor,
          select: () => construtor,
          maybeSingle: async () => ({ data: { gclid: "gclid-777" }, error: null }),
        };
        return construtor;
      },
      rpc,
    };

    await extrairEEstamparAtribuicaoGoogle(
      admin as never,
      ORG,
      CONTATO,
      "Olá! Vim pelo anúncio e quero saber mais. [ref:7K9M2Q]",
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect((params.p_metadata as Record<string, unknown>).ad_platform).toBe("google_ads");
    expect((params.p_metadata as Record<string, unknown>).ad_source_id).toBe("gclid-777");
  });

  it("não estampa nada quando o token não casa (já consumido ou de outra organização)", async () => {
    const rpc = vi.fn();
    const admin = {
      from: () => {
        const construtor = {
          update: () => construtor,
          eq: () => construtor,
          is: () => construtor,
          select: () => construtor,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return construtor;
      },
      rpc,
    };

    await extrairEEstamparAtribuicaoGoogle(
      admin as never,
      ORG,
      CONTATO,
      "texto com [ref:ZZZZZZ] que não existe",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("identificador preservado do WhatsApp ao envio", () => {
  it.each(["gbraid", "wbraid"])("mantém %s no contato e na leitura da conversão", async (tipo) => {
    let metadata: Record<string, unknown> = {};
    const admin = {
      from: (tabela: string) => {
        const q = {
          update: () => q,
          select: () => q,
          eq: () => q,
          is: () => q,
          maybeSingle: async () => ({
            error: null,
            data:
              tabela === "google_ads_click_refs"
                ? { gclid: null, gbraid: null, wbraid: null, [tipo]: "clique-braid" }
                : { phone_number: null, source_metadata: metadata },
          }),
        };
        return q;
      },
      rpc: async (_fn: string, params: { p_metadata: Record<string, unknown> }) => {
        metadata = params.p_metadata;
        return { error: null };
      },
    };
    await extrairEEstamparAtribuicaoGoogle(admin as never, ORG, CONTATO, "Olá [ref:7K9M2Q]");
    expect(await lerAtribuicao(admin as never, ORG, CONTATO)).toEqual({
      temAtribuicao: true,
      atribuicao: {
        plataforma: "google_ads",
        cliqueDeOrigem: "clique-braid",
        telefone: null,
        identificadoresGoogle: { [tipo]: "clique-braid" },
      },
    });
  });
});
