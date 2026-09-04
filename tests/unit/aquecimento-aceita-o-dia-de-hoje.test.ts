/**
 * "ESTE NÚMERO É USADO DESDE" ACEITA O DIA DE HOJE — EM TODA HORA DO DIA.
 *
 * Achado da varredura adversarial contra o PR #496 (já mergeado).
 *
 * ─── O defeito, medido no SHA f700f3e1 ────────────────────────────────────
 *
 * O operador não escolhe um instante: escolhe um DIA num `<input type="date">`,
 * e `AntiBanSheet` encaixa esse dia às **12h UTC** (meia-noite viraria o dia
 * anterior a oeste). A guarda do schema comparava esse encaixe com `Date.now()`
 * — um DIA contra um RELÓGIO —, e o encaixe de hoje só chega às 12:00 UTC.
 *
 * Varrendo as 24 horas com relógio falso, em `America/Sao_Paulo` (UTC−3),
 * declarando o dia que a tela mostra:
 *
 *   UTC 02:30 | BRT 23:30 | dia local=2026-09-02 | ACEITA
 *   UTC 03:00 | BRT 00:00 | dia local=2026-09-03 | RECUSA   ← começa
 *   ...
 *   UTC 11:30 | BRT 08:30 | dia local=2026-09-03 | RECUSA
 *   UTC 12:00 | BRT 09:00 | dia local=2026-09-03 | ACEITA   ← para
 *
 * Nove horas de todo dia — 00:00 às 09:00 no relógio de quem opera — em que a
 * tela oferecia hoje (o `max` do campo) e o servidor respondia 422. Pela régua
 * do dia UTC (o que aquele `max` de fato oferecia, porque ele vinha de
 * `toISOString()`), a recusa cobria as **primeiras 12 horas UTC** do dia.
 *
 * E ela derrubava a ficha INTEIRA: o schema é `.strict()` e a rota devolve 422
 * antes de gravar qualquer campo, então janela, throttle e teto diário caíam
 * junto — o mesmo desfecho que o PR #496 tinha acabado de consertar para o
 * campo em branco, pela porta ao lado.
 *
 * ─── A regra, e o PAR que ela tem de manter ───────────────────────────────
 *
 * Um dia sem fuso não tem instante: "3 de setembro" começa em UTC+14 e acaba em
 * UTC−12, 26 horas depois. O payload não carrega o fuso do navegador, então a
 * única fronteira honesta é a do planeta — recusar apenas o dia que não começou
 * em lugar NENHUM (`agora + 14h`, UTC+14 sendo o fuso mais adiantado que
 * existe).
 *
 * O par que impede "aceite tudo" de satisfazer este arquivo:
 *   • hoje é ACEITO, em qualquer hora do dia (e o passado segue aceito — é para
 *     isso que o campo existe);
 *   • um dia que ainda não começou em canto nenhum segue RECUSADO.
 *
 * ⚠️ A polaridade desta guarda é essa mesma: ela recusa o FUTURO. "Ontem
 * continua recusado" seria o par de uma guarda de agendamento; aqui ontem é o
 * caso legítimo — o número É usado desde antes de hoje —, e recusá-lo é
 * justamente o rebaixamento a 20 envios/dia que o campo existe para desfazer.
 *
 * ─── E a folga de até um dia não afrouxa proteção nenhuma ─────────────────
 *
 * Data futura não adianta o aquecimento: `idadeEmDias` faz `Math.max(0, …)`,
 * então futuro vira idade 0 — o degrau MAIS conservador (20 envios/dia). Medido
 * em `aquecimento-idade-do-numero.test.ts`. O comentário anterior da guarda
 * dizia o contrário ("ela ADIANTARIA o aquecimento") e era a justificativa de
 * um rigor que só machucava quem estava certo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  diaDeHojeLocal,
  diaDeclaradoJaComecou,
  pacingKnobsUpdateSchema,
} from "@/lib/ai/pacing-knobs";

const SESSAO = "44444444-4444-4444-8444-444444444444";
/** UTC−3: o fuso de quem opera este produto, e o `PACING_DEFAULTS.timezone`. */
const FUSO_DO_OPERADOR = "America/Sao_Paulo";

const TZ_ORIGINAL = process.env.TZ;

beforeEach(() => {
  // O `max` do campo é lido no fuso do NAVEGADOR. Sem forçar o fuso, um runner
  // em UTC não distinguiria o conserto do defeito — os dois dias coincidem.
  process.env.TZ = FUSO_DO_OPERADOR;
});

