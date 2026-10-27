/**
 * A CAMADA "DATAS DOS NEGÓCIOS" NA AGENDA (#3221) — a régua de quem entra em que dia.
 *
 * O que este teste protege, e por que ele é de MÓDULO PURO:
 *
 * `itensDaCamada` decide QUEM APARECE EM QUE DIA. É a promessa da issue inteira
 * ("quem embarca hoje, quem volta amanhã"), e a única prova dela não pode ser um
 * render de jsdom: a grade da Agenda é grande, e um teste de tela passaria a
 * depender de a grade inteira montar para dizer que um negócio caiu no dia certo.
 *
 * As quatro réguas cobradas pela entrega:
 *   1. negócio com data aparece no dia certo;
 *   2. negócio SEM data não aparece em dia nenhum (nem em "hoje" por engano);
 *   3. `YYYY-MM-DD` não desliza um dia para trás em `America/Sao_Paulo`;
 *   4. o rótulo diz DE QUE DATA se trata ("Embarque", "Retorno"), nunca "data do
 *      negócio" — e vem do campo do funil, não de uma const no código.
 */
// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  diaDoCampo,
  funisComCamposDeData,
  itensDaCamada,
  type NegocioComDatas,
} from "@/lib/agenda/datas-dos-negocios";

const FUNIL = "funil-viagens";
const ETAPA = "Embarque confirmado";

/** Um negócio da agência, com os campos de data que o teste precisa. */
function negocio(sobrescreve: Partial<NegocioComDatas> = {}): NegocioComDatas {
  return {
    id: "lead-1",
    titulo: "Família Prado — Gramado",
    funilId: FUNIL,
    funilNome: "Viagens",
    etapaNome: ETAPA,
    campos: { data_inicio: "2026-03-10", data_fim: "2026-03-15" },
    ...sobrescreve,
  };
}

const ESCOLHA = { campo: "data_inicio", rotulo: "Embarque" };
const JANELA = { de: "2026-03-01", ate: "2026-03-31" };

describe("diaDoCampo — a régua de data que a Agenda herda do Calendário do funil", () => {
  it("lê YYYY-MM-DD por pedaços e devolve o MESMO dia", () => {
    expect(diaDoCampo("2026-03-10")).toBe("2026-03-10");
    // Primeiro de janeiro é o caso que mais dói se passar por UTC: 01/01 00:00Z
    // é 31/12 no fuso de São Paulo.
    expect(diaDoCampo("2026-01-01")).toBe("2026-01-01");
  });

  it("recusa o que não é data — o negócio sem data não tem dia", () => {
    expect(diaDoCampo("")).toBeNull();
    expect(diaDoCampo(null)).toBeNull();
    expect(diaDoCampo(undefined)).toBeNull();
    expect(diaDoCampo(42)).toBeNull();
    expect(diaDoCampo("2026-02-30")).toBeNull();
    // Mês 13 não existe; e texto livre não é data. (`10/03/2026` NÃO entra aqui:
    // o `Date` do JS o lê como 3 de outubro em MM/DD — é o fallback documentado
    // de `diaDe` para data cheia, e não lixo.)
    expect(diaDoCampo("2026-13-01")).toBeNull();
    expect(diaDoCampo("sem data")).toBeNull();
  });

  it("data cheia (com hora) vale pelo dia LOCAL do carimbo", () => {
    const dia = diaDoCampo("2026-03-10T14:30:00-03:00");
    expect(dia).toBe("2026-03-10");
  });

  /**
   * O TESTE DE FUSO — e a prova de que ele mede o fuso que diz medir.
   *
   * `process.env.TZ` é trocado ANTES do import dinâmico do módulo, e a primeira
   * asserção confere que o ambiente É `America/Sao_Paulo` (offset de 180 min).
   * Sem essa conferência, o teste passaria em qualquer máquina sem provar nada.
   *
   * E ele mostra o caminho ERRADO ao lado: `new Date("2026-03-10")` é meia-noite
   * em UTC, e ali o dia local é 9. É exatamente o defeito que a camada evita ao
   * ler o valor por pedaços — se alguém "simplificar" `diaDe` para `new Date()`,
   * este par vira a evidência do deslize.
   */
  it("não desliza um dia para trás em America/Sao_Paulo", async () => {
    const anterior = process.env.TZ;
    process.env.TZ = "America/Sao_Paulo";
    try {
      expect(new Date(2026, 2, 10).getTimezoneOffset()).toBe(180);

      expect(diaDoCampo("2026-03-10")).toBe("2026-03-10");
      expect(new Date("2026-03-10").getDate()).toBe(9);

      const itens = itensDaCamada([negocio()], ESCOLHA, JANELA);
      expect(itens.map((i) => i.dia)).toEqual(["2026-03-10"]);
    } finally {
      process.env.TZ = anterior;
    }
  });
});

describe("funisComCamposDeData — de onde saem os campos oferecidos", () => {
  it("só campos de data do NEGÓCIO entram na escolha", () => {
    const funis = funisComCamposDeData([
      {
        id: FUNIL,
        nome: "Viagens",
        settings: {
          fields: [
            { key: "data_inicio", label: "Embarque", type: "date" },
            { key: "data_fim", label: "Retorno", type: "date" },
            { key: "observacoes", label: "Observações", type: "textarea" },
            // Campo do CONTATO com o mesmo nome: o valor mora em
            // `contacts.custom_fields`, e a Agenda leria vazio para sempre.
            { key: "aniversario", label: "Aniversário", type: "date", escopo: "contato" },
          ],
        },
      },
    ]);

    expect(funis).toHaveLength(1);
    expect(funis[0]!.campos).toEqual([
      { key: "data_inicio", label: "Embarque" },
      { key: "data_fim", label: "Retorno" },
    ]);
  });

  it("funil sem campo de data não é oferecido — escolhê-lo daria grade vazia sem motivo", () => {
    const funis = funisComCamposDeData([
      { id: "a", nome: "Sem datas", settings: { fields: [{ key: "obs", label: "Obs", type: "text" }] } },
      { id: "b", nome: "Sem settings", settings: null },
      { id: "c", nome: "Com data", settings: { fields: [{ key: "d", label: "Embarque", type: "date" }] } },
    ]);
    expect(funis.map((f) => f.id)).toEqual(["c"]);
  });
});

