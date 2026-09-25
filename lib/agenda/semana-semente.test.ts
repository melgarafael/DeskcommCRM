/**
 * A borda que este teste prende é a que derrubou o CI quatro vezes em
 * 2026-09-20 — e ela vira uma linha porque o instante é parâmetro.
 */
import { describe, expect, it } from "vitest";

import { ancoraLocalDoDia, diaDeHojeNoFuso, semanaSemente } from "./semana-semente";
import { diaLocalISO } from "./fuso";

const SP = "America/Sao_Paulo";

describe("a semana que a agenda abre", () => {
  it("no sábado à noite em São Paulo, é a semana do SÁBADO — mesmo com UTC já em domingo", () => {
    // 2026-09-20T00:30Z: UTC já é DOMINGO, São Paulo ainda é sábado, 21:30. É a
    // janela real em que o CI ficou vermelho — o job rodou às 00:23–00:45Z.
    // ⚠️ A primeira versão deste caso usava 23:54Z, o horário em que a RODADA foi
    // criada; ali UTC ainda é sábado e as duas réguas concordam. O controle
    // abaixo pegou o engano: o caso teria passado medindo nada.
    const { de } = semanaSemente(new Date("2026-09-20T00:30:00Z"), SP);
    expect(diaLocalISO(de, SP)).toBe("2026-09-13");
  });

  it("no fuso do SERVIDOR (UTC), o mesmo instante cai na semana seguinte — a divergência existe", () => {
    // O controle que dá sentido ao caso acima: sem ele, "2026-09-13" poderia
    // ser o resultado de qualquer fuso, e o teste não mediria o parâmetro.
    const { de } = semanaSemente(new Date("2026-09-20T00:30:00Z"), "UTC");
    expect(diaLocalISO(de, "UTC")).toBe("2026-09-20");
  });

  it("depois da meia-noite de São Paulo, as duas réguas voltam a concordar", () => {
    const instante = new Date("2026-09-20T03:30:00Z"); // 00:30 de domingo em SP
    expect(diaLocalISO(semanaSemente(instante, SP).de, SP)).toBe("2026-09-20");
    expect(diaLocalISO(semanaSemente(instante, "UTC").de, "UTC")).toBe("2026-09-20");
  });

  it("começa no domingo e termina no domingo seguinte, exclusivo", () => {
    const { de, ate } = semanaSemente(new Date("2026-09-16T15:00:00Z"), SP);
    expect(diaLocalISO(de, SP)).toBe("2026-09-13");
    expect(diaLocalISO(ate, SP)).toBe("2026-09-20");
    expect(de.getTime()).toBeLessThan(ate.getTime());
  });

  it("a semana começa à MEIA-NOITE local, não à meia-noite de UTC", () => {
    // Sem isto, um `startOfWeek` em UTC passaria nos casos acima por acidente:
    // o dia bateria e a hora não, e o compromisso das 21h de sábado cairia fora
    // da janela que o servidor adianta.
    const { de } = semanaSemente(new Date("2026-09-16T15:00:00Z"), SP);
    expect(de.toISOString()).toBe("2026-09-13T03:00:00.000Z"); // 00:00 em SP (GMT-3)
  });

  it("atravessa a virada do horário de verão sem perder nem inventar hora", () => {
    // Sydney adianta o relógio às 2h de domingo 2026-10-04, então a semana que
    // COMEÇA nele tem 167 horas (medido: 04/10 00:00 → 11/10 00:00 = 167 h).
    // ⚠️ A primeira versão escolheu a semana ANTERIOR, que termina na virada e
    // tem 168 — o teste não teria exercitado a borda. O vermelho me corrigiu.
    const fuso = "Australia/Sydney";
    const { de, ate } = semanaSemente(new Date("2026-10-06T12:00:00Z"), fuso);
    expect(diaLocalISO(de, fuso)).toBe("2026-10-04");
    expect(diaLocalISO(ate, fuso)).toBe("2026-10-11");
    const horas = (ate.getTime() - de.getTime()) / 3_600_000;
    expect(horas).toBe(167);
  });
});

describe("o dia de hoje no fuso da organização", () => {
  it("atravessa a fronteira como DATA, e a âncora local cai no mesmo dia", () => {
    // 2026-09-20T00:30Z: em São Paulo ainda é sábado 19.
    const instante = new Date("2026-09-20T00:30:00Z");
    expect(diaDeHojeNoFuso(instante, SP)).toBe("2026-09-19");
    expect(diaDeHojeNoFuso(instante, "UTC")).toBe("2026-09-20");

    const ancora = ancoraLocalDoDia("2026-09-19");
    expect(ancora.getFullYear()).toBe(2026);
    expect(ancora.getMonth()).toBe(8); // setembro
    expect(ancora.getDate()).toBe(19);
  });

  it("a âncora é ao MEIO-DIA — meia-noite ficaria a um passo de virar o dia", () => {
    // Com 00:00, uma diferença de uma hora (horário de verão, relógio do
    // sistema) muda a DATA. Ao meio-dia, não há borda a doze horas.
    expect(ancoraLocalDoDia("2026-09-19").getHours()).toBe(12);
  });
});
