import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lerCampanhas,
  type CampanhaCrua,
  type LinhaDeInsightCrua,
} from "@/lib/plataformas-de-anuncio/meta/insights";
import {
  montarTabelaDeCampanhas,
  ORDEM_PADRAO,
  ordenarCampanhas,
} from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

/**
 * A ORDEM DA TABELA DE CAMPANHAS (issue #3911): mais recente em primeiro.
 *
 * ─── O defeito que este arquivo trava ───────────────────────────────────────
 *
 * A rota devolvia as linhas na ordem em que a plataforma manda — e a plataforma
 * manda das mais antigas para as mais novas. Numa conta com histórico, quem abre
 * a aba vê campanha pausada de dois anos atrás no topo e tem de rolar a lista
 * inteira para achar a que está rodando agora, que é exatamente o que ele veio
 * ver.
 *
 * ─── Por que a asserção é de ORDEM, e não de conteúdo ───────────────────────
 *
 * Conteúdo já tem teste (`meta-ads-tabela-de-campanhas`). O que faltava era a
 * sequência: os mesmos ids, na ordem errada, passavam em tudo. Por isso cada
 * caso compara a LISTA de ids — a asserção falha com a ordem da plataforma e
 * passa com a ordenação.
 *
 * Os `created_time`/`start_time` abaixo estão no formato que a Graph API devolve
 * (`2026-08-14T09:31:10+0000`), com o offset sem dois-pontos — que `Date.parse`
 * aceita e uma comparação de string ordenaria errado.
 */

