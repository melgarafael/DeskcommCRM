import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type * as AgendaConsulta from "@/lib/agenda/consulta";
import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * `crm_find_and_book_appointment` — o COMPORTAMENTO da ferramenta conjunta (issue #831).
 *
 * ## O sintoma que este arquivo prende
 *
 * O cliente diz "quinta às 14h", o modelo chama `crm_find_free_slots`, recebe a lista,
 * responde "confirmei o horário" e encerra o turno — **ninguém marcou nada**. Consultar e
 * marcar são a MESMA decisão quando o cliente já disse dia E hora; separá-las em duas
 * idas ao modelo cria a chance (e a prática) de parar no meio.
 *
 * ## O que é da TOOL e o que é da COLETA
 *
 * A coleta (`horariosLivresDaOrg`) tem teste próprio, de outro dono. Aqui a fronteira é
 * deliberada — este arquivo mede o que a ferramenta acrescenta por cima dela:
 *  1. NADA é marcado sem estar livre; o instante marcado vem do SLOT, não do texto do modelo;
 *  2. o dia é respeitado (slot de outro dia não serve para a hora pedida);
 *  3. recusa (da consulta ou da marcação) volta como RESPOSTA, nunca como exceção;
 *  4. quem "consegue gravar agenda" é decidido por UMA regra (`temFerramentaDeMarcacao`),
 *     que precisa reconhecer a ferramenta conjunta — senão o bloco residente da Agenda e o
 *     gate `podeMarcar` voltam a discordar entre si.
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof AgendaConsulta>();
  return { ...real, horariosLivresDaOrg: vi.fn(), listaAgendamentos: vi.fn(), idDoTipoPorSlug: vi.fn() };
});

const { horariosLivresDaOrg, idDoTipoPorSlug } = await import("@/lib/agenda/consulta");
const { crmFindAndBookAppointment } = await import("@/lib/mcp/tools/agendamento");
const handlers = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { temFerramentaDeMarcacao } = await import("@/lib/agent-engine/agent/inbound-turn");
const { ApiError } = await import("@/lib/api/types");

// O dublê do client existe só para satisfazer o contrato: a coleta está mockada, então
// nada aqui toca banco.
const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

const CONTATO = "11111111-1111-4111-8111-111111111111";

// Fuso da REGRA em UTC de propósito: é o fuso em que os slots foram calculados, e é o
// que a própria consulta publica. Com ele, `2026-09-01T14:00:00Z` é o rótulo "14:00" do
// dia civil 2026-09-01 — a régua que a ferramenta tem de usar para casar o pedido.
const SUCESSO: ResultadoDaConsulta = {
  ok: true,
  slots: [
    { inicio: new Date("2026-09-01T14:00:00Z"), fim: new Date("2026-09-01T14:30:00Z") },
    { inicio: new Date("2026-09-01T15:00:00Z"), fim: new Date("2026-09-01T15:30:00Z") },
  ],
  fusoDaRegra: "UTC",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
  googleCoberturaParcial: false,
};

const COMPROMISSO = { id: "apt-1", status: "confirmed", meeting_state: "ready" };
const HORA_14 = /14[:h]00/;

describe("crm_find_and_book_appointment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(SUCESSO);
    vi.mocked(idDoTipoPorSlug).mockResolvedValue({ id: "tipo-1" } as never);
    vi.mocked(handlers.marcarAgendamentoHandler).mockResolvedValue(COMPROMISSO as never);
  });

  it("horário livre: marca na MESMA chamada, com o instante que a agenda confirmou", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(handlers.marcarAgendamentoHandler).toHaveBeenCalledTimes(1);

    // A marcação sai pela MESMA porta de `crm_book_appointment` (com o mesmo guard de
    // organização) e com o instante que veio do slot.
    const [, meta, corpo] = vi.mocked(handlers.marcarAgendamentoHandler).mock.calls[0]!;
    expect((meta as { organization_id: string }).organization_id).toBe("org-1");
    expect((corpo as { starts_at: string }).starts_at).toBe("2026-09-01T14:00:00.000Z");
    expect((corpo as { contact_id: string }).contact_id).toBe(CONTATO);

    // E o retorno diz QUAL horário esta chamada usou — o modelo não precisa deduzir.
    expect(r.inicio).toBe("2026-09-01T14:00:00.000Z");
    expect(String(r.quando)).toMatch(HORA_14);
  });

  it("horário pedido fora da lista: NADA é marcado e a resposta traz os horários do dia", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "16:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("horario_indisponivel");

    // A lista que a agenda REALMENTE tem naquele dia — é o que o modelo oferece ao
    // cliente no mesmo turno, em vez de pedir outro dia no escuro.
    const horarios = r.horarios as Array<{ inicio: string; quando: string }>;
    expect(horarios.length).toBeGreaterThan(0);
    expect(horarios.some((h) => HORA_14.test(h.quando))).toBe(true);
  });

  it("o DIA é respeitado: slot de outro dia não serve para a hora pedida", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-02", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    // Mesmo existindo um 14:00 na agenda, ele é do dia 01 — marcar ali seria marcar um
    // dia que o cliente não pediu.
    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
    expect(r.marcado).toBe(false);
  });

  it("consulta recusada por negócio não derruba o turno: volta como resposta ao modelo", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({
      ok: false,
      codigo: "tipo_desconhecido",
      motivoParaCliente: "não existe atendimento com esse nome",
    } as never);

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("tipo_desconhecido");
    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("marcação recusada depois do horário livre volta como resposta, com o dia junto", async () => {
    // A recusa de NEGÓCIO da marcação chega como `ApiError` (é assim que o handler
    // recusa horário tomado na última hora). Numa ferramenta MCP exceção subiria pela
    // ponte e o assistente EMUDECERIA no meio da conversa de agendamento.
    vi.mocked(handlers.marcarAgendamentoHandler).mockRejectedValue(
      new ApiError(409, "agenda_horario_indisponivel", undefined, "req-1", "slot tomado"),
    );

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("agenda_horario_indisponivel");
    // O turno continua e o modelo recebe também o que estava livre: é o material para
    // não encerrar a conversa com o cliente na mão.
    const horarios = r.horarios as Array<{ inicio: string; quando: string }>;
    expect(horarios.length).toBeGreaterThan(0);
    expect(horarios.some((h) => HORA_14.test(h.quando))).toBe(true);
  });
});

describe("temFerramentaDeMarcacao (#831)", () => {
  it("reconhece a ferramenta CONJUNTA como 'consegue gravar agenda'", () => {
    // Livro único da regra: o bloco residente da Agenda e o gate `podeMarcar` leem a
    // MESMA função. Se a ferramenta conjunta não estiver aqui, o agente ganha a
    // ferramenta mas o bloco residente não é montado — e ela fica inalcançável.
    expect(temFerramentaDeMarcacao(["crm_find_and_book_appointment"])).toBe(true);
    expect(temFerramentaDeMarcacao(["crm_book_appointment"])).toBe(true);
    // Consultar NÃO é marcar.
    expect(temFerramentaDeMarcacao(["crm_find_free_slots"])).toBe(false);
  });
});
