import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpContext } from "../types";
const deps = vi.hoisted(() => ({ types: vi.fn(), free: vi.fn(), list: vi.fn(), type: vi.fn(), book: vi.fn() }));
vi.mock("@/lib/agenda/consulta", () => ({ listaTiposDeAtendimento: deps.types, horariosLivresDaOrg: deps.free, listaAgendamentos: deps.list, idDoTipoPorSlug: deps.type, MAXIMO_DE_DIAS: 62 }));
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({ marcarAgendamentoHandler: deps.book, alterarAgendamentoHandler: vi.fn(), cancelarAgendamentoHandler: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentesCom: async () => new Map() }));
import { crmBookAppointment, crmFindFreeSlots, crmFindAndBookAppointment, crmListAppointments, crmListEventTypes } from "./agendamento";
import { ApiError } from "@/lib/api/types";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const ctx = { organizationId: "org", role: "ai_operator", actor: { type: "ai_agent", id: "run", role: "ai_operator" }, contatoDoTurno: CONTACT, requestId: "request", supabase: {} } as McpContext;
const provider = { provider: "amigo", provider_context: { connection_id: "connection", path: "/app/integrations/amigo", required: ["patient_id", "place_id", "user_id", "event_id"] } };
const amigo = { patient_id: 12, user_id: 3, place_id: 4, insurance_id: 5, insurance_product_id: 6 };
const input = { event_type_slug: "amigo-consulta", starts_at: "2026-12-01T12:00:00Z", contact_id: CONTACT, amigo };
beforeEach(() => { vi.clearAllMocks(); deps.type.mockResolvedValue({ id: "local-type" }); deps.book.mockResolvedValue({ id: "local", status: "confirmed", authority: "amigo" }); });
describe("ferramentas existentes preservam a autoridade Amigo", () => {
  it("o schema e o mapeamento da marcação preservam paciente, unidade, médico e convênio", async () => {
    const parsed = z.object(crmBookAppointment.inputSchema).parse(input);
    expect(parsed).toMatchObject({ amigo });
    await crmBookAppointment.handler(parsed, ctx);
    expect(deps.book.mock.calls[0]?.[2]).toMatchObject({ amigo, event_type_id: "local-type", contact_id: CONTACT });
    expect(z.object(crmFindAndBookAppointment.inputSchema).parse({ ...input, dia: "2026-12-01", horario: "09:00" })).toMatchObject({ amigo });
  });
  it("o papel enviado ao domínio vem do contexto autenticado, mesmo se não vier no ator", async () => {
    await crmBookAppointment.handler(input, { ...ctx, actor: { type: "user", id: "person" }, role: "manager" });
    expect(deps.book.mock.calls[0]?.[1].actor).toMatchObject({ type: "user", id: "person", role: "manager" });
  });
  it("a consulta de tipos conserva a conexão e os IDs externos do atendimento", async () => {
    deps.types.mockResolvedValue({ ok: true, ...provider, tipos: [{ slug: "amigo-consulta", nome: "Consulta", descricao: null, duracaoMin: 30, localKind: "in_person", localDetalhes: "Unidade", precisaConfirmacao: false, external_provider: "amigo", external_id: "7", external_connection_id: "connection" }] });
    expect(await crmListEventTypes.handler({}, ctx)).toMatchObject({ ...provider, tipos: [{ external_provider: "amigo", external_id: "7", external_connection_id: "connection" }] });
  });
  it("a ausência de contexto nas duas consultas retorna o próximo passo do provedor", async () => {
    deps.free.mockResolvedValue({ ok: false, codigo: "amigo_context_required", motivoParaCliente: "Selecione o paciente", ...provider });
    expect(await crmFindFreeSlots.handler({ event_type_slug: "amigo-consulta" }, ctx)).toMatchObject({ ...provider, motivo: "amigo_context_required" });
    expect(await crmFindAndBookAppointment.handler({ event_type_slug: "amigo-consulta", contact_id: CONTACT, dia: "2026-12-01", horario: "09:00", amigo }, ctx)).toMatchObject({ ...provider, marcado: false, motivo: "amigo_context_required" });
    expect(deps.book).not.toHaveBeenCalled();
  });
  it("a lista conserva autoridade e estado remoto, sem traduzir chegada em comparecimento", async () => {
    deps.list.mockResolvedValue({ ok: true, agendamentos: [{ id: "local", titulo: "Consulta", iniciaEm: "2026-12-01T12:00:00Z", terminaEm: "2026-12-01T12:30:00Z", fuso: "America/Fortaleza", situacao: "confirmed", donoId: null, contatoId: CONTACT, authority: "amigo", external_status: "arrived", external_connection_id: "connection" }] });
    expect(await crmListAppointments.handler({}, ctx)).toMatchObject({ compromissos: [{ authority: "amigo", external_status: "arrived", external_connection_id: "connection" }] });
  });
  it("falta de contexto e resultado incerto não viram confirmação nem conselho genérico", async () => {
    deps.book.mockRejectedValue(new ApiError(422, "agenda_amigo_context_required", undefined, "r", "sensitive raw provider text"));
    const missing = await crmBookAppointment.handler(input, ctx);
    expect(missing).toMatchObject({ marcado: false, motivo: "agenda_amigo_context_required", mensagem: expect.stringMatching(/paciente.*unidade/i) });
    expect(JSON.stringify(missing)).not.toContain("sensitive");
    deps.book.mockRejectedValue(new ApiError(409, "agenda_amigo_unconfirmed", { operation_id: "op", state: "projection_pending" }, "r"));
    expect(await crmBookAppointment.handler(input, ctx)).toMatchObject({ marcado: false, resultado_incerto: true, operation_id: "op" });
  });
});
