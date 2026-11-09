/**
 * `agenda-da-voz.ts` — a PONTE entre a ligação e as tools de agenda do texto.
 *
 * Aqui não há dublê de fala: o que se prova é o ENCANAMENTO. As cinco
 * operações chamam o `handler` de verdade de `lib/mcp/tools/agendamento.ts`
 * (dublado só no módulo, para não tocar banco), e o `McpContext` que chega
 * nelas carrega a organização e o contato DA LIGAÇÃO.
 *
 * (d) preparar+confirmar executa `crm_book_appointment`;
 * (e) preparo de REMARCAR executa `crm_reschedule_appointment`, não book;
 * (f) `organization_id` nos argumentos não muda a organização usada — ela é
 *     a da ligação, e o campo nem chega ao handler.
 *
 * SABOTAGEM: trocar `organizationId: entrada.organizationId` por
 * `args.organization_id` (ou espalhar os args no input do handler) derruba (f).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas = vi.hoisted(() => ({
  tipos: vi.fn(),
  horarios: vi.fn(),
  lista: vi.fn(),
  marcar: vi.fn(),
  remarcar: vi.fn(),
}));

vi.mock("@/lib/mcp/tools/agendamento", async () => {
  const { z } = await import("zod");
  return {
    crmListEventTypes: { name: "crm_list_event_types", inputSchema: {}, handler: chamadas.tipos },
    crmFindFreeSlots: {
      name: "crm_find_free_slots",
      inputSchema: {
        event_type_slug: z.string(),
        dia: z.string().optional(),
        dias_a_frente: z.number().optional(),
      },
      handler: chamadas.horarios,
    },
    crmListAppointments: { name: "crm_list_appointments", inputSchema: {}, handler: chamadas.lista },
    crmBookAppointment: {
      name: "crm_book_appointment",
      inputSchema: {
        event_type_slug: z.string(),
        starts_at: z.string(),
        contact_id: z.string(),
      },
      handler: chamadas.marcar,
    },
    crmRescheduleAppointment: {
      name: "crm_reschedule_appointment",
      inputSchema: { appointment_id: z.string(), new_starts_at: z.string() },
      handler: chamadas.remarcar,
    },
  };
});

import {
  falarQuando,
  montarAgendaDaVoz,
  normalizarHora,
  type AgendaDaVoz,
} from "./agenda-da-voz";

const INICIO = "2030-01-07T17:00:00.000Z";

function agendaDa(contactId: string | null = "contato-1"): AgendaDaVoz {
  return montarAgendaDaVoz({
    supabase: { from: vi.fn() } as never,
    organizationId: "org-da-ligacao",
    callId: "chamada-1",
    agentId: "agente-1",
    contactId,
  });
}

/** O `McpContext` que chegou no handler (2º argumento). */
function contextoDa(handler: { mock: { calls: unknown[][] } }, indice = 0) {
  return handler.mock.calls[indice]![1] as {
    organizationId: string;
    contatoDoTurno?: string;
    role: string;
    actor: { type: string; id: string; agent_id?: string };
  };
}

/** O input que chegou no handler (1º argumento). */
function entradaDe(handler: { mock: { calls: unknown[][] } }, indice = 0) {
  return handler.mock.calls[indice]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  chamadas.tipos.mockResolvedValue({
    tipos: [
      { slug: "consulta-inicial", nome: "Consulta inicial", duracao_minutos: 30 },
      { slug: "retorno", nome: "Retorno", duracao_minutos: 15 },
    ],
  });
  chamadas.horarios.mockResolvedValue({
    horarios: [
      { inicio: INICIO, quando: "segunda-feira 07/01 às 14:00" },
      { inicio: "2030-01-08T12:00:00.000Z", quando: "terça-feira 08/01 às 09:00" },
    ],
    publicou_horarios: true,
  });
  chamadas.lista.mockResolvedValue({
    compromissos: [
      {
        id: "3f0c1b7a-2d7e-4c1f-9a55-8f0f2f9e1d10",
        titulo: "Consulta inicial",
        inicio: "2030-01-07T17:00:00.000Z",
        quando: "segunda-feira 07/01 às 14:00",
        situacao: "confirmed",
        tipo: { slug: "consulta-inicial", nome: "Consulta inicial" },
      },
    ],
  });
  chamadas.marcar.mockResolvedValue({
    marcado: true,
    compromisso: { quando: "segunda-feira 07/01 às 14:00" },
    aguarda_confirmacao: false,
  });
  chamadas.remarcar.mockResolvedValue({
    remarcado: true,
    compromisso: { quando: "terça-feira 08/01 às 09:00" },
  });
});

