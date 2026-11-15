/**
 * A PORTA `crm_set_appointment_status` É DA INTEGRAÇÃO POR TOKEN (#4515).
 *
 * Ela passa `desfechoPorToken: true` ao handler da agenda, que é a exceção que
 * deixa gravar comparecimento ou falta sem uma pessoa na Agenda. Essa exceção
 * vale para o token com `agenda:attendance`. O agente da casa (contexto sem
 * `tokenScopes`) segue a regra de `crm_set_appointment_outcome`: a presença
 * pede confirmação humana, e o handler nem é chamado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", async () => {
  const real = await vi.importActual<typeof import("@/app/api/v1/agenda/agendamentos/_handler")>(
    "@/app/api/v1/agenda/agendamentos/_handler",
  );
  return {
    ...real,
    alterarAgendamentoHandler: vi.fn(async () => ({
      id: "eeeeeeee-4515-4000-8000-00000000000e",
      status: "no_show",
      starts_at: "2026-11-14T13:00:00.000Z",
      ends_at: "2026-11-14T14:00:00.000Z",
    })),
  };
});

const { crmSetAppointmentStatus } = await import("@/lib/mcp/tools/agendamento");
const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");

const COMPROMISSO = "eeeeeeee-4515-4000-8000-00000000000e";

function contexto(extra: Record<string, unknown>) {
  return {
    supabase: { from: vi.fn() },
    organizationId: "aaaaaaaa-4516-4000-8000-00000000000a",
    actor: { type: "ai_agent", id: "agente-1" },
    requestId: "req-desfecho",
    ...extra,
  } as never;
}

describe("crm_set_appointment_status", () => {
  beforeEach(() => vi.mocked(alterarAgendamentoHandler).mockClear());

  it("o agente da casa (sem tokenScopes) não grava: pede confirmação humana", async () => {
    const r = await crmSetAppointmentStatus.handler(
      { appointment_id: COMPROMISSO, status: "no_show" },
      contexto({}),
    );
    expect(r).toMatchObject({ registrado: false, requer_confirmacao_humana: true });
    expect(alterarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("o token com agenda:attendance grava, com a exceção desfechoPorToken", async () => {
    const r = await crmSetAppointmentStatus.handler(
      { appointment_id: COMPROMISSO, status: "no_show" },
      contexto({ tokenScopes: ["mcp:write", "agenda:attendance"], apiTokenId: "tok-1" }),
    );
    expect(r).toMatchObject({ registrado: true });
    const chamada = vi.mocked(alterarAgendamentoHandler).mock.calls[0]?.[1] as
      | { desfechoPorToken?: boolean }
      | undefined;
    expect(chamada?.desfechoPorToken).toBe(true);
  });
});
