import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpContext } from "../types";
import { extrairRecibosDeAgendamento, ESCRITAS_DE_AGENDAMENTO } from "@/lib/ai/runtime/recibos-de-agendamento";

const domain = vi.hoisted(() => ({ execute: vi.fn(), link: vi.fn() }));
vi.mock("@/lib/amigo/service", () => ({ executeAmigo: domain.execute, linkAmigoPatient: domain.link }));
import { amigoTools } from "./amigo";
import { TOOLS_AMIGO } from "./catalogo/amigo";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const LOCAL = "44444444-4444-4444-8444-444444444444";
const appointment = { id: LOCAL, status: "confirmed", starts_at: "2026-11-09T12:00:00Z", ends_at: "2026-11-09T12:30:00Z", revision: 2 };
function context(overrides: Partial<McpContext> = {}): McpContext {
  return { organizationId: ORG, role: "ai_operator", actor: { type: "ai_agent", id: "run", role: "ai_operator" }, requestId: "request", sourceJobId: "job", apiTokenId: "api", contatoDoTurno: CONTACT, supabase: {} as never, ...overrides };
}
function tool(operation: string) { return amigoTools.find(t => t.name === `crm_amigo_${operation}`)!; }
async function call(operation: string, args: Record<string, unknown>, ctx = context()) { return tool(operation).handler(args, ctx); }
const booking = { contact_id: CONTACT, patient_id: 12, event_id: 3, user_id: 4, place_id: 5, start_date: "2026-11-09 09:00" };

beforeEach(() => { vi.clearAllMocks(); domain.execute.mockResolvedValue({ data: [] }); domain.link.mockResolvedValue({ contact_id: CONTACT, patient: { id: 12 } }); });

describe("Amigo MCP — contexto e recursos", () => {
  it.each(["patient_get", "patient_update", "patient_attendances"])("recusa contato alheio em %s antes do domínio", async operation => {
    const result = await call(operation, { contact_id: OTHER, patientId: 12, patient_id: 12, name: "Pessoa" });
    expect(result).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(domain.execute).not.toHaveBeenCalled();
  });
  it("automação sem contato de confiança não pode escolher seu próprio escopo", async () => {
    expect(await call("patient_get", { contact_id: CONTACT, patientId: 12 }, context({ contatoDoTurno: undefined }))).toMatchObject({ permitido: false });
    expect(domain.execute).not.toHaveBeenCalled();
  });
  it.each(["patient_birthdays", "attendances"])("bloqueia exploração global %s mesmo para automação admin", async operation => {
    expect(await call(operation, { date: "11-06", start_date: "2026-11-06", end_date: "2026-11-07" }, context({ role: "admin" }))).toMatchObject({ permitido: false });
    expect(domain.execute).not.toHaveBeenCalled();
    expect(TOOLS_AMIGO.find(t => t.name === `crm_amigo_${operation}`)?.apenasHumano).toBe(true);
  });
  it("agenda geral exige gestão mesmo na chamada direta de uma pessoa", async () => {
    const human = context({ actor: { type: "user", id: "person" }, role: "agent", contatoDoTurno: undefined });
    expect(await call("attendances", { start_date: "2026-11-06", end_date: "2026-11-07" }, human)).toMatchObject({ permitido: false });
    expect(domain.execute).not.toHaveBeenCalled();
  });
  it("passa papel, ator e contato confiáveis ao domínio que verifica o ID externo", async () => {
    domain.execute.mockRejectedValue(Object.assign(new Error("sensitive provider body"), { code: "amigo_scope_denied", status: 403 }));
    const result = await call("patient_get", { contact_id: CONTACT, patientId: 99 });
    expect(domain.execute).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, contactId: CONTACT, role: "ai_operator", actor: context().actor }), "patient_get", { patientId: 99 }, undefined);
    expect(result).toMatchObject({ permitido: false });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
  it("retorna candidatos sem vincular nem escolher o primeiro paciente", async () => {
    domain.execute.mockResolvedValue({ data: [{ id: 12, name: "Dependente A" }, { id: 13, name: "Dependente B" }] });
    const result = await call("patient_search", { contact_id: CONTACT, contact_cellphone: "11988887777" });
    expect(result).toMatchObject({ data: [{ id: 12 }, { id: 13 }], exige_selecao_explicita: true });
    expect(domain.link).not.toHaveBeenCalled();
  });
  it("vínculo exige escolha explícita e usa o domínio sem escrita delegada", async () => {
    expect(z.object(tool("link_patient").inputSchema).safeParse({ contact_id: CONTACT }).success).toBe(false);
    await call("link_patient", { connection_id:"current", contact_id: CONTACT, patient_id: 13 });
    expect(domain.link).toHaveBeenCalledWith(expect.objectContaining({ contactId: CONTACT }), { contact_id: CONTACT, patient_id: 13, connection_id:"current" });
    expect(tool("link_patient").escritaDelegadaAoContato).toBeUndefined();
  });
  it("catálogo cobre cada operação com handler, sem proxy de HTTP", () => {
    const operations = ["patient_search", "patient_get", "patient_create", "patient_update", "patient_doctors", "patient_birthdays", "insurances", "insurance_plans", "insurance_products", "doctors", "doctors_available", "specialties", "doctor_dates", "attendance_create", "attendances", "patient_attendances", "attendance_cancel", "attendance_status", "attendance_reschedule", "places", "events", "calendar", "link_patient"];
    expect(amigoTools.map(t => t.name).sort()).toEqual(operations.map(o => `crm_amigo_${o}`).sort());
    expect(TOOLS_AMIGO.map(t => t.name).sort()).toEqual(amigoTools.map(t => t.name).sort());
    for (const t of amigoTools) expect(Object.keys(t.inputSchema)).not.toEqual(expect.arrayContaining(["url", "headers"]));
  });
  it("mantém filtros dependentes nos catálogos e recusa produto sem convênio", async () => {
    const input = { place_id: 2, event_id: 3, insurance_id: 4, insurance_product_id: 5 };
    await call("doctors_available", input);
    expect(domain.execute).toHaveBeenCalledWith(expect.anything(), "doctors_available", input, undefined);
    expect(await call("doctors_available", { place_id: 2, insurance_product_id: 5 })).toMatchObject({ error: expect.any(String) });
    expect(domain.execute).toHaveBeenCalledTimes(1);
  });
  it("redige PII em todas as ferramentas antes da auditoria", () => {
    for (const t of amigoTools) {
      const audit = JSON.stringify(t.redigirParaAuditoria!({ name: "Nome privado", cpf: "12345678900", email: "privado@example.test", contact_cellphone: "11987654321", mother_name: "Mãe privada" }));
      for (const value of ["Nome privado", "12345678900", "privado@example.test", "11987654321", "Mãe privada"]) expect(audit).not.toContain(value);
    }
  });
});

