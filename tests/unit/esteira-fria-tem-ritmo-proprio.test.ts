import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { warmupCapFor } from "@/lib/agent-engine/pacing/engine";
import {
  FATOR_DA_ESTEIRA_FRIA,
  proximoEnvioDaEsteiraFria,
  tetoDiarioDaEsteiraFria,
} from "@/lib/prospecting/ritmo-da-esteira-fria";

/**
 * A ESTEIRA FRIA NÃO PODE USAR O RITMO DA ESTEIRA DE RESPOSTA.
 *
 * ## As duas metades, e QUAL delas falhava antes deste conserto
 *
 * (a régua: num teste que cobre duas pontas, diga qual falha hoje — se nenhuma
 * falha, o teste não vigia defeito nenhum)
 *
 *   1. TETO DIÁRIO — falhava. O worker usava só `daily_limit` da campanha e um
 *      teto global de 50, e o warm-up do motor da casa começa em **20 no
 *      primeiro dia**. Um número conectado hoje podia disparar 20 PRIMEIRAS
 *      abordagens hoje.
 *   2. JITTER — falhava. `next_send_at = now() + N minutos`, exato, sempre o
 *      mesmo número de milissegundos. Cadência perfeitamente regular é
 *      assinatura de robô, e é o padrão que a detecção de automação procura.
 *
 * As duas estavam abertas; nenhuma passava "de graça".
 *
 * ## Por que o número é derivado, e não escolhido
 *
 * A doutrina já fixa a proporção entre as esteiras no eixo do TEMPO (resposta
 * 1,2s, campanha 5s ≈ 4×). Este módulo aplica a mesma proporção ao eixo do
 * VOLUME. Uma tabela nova de degraus seria um segundo lugar para ajustar, e
 * quem ajustasse os knobs do canal não saberia dela.
 */

const RAIZ = path.resolve(__dirname, "../..");

describe("o teto diário da esteira fria", () => {
  it("é uma fração do teto da casa — e a fração é a da doutrina", () => {
    for (const dias of [0, 4, 8, 15]) {
      const daCasa = warmupCapFor(dias, PACING_DEFAULTS.warmupDailyCaps)!;
      expect(tetoDiarioDaEsteiraFria(PACING_DEFAULTS, dias)).toBe(
        Math.floor(daCasa / FATOR_DA_ESTEIRA_FRIA),
      );
    }
  });

  it("no PRIMEIRO dia de um número, são 5 e não 20", () => {
    // Este é o caso do defeito, com o número na frente para quem for ler depois.
    expect(warmupCapFor(0, PACING_DEFAULTS.warmupDailyCaps)).toBe(20);
    expect(tetoDiarioDaEsteiraFria(PACING_DEFAULTS, 0)).toBe(5);
  });

  it("acompanha os knobs da instalação em vez de ter tabela própria", () => {
    // Quem apertar o warm-up do canal aperta os dois juntos. Uma segunda tabela
    // aqui divergiria em silêncio.
    const apertado = {
      ...PACING_DEFAULTS,
      warmupDailyCaps: [{ minAgeDays: 0, cap: 8 }],
    };
    expect(tetoDiarioDaEsteiraFria(apertado, 0)).toBe(2);
  });

  it("nunca arredonda para zero — isso PARARIA a esteira em vez de desacelerá-la", () => {
    // Campanha que nunca envia é outro defeito, e pior: silencioso. O operador
    // fica olhando uma tela que não muda.
    const minusculo = { ...PACING_DEFAULTS, warmupDailyCaps: [{ minAgeDays: 0, cap: 2 }] };
    expect(tetoDiarioDaEsteiraFria(minusculo, 0)).toBe(1);
  });

  it("depois do warm-up não impõe teto — quem limita é quem opera", () => {
    expect(warmupCapFor(31, PACING_DEFAULTS.warmupDailyCaps)).toBeNull();
    expect(tetoDiarioDaEsteiraFria(PACING_DEFAULTS, 31)).toBeNull();
  });
});

describe("o intervalo entre abordagens varia", () => {
  const agora = new Date("2026-09-19T12:00:00Z");

  it("soma jitter ao intervalo — a cadência exata é assinatura de robô", () => {
    const semJitter = agora.getTime() + 5 * 60_000;
    // `Math.random` devolve [0,1), então o topo PRÁTICO é 0,999… — e a fórmula
    // da casa (`floor(rng * (max+1))`) chega exatamente a `jitterMaxMs` ali.
    // Passar `() => 1` testaria um valor que o rng real nunca produz, e foi o
    // que eu fiz na primeira versão: o teste reprovou o código certo.
    const comMaximo = proximoEnvioDaEsteiraFria(agora, 5, PACING_DEFAULTS, () => 0.999999);
    expect(comMaximo.getTime()).toBe(semJitter + PACING_DEFAULTS.jitterMaxMs);

    // E o piso: rng no mínimo é o intervalo cru, nunca menos.
    const comMinimo = proximoEnvioDaEsteiraFria(agora, 5, PACING_DEFAULTS, () => 0);
    expect(comMinimo.getTime()).toBe(semJitter);
  });

  it("o jitter só ATRASA — adiantar furaria o intervalo mínimo do operador", () => {
    const base = agora.getTime() + 5 * 60_000;
    for (const r of [0, 0.5, 0.999999]) {
      const t = proximoEnvioDaEsteiraFria(agora, 5, PACING_DEFAULTS, () => r).getTime();
      expect(t).toBeGreaterThanOrEqual(base);
      expect(t).toBeLessThanOrEqual(base + PACING_DEFAULTS.jitterMaxMs);
    }
  });

  it("dois agendamentos seguidos não caem no mesmo milissegundo", () => {
    // Com rng real. Se alguém trocar o jitter por uma constante, isto reprova.
    const amostras = new Set(
      Array.from({ length: 40 }, () =>
        proximoEnvioDaEsteiraFria(agora, 5, PACING_DEFAULTS).getTime(),
      ),
    );
    expect(amostras.size).toBeGreaterThan(1);
  });
});

describe("o worker usa os dois — módulo perfeito e desligado não conserta nada", () => {
  const worker = fs.readFileSync(path.join(RAIZ, "lib/prospecting/worker.ts"), "utf8");

  it("consulta o teto da esteira fria antes de enviar", () => {
    expect(worker).toMatch(/tetoDiarioDaEsteiraFria\(/);
    expect(worker).toMatch(/count\.total >= tetoFrio/);
  });

  it("agenda o próximo envio COM jitter, e não mais com o intervalo cru", () => {
    expect(worker).toMatch(/proximoEnvioDaEsteiraFria\(/);
    expect(
      worker.includes("next_send_at=now()+($3::int*interval '1 minute')"),
      "o agendamento voltou a ser exato, sem jitter",
    ).toBe(false);
  });
});
