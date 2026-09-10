import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ResultadoDaConsulta, ResultadoDosTipos, TipoDeAtendimento } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * AS CAPACIDADES QUE FALTAVAM PARA A IA AGENDAR SOZINHA.
 *
 * ─── O defeito, medido numa instalação real ────────────────────────────────
 *
 * O agente TINHA as cinco ferramentas de agenda montadas no turno — está no log
 * do worker — e não marcava consulta nenhuma. A causa não era o modelo: quatro
 * das cinco exigem `event_type_slug`, e NENHUMA capacidade do catálogo dizia
 * quais slugs existem. Na organização medida eram `atendimento`,
 * `call-estrategica`, `consulta`, `hof-e-botox` e `reuniao` — a IA teria de
 * adivinhar a string. Errava, recebia `tipo_desconhecido`, e caía no "vou
 * confirmar com a equipe" para sempre.
 *
 * A recusa daquele caminho até ensinava o certo — "use um dos tipos que a
 * organização oferece" —, e era uma instrução impossível de cumprir.
 *
 * ─── O que este arquivo cobre, e o que não ─────────────────────────────────
 *
 * A camada que a TOOL acrescenta: o que ela mostra ao modelo, o que ela esconde
 * dele, e como a recusa chega. A coleta (`listaTiposDeAtendimento`) e o handler
 * de escrita têm donos próprios; mockar os dois é o que mantém cada suíte
 * medindo uma coisa. Mesma fronteira de `mcp-agendamento-tools.test.ts`.
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return {
    ...real,
    listaTiposDeAtendimento: vi.fn(),
    horariosLivresDaOrg: vi.fn(),
    listaAgendamentos: vi.fn(),
    idDoTipoPorSlug: vi.fn(),
  };
});

const { listaTiposDeAtendimento, horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { crmListEventTypes, crmConfirmAppointment, crmSetAppointmentOutcome, crmFindFreeSlots } =
  await import("@/lib/mcp/tools/agendamento");
const handlers = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { ApiError } = await import("@/lib/api/types");

const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

/** Um tipo como o banco devolve — os cinco da clínica medida são deste feitio. */
function tipo(over: Partial<TipoDeAtendimento> = {}): TipoDeAtendimento {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    nome: "HOF e Botox",
    slug: "hof-e-botox",
    descricao: null,
    categoria: "procedimento",
    duracaoMin: 45,
    localKind: "in_person",
    localDetalhes: "Sala 2",
    precisaConfirmacao: false,
    ativo: true,
    donoPadraoId: "22222222-2222-4222-8222-222222222222",
    bufferAntesMin: 0,
    bufferDepoisMin: 0,
    antecedenciaMinimaMin: 120,
    janelaDeAgendamentoDias: 60,
    // Como o banco devolve: o lembrete nasce desligado (migration 0194).
    lembreteLigado: false,
    lembreteAntecedenciaMin: 1440,
    ...over,
  };
}

