import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
  marcarAgendamentoHandler: vi.fn(),
}));
vi.mock("@/lib/agenda/consulta", async (original) => ({
  ...(await original<typeof import("@/lib/agenda/consulta")>()),
  idDoTipoPorSlug: vi.fn(),
}));
const h = await import("@/app/api/v1/agenda/agendamentos/_handler");
const consulta = await import("@/lib/agenda/consulta");
const tools = await import("@/lib/mcp/tools/agendamento");
const id = "99999999-0000-4000-8000-000000000001";
const r = {
  id,
  starts_at: "2030-07-03T20:00:00+00:00",
  ends_at: "2030-07-03T20:30:00+00:00",
  time_zone: "America/Sao_Paulo",
  revision: 2,
  status: "confirmed",
};
const ctx = {
  organizationId: "org",
  actor: { type: "ai_agent", id: "agent", role: "ai_operator" },
  supabase: {},
  requestId: "test",
} as unknown as McpContext;
beforeEach(() => {
  vi.mocked(h.alterarAgendamentoHandler).mockResolvedValue({ ...r });
  vi.mocked(h.cancelarAgendamentoHandler).mockResolvedValue({ ...r, status: "cancelled" });
  vi.mocked(h.marcarAgendamentoHandler).mockResolvedValue({ ...r });
  vi.mocked(consulta.idDoTipoPorSlug).mockResolvedValue({
    id,
    name: "Consulta",
    slug: "consulta",
  } as never);
});

describe("a escrita entrega a hora local sem alterar instantes ou estado", () => {
  it.each([
    [
      tools.crmRescheduleAppointment,
      { appointment_id: id, new_starts_at: r.starts_at },
      "remarcado",
      "confirmed",
    ],
    [
      tools.crmCancelAppointment,
      { appointment_id: id, reason: "Cliente pediu cancelamento" },
      "cancelado",
      "cancelled",
    ],
    [tools.crmConfirmAppointment, { appointment_id: id }, "confirmado", "confirmed"],
  ] as const)("$2", async (tool, args, flag, status) => {
    const resultado = (await tool.handler(args as never, ctx)) as Record<string, unknown>;
    expect(resultado[flag]).toBe(true);
    expect(resultado.compromisso).toMatchObject({
      ...r,
      status,
      quando: "quarta-feira 03/07 às 17:00",
      fim_quando: "quarta-feira 03/07 às 17:30",
    });
  });
  it("uma recusa de negócio não ganha horário nem sucesso fictício", async () => {
    const { ApiError } = await import("@/lib/api/types");
    vi.mocked(h.alterarAgendamentoHandler).mockRejectedValue(
      new ApiError(422, "agenda_horario_indisponivel", undefined, "test"),
    );
    const resultado = (await tools.crmRescheduleAppointment.handler(
      { appointment_id: id, new_starts_at: r.starts_at },
      ctx,
    )) as Record<string, unknown>;
    expect(resultado.remarcado).toBe(false);
    expect(resultado.compromisso).toBeUndefined();
    expect(resultado).not.toHaveProperty("quando");
  });
  it("a reserva pendente continua exigindo confirmação da equipe", async () => {
    vi.mocked(h.marcarAgendamentoHandler).mockResolvedValue({ ...r, status: "pending" });
    const resultado = (await tools.crmBookAppointment.handler(
      { event_type_slug: "consulta", starts_at: r.starts_at, contact_id: id },
      ctx,
    )) as Record<string, unknown>;
    expect(resultado.aguarda_confirmacao).toBe(true);
    expect(resultado.compromisso).toMatchObject({
      status: "pending",
      quando: "quarta-feira 03/07 às 17:00",
    });
    expect(resultado.mensagem).toContain("ainda NÃO está confirmado");
  });
});
