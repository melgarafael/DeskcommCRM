/**
 * O dia do prazo é o mesmo em QUALQUER fuso — inclusive no da leitura a LESTE
 * de UTC, que hoje acerta por acaso.
 *
 * ═══ O QUE FALTAVA PROVAR (e por que este arquivo existe) ═══
 *
 * `tests/unit/lgpd-prazo-e-dia-civil.test.ts` prova a REGRA (o que a tela e o
 * e-mail devem mostrar a partir de `due_at`) e a LISTA de quem a obedece. O que
 * ela não prova é que a regra sobreviva a quem EXECUTA: `pnpm test:unit` é
 * `vitest run` sem `TZ` nenhum (ver `package.json`), então tudo roda no fuso da
 * máquina — UTC no CI, `America/Sao_Paulo` num notebook brasileiro.
 *
 * É uma régua dependente do ambiente disfarçada de régua. Se um dia a leitura
 * trocar os getters UTC pelos locais (`getFullYear()` no lugar de
 * `getUTCFullYear()`), o CI em UTC continua VERDE — o fuso local dele é o eixo
 * certo por acaso — e só quem roda a oeste de UTC vê o prazo andar um dia.
 * Exatamente o defeito do #2100, desta vez dentro da própria suíte.
 *
 * Este arquivo fixa o fuso ANTES de ler, nos dois extremos do mapa (a oeste e a
 * leste de UTC) e no próprio UTC, e afirma três coisas:
 *
 * 1. o processo realmente está no fuso pedido — canário, sem o qual nada aqui
 *    provaria nada;
 * 2. as TRÊS bordas do prazo (véspera, dia do prazo, dia seguinte) dão o MESMO
 *    valor nos três fusos;
 * 3. e os valores são os concretos esperados — porque "iguais entre si" também
 *    se alcança errando igual nos três.
 *
 * A borda da véspera é a da issue: `2026-10-05T00:30Z` são 21:30 de 04/10 em
 * São Paulo, e a lista não pode dizer "Vencido" ali.
 */

import { describe, expect, it } from "vitest";

import { computeRiskLevel, computeSlaBucket } from "@/lib/lgpd/balde-de-sla";
import { contagemDoPrazo, distanciaDoPrazo } from "@/lib/lgpd/contagem-do-prazo";
import {
  computeDueAt,
  diaDoPrazo,
  diasAtePrazo,
  diasDeAtraso,
  fimDoPrazo,
  horasAteOFimDoPrazo,
  prazoEmBr,
} from "@/lib/lgpd/sla";

/** Os dois extremos do mapa, e o eixo em que o motor conta. */
const FUSOS = ["America/Sao_Paulo", "UTC", "Africa/Luanda"] as const;

const TZ_ORIGINAL = process.env.TZ;

/**
 * Lê dentro de `fuso`, e devolve o processo como estava — sempre, inclusive
 * quando a leitura lança. Um `TZ` vazando para os testes seguintes do mesmo
 * worker seria um vermelho futuro sem culpado.
 */
function emFuso<T>(fuso: string, leitura: () => T): T {
  process.env.TZ = fuso;
  try {
    return leitura();
  } finally {
    if (TZ_ORIGINAL === undefined) delete process.env.TZ;
    else process.env.TZ = TZ_ORIGINAL;
  }
}

/** O dia de um instante no eixo de QUEM LÊ (`timeZone` explícito), não do processo. */
function diaNoFuso(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instante);
}

const RECEBIDO = "2026-09-14T12:00:00.000Z"; // segunda 2026-09-14, meio-dia UTC

/** As três bordas do prazo, em instantes UTC para não depender de fuso nenhum. */
const BORDAS = {
  /** 21:30 de 04/10 em São Paulo — a véspera, o "Vencido" prematuro da issue. */
  vespera: new Date("2026-10-05T00:30:00.000Z"),
  /** 09:00 de 05/10 em São Paulo — o dia do prazo, meio da manhã. */
  diaDoPrazoAgora: new Date("2026-10-05T12:00:00.000Z"),
  /** 09:00 de 06/10 em São Paulo — o primeiro dia em que há atraso. */
  diaSeguinte: new Date("2026-10-06T12:00:00.000Z"),
};

type Leitura = {
  dueCalculado: string;
  dia: string;
  rotulo: string;
  atraso: number;
  falta: number;
  fim: string | null;
  horas: number | null;
  balde: string;
  selo: string;
  colunaAdmin: string;
  colunaOrg: { label: string; urgent: boolean };
};

/**
 * Tudo o que as superfícies de `due_at` mostram, para UM `agora`, lido dentro
 * do fuso corrente do processo. `computeDueAt` entra de propósito: é o ESCRITOR
 * da coluna, e um escritor que contasse o dia no eixo local gravaria outro dia
 * para o mesmo recebimento.
 */
function leituraEm(agora: Date): Leitura {
  const prazo = computeDueAt(new Date(RECEBIDO), 15);
  const iso = prazo.toISOString();
  return {
    dueCalculado: iso,
    dia: diaDoPrazo(prazo) ?? "",
    rotulo: prazoEmBr(prazo) ?? "",
    atraso: diasDeAtraso(prazo, agora),
    falta: diasAtePrazo(prazo, agora),
    fim: fimDoPrazo(prazo)?.toISOString() ?? null,
    horas: horasAteOFimDoPrazo(prazo, agora),
    balde: computeSlaBucket(iso, RECEBIDO, agora),
    selo: computeRiskLevel(iso, RECEBIDO, agora),
    colunaAdmin: contagemDoPrazo(iso, "processing", (texto) => texto, agora),
    colunaOrg: distanciaDoPrazo(iso, (texto) => texto, agora),
  };
}

