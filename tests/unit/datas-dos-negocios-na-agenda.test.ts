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
  ROTULO_DO_MEIO,
  TETO_DE_DIAS_DO_MEIO_POR_NEGOCIO,
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

  it("com segundo campo, o dia da ida, os dias do meio e o dia do retorno aparecem, cada um com seu rótulo", () => {
    const itens = itensDaCamada([negocio()], { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" }, JANELA);

    expect(itens.map((i) => [i.dia, i.rotulos.join("+")])).toEqual([
      ["2026-03-10", "Embarque"],
      // #3221: o intervalo inteiro, e não só as duas pontas.
      ["2026-03-11", ROTULO_DO_MEIO],
      ["2026-03-12", ROTULO_DO_MEIO],
      ["2026-03-13", ROTULO_DO_MEIO],
      ["2026-03-14", ROTULO_DO_MEIO],
      ["2026-03-15", "Retorno"],
    ]);
  });

  // ─── Dias do MEIO (#3221): a regra 5 do módulo mudou nesta fatia ──────────
  //
  // Antes, só as DATAS declaradas pelo funil entravam. Agora o intervalo
  // inteiro aparece, com um rótulo próprio nos dias do meio — é o que deixa a
  // equipe ver quem está em viagem no dia 12, e não só quem embarca e volta.
  it("10 a 14, janela 01 a 31: o intervalo inteiro entra, e 11 a 13 levam o rótulo do meio", () => {
    const viagem = negocio({
      id: "viagem",
      campos: { data_inicio: "2026-03-10", data_fim: "2026-03-14" },
    });

    const itens = itensDaCamada(
      [viagem],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      JANELA,
    );

    expect(itens.map((i) => i.dia)).toEqual([
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
    ]);
    expect(itens.map((i) => i.rotulos)).toEqual([
      ["Embarque"],
      [ROTULO_DO_MEIO],
      [ROTULO_DO_MEIO],
      [ROTULO_DO_MEIO],
      ["Retorno"],
    ]);
  });

  it("a janela recorta o meio: 11 a 13 mostra 11, 12 e 13, sem as pontas de fora", () => {
    const viagem = negocio({
      id: "viagem",
      campos: { data_inicio: "2026-03-10", data_fim: "2026-03-14" },
    });

    const itens = itensDaCamada(
      [viagem],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      { de: "2026-03-11", ate: "2026-03-13" },
    );

    expect(itens.map((i) => [i.dia, i.rotulos[0]])).toEqual([
      ["2026-03-11", ROTULO_DO_MEIO],
      ["2026-03-12", ROTULO_DO_MEIO],
      ["2026-03-13", ROTULO_DO_MEIO],
    ]);
  });

  it("intervalo inteiro fora da janela não gera item do meio", () => {
    const viagem = negocio({
      id: "viagem",
      campos: { data_inicio: "2026-03-10", data_fim: "2026-03-14" },
    });

    const itens = itensDaCamada(
      [viagem],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      { de: "2026-04-01", ate: "2026-04-30" },
    );

    expect(itens).toEqual([]);
  });

  it("fim no MESMO dia continua UM item com os dois rótulos — e nenhum dia do meio", () => {
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
    expect(itens.some((i) => i.rotulos.includes(ROTULO_DO_MEIO))).toBe(false);
  });

  it("fim ANTES do início continua sem fim e sem meio: só o dia do embarque", () => {
    const invertido = negocio({
      id: "invertido",
      campos: { data_inicio: "2026-03-20", data_fim: "2026-03-02" },
    });

    const itens = itensDaCamada(
      [invertido],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      JANELA,
    );

    expect(itens.map((i) => [i.dia, i.rotulos])).toEqual([["2026-03-20", ["Embarque"]]]);
  });

  it("o teto de dias por negócio é explícito: intervalo absurdo para de emitir, não explode", () => {
    expect(TETO_DE_DIAS_DO_MEIO_POR_NEGOCIO).toBe(366);

    const absurdo = negocio({
      id: "absurdo",
      campos: { data_inicio: "1990-01-01", data_fim: "2030-12-31" },
    });

    const inicio = performance.now();
    const itens = itensDaCamada(
      [absurdo],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      { de: "1990-01-01", ate: "2030-12-31" },
    );
    const decorrido = performance.now() - inicio;

    const meio = itens.filter((i) => i.rotulos.includes(ROTULO_DO_MEIO));
    expect(meio).toHaveLength(TETO_DE_DIAS_DO_MEIO_POR_NEGOCIO);
    // O que o teto NÃO muda: as pontas continuam lá, uma vez cada.
    expect(itens.filter((i) => i.dia === "1990-01-01")).toHaveLength(1);
    expect(itens.filter((i) => i.dia === "2030-12-31")).toHaveLength(1);
    // E o corte é uma parada, não uma varredura de 40 anos em laço.
    expect(decorrido).toBeLessThan(1000);
  });

  it("nenhum negócio aparece duas vezes no mesmo dia com o mesmo rótulo", () => {
    const itens = itensDaCamada(
      [
        negocio({ id: "viagem", campos: { data_inicio: "2026-03-10", data_fim: "2026-03-14" } }),
        negocio({ id: "ponto", campos: { data_inicio: "2026-03-12" } }),
        negocio({ id: "invertido", campos: { data_inicio: "2026-03-20", data_fim: "2026-03-02" } }),
        negocio({ id: "bate-volta", campos: { data_inicio: "2026-03-10", data_fim: "2026-03-10" } }),
      ],
      { ...ESCOLHA, campoFim: "data_fim", rotuloFim: "Retorno" },
      JANELA,
    );

    const chaves = itens.map((i) => `${i.negocio.id}|${i.dia}`);
    expect(new Set(chaves).size).toBe(chaves.length);

    const rotulosPorNegocioEDia = itens.map(
      (i) => `${i.negocio.id}|${i.dia}|${i.rotulos.join("+")}`,
    );
    expect(new Set(rotulosPorNegocioEDia).size).toBe(rotulosPorNegocioEDia.length);
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
