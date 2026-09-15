import { afterEach, describe, expect, it, vi } from "vitest";

import { lerInsights } from "@/lib/plataformas-de-anuncio/meta/insights";

/**
 * OS CAMPOS DO CONNECT RATE ENTRAM NA CHAMADA QUE A TELA JÁ FAZIA.
 *
 * A tela de Anúncios › Meta faz DUAS requisições por atualização (campanhas +
 * insights) e a cota da Graph conta por requisição. Uma coluna derivada não pode
 * custar uma terceira chamada: o que este arquivo trava é que `actions` e
 * `inline_link_clicks` viajam nos `fields` do insights que já existia — e que os
 * campos antigos CONTINUAM sendo pedidos, porque na v22.0 um campo inválido
 * derruba a resposta inteira (achado 2 do cabeçalho de `insights.ts`).
 *
 * O denominador é o ponto: `ctr` e `cpc` são razões — e `cpc` conta cliques
 * TOTAIS —, então contagem de cliques no link não estava em campo nenhum do
 * payload antigo. Sem `inline_link_clicks` a coluna não teria de onde sair.
 */
function camposPedidos(urls: string[]): string[] {
  const primeira = urls[0];
  if (!primeira) throw new Error("esperava ao menos uma requisição");
  return (new URL(primeira).searchParams.get("fields") ?? "").split(",");
}

function capturarUrlsDoPedido(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pedido de insights com os campos do Connect rate", () => {
  it("pede `actions` e `inline_link_clicks` sem acrescentar requisição", async () => {
    const urls = capturarUrlsDoPedido();

    const leitura = await lerInsights("token-de-teste", "act_1", "2026-09-01", "2026-09-30");

    expect(leitura.ok).toBe(true);
    const campos = camposPedidos(urls);
    expect(campos).toContain("actions");
    expect(campos).toContain("inline_link_clicks");
    // UMA requisição e só: é o mesmo pedido de antes, com dois nomes a mais.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("level=campaign");
  });

  it("não perde nenhum campo que a tela já pedia", async () => {
    const urls = capturarUrlsDoPedido();

    await lerInsights("token-de-teste", "act_1", "2026-09-01", "2026-09-30");

    expect(camposPedidos(urls)).toEqual(
      expect.arrayContaining([
        "campaign_id",
        "campaign_name",
        "spend",
        "impressions",
        "reach",
        "cpm",
        "ctr",
        "frequency",
        "cpc",
        "results",
        "cost_per_result",
        "video_play_actions",
        "video_thruplay_watched_actions",
      ]),
    );
  });
});
