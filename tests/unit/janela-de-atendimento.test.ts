/**
 * A janela de atendimento que a tela oferecia e nenhum leitor vivo consultava.
 *
 * O agente desta instalação tinha `08:00–18:00, seg–sex` gravado na versão
 * publicada e respondeu 21:55 de uma terça — porque o único leitor do campo era
 * o dispatcher legado, hoje NO-OP. Estes testes fixam as duas metades do
 * conserto: ler a janela sem nunca virar mordaça, e adiar (não descartar) o
 * turno para a próxima abertura.
 */
import { describe, expect, it } from "vitest";

import {
  lerJanelaDeAtendimento,
  msAteAJanelaAbrir,
  type JanelaDeAtendimento,
} from "@/lib/agent-engine/agent/janela-de-atendimento";

const COMERCIAL: JanelaDeAtendimento = {
  timezone: "America/Sao_Paulo",
  start: "08:00",
  end: "18:00",
  weekdays: [1, 2, 3, 4, 5],
};

const triggerCom = (bh: unknown) => ({ events: ["message"], filters: { business_hours: bh } });

/** Terça-feira 2026-08-18, no fuso de São Paulo (UTC-3). */
const terca = (hhmm: string) => new Date(`2026-08-18T${hhmm}:00-03:00`);

describe("lerJanelaDeAtendimento", () => {
  it("lê a janela declarada na versão publicada", () => {
    expect(lerJanelaDeAtendimento(triggerCom(COMERCIAL))).toEqual(COMERCIAL);
  });

  it("sem business_hours é sem janela (atende sempre)", () => {
    expect(lerJanelaDeAtendimento(triggerCom(null))).toBeNull();
    expect(lerJanelaDeAtendimento({ events: ["message"] })).toBeNull();
    expect(lerJanelaDeAtendimento(null)).toBeNull();
  });

  it("FALHA ABERTA em config quebrada — nunca vira mordaça", () => {
    const quebradas: unknown[] = [
      { ...COMERCIAL, timezone: "Marte/Olympus" }, // fuso que o ambiente não conhece
      { ...COMERCIAL, start: "8h" }, // hora fora do formato
      { ...COMERCIAL, weekdays: [] }, // nenhum dia
      { ...COMERCIAL, weekdays: [9, -1] }, // dias fora de 0–6
      { ...COMERCIAL, start: "22:00", end: "02:00" }, // vira a meia-noite: não suportado
      { ...COMERCIAL, start: "18:00", end: "18:00" }, // janela de duração zero
    ];
    for (const bh of quebradas) {
      expect(lerJanelaDeAtendimento(triggerCom(bh))).toBeNull();
    }
  });
});

describe("msAteAJanelaAbrir", () => {
  it("dentro da janela devolve null (o turno segue)", () => {
    expect(msAteAJanelaAbrir(COMERCIAL, terca("09:30"))).toBeNull();
    expect(msAteAJanelaAbrir(COMERCIAL, terca("08:00"))).toBeNull(); // borda de abertura
  });

  it("depois do fechamento espera até a manhã seguinte", () => {
    // 21:55 de terça — o horário real do defeito. Abre 08:00 de quarta: 10h05.
    expect(msAteAJanelaAbrir(COMERCIAL, terca("21:55"))).toBe((10 * 60 + 5) * 60_000);
  });

  it("antes da abertura espera só até as 08:00 do mesmo dia", () => {
    expect(msAteAJanelaAbrir(COMERCIAL, terca("06:30"))).toBe(90 * 60_000);
  });

  it("18:00 em ponto já está fechado (o fim é exclusivo)", () => {
    expect(msAteAJanelaAbrir(COMERCIAL, terca("18:00"))).toBe((14 * 60) * 60_000);
  });

  it("sexta à noite pula o fim de semana e cai na segunda", () => {
    const sextaTarde = new Date("2026-08-21T19:00:00-03:00");
    // 19h sexta → 08h segunda = 61h.
    expect(msAteAJanelaAbrir(COMERCIAL, sextaTarde)).toBe(61 * 60 * 60_000);
  });

  it("o fuso da janela é o que vale, não o do servidor", () => {
    // 23:00 UTC de terça = 20:00 em São Paulo → fechado, abre 08:00 de quarta (12h).
    expect(msAteAJanelaAbrir(COMERCIAL, new Date("2026-08-18T23:00:00Z"))).toBe(12 * 60 * 60_000);
  });
});