describe("Amigo MCP — comprovante real de consulta", () => {
  function db(row: unknown, error: unknown = null) {
    const filters: Record<string, unknown> = {};
    const chain = { select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; }, maybeSingle: async () => ({ data: filters.organization_id === ORG && filters.contact_id === CONTACT && filters.id === LOCAL && filters.authority === "amigo" ? row : null, error }) };
    return { from: (table: string) => { expect(table).toBe("calendar_appointments"); return chain; } } as never;
  }
  it("sucesso remoto só gera o recibo já usado pelo runtime depois da projeção local", async () => {
    domain.execute.mockResolvedValue({ data: { id: 71 }, state: "confirmed", local_appointment_id: LOCAL, operation_id: "op" });
    const result = await call("attendance_create", booking, context({ supabase: db(appointment) }));
    expect(result).toMatchObject({ marcado: true, compromisso: appointment, attendance_id: 71 });
    expect(extrairRecibosDeAgendamento(result)).toEqual([appointment]);
    expect(ESCRITAS_DE_AGENDAMENTO.has("crm_amigo_attendance_create")).toBe(true);
  });
  it.each(["uncertain", "projection_pending", "sent", "prepared", "rejected"])("%s não vira sucesso nem comprovante", async state => {
    domain.execute.mockResolvedValue({ data: { id: 71 }, state, local_appointment_id: LOCAL, operation_id: "op" });
    const result = await call("attendance_create", booking, context({ supabase: db(appointment) }));
    expect(extrairRecibosDeAgendamento(result)).toEqual([]);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("marcado", true);
  });
  it.each([null, { ...appointment, status: "pending" }, { ...appointment, revision: 0 }])("sem evidência local válida não promete marcação: %j", async row => {
    domain.execute.mockResolvedValue({ data: { id: 71 }, state: "confirmed", local_appointment_id: LOCAL });
    expect(await call("attendance_create", booking, context({ supabase: db(row) }))).toMatchObject({ resultado_incerto: true });
  });
  it("falha ao reler projeção confirmada exige conferência humana, sem repetir mutação", async () => {
    domain.execute.mockResolvedValue({ data: { id: 71 }, state: "confirmed", local_appointment_id: LOCAL });
    const broken = { from: () => { throw new Error("connection lost"); } } as never;
    expect(await call("attendance_create", booking, context({ supabase: broken }))).toMatchObject({ resultado_incerto: true });
    expect(domain.execute).toHaveBeenCalledTimes(1);
  });
  it("usa chave estável do job e diferencia comandos com payloads diferentes", async () => {
    await call("patient_update", { contact_id: CONTACT, patientId: 12, name: "A" });
    await call("patient_update", { contact_id: CONTACT, patientId: 12, name: "A" }, context({ requestId: "other-request" }));
    await call("patient_update", { contact_id: CONTACT, patientId: 12, name: "B" });
    const keys = domain.execute.mock.calls.map(c => c[3]);
    expect(keys[0]).toBeTruthy(); expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).not.toContain('"A"');
  });
  it("não altera consulta de outro paciente selecionado mesmo no mesmo responsável", async () => {
    domain.execute.mockResolvedValue({ data: [{ id: 72, patient_id: 13 }] });
    expect(await call("attendance_cancel", { contact_id: CONTACT, patient_id: 12, id: 71 })).toMatchObject({ permitido: false });
    expect(domain.execute.mock.calls.map(c => c[1])).toEqual(["patient_attendances"]);
  });
});
