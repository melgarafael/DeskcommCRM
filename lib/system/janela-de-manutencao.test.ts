/**
 * A JANELA DE MANUTENÇÃO LIDA PELO APP (#4334, #4504).
 *
 * Este arquivo é o espelho em TypeScript de `janela_normalizada` e
 * `janela_contem` (`hostgator-setup-kit/_common.sh`), e a régua aqui é a MESMA
 * daquele shell: cinco campos cron, os três últimos em `*`, valor recusado =
 * janela ABERTA. Um teste que afrouxasse isso deixaria a rota fechando (ou não
 * fechando) runs por um motivo que o `agent.sh` não reconhece.
 *
 * TEMPO E FUSO. Os instantes são escritos com o deslocamento explícito
 * (`-03:00`, o do host que roda o `agent.sh`), nunca com
 * `new Date(ano, mês, dia, hora, min)` — aquele construtor lê o fuso da
 * MÁQUINA, e o mesmo teste passaria aqui (VPS em -03) e falharia no CI (UTC).
 * É exatamente a confusão que o #4504 conserta: a janela é lida no fuso
 * declarado (`America/Sao_Paulo` por padrão, `SYSTEM_UPDATE_WINDOW_TZ` para
 * declarar outro), e o fuso do processo deixa de importar.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  FUSO_PADRAO_DA_JANELA,
  fusoDaJanela,
  horaEMinutoNoFuso,
  janelaContem,
  normalizarJanela,
  primeiraOportunidade,
} from "./janela-de-manutencao";

/** Um instante do relógio de parede do host (`-03:00`), sem depender do fuso da máquina. */
const emSaoPaulo = (isoLocal: string) => new Date(`${isoLocal}-03:00`);

describe("normalizarJanela", () => {
  it("aceita os cinco campos do cron, com um espaço entre eles", () => {
    expect(normalizarJanela("*/5 2-5 * * *")).toBe("*/5 2-5 * * *");
    expect(normalizarJanela("  */5\t2-5  *  * *  ")).toBe("*/5 2-5 * * *");
    expect(normalizarJanela("0,30 0,12 * * *")).toBe("0,30 0,12 * * *");
  });

  it("recusa o formato de faixa de horário — que é o que a issue propunha", () => {
    // `SYSTEM_UPDATE_WINDOW="02:00-05:00"` é a forma que a issue escreveu. O
    // shell recusa (não é cron), e é essa recusa que precisa chegar ao app: se
    // aqui fosse aceita, o app fecharia runs como abandonados com base numa
    // janela que o `agent.sh` nunca abriria.
    expect(normalizarJanela("02:00-05:00")).toBeNull();
    expect(normalizarJanela("2-5")).toBeNull();
  });

  it("recusa vazio, ausente e quebra de linha", () => {
    expect(normalizarJanela("")).toBeNull();
    expect(normalizarJanela("   ")).toBeNull();
    expect(normalizarJanela(null)).toBeNull();
    expect(normalizarJanela(undefined)).toBeNull();
    expect(normalizarJanela("*/5 2-5 * *\n*")).toBeNull();
  });

  it("recusa minuto e hora fora do campo", () => {
    expect(normalizarJanela("60 2-5 * * *")).toBeNull();
    expect(normalizarJanela("*/5 24 * * *")).toBeNull();
    expect(normalizarJanela("*/5 5-2 * * *")).toBeNull();
    expect(normalizarJanela("*/0 2-5 * * *")).toBeNull();
  });

  it("recusa dia, mês ou dia-da-semana diferentes de '*'", () => {
    expect(normalizarJanela("*/5 2-5 1 * *")).toBeNull();
    expect(normalizarJanela("*/5 2-5 * 1 *")).toBeNull();
    expect(normalizarJanela("*/5 2-5 * * 1")).toBeNull();
  });

  it("recusa o que não é alfabeto de cron", () => {
    expect(normalizarJanela("*/5 2-5 * * *; rm -rf /")).toBeNull();
    expect(normalizarJanela("*/5 2-5 * * *x")).toBeNull();
    expect(normalizarJanela("1-2-3 2-5 * * *")).toBeNull();
  });
});

