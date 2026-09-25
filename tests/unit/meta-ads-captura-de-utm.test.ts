/**
 * A rota pública que troca o `[dk1:<base64url>]` por `[ref:XXXXXX]`.
 *
 * Cada caso aqui é um modo de falha concreto do caminho de quem CLICOU: hit
 * sem UTM nenhuma, organização que não existe, captura desligada e falha ao
 * gravar o ref. Nenhum deles pode virar tela de erro nem exceção — perder a
 * atribuição é aceitável, perder o lead não.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const estado = vi.hoisted(() => ({
  organizacao: { id: "org-a" } as { id: string } | null,
  config: {
    whatsapp_e164: "+5511999999999",
    message_template: "Olá! Vim pelo site. [ref:{token}]",
    enabled: true,
  } as { whatsapp_e164: string; message_template: string; enabled: boolean } | null,
  erroDoInsert: null as { code: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
  permitido: true,
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: estado.permitido }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "meta_ads_click_refs") {
        return {
          insert: async (valores: Record<string, unknown>) => {
            estado.inserts.push(valores);
            return { error: estado.erroDoInsert };
          },
        };
      }
      const consulta: Record<string, unknown> = {};
      consulta.select = () => consulta;
      consulta.eq = () => consulta;
      consulta.maybeSingle = async () => ({
        data: tabela === "organizations" ? estado.organizacao : estado.config,
        error: null,
      });
      return consulta;
    },
  }),
}));

import { GET } from "@/app/api/v1/anuncios/meta/[org]/route";
import { casarClickRef } from "@/lib/plataformas-de-anuncio/meta/captura-de-clique";
import { textoSemRef } from "@/lib/plataformas-de-anuncio/pagina-de-captura";

const chamar = (query: string) =>
  GET(
    new NextRequest(`https://crm.example/api/v1/anuncios/meta/acme${query}`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    }),
    { params: Promise.resolve({ org: "acme" }) },
  );

const UTM_COMPLETA =
  "?utm_source=meta&utm_campaign=black-friday&utm_adset=mulheres-25-34&utm_ad=video-depoimento-v3";

beforeEach(() => {
  estado.organizacao = { id: "org-a" };
  estado.config = {
    whatsapp_e164: "+5511999999999",
    message_template: "Olá! Vim pelo site. [ref:{token}]",
    enabled: true,
  };
  estado.erroDoInsert = null;
  estado.inserts = [];
  estado.permitido = true;
});

describe("GET /api/v1/anuncios/meta/[org]", () => {
  it("guarda as UTMs e manda para o WhatsApp com o ref no texto", async () => {
    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(302);
    const destino = decodeURIComponent(resposta.headers.get("location") ?? "");
    expect(destino).toContain("https://wa.me/5511999999999");
    expect(destino).toMatch(/\[ref:[2-9A-HJ-NP-Z]{6}\]/);

    expect(estado.inserts).toHaveLength(1);
    const linha = estado.inserts[0]!;
    expect(linha.organization_id).toBe("org-a");
    expect(linha.utm).toEqual({
      utm_source: "meta",
      utm_campaign: "black-friday",
      utm_adset: "mulheres-25-34",
      utm_ad: "video-depoimento-v3",
    });
  });

  it("o que não é chave de campanha não atravessa — nem para o ref, nem para a tabela", async () => {
    await chamar("?utm_campaign=black-friday&nome=Fulano&telefone=5511999999999");

    expect(estado.inserts[0]?.utm).toEqual({ utm_campaign: "black-friday" });
    // A query crua fica guardada inteira de propósito (é a prova de onde o
    // clique veio), mas o que vira ATRIBUIÇÃO é só a UTM normalizada.
    expect(estado.inserts[0]?.query_raw).toMatchObject({ nome: "Fulano" });
  });

  it("hit sem UTM nenhuma: vai para o WhatsApp sem ref, e não grava linha", async () => {
    const resposta = await chamar("");

    expect(resposta.status).toBe(302);
    const destino = decodeURIComponent(resposta.headers.get("location") ?? "");
    expect(destino).toContain("https://wa.me/5511999999999");
    expect(destino).not.toContain("[ref:");
    expect(estado.inserts).toHaveLength(0);
  });

  it("falha ao gravar o ref: a pessoa ainda chega no WhatsApp, só sem atribuição", async () => {
    estado.erroDoInsert = { code: "23503", message: "fk violation" };

    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(302);
    expect(decodeURIComponent(resposta.headers.get("location") ?? "")).not.toContain("[ref:");
  });

  it("organização inexistente: página neutra, nunca 500 nem 'esta organização não existe'", async () => {
    estado.organizacao = null;

    const resposta = await chamar(UTM_COMPLETA);

    // Sem organização não há número de WhatsApp para onde mandar — é o único
    // caminho em que a página neutra é o melhor desfecho possível.
    expect(resposta.status).toBe(404);
    expect(await resposta.text()).not.toContain("acme");
  });

  it("captura desligada: mesma régua da organização inexistente", async () => {
    estado.config = {
      whatsapp_e164: "+5511999999999",
      message_template: "Olá! Vim pelo site. [ref:{token}]",
      enabled: false,
    };

    const resposta = await chamar(UTM_COMPLETA);
    expect(resposta.status).toBe(404);
    expect(estado.inserts).toHaveLength(0);
  });

  it("rate limit estourado devolve 429 sem tocar no banco", async () => {
    estado.permitido = false;

    const resposta = await chamar(UTM_COMPLETA);

    expect(resposta.status).toBe(429);
    expect(resposta.headers.get("Retry-After")).toBe("60");
    expect(estado.inserts).toHaveLength(0);
  });
});

describe("textoSemRef", () => {
  it("tira o marcador INTEIRO, não só o placeholder", () => {
    // `[ref:]` na mensagem do lead não casa com padrão nenhum na ingestão e
    // lê como link quebrado para quem recebe.
    expect(textoSemRef("Olá! Vim pelo site. [ref:{token}]")).toBe("Olá! Vim pelo site.");
  });

  it("template que escreve o placeholder fora de colchetes também sai limpo", () => {
    expect(textoSemRef("Vim pelo site {token}")).toBe("Vim pelo site");
  });
});

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "33333333-3333-3333-3333-333333333333";

describe("casarClickRef (Meta)", () => {
  /** O construtor do PostgREST, com os filtros anotados para o caso conferir. */
  function adminQueDevolve(data: unknown, filtros: Record<string, unknown> = {}) {
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
      maybeSingle: async () => ({ data, error: null }),
    };
    return { from: () => construtor };
  }

  it("consome o ref e devolve as UTMs guardadas no clique", async () => {
    const filtros: Record<string, unknown> = {};
    const admin = adminQueDevolve({ utm: { utm_campaign: "black-friday" } }, filtros);

    const casado = await casarClickRef(admin as never, ORG, "K7M2P9", CONTATO);

    expect(casado).toEqual({ utm: { utm_campaign: "black-friday" } });
    // Organização no filtro é a lição da #236; `matched_at is null` é a trava
    // de consumo único.
    expect(filtros.organization_id).toBe(ORG);
    expect(filtros.token).toBe("K7M2P9");
    expect(filtros.matched_at).toBeNull();
  });

  it("ref já consumido não casa (o UPDATE não acha linha)", async () => {
    const casado = await casarClickRef(adminQueDevolve(null) as never, ORG, "K7M2P9", CONTATO);
    expect(casado).toBeNull();
  });

  it("linha sem UTM não vira atribuição", async () => {
    const casado = await casarClickRef(adminQueDevolve({ utm: {} }) as never, ORG, "K7M2P9", CONTATO);
    expect(casado).toBeNull();
  });
});