function tiposRespondem(r: ResultadoDosTipos): void {
  vi.mocked(listaTiposDeAtendimento).mockResolvedValue(r);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("crm_list_event_types — a capacidade que faltava", () => {
  it("entrega o SLUG, que é o handle que as outras ferramentas exigem", async () => {
    tiposRespondem({ ok: true, tipos: [tipo()] });

    const r = (await crmListEventTypes.handler({}, ctx)) as { tipos: { slug: string }[] };

    expect(r.tipos[0]?.slug).toBe("hof-e-botox");
  });

  it("NÃO entrega o id interno — o slug existe para o modelo não alucinar uuid", async () => {
    // Devolver o uuid ao lado do slug convida o modelo a mandá-lo em
    // `event_type_slug`, onde ele nunca casa. O campo simplesmente não sai.
    tiposRespondem({ ok: true, tipos: [tipo()] });

    const r = (await crmListEventTypes.handler({}, ctx)) as { tipos: Record<string, unknown>[] };

    expect(r.tipos[0]).not.toHaveProperty("id");
    expect(JSON.stringify(r.tipos)).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("traduz o local em vez de vazar o vocabulário do banco", async () => {
    // `in_person` é palavra de coluna, e o modelo repassa o que recebe. Quem
    // traduz é o MESMO tradutor da tela.
    tiposRespondem({ ok: true, tipos: [tipo()] });

    const r = (await crmListEventTypes.handler({}, ctx)) as { tipos: { onde: string | null }[] };

    expect(r.tipos[0]?.onde).toBe("Presencial · Sala 2");
    expect(JSON.stringify(r.tipos)).not.toContain("in_person");
  });

  it("pede SÓ os ativos à coleta — tipo desativado é beco sem saída", async () => {
    // Não é filtro de estética: `horariosLivresDaOrg` acha o tipo inativo e
    // recusa com `tipo_desativado`. Oferecê-lo ao modelo é garantir que ele
    // ofereça à pessoa algo que não dá para marcar.
    tiposRespondem({ ok: true, tipos: [] });

    await crmListEventTypes.handler({}, ctx);

    const chamada = vi.mocked(listaTiposDeAtendimento).mock.calls[0];
    expect(chamada?.[1]).toBe("org-1");
    // Sem opções, ou com `incluirInativos` falso — o que não pode é pedir os inativos.
    expect(chamada?.[2]?.incluirInativos ?? false).toBe(false);
  });

  it("diz que precisa de confirmação — muda o que o agente fala depois de marcar", async () => {
    tiposRespondem({ ok: true, tipos: [tipo({ precisaConfirmacao: true })] });

    const r = (await crmListEventTypes.handler({}, ctx)) as {
      tipos: { precisa_confirmacao: boolean }[];
    };

    expect(r.tipos[0]?.precisa_confirmacao).toBe(true);
  });

  it("erro de leitura vira recusa NOMEADA, nunca lista vazia", async () => {
    // As duas chegam ao modelo iguais e significam o oposto: lista vazia diz "a
    // clínica não atende nada", e ele anunciaria isso ao paciente.
    tiposRespondem({
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: 'relation "calendar_event_types" does not exist',
      motivoParaCliente: "Não consegui ver o que a agenda oferece agora.",
    });

    const r = (await crmListEventTypes.handler({}, ctx)) as { motivo: string; mensagem: string };

    expect(r.motivo).toBe("erro_interno");
    // A face do CLIENTE, nunca a do operador: o texto do banco não pode chegar
    // a quem está do outro lado do WhatsApp.
    expect(r.mensagem).not.toContain("relation");
  });
});

describe("crm_set_appointment_outcome — desfecho é sobre o passado", () => {
  it("compromisso que ainda não começou é RECUSADO, e a recusa ensina o caminho certo", async () => {
    // A guarda mora no handler; aqui prova-se que a tool a traduz em resposta ao
    // modelo em vez de deixar a exceção matar o turno.
    vi.mocked(handlers.alterarAgendamentoHandler).mockRejectedValue(
      new ApiError(422, "agenda_ainda_nao_aconteceu", undefined, "req-1", "não começou"),
    );

    const r = (await crmSetAppointmentOutcome.handler(
      { appointment_id: "33333333-3333-4333-8333-333333333333", outcome: "no_show" },
      { ...ctx, actor: { type: "user", id: "bbbbbbbb-1111-4111-8111-111111111111", role: "manager" } },
    )) as { registrado: boolean; motivo: string; mensagem: string };

    expect(r.registrado).toBe(false);
    expect(r.motivo).toBe("agenda_ainda_nao_aconteceu");
    // O ensino importa tanto quanto a recusa: sem ele o modelo tenta de novo igual.
    expect(r.mensagem).toContain("crm_cancel_appointment");
  });

  it("passa o desfecho pedido ao handler, sem inventar transição", async () => {
    vi.mocked(handlers.alterarAgendamentoHandler).mockResolvedValue({ id: "a1", status: "completed" });

    await crmSetAppointmentOutcome.handler(
      { appointment_id: "33333333-3333-4333-8333-333333333333", outcome: "completed" },
      { ...ctx, actor: { type: "user", id: "bbbbbbbb-1111-4111-8111-111111111111", role: "manager" } },
    );

    expect(vi.mocked(handlers.alterarAgendamentoHandler).mock.calls[0]?.[2]).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      status: "completed",
    });
  });
  it.each(["completed","no_show"] as const)("modelo propõe %s ao humano e não escreve presença",async outcome=>{
    const r=await crmSetAppointmentOutcome.handler({appointment_id:"33333333-3333-4333-8333-333333333333",outcome},ctx);
    expect(r).toMatchObject({registrado:false,requer_confirmacao_humana:true,href:"/app/agenda?compromisso=33333333-3333-4333-8333-333333333333"});
    expect(handlers.alterarAgendamentoHandler).not.toHaveBeenCalled();
  });
});

describe("crm_confirm_appointment", () => {
  it("confirma o que estava aguardando a pessoa", async () => {
    vi.mocked(handlers.alterarAgendamentoHandler).mockResolvedValue({ id: "a1", status: "confirmed" });

    const r = (await crmConfirmAppointment.handler(
      { appointment_id: "33333333-3333-4333-8333-333333333333" },
      ctx,
    )) as { confirmado: boolean };

    expect(r.confirmado).toBe(true);
    expect(vi.mocked(handlers.alterarAgendamentoHandler).mock.calls[0]?.[2]).toMatchObject({
      status: "confirmed",
    });
  });
});

/** Uma grade real: 4 dias úteis, 10 horários de 30min em cada — 40 no total. */
function gradeDeQuatroDias(): { inicio: Date; fim: Date }[] {
  const slots: { inicio: Date; fim: Date }[] = [];
  for (const dia of ["01", "02", "03", "04"]) {
    for (let i = 0; i < 10; i += 1) {
      const h = String(12 + Math.floor(i / 2)).padStart(2, "0");
      const m = i % 2 === 0 ? "00" : "30";
      slots.push({
        inicio: new Date(`2026-09-${dia}T${h}:${m}:00Z`),
        fim: new Date(`2026-09-${dia}T${h}:${m}:00Z`),
      });
    }
  }
  return slots;
}

function horariosRespondem(slots: { inicio: Date; fim: Date }[]): void {
  vi.mocked(horariosLivresDaOrg).mockResolvedValue({
    ok: true,
    slots,
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
    googleCoberturaParcial: false,
  } as ResultadoDaConsulta);
}

describe("crm_find_free_slots — o que o modelo consegue ler e escolher", () => {
  it("cada horário vem com o rótulo local ao lado do instante de máquina", async () => {
    horariosRespondem([
      { inicio: new Date("2026-09-04T17:00:00Z"), fim: new Date("2026-09-04T17:30:00Z") },
    ]);

    const r = (await crmFindFreeSlots.handler(
      { event_type_slug: "consulta", dias_a_frente: 7 },
      ctx,
    )) as { horarios: { inicio: string; quando: string }[] };

    // 17:00Z = 14:00 em São Paulo, numa sexta-feira.
    expect(r.horarios[0]?.quando).toBe("sexta-feira 04/09 às 14:00");
    // E o ISO continua lá: é ele que volta em `starts_at`.
    expect(r.horarios[0]?.inicio).toBe("2026-09-04T17:00:00.000Z");
  });

  it("corta no teto, mas ESPALHA pelos dias — cortar pela cabeça esconderia a semana", async () => {
    // 40 horários em 4 dias, teto de 8. Cortar pela cabeça devolveria os 8
    // primeiros, todos do dia 01 — e um pedido de "essa semana" voltaria só com
    // o primeiro dia, fazendo o modelo concluir que os outros estão cheios.
    horariosRespondem(gradeDeQuatroDias());

    const r = (await crmFindFreeSlots.handler(
      { event_type_slug: "consulta", dias_a_frente: 7, limite: 8 },
      ctx,
    )) as { horarios: { quando: string }[]; total_de_horarios: number; ha_mais: boolean };

    expect(r.horarios).toHaveLength(8);
    const diasOferecidos = new Set(r.horarios.map((h) => h.quando.split(" às ")[0]));
    expect(diasOferecidos.size).toBe(4);
    // E o modelo fica sabendo que a lista foi cortada — senão ele leria 8 como
    // "só há 8", que é o mesmo modo de falha que `publicou_horarios` evita.
    expect(r.total_de_horarios).toBe(40);
    expect(r.ha_mais).toBe(true);
  });

  it("lista inteira devolvida: `ha_mais` é falso e o total bate", async () => {
    // O controle do caso acima. Sem ele, um `ha_mais` cravado em `true` passaria.
    horariosRespondem([
      { inicio: new Date("2026-09-04T17:00:00Z"), fim: new Date("2026-09-04T17:30:00Z") },
    ]);

    const r = (await crmFindFreeSlots.handler(
      { event_type_slug: "consulta", dias_a_frente: 7 },
      ctx,
    )) as { horarios: unknown[]; total_de_horarios: number; ha_mais: boolean };

    expect(r.horarios).toHaveLength(1);
    expect(r.total_de_horarios).toBe(1);
    expect(r.ha_mais).toBe(false);
  });
});
