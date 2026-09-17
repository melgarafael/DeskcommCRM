/**
 * Marcar NÃO é confirmar, e a tool tem que dizer isso ao modelo.
 *
 * O defeito: num tipo com `requires_confirmation`, o handler cria o compromisso
 * em `pending` — o horário fica reservado, mas alguém da equipe ainda precisa
 * aprovar. A única pista disso era `status: "pending"` enterrado dentro de
 * `compromisso`, enquanto a DESCRIÇÃO da tool dizia "o cliente conta com ele" e
 * o bloco de sistema da agenda mandava dizer que está confirmado depois de
 * marcar. O produto ensinava o modelo a afirmar uma confirmação que ninguém deu.
 *
 * O caso que mais importa é o terceiro: os dois "pending" deste retorno são
 * coisas DIFERENTES com o mesmo nome (`status` do compromisso, `meeting_state`
 * do link do Meet). Confundi-los daria o aviso errado.
 */
import { describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ marcar: vi.fn(), tipoPorSlug: vi.fn() }));

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: deps.marcar,
  horariosLivresHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

import { crmBookAppointment } from "./agendamento";

const CTX = {
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "tipo-1" }, error: null }),
          }),
        }),
      }),
    }),
  },
  organizationId: "11111111-1111-4111-8111-111111111111",
  actor: { type: "ai_agent", id: "a" },
  requestId: "r",
} as never;

const ENTRADA = {
  event_type_slug: "consulta",
  starts_at: "2026-12-01T12:00:00.000Z",
  contact_id: "22222222-2222-4222-8222-222222222222",
} as never;

function compromisso(over: Record<string, unknown>) {
  return {
    id: "c1",
    starts_at: "2026-12-01T12:00:00.000Z",
    ends_at: "2026-12-01T13:00:00.000Z",
    time_zone: "America/Sao_Paulo",
    revision: 1,
    meeting_state: "not_requested",
    ...over,
  };
}

describe("crm_book_appointment — marcado não é confirmado", () => {
  it("pendente avisa que AINDA NÃO está confirmado", async () => {
    deps.marcar.mockResolvedValue(compromisso({ status: "pending" }));

    const r = (await crmBookAppointment.handler(ENTRADA, CTX)) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(r.aguarda_confirmacao).toBe(true);
    const msg = String(r.mensagem);
    expect(msg).toContain("RESERVADO");
    expect(msg).toContain("NÃO está confirmado");
    // A instrução precisa nomear o que NÃO dizer, senão o modelo escolhe sozinho.
    expect(msg).toContain("Não diga que está confirmado");
  });

  it("confirmado não ganha aviso nenhum — e o campo é false, não ausente", async () => {
    deps.marcar.mockResolvedValue(compromisso({ status: "confirmed" }));

    const r = (await crmBookAppointment.handler(ENTRADA, CTX)) as Record<string, unknown>;

    expect(r.aguarda_confirmacao).toBe(false);
    // Ausente faria o modelo ter que distinguir "não veio" de "false"; um
    // booleano sempre presente não tem essa ambiguidade.
    expect("aguarda_confirmacao" in r).toBe(true);
    expect(r.mensagem).toBeUndefined();
  });

  it("⚠️ os DOIS pending são coisas diferentes, e os dois avisos convivem", async () => {
    deps.marcar.mockResolvedValue(
      compromisso({ status: "pending", meeting_state: "pending" }),
    );

    const r = (await crmBookAppointment.handler(ENTRADA, CTX)) as Record<string, unknown>;
    const msg = String(r.mensagem);

    expect(r.aguarda_confirmacao).toBe(true);
    expect(msg).toContain("NÃO está confirmado"); // status do compromisso
    expect(msg).toContain("link ainda está sendo criado"); // meeting_state
  });

  it("o link pendente sozinho NÃO vira aviso de confirmação", async () => {
    deps.marcar.mockResolvedValue(
      compromisso({ status: "confirmed", meeting_state: "pending" }),
    );

    const r = (await crmBookAppointment.handler(ENTRADA, CTX)) as Record<string, unknown>;

    expect(r.aguarda_confirmacao).toBe(false);
    expect(String(r.mensagem)).toContain("link ainda está sendo criado");
    expect(String(r.mensagem)).not.toContain("RESERVADO");
  });
});
