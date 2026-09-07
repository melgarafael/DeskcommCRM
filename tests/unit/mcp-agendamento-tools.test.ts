import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * `crm_find_free_slots` — o COMPORTAMENTO, não a declaração.
 *
 * ## Por que este arquivo existe
 *
 * Dez gates provam que esta ferramenta está bem DECLARADA: bijeção handler↔catálogo,
 * jargão de leigo, coerência category↔risco, alcance pelo papel, teto do pacote. Nenhum
 * deles prova que ela FUNCIONA quando a IA a chama — são coisas diferentes, e por um
 * tempo eu tratei a primeira como se fosse a segunda.
 *
 * ## O que é da TOOL e o que é da COLETA
 *
 * A coleta (`horariosLivresDaOrg`) tem teste próprio, de outro dono. Aqui a fronteira é
 * deliberada: este arquivo cobre a camada que a tool acrescenta — a tradução do pedido
 * do modelo em janela de tempo, os limites, e **qual das duas faces da recusa sai**.
 * Mockar a coleta não é atalho: é o que mantém as duas suítes medindo coisas diferentes.
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn(), listaAgendamentos: vi.fn(), idDoTipoPorSlug: vi.fn() };
});

const { horariosLivresDaOrg, listaAgendamentos, idDoTipoPorSlug } = await import("@/lib/agenda/consulta");
const {
  crmFindFreeSlots,
  crmListAppointments,
  crmBookAppointment,
  crmRescheduleAppointment,
  crmCancelAppointment,
} = await import("@/lib/mcp/tools/agendamento");
const handlers = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { ApiError } = await import("@/lib/api/types");

// O dublê do client existe só para satisfazer o contrato: `horariosLivresDaOrg` está
// mockada, então nada aqui toca banco. `as never` NÃO servia — `never` não é atribuível
// a `SupabaseClient`, e esse erro ficou ESCONDIDO atrás do erro de input enquanto o
// primeiro parâmetro não compilava. Dois defeitos, um mascarando o outro.
const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  // `role` é obrigatório na variante `ai_agent` do `Actor` — foi o TERCEIRO defeito
  // desta constante, e cada um só apareceu depois de o anterior ser corrigido.
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

function respondeCom(r: ResultadoDaConsulta) {
  vi.mocked(horariosLivresDaOrg).mockResolvedValue(r);
}

const SUCESSO: ResultadoDaConsulta = {
  ok: true,
  slots: [{ inicio: new Date("2026-09-01T14:00:00Z"), fim: new Date("2026-09-01T14:30:00Z") }],
  fusoDaRegra: "America/Sao_Paulo",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
};