afterEach(() => {
  vi.useRealTimers();
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

/** Congela o relógio num instante UTC. */
function relogioEm(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

/** O dia que o `<input type="date">` mostra a quem está neste fuso. */
function diaNaTela(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

/** A expressão EXATA de `AntiBanSheet.handleSave`: o dia encaixado às 12h UTC. */
function salvar(dia: string) {
  return pacingKnobsUpdateSchema.safeParse({
    channel_session_id: SESSAO,
    number_activated_at: new Date(`${dia}T12:00:00.000Z`).toISOString(),
  });
}

describe("a fronteira que recusava o dia de hoje", () => {
  it("00:30 UTC — o dia de hoje é aceito (era a primeira hora da recusa)", () => {
    relogioEm("2026-09-04T00:30:00.000Z");
    // Às 00:30 UTC o dia UTC já virou; o dia de quem está em UTC−3 ainda é o 3.
    expect(diaNaTela(new Date(), FUSO_DO_OPERADOR)).toBe("2026-09-03");
    expect(salvar("2026-09-03").success).toBe(true);
    // E o dia UTC — que é o que o `max` antigo oferecia nesta hora — também: era
    // ele que caía com "a data não pode estar no futuro" até as 12:00 UTC.
    expect(salvar("2026-09-04").success).toBe(true);
  });

  it("23:30 UTC — o dia de hoje continua aceito (a ponta oposta do dia)", () => {
    relogioEm("2026-09-03T23:30:00.000Z");
    expect(diaNaTela(new Date(), FUSO_DO_OPERADOR)).toBe("2026-09-03");
    expect(salvar("2026-09-03").success).toBe(true);
  });

  it("03:30 UTC — 00:30 no relógio de quem opera, a hora em que a recusa começava", () => {
    relogioEm("2026-09-03T03:30:00.000Z");
    expect(diaNaTela(new Date(), FUSO_DO_OPERADOR)).toBe("2026-09-03");
    expect(salvar("2026-09-03").success).toBe(true);
  });

  it("nenhuma das 48 meias-horas do dia recusa o dia que a tela mostra", () => {
    const recusadas: string[] = [];
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const hh = String(h).padStart(2, "0");
        const mm = String(m).padStart(2, "0");
        relogioEm(`2026-09-03T${hh}:${mm}:00.000Z`);
        const dia = diaNaTela(new Date(), FUSO_DO_OPERADOR);
        if (!salvar(dia).success) recusadas.push(`${hh}:${mm} UTC (dia ${dia})`);
        vi.useRealTimers();
      }
    }
    expect(recusadas).toEqual([]);
  });
});

describe("o par — sem ele, 'aceite tudo' satisfaria o arquivo acima", () => {
  it("o dia seguinte, quando não começou em canto nenhum, segue recusado", () => {
    relogioEm("2026-09-04T00:30:00.000Z");
    // 00:30 UTC + 14h (UTC+14, o fuso mais adiantado) ainda é dia 4 em todo
    // lugar: ninguém no planeta está no dia 5.
    expect(salvar("2026-09-05").success).toBe(false);
  });

  it("um dia depois de amanhã segue recusado em qualquer hora do dia", () => {
    for (const hora of ["00:30", "12:30", "23:30"]) {
      relogioEm(`2026-09-03T${hora}:00.000Z`);
      expect(salvar("2026-09-05").success).toBe(false);
      vi.useRealTimers();
    }
  });

  it("o absurdo continua recusado — é para isso que a guarda existe", () => {
    relogioEm("2026-09-03T23:30:00.000Z");
    expect(salvar("2030-01-01").success).toBe(false);
  });

  it("o passado segue aceito — declarar número antigo é o propósito do campo", () => {
    relogioEm("2026-09-03T00:30:00.000Z");
    expect(salvar("2026-09-02").success).toBe(true); // ontem
    expect(salvar("2025-09-03").success).toBe(true); // um ano atrás
  });

  it("a regra, com o relógio injetado: a fronteira é o dia UTC de agora + 14h", () => {
    const agora = new Date("2026-09-04T00:30:00.000Z");
    expect(diaDeclaradoJaComecou("2026-09-04T12:00:00.000Z", agora)).toBe(true);
    expect(diaDeclaradoJaComecou("2026-09-05T12:00:00.000Z", agora)).toBe(false);
  });
});

describe("o limite do campo não pode oferecer o que o servidor recusa", () => {
  it("o `max` é o dia LOCAL — às 22h em São Paulo ele parava de oferecer amanhã", () => {
    relogioEm("2026-09-04T01:00:00.000Z"); // 22:00 BRT do dia 3
    expect(diaDeHojeLocal()).toBe("2026-09-03");
    // O dia UTC nesta hora é o 4: era ele que o `max` oferecia, e ele é AMANHÃ
    // para quem está olhando a tela.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-04");
  });

  it("a tela não volta a calcular o `max` em UTC", () => {
    // Sem esta linha, restaurar `max={new Date().toISOString().slice(0, 10)}`
    // não vermelha nada: os casos acima medem `diaDeHojeLocal`, não o ponto de
    // uso. E é o ponto de uso que o operador vê.
    const sheet = readFileSync(
      join(process.cwd(), "components/connections/AntiBanSheet.tsx"),
      "utf8",
    );
    const maxDoCampo = /max=\{([^}]*)\}/.exec(sheet)?.[1] ?? "";
    expect(maxDoCampo, "AntiBanSheet perdeu o `max` do campo de data").not.toBe("");
    expect(
      maxDoCampo.includes("diaDeHojeLocal"),
      `o \`max\` do campo voltou a ser calculado fora do fuso local: ${maxDoCampo}`,
    ).toBe(true);
  });

  it("o dia que o `max` oferece é aceito pelo schema em toda hora do dia", () => {
    const recusadas: string[] = [];
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, "0");
      relogioEm(`2026-09-03T${hh}:15:00.000Z`);
      const oferecido = diaDeHojeLocal();
      if (!salvar(oferecido).success) recusadas.push(`${hh}:15 UTC (max ${oferecido})`);
      vi.useRealTimers();
    }
    expect(recusadas).toEqual([]);
  });
});
