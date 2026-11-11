/**
 * A REPETIÇÃO QUE SALVA A TELA QUANDO A PLATAFORMA RECUSA UM CAMPO NOVO.
 *
 * Na v22.0, um nome inválido em `fields` devolve erro 100 e derruba a resposta
 * INTEIRA — já aconteceu nesta rota com `video_3_sec_watched_actions` (achado 2
 * do cabeçalho de `insights.ts`). O payload de insights alimenta TODAS as
 * colunas da tabela, então o desfecho é a tela toda cair, sem nada que quem
 * opera possa fazer.
 *
 * O Connect rate (#920) acrescentou dois nomes. O contrato que este arquivo
 * trava: recusa por CAMPO INVÁLIDO ⇒ UMA repetição da mesma leitura sem os dois
 * nomes novos ⇒ a tabela carrega, a coluna fica "—" e a RECUSA DEIXA RASTRO:
 * log com o motivo cru da plataforma e ressalva visível na célula.
 *
 * O dublê é o instrumento, e o fail-first é explícito: sem a repetição, a
 * primeira resposta (erro 100) já encerra a leitura e não existe linha nenhuma
 * para a tela desenhar. Com ela, o segundo pedido não carrega `actions` nem
 * `inline_link_clicks` e a linha aparece — com "—" na décima primeira célula.
 *
 * A repetição também não pode ser SILENCIOSA: ela fecha a AÇÃO (a tela não
 * morre) e ABRE a informação — o motivo cru que a plataforma devolveu vai para
 * o log no momento da recusa, e a leitura carrega uma ressalva que a tabela
 * mostra no hover do "—". Sem os dois, número ausente e zero ficam idênticos na
 * tela, e aí a repetição troca um erro visível por um erro invisível.
 *
 * Sem Graph, sem token: tudo o que a plataforma diria está no dublê.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import { logger } from "@/lib/logger";
import {
  AVISO_DO_CONNECT_RATE_AUSENTE,
  lerInsights,
} from "@/lib/plataformas-de-anuncio/meta/insights";
import { montarTabelaDeCampanhas } from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";
import type { CampanhaCrua } from "@/lib/plataformas-de-anuncio/meta/insights";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A recusa real da Graph para um nome que ela não aceita: erro 100. */
function respostaDeCampoInvalido(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 33 },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** A leitura que dá certo SEM os dois campos novos — a resposta da repetição. */
function respostaSemConnectRate(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          campaign_id: "120254402954150350",
          campaign_name: "Cadastro: Agenda Cheia",
          spend: "364.63",
          impressions: "21281",
          reach: "13894",
          cpm: "17.13",
          ctr: "2.02",
          frequency: "1.53",
          cpc: "0.85",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A mesma linha, mas COM os dois campos do Connect rate — o caminho bom. */
function respostaComConnectRate(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          campaign_id: "120254402954150350",
          campaign_name: "Cadastro: Agenda Cheia",
          spend: "364.63",
          impressions: "21281",
          reach: "13894",
          cpm: "17.13",
          ctr: "2.02",
          frequency: "1.53",
          cpc: "0.85",
          inline_link_clicks: "250",
          actions: [{ action_type: "landing_page_view", value: "120" }],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function respostaDeTokenInvalido(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** Cada chamada consome a resposta seguinte; a última se repete se faltar. */
function duble(respostas: Response[]): string[] {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      const resposta = respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      if (!resposta) throw new Error("o dublê ficou sem resposta");
      return resposta;
    }),
  );
  return urls;
}

function camposDe(url: string): string[] {
  return (new URL(url).searchParams.get("fields") ?? "").split(",");
}

const CAMPANHA: CampanhaCrua = {
  id: "120254402954150350",
  name: "Cadastro: Agenda Cheia",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  objective: "OUTCOME_LEADS",
};

const PERIODO = ["2026-09-01", "2026-09-30"] as const;