describe("crm_find_free_slots", () => {
  // Sem isto, `mock.calls[0]` é sempre a chamada do PRIMEIRO teste que rodou — e os
  // casos seguintes passariam a medir um argumento que não é o deles. Foi o que
  // aconteceu ao escrever este arquivo: dois testes leram a janela de 7 dias do caso
  // anterior e acusaram o código de estar errado.
  beforeEach(() => vi.clearAllMocks());

  it("o caminho PADRÃO é relativo — o modelo não sabe que dia é hoje", async () => {
    // A lição está medida em `lib/mcp/tools/retencao.ts`: num turno real o modelo
    // mandou a data do TREINO dele quando pedimos um instante absoluto. Por isso
    // `dias_a_frente` existe e é o caminho que a `description` manda usar.
    respondeCom(SUCESSO);
    await crmFindFreeSlots.handler({ event_type_slug: "consulta", dias_a_frente: 7 }, ctx);

    const params = vi.mocked(horariosLivresDaOrg).mock.calls[0]![2];
    const dias = (params.ate.getTime() - params.de.getTime()) / 86_400_000;
    expect(Math.round(dias)).toBe(7);
    // E o relógio é INJETADO na coleta, não lido lá dentro.
    expect(params.agora).toBeInstanceOf(Date);
  });

  it("sem período nenhum, assume 14 dias — não estoura nem devolve vazio", async () => {
    respondeCom(SUCESSO);
    await crmFindFreeSlots.handler({ event_type_slug: "consulta" }, ctx);
    const params = vi.mocked(horariosLivresDaOrg).mock.calls[0]![2];
    expect(Math.round((params.ate.getTime() - params.de.getTime()) / 86_400_000)).toBe(14);
  });

  it("a ferramenta fala SLUG, não uuid — o modelo não inventa slug", async () => {
    // `calendar_event_types.slug` existe, nas palavras do próprio schema, para "dar à
    // IA um handle que ela não alucina, ao contrário de um uuid".
    respondeCom(SUCESSO);
    await crmFindFreeSlots.handler({ event_type_slug: "consulta-inicial" }, ctx);
    expect(vi.mocked(horariosLivresDaOrg).mock.calls[0]![2].eventTypeSlug).toBe("consulta-inicial");
  });

  it("um dia civil inclui a noite em Manaus, sem pedir que o modelo calcule UTC", async () => {
    respondeCom({
      ...SUCESSO,
      fusoDaRegra: "America/Manaus",
      slots: [
        // 21h do dia 13 em Manaus: este foi o horário que o agente perdeu ao
        // consultar 00:00–23:59 UTC, que termina às 19:59 no fuso da regra.
        { inicio: new Date("2026-09-14T01:00:00.000Z"), fim: new Date("2026-09-14T01:30:00.000Z") },
        // Já é madrugada do dia 14 local; a faixa larga pode vê-lo, mas a
        // resposta de um pedido pelo dia 13 não pode oferecê-lo.
        { inicio: new Date("2026-09-14T05:00:00.000Z"), fim: new Date("2026-09-14T05:30:00.000Z") },
      ],
    });
    const r = (await crmFindFreeSlots.handler(
      { event_type_slug: "c", dia: "2026-09-13" },
      ctx,
    )) as { horarios: { inicio: string }[]; total_de_horarios: number };
    expect(r.horarios.map((h) => h.inicio)).toEqual(["2026-09-14T01:00:00.000Z"]);
    expect(r.total_de_horarios).toBe(1);

    const params = vi.mocked(horariosLivresDaOrg).mock.calls[0]![2];
    expect(params.de.toISOString()).toBe("2026-09-12T10:00:00.000Z");
    expect(params.ate.toISOString()).toBe("2026-09-14T14:00:00.000Z");
  });

  it("não aceita dia específico e período relativo juntos", async () => {
    const r = (await crmFindFreeSlots.handler(
      { event_type_slug: "c", dia: "2026-09-13", dias_a_frente: 7 },
      ctx,
    )) as { motivo: string; mensagem: string };
    expect(r.motivo).toBe("periodo_ambiguo");
    expect(r.mensagem).toMatch(/não os dois/);
    expect(horariosLivresDaOrg).not.toHaveBeenCalled();
  });

  it("⚠️ a recusa que sai é a do CLIENTE, nunca a do OPERADOR", async () => {
    // DECISÃO 20, e é o teste mais importante deste arquivo. `motivoParaOperador`
    // nomeia CAMPO e PESSOA; o modelo repassa o que recebe, e quem ouve é o paciente.
    // Foi o defeito que gerou `lib/mcp/recusa-para-o-modelo.ts`, cujo cabeçalho conta
    // o caso do "seu perfil atual é agent" chegando ao cliente final.
    respondeCom({
      ok: false,
      codigo: "jornada_mal_configurada",
      motivoParaOperador: "fuso horário inválido (em `timezone`) — agenda de Marina Alves",
      motivoParaCliente: "Os horários ainda não estão disponíveis. Avise que a equipe confirma.",
    });
    const r = (await crmFindFreeSlots.handler({ event_type_slug: "c" }, ctx)) as {
      motivo: string;
      mensagem: string;
    };
    expect(r.motivo).toBe("jornada_mal_configurada");
    expect(r.mensagem).toBe("Os horários ainda não estão disponíveis. Avise que a equipe confirma.");
    expect(r.mensagem).not.toMatch(/timezone|Marina|campo/i);
  });

  it("os dois sinais que a lista vazia esconde chegam ao MODELO", async () => {
    // `publicou_horarios` distingue "não publiquei" de "não tenho vaga" (DECISÃO 1.1);
    // `fuso_suposto` avisa que ninguém escolheu o fuso (DECISÃO 20.2). A IA OFERECE
    // horário — se a marca ficasse só na tela, ela afirmaria com confiança um horário
    // que ninguém confirmou.
    respondeCom({ ...SUCESSO, slots: [], publicouHorarios: false, fusoSuposto: true });
    const r = (await crmFindFreeSlots.handler({ event_type_slug: "c" }, ctx)) as {
      horarios: unknown[];
      publicou_horarios: boolean;
      fuso_suposto: boolean;
    };
    expect(r.horarios).toEqual([]);
    expect(r.publicou_horarios).toBe(false);
    expect(r.fuso_suposto).toBe(true);
  });

  it("CONTROLE: o sucesso devolve os horários em ISO — senão os casos acima passariam por vazio", async () => {
    respondeCom(SUCESSO);
    const r = (await crmFindFreeSlots.handler({ event_type_slug: "c" }, ctx)) as {
      horarios: { inicio: string; fim: string }[];
    };
    expect(r.horarios).toHaveLength(1);
    expect(r.horarios[0]!.inicio).toBe("2026-09-01T14:00:00.000Z");
  });
});


