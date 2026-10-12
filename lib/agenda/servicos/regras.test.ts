import { describe, expect, it } from "vitest";
import { capacidadeEfetiva, candidatosDoServico, configuracaoDoServicoSchema, horarioDoServicoSchema, horarioEfetivo, type RegraDoServico } from "./regras";

const servico: RegraDoServico = { booking_mode: "collective_unlimited", service_capacity: null, service_timezone: "America/Sao_Paulo", duration_minutes: 40 };
const semanal = horarioDoServicoSchema.parse({ weekday: 2, timing_kind: "fixed", start_minute: 840 });
const periodo = [new Date("2026-10-13T00:00:00Z"), new Date("2026-10-15T00:00:00Z")] as const;
describe("programação de um serviço", () => {
  it("rascunho não exige oferta pronta, mas ativação exige horário e profissional individual", () => {
    const draft = { event_type_id: "10000000-0000-4000-8000-000000000001", expected_revision: 1, service_enabled: true, is_active: false,
      booking_mode: "individual", service_timezone: servico.service_timezone, professionals: [], resources: [], calendar_sources: [], schedule: [] };
    expect(configuracaoDoServicoSchema.safeParse(draft).success).toBe(true);
    expect(configuracaoDoServicoSchema.safeParse({ ...draft, is_active: true }).success).toBe(false);
  });
  it("produz instante local e duração sem exigir dono fictício", () => {
    expect(candidatosDoServico(servico, [semanal], ...periodo)).toEqual([
      { starts_at: "2026-10-13T17:00:00.000Z", ends_at: "2026-10-13T17:40:00.000Z", duration_minutes: 40, capacity_rule: "inherit", capacity_limit: null },
    ]);
  });
  it("exceção da data vence só o horário declarado", () => {
    const extra = horarioDoServicoSchema.parse({ on_date: "2026-10-13", timing_kind: "fixed", start_minute: 840, capacity_rule: "limited", capacity_limit: 5 });
    const outro = horarioDoServicoSchema.parse({ ...semanal, start_minute: 900 });
    expect(candidatosDoServico(servico, [semanal, extra, outro], ...periodo).map((r) => r.capacity_limit)).toEqual([5, null]);
    expect(horarioEfetivo([semanal, extra], "2026-10-20", 2, 840)).toEqual(semanal);
  });
  it("herda limite e permite exceção sem limite", () => {
    const limitado = { ...servico, booking_mode: "collective_limited" as const, service_capacity: 3 };
    expect(capacidadeEfetiva(limitado, semanal)).toBe(3);
    expect(capacidadeEfetiva(limitado, { ...semanal, capacity_rule: "unlimited" })).toBeNull();
    expect(capacidadeEfetiva({ ...limitado, booking_mode: "individual" }, { ...semanal, capacity_rule: "unlimited" })).toBe(1);
  });
  it("faixa não oferece início que ultrapassa seu fim", () => {
    const janela = horarioDoServicoSchema.parse({ weekday: 2, timing_kind: "window", start_minute: 840, end_minute: 930 });
    expect(candidatosDoServico(servico, [janela], ...periodo).map((r) => r.starts_at)).toEqual(["2026-10-13T17:00:00.000Z", "2026-10-13T17:40:00.000Z"]);
  });
  it("programação concorrente ambígua não cria oferta", () => {
    expect(candidatosDoServico(servico, [semanal, { ...semanal, capacity_rule: "limited", capacity_limit: 5 }], ...periodo)).toEqual([]);
  });
  it("rejeita exceção individual que permitiria capacidade coletiva", () => {
    const config = { event_type_id: "10000000-0000-4000-8000-000000000001", expected_revision: 1, service_enabled: false, booking_mode: "individual", service_timezone: servico.service_timezone, professionals: [], resources: [], calendar_sources: [], schedule: [{ ...semanal, capacity_rule: "unlimited" }] };
    expect(configuracaoDoServicoSchema.safeParse(config).success).toBe(false);
  });
  it("não interpreta dia UTC como dia da regra", () => {
    const noite = horarioDoServicoSchema.parse({ weekday: 2, timing_kind: "fixed", start_minute: 1320 });
    const rows = candidatosDoServico(servico, [noite], new Date("2026-10-14T00:00:00Z"), new Date("2026-10-14T03:00:00Z"));
    expect(rows[0]?.starts_at).toBe("2026-10-14T01:00:00.000Z");
  });
});
