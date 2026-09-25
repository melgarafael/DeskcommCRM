import { afterEach, describe, expect, it, vi } from "vitest";

import { lerHierarquiaDoAnuncio } from "@/lib/plataformas-de-anuncio/meta/hierarquia-do-anuncio";

/**
 * A distinção que este arquivo existe para guardar: **cota não é ausência**.
 *
 * Um 613 significa "pergunte de novo mais tarde". Se ele virasse "este anúncio
 * não existe", o chamador gravaria um vazio permanente no cache por causa de
 * uma espera de minutos — e a ficha do contato passaria a mentir para sempre
 * sobre um anúncio que está no ar.
 */

function respostaDe(status: number, corpo: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
  } as Response;
}

const mockFetch = (r: Response | Promise<Response> | Error) => {
  const fn = vi.fn(async () => {
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a leitura da hierarquia", () => {
  it("traz anúncio, conjunto e campanha de UMA chamada só", async () => {
    // Três chamadas encadeadas custariam o triplo da cota para a mesma
    // resposta, e cota é o recurso escasso nesta conta.
    const fetchMock = mockFetch(
      respostaDe(200, {
        name: "Criativo 07",
        adset: { id: "6123", name: "Lookalike 1%" },
        campaign: { id: "2345", name: "Leads Setembro" },
      }),
    );

    const r = await lerHierarquiaDoAnuncio("tok", "120210000000000");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      ok: true,
      dados: {
        adId: "120210000000000",
        adName: "Criativo 07",
        adsetId: "6123",
        adsetName: "Lookalike 1%",
        campaignId: "2345",
        campaignName: "Leads Setembro",
      },
    });
  });

  it("o token vai no HEADER, nunca na query", async () => {
    // Token em URL vaza para log de proxy e para breadcrumb de erro. Mesma
    // regra de `insights.ts` e do anti-pattern 12.
    const fetchMock = mockFetch(respostaDe(200, { name: "X" }));
    await lerHierarquiaDoAnuncio("segredo-do-token", "120210000000000");

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).not.toContain("segredo-do-token");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer segredo-do-token",
    );
  });

  it("campo ausente na resposta vira null, não string vazia", async () => {
    // Anúncio sem conjunto não acontece na plataforma, mas a resposta pode vir
    // podada por permissão. `""` na ficha desenharia uma linha em branco.
    const r = await (mockFetch(respostaDe(200, { name: "  " })),
    lerHierarquiaDoAnuncio("tok", "ad-1"));
    expect(r).toEqual({
      ok: true,
      dados: {
        adId: "ad-1",
        adName: null,
        adsetId: null,
        adsetName: null,
        campaignId: null,
        campaignName: null,
      },
    });
  });
});

describe("as falhas, e a diferença entre elas", () => {
  it("613 é COTA — transitório, e nunca 'o anúncio não existe'", async () => {
    mockFetch(
      respostaDe(400, {
        error: { code: 613, message: "Calls to this api have exceeded the rate limit" },
      }),
    );
    const r = await lerHierarquiaDoAnuncio("tok", "ad-1");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ falha: "limite_de_chamadas" });
  });

  it("100 é campo inválido — bug nosso ou campo removido, não espera", async () => {
    // É o desfecho do achado 2 de `insights.ts`: nome inválido em `fields`
    // derruba a resposta inteira. Mandar o operador "tentar mais tarde" aqui
    // desperdiça o dia dele — o conserto é um deploy.
    mockFetch(
      respostaDe(400, { error: { code: 100, message: "is not valid for fields param" } }),
    );
    const r = await lerHierarquiaDoAnuncio("tok", "ad-1");
    expect(r).toMatchObject({ ok: false, falha: "campo_invalido" });
  });

  it("190 é token — quem opera precisa reconectar", async () => {
    mockFetch(respostaDe(401, { error: { code: 190, message: "Invalid OAuth token" } }));
    const r = await lerHierarquiaDoAnuncio("tok", "ad-1");
    expect(r).toMatchObject({ ok: false, falha: "token_invalido" });
  });

  it("5xx é instabilidade do outro lado", async () => {
    mockFetch(respostaDe(500, "<html>bad gateway</html>"));
    const r = await lerHierarquiaDoAnuncio("tok", "ad-1");
    expect(r).toMatchObject({ ok: false, falha: "transitorio" });
  });

  it("falha de rede não lança — vira resultado", async () => {
    mockFetch(new Error("ECONNRESET"));
    const r = await lerHierarquiaDoAnuncio("tok", "ad-1");
    expect(r).toMatchObject({ ok: false, falha: "transitorio", detalhe: "ECONNRESET" });
  });

  it("200 com corpo ilegível não estoura o chamador", async () => {
    mockFetch(respostaDe(200, "isto não é json"));
    const r = await lerHierarquiaDoAnuncio("tok", "ad-1");
    expect(r).toMatchObject({ ok: false, falha: "transitorio" });
  });
});