describe("janelaContem", () => {
  const JANELA = "*/5 2-5 * * *";

  it("cobre os minutos múltiplos de 5 das 2h às 5h59", () => {
    expect(janelaContem(JANELA, 2, 0)).toBe(true);
    expect(janelaContem(JANELA, 2, 5)).toBe(true);
    expect(janelaContem(JANELA, 5, 55)).toBe(true);
  });

  it("não cobre o minuto fora do passo nem a hora fora da faixa", () => {
    expect(janelaContem(JANELA, 2, 1)).toBe(false);
    expect(janelaContem(JANELA, 2, 7)).toBe(false);
    expect(janelaContem(JANELA, 1, 55)).toBe(false);
    expect(janelaContem(JANELA, 6, 0)).toBe(false);
    expect(janelaContem(JANELA, 10, 0)).toBe(false);
  });

  it("aceita o dia inteiro quando o valor é `* *`", () => {
    expect(janelaContem("* * * * *", 23, 59)).toBe(true);
    expect(janelaContem("* * * * *", 0, 0)).toBe(true);
  });
});

describe("primeiraOportunidade", () => {
  const JANELA = "*/5 2-5 * * *";

  it("despacho de dia: a janela só abre na madrugada seguinte", () => {
    const despacho = emSaoPaulo("2026-11-12T10:00:00");
    const primeira = primeiraOportunidade(JANELA, despacho);
    expect(primeira?.toISOString()).toBe(emSaoPaulo("2026-11-13T02:00:00").toISOString());
  });

  it("despacho dentro da janela: a próxima oportunidade é o ciclo seguinte", () => {
    expect(primeiraOportunidade(JANELA, emSaoPaulo("2026-11-12T02:00:00"))?.toISOString()).toBe(
      emSaoPaulo("2026-11-12T02:05:00").toISOString(),
    );
  });

  it("o minuto da própria despacho não conta — o agente pega no ciclo seguinte", () => {
    // 01:59:59 → o primeiro minuto inteiro DEPOIS é 02:00, que já está na janela.
    expect(primeiraOportunidade(JANELA, emSaoPaulo("2026-11-12T01:59:59"))?.toISOString()).toBe(
      emSaoPaulo("2026-11-12T02:00:00").toISOString(),
    );
    // 02:00:00 exato: 02:00 já passou, e 02:01 não casa o passo — 02:05.
    expect(primeiraOportunidade(JANELA, emSaoPaulo("2026-11-12T02:00:00"))?.toISOString()).toBe(
      emSaoPaulo("2026-11-12T02:05:00").toISOString(),
    );
  });
});

/**
 * O FUSO DA JANELA (#4504).
 *
 * Vermelho antes: o cálculo lia `getHours()`, o fuso do PROCESSO. Com a janela
 * de 5 em 5 minutos das 2h às 5h59 e um clique às 23:15 de São Paulo (02:15Z),
 * `TZ=UTC` devolvia 02:20Z e `TZ=America/Sao_Paulo` devolvia 05:00Z — o app
 * liberando o fechamento do pedido 2h40 antes de o host poder executá-lo.
 */
