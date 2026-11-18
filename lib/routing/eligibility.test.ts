import { describe, expect, it } from "vitest";

import { abriuOHorario, estaDePlantao, isAttendantEligible, isWithinSchedule, localMoment } from "./eligibility";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

/**
 * Elegibilidade (spec 13 §5) + heartbeat AT-08. Clock SEMPRE injetado (`now`) —
 * zero relógio implícito, zero sleep real; o "agora" é um parâmetro.
 */

// Seg 2026-07-13 14:00 America/Sao_Paulo (UTC-03) == 17:00Z. dow=1 (segunda).
const MON_1400_BRT = new Date("2026-07-13T17:00:00Z");
// Seg 2026-07-13 19:00 BRT == 22:00Z (fora de uma janela 08:00–18:00).
const MON_1900_BRT = new Date("2026-07-13T22:00:00Z");

const schedule8to18Mon = availabilityScheduleSchema.parse({
  timezone: "America/Sao_Paulo",
  windows: [{ dow: 1, start: "08:00", end: "18:00" }],
});

describe("isWithinSchedule (tz-aware)", () => {
  it("dentro da janela (seg 14:00 BRT, janela seg 08–18) ⇒ true", () => {
    expect(isWithinSchedule(schedule8to18Mon, MON_1400_BRT)).toBe(true);
  });

  it("fora da janela (seg 19:00 BRT, janela seg 08–18) ⇒ false", () => {
    expect(isWithinSchedule(schedule8to18Mon, MON_1900_BRT)).toBe(false);
  });

  it("dia sem janela (mesma hora mas janela só seg — testado terça) ⇒ false", () => {
    // Ter 2026-07-14 14:00 BRT == 17:00Z, dow=2 — sem janela ⇒ inelegível.
    const tue1400 = new Date("2026-07-14T17:00:00Z");
    expect(isWithinSchedule(schedule8to18Mon, tue1400)).toBe(false);
  });

  it("windows vazio (default '{}') ⇒ sem restrição (24/7) ⇒ true", () => {
    expect(isWithinSchedule({ timezone: "America/Sao_Paulo", windows: [] }, MON_1900_BRT)).toBe(
      true,
    );
  });
});

describe("isAttendantEligible (§5: disponível ∧ horário ∧ folga)", () => {
  const base = { isAvailable: true, capacity: 5, currentLoad: 2, schedule: schedule8to18Mon };

  it("disponível + dentro da janela + com folga (2/5) ⇒ elegível", () => {
    expect(isAttendantEligible(base, MON_1400_BRT)).toBe(true);
  });

  it("fora da janela (seg 19h) ⇒ NÃO elegível", () => {
    expect(isAttendantEligible(base, MON_1900_BRT)).toBe(false);
  });

  it("capacidade cheia (carga 5 == capacity 5) ⇒ NÃO elegível", () => {
    expect(isAttendantEligible({ ...base, currentLoad: 5 }, MON_1400_BRT)).toBe(false);
  });

  it("carga acima da capacidade (6 > 5) ⇒ NÃO elegível", () => {
    expect(isAttendantEligible({ ...base, currentLoad: 6 }, MON_1400_BRT)).toBe(false);
  });

  it("offline (is_available=false), mesmo com folga e no horário ⇒ NÃO elegível", () => {
    expect(isAttendantEligible({ ...base, isAvailable: false }, MON_1400_BRT)).toBe(false);
  });
});

/**
 * A REGRA DO PLANTÃO, enunciada pelo dono do produto em 2026-09-11:
 *
 *   "ligado sem data e hora definida é 24/7; ligado com data e hora definida
 *    fica on só nos horários, fora deles é off, e religa sozinho."
 *
 * Aqui ficava o `isHeartbeatStale` — o predicado do auto-offline por presença.
 * Ele saiu junto com o cron que o usava: **não existia emissor de sinal de vida
 * em lugar nenhum do repositório**, então a varredura derrubava todo atendente
 * ~15 min depois de ele se declarar de plantão, em toda instalação, e nada o
 * religava.
 *
 * O "religa sozinho" é a razão de isto ser DERIVADO e não gravado: não há o que
 * religar, porque nada foi desligado. A conta simplesmente muda de resposta
 * quando o relógio entra na janela.
 */
