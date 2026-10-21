import { describe, it, expect } from "vitest";
import {
  calendarPresentationSchema,
  initialCalendarService,
  calendarServiceMatches,
} from "./calendar-presentation";
describe("recorte visual da agenda", () => {
  const types = [{ id: "consulta" }, { id: "retorno" }];
  it("Todos nasce somente na contribuição; URL explícita prevalece e Padrão conserva sua entrada", () => {
    expect(initialCalendarService(null, types, true)).toBeNull();
    expect(initialCalendarService("retorno", types, true)).toBe("retorno");
    expect(initialCalendarService("todos", types, true)).toBeNull();
    expect(initialCalendarService("todos", types, false)).toBe("consulta");
    expect(initialCalendarService(null, types, false)).toBe("consulta");
    expect(initialCalendarService("removido", types, true)).toBe("consulta");
  });
  it("não perde serviço desconhecido em Todos nem ocupação externa ao filtrar um serviço", () => {
    expect(calendarServiceMatches({ origem: "ui" }, null)).toBe(true);
    expect(calendarServiceMatches({ origem: "google_sync" }, "consulta")).toBe(true);
    expect(calendarServiceMatches({ origem: "ui", tipoSlug: "retorno" }, "consulta")).toBe(false);
    expect(calendarServiceMatches({ origem: "ui", tipoSlug: "consulta" }, "consulta")).toBe(true);
  });
  it("não recebe política, disponibilidade ou comandos de reserva no manifesto", () => {
    expect(
      calendarPresentationSchema.safeParse({ allServices: true, periodList: true }).success,
    ).toBe(true);
    expect(calendarPresentationSchema.safeParse({ available: true }).success).toBe(false);
  });
});