describe("crm_list_appointments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("⚠️ 'não sei de quem' NÃO vira lista vazia — vira pergunta", async () => {
    // O caso mais importante deste bloco. Lista vazia faria o modelo concluir e dizer
    // ao cliente que ele não tem nada marcado, quando a verdade é que a chamada não
    // tinha recorte. É o mesmo defeito da DECISÃO 1.1 num lugar novo: "não sei" e
    // "não tem" chegando como a mesma resposta.
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: false,
      codigo: "sem_alvo",
      motivoParaOperador: "listagem sem recorte: informe contato, lead, dia ou responsável.",
      motivoParaCliente:
        "Preciso saber de quem ou de que dia. Pergunte de qual cliente ou de qual data você quer ver os compromissos.",
    });
    const r = (await crmListAppointments.handler({}, ctx)) as {
      compromissos: unknown[];
      motivo: string;
      mensagem: string;
    };
    expect(r.motivo).toBe("sem_alvo");
    expect(r.mensagem).toMatch(/Pergunte de qual cliente/);
    // E a face do operador não vaza: nada de nome de campo na mensagem do cliente.
    expect(r.mensagem).not.toMatch(/contato, lead, dia ou responsável|recorte/);
  });

  it("lead SEM compromisso devolve lista vazia — e aqui vazio é a resposta certa", async () => {
    // Contraste com o caso acima, e é o que dá sentido a ele: quando o recorte EXISTE
    // e não há nada, vazio é verdade. Sem este par, o teste de cima passaria mesmo se
    // a tool recusasse tudo.
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [] });
    const r = (await crmListAppointments.handler(
      { lead_id: "11111111-1111-4111-8111-111111111111" },
      ctx,
    )) as { compromissos: unknown[]; motivo?: string };
    expect(r.compromissos).toEqual([]);
    expect(r.motivo).toBeUndefined();
  });

  it("o recorte chega inteiro à regra, e o limite tem padrão", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [] });
    await crmListAppointments.handler({ contact_id: "22222222-2222-4222-8222-222222222222", dia: "2026-09-01" }, ctx);
    const params = vi.mocked(listaAgendamentos).mock.calls[0]![2];
    expect(params.contactId).toBe("22222222-2222-4222-8222-222222222222");
    expect(params.dia).toBe("2026-09-01");
    expect(params.limite).toBe(20);
  });

  it("a situação vem do vocabulário do banco, não de literais inventados", async () => {
    // Escrevi `scheduled|done|cancelled` no contrato antes de ler a fonte, e os três
    // estavam errados. O shape usa `SITUACOES_DO_AGENDAMENTO`, então um valor fora dela
    // é recusado pelo Zod antes de chegar ao handler.
    const shape = crmListAppointments.inputSchema;
    expect(() => shape.situacao.parse("no_show")).not.toThrow();
    expect(() => shape.situacao.parse("done")).toThrow();
  });
});