describe("estaDePlantao — a regra inteira, com clock injetado", () => {
  const JORNADA = {
    timezone: "America/Sao_Paulo",
    // Segunda, 08:00–18:00.
    windows: [{ dow: 1, start: "08:00", end: "18:00" }],
  };
  // Segunda, 12:00 em São Paulo (UTC-3).
  const DENTRO = new Date("2026-09-14T15:00:00Z");
  // Segunda, 22:00 em São Paulo — mesma segunda, fora da janela.
  const FORA = new Date("2026-09-15T01:00:00Z");

  it("chave desligada ⇒ off, com jornada ou sem ela — decisão de gente vence tudo", () => {
    expect(estaDePlantao({ isAvailable: false, schedule: JORNADA }, DENTRO)).toBe(false);
    expect(estaDePlantao({ isAvailable: false, schedule: null }, DENTRO)).toBe(false);
  });

  it("ligado SEM jornada publicada ⇒ 24/7", () => {
    expect(estaDePlantao({ isAvailable: true, schedule: null }, DENTRO)).toBe(true);
    expect(estaDePlantao({ isAvailable: true, schedule: null }, FORA)).toBe(true);
    expect(estaDePlantao({ isAvailable: true, schedule: { timezone: "America/Sao_Paulo", windows: [] } }, FORA)).toBe(true);
  });

  it("ligado COM jornada ⇒ on dentro dela", () => {
    expect(estaDePlantao({ isAvailable: true, schedule: JORNADA }, DENTRO)).toBe(true);
  });

  it("ligado COM jornada ⇒ off fora dela, SEM ninguém desligar nada", () => {
    expect(estaDePlantao({ isAvailable: true, schedule: JORNADA }, FORA)).toBe(false);
  });

  it("RELIGA SOZINHO: a MESMA linha do banco, dois instantes, duas respostas", () => {
    // É o caso que dá nome ao conserto. Nada entre uma linha e outra escreve no
    // banco: só o relógio andou. Era impossível enquanto a indisponibilidade era
    // GRAVADA por uma varredura — depois de gravada, nada sabia reacender.
    const linha = { isAvailable: true, schedule: JORNADA };
    expect(estaDePlantao(linha, FORA)).toBe(false);
    // Segunda seguinte, 09:00 em São Paulo.
    expect(estaDePlantao(linha, new Date("2026-09-21T12:00:00Z"))).toBe(true);
  });

  it("é a MESMA conta do roteador, sem a capacidade — tela e motor não divergem", () => {
    // O defeito de origem foi a tela ler uma coisa (presença) e o motor outra
    // (jornada). Este caso prende as duas na mesma resposta.
    for (const [linha, now] of [
      [{ isAvailable: true, schedule: JORNADA }, DENTRO],
      [{ isAvailable: true, schedule: JORNADA }, FORA],
      [{ isAvailable: false, schedule: JORNADA }, DENTRO],
      [{ isAvailable: true, schedule: null }, FORA],
    ] as const) {
      expect(
        isAttendantEligible({ ...linha, capacity: 5, currentLoad: 0 }, now),
        JSON.stringify({ linha, now }),
      ).toBe(estaDePlantao(linha, now));
    }
  });
});

/**
 * PORTA 3 DO ROTEAMENTO (#3916): A JORNADA ABRIU AGORA?
 *
 * O defeito que estes casos prendem: a jornada é DERIVADA na leitura, então
 * ninguém avisa o roteamento quando ela vira. Uma conversa que espera a fila
 * abrir (backoff do worker) só é tentada de novo quando o backoff vence (até
 * 15 minutos) — e numa fila que ABRIU agora não chega evento nenhum que a
 * adiante.
 *
 * A regra é a mesma conta de `isWithinSchedule`, feita duas vezes: um minuto
 * atrás estava fora, agora está dentro. É o que a torna IDEMPOTENTE SEM COLUNA
 * DE ESTADO: não existe "já avisei" gravado, e o segundo tick seguido dá
 * `false` por construção, não por memória.
 *
 * A janela é a cadência do crontab (`* * * * *`), 60 s: com ela, exatamente UM
 * tick da abertura responde `true`. Janela maior daria dois acordes na virada
 * de um minuto para o outro; menor perderia a abertura quando o tick atrasa.
 */