describe("fuso da janela (#4504)", () => {
  const JANELA = "*/5 2-5 * * *";
  /** 23:15 de 19/11 em São Paulo — o clique do defeito medido. */
  const CLIQUE = new Date("2026-11-20T02:15:00.000Z");

  /**
   * Roda `primeiraOportunidade` num PROCESSO de verdade com `TZ` trocado: só
   * assim o `getHours()` de antes apareceria. Trocar `process.env.TZ` dentro do
   * vitest não muda o fuso que o Node já resolveu.
   */
  function emProcesso(tz: string, janela = JANELA, clique = CLIQUE.toISOString()): string {
    const modulo = fileURLToPath(new URL("./janela-de-manutencao.ts", import.meta.url));
    const programa = [
      `const { primeiraOportunidade } = await import(${JSON.stringify(modulo)});`,
      `const quando = primeiraOportunidade(${JSON.stringify(janela)}, new Date(${JSON.stringify(clique)}));`,
      `process.stdout.write(quando ? quando.toISOString() : "null");`,
    ].join("\n");
    return execFileSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", programa],
      {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      },
    ).trim();
  }

  it("o mesmo cron e o mesmo clique dão o MESMO instante com TZ=UTC e TZ=America/Sao_Paulo", () => {
    const comUTC = emProcesso("UTC");
    const comLocal = emProcesso("America/Sao_Paulo");

    expect(comUTC).toBe(comLocal);
    // 02:00 de 20/11 em São Paulo — a hora em que o host abre a janela.
    expect(comUTC).toBe("2026-11-20T05:00:00.000Z");
  });

  it("o instante vem do fuso DECLARADO, não de um acidente do processo", () => {
    vi.stubEnv("SYSTEM_UPDATE_WINDOW_TZ", "UTC");
    try {
      // A mesma janela lida em UTC abre 02:00Z — é o valor de antes do #4504, e
      // é o que um host em UTC deve ver. O que não pode acontecer é isso mudar
      // sozinho: agora só muda declarando.
      expect(primeiraOportunidade(JANELA, CLIQUE)?.toISOString()).toBe("2026-11-20T02:20:00.000Z");
    } finally {
      vi.unstubAllEnvs();
    }

    expect(primeiraOportunidade(JANELA, CLIQUE)?.toISOString()).toBe("2026-11-20T05:00:00.000Z");
  });

  it("fuso declarado de outro host é respeitado; valor inválido cai no padrão", () => {
    expect(FUSO_PADRAO_DA_JANELA).toBe("America/Sao_Paulo");
    expect(fusoDaJanela("")).toBe(FUSO_PADRAO_DA_JANELA);
    expect(fusoDaJanela("   ")).toBe(FUSO_PADRAO_DA_JANELA);
    expect(fusoDaJanela(null)).toBe(FUSO_PADRAO_DA_JANELA);
    expect(fusoDaJanela("Europe/Lisbon")).toBe("Europe/Lisbon");

    // 23:15 de 19/11 em Lisboa (23:15Z, Lisboa é UTC+0 no inverno): a janela
    // das 2h às 5h59 abre 02:00Z do dia 20 — e não 02:00 de São Paulo (05:00Z).
    expect(
      primeiraOportunidade(
        JANELA,
        new Date("2026-11-19T23:15:00.000Z"),
        "Europe/Lisbon",
      )?.toISOString(),
    ).toBe("2026-11-20T02:00:00.000Z");

    // Lixo não vira fuso do processo: vira o padrão declarado.
    expect(fusoDaJanela("Marte/Olympus")).toBe(FUSO_PADRAO_DA_JANELA);
    expect(primeiraOportunidade(JANELA, CLIQUE, "Marte/Olympus")?.toISOString()).toBe(
      "2026-11-20T05:00:00.000Z",
    );

    vi.stubEnv("SYSTEM_UPDATE_WINDOW_TZ", "Europe/Lisbon");
    try {
      expect(fusoDaJanela()).toBe("Europe/Lisbon");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("hora e minuto de parede no fuso da janela", () => {
    const madrugada = new Date("2026-11-20T05:00:00.000Z");
    expect(horaEMinutoNoFuso(madrugada, "America/Sao_Paulo")).toEqual({ hora: 2, minuto: 0 });
    expect(horaEMinutoNoFuso(madrugada, "UTC")).toEqual({ hora: 5, minuto: 0 });
    // Duas horas sem zero à esquerda e meia-noite como 0 — `hourCycle: "h23"`,
    // porque o default de `en-US` devolve "24" à meia-noite e `janelaContem`
    // recusaria a hora 24.
    expect(horaEMinutoNoFuso(new Date("2026-11-20T03:00:00.000Z"), "UTC")).toEqual({
      hora: 3,
      minuto: 0,
    });
    expect(horaEMinutoNoFuso(new Date("2026-11-20T00:00:00.000Z"), "UTC")).toEqual({
      hora: 0,
      minuto: 0,
    });
    expect(horaEMinutoNoFuso(new Date("2026-11-20T00:05:00.000Z"), "UTC")).toEqual({
      hora: 0,
      minuto: 5,
    });
  });

  it("o compose declara o MESMO fuso padrão do código", () => {
    // Duas declarações do mesmo fuso é uma a mais do que o ideal; se elas
    // divergirem, a janela muda de significado em produção sem nenhum teste
    // vermelho. Esta é a cerca.
    const compose = readFileSync(
      fileURLToPath(new URL("../../docker-compose.prod.yml", import.meta.url)),
      "utf8",
    );
    expect(compose).toContain(
      `SYSTEM_UPDATE_WINDOW_TZ: \${SYSTEM_UPDATE_WINDOW_TZ:-${FUSO_PADRAO_DA_JANELA}}`,
    );
  });
});