describe("as escritas de agenda", () => {
  beforeEach(() => vi.clearAllMocks());

  it("⚠️ ApiError do handler vira RESPOSTA — exceção mataria o turno", async () => {
    // O caso que dá nome a este bloco. Numa rota HTTP lançar é certo: o wrapper
    // traduz em status. Numa ferramenta MCP a exceção sobe pela ponte e o assistente
    // EMUDECE na frente do cliente, no meio de uma conversa sobre marcar consulta.
    vi.mocked(idDoTipoPorSlug).mockResolvedValue({ id: "t-1", nome: "Consulta" });
    vi.mocked(handlers.marcarAgendamentoHandler).mockRejectedValue(
      new ApiError(409, "agenda_horario_indisponivel", undefined, "req-1", "slot tomado"),
    );

    const r = (await crmBookAppointment.handler(
      { event_type_slug: "consulta", starts_at: "2026-09-01T14:00:00Z", contact_id: "c-1" },
      ctx,
    )) as { marcado: boolean; motivo: string; mensagem: string };

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("agenda_horario_indisponivel");
    // E a recusa ENSINA o próximo passo — não só nega.
    expect(r.mensagem).toMatch(/crm_find_free_slots/);
  });

  it("cada código traz o ensino DELE, não uma frase genérica", async () => {
    // Recusa que só nega faz o modelo tentar de novo IGUAL — é o caso medido em
    // `retencao.ts`, onde ele repetiu a mesma data de 2023 e queimou o turno.
    vi.mocked(handlers.cancelarAgendamentoHandler).mockRejectedValue(
      new ApiError(409, "agenda_ja_cancelado", undefined, "req-1"),
    );
    const r = (await crmCancelAppointment.handler(
      { appointment_id: "11111111-1111-4111-8111-111111111111", reason: "cliente avisou" },
      ctx,
    )) as { cancelado: boolean; mensagem: string };
    expect(r.cancelado).toBe(false);
    expect(r.mensagem).toMatch(/não é erro|siga sem desmarcar/i);
  });

  it("CONTROLE: erro de INFRA sobe — a distinção é o ponto", async () => {
    // Sem este caso, `semDerrubarOTurno` poderia engolir TUDO e o teste acima
    // continuaria verde. Limite de negócio vira resposta; infra quebrada tem de
    // subir, senão o worker acha que funcionou e a linha morre em silêncio.
    vi.mocked(handlers.alterarAgendamentoHandler).mockRejectedValue(new Error("conexão caiu"));
    await expect(
      crmRescheduleAppointment.handler(
        { appointment_id: "22222222-2222-4222-8222-222222222222", new_starts_at: "2026-09-02T10:00:00Z" },
        ctx,
      ),
    ).rejects.toThrow("conexão caiu");
  });

  it("slug desconhecido é recusado ANTES de chamar o handler", async () => {
    vi.mocked(idDoTipoPorSlug).mockResolvedValue(null);
    const r = (await crmBookAppointment.handler(
      { event_type_slug: "nao-existe", starts_at: "2026-09-01T14:00:00Z", contact_id: "c-1" },
      ctx,
    )) as { marcado: boolean; motivo: string; mensagem: string };
    expect(r.motivo).toBe("tipo_desconhecido");
    expect(r.mensagem).toMatch(/nao-existe|não existe atendimento/);
    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("remarcar chama ALTERAR, nunca cancelar+marcar", async () => {
    // O contrato do DevVivo e a DECISÃO 25: é o MESMO compromisso mudando de hora.
    // Cancelar e recriar faria a timeline contar que o cliente desistiu e voltou.
    vi.mocked(handlers.alterarAgendamentoHandler).mockResolvedValue({ id: "a-1" });
    await crmRescheduleAppointment.handler(
      { appointment_id: "33333333-3333-4333-8333-333333333333", new_starts_at: "2026-09-02T10:00:00Z" },
      ctx,
    );
    expect(handlers.alterarAgendamentoHandler).toHaveBeenCalledTimes(1);
    expect(handlers.cancelarAgendamentoHandler).not.toHaveBeenCalled();
    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("a organização vem do CONTEXTO do agente, nunca do argumento", async () => {
    // O handler recebe `organization_id` por parâmetro justamente para servir à tool,
    // e pelo MCP o client é service-role: a RLS não filtra. Se isto vier do input, é
    // vazamento entre organizações.
    vi.mocked(handlers.cancelarAgendamentoHandler).mockResolvedValue({ id: "a-1" });
    await crmCancelAppointment.handler(
      { appointment_id: "44444444-4444-4444-8444-444444444444", reason: "cliente pediu" },
      ctx,
    );
    expect(vi.mocked(handlers.cancelarAgendamentoHandler).mock.calls[0]![1].organization_id).toBe("org-1");
  });
});