describe("abriuOHorario — a porta 3 do roteamento (a jornada começa)", () => {
  const JANELA_DE_TICK = 60_000;
  const SEG_0800_BRT = new Date("2026-07-13T11:00:00Z"); // seg 08:00 em São Paulo
  const SEG_0801_BRT = new Date("2026-07-13T11:01:00Z");
  const SEG_1400_BRT_2 = new Date("2026-07-13T17:00:00Z");

  it("ABRIU AGORA: 08:00 com janela 08:00–18:00 ⇒ true (07:59 estava fora)", () => {
    expect(abriuOHorario(schedule8to18Mon, SEG_0800_BRT, JANELA_DE_TICK)).toBe(true);
  });

  it("JÁ ESTAVA ABERTO: o tick seguinte (08:01) e o meio da tarde ⇒ false, sem estado gravado", () => {
    // O controle negativo é o que impede "acorda em todo tick": 08:01 só é
    // diferente de 08:00 porque 08:00 JÁ estava dentro — nada foi lembrado.
    expect(abriuOHorario(schedule8to18Mon, SEG_0801_BRT, JANELA_DE_TICK)).toBe(false);
    expect(abriuOHorario(schedule8to18Mon, SEG_1400_BRT_2, JANELA_DE_TICK)).toBe(false);
  });

  it("FECHADO: fora da janela (19:00) e dia sem janela ⇒ false nos dois lados da conta", () => {
    expect(abriuOHorario(schedule8to18Mon, MON_1900_BRT, JANELA_DE_TICK)).toBe(false);
    // Terça 08:00 com jornada que só publica segunda: o dia abre sem jornada —
    // nada a acordar, porque não existe janela para abrir.
    expect(abriuOHorario(schedule8to18Mon, new Date("2026-07-14T11:00:00Z"), JANELA_DE_TICK)).toBe(
      false,
    );
  });

  it("VIRADA DE DIA/FUSO: segunda 08:00 em Tóquio é DOMINGO 23:00 em UTC", () => {
    const tokyo8to12Mon = availabilityScheduleSchema.parse({
      timezone: "Asia/Tokyo",
      windows: [{ dow: 1, start: "08:00", end: "12:00" }],
    });
    // Seg 2026-07-13 08:00 JST == dom 2026-07-12 23:00Z.
    const aberturaEmToquio = new Date("2026-07-12T23:00:00Z");
    // A prova de que o caso é de FUSO e não de horário: em UTC este instante é
    // domingo (dow 0) às 23:00 — quem lesse o relógio sem o fuso da jornada
    // diria "fechado" e nunca acordaria a segunda-feira japonesa.
    expect(localMoment(aberturaEmToquio, "UTC")).toEqual({ dow: 0, hhmm: "23:00" });
    expect(isWithinSchedule(tokyo8to12Mon, aberturaEmToquio)).toBe(true);
    expect(abriuOHorario(tokyo8to12Mon, aberturaEmToquio, JANELA_DE_TICK)).toBe(true);
    // E o tick seguinte já está aberto dos dois lados.
    expect(abriuOHorario(tokyo8to12Mon, new Date("2026-07-12T23:01:00Z"), JANELA_DE_TICK)).toBe(
      false,
    );
  });

  it("24/7 (windows vazio) nunca ABRE — sem restrição não há virada a avisar", () => {
    const semJanela = availabilityScheduleSchema.parse({
      timezone: "America/Sao_Paulo",
      windows: [],
    });
    expect(abriuOHorario(semJanela, SEG_0800_BRT, JANELA_DE_TICK)).toBe(false);
    expect(abriuOHorario(null, SEG_0800_BRT, JANELA_DE_TICK)).toBe(false);
  });
});
