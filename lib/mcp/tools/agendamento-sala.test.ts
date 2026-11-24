/**
 * A sala escolhida em cada consulta: o agente acha horário com sala e marca
 * numa sala livre, sem gravar quando todas estão ocupadas.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const deps = vi.hoisted(() => ({
  marcar: vi.fn(),
  tipoPorSlug: vi.fn(),
  lerServico: vi.fn(),
  primeiroLugarLivre: vi.fn(),
  lugaresDoServico: vi.fn(),
}));

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: deps.marcar,
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));
vi.mock("@/lib/agenda/servicos/consulta", () => ({
  lerServico: deps.lerServico,
  primeiroLugarLivre: deps.primeiroLugarLivre,
  lugaresDoServico: deps.lugaresDoServico,
}));
vi.mock("@/lib/agenda/consulta", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@/lib/agenda/consulta")>();
  return {
    ...actual,
    idDoTipoPorSlug: deps.tipoPorSlug,
  };
});

import { crmBookAppointment } from "./agendamento";
import type { DadosDoServico } from "@/lib/agenda/servicos/consulta";

const ORG = "11111111-1111-4111-8111-111111111111";
const SALA_A = "20000000-0000-4000-8000-000000000001";
const SALA_B = "20000000-0000-4000-8000-000000000002";

const CTX = {
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "tipo-1", nome: "Consulta", service_enabled: true }, error: null }),
          }),
        }),
      }),
    }),
  },
  organizationId: ORG,
  actor: { type: "ai_agent", id: "a" },
  requestId: "r",
} as never;

type EntradaBase = {
  event_type_slug: string;
  starts_at: string;
  contact_id: string;
};

const ENTRADA_BASE: EntradaBase = {
  event_type_slug: "consulta",
  starts_at: "2026-12-01T12:00:00.000Z",
  contact_id: "22222222-2222-4222-8222-222222222222",
};

function compromisso(over: Record<string, unknown>) {
  return {
    id: "c1",
    starts_at: "2026-12-01T12:00:00.000Z",
    ends_at: "2026-12-01T13:00:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    meeting_state: "not_requested",
    service_space_id: over.service_space_id ?? null,
    ...over,
  };
}

const servicoComLugar: DadosDoServico = {
  event_type_id: "tipo-1", name: "Consulta", slug: "consulta", is_active: true, service_enabled: true,
  booking_mode: "individual", service_capacity: null, service_timezone: "America/Sao_Paulo",
  duration_minutes: 60, slot_interval_minutes: 60, service_revision: 1, requires_confirmation: false,
  destination_calendar_id: null, service_publication_mode: "none",
  schedule: [], professionals: [], resources: [], calendar_sources: [],
};

describe("crm_book_appointment — sala escolhida em cada consulta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.tipoPorSlug.mockResolvedValue({ id: "tipo-1", nome: "Consulta", servicoLigado: true });
    deps.lerServico.mockResolvedValue(servicoComLugar);
    deps.primeiroLugarLivre.mockResolvedValue({ livre: { id: SALA_B, name: "Sala B" }, motivo: null });
    deps.lugaresDoServico.mockReturnValue([
      { id: SALA_A, name: "Sala A", sector: null },
      { id: SALA_B, name: "Sala B", sector: null },
    ]);
  });

  it("sem space_id, marca na primeira sala livre", async () => {
    deps.marcar.mockResolvedValue(compromisso({ service_space_id: SALA_B }));

    const r = (await crmBookAppointment.handler(ENTRADA_BASE, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(r.lugar).toBe("Sala B");
    expect(deps.lerServico).toHaveBeenCalledTimes(1);
    expect(deps.primeiroLugarLivre).toHaveBeenCalledTimes(1);
    // O handler recebeu space_id da Sala B (A vem primeiro por nome, mas está ocupada).
    expect(deps.marcar).toHaveBeenCalledTimes(1);
    const args = deps.marcar.mock.calls[0]?.[2];
    expect(args?.space_id).toBe(SALA_B);
  });

  it("todas as salas ocupadas: não grava e devolve space_capacity_reached", async () => {
    deps.primeiroLugarLivre.mockResolvedValue({ livre: null, motivo: "space_capacity_reached" });

    const r = (await crmBookAppointment.handler(ENTRADA_BASE, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("space_capacity_reached");
    expect(deps.marcar).not.toHaveBeenCalled();
  });

  it("nenhuma sala livre por estar fora da programação: repassa outside_schedule, não 'lugar ocupado'", async () => {
    deps.primeiroLugarLivre.mockResolvedValue({ livre: null, motivo: "outside_schedule" });

    const r = (await crmBookAppointment.handler(ENTRADA_BASE, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("outside_schedule");
    expect(String(r.mensagem)).toContain("Fora da programação");
    expect(deps.marcar).not.toHaveBeenCalled();
  });

  it("space_id dado é repassado sem troca", async () => {
    vi.clearAllMocks();
    deps.marcar.mockResolvedValue(compromisso({ service_space_id: SALA_A }));

    const r = (await crmBookAppointment.handler({ ...ENTRADA_BASE, space_id: SALA_A }, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(deps.primeiroLugarLivre).not.toHaveBeenCalled();
    const args = deps.marcar.mock.calls[0]?.[2];
    expect(args?.space_id).toBe(SALA_A);
  });

  it("tipo sem lugar marca como hoje, sem space_id", async () => {
    vi.clearAllMocks();
    deps.lerServico.mockResolvedValue({ ...servicoComLugar, resources: [] });
    deps.lugaresDoServico.mockReturnValue([]);
    deps.marcar.mockResolvedValue(compromisso({ service_space_id: null }));

    const r = (await crmBookAppointment.handler(ENTRADA_BASE, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(r.lugar).toBeUndefined();
    const args = deps.marcar.mock.calls[0]?.[2];
    expect(args?.space_id).toBeUndefined();
  });

  it("tipo comum (servicoLigado falso) marca sem chamar lerServico", async () => {
    deps.tipoPorSlug.mockResolvedValue({ id: "tipo-2", nome: "Consulta comum", servicoLigado: false });
    deps.marcar.mockResolvedValue(compromisso({ service_space_id: null }));

    const r = (await crmBookAppointment.handler({ ...ENTRADA_BASE, event_type_slug: "consulta-comum" }, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(deps.lerServico).not.toHaveBeenCalled();
    expect(deps.marcar).toHaveBeenCalledTimes(1);
  });

  it("tipo sem servicoLigado não chama lerServico", async () => {
    deps.tipoPorSlug.mockResolvedValue({ id: "tipo-3", nome: "Sem flag" });
    deps.marcar.mockResolvedValue(compromisso({ service_space_id: null }));

    const r = (await crmBookAppointment.handler(ENTRADA_BASE, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(deps.lerServico).not.toHaveBeenCalled();
    expect(deps.marcar).toHaveBeenCalledTimes(1);
  });
});