describe("campo inválido na leitura de insights: repetição sem os dois nomes novos", () => {
  it("repete sem `actions`/`inline_link_clicks` e a tela carrega com “—” na coluna", async () => {
    const urls = duble([respostaDeCampoInvalido(), respostaSemConnectRate()]);
    const log = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const leitura = await lerInsights("token-de-teste", "act_1", ...PERIODO);

    if (!leitura.ok) throw new Error(`esperava leitura verde, veio ${leitura.falha}`);

    // O RASTRO da recusa — é ele que separa esta repetição de um silêncio: o
    // motivo CRU da plataforma vai para o log no momento em que ela acontece, e
    // é o que distingue "campo removido nesta versão" de "conta sem permissão".
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("repetindo sem os campos do Connect rate"),
      expect.objectContaining({ contexto: "insights", detalhe: "Invalid parameter" }),
    );

    // E a informação ABRE: a leitura carrega a ressalva. Sem ela, a coluna
    // vazia seria indistinguível de zero — erro invisível, que é pior.
    expect(leitura.aviso).toBe(AVISO_DO_CONNECT_RATE_AUSENTE);

    // Duas chamadas: a que carrega os nomes novos e a que abre mão deles.
    expect(urls).toHaveLength(2);
    expect(camposDe(urls[0]!)).toEqual(expect.arrayContaining(["actions", "inline_link_clicks"]));
    expect(camposDe(urls[1]!)).not.toContain("actions");
    expect(camposDe(urls[1]!)).not.toContain("inline_link_clicks");
    // A repetição não encolhe o resto: os campos de sempre continuam pedidos.
    expect(camposDe(urls[1]!)).toEqual(
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

    // A tabela do caminho ruim: as outras colunas de pé, a nova em "—".
    const linhas = montarTabelaDeCampanhas([CAMPANHA], leitura.dados);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.connectRate).toBeNull();
    expect(linhas[0]?.ctr).toBe(2.02);
    expect(linhas[0]?.gasto).toBe(364.63);

    render(
      <TabelaDeCampanhas
        linhas={linhas}
        moeda="BRL"
        avisos={[AVISO_DO_CONNECT_RATE_AUSENTE]}
      />,
    );
    const corpo = screen.getAllByRole("row")[1];
    if (!corpo) throw new Error("esperava a linha da campanha");
    const celulas = within(corpo).getAllByRole("cell");

    expect(celulas).toHaveLength(16);
    expect(celulas[11]?.textContent).toBe("—");
    expect(within(corpo).queryByText("0,00%")).toBeNull();
    // E o "—" DIZ por que está vazio: o hover leva a ressalva da leitura, que é
    // o que separa "a plataforma não devolveu" de "esta campanha mediu zero".
    expect(celulas[11]?.firstElementChild?.getAttribute("title")).toBe(
      AVISO_DO_CONNECT_RATE_AUSENTE,
    );
  });

  it("o caminho bom continua com UMA chamada, e ela leva os dois nomes", async () => {
    const urls = duble([
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);

    const leitura = await lerInsights("token-de-teste", "act_1", ...PERIODO);

    expect(leitura.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(camposDe(urls[0]!)).toEqual(expect.arrayContaining(["actions", "inline_link_clicks"]));
  });

  it("recusa que não é de campo — token — não gasta uma segunda chamada", async () => {
    const urls = duble([respostaDeTokenInvalido()]);

    const leitura = await lerInsights("token-de-teste", "act_1", ...PERIODO);

    if (leitura.ok) throw new Error("esperava a falha de token");
    expect(leitura.falha).toBe("token_invalido");
    expect(urls).toHaveLength(1);
  });

  it("se a repetição também for recusada, a falha sobe — a repetição não inventa sucesso", async () => {
    const urls = duble([respostaDeCampoInvalido(), respostaDeCampoInvalido()]);

    const leitura = await lerInsights("token-de-teste", "act_1", ...PERIODO);

    if (leitura.ok) throw new Error("esperava a falha de campo inválido");
    expect(leitura.falha).toBe("campo_invalido");
    expect(urls).toHaveLength(2);
  });

  it("no caminho bom não há ressalva, e a célula com número não ganha título", async () => {
    const urls = duble([respostaComConnectRate()]);

    const leitura = await lerInsights("token-de-teste", "act_1", ...PERIODO);

    if (!leitura.ok) throw new Error(`esperava leitura verde, veio ${leitura.falha}`);
    expect(urls).toHaveLength(1);
    // Sem recusa, sem ressalva: a tela não tem o que explicar.
    expect(leitura.aviso).toBeUndefined();

    const linhas = montarTabelaDeCampanhas([CAMPANHA], leitura.dados);
    // 120 visualizações da página ÷ 250 cliques no link = 48%.
    expect(linhas[0]?.connectRate).toBe(48);

    render(<TabelaDeCampanhas linhas={linhas} moeda="BRL" />);
    const corpo = screen.getAllByRole("row")[1];
    if (!corpo) throw new Error("esperava a linha da campanha");
    const celulas = within(corpo).getAllByRole("cell");

    expect(celulas[11]?.textContent).toBe("48,00%");
    // Medição NÃO leva o aviso do ausente: o título só existe quando FALTA, e é
    // isso que faz o hover ser sinal, e não decoração.
    expect(celulas[11]?.querySelector("[title]")).toBeNull();
  });
});
