import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ cancel: vi.fn(), marcar: vi.fn() }));

// Mocka só os handlers da agenda; a ferramenta real (crmCancelAppointment/crmBookAppointment) e a ponte seguem reais.
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: fake.cancel,
  marcarAgendamentoHandler: fake.marcar,
}));

// O banco é mockado. O tipo da marcação vem de calendar_event_types no banco fake.
const tipoId = "44444444-4444-4444-8444-444444444444";

import { pickToolsFromMcp } from "./tools";
import { criarEfeitoDasEscrituras } from "./efeito-das-escritas";
import { conferirRecibosDeAgendamento } from "./recibos-de-agendamento";
import type { McpContext } from "@/lib/mcp/types";
import type { McpAuthResult } from "@/lib/mcp/auth";

const org = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const appointmentId = "11111111-1111-4111-8111-111111111111";
const confirmadoId = "12121212-1212-4212-8212-121212121212";

const calendarBase = {
  organization_id: org,
  contact_id: contactId,
  event_type_id: tipoId,
  time_zone: "America/Sao_Paulo",
  location_kind: "in_person",
  location_details: null,
  participant_name: null,
  service_requires_confirmation: false,
  service_confirmed_by_user_id: null,
  service_confirmed_at: null,
  owner_user_id: null,
  calendar_appointment_responsibles: [],
  calendar_event_types: { id: tipoId, organization_id: org, name: "Consulta inicial" },
};

// Mock do cancelamento: a linha como o banco devolve (id,status,starts_at,ends_at,revision,time_zone).
const canceladoRow = {
  id: appointmentId,
  status: "cancelled",
  starts_at: "2026-12-10T13:00:00Z",
  ends_at: "2026-12-10T13:30:00Z",
  revision: 2,
  time_zone: "America/Sao_Paulo",
};
const confirmadoRow = {
  id: confirmadoId,
  status: "confirmed",
  starts_at: "2026-12-11T13:00:00Z",
  ends_at: "2026-12-11T13:30:00Z",
  revision: 1,
  time_zone: "America/Sao_Paulo",
};

function fakeSupabase() {
  const appointment = { id: appointmentId };
  return {
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        is: () => q,
        in: () => q,
        data: [],
        error: null,
        maybeSingle: async () => ({
          data:
            table === "calendar_appointments"
              ? appointment
              : table === "calendar_event_types"
                ? { id: tipoId, name: "Consulta inicial", service_enabled: false }
                : null,
          error: null,
        }),
      };
      return q;
    },
  };
}

// Banco da conferência: devolve as linhas completas de calendar_appointments.
function bancoConferencia(rows: unknown[]) {
  const q = { select: vi.fn(() => q), eq: vi.fn(() => q), in: vi.fn(async () => ({ data: rows, error: null })) };
  return { from: vi.fn(() => q), rpc: vi.fn(async () => ({ data: [], error: null })) };
}

describe("caso da issue: ponte real crm_cancel_appointment → crm_book_appointment → conferirRecibosDeAgendamento", () => {
  beforeEach(() => {
    fake.cancel.mockReset();
    fake.marcar.mockReset();
  });

  it("saem as duas evidências (cancelled e confirmed)", async () => {
    fake.cancel.mockResolvedValue(canceladoRow);
    fake.marcar.mockResolvedValue(confirmadoRow);

    const efeitos = criarEfeitoDasEscrituras();
    const supabase = fakeSupabase();
    const ctx = {
      organizationId: org,
      requestId: "turno-sintetico",
      supabase,
      role: "ai_operator",
      actor: { type: "ai_agent", id: "agente-sintetico" },
    } as unknown as McpContext;
    const auth = { role: "ai_operator", scopes: ["mcp:write"] } as McpAuthResult;

    const tools = pickToolsFromMcp({
      ctx,
      auth,
      supabase: supabase as never,
      contatoDoTurno: contactId,
      toolIds: ["crm_cancel_appointment", "crm_book_appointment"],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      efeitos,
    });

    // 1) cancelar
    const cancelTool = tools.crm_cancel_appointment!;
    await cancelTool.execute!(
      { appointment_id: appointmentId, reason: "cliente pediu para desmarcar" },
      { toolCallId: "c1", messages: [], context: {} },
    );

    // 2) marcar
    const bookTool = tools.crm_book_appointment!;
    await bookTool.execute!(
      { event_type_slug: "consulta-inicial", starts_at: "2026-12-11T13:00:00Z", contact_id: contactId },
      { toolCallId: "c2", messages: [], context: {} },
    );

    // 3) conferir com os recibos do coletor
    const recibos = efeitos.recibosDeAgendamento();
    expect(recibos.some((r) => r.status === "cancelled" && r.id === appointmentId)).toBe(true);
    expect(recibos.some((r) => r.status === "confirmed" && r.id === confirmadoId)).toBe(true);

    const admin = bancoConferencia([
      { ...calendarBase, ...canceladoRow, id: appointmentId, status: "cancelled" },
      { ...calendarBase, ...confirmadoRow, id: confirmadoId, status: "confirmed" },
    ]);
    const evidencias = await conferirRecibosDeAgendamento(
      admin as never,
      { organizationId: org, contactId },
      recibos,
    );

    expect(evidencias).toHaveLength(2);
    expect(evidencias.some((e) => e.status === "cancelled" && e.id === appointmentId)).toBe(true);
    expect(evidencias.some((e) => e.status === "confirmed" && e.id === confirmadoId)).toBe(true);
    // profissionais resolvidos uma única vez, no final
    expect(admin.rpc).toHaveBeenCalledTimes(0);
  });
});