/**
 * As três bordas, POR NOME e não em array.
 *
 * Nomeadas porque o `tsc` do repositório tem `noUncheckedIndexedAccess`: um
 * array destructurado devolve `Leitura | undefined`, e as 26 asserções logo
 * abaixo ficariam todas `possibly undefined`. O objeto devolve o tipo exato, e
 * a ordem das chaves continua estável — é ela que o caso "dão o MESMO valor"
 * compara por `JSON.stringify`.
 */
function asTresBordas(): {
  vespera: Leitura;
  diaDoPrazoAgora: Leitura;
  diaSeguinte: Leitura;
} {
  return {
    vespera: leituraEm(BORDAS.vespera),
    diaDoPrazoAgora: leituraEm(BORDAS.diaDoPrazoAgora),
    diaSeguinte: leituraEm(BORDAS.diaSeguinte),
  };
}

describe("a leitura do prazo não muda com o fuso do processo", () => {
  it("o canário: o processo realmente está no fuso pedido, senão nada aqui prova nada", () => {
    // `process.env.TZ` só vale se o Node o respeitar em tempo de execução. Se
    // um dia ele passar a ignorar a troca, os testes de baixo continuariam
    // passando — e é exatamente esse verde-que-não-prova-nada que este canário
    // existe para derrubar.
    const meiaNoiteUtc = new Date("2026-10-05T00:00:00.000Z");
    expect(emFuso("America/Sao_Paulo", () => meiaNoiteUtc.getHours())).toBe(21);
    expect(emFuso("UTC", () => meiaNoiteUtc.getHours())).toBe(0);
    expect(emFuso("Africa/Luanda", () => meiaNoiteUtc.getHours())).toBe(1);
  });

  it("as três bordas dão o MESMO valor a oeste, no UTC e a leste de UTC", () => {
    const porFuso = FUSOS.map((fuso) => emFuso(fuso, asTresBordas));
    expect(new Set(porFuso.map((lidas) => JSON.stringify(lidas))).size).toBe(1);
  });

  it("e os valores são os concretos esperados (igual entre si não basta: errar igual nos três passaria)", () => {
    const { vespera, diaDoPrazoAgora, diaSeguinte } = emFuso(
      "America/Sao_Paulo",
      asTresBordas,
    );

    // O escritor grava o mesmo dia em qualquer fuso.
    expect(vespera.dueCalculado).toBe("2026-10-05T00:00:00.000Z");
    expect(vespera.dia).toBe("2026-10-05");
    expect(vespera.rotulo).toBe("05/10/2026");
    expect(vespera.fim).toBe("2026-10-06T00:00:00.000Z");

    // Véspera às 21:30 de São Paulo: o prazo é amanhã, e nada diz "vencido".
    expect(vespera.atraso).toBe(0);
    expect(vespera.falta).toBe(0);
    expect(vespera.horas).toBe(23.5);
    expect(vespera.balde).toBe("critical");
    expect(vespera.selo).toBe("at_risk");
    expect(vespera.colunaAdmin).toBe("23h restantes");
    expect(vespera.colunaOrg).toEqual({ label: "em 23h", urgent: true });

    // No dia do prazo, meio da manhã: continua sem atraso, e a contagem é do dia.
    expect(diaDoPrazoAgora.atraso).toBe(0);
    expect(diaDoPrazoAgora.falta).toBe(0);
    expect(diaDoPrazoAgora.horas).toBe(12);
    expect(diaDoPrazoAgora.balde).toBe("critical");
    expect(diaDoPrazoAgora.selo).toBe("at_risk");
    expect(diaDoPrazoAgora.colunaAdmin).toBe("12h restantes");
    expect(diaDoPrazoAgora.colunaOrg).toEqual({ label: "em 12h", urgent: true });

    // No dia seguinte: aí sim vencido, com um dia inteiro de atraso.
    expect(diaSeguinte.atraso).toBe(1);
    expect(diaSeguinte.falta).toBe(-1);
    expect(diaSeguinte.horas).toBe(-12);
    expect(diaSeguinte.balde).toBe("overdue");
    expect(diaSeguinte.selo).toBe("expired");
    expect(diaSeguinte.colunaAdmin).toBe("12h em atraso");
    expect(diaSeguinte.colunaOrg).toEqual({ label: "atrasado hoje", urgent: true });
  });
});

describe("o instante é ambíguo por fuso, o dia da coluna não", () => {
  it("a oeste de UTC o instante cai no dia anterior; a leste, no mesmo dia — e o helper devolve o mesmo dia nos dois", () => {
    const prazo = computeDueAt(new Date(RECEBIDO), 15);
    // O defeito medido na issue: o mesmo instante redesenhado no eixo do leitor
    // brasileiro é o dia ANTERIOR ao que o motor contou.
    expect(diaNoFuso(prazo, "America/Sao_Paulo")).toBe("2026-10-04");
    // A leste (Angola, Lisboa) a meia-noite UTC ainda cai no mesmo dia — o sinal
    // "acerta por acaso", e é por isso que o defeito não aparecia lá.
    expect(diaNoFuso(prazo, "Africa/Luanda")).toBe("2026-10-05");
    // Em QUALQUER dos dois, o helper devolve o dia que a coluna guarda.
    for (const fuso of FUSOS) {
      expect(emFuso(fuso, () => diaDoPrazo(prazo))).toBe("2026-10-05");
      expect(emFuso(fuso, () => prazoEmBr(prazo))).toBe("05/10/2026");
    }
  });
});
