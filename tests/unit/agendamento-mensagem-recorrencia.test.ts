import { describe, expect, it } from "vitest";
import {
  motivoRegraInvalida,
  primeiraOcorrencia,
  proximaOcorrenciaDepois,
  type RegraDeRecorrencia,
} from "@/lib/agendamento-mensagem/recorrencia";

const TZ = "America/Cuiaba"; // UTC-4 fixo, sem horário de verão
const regra = (over: Partial<RegraDeRecorrencia>): RegraDeRecorrencia => ({
  recorrencia: "semanal",
  inicio: "2026-11-06T09:00",
  tz: TZ,
  ...over,
});
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("primeiraOcorrencia", () => {
  it("converte a hora de parede do fuso para UTC", () => {
    expect(iso(primeiraOcorrencia(regra({})))).toBe("2026-11-06T13:00:00.000Z");
  });
});

describe("proximaOcorrenciaDepois", () => {
  it("semanal avança 7 dias a partir da âncora", () => {
    const r = regra({ recorrencia: "semanal" });
    expect(iso(proximaOcorrenciaDepois(r, new Date("2026-11-06T13:00:00Z")))).toBe("2026-11-13T13:00:00.000Z");
  });

  it("diária, quinzenal e a cada N dias", () => {
    const depois = new Date("2026-11-06T13:00:00Z");
    expect(iso(proximaOcorrenciaDepois(regra({ recorrencia: "diaria" }), depois))).toBe("2026-11-07T13:00:00.000Z");
    expect(iso(proximaOcorrenciaDepois(regra({ recorrencia: "quinzenal" }), depois))).toBe("2026-11-20T13:00:00.000Z");
    expect(
      iso(proximaOcorrenciaDepois(regra({ recorrencia: "a_cada_n_dias", intervalo_dias: 5 }), depois)),
    ).toBe("2026-11-11T13:00:00.000Z");
  });

  it("mensal não encolhe o dia: âncora dia 31 cai no último dia de fevereiro e volta ao 31", () => {
    const r = regra({ recorrencia: "mensal", inicio: "2026-01-31T09:00" });
    const fev = proximaOcorrenciaDepois(r, new Date("2026-01-31T13:00:00Z"));
    expect(iso(fev)).toBe("2026-02-28T13:00:00.000Z");
    expect(iso(proximaOcorrenciaDepois(r, fev!))).toBe("2026-03-31T13:00:00.000Z");
  });

  it("trimestral, semestral e anual", () => {
    const base = regra({ inicio: "2026-01-15T09:00" });
    const depois = new Date("2026-01-15T13:00:00Z");
    expect(iso(proximaOcorrenciaDepois({ ...base, recorrencia: "trimestral" }, depois))).toBe("2026-04-15T13:00:00.000Z");
    expect(iso(proximaOcorrenciaDepois({ ...base, recorrencia: "semestral" }, depois))).toBe("2026-07-15T13:00:00.000Z");
    expect(iso(proximaOcorrenciaDepois({ ...base, recorrencia: "anual" }, depois))).toBe("2027-01-15T13:00:00.000Z");
  });

  it("pula ocorrências perdidas quando o worker ficou parado (sem rajada)", () => {
    const r = regra({ recorrencia: "diaria" });
    expect(iso(proximaOcorrenciaDepois(r, new Date("2026-11-10T14:00:00Z")))).toBe("2026-11-11T13:00:00.000Z");
  });

  it("para depois do término e não gera ocorrência após ele", () => {
    const r = regra({ recorrencia: "diaria", termino: "2026-11-07T09:00" });
    expect(iso(proximaOcorrenciaDepois(r, new Date("2026-11-06T13:00:00Z")))).toBe("2026-11-07T13:00:00.000Z");
    expect(proximaOcorrenciaDepois(r, new Date("2026-11-07T13:00:00Z"))).toBeNull();
  });

  it("envio único: devolve a própria data uma vez e depois nada", () => {
    const r = regra({ recorrencia: "nenhuma" });
    expect(iso(proximaOcorrenciaDepois(r, new Date("2026-11-06T12:00:00Z")))).toBe("2026-11-06T13:00:00.000Z");
    expect(proximaOcorrenciaDepois(r, new Date("2026-11-06T13:00:00Z"))).toBeNull();
  });

  it("respeita o fuso: 09:00 de Cuiabá não é 09:00 UTC", () => {
    const r = regra({ recorrencia: "diaria" });
    expect(iso(primeiraOcorrencia(r))).not.toBe("2026-11-06T09:00:00.000Z");
  });
});

describe("motivoRegraInvalida", () => {
  it("aceita as opções da tela", () => {
    expect(motivoRegraInvalida(regra({ recorrencia: "trimestral" }))).toBeNull();
    expect(motivoRegraInvalida(regra({ recorrencia: "a_cada_n_dias", intervalo_dias: 3 }))).toBeNull();
  });
  it("recusa N dias fora de 1..365 e término anterior ao início", () => {
    expect(motivoRegraInvalida(regra({ recorrencia: "a_cada_n_dias", intervalo_dias: 0 }))).toBe("intervalo_dias_invalido");
    expect(motivoRegraInvalida(regra({ recorrencia: "a_cada_n_dias", intervalo_dias: null }))).toBe("intervalo_dias_invalido");
    expect(motivoRegraInvalida(regra({ termino: "2026-11-01T09:00" }))).toBe("termino_antes_do_inicio");
  });
  it("recusa data mal formada", () => {
    expect(motivoRegraInvalida(regra({ inicio: "06/11/2026 09:00" }))).toBe("data_local_invalida");
  });
});