describe("itensDaCamada — quem entra em que dia", () => {
  it("negócio com data aparece no dia certo, com o rótulo do campo", () => {
    const itens = itensDaCamada([negocio()], ESCOLHA, JANELA);

    expect(itens).toHaveLength(1);
    expect(itens[0]!.dia).toBe("2026-03-10");
    expect(itens[0]!.rotulos).toEqual(["Embarque"]);
    expect(itens[0]!.negocio.titulo).toBe("Família Prado — Gramado");
    // O funil e a etapa viajam junto: a linha da camada diz de onde vem o dado.
    expect(itens[0]!.negocio.funilNome).toBe("Viagens");
    expect(itens[0]!.negocio.etapaNome).toBe(ETAPA);
    // O `custom_fields` NÃO vaza para o item: a camada é uma linha de agenda,
    // não uma cópia do negócio.
    expect(itens[0]!.negocio).not.toHaveProperty("campos");
  });

  it("negócio SEM data não aparece em dia nenhum", () => {
    const semData = negocio({ id: "lead-sem-data", campos: {} });
    const vazio = negocio({ id: "lead-vazio", campos: { data_inicio: "" } });
    const lixo = negocio({ id: "lead-lixo", campos: { data_inicio: "sem data" } });

    expect(itensDaCamada([semData, vazio, lixo], ESCOLHA, JANELA)).toEqual([]);
  });

  it("fora da janela não aparece — e a janela é inclusiva nas duas pontas", () => {
    const antes = negocio({ id: "antes", campos: { data_inicio: "2026-02-28" } });
    const primeiroDia = negocio({ id: "primeiro", campos: { data_inicio: "2026-03-01" } });
    const ultimoDia = negocio({ id: "ultimo", campos: { data_inicio: "2026-03-31" } });
    const depois = negocio({ id: "depois", campos: { data_inicio: "2026-04-01" } });

    const dias = itensDaCamada([antes, primeiroDia, ultimoDia, depois], ESCOLHA, JANELA).map(
      (i) => i.negocio.id,
    );
    expect(dias).toEqual(["primeiro", "ultimo"]);
  });

  it("com segundo campo, o retorno aparece no dia do retorno com o rótulo dele", () => {
    const itens = itensDaCamada([negocio()], { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" }, JANELA);

    expect(itens.map((i) => [i.dia, i.rotulos.join("+")])).toEqual([
      ["2026-03-10", "Embarque"],
      ["2026-03-15", "Retorno"],
    ]);
  });

  it("os dias do MEIO do intervalo não entram: a camada marca datas, não ocupação", () => {
    const itens = itensDaCamada([negocio()], { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" }, JANELA);
    expect(itens.map((i) => i.dia)).not.toContain("2026-03-12");
  });

  it("fim no MESMO dia é UMA ocorrência com os dois rótulos (decisão (b), default conservador)", () => {
    const idaEvolta = negocio({
      id: "bate-volta",
      campos: { data_inicio: "2026-03-10", data_fim: "2026-03-10" },
    });

    const itens = itensDaCamada(
      [idaEvolta],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      JANELA,
    );

    expect(itens).toHaveLength(1);
    expect(itens[0]!.rotulos).toEqual(["Embarque", "Retorno"]);
  });

  it("fim ANTES do início é dado errado: vale só o dia do embarque", () => {
    const invertido = negocio({
      id: "invertido",
      campos: { data_inicio: "2026-03-20", data_fim: "2026-03-02" },
    });

    const itens = itensDaCamada(
      [invertido],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      JANELA,
    );

    expect(itens.map((i) => i.dia)).toEqual(["2026-03-20"]);
  });

  it("o mesmo campo nos dois seletores não duplica o item", () => {
    const itens = itensDaCamada(
      [negocio()],
      { ...ESCOLHA, campoFim: "data_inicio", rotuloFim: "Embarque" },
      JANELA,
    );
    expect(itens).toHaveLength(1);
    expect(itens[0]!.rotulos).toEqual(["Embarque"]);
  });

  it("negócio sem o SEGUNDO campo aparece só no dia do primeiro", () => {
    const semVolta = negocio({ id: "sem-volta", campos: { data_inicio: "2026-03-10" } });
    const itens = itensDaCamada(
      [semVolta],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      JANELA,
    );
    expect(itens.map((i) => i.dia)).toEqual(["2026-03-10"]);
  });

  it("ordem estável: dia, depois título, depois id", () => {
    const itens = itensDaCamada(
      [
        negocio({ id: "b", titulo: "Beta", campos: { data_inicio: "2026-03-11" } }),
        negocio({ id: "z", titulo: "Alfa", campos: { data_inicio: "2026-03-11" } }),
        negocio({ id: "a", titulo: "Alfa", campos: { data_inicio: "2026-03-11" } }),
        negocio({ id: "c", titulo: "Gama", campos: { data_inicio: "2026-03-10" } }),
      ],
      ESCOLHA,
      JANELA,
    );
    expect(itens.map((i) => i.negocio.id)).toEqual(["c", "a", "z", "b"]);
  });
});