/** As três campanhas como a plataforma devolve: das mais antigas para as novas. */
const CAMPANHAS_NA_ORDEM_DA_API: CampanhaCrua[] = [
  {
    id: "antiga",
    name: "Captação: janeiro",
    status: "PAUSED",
    effective_status: "PAUSED",
    created_time: "2024-01-09T11:00:00+0000",
    start_time: "2024-01-10T11:00:00+0000",
  },
  {
    id: "meio",
    name: "Cadastro: Agenda Cheia",
    status: "PAUSED",
    effective_status: "PAUSED",
    created_time: "2026-03-02T08:15:00+0000",
    start_time: "2026-03-03T08:15:00+0000",
  },
  {
    id: "nova",
    name: "Engajamento: Astra Mídia",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    created_time: "2026-08-14T09:31:10+0000",
    start_time: "2026-08-15T09:31:10+0000",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function ids(linhas: { campanhaId: string }[]): string[] {
  return linhas.map((linha) => linha.campanhaId);
}

/** Uma linha pronta, para exercitar só a ordenação (sem cruzar nada). */
function linha(ajustes: Partial<LinhaDeCampanha> = {}): LinhaDeCampanha {
  return {
    campanhaId: "x",
    nome: "x",
    status: "ACTIVE",
    veiculacao: "ACTIVE",
    objetivo: "OUTCOME_LEADS",
    criadaEm: "2026-01-01T00:00:00+0000",
    iniciadaEm: "2026-01-02T00:00:00+0000",
    resultado: { valor: null, custoPorResultado: null, indicador: null },
    gasto: null,
    impressoes: null,
    alcance: null,
    cpm: null,
    ctr: null,
    connectRate: null,
    frequencia: null,
    cpc: null,
    hookRate: null,
    thruPlays: null,
    ...ajustes,
  };
}

describe("ordem padrão: da campanha mais recente para a mais antiga", () => {
  it("inverte a ordem da plataforma em vez de repassá-la", () => {
    const linhas = montarTabelaDeCampanhas(CAMPANHAS_NA_ORDEM_DA_API, []);
    // O defeito: antes saía ["antiga", "meio", "nova"] — a ordem da API, com a
    // campanha que está rodando no FIM da tabela.
    expect(ids(linhas)).toEqual(["nova", "meio", "antiga"]);
  });

  it("é a ordem com que a tabela abre quando ninguém escolheu nada", () => {
    expect(ORDEM_PADRAO).toBe("mais_recentes");
    // Chamar sem critério tem de dar exatamente o que `montarTabela` devolve.
    const montadas = montarTabelaDeCampanhas(CAMPANHAS_NA_ORDEM_DA_API, []);
    expect(ids(ordenarCampanhas(montadas))).toEqual(ids(montadas));
  });

  it("desempata por `start_time` quando o `created_time` é o mesmo", () => {
    const mesmoDia: CampanhaCrua[] = [
      {
        id: "comecou-antes",
        name: "B",
        created_time: "2026-05-01T10:00:00+0000",
        start_time: "2026-05-20T10:00:00+0000",
      },
      {
        id: "comecou-depois",
        name: "A",
        created_time: "2026-05-01T10:00:00+0000",
        start_time: "2026-06-01T10:00:00+0000",
      },
    ];
    expect(ids(montarTabelaDeCampanhas(mesmoDia, []))).toEqual([
      "comecou-depois",
      "comecou-antes",
    ]);
  });

  it("campanha sem `created_time` nenhum vai para o FIM, nunca para o topo", () => {
    // Insight órfão (campanha apagada entre as duas chamadas) não tem cadastro,
    // logo não tem data. Tratar `null` como 1970 a colocaria em primeiro — e a
    // linha de que menos se sabe seria a primeira que se vê.
    const semData: LinhaDeInsightCrua = {
      campaign_id: "orfa",
      campaign_name: "Campanha apagada",
      spend: "50.00",
    };
    const linhas = montarTabelaDeCampanhas(CAMPANHAS_NA_ORDEM_DA_API, [semData]);
    expect(ids(linhas)).toEqual(["nova", "meio", "antiga", "orfa"]);
  });

  it("sem `created_time`, ainda ordena pelo `start_time` quando ele veio", () => {
    const semCriacao: CampanhaCrua[] = [
      { id: "antiga", name: "A", start_time: "2025-01-05T10:00:00+0000" },
      { id: "nova", name: "B", start_time: "2026-07-05T10:00:00+0000" },
    ];
    expect(ids(montarTabelaDeCampanhas(semCriacao, []))).toEqual(["nova", "antiga"]);
  });

  it("sem data em ninguém, preserva a ordem em que as linhas foram montadas", () => {
    // Conta cujo payload venha sem os dois campos: ordenar não pode embaralhar
    // nada. A ordem de montagem (insights primeiro) é o desempate estável.
    const semDatas = CAMPANHAS_NA_ORDEM_DA_API.map((c) => ({
      ...c,
      created_time: undefined,
      start_time: undefined,
    }));
    expect(ids(montarTabelaDeCampanhas(semDatas, []))).toEqual(["antiga", "meio", "nova"]);
  });

  it("não muda o array recebido", () => {
    const original = montarTabelaDeCampanhas(CAMPANHAS_NA_ORDEM_DA_API, []);
    const copia = ids(original);
    ordenarCampanhas(original, "mais_antigas");
    expect(ids(original)).toEqual(copia);
  });
});

describe("as outras ordens que a tela oferece", () => {
  const montadas = (): LinhaDeCampanha[] => montarTabelaDeCampanhas(CAMPANHAS_NA_ORDEM_DA_API, []);

  it("`mais_antigas` inverte sem jogar as linhas sem data para o topo", () => {
    const comOrfa = ordenarCampanhas([
      ...montadas(),
      linha({ campanhaId: "orfa", criadaEm: null, iniciadaEm: null }),
    ]);
    expect(ids(ordenarCampanhas(comOrfa, "mais_antigas"))).toEqual([
      "antiga",
      "meio",
      "nova",
      "orfa",
    ]);
  });

  it("`status` põe quem está entregando primeiro, e dentro do grupo o mais recente", () => {
    const linhas = [
      linha({ campanhaId: "pausada-nova", veiculacao: "PAUSED", criadaEm: "2026-08-01T00:00:00+0000" }),
      linha({ campanhaId: "ativa-velha", veiculacao: "ACTIVE", criadaEm: "2024-01-01T00:00:00+0000" }),
      // Status ACTIVE no cadastro com entrega barrada pelo pai: não está
      // entregando, então NÃO entra no grupo das ativas.
      linha({
        campanhaId: "campanha-pausada",
        status: "ACTIVE",
        veiculacao: "CAMPAIGN_PAUSED",
        criadaEm: "2026-07-01T00:00:00+0000",
      }),
      linha({ campanhaId: "sem-cadastro", status: null, veiculacao: null, criadaEm: null, iniciadaEm: null }),
      linha({ campanhaId: "ativa-nova", veiculacao: "ACTIVE", criadaEm: "2026-08-20T00:00:00+0000" }),
    ];
    expect(ids(ordenarCampanhas(linhas, "status"))).toEqual([
      "ativa-nova",
      "ativa-velha",
      "pausada-nova",
      "campanha-pausada",
      "sem-cadastro",
    ]);
  });

  it("ordem desconhecida cai na padrão em vez de devolver a ordem de entrada", () => {
    // O critério vem de um `select`, mas `ordenarCampanhas` é público: um valor
    // inválido não pode virar "ordem nenhuma" em silêncio.
    const criterioInvalido = "gasto" as unknown as "mais_recentes";
    expect(ids(ordenarCampanhas(montadas(), criterioInvalido))).toEqual(["nova", "meio", "antiga"]);
  });
});

describe("a data vem do pedido de campanhas", () => {
  it("pede `created_time` e `start_time` na MESMA leitura de campanhas", async () => {
    // Sem estes dois nomes no `fields`, a tabela volta sem data nenhuma e cai
    // na ordem da plataforma — o defeito de novo, em silêncio. Por isso o
    // pedido é asserção, e não detalhe de implementação.
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "1",
                name: "Engajamento: Astra Mídia",
                status: "ACTIVE",
                effective_status: "ACTIVE",
                created_time: "2026-08-14T09:31:10+0000",
                start_time: "2026-08-15T09:31:10+0000",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const leitura = await lerCampanhas("token-de-teste", "act_1");

    const pedido = urls[0] ?? "";
    expect(pedido).toContain("created_time");
    expect(pedido).toContain("start_time");
    // Uma leitura só: os dois campos pegam carona na chamada que já existia.
    expect(urls).toHaveLength(1);

    if (!leitura.ok) throw new Error(`leitura falhou: ${leitura.detalhe}`);
    const [campanha] = leitura.dados;
    if (!campanha) throw new Error("esperava uma campanha");
    expect(campanha.created_time).toBe("2026-08-14T09:31:10+0000");

    // E a data chega na linha da tabela, que é onde a ordenação a usa.
    const [linhaMontada] = montarTabelaDeCampanhas(leitura.dados, []);
    expect(linhaMontada?.criadaEm).toBe("2026-08-14T09:31:10+0000");
    expect(linhaMontada?.iniciadaEm).toBe("2026-08-15T09:31:10+0000");
  });
});