describe("fala curta", () => {
  it("traduz o rótulo do calendário para a fala", () => {
    expect(falarQuando("segunda-feira 07/01 às 14:00")).toBe("segunda-feira, 7 de janeiro, às 14 horas");
    expect(falarQuando("terça-feira 08/01 às 09:30")).toBe("terça-feira, 8 de janeiro, às 9 e 30");
  });

  it("aceita as formas que o modelo fala", () => {
    expect(normalizarHora("14")).toBe("14:00");
    expect(normalizarHora("14h")).toBe("14:00");
    expect(normalizarHora("14h30")).toBe("14:30");
    expect(normalizarHora("9:05")).toBe("09:05");
    expect(normalizarHora("meio-dia")).toBeNull();
    expect(normalizarHora("25:00")).toBeNull();
  });
});

describe("leitura", () => {
  it("lista os tipos pelo handler de texto, na organização da ligação", async () => {
    const fala = await agendaDa().listarTipos();

    expect(chamadas.tipos).toHaveBeenCalledTimes(1);
    expect(contextoDa(chamadas.tipos).organizationId).toBe("org-da-ligacao");
    expect(fala).toContain("Consulta inicial, 30 minutos");
    expect(fala.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
  });

  it("acha horário livre sem deixar a organização vir dos argumentos", async () => {
    const fala = await agendaDa().horariosLivres({
      tipo: "consulta-inicial",
      dias_a_frente: 7,
      // @ts-expect-error — o modelo pode mandar isto; o tipo não declara, e
      // nada pode encaminhar.
      organization_id: "org-intrusa",
    } as never);

    expect(entradaDe(chamadas.horarios)).toEqual({ event_type_slug: "consulta-inicial", dias_a_frente: 7 });
    expect(contextoDa(chamadas.horarios).organizationId).toBe("org-da-ligacao");
    expect(fala).toContain("segunda-feira, 7 de janeiro, às 14 horas");
  });

  it("lista só os compromissos do contato da ligação", async () => {
    const fala = await agendaDa().listarCompromissos({});

    expect(entradaDe(chamadas.lista)).toEqual({ limite: 20 });
    expect(contextoDa(chamadas.lista).contatoDoTurno).toBe("contato-1");
    expect(fala).toContain("segunda-feira, 7 de janeiro, às 14 horas");
    // O id do compromisso morre dentro da ponte: fala não leva UUID.
    expect(fala).not.toMatch(/3f0c1b7a/);
  });
});

describe("(d) preparar não escreve, confirmar marca", () => {
  it("preparo de MARCAR resolve o horário no handler e só escreve no segundo passo", async () => {
    const agenda = agendaDa();

    const preparo = await agenda.preparar({ tipo: "consulta-inicial", hora: "14:00", dias_a_frente: 7 });

    expect("recusa" in preparo).toBe(false);
    if ("recusa" in preparo) return;
    expect(preparo.operacao).toBe("marcar");
    expect(preparo.args).toEqual({ event_type_slug: "consulta-inicial", starts_at: INICIO });
    expect(preparo.resumo).toBe("Consulta inicial, segunda-feira, 7 de janeiro, às 14 horas.");
    // Preparar NÃO escreve.
    expect(chamadas.marcar).not.toHaveBeenCalled();

    const fala = await agenda.executar(preparo.operacao, preparo.args);

    expect(chamadas.marcar).toHaveBeenCalledTimes(1);
    expect(entradaDe(chamadas.marcar)).toEqual({
      event_type_slug: "consulta-inicial",
      starts_at: INICIO,
      contact_id: "contato-1",
    });
    expect(contextoDa(chamadas.marcar).organizationId).toBe("org-da-ligacao");
    expect(fala).toBe("Pronto: marquei segunda-feira, 7 de janeiro, às 14 horas.");
    expect(fala).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("quando o tipo exige aprovação, a fala NÃO diz que está confirmado", async () => {
    chamadas.marcar.mockResolvedValueOnce({
      marcado: true,
      compromisso: { quando: "segunda-feira 07/01 às 14:00" },
      aguarda_confirmacao: true,
    });
    const agenda = agendaDa();

    const fala = await agenda.executar("marcar", {
      event_type_slug: "consulta-inicial",
      starts_at: INICIO,
    });

    expect(fala).toContain("equipe confirma");
    expect(fala.toLowerCase()).not.toContain("está marcado");
  });

  it("sem contato identificado, não prepara e não escreve", async () => {
    const agenda = agendaDa(null);

    const preparo = await agenda.preparar({ tipo: "consulta-inicial", hora: "14:00" });

    expect("recusa" in preparo).toBe(true);
    if (!("recusa" in preparo)) return;
    expect(preparo.recusa).toContain("não identifiquei seu cadastro");
    expect(chamadas.horarios).not.toHaveBeenCalled();
    expect(chamadas.marcar).not.toHaveBeenCalled();
  });

  it("horário sem vaga é recusado com alternativas — e nada é escrito", async () => {
    const agenda = agendaDa();

    const preparo = await agenda.preparar({ tipo: "consulta-inicial", hora: "16:00" });

    expect("recusa" in preparo).toBe(true);
    if (!("recusa" in preparo)) return;
    expect(preparo.recusa).toContain("Não tem vaga nesse horário");
    expect(preparo.recusa).toContain("segunda-feira, 7 de janeiro");
    expect(chamadas.marcar).not.toHaveBeenCalled();
  });
});

describe("(e) remarcar", () => {
  it("preparo de REMARCAR executa remarcar, nunca book", async () => {
    const agenda = agendaDa();

    const preparo = await agenda.preparar({
      tipo: "consulta-inicial",
      hora: "09:00",
      remarcar: true,
      dias_a_frente: 7,
    });

    expect("recusa" in preparo).toBe(false);
    if ("recusa" in preparo) return;
    expect(preparo.operacao).toBe("remarcar");
    expect(preparo.args).toEqual({
      appointment_id: "3f0c1b7a-2d7e-4c1f-9a55-8f0f2f9e1d10",
      new_starts_at: "2030-01-08T12:00:00.000Z",
    });
    // O mesmo compromisso: o handler de marcar não é chamado em ponto nenhum.
    expect(chamadas.marcar).not.toHaveBeenCalled();

    const fala = await agenda.executar(preparo.operacao, preparo.args);

    expect(chamadas.remarcar).toHaveBeenCalledTimes(1);
    expect(chamadas.marcar).not.toHaveBeenCalled();
    expect(fala).toBe("Pronto: remarquei para terça-feira, 8 de janeiro, às 9 horas.");
  });
});

describe("(f) organização dos argumentos", () => {
  it("organization_id de outra org não chega ao handler e a escrita usa a org da ligação", async () => {
    const agenda = agendaDa();

    await agenda.executar("marcar", {
      event_type_slug: "consulta-inicial",
      starts_at: INICIO,
      organization_id: "org-intrusa",
      org_id: "org-intrusa",
    });

    const entrada = entradaDe(chamadas.marcar);
    expect(entrada).not.toHaveProperty("organization_id");
    expect(entrada).not.toHaveProperty("org_id");
    expect(entrada).toEqual({
      event_type_slug: "consulta-inicial",
      starts_at: INICIO,
      contact_id: "contato-1",
    });
    expect(contextoDa(chamadas.marcar).organizationId).toBe("org-da-ligacao");
  });
});
